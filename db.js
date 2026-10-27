import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { hashPassword } from './auth.js';

dotenv.config();

/**
 * Base de datos SQLite local (archivo `data.db` en la raíz del
 * proyecto), usando el módulo `node:sqlite` INTEGRADO de Node (>=22.5)
 * — sin dependencia npm, sin compilación nativa. Se eligió a propósito
 * en vez de `better-sqlite3` porque esta máquina no tiene Visual
 * Studio Build Tools instalado (better-sqlite3 requiere compilar un
 * addon nativo). Requiere Node 22.5+ (acá corre con Node 24).
 */
export const db = new DatabaseSync('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    nombre_negocio TEXT,
    waba_id TEXT,
    phone_number_id TEXT,
    access_token TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente_whatsapp', -- 'pendiente_whatsapp' | 'conectado'
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL,
    nombre TEXT,
    cliente_id INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, telefono)
  );

  CREATE TABLE IF NOT EXISTS campanas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_nombre TEXT NOT NULL,
    idioma TEXT NOT NULL DEFAULT 'es',
    parametros_json TEXT NOT NULL DEFAULT '[]',
    imagen_media_id TEXT,
    encabezado_tipo TEXT,
    total_contactos INTEGER NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'procesando',
    cliente_id INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campana_id INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
    contacto_id INTEGER REFERENCES contactos(id) ON DELETE SET NULL,
    telefono TEXT NOT NULL,
    nombre TEXT,
    estado TEXT NOT NULL, -- 'enviado' | 'fallido'
    error TEXT,
    wa_message_id TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_envios_campana ON envios(campana_id);

  CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL,
    direccion TEXT NOT NULL, -- 'entrante' | 'saliente'
    tipo TEXT NOT NULL DEFAULT 'texto', -- text, image, button, etc. (tal cual lo manda Meta)
    texto TEXT,
    media_id TEXT, -- id de Meta para bajar el archivo (imagen/sticker/video/audio/documento) vía Graph API
    media_mime_type TEXT,
    wa_message_id TEXT,
    estado TEXT NOT NULL DEFAULT 'recibido', -- entrante: 'recibido' | saliente: 'enviado'|'entregado'|'leido'|'fallido'
    error TEXT,
    nombre_perfil TEXT, -- nombre de WhatsApp que manda Meta en el webhook (puede no coincidir con el contacto guardado)
    leido_por_agente INTEGER NOT NULL DEFAULT 0,
    cliente_id INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON mensajes(telefono, creado_en);
  CREATE INDEX IF NOT EXISTS idx_mensajes_wa_id ON mensajes(wa_message_id);

  CREATE TABLE IF NOT EXISTS leads_prospectos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    rubro TEXT,
    direccion TEXT,
    telefono TEXT NOT NULL,
    link_whatsapp TEXT NOT NULL,
    sitio_web TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',
    cliente_id INTEGER,
    fecha_encontrado TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, telefono)
  );

  CREATE INDEX IF NOT EXISTS idx_leads_estado ON leads_prospectos(estado);

  CREATE TABLE IF NOT EXISTS facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    emitida_por_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    campana_ids_json TEXT NOT NULL DEFAULT '[]',
    -- Copia congelada del detalle por campaña y de los datos fiscales al
    -- momento de emitir: una factura ya emitida NO puede cambiar de
    -- valor porque después se edite la tarifa o se borre una campaña.
    detalle_json TEXT NOT NULL DEFAULT '[]',
    datos_cliente_json TEXT NOT NULL DEFAULT '{}',
    total_mensajes INTEGER NOT NULL DEFAULT 0,
    tarifa_unitaria REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    iva_porcentaje REAL NOT NULL DEFAULT 0,
    iva_monto REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    moneda TEXT NOT NULL DEFAULT 'COP',
    estado TEXT NOT NULL DEFAULT 'emitida', -- 'emitida' | 'pagada' | 'anulada'
    periodo_desde TEXT,
    periodo_hasta TEXT,
    notas TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    pagada_en TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_facturas_cliente ON facturas(cliente_id, id);

  -- Todos los números de WhatsApp que un cliente conectó alguna vez desde
  -- Meta (Embedded Signup se puede repetir para agregar más números de la
  -- misma WABA). clientes.phone_number_id/waba_id/access_token sigue
  -- siendo el número ACTIVO (de ahí sale todo envío); esta tabla es el
  -- listado completo para poder elegir cuál activar.
  CREATE TABLE IF NOT EXISTS whatsapp_numeros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    waba_id TEXT NOT NULL,
    phone_number_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    etiqueta TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, phone_number_id)
  );

  -- Cada importación de CSV/Excel queda guardada acá como un grupo
  -- reutilizable de contactos (ver POST /api/contactos/importar), para
  -- poder volver a seleccionar exactamente ese mismo lote después sin
  -- reimportar el archivo ni tildar contacto por contacto.
  CREATE TABLE IF NOT EXISTS listas_contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    contacto_ids_json TEXT NOT NULL DEFAULT '[]',
    total INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Respuestas de formularios nativos de WhatsApp (Flow) que llegan por
  -- el webhook (mensaje interactive de subtipo nfm_reply). Cada fila es
  -- un envío del formulario por parte de un contacto. respuestas_json
  -- guarda el objeto crudo { campo: valor } tal cual lo manda Meta; la
  -- campaña se asocia por teléfono contra el último envío Flow de ese
  -- cliente. Alimenta la pestaña "Encuestas" (estadísticas). Ver server.js.
  CREATE TABLE IF NOT EXISTS respuestas_flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    telefono TEXT NOT NULL,
    campana_id INTEGER,
    template_nombre TEXT,
    respuestas_json TEXT NOT NULL DEFAULT '{}',
    wa_message_id TEXT,
    recibido_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_respuestas_flow_cliente ON respuestas_flow(cliente_id, campana_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_respuestas_flow_wamid ON respuestas_flow(wa_message_id);

  -- Pedido de plantilla que un cliente arma desde el panel (formato calcado del
  -- creador de plantillas de Meta: categoría, encabezado, cuerpo, pie, botones)
  -- y que le llega al admin para que la cree a mano en el Administrador de Meta.
  -- El admin va cambiando el estado a medida que la gestiona y le asigna uno
  -- de SUS números conectados (whatsapp_numeros) — ver server.js, sección
  -- "PLANTILLAS (solicitudes)".
  CREATE TABLE IF NOT EXISTS plantillas_solicitudes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    categoria TEXT NOT NULL, -- MARKETING | UTILITY | AUTHENTICATION
    idioma TEXT NOT NULL DEFAULT 'es',
    header_tipo TEXT NOT NULL DEFAULT 'NONE', -- NONE | TEXT | IMAGE | VIDEO | DOCUMENT
    header_texto TEXT,
    header_media_path TEXT,
    body_texto TEXT NOT NULL,
    footer_texto TEXT,
    botones_json TEXT NOT NULL DEFAULT '[]',
    numero_personalizado INTEGER NOT NULL DEFAULT 0,
    nota_cliente TEXT,
    whatsapp_numero_id INTEGER REFERENCES whatsapp_numeros(id) ON DELETE SET NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|esperando_confirmacion|lista_para_enviar|rechazada|cancelada
    nota_admin TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_plantillas_solicitudes_cliente ON plantillas_solicitudes(cliente_id);
`);

/**
 * Clientes que ya tenían un número conectado ANTES de que existiera
 * `whatsapp_numeros` no aparecerían en el listado (aunque siguen
 * funcionando, porque siguen siendo el número activo en `clientes`).
 * Esto los siembra una sola vez para que también aparezcan como opción
 * elegible.
 */
function sembrarNumerosExistentes() {
  const clientes = db
    .prepare(`SELECT id, waba_id, phone_number_id, access_token FROM clientes WHERE phone_number_id IS NOT NULL AND access_token IS NOT NULL`)
    .all();
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO whatsapp_numeros (cliente_id, waba_id, phone_number_id, access_token, etiqueta)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const c of clientes) {
    insertar.run(c.id, c.waba_id || '', c.phone_number_id, c.access_token, null);
  }
}

/**
 * `node:sqlite` no versiona migraciones — este proyecto ya tenía datos
 * en producción con `contactos`/`campanas`/`mensajes`/`leads_prospectos`
 * sin columna `cliente_id` (creadas con `CREATE TABLE IF NOT EXISTS`
 * antes de que existiera el modelo multi-tenant). Estas líneas agregan
 * la columna en bases viejas; en una base nueva ya viene de la creación
 * de arriba y el ALTER simplemente falla con "duplicate column", que
 * ignoramos.
 */
function agregarColumnaSiFalta(tabla, definicion) {
  try {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${definicion}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}

agregarColumnaSiFalta('contactos', 'cliente_id INTEGER');
agregarColumnaSiFalta('campanas', 'cliente_id INTEGER');
agregarColumnaSiFalta('mensajes', 'cliente_id INTEGER');
agregarColumnaSiFalta('leads_prospectos', 'cliente_id INTEGER');
agregarColumnaSiFalta('mensajes', 'media_id TEXT');
agregarColumnaSiFalta('mensajes', 'media_mime_type TEXT');
// Por cuál de nuestros números entró/salió el mensaje. Hace falta porque el
// admin recibe una copia de las conversaciones de TODOS sus números (también
// los asignados a empresas) y, si responde, tiene que salir por ese mismo
// número y no por su número activo. NULL en mensajes viejos.
agregarColumnaSiFalta('mensajes', 'phone_number_id TEXT');
agregarColumnaSiFalta('campanas', 'imagen_media_id TEXT');
agregarColumnaSiFalta('campanas', 'encabezado_tipo TEXT'); // 'image' | 'video' (null = image, retrocompat)

/**
 * Facturación: qué se le cobra a cada cliente y con qué datos sale su
 * factura. La tarifa se cobra POR MENSAJE ENVIADO (ver facturacion.js)
 * y vive en la fila del cliente para que cada uno pueda tener un precio
 * distinto negociado.
 */
agregarColumnaSiFalta('clientes', 'tarifa_por_mensaje REAL NOT NULL DEFAULT 0');
agregarColumnaSiFalta('clientes', "moneda TEXT NOT NULL DEFAULT 'COP'");
agregarColumnaSiFalta('clientes', 'iva_porcentaje REAL NOT NULL DEFAULT 0');
agregarColumnaSiFalta('clientes', 'nit TEXT');
agregarColumnaSiFalta('clientes', 'direccion_fiscal TEXT');
agregarColumnaSiFalta('clientes', 'ciudad TEXT');
agregarColumnaSiFalta('clientes', 'telefono_contacto TEXT');
/**
 * Code Repair Tech (el cliente sembrado) necesita poder ver y facturar
 * las campañas de SUS clientes — sin esto, cada cuenta solo se puede
 * facturar a sí misma. Es el único permiso que cruza el aislamiento por
 * `cliente_id`, y siempre pasa por `resolverClienteObjetivo()` en
 * server.js.
 */
agregarColumnaSiFalta('clientes', 'es_admin INTEGER NOT NULL DEFAULT 0');

/**
 * Recordatorios personalizados por contacto (ej: fecha/hora de una cita,
 * tipo de servicio) para usar como variables de plantilla, y programación
 * de envíos (fecha común por campaña o individual por contacto) — ver
 * campanas.js y scheduler.js.
 */
agregarColumnaSiFalta('contactos', "variables_json TEXT NOT NULL DEFAULT '{}'");
agregarColumnaSiFalta('contactos', 'fecha_recordatorio TEXT');
// Ejemplo de cada variable {{N}} del cuerpo de una plantilla (Meta los exige para aprobarla).
agregarColumnaSiFalta('plantillas_solicitudes', "ejemplos_json TEXT NOT NULL DEFAULT '[]'");
agregarColumnaSiFalta('campanas', 'fecha_programada TEXT');
agregarColumnaSiFalta('campanas', 'contacto_ids_json TEXT');

/**
 * Una "empresa" creada desde el panel admin (ver server.js, sección ADMIN)
 * es una fila más de `clientes` pero SIN login real: su email/contraseña se
 * generan al azar y nunca se muestran, porque el único usuario que existe
 * de verdad en el aplicativo es el admin — él hace todo (contactos,
 * plantillas, envíos) desde adentro de cada empresa. Esta columna es solo
 * para distinguir esas filas en la UI, no cambia ningún permiso.
 */
agregarColumnaSiFalta('clientes', 'es_empresa_gestionada INTEGER NOT NULL DEFAULT 0');

/**
 * Si está prendida, al completarse el envío (`procesarCampana` en
 * campanas.js) se clona la campaña para el mismo día del mes siguiente —
 * pensado para recordatorios que se repiten todos los meses (ej: una cita
 * mensual) sin tener que volver a cargarlos a mano.
 */
agregarColumnaSiFalta('campanas', 'recurrente_mensual INTEGER NOT NULL DEFAULT 0');

/**
 * Plantillas con un botón de formulario nativo de WhatsApp ("Flow"):
 * al enviarlas hay que agregar un componente `button` de `sub_type:
 * 'flow'` en el payload, si no Meta rechaza con el error 131009
 * ("Components sub_type invalid"). `flow_boton` prende ese componente y
 * `flow_action_data_json` guarda datos opcionales para la primera
 * pantalla del formulario (la mayoría de las encuestas no lo necesitan).
 * Ver `sendTemplate` en whatsapp.js.
 */
agregarColumnaSiFalta('campanas', 'flow_boton INTEGER NOT NULL DEFAULT 0');
agregarColumnaSiFalta('campanas', 'flow_action_data_json TEXT');

/**
 * Sistema de créditos (prepago) para clientes independientes — reemplaza la
 * facturación por tarifa/mensaje SOLO para ellos (admin y empresas
 * gestionadas siguen igual que siempre). `categoria_plantilla` queda NULL en
 * una campaña de admin/gestionada; solo se completa cuando quien manda es un
 * cliente independiente, y ahí es lo que dispara el descuento. Ver
 * creditos.js, campanas.js (procesarCampana) y server.js (POST /api/campanas).
 */
agregarColumnaSiFalta('clientes', 'creditos INTEGER NOT NULL DEFAULT 0');
agregarColumnaSiFalta('campanas', 'categoria_plantilla TEXT');
agregarColumnaSiFalta('campanas', 'creditos_consumidos INTEGER');

db.exec(`
  -- Costo en créditos por categoría de plantilla — una sola fila global
  -- (id fijo = 1), editable por el admin. Es el costo real (tipo Meta), no
  -- una tarifa negociada por cliente — eso lo sigue cubriendo facturación.
  CREATE TABLE IF NOT EXISTS configuracion_creditos (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    costo_marketing INTEGER NOT NULL DEFAULT 3,
    costo_utility INTEGER NOT NULL DEFAULT 1,
    costo_authentication INTEGER NOT NULL DEFAULT 2
  );

  -- Ledger de cargas (cantidad positiva) y consumos (cantidad negativa) de
  -- créditos. Hoy las cargas las inserta el admin a mano
  -- (POST /api/admin/clientes-independientes/:id/creditos); cuando se
  -- conecte la pasarela de pagos, su webhook va a insertar acá mismo.
  CREATE TABLE IF NOT EXISTS creditos_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    cantidad INTEGER NOT NULL,
    motivo TEXT,
    campana_id INTEGER REFERENCES campanas(id) ON DELETE SET NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_creditos_movimientos_cliente ON creditos_movimientos(cliente_id, creado_en);
`);

db.prepare('INSERT OR IGNORE INTO configuracion_creditos (id) VALUES (1)').run();

/**
 * Precios reales en pesos COP por mensaje, según el modelo de cobro de
 * Daemon Leads (documento interno, sept. 2026): a diferencia del costo
 * abstracto de arriba, acá el precio varía también por tipo de contenido del
 * encabezado (texto/imagen/video), no solo por categoría. 1 crédito = 1 peso
 * COP. `costo_authentication` reutiliza la columna vieja (el documento no
 * define un precio propio para esa categoría); se migra su valor de fábrica
 * de 2 (abstracto) a 50 (= Utility texto) solo si nadie lo tocó todavía.
 */
agregarColumnaSiFalta('configuracion_creditos', 'costo_marketing_texto INTEGER NOT NULL DEFAULT 120');
agregarColumnaSiFalta('configuracion_creditos', 'costo_marketing_imagen INTEGER NOT NULL DEFAULT 140');
agregarColumnaSiFalta('configuracion_creditos', 'costo_marketing_video INTEGER NOT NULL DEFAULT 170');
agregarColumnaSiFalta('configuracion_creditos', 'costo_utility_texto INTEGER NOT NULL DEFAULT 50');
agregarColumnaSiFalta('configuracion_creditos', 'costo_utility_imagen INTEGER NOT NULL DEFAULT 70');
agregarColumnaSiFalta('configuracion_creditos', 'costo_utility_video INTEGER NOT NULL DEFAULT 100');
db.prepare('UPDATE configuracion_creditos SET costo_authentication = 50 WHERE costo_authentication = 2').run();

/**
 * Planes mensuales (sección 4 del modelo de cobro Daemon Leads) — cuota fija
 * de mensajes/mes a precio plano, alternativa a la recarga suelta de arriba.
 * Un cliente independiente usa UNO de los dos caminos: si tiene `plan_id`
 * asignado, sus campañas descuentan de acá (ver planes.js); si no, sigue
 * usando créditos como ya funcionaba. `plan_consumos` es un ledger (como
 * `creditos_movimientos`) en vez de un contador con reset mensual — la
 * cuota restante se calcula sumando lo consumido desde el inicio del ciclo
 * actual, sin necesitar un job de reset. Los mensajes se cuentan en
 * "medios mensajes" en `plan_consumos`, pero todas las categorías pesan
 * igual (1 medio = 1 mensaje) — decisión explícita del usuario 2026-09-23,
 * reemplaza el descuento a medio mensaje para Utility/Authentication que
 * sugería el documento original.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS planes_mensuales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    mensajes_mes INTEGER NOT NULL,
    precio_sin_iva INTEGER NOT NULL,
    orden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS plan_consumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    medios_mensajes INTEGER NOT NULL,
    motivo TEXT,
    campana_id INTEGER REFERENCES campanas(id) ON DELETE SET NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plan_consumos_cliente ON plan_consumos(cliente_id, creado_en);
`);

if (db.prepare('SELECT COUNT(*) AS n FROM planes_mensuales').get().n === 0) {
  const insertarPlan = db.prepare(
    'INSERT INTO planes_mensuales (nombre, mensajes_mes, precio_sin_iva, orden) VALUES (?, ?, ?, ?)'
  );
  [
    ['Básico', 600, 72000],
    ['Pro', 1500, 180000],
    ['Empresa', 4000, 480000],
    ['Corporativo', 10000, 1200000],
    ['Masivo', 25000, 3000000],
    ['Mayorista', 50000, 6000000],
    ['Máximo', 100000, 12000000],
  ].forEach(([nombre, mensajesMes, precio], i) => insertarPlan.run(nombre, mensajesMes, precio, i));
}

agregarColumnaSiFalta('clientes', 'plan_id INTEGER REFERENCES planes_mensuales(id)');
agregarColumnaSiFalta('clientes', 'plan_activado_en TEXT');
agregarColumnaSiFalta('campanas', "canal_cobro TEXT"); // 'plan' | 'creditos' | NULL (admin/gestionada)
agregarColumnaSiFalta('campanas', 'plan_medios_consumidos INTEGER');

/**
 * `contactos` y `leads_prospectos` tenían `UNIQUE(telefono)` a nivel de
 * columna (una sola columna) antes del modelo multi-tenant — ese índice
 * viejo no se puede alterar con ALTER TABLE, así que en bases con datos
 * previos hay que reconstruir la tabla para que quede `UNIQUE(cliente_id,
 * telefono)` (permite que dos clientes distintos tengan el mismo
 * teléfono en su lista). En una base nueva la tabla ya nace con el
 * índice compuesto (ver el `CREATE TABLE` de arriba) y esto no hace nada.
 */
function tieneIndiceUnicoCompuesto(tabla, columnas) {
  const indices = db.prepare(`PRAGMA index_list(${tabla})`).all();
  return indices.some((idx) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name);
    return cols.length === columnas.length && columnas.every((c, i) => cols[i] === c);
  });
}

/**
 * `node:sqlite` tiene `PRAGMA foreign_keys` activado por defecto (a
 * diferencia de la librería C de SQLite, que lo trae apagado). Con eso
 * activado, un `ALTER TABLE ... RENAME TO` reescribe automáticamente
 * las cláusulas REFERENCES de OTRAS tablas que apunten a la tabla
 * renombrada — así fue como la primera corrida de `migrarAUniqueCompuesto`
 * sobre `contactos` dejó a `envios.contacto_id` apuntando a
 * `contactos_old`, que se borra dos líneas después, rompiendo todo
 * INSERT en `envios` con "no such table: main.contactos_old". Por eso
 * estas migraciones apagan `foreign_keys` mientras dura el rename.
 */
function migrarAUniqueCompuesto(tabla, createSql, columnas) {
  if (tieneIndiceUnicoCompuesto(tabla, ['cliente_id', 'telefono'])) return;
  const tablaVieja = `${tabla}_old`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE ${tabla} RENAME TO ${tablaVieja}`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${tabla} (${columnas.join(', ')}) SELECT ${columnas.join(', ')} FROM ${tablaVieja}`);
    db.exec(`DROP TABLE ${tablaVieja}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Repara `envios` si ya quedó con `contacto_id REFERENCES contactos_old`
 * por haber corrido la migración de `contactos` ANTES de este arreglo
 * (fue el caso en producción). Reconstruye la tabla con la referencia
 * correcta, sin tocar los datos. En una base que nunca tuvo el bug, el
 * chequeo de abajo no encuentra "contactos_old" en el DDL y no hace nada.
 */
function repararReferenciaEnviosContactos() {
  const fila = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'envios'`).get();
  if (!fila || !fila.sql.includes('contactos_old')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE envios RENAME TO envios_old');
    db.exec(`
      CREATE TABLE envios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campana_id INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
        contacto_id INTEGER REFERENCES contactos(id) ON DELETE SET NULL,
        telefono TEXT NOT NULL,
        nombre TEXT,
        estado TEXT NOT NULL,
        error TEXT,
        wa_message_id TEXT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO envios (id, campana_id, contacto_id, telefono, nombre, estado, error, wa_message_id, creado_en)
      SELECT id, campana_id, contacto_id, telefono, nombre, estado, error, wa_message_id, creado_en FROM envios_old
    `);
    db.exec('DROP TABLE envios_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_envios_campana ON envios(campana_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrarAUniqueCompuesto(
  'contactos',
  `CREATE TABLE contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL,
    nombre TEXT,
    cliente_id INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, telefono)
  )`,
  ['id', 'telefono', 'nombre', 'cliente_id', 'creado_en']
);

migrarAUniqueCompuesto(
  'leads_prospectos',
  `CREATE TABLE leads_prospectos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    rubro TEXT,
    direccion TEXT,
    telefono TEXT NOT NULL,
    link_whatsapp TEXT NOT NULL,
    sitio_web TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',
    cliente_id INTEGER,
    fecha_encontrado TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, telefono)
  )`,
  ['id', 'nombre', 'rubro', 'direccion', 'telefono', 'link_whatsapp', 'sitio_web', 'estado', 'cliente_id', 'fecha_encontrado']
);

repararReferenciaEnviosContactos();

// 1 = ya se le devolvió al cliente lo cobrado por este envío (el webhook lo
// marcó fallido después de que Meta lo aceptó). Evita reembolsar dos veces.
// Va después de la reparación de arriba porque esa reconstruye `envios`.
agregarColumnaSiFalta('envios', 'reembolsado INTEGER NOT NULL DEFAULT 0');

/**
 * Antes de este cambio, `contactos`/`campanas`/`envios`/`mensajes`/
 * `leads_prospectos` eran globales (un solo tenant: Code Repair Tech,
 * usando las credenciales de WHATSAPP_* del .env). Al introducir
 * `clientes`, sembramos ese primer cliente con esos mismos valores y le
 * asignamos todos los datos preexistentes, para no perder nada de lo
 * que ya estaba funcionando.
 */
function sembrarClienteInicial() {
  const hayClientes = db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n > 0;
  if (hayClientes) return;

  const email = process.env.SEED_ADMIN_EMAIL || 'nicolasperdomoliz@gmail.com';
  const passwordGenerada = !process.env.BASIC_AUTH_PASS;
  const password = process.env.BASIC_AUTH_PASS || crypto.randomBytes(9).toString('base64url');
  const { hash, salt } = hashPassword(password);

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
  const wabaId = process.env.WHATSAPP_WABA_ID || null;
  const accessToken = process.env.WHATSAPP_API_TOKEN || null;

  const result = db
    .prepare(
      `INSERT INTO clientes (email, password_hash, password_salt, nombre_negocio, waba_id, phone_number_id, access_token, estado, es_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      email,
      hash,
      salt,
      'Code Repair Tech',
      wabaId,
      phoneNumberId,
      accessToken,
      phoneNumberId && accessToken ? 'conectado' : 'pendiente_whatsapp'
    );

  const clienteId = result.lastInsertRowid;
  for (const tabla of ['contactos', 'campanas', 'mensajes', 'leads_prospectos']) {
    db.prepare(`UPDATE ${tabla} SET cliente_id = ? WHERE cliente_id IS NULL`).run(clienteId);
  }

  console.log(`\nCliente inicial creado — email: ${email}${passwordGenerada ? `, contraseña generada: ${password} (guardala, no se vuelve a mostrar)` : ' (contraseña = BASIC_AUTH_PASS actual)'}\n`);
}

sembrarClienteInicial();
sembrarNumerosExistentes();

/**
 * En bases que ya existían antes de la facturación, `es_admin` nace en 0
 * para todos y nadie podría facturarle a nadie. El primer cliente
 * (Code Repair Tech, el que sembró `sembrarClienteInicial`) es el dueño
 * de la instalación, así que se lo promueve una única vez.
 */
function asegurarAdministrador() {
  const hayAdmin = db.prepare('SELECT COUNT(*) AS n FROM clientes WHERE es_admin = 1').get().n > 0;
  if (hayAdmin) return;
  const primero = db.prepare('SELECT id FROM clientes ORDER BY id ASC LIMIT 1').get();
  if (primero) db.prepare('UPDATE clientes SET es_admin = 1 WHERE id = ?').run(primero.id);
}

asegurarAdministrador();

export default db;
