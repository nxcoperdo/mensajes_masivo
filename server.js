import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto, { timingSafeEqual } from 'crypto';
import { db } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { parseCsv } from './csv.js';
import { parsearFechaEnvio, analizarFechaEnvio, esColumnaFechaEnvio } from './fechas.js';
import { parseExcel } from './excel.js';
import { sendTextMessage, subirMedia, normalizePhone, isWhatsAppConfigured } from './whatsapp.js';
import { normalizarVideoWhatsApp, MAX_VIDEO_BYTES } from './video.js';
import { procesarCampana, validarParametrosDef, particionarPorParametros, reembolsarEnvio } from './campanas.js';
import { iniciarScheduler } from './scheduler.js';
import { validarContenidoPlantilla, validarBotones } from './plantillas.js';
import {
  CATEGORIAS_CREDITO,
  esClienteIndependiente,
  obtenerConfigCreditos,
  guardarConfigCreditos,
  costoPorMensaje,
  IVA_PORCENTAJE,
  registrarMovimientoCreditos,
} from './creditos.js';
import {
  clienteTienePlanActivo,
  pesoMensaje,
  obtenerPlanesCatalogo,
  guardarPlanesCatalogo,
  cuotaRestante,
  contactosQueEntran,
} from './planes.js';
import { buscarNegocios } from './leads.js';
import {
  calcularResumen,
  calcularCotizacion,
  datosEmisor,
  generarFacturaPdf,
  generarReportePdf,
  generarHistorialDetalladoPdf,
  generarCotizacionPdf,
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
      return cb(new Error('Formato no soportado. Usa un archivo .csv, .xlsx o .xls'));
    }
    cb(null, true);
  },
});

const EXTENSIONES_IMAGEN_PERMITIDAS = ['.jpg', '.jpeg', '.png'];
const EXTENSIONES_VIDEO_PERMITIDAS = ['.mp4', '.3gp', '.3gpp'];
const EXTENSIONES_ENCABEZADO_PERMITIDAS = [
  ...EXTENSIONES_IMAGEN_PERMITIDAS,
  ...EXTENSIONES_VIDEO_PERMITIDAS,
];

/** Devuelve 'image' | 'video' según la extensión del archivo de encabezado. */
function tipoEncabezado(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  return EXTENSIONES_VIDEO_PERMITIDAS.includes(ext) ? 'video' : 'image';
}

const uploadImagen = multer({
  storage: multer.memoryStorage(),
  // Tope de subida generoso: un video se re-codifica después y recién
  // ahí se valida contra el límite real de Meta (16MB). Imágenes: 5MB.
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSIONES_ENCABEZADO_PERMITIDAS.includes(ext)) {
      return cb(new Error('Formato no soportado. El encabezado debe ser una imagen (.jpg, .jpeg, .png) o un video (.mp4, .3gp)'));
    }
    cb(null, true);
  },
});

// Muestra de encabezado de una SOLICITUD de plantilla (ver sección PLANTILLAS
// más abajo). A diferencia de `uploadImagen` (que sube directo a Meta durante
// un envío real), acá no hay ningún envío a Meta — es solo la referencia que
// el admin va a mirar para recrear la plantilla a mano, así que se guarda en
// disco tal cual.
const DIR_MUESTRAS_PLANTILLAS = path.join(__dirname, 'public', 'uploads', 'plantillas');
fs.mkdirSync(DIR_MUESTRAS_PLANTILLAS, { recursive: true });
const uploadMuestraPlantilla = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIR_MUESTRAS_PLANTILLAS),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSIONES_ENCABEZADO_PERMITIDAS.includes(ext)) {
      return cb(new Error('Formato no soportado. La muestra debe ser una imagen (.jpg, .jpeg, .png) o un video (.mp4, .3gp)'));
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
  '/planes.html',
  '/oauth/callback',
  '/privacidad.html',
  '/style.css',
  '/auth.css',
  '/favicon.ico',
  '/auth.js',
  '/api/auth/login',
  '/api/auth/registro',
  '/api/planes-publico',
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

// Límite general para toda la API: generoso para no afectar el uso normal
// (polling de estado, carga de config, etc.), solo frena abuso/DoS por
// fuerza bruta de requests repetidos.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Espera un momento y vuelve a intentar.' },
});
app.use('/api/', apiLimiter);

// Límite estricto solo para login/registro: frena fuerza bruta y
// credential stuffing sin afectar a un usuario normal equivocándose
// un par de veces con la contraseña.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos y vuelve a intentar.' },
});

function clienteActual(req) {
  return db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.session.clienteId);
}

// ==================== AUTENTICACIÓN ====================

app.post('/api/auth/registro', authLimiter, (req, res) => {
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

app.post('/api/auth/login', authLimiter, (req, res) => {
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
  res.type('html').send('<!doctype html><html lang="es"><body style="font-family: sans-serif; padding: 2rem;"><p>Puedes cerrar esta ventana.</p></body></html>');
});

// ==================== CONFIG ====================

app.get('/api/config', (req, res) => {
  const cliente = clienteActual(req);

  // Teléfono público al que apunta el botón "Número personalizado" de la
  // pestaña Plantillas (wa.me) — el del admin, tal cual lo cargó en
  // Facturación > telefono_contacto. No es una credencial, es el número al
  // que cualquier cliente le puede escribir por WhatsApp.
  const admin = db.prepare('SELECT telefono_contacto FROM clientes WHERE es_admin = 1 LIMIT 1').get();
  const contactoWhatsapp = admin?.telefono_contacto ? normalizePhone(admin.telefono_contacto) : null;

  // Para un cliente independiente (no admin), la pestaña Webhook no le
  // muestra la gestión completa de números (esa es del admin, que asigna
  // desde SU pool) — solo cuál es el suyo, en modo lectura. La etiqueta
  // linda vive en la fila de `whatsapp_numeros` de quien lo conectó (el
  // admin, si se lo asignó), así que se busca por phone_number_id sin
  // filtrar por cliente_id — no expone ninguna credencial, solo el nombre.
  let miNumero = null;
  if (cliente.phone_number_id) {
    const info = db.prepare('SELECT etiqueta FROM whatsapp_numeros WHERE phone_number_id = ? LIMIT 1').get(cliente.phone_number_id);
    miNumero = { phone_number_id: cliente.phone_number_id, etiqueta: info?.etiqueta || null };
  }

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
    contactoWhatsapp,
    miNumero,
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
    return res.status(400).json({ error: 'Todavía no tienes ningún número conectado — usa "Conectar WhatsApp Business" primero' });
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

// `cliente_id` (query/body, según el método) solo lo puede usar un admin —
// es lo que le permite gestionar los contactos de otra empresa desde el
// panel de administración (ver resolverClienteObjetivo).
app.get('/api/contactos', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const contactos = db
    .prepare('SELECT * FROM contactos WHERE cliente_id = ? ORDER BY nombre COLLATE NOCASE ASC')
    .all(cliente.id);
  res.json({ contactos });
});

app.post('/api/contactos', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const { telefono, nombre, fecha_recordatorio } = req.body || {};
  const normalizado = normalizePhone(telefono);
  if (!normalizado) {
    return res.status(400).json({ error: 'Teléfono inválido' });
  }
  const fechaRecordatorioNormalizada = fecha_recordatorio ? normalizarFechaProgramada(fecha_recordatorio) : null;
  if (fecha_recordatorio && !fechaRecordatorioNormalizada) {
    return res.status(400).json({ error: 'Fecha de envío inválida' });
  }
  try {
    const result = db
      .prepare('INSERT INTO contactos (telefono, nombre, cliente_id, fecha_recordatorio) VALUES (?, ?, ?, ?)')
      .run(normalizado, nombre || null, cliente.id, fechaRecordatorioNormalizada);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un contacto con ese teléfono' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reajusta las "listas guardadas" de un cliente después de borrar
 * contactos: saca de cada lista los ids que ya no existen y elimina las
 * listas que quedaron sin ningún contacto vivo — así no se acumulan
 * importaciones fantasma que solo confunden ("Usar esta lista" que no
 * selecciona nada).
 */
function limpiarListasObsoletas(clienteId) {
  const idsVivos = new Set(
    db.prepare('SELECT id FROM contactos WHERE cliente_id = ?').all(clienteId).map((c) => c.id)
  );
  const listas = db.prepare('SELECT * FROM listas_contactos WHERE cliente_id = ?').all(clienteId);
  for (const l of listas) {
    const guardados = JSON.parse(l.contacto_ids_json || '[]');
    const vigentes = guardados.filter((id) => idsVivos.has(id));
    if (vigentes.length === 0) {
      db.prepare('DELETE FROM listas_contactos WHERE id = ?').run(l.id);
    } else if (vigentes.length !== guardados.length) {
      db.prepare('UPDATE listas_contactos SET contacto_ids_json = ?, total = ? WHERE id = ?')
        .run(JSON.stringify(vigentes), vigentes.length, l.id);
    }
  }
}

app.delete('/api/contactos', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  db.prepare('DELETE FROM contactos WHERE cliente_id = ?').run(cliente.id);
  limpiarListasObsoletas(cliente.id);
  res.json({ ok: true });
});

app.delete('/api/contactos/:id', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  db.prepare('DELETE FROM contactos WHERE id = ? AND cliente_id = ?').run(req.params.id, cliente.id);
  limpiarListasObsoletas(cliente.id);
  res.json({ ok: true });
});

/**
 * Edita un contacto ya cargado — sobre todo pensado para poner o corregir
 * a mano su `fecha_recordatorio` (el envío individual, ver POST
 * /api/campanas con `individual=true`) cuando no vino de una columna del
 * CSV, o cuando hay que reprogramarlo sin tener que reimportar todo.
 */
app.patch('/api/contactos/:id', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const contacto = db.prepare('SELECT * FROM contactos WHERE id = ? AND cliente_id = ?').get(req.params.id, cliente.id);
  if (!contacto) return res.status(404).json({ error: 'Contacto no encontrado' });

  // Un campo que no viene en el body se conserva; uno que viene vacío se borra.
  const body = req.body || {};
  const { nombre, fecha_recordatorio } = body;
  const fechaNormalizada = fecha_recordatorio ? normalizarFechaProgramada(fecha_recordatorio) : null;
  if (fecha_recordatorio && !fechaNormalizada) {
    return res.status(400).json({ error: 'La fecha de envío no es válida. Usa el formato día/mes/año con hora.' });
  }

  const nombreFinal = 'nombre' in body ? nombre || null : contacto.nombre;
  const fechaFinal = 'fecha_recordatorio' in body ? fechaNormalizada : contacto.fecha_recordatorio;
  db.prepare('UPDATE contactos SET nombre = ?, fecha_recordatorio = ? WHERE id = ?')
    .run(nombreFinal, fechaFinal, contacto.id);

  res.json({ contacto: db.prepare('SELECT * FROM contactos WHERE id = ?').get(contacto.id) });
});

// Columnas del CSV/Excel con un significado propio — todo lo demás que
// traiga el archivo (fecha_cita, hora, servicio, etc.) se junta en
// `variables_json` y queda disponible como parámetro de plantilla
// (tipo 'variable', ver campanas.js).
const COLUMNAS_RECONOCIDAS_CONTACTO = new Set([
  'telefono', 'phone', 'numero', 'celular',
  'nombre', 'name',
]);

// La fecha de envío individual acepta varias cabeceras ("fecha_envio",
// "Fecha de envío", "fecha_recordatorio"…) — ver esColumnaFechaEnvio.
function variablesDeFila(row) {
  const variables = {};
  for (const [clave, valor] of Object.entries(row)) {
    if (COLUMNAS_RECONOCIDAS_CONTACTO.has(clave) || esColumnaFechaEnvio(clave)) continue;
    if (valor) variables[clave] = valor;
  }
  return variables;
}

/** Valor de la columna de fecha de envío de una fila, con la cabecera que haya usado el archivo. */
function fechaEnvioDeFila(row) {
  for (const [clave, valor] of Object.entries(row)) {
    if (esColumnaFechaEnvio(clave) && valor) return valor;
  }
  return '';
}

/**
 * Importa un CSV o Excel (.xlsx/.xls) con columnas `telefono` (o
 * `phone`/`numero`) y `nombre` (opcional). Hace upsert por teléfono
 * normalizado: si ya existe, actualiza el nombre; si no, lo crea.
 * Cualquier otra columna (ej: `fecha_cita`, `hora`, `servicio`) se
 * guarda como variable de plantilla del contacto, y `fecha_envio`/
 * `fecha_recordatorio` programa su recordatorio individual.
 */
app.post('/api/contactos/importar', (req, res) => {
  upload.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
    if (error) return res.status(status).json({ error });

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
      INSERT INTO contactos (telefono, nombre, cliente_id, variables_json, fecha_recordatorio)
      VALUES (?, ?, ?, COALESCE(?, '{}'), ?)
      ON CONFLICT(cliente_id, telefono) DO UPDATE SET
        nombre = COALESCE(excluded.nombre, contactos.nombre),
        variables_json = COALESCE(NULLIF(excluded.variables_json, '{}'), contactos.variables_json),
        fecha_recordatorio = COALESCE(excluded.fecha_recordatorio, contactos.fecha_recordatorio)
    `);

    let importados = 0;
    const invalidos = [];
    const telefonosImportados = [];
    // Resumen de la columna de fecha de envío — se devuelve al frontend para
    // que el usuario vea qué contactos quedaron programados y cuáles no,
    // en vez de enterarse recién cuando una campaña individual los omite.
    const ahoraSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const resumenFechas = { futuras: 0, sin_fecha: 0, invalidas: [], pasadas: [] };
    // `node:sqlite` no trae un helper `.transaction()` como better-sqlite3
    // — envolvemos a mano con BEGIN/COMMIT (y ROLLBACK si algo explota).
    db.exec('BEGIN');
    try {
      for (const row of filas) {
        const telefonoRaw = row.telefono || row.phone || row.numero || row.celular || '';
        const nombreRaw = row.nombre || row.name || '';
        const fechaRecordatorioRaw = fechaEnvioDeFila(row);
        const analisisFecha = analizarFechaEnvio(fechaRecordatorioRaw);
        const fechaRecordatorioNormalizada = analisisFecha.fecha;
        const normalizado = normalizePhone(telefonoRaw);
        if (!normalizado) {
          if (telefonoRaw) invalidos.push(telefonoRaw);
          continue;
        }
        if (analisisFecha.estado === 'vacia') {
          resumenFechas.sin_fecha++;
        } else if (analisisFecha.estado === 'invalida') {
          resumenFechas.invalidas.push({ telefono: normalizado, valor: String(fechaRecordatorioRaw) });
        } else if (fechaRecordatorioNormalizada > ahoraSql) {
          resumenFechas.futuras++;
        } else {
          resumenFechas.pasadas.push({ telefono: normalizado, fecha: fechaRecordatorioNormalizada });
        }
        const variables = variablesDeFila(row);
        upsert.run(
          normalizado,
          nombreRaw || null,
          cliente.id,
          Object.keys(variables).length > 0 ? JSON.stringify(variables) : null,
          fechaRecordatorioNormalizada
        );
        telefonosImportados.push(normalizado);
        importados++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: err.message });
    }

    // Guarda este lote como una "lista" reutilizable — resuelve los ids
    // reales (nuevos o ya existentes) por teléfono, en vez de confiar en
    // `lastInsertRowid` (poco fiable cuando el UPSERT actualiza en vez de
    // insertar).
    let listaId = null;
    let contactoIds = [];
    if (telefonosImportados.length > 0) {
      const marcadores = telefonosImportados.map(() => '?').join(',');
      contactoIds = db
        .prepare(`SELECT id FROM contactos WHERE cliente_id = ? AND telefono IN (${marcadores})`)
        .all(cliente.id, ...telefonosImportados)
        .map((c) => c.id);

      const resultLista = db
        .prepare('INSERT INTO listas_contactos (cliente_id, nombre, contacto_ids_json, total) VALUES (?, ?, ?, ?)')
        .run(cliente.id, req.file.originalname, JSON.stringify(contactoIds), contactoIds.length);
      listaId = resultLista.lastInsertRowid;
    }

    res.json({ importados, invalidos, total_filas: filas.length, contacto_ids: contactoIds, lista_id: listaId, fechas: resumenFechas });
  });
});

// ==================== LISTAS DE CONTACTOS (importaciones guardadas) ====================

app.get('/api/listas', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const listas = db
    .prepare('SELECT * FROM listas_contactos WHERE cliente_id = ? ORDER BY id DESC')
    .all(cliente.id);

  // Los ids guardados en la lista pueden quedar obsoletos: si después se
  // borraron esos contactos, o se reimportó el mismo archivo (el import
  // crea filas con ids NUEVOS cuando los viejos ya no están), la lista
  // seguiría apuntando a ids que ya no existen. Sin filtrar, "Usar esta
  // lista" seleccionaba ids muertos —> no se tildaba ningún contacto y la
  // campaña fallaba con "No se encontraron los contactos seleccionados".
  // Resolvemos contra los contactos que existen HOY para este cliente.
  const idsVivos = new Set(
    db.prepare('SELECT id FROM contactos WHERE cliente_id = ?').all(cliente.id).map((c) => c.id)
  );

  res.json({
    listas: listas.map((l) => {
      const guardados = JSON.parse(l.contacto_ids_json || '[]');
      const vigentes = guardados.filter((id) => idsVivos.has(id));
      return {
        id: l.id,
        nombre: l.nombre,
        total: vigentes.length,
        total_guardado: l.total,
        obsoletos: guardados.length - vigentes.length,
        creado_en: l.creado_en,
        contacto_ids: vigentes,
      };
    }),
  });
});

app.delete('/api/listas/:id', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  db.prepare('DELETE FROM listas_contactos WHERE id = ? AND cliente_id = ?').run(req.params.id, cliente.id);
  res.json({ ok: true });
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
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campana = db.prepare('SELECT * FROM campanas WHERE id = ? AND cliente_id = ?').get(req.params.id, cliente.id);
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
 * Convierte lo que venga de un input `datetime-local` (o una fecha de un
 * CSV/Excel, ej: `25/10/2026 9:00`) a un datetime UTC comparable con
 * `datetime('now')` de SQLite (mismo formato que ya usa `pagada_en` en
 * facturas). Sin zona explícita se interpreta en hora de Colombia. Devuelve
 * `null` si no se pudo interpretar como fecha — ver `fechas.js`.
 */
function normalizarFechaProgramada(valor) {
  return parsearFechaEnvio(valor);
}

/**
 * Fecha de envío ya guardada en un contacto. Se guarda en UTC
 * ('YYYY-MM-DD HH:MM:SS'), así que NO se vuelve a pasar por
 * `normalizarFechaProgramada`: sin zona explícita la leería como hora de
 * Colombia y le sumaría 5 horas otra vez (un recordatorio de las 8 p. m. del
 * 13 terminaba el 14).
 */
function fechaGuardadaDeContacto(contacto) {
  const valor = String(contacto.fecha_recordatorio || '').trim();
  if (!valor) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(valor) ? valor : normalizarFechaProgramada(valor);
}

function esFechaFutura(fechaSql) {
  return Boolean(fechaSql) && fechaSql > new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Crea una campaña y, si no está programada, dispara el envío EN SEGUNDO
 * PLANO (no bloquea el request — con 250+ contactos y un delay entre
 * cada uno, esto puede tardar más de un minuto). El frontend hace
 * polling a `GET /api/campanas/:id` para ver el progreso.
 *
 * multipart/form-data (no JSON, porque puede traer una imagen):
 *   cliente_id: string (opcional, solo admin) — empresa para la que se crea
 *   template_nombre: string
 *   idioma: string (default 'es')
 *   contacto_ids: string (JSON de number[])
 *   parametros: string (JSON de Array<{ tipo: 'fijo'|'nombre'|'variable', valor?, clave? }>)
 *     - 'nombre': nombre del contacto (o el teléfono si no tiene).
 *     - 'variable': `contacto.variables_json[clave]` (ej: fecha_cita, hora).
 *     - 'fijo': se manda `valor` tal cual, igual para todos.
 *   fecha_programada: string (opcional) — fecha/hora común para toda la
 *     campaña; si es futura, no se envía ahora sino cuando el scheduler
 *     la vea vencida (ver scheduler.js).
 *   individual: 'true' (opcional) — en vez de una campaña con todos los
 *     contactos, crea UNA CAMPAÑA POR CONTACTO usando el
 *     `fecha_recordatorio` propio de cada uno (contactos sin esa fecha
 *     quedan afuera, reportados en `omitidos`).
 *   recurrente_mensual: 'true' (opcional) — al completarse el envío, se
 *     clona la campaña para el mismo día del mes siguiente (ver
 *     campanas.js). Sirve tanto en modo común como individual.
 *   imagen: archivo (opcional) — solo si la plantilla tiene un
 *     encabezado de tipo imagen o video. Se sube una vez a Meta y se
 *     reusa el media_id para todos los envíos. Si es un video se
 *     re-codifica con ffmpeg (H.264/AAC/faststart) para que se vea en
 *     Android, no solo en iOS.
 */
app.post('/api/campanas', (req, res) => {
  uploadImagen.single('imagen')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
    if (error) return res.status(status).json({ error });

    const { template_nombre, idioma, fecha_programada, individual, recurrente_mensual, flow_boton } = req.body || {};
    const esRecurrenteMensual = recurrente_mensual === 'true' || recurrente_mensual === true ? 1 : 0;
    const esFlowBoton = flow_boton === 'true' || flow_boton === true ? 1 : 0;
    let contacto_ids, parametros, flowActionData;
    try {
      contacto_ids = JSON.parse(req.body?.contacto_ids || '[]');
      parametros = JSON.parse(req.body?.parametros || '[]');
      // Datos opcionales para la primera pantalla del Flow (raro; la
      // mayoría de las encuestas no lo necesitan).
      flowActionData = req.body?.flow_action_data ? JSON.parse(req.body.flow_action_data) : null;
    } catch {
      return res.status(400).json({ error: 'Formato inválido en contacto_ids / parametros / flow_action_data' });
    }
    const flowActionDataJson = flowActionData && Object.keys(flowActionData).length > 0 ? JSON.stringify(flowActionData) : null;

    if (!template_nombre || !String(template_nombre).trim()) {
      return res.status(400).json({ error: 'Falta el nombre de la plantilla' });
    }
    if (!Array.isArray(contacto_ids) || contacto_ids.length === 0) {
      return res.status(400).json({ error: 'Elige al menos un contacto' });
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

    const parametrosDef = Array.isArray(parametros) ? parametros : [];
    const errorParametros = validarParametrosDef(parametros);
    if (errorParametros) return res.status(400).json({ error: errorParametros });

    // Contactos que de verdad se van a enviar: los que tienen el dato de
    // cada parámetro y, en modo individual, además una fecha propia válida.
    // Solo ellos cuentan para el saldo/cuota — los omitidos no se cobran.
    const { enviables: conParametros, omitidos: omitidosPorParametros } = particionarPorParametros(parametrosDef, contactos);
    const esIndividual = individual === 'true' || individual === true;
    const sinFechaPropia = esIndividual ? conParametros.filter((c) => !fechaGuardadaDeContacto(c)) : [];
    const contactosAEnviar = esIndividual ? conParametros.filter((c) => fechaGuardadaDeContacto(c)) : conParametros;
    if (contactosAEnviar.length === 0) {
      const motivos = [];
      if (sinFechaPropia.length > 0) motivos.push(`${sinFechaPropia.length} sin fecha de envío propia`);
      if (omitidosPorParametros.length > 0) motivos.push(`${omitidosPorParametros.length} sin el dato de algún parámetro`);
      return res.status(400).json({
        error: `Ninguno de los contactos seleccionados se puede enviar (${motivos.join(', ') || 'sin datos'}). Revisa las fechas y los parámetros.`,
        omitidos_parametros: omitidosPorParametros.map((o) => ({ telefono: o.telefono, faltantes: o.faltantes })),
      });
    }

    // El costo en créditos varía según el tipo de contenido del encabezado
    // (texto/imagen/video), así que hace falta saberlo ANTES del chequeo de
    // saldo — tipoEncabezado() es puro sobre el nombre de archivo, no hace
    // falta esperar a subir el media para calcularlo.
    let encabezadoTipo = req.file ? tipoEncabezado(req.file.originalname) : null;

    // Sistema de créditos (prepago) — solo aplica a clientes independientes.
    // Admin y empresas gestionadas siguen con la facturación de siempre
    // (categoriaPlantilla queda null para ellos, y procesarCampana lo salta).
    let categoriaPlantilla = null;
    if (esClienteIndependiente(cliente)) {
      categoriaPlantilla = String(req.body?.categoria_plantilla || '').toUpperCase();
      if (!CATEGORIAS_CREDITO.includes(categoriaPlantilla)) {
        return res.status(400).json({ error: 'Elige la categoría de la plantilla (Marketing, Utilidad o Autenticación) para calcular el costo en créditos' });
      }
      if (clienteTienePlanActivo(cliente)) {
        // Camino plan mensual: cuota fija, sin distinguir texto/imagen/video.
        // No hay desborde automático a créditos — el frontend ya debería
        // haber evitado llegar acá (ver btnEnviarCampana en app.js), pero
        // el backend es la fuente de verdad.
        const peso = pesoMensaje(categoriaPlantilla);
        const necesarios = peso * contactosAEnviar.length;
        const { mediosLibres } = cuotaRestante(cliente.id);
        if (necesarios > mediosLibres) {
          return res.status(409).json({
            error: 'cuota_insuficiente',
            contactosDisponibles: Math.floor(mediosLibres / peso),
          });
        }
      } else {
        // Camino créditos sueltos (recarga suelta, precios reales COP).
        const costoTotal = costoPorMensaje(categoriaPlantilla, encabezadoTipo) * contactosAEnviar.length;
        if (cliente.creditos < costoTotal) {
          return res.status(402).json({ error: `No te alcanzan los créditos: esta campaña necesita ${costoTotal} y tienes ${cliente.creditos}.` });
        }
      }
    }

    let imagenMediaId = null;
    if (req.file) {
      let { buffer, mimetype } = req.file;

      if (encabezadoTipo === 'video') {
        // Re-codifica a H.264/AAC/faststart para que Android no lo
        // muestre como "archivo dañado" (los videos de iPhone vienen en
        // HEVC y solo se ven en iOS / WhatsApp Web).
        const norm = await normalizarVideoWhatsApp(buffer);
        buffer = norm.buffer;
        mimetype = norm.mimetype;
        if (!norm.convertido) {
          console.warn(`[campañas] video de encabezado enviado sin normalizar: ${norm.error}`);
        }
        if (buffer.length > MAX_VIDEO_BYTES) {
          return res.status(400).json({
            error: 'El video supera los 16MB que permite WhatsApp. Usa uno más corto o de menor resolución.',
          });
        }
      }

      const subida = await subirMedia(buffer, mimetype, cliente.phone_number_id, cliente.access_token);
      if (!subida.ok) {
        const etiqueta = encabezadoTipo === 'video' ? 'el video' : 'la imagen';
        return res.status(502).json({ error: `No se pudo subir ${etiqueta} a WhatsApp: ${subida.error}` });
      }
      imagenMediaId = subida.mediaId;
    }

    const templateNombreLimpio = template_nombre.trim();
    const idiomaLimpio = idioma || 'es';

    // ---- Modo "fecha individual": una campaña por contacto, cada una
    // con SU propio `fecha_recordatorio` (ej: recordatorio de cada
    // paciente el día antes de SU cita particular). ----
    if (esIndividual) {
      const creadas = [];
      const omitidos = sinFechaPropia.map((c) => c.telefono);
      // Solo los que tienen dato en todos los parámetros y fecha propia.
      for (const contacto of contactosAEnviar) {
        const fechaProgramada = fechaGuardadaDeContacto(contacto);
        const futura = esFechaFutura(fechaProgramada);
        const result = db
          .prepare(
            `INSERT INTO campanas (template_nombre, idioma, parametros_json, imagen_media_id, encabezado_tipo, total_contactos, estado, cliente_id, fecha_programada, contacto_ids_json, recurrente_mensual, flow_boton, flow_action_data_json, categoria_plantilla)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            templateNombreLimpio,
            idiomaLimpio,
            JSON.stringify(parametrosDef),
            imagenMediaId,
            encabezadoTipo,
            futura ? 'programada' : 'procesando',
            cliente.id,
            fechaProgramada,
            JSON.stringify([contacto.id]),
            esRecurrenteMensual,
            esFlowBoton,
            flowActionDataJson,
            categoriaPlantilla
          );
        creadas.push(result.lastInsertRowid);
        if (!futura) {
          procesarCampana({
            campanaId: result.lastInsertRowid,
            template_nombre: templateNombreLimpio,
            idioma: idiomaLimpio,
            parametrosDef,
            imagenMediaId,
            encabezadoTipo,
            contactos: [contacto],
            phoneNumberId: cliente.phone_number_id,
            accessToken: cliente.access_token,
            flowBoton: esFlowBoton,
            flowActionData,
            clienteId: cliente.id,
            categoriaPlantilla,
          });
        }
      }
      return res.status(202).json({
        campana_ids: creadas,
        creadas: creadas.length,
        omitidos,
        omitidos_parametros: omitidosPorParametros.map((o) => ({ telefono: o.telefono, faltantes: o.faltantes })),
        total: contactos.length,
      });
    }

    // ---- Modo normal: una sola campaña para todos los contactos
    // seleccionados, inmediata o programada a una fecha común. ----
    const fechaProgramadaComun = normalizarFechaProgramada(fecha_programada);
    const futuraComun = esFechaFutura(fechaProgramadaComun);

    const result = db
      .prepare(
        `INSERT INTO campanas (template_nombre, idioma, parametros_json, imagen_media_id, encabezado_tipo, total_contactos, estado, cliente_id, fecha_programada, contacto_ids_json, recurrente_mensual, flow_boton, flow_action_data_json, categoria_plantilla)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        templateNombreLimpio,
        idiomaLimpio,
        JSON.stringify(parametrosDef),
        imagenMediaId,
        encabezadoTipo,
        contactos.length,
        futuraComun ? 'programada' : 'procesando',
        cliente.id,
        futuraComun ? fechaProgramadaComun : null,
        JSON.stringify(contactos.map((c) => c.id)),
        esRecurrenteMensual,
        esFlowBoton,
        flowActionDataJson,
        categoriaPlantilla
      );

    const campanaId = result.lastInsertRowid;

    if (!futuraComun) {
      // Fire-and-forget: procesa en background, el request ya respondió.
      procesarCampana({
        campanaId,
        template_nombre: templateNombreLimpio,
        idioma: idiomaLimpio,
        parametrosDef,
        imagenMediaId,
        encabezadoTipo,
        contactos,
        phoneNumberId: cliente.phone_number_id,
        accessToken: cliente.access_token,
        flowBoton: esFlowBoton,
        flowActionData,
        clienteId: cliente.id,
        categoriaPlantilla,
      });
    }

    res.status(202).json({ campana_id: campanaId, total: contactos.length, programada: futuraComun });
  });
});

/**
 * Cancela una campaña todavía no disparada. Solo tiene sentido sobre
 * `estado = 'programada'` — una vez en camino o completada no hay nada que
 * cancelar. El scheduler (scheduler.js) solo mira campañas 'programada', así
 * que una 'cancelada' ni se dispara ni, si era mensual, vuelve a clonarse.
 */
app.post('/api/campanas/:id/cancelar', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const campana = db.prepare('SELECT * FROM campanas WHERE id = ? AND cliente_id = ?').get(req.params.id, cliente.id);
  if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });
  if (campana.estado !== 'programada') {
    return res.status(400).json({ error: 'Solo se puede cancelar una campaña que todavía no se disparó' });
  }

  db.prepare(`UPDATE campanas SET estado = 'cancelada' WHERE id = ?`).run(campana.id);
  res.json({ ok: true });
});

// ==================== ENCUESTAS / FORMULARIOS (WhatsApp Flow) ====================
//
// Las respuestas entran por el webhook (ver `guardarRespuestaFlow`) y se
// guardan en `respuestas_flow`. Acá se listan las campañas de tipo
// formulario y se arman las estadísticas agregadas por pregunta.

/**
 * Limpia el nombre técnico de un campo del Flow ("screen_0_Que_tan_
 * satisfecho") para mostrarlo ("Que tan satisfecho").
 */
function etiquetaCampoFlow(clave) {
  return String(clave).replace(/^screen_\d+_/i, '').replace(/_/g, ' ').trim() || String(clave);
}

/**
 * Dada la lista de respuestas (una por contacto, con `datos` = objeto
 * { campo: valor }), arma el resumen por pregunta. Si una pregunta tiene
 * pocas respuestas distintas y cortas, se trata como "opciones" (conteo
 * por valor, para gráfico de barras); si no, como "texto" (lista de
 * respuestas abiertas).
 */
function agregarPreguntasFlow(respuestas) {
  const claves = [];
  const vistas = new Set();
  for (const r of respuestas) {
    for (const k of Object.keys(r.datos || {})) {
      if (!vistas.has(k)) { vistas.add(k); claves.push(k); }
    }
  }

  return claves.map((clave) => {
    const valores = [];
    for (const r of respuestas) {
      const v = r.datos?.[clave];
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) valores.push(...v.map(String));
      else valores.push(String(v));
    }
    const distintos = new Set(valores);
    const etiqueta = etiquetaCampoFlow(clave);
    // "opciones" = pregunta cerrada (radio, dropdown, checkbox): pocas
    // respuestas distintas y cortas. Si con suficientes respuestas casi
    // todas son distintas, es texto libre (un comentario) y se lista
    // en vez de graficarse.
    const proporcionUnica = valores.length ? distintos.size / valores.length : 0;
    const esOpciones =
      distintos.size > 0 &&
      distintos.size <= 15 &&
      [...distintos].every((v) => v.length <= 45) &&
      !(valores.length >= 6 && proporcionUnica > 0.8);

    if (esOpciones) {
      const conteo = {};
      for (const v of valores) conteo[v] = (conteo[v] || 0) + 1;
      const opciones = Object.entries(conteo)
        .map(([valor, n]) => ({ valor, n, pct: valores.length ? n / valores.length : 0 }))
        .sort((a, b) => b.n - a.n);
      return { clave, etiqueta, tipo: 'opciones', total: valores.length, opciones };
    }

    const textos = respuestas
      .filter((r) => r.datos?.[clave] !== undefined && r.datos?.[clave] !== null && r.datos?.[clave] !== '')
      .map((r) => ({ telefono: r.telefono, nombre: r.nombre, valor: String(r.datos[clave]) }));
    return { clave, etiqueta, tipo: 'texto', total: textos.length, textos };
  });
}

/**
 * Junta las respuestas de una campaña de formulario, deduplicadas por
 * teléfono (si alguien mandó el formulario dos veces, vale la última), y
 * con el nombre del contacto resuelto.
 */
function respuestasDeCampana(campanaId, clienteId) {
  const filas = db
    .prepare('SELECT telefono, respuestas_json, recibido_en FROM respuestas_flow WHERE campana_id = ? ORDER BY id ASC')
    .all(campanaId);
  const porTelefono = new Map();
  for (const f of filas) porTelefono.set(f.telefono, f);

  return [...porTelefono.values()].map((f) => {
    let datos = {};
    try {
      datos = JSON.parse(f.respuestas_json || '{}');
    } catch {
      datos = {};
    }
    const nombre = db
      .prepare('SELECT nombre FROM contactos WHERE telefono = ? AND cliente_id = ?')
      .get(f.telefono, clienteId)?.nombre || null;
    return { telefono: f.telefono, nombre, recibido_en: f.recibido_en, datos };
  });
}

/** Lista las campañas de tipo formulario con enviados vs respondidos. */
app.get('/api/flow/campanas', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanas = db
    .prepare(
      `SELECT c.id, c.template_nombre, c.creado_en, c.fecha_programada, c.estado,
              (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'enviado') AS enviados,
              (SELECT COUNT(DISTINCT r.telefono) FROM respuestas_flow r WHERE r.campana_id = c.id) AS respondidos
         FROM campanas c
        WHERE c.cliente_id = ? AND c.flow_boton = 1
        ORDER BY c.id DESC`
    )
    .all(cliente.id);

  res.json({ campanas });
});

/** Estadísticas agregadas (por pregunta) de una campaña de formulario. */
app.get('/api/flow/estadisticas', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanaId = Number(req.query.campana_id);
  if (!campanaId) return res.status(400).json({ error: 'Falta campana_id' });

  const campana = db
    .prepare('SELECT * FROM campanas WHERE id = ? AND cliente_id = ? AND flow_boton = 1')
    .get(campanaId, cliente.id);
  if (!campana) return res.status(404).json({ error: 'No hay una campaña de formulario con ese id' });

  const enviados = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'enviado'`)
    .get(campanaId).n;
  const respuestas = respuestasDeCampana(campanaId, cliente.id);

  res.json({
    campana: { id: campana.id, template_nombre: campana.template_nombre },
    enviados,
    respondidos: respuestas.length,
    tasa: enviados > 0 ? respuestas.length / enviados : 0,
    preguntas: agregarPreguntasFlow(respuestas),
    respuestas,
  });
});

/** Descarga de todas las respuestas de una campaña de formulario en CSV. */
app.get('/api/flow/respuestas.csv', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const campanaId = Number(req.query.campana_id);
  if (!campanaId) return res.status(400).json({ error: 'Falta campana_id' });

  const campana = db
    .prepare('SELECT * FROM campanas WHERE id = ? AND cliente_id = ? AND flow_boton = 1')
    .get(campanaId, cliente.id);
  if (!campana) return res.status(404).json({ error: 'No hay una campaña de formulario con ese id' });

  const respuestas = respuestasDeCampana(campanaId, cliente.id);
  const claves = [];
  const vistas = new Set();
  for (const r of respuestas) {
    for (const k of Object.keys(r.datos || {})) {
      if (!vistas.has(k)) { vistas.add(k); claves.push(k); }
    }
  }

  const escapar = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const encabezados = ['telefono', 'nombre', 'recibido_en', ...claves.map(etiquetaCampoFlow)];
  const lineas = [encabezados.map(escapar).join(',')];
  for (const r of respuestas) {
    const fila = [
      r.telefono,
      r.nombre || '',
      r.recibido_en,
      ...claves.map((k) => {
        const v = r.datos?.[k];
        return Array.isArray(v) ? v.join(' | ') : v ?? '';
      }),
    ];
    lineas.push(fila.map(escapar).join(','));
  }

  const nombreArchivo = `respuestas-${(campana.template_nombre || 'formulario').replace(/[^a-z0-9_-]+/gi, '_')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  res.send('﻿' + lineas.join('\r\n'));
});

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
  if (!propio.es_admin) return { error: 'No tienes permiso para ver los datos de otro cliente', status: 403 };

  const objetivo = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!objetivo) return { error: 'Cliente no encontrado', status: 404 };
  return { cliente: objetivo, propio };
}

// ==================== ADMIN: GESTIÓN DE EMPRESAS ====================
//
// Una "empresa" (ej: una odontología) es un espacio organizativo dentro del
// panel del ÚNICO usuario real del aplicativo (el admin) — no tiene login
// propio ni conecta su propio WhatsApp. El admin sube sus contactos, elige
// con cuál de SUS números ya conectados (pestaña Webhook) manda, y arma sus
// campañas, todo desde adentro de la empresa (ver resolverClienteObjetivo,
// ya extendido a contactos/campañas para aceptar `cliente_id` de una
// empresa en vez de la cuenta logueada).

function serializarEmpresa(cliente) {
  return {
    id: cliente.id,
    nombre_negocio: cliente.nombre_negocio,
    estado: cliente.estado,
    whatsapp_conectado: Boolean(cliente.phone_number_id && cliente.access_token),
    phone_number_id: cliente.phone_number_id,
  };
}

app.get('/api/admin/empresas', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para ver esta lista' });
  }
  const empresas = db
    .prepare('SELECT * FROM clientes WHERE es_empresa_gestionada = 1 ORDER BY nombre_negocio COLLATE NOCASE ASC')
    .all();
  res.json({ empresas: empresas.map(serializarEmpresa) });
});

/**
 * Crea una empresa nueva. Solo pide el nombre del negocio — no tiene login
 * propio, así que se le genera un email placeholder único y una contraseña
 * al azar que nunca se devuelven ni se muestran (existen solo porque
 * `clientes.email`/`password_hash` son NOT NULL, no para que nadie inicie
 * sesión con ellas).
 */
app.post('/api/admin/empresas', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para crear empresas' });
  }

  const { nombre_negocio } = req.body || {};
  if (!nombre_negocio || !String(nombre_negocio).trim()) {
    return res.status(400).json({ error: 'Falta el nombre de la empresa' });
  }

  const emailPlaceholder = `empresa-${crypto.randomBytes(8).toString('hex')}@gestionada.local`;
  const { hash, salt } = hashPassword(crypto.randomBytes(24).toString('base64url'));

  const result = db
    .prepare(
      `INSERT INTO clientes (email, password_hash, password_salt, nombre_negocio, estado, es_empresa_gestionada)
       VALUES (?, ?, ?, ?, 'pendiente_whatsapp', 1)`
    )
    .run(emailPlaceholder, hash, salt, String(nombre_negocio).trim());

  const creado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ empresa: serializarEmpresa(creado) });
});

/**
 * Asigna a una empresa uno de los números que el ADMIN ya conectó (los que
 * aparecen en la pestaña Webhook, tabla `whatsapp_numeros`). Copia
 * waba_id/phone_number_id/access_token a la fila de la empresa — desde ahí
 * `isWhatsAppConfigured`/`sendTemplate` funcionan igual que si la empresa
 * hubiera conectado su propio WhatsApp.
 */
/**
 * Un número de WhatsApp solo puede ser de UNA empresa (gestionada o
 * independiente): las respuestas que llegan al webhook se atribuyen por
 * `phone_number_id`, y si dos empresas comparten número no hay forma de
 * saber de cuál es la respuesta (ver `clientePorPhoneNumberId`). El admin
 * no cuenta — es el dueño del pool, no "usa" el número una vez asignado.
 */
function empresaQueYaTieneNumero(phoneNumberId, exceptoClienteId) {
  return db
    .prepare('SELECT id, nombre_negocio, email FROM clientes WHERE phone_number_id = ? AND es_admin = 0 AND id != ? LIMIT 1')
    .get(phoneNumberId, exceptoClienteId);
}

function errorNumeroOcupado(otra) {
  return `Ese número ya está asignado a "${otra.nombre_negocio || otra.email}". Un número solo puede ser de una empresa — quítaselo primero.`;
}

app.patch('/api/admin/empresas/:id/numero', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para asignar números' });
  }

  const empresa = db
    .prepare('SELECT * FROM clientes WHERE id = ? AND es_empresa_gestionada = 1')
    .get(req.params.id);
  if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { whatsapp_numero_id } = req.body || {};
  const numero = db
    .prepare('SELECT * FROM whatsapp_numeros WHERE id = ? AND cliente_id = ?')
    .get(whatsapp_numero_id, propio.id);
  if (!numero) return res.status(404).json({ error: 'Ese número no está entre los tuyos conectados' });

  const otra = empresaQueYaTieneNumero(numero.phone_number_id, empresa.id);
  if (otra) return res.status(409).json({ error: errorNumeroOcupado(otra) });

  db.prepare(
    `UPDATE clientes SET waba_id = ?, phone_number_id = ?, access_token = ?, estado = 'conectado' WHERE id = ?`
  ).run(numero.waba_id, numero.phone_number_id, numero.access_token, empresa.id);

  const actualizada = db.prepare('SELECT * FROM clientes WHERE id = ?').get(empresa.id);
  res.json({ empresa: serializarEmpresa(actualizada) });
});

// ==================== ADMIN: EMPRESAS INDEPENDIENTES ====================
//
// A diferencia de una "empresa gestionada" (arriba), una empresa
// independiente es una cuenta que se registró SOLA desde registro.html —
// tiene su propio login y arma sus contactos/campañas/plantillas desde su
// propio panel. Lo único que el admin hace acá es asignarle uno de SUS
// números conectados (mismo mecanismo que arriba) para que deje de estar
// `pendiente_whatsapp` y pueda mandar campañas con las plantillas que ya
// tenga aprobadas — sin esto, aunque tenga una plantilla en estado "lista
// para enviar", no tiene con qué número mandarla.

function serializarClienteIndependiente(cliente) {
  const plan = cliente.plan_id ? db.prepare('SELECT id, nombre, mensajes_mes FROM planes_mensuales WHERE id = ?').get(cliente.plan_id) : null;
  const cuota = plan ? cuotaRestante(cliente.id) : null;
  return {
    id: cliente.id,
    email: cliente.email,
    nombre_negocio: cliente.nombre_negocio,
    estado: cliente.estado,
    whatsapp_conectado: Boolean(cliente.phone_number_id && cliente.access_token),
    phone_number_id: cliente.phone_number_id,
    creditos: cliente.creditos,
    plan_id: cliente.plan_id || null,
    plan_nombre: plan?.nombre || null,
    plan_mensajes_mes: plan?.mensajes_mes || null,
    plan_contactos_disponibles: cuota
      ? { MARKETING: contactosQueEntran(cliente.id, 'MARKETING'), UTILITY: contactosQueEntran(cliente.id, 'UTILITY') }
      : null,
  };
}

app.get('/api/admin/clientes-independientes', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para ver esta lista' });
  }
  const clientes = db
    .prepare(`SELECT * FROM clientes ORDER BY nombre_negocio COLLATE NOCASE ASC, email COLLATE NOCASE ASC`)
    .all()
    .filter(esClienteIndependiente);
  res.json({ clientes: clientes.map(serializarClienteIndependiente) });
});

app.patch('/api/admin/clientes-independientes/:id/numero', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para asignar números' });
  }

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente || !esClienteIndependiente(cliente)) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { whatsapp_numero_id } = req.body || {};
  if (!whatsapp_numero_id) {
    // Desasignar: vuelve a "pendiente_whatsapp" (ej: si el admin se equivocó de número).
    db.prepare(`UPDATE clientes SET waba_id = NULL, phone_number_id = NULL, access_token = NULL, estado = 'pendiente_whatsapp' WHERE id = ?`).run(cliente.id);
  } else {
    const numero = db
      .prepare('SELECT * FROM whatsapp_numeros WHERE id = ? AND cliente_id = ?')
      .get(whatsapp_numero_id, propio.id);
    if (!numero) return res.status(404).json({ error: 'Ese número no está entre los tuyos conectados' });

    const otra = empresaQueYaTieneNumero(numero.phone_number_id, cliente.id);
    if (otra) return res.status(409).json({ error: errorNumeroOcupado(otra) });

    db.prepare(
      `UPDATE clientes SET waba_id = ?, phone_number_id = ?, access_token = ?, estado = 'conectado' WHERE id = ?`
    ).run(numero.waba_id, numero.phone_number_id, numero.access_token, cliente.id);
  }

  const actualizado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente.id);
  res.json({ cliente: serializarClienteIndependiente(actualizado) });
});

/**
 * Asigna (o quita, con `plan_id` null) un plan mensual a un cliente
 * independiente. Asignar SIEMPRE resetea `plan_activado_en` a "ahora" — es
 * también el mecanismo manual de "recarga" cuando el admin le da más cupo a
 * alguien que pidió ampliar (reasignarle el mismo plan u otro más grande
 * arranca un ciclo nuevo desde ese momento). Quitar el plan hace que el
 * cliente vuelva al camino de créditos sueltos.
 */
app.patch('/api/admin/clientes-independientes/:id/plan', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para asignar planes' });
  }

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente || !esClienteIndependiente(cliente)) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { plan_id } = req.body || {};
  if (!plan_id) {
    db.prepare('UPDATE clientes SET plan_id = NULL, plan_activado_en = NULL WHERE id = ?').run(cliente.id);
  } else {
    const plan = db.prepare('SELECT id FROM planes_mensuales WHERE id = ?').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'Ese plan no existe' });
    db.prepare(`UPDATE clientes SET plan_id = ?, plan_activado_en = datetime('now') WHERE id = ?`).run(plan.id, cliente.id);
  }

  const actualizado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente.id);
  res.json({ cliente: serializarClienteIndependiente(actualizado) });
});

/**
 * Carga (o corrige, con `cantidad` negativa) el saldo de créditos de un
 * cliente independiente. Manual porque todavía no hay pasarela de pagos
 * conectada — cuando se conecte, su webhook va a llamar
 * `registrarMovimientoCreditos` igual que esto, sin tener que tocar nada más.
 */
app.post('/api/admin/clientes-independientes/:id/creditos', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para cargar créditos' });
  }

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente || !esClienteIndependiente(cliente)) return res.status(404).json({ error: 'Cliente no encontrado' });

  const cantidad = Math.trunc(Number(req.body?.cantidad));
  const motivo = req.body?.motivo ? String(req.body.motivo).trim() : '';
  if (!Number.isInteger(cantidad) || cantidad === 0) {
    return res.status(400).json({ error: 'La cantidad tiene que ser un número entero distinto de 0' });
  }
  if (!motivo) {
    return res.status(400).json({ error: 'Falta el motivo de la carga' });
  }

  registrarMovimientoCreditos({ clienteId: cliente.id, cantidad, motivo });

  const actualizado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente.id);
  res.json({ cliente: serializarClienteIndependiente(actualizado) });
});

app.get('/api/admin/configuracion-creditos', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para ver esta configuración' });
  }
  res.json({ costos: obtenerConfigCreditos(), ivaPorcentaje: IVA_PORCENTAJE });
});

app.put('/api/admin/configuracion-creditos', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para cambiar esta configuración' });
  }
  try {
    const costos = guardarConfigCreditos(req.body || {});
    res.json({ costos });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Catálogo de planes sin sesión — lo consume la página pública /planes.html
 * (landing de precios, ve gente que todavía no se registró). Sin datos
 * sensibles: mismo nombre/mensajes/precio que ya se ven en el panel, más el
 * teléfono de contacto público (mismo que expone /api/config).
 */
app.get('/api/planes-publico', (req, res) => {
  const admin = db.prepare('SELECT telefono_contacto FROM clientes WHERE es_admin = 1 LIMIT 1').get();
  const contactoWhatsapp = admin?.telefono_contacto ? normalizePhone(admin.telefono_contacto) : null;
  res.json({ planes: obtenerPlanesCatalogo(), ivaPorcentaje: IVA_PORCENTAJE, contactoWhatsapp });
});

app.get('/api/admin/planes', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para ver esta configuración' });
  }
  res.json({ planes: obtenerPlanesCatalogo(), ivaPorcentaje: IVA_PORCENTAJE });
});

app.put('/api/admin/planes', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para cambiar esta configuración' });
  }
  try {
    const planes = guardarPlanesCatalogo(req.body?.planes || []);
    res.json({ planes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Saldo y movimientos del cliente logueado — solo tiene sentido para un
 * independiente (admin/gestionadas no manejan créditos). `aplica: false` le
 * dice al frontend que no muestre nada de esto en "Nueva campaña".
 */
app.get('/api/creditos', (req, res) => {
  const cliente = clienteActual(req);
  if (!esClienteIndependiente(cliente)) {
    return res.json({ aplica: false });
  }
  const movimientos = db
    .prepare('SELECT cantidad, motivo, creado_en FROM creditos_movimientos WHERE cliente_id = ? ORDER BY creado_en DESC, id DESC LIMIT 20')
    .all(cliente.id);
  res.json({ aplica: true, creditos: cliente.creditos, costos: obtenerConfigCreditos(), ivaPorcentaje: IVA_PORCENTAJE, movimientos });
});

/**
 * Cuota del plan mensual del cliente logueado — solo tiene sentido para un
 * independiente CON plan asignado (sin plan, usa /api/creditos en su
 * lugar). `aplica: false` le dice al frontend que no muestre nada de esto.
 */
app.get('/api/plan', (req, res) => {
  const cliente = clienteActual(req);
  if (!esClienteIndependiente(cliente) || !clienteTienePlanActivo(cliente)) {
    return res.json({ aplica: false });
  }
  const cuota = cuotaRestante(cliente.id);
  if (!cuota) return res.json({ aplica: false });

  res.json({
    aplica: true,
    plan: cuota.plan,
    mediosDisponibles: cuota.mediosDisponibles,
    mediosLibres: cuota.mediosLibres,
    contactosQueEntran: {
      MARKETING: contactosQueEntran(cliente.id, 'MARKETING'),
      UTILITY: contactosQueEntran(cliente.id, 'UTILITY'),
      AUTHENTICATION: contactosQueEntran(cliente.id, 'AUTHENTICATION'),
    },
  });
});

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
    return res.status(400).json({ error: 'Elige al menos una campaña de este cliente' });
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
    return res.status(400).json({ error: 'Elige al menos una campaña de este cliente' });
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
 * Historial detallado en PDF: cada envío (no cada campaña) de las
 * campañas seleccionadas, con la plantilla, el contacto y el detalle
 * técnico del envío — complementa a `reporte.pdf`, que solo agrega
 * totales por campaña.
 */
app.get('/api/facturacion/historial.pdf', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.query.cliente_id);
  if (error) return res.status(status).json({ error });

  const ids = idsDesdeQuery(req.query.ids);
  const campanas = campanasParaFacturar(cliente.id, ids);
  if (campanas.length === 0) {
    return res.status(400).json({ error: 'Elige al menos una campaña de este cliente' });
  }

  const marcadores = campanas.map(() => '?').join(',');
  const envios = db
    .prepare(
      `SELECT e.telefono, e.nombre, e.estado, e.error, e.wa_message_id, c.template_nombre
       FROM envios e
       JOIN campanas c ON c.id = e.campana_id
       WHERE e.campana_id IN (${marcadores})
       ORDER BY c.id ASC, e.id ASC`
    )
    .all(...campanas.map((c) => c.id));

  try {
    const pdf = generarHistorialDetalladoPdf({ campanas, envios, cliente });
    const nombre = nombreArchivo(`historial-${cliente.nombre_negocio || cliente.email}-${new Date().toISOString().slice(0, 10)}`);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${nombre}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Error generando el historial detallado PDF:', err);
    res.status(500).json({ error: 'No se pudo generar el historial detallado PDF' });
  }
});

/**
 * Cotización: estimación de lo que costaría mandarle una campaña a un
 * grupo de contactos, ANTES de mandarla — usa la misma tarifa/IVA que ya
 * se configura en Historial → Tarifa, pero no toca `campanas`/`envios`
 * (no hay nada enviado todavía). Complementa a `reporte.pdf`, que es el
 * mismo cálculo pero sobre mensajes ya mandados.
 *
 * Es POST (no GET con query string) porque una empresa puede tener miles
 * de contactos seleccionados — pasar esos ids en la URL se pasa del
 * límite de largo de request que aceptan los navegadores/proxies (414
 * Request-URI Too Large visto en producción con ~250 contactos).
 */
app.post('/api/facturacion/cotizacion.pdf', (req, res) => {
  const { cliente, error, status } = resolverClienteObjetivo(req, req.body?.cliente_id);
  if (error) return res.status(status).json({ error });

  const ids = idsDesdeQuery(req.body?.contacto_ids);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'Elige al menos un contacto' });
  }

  const marcadores = ids.map(() => '?').join(',');
  const contactos = db
    .prepare(`SELECT id, telefono, nombre FROM contactos WHERE id IN (${marcadores}) AND cliente_id = ?`)
    .all(...ids, cliente.id);
  if (contactos.length === 0) {
    return res.status(400).json({ error: 'No se encontraron los contactos seleccionados' });
  }

  const cotizacion = calcularCotizacion({
    totalContactos: contactos.length,
    tarifa: Number(cliente.tarifa_por_mensaje) || 0,
    ivaPorcentaje: Number(cliente.iva_porcentaje) || 0,
    moneda: cliente.moneda || 'COP',
  });

  try {
    const pdf = generarCotizacionPdf({ contactos, cotizacion, cliente });
    const nombre = nombreArchivo(`cotizacion-${cliente.nombre_negocio || cliente.email}-${new Date().toISOString().slice(0, 10)}`);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${nombre}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Error generando la cotización PDF:', err);
    res.status(500).json({ error: 'No se pudo generar la cotización PDF' });
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
    return res.status(400).json({ error: 'Elige al menos una campaña de este cliente' });
  }

  const tarifa = Number(cliente.tarifa_por_mensaje) || 0;
  if (tarifa <= 0) {
    return res.status(400).json({ error: 'Configura primero la tarifa por mensaje de este cliente' });
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
  INSERT INTO mensajes (telefono, direccion, tipo, texto, media_id, media_mime_type, wa_message_id, estado, nombre_perfil, leido_por_agente, cliente_id, phone_number_id)
  VALUES (?, 'entrante', ?, ?, ?, ?, ?, 'recibido', ?, 0, ?, ?)
`);

// El admin dueño del número en su pool — recibe una copia de todo lo que
// entra por sus números aunque el número esté asignado a una empresa.
const adminDuenoDelNumero = db.prepare(`
  SELECT c.id
  FROM whatsapp_numeros n JOIN clientes c ON c.id = n.cliente_id
  WHERE n.phone_number_id = ? AND c.es_admin = 1
  LIMIT 1
`);

/**
 * BUG real (2026-09-23): cuando el admin conecta su primer número, éste
 * queda guardado tanto en su pool (`whatsapp_numeros`) COMO en su propia
 * fila de `clientes` (es "su número activo" — ver POST /api/whatsapp/oauth
 * más arriba, "el primer número que conecta una cuenta queda activo
 * automáticamente"). Si después el admin le asigna ESE MISMO número a una
 * empresa independiente o gestionada, esa empresa también termina con ese
 * `phone_number_id` en su propia fila — dos clientes con el mismo número,
 * ambos con prioridad 0 en el ORDER BY de abajo. Como el admin casi
 * siempre tiene el `id` más chico (primer cliente sembrado), el desempate
 * `c.id` lo hacía ganar siempre, y todo mensaje entrante de ese número le
 * llegaba a él en vez de a la empresa dueña real del número.
 *
 * Fix: un cliente NO admin con el número como propio (`c.phone_number_id`)
 * tiene prioridad absoluta (0). El admin solo es el destino de fallback
 * (prioridad 1) — para números que todavía nadie tiene asignado, o para
 * cuando el admin manda mensajes de prueba con un número que no le dio a
 * nadie todavía.
 */
const clientePorPhoneNumberId = db.prepare(`
  SELECT c.id
  FROM clientes c
  LEFT JOIN whatsapp_numeros n ON n.cliente_id = c.id
  WHERE c.phone_number_id = ? OR n.phone_number_id = ?
  GROUP BY c.id
  ORDER BY CASE WHEN c.phone_number_id = ? AND c.es_admin = 0 THEN 0 ELSE 1 END, c.id
  LIMIT 1
`);

// Tipos de mensaje que traen un archivo descargable de Meta (`msg.<tipo>.id`
// + `.mime_type`) — se guardan para poder mostrarlos después vía
// GET /api/mensajes/:id/media (ver más abajo).
const TIPOS_CON_MEDIA = new Set(['image', 'sticker', 'video', 'audio', 'document']);

/**
 * Convierte el `nfm_reply` de un WhatsApp Flow completado en texto
 * legible. `response_json` es un string JSON tipo
 * { "screen_0_Como_calificas": "5", "flow_token": "573001112233" }.
 * Se ignoran las claves internas (`flow_token`) y se limpian los
 * prefijos que Meta agrega al nombre del campo.
 */
function formatearRespuestaFlow(nfmReply) {
  if (!nfmReply) return '[Formulario]';
  let datos;
  try {
    datos = JSON.parse(nfmReply.response_json || '{}');
  } catch {
    return '[Formulario recibido]';
  }
  const lineas = Object.entries(datos)
    .filter(([clave]) => clave !== 'flow_token')
    .map(([clave, valor]) => {
      const etiqueta = clave.replace(/^screen_\d+_/i, '').replace(/_/g, ' ').trim();
      const texto = Array.isArray(valor) ? valor.join(', ') : String(valor);
      return `• ${etiqueta}: ${texto}`;
    });
  return lineas.length ? `Formulario:\n${lineas.join('\n')}` : '[Formulario recibido]';
}

function extraerTextoMensaje(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body || '';
    case 'button':
      return msg.button?.text || '';
    case 'interactive':
      // `nfm_reply` = respuesta de un formulario nativo (WhatsApp Flow):
      // las respuestas vienen en `response_json` (string JSON). Lo
      // desplegamos como "campo: valor" para que se lean en el chat.
      if (msg.interactive?.type === 'nfm_reply') {
        return formatearRespuestaFlow(msg.interactive.nfm_reply);
      }
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

const insertRespuestaFlow = db.prepare(`
  INSERT OR IGNORE INTO respuestas_flow (cliente_id, telefono, campana_id, template_nombre, respuestas_json, wa_message_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/**
 * Guarda la respuesta de un formulario nativo (WhatsApp Flow) para la
 * pestaña "Encuestas". La campaña se resuelve por teléfono: la última
 * campaña con `flow_boton = 1` de este cliente que se le envió a ese
 * número (el `flow_token` que mandamos es justamente el teléfono, así
 * que coincide con `msg.from`). Si no hay match, se guarda igual con
 * `campana_id` nulo.
 */
function guardarRespuestaFlow(clienteId, telefono, msg) {
  const nfm = msg.interactive?.nfm_reply;
  if (!nfm) return;
  let respuestas;
  try {
    respuestas = JSON.parse(nfm.response_json || '{}');
  } catch {
    return;
  }
  if (!respuestas || typeof respuestas !== 'object') return;
  delete respuestas.flow_token;

  const campana = db
    .prepare(
      `SELECT c.id, c.template_nombre
         FROM envios e JOIN campanas c ON c.id = e.campana_id
        WHERE e.telefono = ? AND c.cliente_id = ? AND c.flow_boton = 1
        ORDER BY e.id DESC LIMIT 1`
    )
    .get(telefono, clienteId);

  insertRespuestaFlow.run(
    clienteId,
    telefono,
    campana?.id || null,
    campana?.template_nombre || null,
    JSON.stringify(respuestas),
    msg.id || null
  );
}

function aplicarEstadoSiCorresponde(tabla, waMessageId, nuevoEstado, error) {
  const fila = db.prepare(`SELECT id, estado FROM ${tabla} WHERE wa_message_id = ?`).get(waMessageId);
  if (!fila) return;
  const rankActual = ESTADO_RANK[fila.estado] || 0;
  const rankNuevo = ESTADO_RANK[nuevoEstado] || 0;
  if (nuevoEstado === 'fallido' || rankNuevo > rankActual) {
    db.prepare(`UPDATE ${tabla} SET estado = ?, error = ? WHERE wa_message_id = ?`).run(nuevoEstado, error, waMessageId);
  }
  // Meta aceptó el mensaje (y se cobró) pero después falló: se devuelve el cobro.
  if (tabla === 'envios' && nuevoEstado === 'fallido') {
    try {
      reembolsarEnvio(fila.id);
    } catch (err) {
      console.error(`[webhook] no se pudo reembolsar el envío ${fila.id}:`, err);
    }
  }
}

function procesarWebhookWhatsApp(body) {
  for (const entrada of body.entry || []) {
    for (const cambio of entrada.changes || []) {
      const valor = cambio.value || {};

      // Un solo webhook de Meta recibe eventos de TODAS las WABAs
      // suscriptas a la app — hay que resolver a qué cliente pertenece
      // este evento por el phone_number_id que manda Meta en el payload.
      // Primero intenta contra el número activo del cliente y después
      // contra cualquier número guardado en `whatsapp_numeros`.
      const phoneNumberId = valor.metadata?.phone_number_id;
      const cliente = phoneNumberId ? clientePorPhoneNumberId.get(phoneNumberId, phoneNumberId, phoneNumberId) : null;
      if (!cliente) {
        console.warn('Webhook de WhatsApp ignorado: phone_number_id no reconocido', phoneNumberId);
        continue;
      }

      const nombresPerfil = {};
      for (const c of valor.contacts || []) {
        if (c.wa_id && c.profile?.name) nombresPerfil[c.wa_id] = c.profile.name;
      }

      // Si el número es de una empresa, el admin dueño del pool también ve
      // la conversación (copia aparte, con su propio "leído").
      const admin = adminDuenoDelNumero.get(phoneNumberId);
      const destinatarios = admin && admin.id !== cliente.id ? [cliente.id, admin.id] : [cliente.id];

      for (const msg of valor.messages || []) {
        const telefono = msg.from;
        if (!telefono) continue;
        const { mediaId, mimeType } = extraerMedia(msg);
        for (const clienteId of destinatarios) {
          insertMensajeEntrante.run(
            telefono,
            msg.type || 'texto',
            extraerTextoMensaje(msg),
            mediaId,
            mimeType,
            msg.id || null,
            nombresPerfil[telefono] || null,
            clienteId,
            phoneNumberId
          );
        }

        if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
          guardarRespuestaFlow(cliente.id, telefono, msg);
        }
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
      .prepare(`SELECT texto, direccion, estado, creado_en, phone_number_id FROM mensajes WHERE telefono = ? AND cliente_id = ? ORDER BY creado_en DESC, id DESC LIMIT 1`)
      .get(telefono, clienteId);
    // Etiqueta del número por el que entró — el admin ve conversaciones de
    // todos sus números mezcladas, así sabe de qué empresa/línea es cada una.
    const via = ultimo?.phone_number_id
      ? db.prepare('SELECT etiqueta FROM whatsapp_numeros WHERE phone_number_id = ? AND etiqueta IS NOT NULL LIMIT 1').get(ultimo.phone_number_id)?.etiqueta || ultimo.phone_number_id
      : null;
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
      via,
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
  // Token del número por el que entró el mensaje (puede no ser el activo
  // del cliente — ej. la copia del admin de un número asignado a una
  // empresa); si no se sabe el número (mensajes viejos), el del cliente.
  const mensaje = db
    .prepare(
      `SELECT m.media_id, m.media_mime_type,
              COALESCE(
                (SELECT n.access_token FROM whatsapp_numeros n WHERE n.phone_number_id = m.phone_number_id AND n.cliente_id = m.cliente_id),
                c.access_token
              ) AS access_token
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

  // Se responde por el mismo número por el que entró la conversación. Para
  // una empresa es siempre su único número; para el admin puede ser
  // cualquiera de su pool (incluidos los asignados a empresas), así que se
  // busca el token de ese número en `whatsapp_numeros`.
  let phoneNumberId = cliente.phone_number_id;
  let accessToken = cliente.access_token;
  const ultimo = db
    .prepare(`SELECT phone_number_id FROM mensajes WHERE telefono = ? AND cliente_id = ? AND phone_number_id IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(telefono, cliente.id);
  if (ultimo && ultimo.phone_number_id !== phoneNumberId) {
    const delPool = db
      .prepare('SELECT access_token FROM whatsapp_numeros WHERE cliente_id = ? AND phone_number_id = ?')
      .get(cliente.id, ultimo.phone_number_id);
    if (delPool?.access_token) {
      phoneNumberId = ultimo.phone_number_id;
      accessToken = delPool.access_token;
    }
  }

  const textoLimpio = texto.trim();
  const resultado = await sendTextMessage({ to: telefono, body: textoLimpio, phoneNumberId, accessToken });

  const insertado = db
    .prepare(`
      INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, error, leido_por_agente, cliente_id, phone_number_id)
      VALUES (?, 'saliente', 'texto', ?, ?, ?, ?, 1, ?, ?)
    `)
    .run(telefono, textoLimpio, resultado.messageId || null, resultado.ok ? 'enviado' : 'fallido', resultado.ok ? null : resultado.error, cliente.id, phoneNumberId);

  // La otra cuenta que ve esta conversación (la empresa dueña del número, o
  // el admin dueño del pool) también tiene que ver lo que se respondió.
  if (resultado.ok) {
    const otros = db
      .prepare(`
        SELECT id FROM clientes WHERE phone_number_id = ? AND es_admin = 0 AND id != ?
        UNION
        SELECT c.id FROM whatsapp_numeros n JOIN clientes c ON c.id = n.cliente_id
        WHERE n.phone_number_id = ? AND c.es_admin = 1 AND c.id != ?
      `)
      .all(phoneNumberId, cliente.id, phoneNumberId, cliente.id);
    const copia = db.prepare(`
      INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, leido_por_agente, cliente_id, phone_number_id)
      VALUES (?, 'saliente', 'texto', ?, ?, 'enviado', 1, ?, ?)
    `);
    for (const otro of otros) copia.run(telefono, textoLimpio, resultado.messageId, otro.id, phoneNumberId);
  }

  if (!resultado.ok) {
    return res.status(502).json({ error: resultado.error, id: insertado.lastInsertRowid });
  }
  res.status(201).json({ id: insertado.lastInsertRowid, wa_message_id: resultado.messageId });
});

// ==================== PLANTILLAS (solicitudes) ====================
//
// Cualquier cliente arma acá una plantilla con el mismo formato que pide el
// creador de plantillas de Meta (categoría, encabezado, cuerpo, pie, botones)
// y la manda como "solicitud". El admin las ve todas juntas (GET
// /api/admin/plantillas), la crea A MANO en el Administrador de Meta — no hay
// ninguna llamada a la Graph API de creación de plantillas acá, es decisión
// explícita — y va actualizando su estado y el número que le asigna (PATCH
// /api/admin/plantillas/:id, siempre de entre SUS propios `whatsapp_numeros`).

const CATEGORIAS_PLANTILLA = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
const HEADER_TIPOS_PLANTILLA = ['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];
const ESTADOS_PLANTILLA = ['pendiente', 'esperando_confirmacion', 'lista_para_enviar', 'rechazada', 'cancelada'];

/**
 * Arma el bloque `components` con la forma exacta que espera la Graph API de
 * Meta para crear una plantilla. No se manda a ningún lado — es solo para que
 * el admin lo use de referencia (o lo copie) al recrearla a mano en el
 * Administrador de Meta.
 */
function construirComponentesMeta(fila) {
  const componentes = [];

  if (fila.header_tipo === 'TEXT' && fila.header_texto) {
    componentes.push({ type: 'HEADER', format: 'TEXT', text: fila.header_texto });
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fila.header_tipo)) {
    componentes.push({
      type: 'HEADER',
      format: fila.header_tipo,
      example: { header_handle: ['<subir la muestra adjunta a Meta y pegar aquí el handle que devuelve>'] },
    });
  }

  const ejemplos = JSON.parse(fila.ejemplos_json || '[]');
  componentes.push(
    ejemplos.length > 0
      ? { type: 'BODY', text: fila.body_texto, example: { body_text: [ejemplos] } }
      : { type: 'BODY', text: fila.body_texto }
  );

  if (fila.footer_texto) {
    componentes.push({ type: 'FOOTER', text: fila.footer_texto });
  }

  const botones = JSON.parse(fila.botones_json || '[]');
  if (botones.length > 0) {
    componentes.push({
      type: 'BUTTONS',
      buttons: botones.map((b) => {
        if (b.tipo === 'URL') return { type: 'URL', text: b.texto, url: b.url };
        if (b.tipo === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.texto, phone_number: b.telefono };
        return { type: 'QUICK_REPLY', text: b.texto };
      }),
    });
  }

  return { name: fila.nombre, language: fila.idioma, category: fila.categoria, components: componentes };
}

function serializarSolicitudPlantilla(fila) {
  return {
    id: fila.id,
    nombre: fila.nombre,
    categoria: fila.categoria,
    idioma: fila.idioma,
    header_tipo: fila.header_tipo,
    header_texto: fila.header_texto,
    header_media_url: fila.header_media_path ? `/uploads/plantillas/${fila.header_media_path}` : null,
    body_texto: fila.body_texto,
    footer_texto: fila.footer_texto,
    botones: JSON.parse(fila.botones_json || '[]'),
    ejemplos: JSON.parse(fila.ejemplos_json || '[]'),
    numero_personalizado: Boolean(fila.numero_personalizado),
    nota_cliente: fila.nota_cliente,
    numero_asignado: fila.numero_etiqueta || fila.numero_phone_id || null,
    estado: fila.estado,
    nota_admin: fila.nota_admin,
    creado_en: fila.creado_en,
    actualizado_en: fila.actualizado_en,
  };
}

const SELECT_PLANTILLA_BASE = `
  SELECT s.*, c.nombre_negocio AS cliente_nombre, c.email AS cliente_email,
         n.etiqueta AS numero_etiqueta, n.phone_number_id AS numero_phone_id
  FROM plantillas_solicitudes s
  JOIN clientes c ON c.id = s.cliente_id
  LEFT JOIN whatsapp_numeros n ON n.id = s.whatsapp_numero_id
`;

/** Serialización para el panel admin: agrega datos del cliente y el JSON estilo Meta. */
function serializarSolicitudAdmin(fila) {
  return {
    ...serializarSolicitudPlantilla(fila),
    cliente_id: fila.cliente_id,
    cliente_nombre: fila.cliente_nombre || fila.cliente_email,
    cliente_email: fila.cliente_email,
    whatsapp_numero_id: fila.whatsapp_numero_id,
    componentes_meta: construirComponentesMeta(fila),
  };
}

app.post('/api/plantillas', uploadMuestraPlantilla.single('muestra_encabezado'), (req, res) => {
  const body = req.body || {};
  const nombre = String(body.nombre || '').trim().toLowerCase();
  const categoria = String(body.categoria || '').toUpperCase();
  const idioma = String(body.idioma || 'es').trim() || 'es';
  const headerTipo = String(body.header_tipo || 'NONE').toUpperCase();
  const headerTexto = body.header_texto ? String(body.header_texto).trim() : null;
  const bodyTexto = String(body.body_texto || '').trim();
  const footerTexto = body.footer_texto ? String(body.footer_texto).trim() : null;
  const numeroPersonalizado = ['true', '1', true].includes(body.numero_personalizado);
  const notaCliente = body.nota_cliente ? String(body.nota_cliente).trim() : null;

  let ejemplos = [];
  try {
    ejemplos = body.ejemplos_json ? JSON.parse(body.ejemplos_json) : [];
  } catch {
    return res.status(400).json({ error: 'Los ejemplos de las variables tienen un formato inválido' });
  }
  if (!Array.isArray(ejemplos)) return res.status(400).json({ error: 'Los ejemplos de las variables tienen un formato inválido' });
  ejemplos = ejemplos.map((e) => String(e ?? '').trim());

  if (!CATEGORIAS_PLANTILLA.includes(categoria)) {
    return res.status(400).json({ error: 'Elige la categoría de la plantilla (Marketing, Utilidad o Autenticación)' });
  }
  if (!HEADER_TIPOS_PLANTILLA.includes(headerTipo)) {
    return res.status(400).json({ error: 'Tipo de encabezado inválido' });
  }
  const errorContenido = validarContenidoPlantilla({ nombre, idioma, headerTipo, headerTexto, bodyTexto, footerTexto, ejemplos });
  if (errorContenido) return res.status(400).json({ error: errorContenido });
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerTipo) && !req.file) {
    return res.status(400).json({ error: 'Sube un archivo de muestra para ese tipo de encabezado' });
  }

  let botonesLimpios;
  try {
    botonesLimpios = validarBotones(body.botones_json);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Mismo nombre e idioma ya pedido y todavía vigente: Meta no permite dos plantillas con el mismo nombre.
  const repetida = db
    .prepare(`SELECT id, estado FROM plantillas_solicitudes WHERE cliente_id = ? AND nombre = ? AND idioma = ? AND estado NOT IN ('cancelada', 'rechazada') LIMIT 1`)
    .get(req.session.clienteId, nombre, idioma);
  if (repetida) {
    return res.status(409).json({ error: `Ya tienes una solicitud con el nombre «${nombre}» (${idioma}) en curso. Cámbiale el nombre (ej: ${nombre}_v2) o cancela la anterior.` });
  }

  const result = db
    .prepare(
      `INSERT INTO plantillas_solicitudes
        (cliente_id, nombre, categoria, idioma, header_tipo, header_texto, header_media_path, body_texto, footer_texto, botones_json, numero_personalizado, nota_cliente, ejemplos_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.session.clienteId,
      nombre,
      categoria,
      idioma,
      headerTipo,
      headerTexto,
      req.file ? req.file.filename : null,
      bodyTexto,
      footerTexto,
      JSON.stringify(botonesLimpios),
      numeroPersonalizado ? 1 : 0,
      notaCliente,
      JSON.stringify(ejemplos)
    );

  const creada = db.prepare(`${SELECT_PLANTILLA_BASE} WHERE s.id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ solicitud: serializarSolicitudPlantilla(creada) });
});

app.get('/api/plantillas', (req, res) => {
  const filas = db.prepare(`${SELECT_PLANTILLA_BASE} WHERE s.cliente_id = ? ORDER BY s.creado_en DESC`).all(req.session.clienteId);
  res.json({ solicitudes: filas.map(serializarSolicitudPlantilla) });
});

/**
 * El cliente cancela una solicitud que el equipo aún no empezó a gestionar
 * (estado 'pendiente'). Solo las suyas, y solo ese cambio de estado.
 */
app.patch('/api/plantillas/:id/cancelar', (req, res) => {
  const solicitud = db.prepare('SELECT * FROM plantillas_solicitudes WHERE id = ? AND cliente_id = ?').get(req.params.id, req.session.clienteId);
  if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (solicitud.estado !== 'pendiente') {
    return res.status(409).json({
      error: solicitud.estado === 'cancelada'
        ? 'Esta solicitud ya estaba cancelada.'
        : 'Esta solicitud ya está en gestión y no se puede cancelar desde aquí. Escríbenos si necesitas detenerla.',
    });
  }
  db.prepare(`UPDATE plantillas_solicitudes SET estado = 'cancelada', actualizado_en = datetime('now') WHERE id = ?`).run(solicitud.id);
  const actualizada = db.prepare(`${SELECT_PLANTILLA_BASE} WHERE s.id = ?`).get(solicitud.id);
  res.json({ solicitud: serializarSolicitudPlantilla(actualizada) });
});

app.get('/api/admin/plantillas', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para ver esta lista' });
  }

  const estado = req.query.estado ? String(req.query.estado) : null;
  if (estado && !ESTADOS_PLANTILLA.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  const filas = db
    .prepare(`${SELECT_PLANTILLA_BASE} ${estado ? 'WHERE s.estado = ?' : ''} ORDER BY s.creado_en DESC`)
    .all(...(estado ? [estado] : []));
  res.json({ solicitudes: filas.map(serializarSolicitudAdmin) });
});

app.patch('/api/admin/plantillas/:id', (req, res) => {
  const propio = clienteActual(req);
  if (!propio.es_admin) {
    return res.status(403).json({ error: 'No tienes permiso para gestionar solicitudes' });
  }

  const solicitud = db.prepare('SELECT * FROM plantillas_solicitudes WHERE id = ?').get(req.params.id);
  if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });

  const { estado, nota_admin, whatsapp_numero_id } = req.body || {};

  if (estado !== undefined) {
    if (!ESTADOS_PLANTILLA.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    db.prepare(`UPDATE plantillas_solicitudes SET estado = ?, actualizado_en = datetime('now') WHERE id = ?`).run(estado, solicitud.id);
  }

  if (nota_admin !== undefined) {
    db.prepare(`UPDATE plantillas_solicitudes SET nota_admin = ?, actualizado_en = datetime('now') WHERE id = ?`).run(
      nota_admin ? String(nota_admin).trim() : null,
      solicitud.id
    );
  }

  if (whatsapp_numero_id !== undefined) {
    if (whatsapp_numero_id === null || whatsapp_numero_id === '') {
      db.prepare(`UPDATE plantillas_solicitudes SET whatsapp_numero_id = NULL, actualizado_en = datetime('now') WHERE id = ?`).run(solicitud.id);
    } else {
      const numero = db.prepare('SELECT * FROM whatsapp_numeros WHERE id = ? AND cliente_id = ?').get(whatsapp_numero_id, propio.id);
      if (!numero) return res.status(404).json({ error: 'Ese número no está entre los tuyos conectados' });
      db.prepare(`UPDATE plantillas_solicitudes SET whatsapp_numero_id = ?, actualizado_en = datetime('now') WHERE id = ?`).run(numero.id, solicitud.id);
    }
  }

  const actualizada = db.prepare(`${SELECT_PLANTILLA_BASE} WHERE s.id = ?`).get(solicitud.id);
  res.json({ solicitud: serializarSolicitudAdmin(actualizada) });
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Envío masivo de WhatsApp corriendo en http://localhost:${PORT}`);
  iniciarScheduler();
});
