import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto, { timingSafeEqual } from 'crypto';
import { db } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { parseCsv } from './csv.js';
import { parseExcel } from './excel.js';
import { sendTemplate, sendTextMessage, subirMedia, normalizePhone, isWhatsAppConfigured } from './whatsapp.js';
import { buscarNegocios } from './leads.js';
import {
  calcularResumen,
  datosEmisor,
  generarFacturaPdf,
  generarReportePdf,
  nombreArchivo,
} from './facturacion.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const EXTENSIONES_PERMITIDAS = ['.csv', '.xlsx', '.xls'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
      return cb(new Error('Formato no soportado. Usá un archivo .csv, .xlsx o .xls'));
    }
    cb(null, true);
  },
});

const EXTENSIONES_IMAGEN_PERMITIDAS = ['.jpg', '.jpeg', '.png'];
const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // límite de Meta para imágenes de header
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSIONES_IMAGEN_PERMITIDAS.includes(ext)) {
      return cb(new Error('Formato no soportado. La imagen debe ser .jpg, .jpeg o .png'));
    }
    cb(null, true);
  },
});

// Rutas alcanzables sin sesión iniciada (páginas de login/registro y sus
// assets, el callback de OAuth de Meta, la política de privacidad, y el
// webhook que llama Meta directo). Todo lo demás exige `req.session.clienteId`.
const RUTAS_PUBLICAS = new Set([
  '/login.html',
  '/registro.html',
  '/oauth/callback',
  '/privacidad.html',
  '/style.css',
  '/favicon.ico',
  '/auth.js',
  '/api/auth/login',
  '/api/auth/registro',
]);

function esRutaPublica(req) {
  if (req.path === '/webhook') return true;
  if (RUTAS_PUBLICAS.has(req.path)) return true;
  if (req.path.startsWith('/assets/')) return true;
  return false;
}

/**
 * Autenticación por sesión (login por cliente). Reemplaza el Basic Auth
 * único que tenía todo el proyecto antes de volverse multi-tenant — ese
 * usuario/contraseña ahora vive como credenciales del primer cliente
 * (sembrado en db.js), no como un gate global.
 */
function requireAuth(req, res, next) {
  if (esRutaPublica(req)) return next();
  if (req.session && req.session.clienteId) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  res.redirect('/login.html');
}

app.set('trust proxy', 1); // corre detrás de Nginx en el VPS
app.use(
  session({
    name: 'wa_broadcast_sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-cambiar-en-produccion',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    },
  })
);
app.use(requireAuth);
// Guarda el body crudo (necesario para verificar la firma HMAC del
// webhook de Meta) sin cambiar cómo se usa req.body en el resto de la app.
// El límite por defecto de express.json es 100 KB, y una campaña con
// varios miles de contactos manda un array de IDs que lo supera (el
// navegador recibía un 413 antes de llegar al endpoint).
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

function clienteActual(req) {
  return db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.session.clienteId);
}

// ==================== AUTENTICACIÓN ====================

app.post('/api/auth/registro', (req, res) => {
  const { email, password, nombre_negocio } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'Falta el email' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  const emailNormalizado = String(email).trim().toLowerCase();
  const { hash, salt } = hashPassword(password);

  try {
    const result = db
      .prepare(
        `INSERT INTO clientes (email, password_hash, password_salt, nombre_negocio, estado)
         VALUES (?, ?, ?, ?, 'pendiente_whatsapp')`
      )
      .run(emailNormalizado, hash, salt, nombre_negocio ? String(nombre_negocio).trim() : null);

    req.session.clienteId = result.lastInsertRowid;
    res.status(201).json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Falta email o contraseña' });
  }

  const cliente = db.prepare('SELECT * FROM clientes WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!cliente || !verifyPassword(password, cliente.password_hash, cliente.password_salt)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  req.session.clienteId = cliente.id;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/yo', (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.status(401).json({ error: 'No autenticado' });
  res.json({
    cliente: {
      id: cliente.id,
      email: cliente.email,
      nombre_negocio: cliente.nombre_negocio,
      estado: cliente.estado,
    },
  });
});

// Meta exige una "Valid OAuth Redirect URI" configurada en Facebook
// Login for Business para el flujo de Embedded Signup, aunque el popup
// del SDK de JS no redirige visiblemente acá (el `code` se recibe por
// postMessage — ver public/app.js). Esta página solo cubre ese requisito.
app.get('/oauth/callback', (req, res) => {
  res.type('html').send('<!doctype html><html lang="es"><body style="font-family: sans-serif; padding: 2rem;"><p>Podés cerrar esta ventana.</p></body></html>');
});

// ==================== CONFIG ====================

app.get('/api/config', (req, res) => {
  const cliente = clienteActual(req);
  res.json({
    cliente: {
      email: cliente.email,
      nombre_negocio: cliente.nombre_negocio,
      estado: cliente.estado,
      es_admin: Boolean(cliente.es_admin),
    },
    // Estricto (sin el fallback al .env global que tiene whatsapp.js para
    // desarrollo local) — acá nos interesa si ESTE cliente ya conectó.
    whatsappConfigured: Boolean(cliente.phone_number_id && cliente.access_token),
    webhookVerifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    webhookSignatureConfigured: Boolean(process.env.WHATSAPP_APP_SECRET),
    facebookAppId: process.env.FACEBOOK_APP_ID || null,
    facebookEmbeddedConfigId: process.env.FACEBOOK_EMBEDDED_CONFIG_ID || null,
  });
});

// ==================== EMBEDDED SIGNUP (conectar WhatsApp) ====================
//
// El frontend abre el popup del SDK de Facebook (ver public/app.js) y,
// cuando el cliente termina de conectar su WhatsApp Business, junta
// { code, waba_id, phone_number_id } y los manda acá. Este endpoint:
//  1. Cambia el `code` por un access token (Graph API OAuth).
//  2. Suscribe esta app a la WABA para empezar a recibir su webhook
//     (mismo llamado POST /{waba_id}/subscribed_apps que se hizo a mano
//     por curl mientras se armaba este flujo).
//  3. Guarda todo en la fila del cliente logueado.

app.post('/api/clientes/whatsapp/conectar', async (req, res) => {
  const { code, waba_id, phone_number_id } = req.body || {};
  if (!code || !waba_id || !phone_number_id) {
    return res.status(400).json({ error: 'Faltan datos del Embedded Signup (code, waba_id, phone_number_id)' });
  }

  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  if (!appId || !appSecret) {
    return res.status(500).json({ error: 'Falta configurar FACEBOOK_APP_ID / FACEBOOK_APP_SECRET en el .env del servidor' });
  }

  try {
    const tokenUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(502).json({ error: tokenData.error?.message || 'No se pudo obtener el access token de Meta' });
    }
    const accessToken = tokenData.access_token;

    const subRes = await fetch(`https://graph.facebook.com/${apiVersion}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const subData = await subRes.json();
    if (!subRes.ok || !subData.success) {
      return res.status(502).json({ error: subData.error?.message || 'No se pudo suscribir la app a esa cuenta de WhatsApp Business' });
    }

    // Nombre lindo para mostrar en el selector de números (best-effort: si
    // falla, se guarda sin etiqueta y el listado cae al phone_number_id).
    let etiqueta = null;
    try {
      const infoRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phone_number_id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const infoData = await infoRes.json();
      if (infoRes.ok) {
        etiqueta = [infoData.verified_name, infoData.display_phone_number].filter(Boolean).join(' · ') || null;
      }
    } catch {
      // no bloquea la conexión si Graph no responde este dato opcional
    }

    db.prepare(
      `INSERT INTO whatsapp_numeros (cliente_id, waba_id, phone_number_id, access_token, etiqueta)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cliente_id, phone_number_id) DO UPDATE SET
         waba_id = excluded.waba_id, access_token = excluded.access_token, etiqueta = excluded.etiqueta`
    ).run(req.session.clienteId, waba_id, phone_number_id, accessToken, etiqueta);

    // El primer número que conecta una cuenta queda activo automáticamente
    // (comportamiento anterior). Si ya tenía otro activo, este se agrega a
    // la lista pero el activo no cambia solo — el cliente lo elige a mano
    // en Configuración (POST /api/whatsapp/numeros/:id/activar).
    const cliente = clienteActual(req);
    if (!cliente.phone_number_id) {
      db.prepare(
        `UPDATE clientes SET waba_id = ?, phone_number_id = ?, access_token = ?, estado = 'conectado' WHERE id = ?`
      ).run(waba_id, phone_number_id, accessToken, req.session.clienteId);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Lista de todos los números que este cliente conectó alguna vez, marcando
// cuál es el activo (el que usan los envíos ahora mismo).
app.get('/api/whatsapp/numeros', (req, res) => {
  const cliente = clienteActual(req);
  const numeros = db
    .prepare('SELECT id, waba_id, phone_number_id, etiqueta, creado_en FROM whatsapp_numeros WHERE cliente_id = ? ORDER BY creado_en ASC')
    .all(req.session.clienteId);
  res.json({
    numeros: numeros.map((n) => ({ ...n, activo: n.phone_number_id === cliente.phone_number_id })),
  });
});

// Agrega un número a mano, sin pasar por el popup de Embedded Signup.
// Sirve cuando el número nuevo ya está en la MISMA cuenta de WhatsApp
// Business (WABA) que la que ya tenés conectada: el access token actual
// tiene permiso a nivel de WABA (no por número), así que sirve tal cual
// para mandar desde cualquier número de esa cuenta. Se valida contra
// Graph API antes de guardar, para no guardar un ID que no existe o al
// que este token no tiene acceso.
app.post('/api/whatsapp/numeros/manual', async (req, res) => {
  const { phone_number_id } = req.body || {};
  if (!phone_number_id || !String(phone_number_id).trim()) {
    return res.status(400).json({ error: 'Falta el phone_number_id' });
  }
  const phoneNumberId = String(phone_number_id).trim();

  const cliente = clienteActual(req);
  if (!cliente.access_token) {
    return res.status(400).json({ error: 'Todavía no tenés ningún número conectado — usá "Conectar WhatsApp Business" primero' });
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  try {
    // Solo confirma que el ID existe y que el token del cliente tiene
    // acceso — no hay forma de pedirle a Graph "a qué WABA pertenece este
    // número" desde el nodo del número (whatsapp_business_account no es
    // un campo válido acá), así que se asume la misma WABA que ya tenía
    // el cliente, que es la premisa de este endpoint.
    const infoRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${cliente.access_token}` },
    });
    const infoData = await infoRes.json();
    if (!infoRes.ok) {
      return res.status(400).json({ error: infoData.error?.message || 'No se pudo verificar ese phone_number_id con Meta (¿el número está en otra cuenta de WhatsApp Business?)' });
    }

    const etiqueta = [infoData.verified_name, infoData.display_phone_number].filter(Boolean).join(' · ') || null;

    db.prepare(
      `INSERT INTO whatsapp_numeros (cliente_id, waba_id, phone_number_id, access_token, etiqueta)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cliente_id, phone_number_id) DO UPDATE SET etiqueta = excluded.etiqueta`
    ).run(req.session.clienteId, cliente.waba_id || '', phoneNumberId, cliente.access_token, etiqueta);

    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Cambia cuál de los números ya conectados es el activo — todo envío
// nuevo (campañas y respuestas de chat) sale por este a partir de ahora.
app.post('/api/whatsapp/numeros/:id/activar', (req, res) => {
  const numero = db
    .prepare('SELECT * FROM whatsapp_numeros WHERE id = ? AND cliente_id = ?')
    .get(req.params.id, req.session.clienteId);
  if (!numero) return res.status(404).json({ error: 'Número no encontrado' });

  db.prepare(
    `UPDATE clientes SET waba_id = ?, phone_number_id = ?, access_token = ?, estado = 'conectado' WHERE id = ?`
  ).run(numero.waba_id, numero.phone_number_id, numero.access_token, req.session.clienteId);

  res.json({ ok: true });
});

// ==================== CONTACTOS ====================

app.get('/api/contactos', (req, res) => {
  const contactos = db
    .prepare('SELECT * FROM contactos WHERE cliente_id = ? ORDER BY nombre COLLATE NOCASE ASC')
    .all(req.session.clienteId);
  res.json({ contactos });
});

app.post('/api/contactos', (req, res) => {
  const { telefono, nombre } = req.body || {};
  const normalizado = normalizePhone(telefono);
  if (!normalizado) {
    return res.status(400).json({ error: 'Teléfono inválido' });
  }
  try {
    const result = db
      .prepare('INSERT INTO contactos (telefono, nombre, cliente_id) VALUES (?, ?, ?)')
      .run(normalizado, nombre || null, req.session.clienteId);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un contacto con ese teléfono' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contactos', (req, res) => {
  db.prepare('DELETE FROM contactos WHERE cliente_id = ?').run(req.session.clienteId);
  res.json({ ok: true });
});

app.delete('/api/contactos/:id', (req, res) => {
  db.prepare('DELETE FROM contactos WHERE id = ? AND cliente_id = ?').run(req.params.id, req.session.clienteId);
  res.json({ ok: true });
});

/**
 * Importa un CSV o Excel (.xlsx/.xls) con columnas `telefono` (o
 * `phone`/`numero`) y `nombre` (opcional). Hace upsert por teléfono
 * normalizado: si ya existe, actualiza el nombre; si no, lo crea.
 */
app.post('/api/contactos/importar', (req, res) => {
  upload.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    if (!req.file) {
      return res.status(400).json({ error: 'Falta el archivo' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const filas = ext === '.csv'
      ? parseCsv(req.file.buffer.toString('utf-8'))
      : parseExcel(req.file.buffer);

    if (filas.length === 0) {
      return res.status(400).json({ error: 'El archivo está vacío o no se pudo leer' });
    }

    const upsert = db.prepare(`
      INSERT INTO contactos (telefono, nombre, cliente_id) VALUES (?, ?, ?)
      ON CONFLICT(cliente_id, telefono) DO UPDATE SET nombre = COALESCE(excluded.nombre, contactos.nombre)
    `);

    let importados = 0;
    const invalidos = [];
    // `node:sqlite` no trae un helper `.transaction()` como better-sqlite3
    // — envolvemos a mano con BEGIN/COMMIT (y ROLLBACK si algo explota).
    db.exec('BEGIN');
    try {
      for (const row of filas) {
        const telefonoRaw = row.telefono || row.phone || row.numero || row.celular || '';
        const nombreRaw = row.nombre || row.name || '';
        const normalizado = normalizePhone(telefonoRaw);
        if (!normalizado) {
          if (telefonoRaw) invalidos.push(telefonoRaw);
          continue;
        }
        upsert.run(normalizado, nombreRaw || null, req.session.clienteId);
        importados++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: err.message });
    }

    res.json({ importados, invalidos, total_filas: filas.length });
  });
});

// ==================== CAMPAÑAS ====================

// Nota sobre `estado` en envios: arranca en 'enviado' y el webhook de
// Meta lo va escalando a 'entregado' y 'leido' a medida que llegan los
// callbacks de status (ver sección WEBHOOK más abajo). "enviados" acá
// cuenta cualquier envío exitoso sin importar en qué estado quedó
// después — 'entregados'/'leidos' son sub-conteos de esos mismos.
app.get('/api/campanas', (req, res) => {
  // `cliente_id` solo lo puede usar un admin, para facturarle a sus
  // clientes desde el historial (ver resolverClienteObjetivo).
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanas = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('enviado','entregado','leido')) AS enviados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('entregado','leido')) AS entregados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'leido') AS leidos,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'fallido') AS fallidos
       FROM campanas c
       WHERE c.cliente_id = ?
       ORDER BY c.id DESC`
    )
    .all(cliente.id);
  res.json({ campanas });
});

app.get('/api/campanas/:id', (req, res) => {
  const campana = db.prepare('SELECT * FROM campanas WHERE id = ? AND cliente_id = ?').get(req.params.id, req.session.clienteId);
  if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });
  const enviados = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado IN ('enviado','entregado','leido')`)
    .get(req.params.id).n;
  const entregados = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado IN ('entregado','leido')`)
    .get(req.params.id).n;
  const leidos = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'leido'`)
    .get(req.params.id).n;
  const fallidos = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'fallido'`)
    .get(req.params.id).n;
  res.json({ campana: { ...campana, enviados, entregados, leidos, fallidos } });
});

app.get('/api/campanas/:id/envios', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campana = db.prepare('SELECT id FROM campanas WHERE id = ? AND cliente_id = ?').get(req.params.id, cliente.id);
  if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });
  const envios = db
    .prepare('SELECT * FROM envios WHERE campana_id = ? ORDER BY id ASC')
    .all(req.params.id);
  res.json({ envios });
});

/**
 * Crea una campaña y dispara el envío EN SEGUNDO PLANO (no bloquea el
 * request — con 250+ contactos y un delay entre cada uno, esto puede
 * tardar más de un minuto, y no queremos que el navegador tenga un
 * fetch colgado todo ese tiempo). El frontend hace polling a
 * `GET /api/campanas/:id` para ver el progreso.
 *
 * multipart/form-data (no JSON, porque puede traer una imagen):
 *   template_nombre: string
 *   idioma: string (default 'es')
 *   contacto_ids: string (JSON de number[])
 *   parametros: string (JSON de Array<{ tipo: 'fijo'|'nombre', valor?: string }>)
 *     - 'nombre': se reemplaza por el nombre del contacto (o el
 *       teléfono si no tiene nombre cargado).
 *     - 'fijo': se manda `valor` tal cual, igual para todos.
 *   imagen: archivo (opcional) — solo si la plantilla tiene un
 *     encabezado de tipo imagen. Se sube una vez a Meta y se reusa el
 *     media_id para todos los envíos de la campaña.
 */
app.post('/api/campanas', (req, res) => {
  uploadImagen.single('imagen')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { template_nombre, idioma } = req.body || {};
    const cliente = clienteActual(req);
    let contacto_ids, parametros;
    try {
      contacto_ids = JSON.parse(req.body?.contacto_ids || '[]');
      parametros = JSON.parse(req.body?.parametros || '[]');
    } catch {
      return res.status(400).json({ error: 'Formato inválido en contacto_ids/parametros' });
    }

    if (!template_nombre || !String(template_nombre).trim()) {
      return res.status(400).json({ error: 'Falta el nombre de la plantilla' });
    }
    if (!Array.isArray(contacto_ids) || contacto_ids.length === 0) {
      return res.status(400).json({ error: 'Elegí al menos un contacto' });
    }
    if (!isWhatsAppConfigured(cliente.phone_number_id, cliente.access_token)) {
      return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de WhatsApp Business' });
    }

    const placeholders = contacto_ids.map(() => '?').join(',');
    const contactos = db
      .prepare(`SELECT * FROM contactos WHERE id IN (${placeholders}) AND cliente_id = ?`)
      .all(...contacto_ids, cliente.id);

    if (contactos.length === 0) {
      return res.status(400).json({ error: 'No se encontraron los contactos seleccionados' });
    }

    let imagenMediaId = null;
    if (req.file) {
      const subida = await subirMedia(req.file.buffer, req.file.mimetype, cliente.phone_number_id, cliente.access_token);
      if (!subida.ok) {
        return res.status(502).json({ error: `No se pudo subir la imagen a WhatsApp: ${subida.error}` });
      }
      imagenMediaId = subida.mediaId;
    }

    const parametrosDef = Array.isArray(parametros) ? parametros : [];

    const result = db
      .prepare(
        `INSERT INTO campanas (template_nombre, idioma, parametros_json, imagen_media_id, total_contactos, estado, cliente_id)
         VALUES (?, ?, ?, ?, ?, 'procesando', ?)`
      )
      .run(template_nombre.trim(), idioma || 'es', JSON.stringify(parametrosDef), imagenMediaId, contactos.length, cliente.id);

    const campanaId = result.lastInsertRowid;

    // Fire-and-forget: procesa en background, el request ya respondió.
    procesarCampana({
      campanaId,
      template_nombre: template_nombre.trim(),
      idioma: idioma || 'es',
      parametrosDef,
      imagenMediaId,
      contactos,
      phoneNumberId: cliente.phone_number_id,
      accessToken: cliente.access_token,
    });

    res.status(202).json({ campana_id: campanaId, total: contactos.length });
  });
});

async function procesarCampana({ campanaId, template_nombre, idioma, parametrosDef, imagenMediaId, contactos, phoneNumberId, accessToken }) {
  const delayMs = Number(process.env.ENVIO_DELAY_MS) || 250;
  const insertEnvio = db.prepare(`
    INSERT INTO envios (campana_id, contacto_id, telefono, nombre, estado, error, wa_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const contacto of contactos) {
    const parametrosResueltos = parametrosDef.map((p) =>
      p.tipo === 'nombre' ? (contacto.nombre || contacto.telefono) : (p.valor || '')
    );

    const resultado = await sendTemplate({
      to: contacto.telefono,
      template: template_nombre,
      languageCode: idioma,
      parameters: parametrosResueltos,
      phoneNumberId,
      accessToken,
      headerMediaId: imagenMediaId,
    });

    insertEnvio.run(
      campanaId,
      contacto.id,
      contacto.telefono,
      contacto.nombre || null,
      resultado.ok ? 'enviado' : 'fallido',
      resultado.ok ? null : resultado.error,
      resultado.messageId || null
    );

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  db.prepare(`UPDATE campanas SET estado = 'completada' WHERE id = ?`).run(campanaId);
}

// ==================== FACTURACIÓN ====================
//
// Se factura POR MENSAJE ENVIADO: cuenta cada fila de `envios` que no
// quedó en 'fallido'. Como el webhook de Meta va escalando ese mismo
// registro a 'entregado' y después a 'leido', los tres estados son
// "mensajes que se enviaron" y por eso los tres se cobran; 'fallido'
// nunca se cobra. Ver el bloque de comentarios de facturacion.js.
const CONDICION_FACTURABLE = `e.estado IN ('enviado','entregado','leido')`;

/**
 * Resuelve sobre qué cliente se está operando. Por defecto, el logueado.
 * Un cliente marcado `es_admin` (Code Repair Tech, el dueño de la
 * instalación) puede pasar `?cliente_id=` para ver y facturar las
 * campañas de cualquiera de sus clientes — es el único punto donde se
 * cruza el aislamiento por `cliente_id`, y solo por acá.
 *
 * Devuelve `{ error }` en vez de tirar excepción para que cada endpoint
 * responda el status que corresponda.
 */
function resolverClienteObjetivo(req, idPedido) {
  const propio = clienteActual(req);
  if (!propio) return { error: 'No autenticado', status: 401 };
  if (idPedido === undefined || idPedido === null || idPedido === '') return { cliente: propio, propio };

  const id = Number(idPedido);
  if (!Number.isInteger(id)) return { error: 'cliente_id inválido', status: 400 };
  if (id === propio.id) return { cliente: propio, propio };
  if (!propio.es_admin) return { error: 'No tenés permiso para ver los datos de otro cliente', status: 403 };

  const objetivo = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!objetivo) return { error: 'Cliente no encontrado', status: 404 };
  return { cliente: objetivo, propio };
}

/** Datos de facturación (sin credenciales) que se mandan al frontend. */
function configFacturacion(cliente) {
  return {
    cliente_id: cliente.id,
    nombre_negocio: cliente.nombre_negocio,
    email: cliente.email,
    tarifa_por_mensaje: Number(cliente.tarifa_por_mensaje) || 0,
    moneda: cliente.moneda || 'COP',
    iva_porcentaje: Number(cliente.iva_porcentaje) || 0,
    nit: cliente.nit || '',
    direccion_fiscal: cliente.direccion_fiscal || '',
    ciudad: cliente.ciudad || '',
    telefono_contacto: cliente.telefono_contacto || '',
  };
}

/**
 * Trae las campañas pedidas con sus conteos por estado, siempre
 * acotadas al cliente objetivo (una campaña de otro cliente
 * simplemente no aparece, aunque manden su id).
 */
function campanasParaFacturar(clienteId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const numericos = ids.map(Number).filter(Number.isInteger);
  if (numericos.length === 0) return [];

  const marcadores = numericos.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT c.id, c.template_nombre, c.idioma, c.estado, c.total_contactos, c.creado_en,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND ${CONDICION_FACTURABLE}) AS enviados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('entregado','leido')) AS entregados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'leido') AS leidos,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'fallido') AS fallidos
       FROM campanas c
       WHERE c.cliente_id = ? AND c.id IN (${marcadores})
       ORDER BY c.id ASC`
    )
    .all(clienteId, ...numericos);
}

function idsDesdeQuery(valor) {
  if (valor === undefined || valor === null || valor === '') return [];
  const bruto = Array.isArray(valor) ? valor : String(valor).split(',');
  return bruto.map((v) => Number(String(v).trim())).filter(Number.isInteger);
}

/** Lista de clientes facturables — solo para admins (alimenta el selector). */
app.get('/api/facturacion/clientes', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.json({ es_admin: false, clientes: [configFacturacion(propio)] });
  }
  const clientes = db
    .prepare('SELECT * FROM clientes ORDER BY (id = ?) DESC, nombre_negocio COLLATE NOCASE ASC, email ASC')
    .all(propio.id);
  res.json({ es_admin: true, clientes: clientes.map(configFacturacion) });
});

app.get('/api/facturacion/config', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });
  res.json({ config: configFacturacion(cliente), emisor: datosEmisor() });
});

app.put('/api/facturacion/config', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const { tarifa_por_mensaje, moneda, iva_porcentaje, nit, direccion_fiscal, ciudad, telefono_contacto } =
    req.body || {};

  const tarifa = Number(tarifa_por_mensaje);
  if (!Number.isFinite(tarifa) || tarifa < 0) {
    return res.status(400).json({ error: 'La tarifa por mensaje debe ser un número mayor o igual a 0' });
  }
  const iva = Number(iva_porcentaje ?? 0);
  if (!Number.isFinite(iva) || iva < 0 || iva > 100) {
    return res.status(400).json({ error: 'El IVA debe ser un porcentaje entre 0 y 100' });
  }
  const monedaLimpia = String(moneda || 'COP').trim().toUpperCase().slice(0, 6) || 'COP';

  db.prepare(
    `UPDATE clientes
     SET tarifa_por_mensaje = ?, moneda = ?, iva_porcentaje = ?, nit = ?, direccion_fiscal = ?, ciudad = ?, telefono_contacto = ?
     WHERE id = ?`
  ).run(
    tarifa,
    monedaLimpia,
    iva,
    nit ? String(nit).trim() : null,
    direccion_fiscal ? String(direccion_fiscal).trim() : null,
    ciudad ? String(ciudad).trim() : null,
    telefono_contacto ? String(telefono_contacto).trim() : null,
    cliente.id
  );

  const actualizado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente.id);
  res.json({ config: configFacturacion(actualizado) });
});

/** Estadísticas en vivo de las campañas seleccionadas (lo que ve el panel). */
app.post('/api/facturacion/estadisticas', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanas = campanasParaFacturar(cliente.id, req.body?.campana_ids);
  if (campanas.length === 0) {
    return res.status(400).json({ error: 'Elegí al menos una campaña de este cliente' });
  }

  const resumen = calcularResumen({
    campanas,
    tarifa: Number(cliente.tarifa_por_mensaje) || 0,
    ivaPorcentaje: Number(cliente.iva_porcentaje) || 0,
    moneda: cliente.moneda || 'COP',
  });

  res.json({ resumen, config: configFacturacion(cliente) });
});

/** Reporte de estadísticas en PDF (no crea factura, es solo el respaldo). */
app.get('/api/facturacion/reporte.pdf', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanas = campanasParaFacturar(cliente.id, idsDesdeQuery(req.query.ids));
  if (campanas.length === 0) {
    return res.status(400).json({ error: 'Elegí al menos una campaña de este cliente' });
  }

  const resumen = calcularResumen({
    campanas,
    tarifa: Number(cliente.tarifa_por_mensaje) || 0,
    ivaPorcentaje: Number(cliente.iva_porcentaje) || 0,
    moneda: cliente.moneda || 'COP',
  });

  try {
    const pdf = generarReportePdf({ resumen, cliente });
    const nombre = nombreArchivo(`reporte-${cliente.nombre_negocio || cliente.email}-${new Date().toISOString().slice(0, 10)}`);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${nombre}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Error generando el reporte PDF:', err);
    res.status(500).json({ error: 'No se pudo generar el reporte PDF' });
  }
});

/**
 * Numeración correlativa por año: CRT-2026-0001. Se calcula sobre el
 * máximo ya emitido de ese año (y no sobre un COUNT) para que anular o
 * borrar una factura no haga que se repita un número.
 */
function siguienteNumeroFactura(prefijo) {
  const anio = new Date().getUTCFullYear();
  const raiz = `${prefijo}-${anio}-`;
  const filas = db
    .prepare('SELECT numero FROM facturas WHERE numero LIKE ? ORDER BY id DESC')
    .all(`${raiz}%`);

  let maximo = 0;
  for (const fila of filas) {
    const secuencia = Number(fila.numero.slice(raiz.length));
    if (Number.isInteger(secuencia) && secuencia > maximo) maximo = secuencia;
  }
  return `${raiz}${String(maximo + 1).padStart(4, '0')}`;
}

app.post('/api/facturacion/facturas', (req, res) => {
  const { cliente, propio, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanas = campanasParaFacturar(cliente.id, req.body?.campana_ids);
  if (campanas.length === 0) {
    return res.status(400).json({ error: 'Elegí al menos una campaña de este cliente' });
  }

  const tarifa = Number(cliente.tarifa_por_mensaje) || 0;
  if (tarifa <= 0) {
    return res.status(400).json({ error: 'Configurá primero la tarifa por mensaje de este cliente' });
  }

  const resumen = calcularResumen({
    campanas,
    tarifa,
    ivaPorcentaje: Number(cliente.iva_porcentaje) || 0,
    moneda: cliente.moneda || 'COP',
  });

  if (resumen.totales.mensajes_facturables === 0) {
    return res.status(400).json({
      error: 'Las campañas seleccionadas no tienen mensajes enviados, así que no hay nada para cobrar',
    });
  }

  const notas = req.body?.notas ? String(req.body.notas).trim().slice(0, 2000) : null;

  // La numeración y el INSERT van juntos en una transacción para que dos
  // pedidos simultáneos no puedan calcular el mismo número.
  db.exec('BEGIN IMMEDIATE');
  let factura;
  try {
    const numero = siguienteNumeroFactura(datosEmisor().prefijo);
    const resultado = db
      .prepare(
        `INSERT INTO facturas (
           numero, cliente_id, emitida_por_id, campana_ids_json, detalle_json, datos_cliente_json,
           total_mensajes, tarifa_unitaria, subtotal, iva_porcentaje, iva_monto, total, moneda,
           periodo_desde, periodo_hasta, notas
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        numero,
        cliente.id,
        propio.id,
        JSON.stringify(resumen.detalle.map((linea) => linea.campana_id)),
        JSON.stringify(resumen.detalle),
        JSON.stringify(configFacturacion(cliente)),
        resumen.totales.mensajes_facturables,
        tarifa,
        resumen.subtotal,
        resumen.iva_porcentaje,
        resumen.iva_monto,
        resumen.total,
        resumen.moneda,
        resumen.periodo_desde,
        resumen.periodo_hasta,
        notas
      );
    factura = db.prepare('SELECT * FROM facturas WHERE id = ?').get(resultado.lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  res.status(201).json({ factura: serializarFactura(factura) });
});

function serializarFactura(fila) {
  return {
    ...fila,
    campana_ids: JSON.parse(fila.campana_ids_json || '[]'),
    detalle: JSON.parse(fila.detalle_json || '[]'),
    datos_cliente: JSON.parse(fila.datos_cliente_json || '{}'),
  };
}

app.get('/api/facturacion/facturas', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const facturas = db
    .prepare('SELECT * FROM facturas WHERE cliente_id = ? ORDER BY id DESC')
    .all(cliente.id);
  res.json({ facturas: facturas.map(serializarFactura) });
});

const ESTADOS_FACTURA = new Set(['emitida', 'pagada', 'anulada']);

app.patch('/api/facturacion/facturas/:id', (req, res) => {
  const propio = clienteActual(req);
  const factura = db.prepare('SELECT * FROM facturas WHERE id = ?').get(req.params.id);
  if (!factura || (factura.cliente_id !== propio.id && !propio.es_admin)) {
    return res.status(404).json({ error: 'Factura no encontrada' });
  }

  const { estado } = req.body || {};
  if (!ESTADOS_FACTURA.has(estado)) {
    return res.status(400).json({ error: 'Estado inválido (emitida, pagada o anulada)' });
  }

  db.prepare('UPDATE facturas SET estado = ?, pagada_en = ? WHERE id = ?').run(
    estado,
    estado === 'pagada' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    factura.id
  );
  res.json({ factura: serializarFactura(db.prepare('SELECT * FROM facturas WHERE id = ?').get(factura.id)) });
});

/**
 * PDF de una factura ya emitida. Se arma con el detalle CONGELADO en la
 * fila, no volviendo a consultar `envios` — así el documento es
 * reproducible aunque después cambie la tarifa o se borren campañas.
 */
app.get('/api/facturacion/facturas/:id/pdf', (req, res) => {
  const propio = clienteActual(req);
  const factura = db.prepare('SELECT * FROM facturas WHERE id = ?').get(req.params.id);
  if (!factura || (factura.cliente_id !== propio.id && !propio.es_admin)) {
    return res.status(404).json({ error: 'Factura no encontrada' });
  }

  try {
    const pdf = generarFacturaPdf({
      factura,
      detalle: JSON.parse(factura.detalle_json || '[]'),
      datosCliente: JSON.parse(factura.datos_cliente_json || '{}'),
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${nombreArchivo(`factura-${factura.numero}`)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Error generando la factura PDF:', err);
    res.status(500).json({ error: 'No se pudo generar la factura PDF' });
  }
});

// ==================== LEADS (PROSPECCIÓN B2B) ====================

/**
 * Busca negocios de una categoría en una ciudad colombiana (Google
 * Places si hay GOOGLE_PLACES_API_KEY en .env, si no cae a
 * Nominatim+Overpass gratis — ver leads.js) y guarda los que tengan
 * teléfono. Hace dedup por teléfono: si ya existía un lead con ese
 * número, no lo duplica (ON CONFLICT DO NOTHING).
 *
 * Esta tabla es independiente de contactos/campanas/envios — estos
 * leads NUNCA se usan para enviar mensajes automáticamente, son solo
 * para prospección manual.
 *
 * Body: { query: string, ciudad: string }
 */
app.post('/api/leads/buscar', async (req, res) => {
  const { query, ciudad } = req.body || {};
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'Falta el término de búsqueda (query)' });
  }
  if (!ciudad || !String(ciudad).trim()) {
    return res.status(400).json({ error: 'Falta la ciudad' });
  }

  const busqueda = await buscarNegocios({ query: query.trim(), ciudad: ciudad.trim() });
  if (!busqueda.ok) {
    return res.status(502).json({ error: busqueda.error });
  }

  const insert = db.prepare(`
    INSERT INTO leads_prospectos (nombre, rubro, direccion, telefono, link_whatsapp, sitio_web, cliente_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cliente_id, telefono) DO NOTHING
  `);

  let nuevos = 0;
  let duplicados = 0;
  for (const r of busqueda.resultados) {
    const result = insert.run(r.nombre, r.rubro, r.direccion, r.telefono, r.link_whatsapp, r.sitio_web, req.session.clienteId);
    if (result.changes > 0) nuevos++;
    else duplicados++;
  }

  res.json({
    proveedor: busqueda.proveedor,
    total_encontrados: busqueda.resultados.length,
    nuevos,
    duplicados,
  });
});

app.get('/api/leads', (req, res) => {
  const { estado } = req.query;
  const leads = estado
    ? db.prepare('SELECT * FROM leads_prospectos WHERE cliente_id = ? AND estado = ? ORDER BY fecha_encontrado DESC').all(req.session.clienteId, estado)
    : db.prepare('SELECT * FROM leads_prospectos WHERE cliente_id = ? ORDER BY fecha_encontrado DESC').all(req.session.clienteId);
  res.json({ leads });
});

app.patch('/api/leads/:id', (req, res) => {
  const { estado } = req.body || {};
  if (!estado || !String(estado).trim()) {
    return res.status(400).json({ error: 'Falta el estado' });
  }
  const result = db
    .prepare('UPDATE leads_prospectos SET estado = ? WHERE id = ? AND cliente_id = ?')
    .run(estado.trim(), req.params.id, req.session.clienteId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Lead no encontrado' });
  }
  res.json({ ok: true });
});

// ==================== WEBHOOK DE WHATSAPP ====================
//
// Recibe dos tipos de eventos de Meta:
//  - `statuses`: confirmaciones de entrega de mensajes salientes que
//    mandó esta app (enviado -> entregado -> leido, o fallido). Se
//    matchean por `wa_message_id` contra `envios` (campañas) y
//    `mensajes` (respuestas manuales).
//  - `messages`: mensajes entrantes de las personas (respuestas). Se
//    guardan en `mensajes` para verlos y contestarlos desde la pestaña
//    "Webhook".
//
// Configuración en Meta (App > WhatsApp > Configuration > Webhook):
//   Callback URL: https://tu-dominio/webhook
//   Verify token: el valor de WHATSAPP_VERIFY_TOKEN en .env
// Si además configurás WHATSAPP_APP_SECRET, se valida la firma
// HMAC-SHA256 de cada request (header X-Hub-Signature-256) para
// asegurarnos de que el POST viene realmente de Meta.

const ESTADO_RANK = { enviado: 1, entregado: 2, leido: 3, fallido: 99 };
const MAPA_ESTADOS_META = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };

const insertMensajeEntrante = db.prepare(`
  INSERT INTO mensajes (telefono, direccion, tipo, texto, media_id, media_mime_type, wa_message_id, estado, nombre_perfil, leido_por_agente, cliente_id)
  VALUES (?, 'entrante', ?, ?, ?, ?, ?, 'recibido', ?, 0, ?)
`);

const clientePorPhoneNumberId = db.prepare('SELECT id FROM clientes WHERE phone_number_id = ?');

// Tipos de mensaje que traen un archivo descargable de Meta (`msg.<tipo>.id`
// + `.mime_type`) — se guardan para poder mostrarlos después vía
// GET /api/mensajes/:id/media (ver más abajo).
const TIPOS_CON_MEDIA = new Set(['image', 'sticker', 'video', 'audio', 'document']);

function extraerTextoMensaje(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body || '';
    case 'button':
      return msg.button?.text || '';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interactivo]';
    case 'image':
      return msg.image?.caption || '[Imagen]';
    case 'video':
      return msg.video?.caption || '[Video]';
    case 'audio':
      return msg.audio?.voice ? '[Nota de voz]' : '[Audio]';
    case 'document':
      return msg.document?.caption || `[Documento] ${msg.document?.filename || ''}`.trim();
    case 'sticker':
      return '[Sticker]';
    case 'location':
      return '[Ubicación]';
    default:
      return `[${msg.type || 'mensaje'}]`;
  }
}

function extraerMedia(msg) {
  if (!TIPOS_CON_MEDIA.has(msg.type)) return { mediaId: null, mimeType: null };
  const campo = msg[msg.type] || {};
  return { mediaId: campo.id || null, mimeType: campo.mime_type || null };
}

function aplicarEstadoSiCorresponde(tabla, waMessageId, nuevoEstado, error) {
  const fila = db.prepare(`SELECT estado FROM ${tabla} WHERE wa_message_id = ?`).get(waMessageId);
  if (!fila) return;
  const rankActual = ESTADO_RANK[fila.estado] || 0;
  const rankNuevo = ESTADO_RANK[nuevoEstado] || 0;
  if (nuevoEstado === 'fallido' || rankNuevo > rankActual) {
    db.prepare(`UPDATE ${tabla} SET estado = ?, error = ? WHERE wa_message_id = ?`).run(nuevoEstado, error, waMessageId);
  }
}

function procesarWebhookWhatsApp(body) {
  for (const entrada of body.entry || []) {
    for (const cambio of entrada.changes || []) {
      const valor = cambio.value || {};

      // Un solo webhook de Meta recibe eventos de TODAS las WABAs
      // suscriptas a la app — hay que resolver a qué cliente pertenece
      // este evento por el phone_number_id que manda Meta en el payload.
      const phoneNumberId = valor.metadata?.phone_number_id;
      const cliente = phoneNumberId ? clientePorPhoneNumberId.get(phoneNumberId) : null;
      if (!cliente) continue; // evento de un número que no conocemos (o app en dev con otro tester)

      const nombresPerfil = {};
      for (const c of valor.contacts || []) {
        if (c.wa_id && c.profile?.name) nombresPerfil[c.wa_id] = c.profile.name;
      }

      for (const msg of valor.messages || []) {
        const telefono = msg.from;
        if (!telefono) continue;
        const { mediaId, mimeType } = extraerMedia(msg);
        insertMensajeEntrante.run(
          telefono,
          msg.type || 'texto',
          extraerTextoMensaje(msg),
          mediaId,
          mimeType,
          msg.id || null,
          nombresPerfil[telefono] || null,
          cliente.id
        );
      }

      for (const estado of valor.statuses || []) {
        const nuevoEstado = MAPA_ESTADOS_META[estado.status];
        if (!nuevoEstado || !estado.id) continue;
        const error = estado.errors?.[0]?.title || null;
        aplicarEstadoSiCorresponde('envios', estado.id, nuevoEstado, error);
        aplicarEstadoSiCorresponde('mensajes', estado.id, nuevoEstado, error);
      }
    }
  }
}

function verificarFirmaWebhook(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // sin secret configurado no se valida (ok para desarrollo local)
  const firma = req.headers['x-hub-signature-256'];
  if (!firma || !req.rawBody) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const bufA = Buffer.from(firma);
  const bufB = Buffer.from(esperada);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Verificación inicial que pide Meta al configurar el webhook.
app.get('/webhook', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (modo === 'subscribe' && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verificarFirmaWebhook(req)) {
    return res.sendStatus(403);
  }
  // Meta espera un 200 rápido — respondemos antes de procesar.
  res.sendStatus(200);
  try {
    procesarWebhookWhatsApp(req.body);
  } catch (err) {
    console.error('Error procesando webhook de WhatsApp:', err);
  }
});

// ==================== CONVERSACIONES (respuestas de la gente) ====================

app.get('/api/conversaciones', (req, res) => {
  const clienteId = req.session.clienteId;
  const telefonos = db
    .prepare(`SELECT telefono, MAX(creado_en) AS ultimo_en FROM mensajes WHERE cliente_id = ? GROUP BY telefono ORDER BY ultimo_en DESC`)
    .all(clienteId);

  const conversaciones = telefonos.map(({ telefono }) => {
    const ultimo = db
      .prepare(`SELECT texto, direccion, estado, creado_en FROM mensajes WHERE telefono = ? AND cliente_id = ? ORDER BY creado_en DESC, id DESC LIMIT 1`)
      .get(telefono, clienteId);
    const contacto = db.prepare('SELECT nombre FROM contactos WHERE telefono = ? AND cliente_id = ?').get(telefono, clienteId);
    const noLeidos = db
      .prepare(`SELECT COUNT(*) AS n FROM mensajes WHERE telefono = ? AND cliente_id = ? AND direccion = 'entrante' AND leido_por_agente = 0`)
      .get(telefono, clienteId).n;
    return {
      telefono,
      nombre: contacto?.nombre || null,
      ultimo_mensaje: ultimo?.texto || '',
      ultimo_direccion: ultimo?.direccion,
      ultimo_estado: ultimo?.estado,
      ultimo_en: ultimo?.creado_en,
      no_leidos: noLeidos,
    };
  });

  res.json({ conversaciones });
});

app.get('/api/conversaciones/:telefono/mensajes', (req, res) => {
  const { telefono } = req.params;
  const clienteId = req.session.clienteId;
  const mensajes = db
    .prepare('SELECT * FROM mensajes WHERE telefono = ? AND cliente_id = ? ORDER BY creado_en ASC, id ASC')
    .all(telefono, clienteId);
  db.prepare(`UPDATE mensajes SET leido_por_agente = 1 WHERE telefono = ? AND cliente_id = ? AND direccion = 'entrante' AND leido_por_agente = 0`).run(telefono, clienteId);
  res.json({ mensajes });
});

/**
 * Proxy autenticado para bajar el archivo (imagen/sticker/video/audio/
 * documento) de un mensaje del webhook. Meta no da una URL pública
 * directa: hay que pedir la URL temporal con GET /{media_id} y después
 * bajar esa URL, ambos pasos con el access token del cliente dueño del
 * mensaje — por eso esto pasa por el servidor y no directo desde el
 * navegador.
 */
app.get('/api/mensajes/:id/media', async (req, res) => {
  const mensaje = db
    .prepare(
      `SELECT m.media_id, m.media_mime_type, c.access_token
       FROM mensajes m JOIN clientes c ON c.id = m.cliente_id
       WHERE m.id = ? AND m.cliente_id = ?`
    )
    .get(req.params.id, req.session.clienteId);

  if (!mensaje || !mensaje.media_id) {
    return res.status(404).json({ error: 'Mensaje sin archivo adjunto' });
  }
  if (!mensaje.access_token) {
    return res.status(400).json({ error: 'Este cliente no tiene WhatsApp conectado' });
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mensaje.media_id}`, {
      headers: { Authorization: `Bearer ${mensaje.access_token}` },
    });
    const metaData = await metaRes.json();
    if (!metaRes.ok || !metaData.url) {
      return res.status(502).json({ error: metaData.error?.message || 'No se pudo obtener el archivo (puede haber expirado en los servidores de Meta)' });
    }

    const archivoRes = await fetch(metaData.url, {
      headers: { Authorization: `Bearer ${mensaje.access_token}` },
    });
    if (!archivoRes.ok) {
      return res.status(502).json({ error: `Meta devolvió HTTP ${archivoRes.status} al bajar el archivo` });
    }

    res.set('Content-Type', mensaje.media_mime_type || metaData.mime_type || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    const buffer = Buffer.from(await archivoRes.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Manda una respuesta de texto libre a una conversación. Solo funciona
 * dentro de la ventana de 24hs desde el último mensaje del usuario
 * (restricción de Meta) — fuera de eso hay que usar una plantilla
 * (pestaña "Nueva campaña").
 */
app.post('/api/conversaciones/:telefono/responder', async (req, res) => {
  const { telefono } = req.params;
  const { texto } = req.body || {};
  const cliente = clienteActual(req);
  if (!texto || !String(texto).trim()) {
    return res.status(400).json({ error: 'Falta el texto del mensaje' });
  }
  if (!isWhatsAppConfigured(cliente.phone_number_id, cliente.access_token)) {
    return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de WhatsApp Business' });
  }

  const textoLimpio = texto.trim();
  const resultado = await sendTextMessage({ to: telefono, body: textoLimpio, phoneNumberId: cliente.phone_number_id, accessToken: cliente.access_token });

  const insertado = db
    .prepare(`
      INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, error, leido_por_agente, cliente_id)
      VALUES (?, 'saliente', 'texto', ?, ?, ?, ?, 1, ?)
    `)
    .run(telefono, textoLimpio, resultado.messageId || null, resultado.ok ? 'enviado' : 'fallido', resultado.ok ? null : resultado.error, cliente.id);

  if (!resultado.ok) {
    return res.status(502).json({ error: resultado.error, id: insertado.lastInsertRowid });
  }
  res.status(201).json({ id: insertado.lastInsertRowid, wa_message_id: resultado.messageId });
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Envío masivo de WhatsApp corriendo en http://localhost:${PORT}`);
});
