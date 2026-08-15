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
`);

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

function migrarAUniqueCompuesto(tabla, createSql, columnas) {
  if (tieneIndiceUnicoCompuesto(tabla, ['cliente_id', 'telefono'])) return;
  const tablaVieja = `${tabla}_old`;
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
      `INSERT INTO clientes (email, password_hash, password_salt, nombre_negocio, waba_id, phone_number_id, access_token, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

export default db;
