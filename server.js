import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto, { timingSafeEqual } from 'crypto';
import { db } from './db.js';
import { parseCsv } from './csv.js';
import { parseExcel } from './excel.js';
import { sendTemplate, sendTextMessage, normalizePhone, isWhatsAppConfigured } from './whatsapp.js';
import { buscarNegocios } from './leads.js';

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

/**
 * Compara dos strings en tiempo constante (evita timing attacks),
 * sin explotar si difieren en longitud.
 */
function secureCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // igual costo que una comparación real
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * HTTP Basic Auth para toda la app (API + estáticos). Credenciales en
 * BASIC_AUTH_USER / BASIC_AUTH_PASS del .env. Si no están configuradas,
 * no se exige login (útil en dev local).
 */
function requireAuth(req, res, next) {
  // Meta llama a /webhook directo (sin credenciales) — se protege con
  // la verificación de token (GET) y la firma HMAC (POST), no con Basic Auth.
  if (req.path === '/webhook') return next();

  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [reqUser, reqPass] = Buffer.from(encoded, 'base64').toString('utf-8').split(':');
    if (reqUser && reqPass && secureCompare(reqUser, user) && secureCompare(reqPass, pass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Envio masivo WhatsApp"');
  res.status(401).send('Autenticación requerida');
}

app.use(requireAuth);
// Guarda el body crudo (necesario para verificar la firma HMAC del
// webhook de Meta) sin cambiar cómo se usa req.body en el resto de la app.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIG ====================

app.get('/api/config', (req, res) => {
  res.json({
    whatsappConfigured: isWhatsAppConfigured(),
    webhookVerifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    webhookSignatureConfigured: Boolean(process.env.WHATSAPP_APP_SECRET),
  });
});

// ==================== CONTACTOS ====================

app.get('/api/contactos', (req, res) => {
  const contactos = db.prepare('SELECT * FROM contactos ORDER BY nombre COLLATE NOCASE ASC').all();
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
      .prepare('INSERT INTO contactos (telefono, nombre) VALUES (?, ?)')
      .run(normalizado, nombre || null);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un contacto con ese teléfono' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contactos', (req, res) => {
  db.prepare('DELETE FROM contactos').run();
  res.json({ ok: true });
});

app.delete('/api/contactos/:id', (req, res) => {
  db.prepare('DELETE FROM contactos WHERE id = ?').run(req.params.id);
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
      INSERT INTO contactos (telefono, nombre) VALUES (?, ?)
      ON CONFLICT(telefono) DO UPDATE SET nombre = COALESCE(excluded.nombre, contactos.nombre)
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
        upsert.run(normalizado, nombreRaw || null);
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
  const campanas = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('enviado','entregado','leido')) AS enviados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('entregado','leido')) AS entregados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'leido') AS leidos,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'fallido') AS fallidos
       FROM campanas c
       ORDER BY c.id DESC`
    )
    .all();
  res.json({ campanas });
});

app.get('/api/campanas/:id', (req, res) => {
  const campana = db.prepare('SELECT * FROM campanas WHERE id = ?').get(req.params.id);
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
 * Body:
 *   template_nombre: string
 *   idioma: string (default 'es')
 *   contacto_ids: number[]
 *   parametros: Array<{ tipo: 'fijo'|'nombre', valor?: string }>
 *     - 'nombre': se reemplaza por el nombre del contacto (o el
 *       teléfono si no tiene nombre cargado).
 *     - 'fijo': se manda `valor` tal cual, igual para todos.
 */
app.post('/api/campanas', (req, res) => {
  const { template_nombre, idioma, contacto_ids, parametros } = req.body || {};

  if (!template_nombre || !String(template_nombre).trim()) {
    return res.status(400).json({ error: 'Falta el nombre de la plantilla' });
  }
  if (!Array.isArray(contacto_ids) || contacto_ids.length === 0) {
    return res.status(400).json({ error: 'Elegí al menos un contacto' });
  }
  if (!isWhatsAppConfigured()) {
    return res.status(400).json({ error: 'WhatsApp no está configurado en el .env de este proyecto' });
  }

  const placeholders = contacto_ids.map(() => '?').join(',');
  const contactos = db
    .prepare(`SELECT * FROM contactos WHERE id IN (${placeholders})`)
    .all(...contacto_ids);

  if (contactos.length === 0) {
    return res.status(400).json({ error: 'No se encontraron los contactos seleccionados' });
  }

  const parametrosDef = Array.isArray(parametros) ? parametros : [];

  const result = db
    .prepare(
      `INSERT INTO campanas (template_nombre, idioma, parametros_json, total_contactos, estado)
       VALUES (?, ?, ?, ?, 'procesando')`
    )
    .run(template_nombre.trim(), idioma || 'es', JSON.stringify(parametrosDef), contactos.length);

  const campanaId = result.lastInsertRowid;

  // Fire-and-forget: procesa en background, el request ya respondió.
  procesarCampana({ campanaId, template_nombre: template_nombre.trim(), idioma: idioma || 'es', parametrosDef, contactos });

  res.status(202).json({ campana_id: campanaId, total: contactos.length });
});

async function procesarCampana({ campanaId, template_nombre, idioma, parametrosDef, contactos }) {
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
    INSERT INTO leads_prospectos (nombre, rubro, direccion, telefono, link_whatsapp, sitio_web)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telefono) DO NOTHING
  `);

  let nuevos = 0;
  let duplicados = 0;
  for (const r of busqueda.resultados) {
    const result = insert.run(r.nombre, r.rubro, r.direccion, r.telefono, r.link_whatsapp, r.sitio_web);
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
    ? db.prepare('SELECT * FROM leads_prospectos WHERE estado = ? ORDER BY fecha_encontrado DESC').all(estado)
    : db.prepare('SELECT * FROM leads_prospectos ORDER BY fecha_encontrado DESC').all();
  res.json({ leads });
});

app.patch('/api/leads/:id', (req, res) => {
  const { estado } = req.body || {};
  if (!estado || !String(estado).trim()) {
    return res.status(400).json({ error: 'Falta el estado' });
  }
  const result = db
    .prepare('UPDATE leads_prospectos SET estado = ? WHERE id = ?')
    .run(estado.trim(), req.params.id);
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
  INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, nombre_perfil, leido_por_agente)
  VALUES (?, 'entrante', ?, ?, ?, 'recibido', ?, 0)
`);

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
      return '[Audio]';
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

      const nombresPerfil = {};
      for (const c of valor.contacts || []) {
        if (c.wa_id && c.profile?.name) nombresPerfil[c.wa_id] = c.profile.name;
      }

      for (const msg of valor.messages || []) {
        const telefono = msg.from;
        if (!telefono) continue;
        insertMensajeEntrante.run(telefono, msg.type || 'texto', extraerTextoMensaje(msg), msg.id || null, nombresPerfil[telefono] || null);
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
  const telefonos = db
    .prepare(`SELECT telefono, MAX(creado_en) AS ultimo_en FROM mensajes GROUP BY telefono ORDER BY ultimo_en DESC`)
    .all();

  const conversaciones = telefonos.map(({ telefono }) => {
    const ultimo = db
      .prepare(`SELECT texto, direccion, estado, creado_en FROM mensajes WHERE telefono = ? ORDER BY creado_en DESC, id DESC LIMIT 1`)
      .get(telefono);
    const contacto = db.prepare('SELECT nombre FROM contactos WHERE telefono = ?').get(telefono);
    const noLeidos = db
      .prepare(`SELECT COUNT(*) AS n FROM mensajes WHERE telefono = ? AND direccion = 'entrante' AND leido_por_agente = 0`)
      .get(telefono).n;
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
  const mensajes = db
    .prepare('SELECT * FROM mensajes WHERE telefono = ? ORDER BY creado_en ASC, id ASC')
    .all(telefono);
  db.prepare(`UPDATE mensajes SET leido_por_agente = 1 WHERE telefono = ? AND direccion = 'entrante' AND leido_por_agente = 0`).run(telefono);
  res.json({ mensajes });
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
  if (!texto || !String(texto).trim()) {
    return res.status(400).json({ error: 'Falta el texto del mensaje' });
  }
  if (!isWhatsAppConfigured()) {
    return res.status(400).json({ error: 'WhatsApp no está configurado en el .env de este proyecto' });
  }

  const textoLimpio = texto.trim();
  const resultado = await sendTextMessage({ to: telefono, body: textoLimpio });

  const insertado = db
    .prepare(`
      INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, error, leido_por_agente)
      VALUES (?, 'saliente', 'texto', ?, ?, ?, ?, 1)
    `)
    .run(telefono, textoLimpio, resultado.messageId || null, resultado.ok ? 'enviado' : 'fallido', resultado.ok ? null : resultado.error);

  if (!resultado.ok) {
    return res.status(502).json({ error: resultado.error, id: insertado.lastInsertRowid });
  }
  res.status(201).json({ id: insertado.lastInsertRowid, wa_message_id: resultado.messageId });
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Envío masivo de WhatsApp corriendo en http://localhost:${PORT}`);
  if (!isWhatsAppConfigured()) {
    console.warn('⚠️  WhatsApp no configurado — copiá .env.example a .env y completá las credenciales.');
  }
});
