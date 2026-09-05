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
agregarColumnaSiFalta('campanas', 'fecha_programada TEXT');
agregarColumnaSiFalta('campanas', 'contacto_ids_json TEXT');

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
