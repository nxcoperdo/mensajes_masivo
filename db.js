import { DatabaseSync } from 'node:sqlite';

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
  CREATE TABLE IF NOT EXISTS contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL UNIQUE,
    nombre TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campanas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_nombre TEXT NOT NULL,
    idioma TEXT NOT NULL DEFAULT 'es',
    parametros_json TEXT NOT NULL DEFAULT '[]',
    total_contactos INTEGER NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'procesando',
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
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON mensajes(telefono, creado_en);
  CREATE INDEX IF NOT EXISTS idx_mensajes_wa_id ON mensajes(wa_message_id);

  CREATE TABLE IF NOT EXISTS leads_prospectos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    rubro TEXT,
    direccion TEXT,
    telefono TEXT NOT NULL UNIQUE,
    link_whatsapp TEXT NOT NULL,
    sitio_web TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',
    fecha_encontrado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_estado ON leads_prospectos(estado);
`);

export default db;
