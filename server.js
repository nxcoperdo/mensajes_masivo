import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import { db } from './db.js';
import { parseCsv } from './csv.js';
import { sendTemplate, normalizePhone, isWhatsAppConfigured } from './whatsapp.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIG ====================

app.get('/api/config', (req, res) => {
  res.json({ whatsappConfigured: isWhatsAppConfigured() });
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

app.delete('/api/contactos/:id', (req, res) => {
  db.prepare('DELETE FROM contactos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Importa un CSV con columnas `telefono` (o `phone`/`numero`) y
 * `nombre` (opcional). Hace upsert por teléfono normalizado: si ya
 * existe, actualiza el nombre; si no, lo crea.
 */
app.post('/api/contactos/importar', upload.single('archivo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo CSV' });
  }

  const texto = req.file.buffer.toString('utf-8');
  const filas = parseCsv(texto);
  if (filas.length === 0) {
    return res.status(400).json({ error: 'El CSV está vacío o no se pudo leer' });
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

// ==================== CAMPAÑAS ====================

app.get('/api/campanas', (req, res) => {
  const campanas = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'enviado') AS enviados,
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
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'enviado'`)
    .get(req.params.id).n;
  const fallidos = db
    .prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'fallido'`)
    .get(req.params.id).n;
  res.json({ campana: { ...campana, enviados, fallidos } });
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

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Envío masivo de WhatsApp corriendo en http://localhost:${PORT}`);
  if (!isWhatsAppConfigured()) {
    console.warn('⚠️  WhatsApp no configurado — copiá .env.example a .env y completá las credenciales.');
  }
});
