import express from 'express';
import { db } from '../db.js';
import { sendTextMessage, sendTemplate, normalizePhone } from '../whatsapp.js';
import { buscarNegocios } from '../leads.js';
import { generarRespuesta } from './claude.js';
import { promptPorDefecto } from './knowledge.js';

// ==================== BD ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS agente_config (
    cliente_id INTEGER PRIMARY KEY,
    activo INTEGER NOT NULL DEFAULT 0,
    phone_number_id TEXT,
    modelo TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
    anthropic_key TEXT,
    prompt_base TEXT,
    prompt_extra TEXT,
    plantilla TEXT NOT NULL DEFAULT 'presentacion_crt',
    idioma TEXT NOT NULL DEFAULT 'es_CO',
    owner_phone TEXT,
    telegram_token TEXT,
    telegram_chat_id TEXT,
    limite_diario INTEGER NOT NULL DEFAULT 20,
    crt_url TEXT,
    nota_iva TEXT
  );
  CREATE TABLE IF NOT EXISTS agente_contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    telefono TEXT NOT NULL,
    nombre TEXT, negocio TEXT, ciudad TEXT, necesidad TEXT, presupuesto TEXT, urgencia TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',  -- nuevo|contactado|conversando|caliente|cerrado|perdido|baja
    modo TEXT NOT NULL DEFAULT 'agente',   -- agente|humano
    resumen TEXT,
    nicho TEXT,
    primer_contacto TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cliente_id, telefono)
  );
  CREATE TABLE IF NOT EXISTS agente_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    telefono TEXT NOT NULL,
    rol TEXT NOT NULL, -- user|assistant|nicolas
    texto TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agente_chat ON agente_chat(cliente_id, telefono, id);
  CREATE TABLE IF NOT EXISTS agente_programados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    ejecutar_en TEXT NOT NULL,           -- UTC 'YYYY-MM-DD HH:MM:SS'
    cantidad INTEGER NOT NULL,
    nicho TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|ejecutando|hecho|error|cancelado
    resultado TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

for (const col of ['resenas INTEGER', 'calificacion REAL']) { try { db.exec(`ALTER TABLE leads_prospectos ADD COLUMN ${col}`); } catch { /* ya existe */ } }
try { db.exec("ALTER TABLE agente_programados ADD COLUMN ciudad TEXT NOT NULL DEFAULT ''"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE agente_programados ADD COLUMN tipo TEXT NOT NULL DEFAULT 'primer'"); } catch { /* ya existe */ }
try { db.exec('ALTER TABLE agente_contactos ADD COLUMN sitio_web TEXT'); } catch { /* ya existe */ }
try { db.exec('ALTER TABLE agente_contactos ADD COLUMN reenviado INTEGER NOT NULL DEFAULT 0'); } catch { /* ya existe */ }

const CAMPOS_CONTACTO = ['nombre', 'negocio', 'ciudad', 'necesidad', 'presupuesto', 'urgencia', 'estado', 'modo', 'resumen'];

export function emailDuenoAgente() {
  return (process.env.AGENTE_EMAIL || 'nicolasperdomoliz@gmail.com').trim().toLowerCase();
}

export function esDuenoAgente(cliente) {
  return Boolean(cliente && String(cliente.email).toLowerCase() === emailDuenoAgente());
}

function getCfg(clienteId) {
  let cfg = db.prepare('SELECT * FROM agente_config WHERE cliente_id = ?').get(clienteId);
  if (!cfg) {
    db.prepare('INSERT INTO agente_config (cliente_id) VALUES (?)').run(clienteId);
    cfg = db.prepare('SELECT * FROM agente_config WHERE cliente_id = ?').get(clienteId);
  }
  return cfg;
}

const apiKeyDe = (cfg) => (cfg.anthropic_key || process.env.ANTHROPIC_API_KEY || '').trim();

/** Credenciales del número elegido (del pool del dueño). */
function credencialesNumero(clienteId, phoneNumberId) {
  const n = db.prepare('SELECT access_token FROM whatsapp_numeros WHERE cliente_id = ? AND phone_number_id = ?').get(clienteId, phoneNumberId);
  if (n?.access_token) return { phoneNumberId, accessToken: n.access_token };
  const c = db.prepare('SELECT access_token FROM clientes WHERE id = ? AND phone_number_id = ?').get(clienteId, phoneNumberId);
  return c?.access_token ? { phoneNumberId, accessToken: c.access_token } : null;
}

const getContacto = (clienteId, tel) => db.prepare('SELECT * FROM agente_contactos WHERE cliente_id = ? AND telefono = ?').get(clienteId, tel);

function crearContacto(clienteId, tel, nombre) {
  db.prepare('INSERT OR IGNORE INTO agente_contactos (cliente_id, telefono, nombre) VALUES (?, ?, ?)').run(clienteId, tel, nombre || null);
}

function actualizarContacto(clienteId, tel, campos) {
  const k = Object.keys(campos).filter((x) => CAMPOS_CONTACTO.includes(x) && campos[x] != null);
  if (!k.length) return;
  db.prepare(`UPDATE agente_contactos SET ${k.map((x) => `${x} = ?`).join(', ')}, actualizado_en = datetime('now') WHERE cliente_id = ? AND telefono = ?`)
    .run(...k.map((x) => String(campos[x])), clienteId, tel);
}

const addChat = (clienteId, tel, rol, texto) =>
  db.prepare('INSERT INTO agente_chat (cliente_id, telefono, rol, texto) VALUES (?, ?, ?, ?)').run(clienteId, tel, rol, texto);

function mensajesParaClaude(clienteId, tel) {
  const filas = db.prepare('SELECT rol, texto FROM agente_chat WHERE cliente_id = ? AND telefono = ? ORDER BY id DESC LIMIT 40').all(clienteId, tel).reverse();
  const out = [];
  for (const m of filas) {
    const role = m.rol === 'user' ? 'user' : 'assistant';
    const texto = m.rol === 'nicolas' ? `[Nicolás escribió]: ${m.texto}` : m.texto;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${texto}`;
    else out.push({ role, content: texto });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ==================== Envío + registro en `mensajes` ====================
async function enviarTexto(clienteId, cfg, tel, texto) {
  const cred = credencialesNumero(clienteId, cfg.phone_number_id);
  if (!cred) throw new Error('El número elegido no tiene credenciales en whatsapp_numeros');
  const r = await sendTextMessage({ to: tel, body: texto, ...cred });
  db.prepare(`INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, error, leido_por_agente, cliente_id, phone_number_id)
              VALUES (?, 'saliente', 'texto', ?, ?, ?, ?, 1, ?, ?)`)
    .run(tel, texto, r.messageId || null, r.ok ? 'enviado' : 'fallido', r.ok ? null : r.error, clienteId, cfg.phone_number_id);
  if (!r.ok) throw new Error(r.error);
  return r;
}

// ==================== Notificaciones (Telegram / WhatsApp al dueño) ====================
export async function avisar(clienteId, cfg, texto) {
  try {
    if (cfg.telegram_token && cfg.telegram_chat_id) {
      const r = await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegram_chat_id, text: texto, disable_web_page_preview: true }),
      });
      if (r.ok) return { ok: true, via: 'telegram' };
      console.error('[agente] Telegram falló:', await r.text());
    }
    const owner = normalizePhone(cfg.owner_phone);
    if (owner) {
      const cred = credencialesNumero(clienteId, cfg.phone_number_id);
      if (cred) {
        const r = await sendTextMessage({ to: owner, body: texto, ...cred });
        return { ok: r.ok, via: 'whatsapp', error: r.error };
      }
    }
    return { ok: false, error: 'Sin Telegram ni número de dueño configurado' };
  } catch (e) {
    console.error('[agente] no pude avisar:', e.message);
    return { ok: false, error: e.message };
  }
}

// ==================== Núcleo ====================
async function ejecutarHerramienta(clienteId, cfg, tel, nombre, input) {
  const contacto = getContacto(clienteId, tel);
  switch (nombre) {
    case 'guardar_datos':
      actualizarContacto(clienteId, tel, input);
      return 'Guardado.';
    case 'pasar_a_nicolas': {
      actualizarContacto(clienteId, tel, { estado: 'caliente', modo: 'humano', resumen: input.resumen });
      const c = getContacto(clienteId, tel);
      await avisar(clienteId, cfg, [
        '🔥 CLIENTE LISTO PARA CERRAR',
        `👤 ${c.nombre || 'Sin nombre'} — ${c.negocio || 'negocio sin definir'}${c.ciudad ? ` (${c.ciudad})` : ''}`,
        `📞 https://wa.me/${tel}`,
        `🎯 Motivo: ${input.motivo}`,
        `📝 ${input.resumen}`,
        input.propuesta_sugerida ? `💡 Sugerencia: ${input.propuesta_sugerida}` : '',
        c.presupuesto ? `💰 Presupuesto: ${c.presupuesto}` : '',
        c.urgencia ? `⏱ Urgencia: ${c.urgencia}` : '',
        '',
        'El agente ya se calló en este chat. Escríbele desde tu WhatsApp o desde el panel.',
      ].filter(Boolean).join('\n'));
      return 'Listo, Nicolás fue notificado. Despídete diciendo que Nicolás le escribe en breve desde su WhatsApp personal.';
    }
    case 'marcar_no_interesado':
      actualizarContacto(clienteId, tel, {
        estado: input.pidio_baja ? 'baja' : 'perdido',
        resumen: `${contacto?.resumen ? contacto.resumen + ' | ' : ''}No interesado: ${input.razon || ''}`,
      });
      return 'Marcado. Despídete con amabilidad en una línea y no insistas.';
    default:
      return 'Herramienta desconocida.';
  }
}

async function manejarEntrante(clienteId, cfg, tel, texto, nombrePerfil) {
  if (!getContacto(clienteId, tel)) crearContacto(clienteId, tel, nombrePerfil);
  let c = getContacto(clienteId, tel);
  if (c.estado === 'contactado' || c.estado === 'nuevo') actualizarContacto(clienteId, tel, { estado: 'conversando' });
  addChat(clienteId, tel, 'user', texto);

  if (c.modo === 'humano') {
    return avisar(clienteId, cfg, `💬 ${c.nombre || tel} (${c.negocio || 'sin negocio'}):\n${texto}\nhttps://wa.me/${tel}`);
  }
  if (c.estado === 'baja') return;

  // Primer toque de "Sí, cuéntame": presentación fija y corta con el enlace; luego Claude sigue desarrollando la venta con ese mensaje ya en el historial.
  if ((c.estado === 'contactado' || c.estado === 'nuevo') && /^\s*s[ií]\s*,?\s*cu[eé]ntame/i.test(texto)) {
    const intro = [
      `¡Genial${c.nombre ? `, ${String(c.nombre).split(' ')[0]}` : ''}! 👋 Soy el asistente de *Code Repair Tech*, de parte de Nicolás Perdomo.`,
      cfg.crt_url ? `Aquí puedes ver lo que hacemos: ${cfg.crt_url}` : '',
      'Cuéntame, ¿qué tipo de negocio tienes y qué te gustaría mejorar?',
    ].filter(Boolean).join('\n\n');
    await enviarTexto(clienteId, cfg, tel, intro);
    addChat(clienteId, tel, 'assistant', intro);
    return;
  }

  await responderConClaude(clienteId, cfg, tel);
}

/** Genera y envía la respuesta de Claude con el historial actual (sin agregar mensaje nuevo). */
// Señales claras de compra / necesidad de cierre humano. Si aparecen y Claude no pasó el cliente
// a Nicolás por su cuenta, el sistema lo pasa igual (red de seguridad determinista).
const SENAL_CIERRE = /cuota|abono|financ|a plazos|cotizaci|c[oó]mo (pago|pagar|se paga)|formas? de pago|quiero (empezar|contratar|comprar|el servicio|la p[aá]gina|el sistema)|me (gustar[ií]a|interesa)\s+(empezar|contratar)|empecemos|arranquemos|(ll[aá]ma(me|r|nos)|llamen|llamada)|reuni[oó]n|hablar con (nicol[aá]s|una persona|alguien|un asesor)|no (cuento|tengo) (con )?(todo|el dinero|la plata)|no puedo pagar/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const primerNombre = (c) => (c?.nombre ? String(c.nombre).split(' ')[0] : '');
const ultimoMensajeCliente = (clienteId, tel) =>
  db.prepare("SELECT texto FROM agente_chat WHERE cliente_id = ? AND telefono = ? AND rol = 'user' ORDER BY id DESC LIMIT 1").get(clienteId, tel)?.texto || '';

async function enviarYRegistrar(clienteId, cfg, tel, texto) {
  await enviarTexto(clienteId, cfg, tel, texto);
  addChat(clienteId, tel, 'assistant', texto);
}

/** Pasa el cliente a Nicolás aunque Claude no lo haya hecho (con resumen armado del historial). */
async function pasarPorRegla(clienteId, cfg, tel, motivo) {
  const c = getContacto(clienteId, tel);
  const ult = db.prepare("SELECT rol, texto FROM agente_chat WHERE cliente_id = ? AND telefono = ? ORDER BY id DESC LIMIT 6").all(clienteId, tel).reverse();
  const resumen = [
    [c?.negocio && `Negocio: ${c.negocio}`, c?.necesidad && `Necesidad: ${c.necesidad}`, c?.presupuesto && `Presupuesto: ${c.presupuesto}`, c?.urgencia && `Urgencia: ${c.urgencia}`].filter(Boolean).join(' | '),
    'Últimos mensajes: ' + ult.map((m) => `${m.rol === 'user' ? 'Cliente' : 'Agente'}: ${String(m.texto).slice(0, 120)}`).join(' / '),
  ].filter(Boolean).join('\n');
  return ejecutarHerramienta(clienteId, cfg, tel, 'pasar_a_nicolas', { motivo, resumen });
}

/**
 * Genera y envía la respuesta. NUNCA deja al cliente sin respuesta:
 *  - reintenta hasta 3 veces si Claude falla o devuelve vacío,
 *  - si el cliente muestra señal de compra y Claude no lo pasó, lo pasa el sistema,
 *  - si todo falla, manda un mensaje seguro y avisa al dueño.
 */
async function responderConClaude(clienteId, cfg, tel) {
  if (!mensajesParaClaude(clienteId, tel).length) return;
  const textoCliente = ultimoMensajeCliente(clienteId, tel);
  let respuesta = '';
  let error = null;

  for (let intento = 0; intento < 3 && !respuesta; intento++) {
    try {
      respuesta = await generarRespuesta({
        cfg,
        apiKey: apiKeyDe(cfg),
        mensajes: mensajesParaClaude(clienteId, tel),
        contacto: () => getContacto(clienteId, tel),
        ejecutarHerramienta: (n, i) => ejecutarHerramienta(clienteId, cfg, tel, n, i),
      });
    } catch (e) {
      error = e;
      console.error(`[agente ${clienteId}:${tel}] intento ${intento + 1} falló:`, e.message);
    }
    // Si ya pasó el cliente a Nicolás (alerta enviada), no repetir: evita alertas dobles.
    if (!respuesta && getContacto(clienteId, tel)?.modo === 'humano') break;
    if (!respuesta && intento < 2) await sleep(1500 * (intento + 1));
  }

  const c = getContacto(clienteId, tel);
  const yaPasado = c?.modo === 'humano';
  const nombre = primerNombre(c);

  // Red de seguridad: señal de cierre y Claude no pasó el cliente.
  if (!yaPasado && SENAL_CIERRE.test(textoCliente)) {
    await pasarPorRegla(clienteId, cfg, tel, `Señal de compra detectada: "${textoCliente.slice(0, 150)}"`);
    await enviarYRegistrar(clienteId, cfg, tel,
      `Perfecto${nombre ? `, ${nombre}` : ''} 🙌 Nicolás te escribe o te llama en breve desde su WhatsApp personal para acordar los detalles y arrancar (si lo necesitas, se puede pagar en cuotas).`);
    return 'cierre-por-regla';
  }

  if (respuesta) {
    await enviarYRegistrar(clienteId, cfg, tel, respuesta);
    return respuesta;
  }

  if (yaPasado) {
    // Se pasó a Nicolás pero Claude no escribió despedida: mandamos una estándar.
    await enviarYRegistrar(clienteId, cfg, tel, `Listo${nombre ? `, ${nombre}` : ''}. Nicolás ya tiene tu caso y te escribe o te llama en breve desde su WhatsApp personal. ¡Gracias por la confianza! 🙌`);
    return 'despedida-estandar';
  }

  // Falló todo: mensaje seguro + aviso al dueño (el cliente nunca queda en silencio).
  console.error(`[agente ${clienteId}:${tel}] sin respuesta tras 3 intentos`, error?.message || '');
  await avisar(clienteId, cfg, `⚠️ El agente no pudo responder a ${c?.nombre || tel} tras 3 intentos${error ? ` (${String(error.message).slice(0, 120)})` : ''}.\nÚltimo mensaje: "${textoCliente.slice(0, 150)}"\nRespóndele tú: https://wa.me/${tel}`);
  await enviarYRegistrar(clienteId, cfg, tel, `Gracias por escribirnos${nombre ? `, ${nombre}` : ''} 🙌 Dame un momento: Nicolás te responde por aquí en breve.`);
  return 'respaldo';
}

// ==================== Vigilante: ningún cliente sin respuesta ====================
const intentosVigilante = new Map();

export async function vigilarPendientes() {
  const configs = db.prepare('SELECT * FROM agente_config WHERE activo = 1 AND phone_number_id IS NOT NULL').all();
  for (const cfg of configs) {
    const owner = normalizePhone(cfg.owner_phone);
    const pendientes = db.prepare(`
      SELECT c.telefono, ch.id AS chat_id
      FROM agente_contactos c
      JOIN agente_chat ch ON ch.id = (SELECT MAX(id) FROM agente_chat WHERE cliente_id = c.cliente_id AND telefono = c.telefono)
      WHERE c.cliente_id = ? AND c.modo = 'agente' AND c.estado NOT IN ('baja','perdido','cerrado','caliente')
        AND ch.rol = 'user' AND ch.creado_en < datetime('now', '-2 minutes') AND ch.creado_en > datetime('now', '-20 hours')
    `).all(cfg.cliente_id);
    for (const p of pendientes) {
      if (owner && p.telefono === owner) continue;
      const clave = `${cfg.cliente_id}:${p.telefono}`;
      if (colas.has(clave)) continue; // se está atendiendo ahora mismo
      const llave = `${clave}:${p.chat_id}`;
      const n = intentosVigilante.get(llave) || 0;
      if (n >= 2) continue;
      intentosVigilante.set(llave, n + 1);
      console.error(`[agente vigilante] cliente sin respuesta: ${p.telefono}, reintento ${n + 1}`);
      enCola(clave, () => responderConClaude(cfg.cliente_id, getCfg(cfg.cliente_id), p.telefono));
    }
  }
  if (intentosVigilante.size > 2000) intentosVigilante.clear();
  await ejecutarProgramados();
  await resumenDiarioSiToca();
}

/** Envíos de presentación programados (ver POST /api/agente/programar). */
async function ejecutarProgramados() {
  const vencidos = db.prepare("SELECT * FROM agente_programados WHERE estado = 'pendiente' AND ejecutar_en <= datetime('now') ORDER BY ejecutar_en LIMIT 3").all();
  for (const p of vencidos) {
    // Reclamo atómico: si otro tick ya lo tomó, no se ejecuta dos veces.
    if (db.prepare("UPDATE agente_programados SET estado = 'ejecutando' WHERE id = ? AND estado = 'pendiente'").run(p.id).changes === 0) continue;
    const cfg = getCfg(p.cliente_id);
    try {
      if (!cfg.activo) throw new Error('El agente está apagado');
      const r = p.tipo === 'reenvio'
        ? await reenviarSinRespuesta(p.cliente_id, cfg, { limite: p.cantidad })
        : await contactarProspectos(p.cliente_id, cfg, { nicho: p.nicho, ciudad: p.ciudad, limite: p.cantidad, prueba: false });
      db.prepare("UPDATE agente_programados SET estado = 'hecho', resultado = ? WHERE id = ?").run(JSON.stringify(r), p.id);
      const detalle = r.errores.slice(0, 5).map((e) => e.telefono + ': ' + e.error).join(' | ');
      await avisar(p.cliente_id, cfg, '📤 Envío programado terminado: ' + r.enviados + ' presentaciones enviadas, ' + r.errores.length + ' errores.' + (detalle ? ' ' + detalle : ''));
    } catch (e) {
      db.prepare("UPDATE agente_programados SET estado = 'error', resultado = ? WHERE id = ?").run(String(e.message), p.id);
      await avisar(p.cliente_id, cfg, `⚠️ Falló el envío programado #${p.id}: ${e.message}`);
    }
  }
}

if (!globalThis.__agenteVigilante) {
  globalThis.__agenteVigilante = setInterval(() => vigilarPendientes().catch((e) => console.error('[agente vigilante]', e.message)), 60_000);
  globalThis.__agenteVigilante.unref?.();
}

/** Reintenta la respuesta pendiente de un cliente (uso operativo tras un fallo). */
export function reintentarRespuesta(clienteId, tel) {
  return responderConClaude(clienteId, getCfg(clienteId), tel);
}

async function comandoDueno(clienteId, cfg, texto) {
  const [cmd, telRaw, ...resto] = texto.split(/\s+/);
  const tel = telRaw ? normalizePhone(telRaw) : null;
  const owner = normalizePhone(cfg.owner_phone);
  const r = (t) => enviarTexto(clienteId, cfg, owner, t);
  const existe = tel && getContacto(clienteId, tel);

  switch ((cmd || '').toLowerCase()) {
    case '#leads': {
      const ls = db.prepare("SELECT * FROM agente_contactos WHERE cliente_id = ? AND estado = 'caliente' ORDER BY actualizado_en DESC").all(clienteId);
      if (!ls.length) return r('No hay clientes calientes pendientes.');
      return r(ls.map((c) => `🔥 ${c.nombre || '-'} | ${c.negocio || '-'}\n${c.resumen || ''}\nwa.me/${c.telefono}`).join('\n\n'));
    }
    case '#tomar':
      if (!existe) return r('No conozco ese número.');
      actualizarContacto(clienteId, tel, { modo: 'humano' });
      return r(`Listo, el agente se calla con ${tel}.`);
    case '#devolver':
      if (!existe) return r('No conozco ese número.');
      actualizarContacto(clienteId, tel, { modo: 'agente', estado: 'conversando' });
      return r(`El agente vuelve a atender a ${tel}.`);
    case '#cerrado':
    case '#perdido':
      if (!existe) return r('No conozco ese número.');
      actualizarContacto(clienteId, tel, { estado: cmd.slice(1).toLowerCase(), modo: 'humano' });
      return r(`${tel} marcado como ${cmd.slice(1)}.`);
    case '#r': {
      if (!existe || !resto.length) return r('Uso: #r 573001234567 mensaje');
      const msj = resto.join(' ');
      await enviarTexto(clienteId, cfg, tel, msj);
      addChat(clienteId, tel, 'nicolas', msj);
      return r('Enviado ✅');
    }
    case '#ficha': {
      if (!existe) return r('No conozco ese número.');
      return r(Object.entries(getContacto(clienteId, tel)).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
    default:
      return r('Comandos:\n#leads\n#ficha 57…\n#tomar 57…\n#devolver 57…\n#cerrado 57… / #perdido 57…\n#r 57… mensaje');
  }
}

// Cola por teléfono: procesa en orden los mensajes de una misma persona.
const colas = new Map();
function enCola(clave, fn) {
  const prev = colas.get(clave) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error(`[agente ${clave}]`, e.message));
  colas.set(clave, next);
  next.finally(() => colas.get(clave) === next && colas.delete(clave));
}

/**
 * Hook llamado desde el webhook por cada mensaje entrante. Inerte salvo que
 * algún destinatario sea el dueño del agente, esté activo y el mensaje haya
 * entrado por el número elegido en el panel.
 */
export function alRecibirMensaje({ clienteIds, phoneNumberId, msg, texto, nombrePerfil }) {
  try {
    if (!texto || !msg?.from) return;
    for (const clienteId of clienteIds) {
      const cliente = db.prepare('SELECT id, email FROM clientes WHERE id = ?').get(clienteId);
      if (!esDuenoAgente(cliente)) continue;
      const cfg = getCfg(clienteId);
      if (!cfg.activo || !cfg.phone_number_id || cfg.phone_number_id !== phoneNumberId) continue;
      const tel = msg.from;
      const owner = normalizePhone(cfg.owner_phone);
      enCola(`${clienteId}:${tel}`, async () => {
        if (owner && tel === owner) return comandoDueno(clienteId, cfg, texto.trim());
        if (msg.type === 'audio') texto = '[El cliente envió una nota de voz que no puedes escuchar. Pídele amablemente que lo escriba.]';
        else if (msg.type === 'image' || msg.type === 'video' || msg.type === 'document' || msg.type === 'sticker')
          texto = `[El cliente envió ${msg.type}${texto && !texto.startsWith('[') ? ` con el texto: "${texto}"` : ''}]`;
        try {
          return await manejarEntrante(clienteId, cfg, tel, texto, nombrePerfil);
        } catch (e) {
          await avisar(clienteId, cfg, `⚠️ Falló el agente con ${tel}: ${String(e.message).slice(0, 200)}\nRespóndele tú: https://wa.me/${tel}`);
          throw e;
        }
      });
    }
  } catch (e) {
    console.error('[agente] hook:', e.message);
  }
}

// ==================== Prospección / contacto ====================
function puntajeLead(l) {
  let p = 0;
  const web = (l.sitio_web || '').toLowerCase();
  if (!web) p += 60;
  else if (/facebook|instagram|wa\.me|linktr/.test(web)) p += 35;
  if (/^573d{9}$/.test(l.telefono)) p += 25; // celular
  // Reseñas = negocio activo con clientes reales que puede pagar
  const rs = Number(l.resenas) || 0;
  p += rs >= 100 ? 25 : rs >= 30 ? 18 : rs >= 10 ? 10 : rs >= 3 ? 4 : 0;
  return p;
}

/**
 * Reenvía UNA sola vez la presentación a quienes recibieron el primer mensaje y no respondieron
 * (estado 'contactado', agente a cargo, primer contacto en los últimos 4 días).
 */
async function reenviarSinRespuesta(clienteId, cfg, { limite }) {
  const cred = credencialesNumero(clienteId, cfg.phone_number_id);
  if (!cred) throw new Error('Elige un número válido para el agente');
  const filas = db.prepare("SELECT * FROM agente_contactos WHERE cliente_id = ? AND estado = 'contactado' AND modo = 'agente' AND reenviado = 0 AND primer_contacto IS NOT NULL AND primer_contacto > datetime('now', '-4 days') ORDER BY id LIMIT ?")
    .all(clienteId, Number(limite) || 200);
  let enviados = 0;
  const errores = [];
  for (const c of filas) {
    const r = await sendTemplate({ to: c.telefono, template: cfg.plantilla, languageCode: cfg.idioma, parameters: [c.nombre || 'amigo'], ...cred });
    if (r.ok) {
      enviados++;
      db.prepare("UPDATE agente_contactos SET reenviado = 1, actualizado_en = datetime('now') WHERE id = ?").run(c.id);
      db.prepare(`INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, leido_por_agente, cliente_id, phone_number_id)
                  VALUES (?, 'saliente', 'plantilla', ?, ?, 'enviado', 1, ?, ?)`).run(c.telefono, `[Plantilla ${cfg.plantilla}] reenvío: ${c.nombre}`, r.messageId || null, clienteId, cfg.phone_number_id);
      addChat(clienteId, c.telefono, 'assistant', `[Se reenvió la plantilla de presentación a ${c.nombre} (no había respondido)]`);
    } else errores.push({ telefono: c.telefono, error: r.error });
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { enviados, errores, candidatos: filas.length };
}

function contactadosHoy(clienteId) {
  return db.prepare("SELECT COUNT(*) n FROM agente_contactos WHERE cliente_id = ? AND date(primer_contacto, '-5 hours') = date('now', '-5 hours')").get(clienteId).n;
}

async function contactarProspectos(clienteId, cfg, { nicho, ciudad, limite, prueba }) {
  const restante = Math.max(0, cfg.limite_diario - contactadosHoy(clienteId));
  const tope = Math.min(Number(limite) || restante, restante);
  let leads = db.prepare("SELECT * FROM leads_prospectos WHERE cliente_id = ? AND estado = 'nuevo' AND (? = '' OR lower(rubro) LIKE ? OR lower(nombre) LIKE ?) AND (? = '' OR lower(direccion) LIKE ?)")
    .all(clienteId, (nicho || '').toLowerCase(), `%${(nicho || '').toLowerCase()}%`, `%${(nicho || '').toLowerCase()}%`, (ciudad || '').toLowerCase(), `%${(ciudad || '').toLowerCase()}%`);
  // WhatsApp solo funciona con celulares colombianos (573XXXXXXXXX); los fijos se descartan.
  leads = leads.filter((l) => /^573\d{9}$/.test(l.telefono));
  leads = leads.map((l) => ({ ...l, puntaje: puntajeLead(l) })).sort((a, b) => b.puntaje - a.puntaje).slice(0, tope);

  if (prueba) return { prueba: true, restante_hoy: restante, a_contactar: leads.map((l) => ({ nombre: l.nombre, telefono: l.telefono, puntaje: l.puntaje })) };

  const cred = credencialesNumero(clienteId, cfg.phone_number_id);
  if (!cred) throw new Error('Elige un número válido para el agente');
  let enviados = 0;
  const errores = [];
  for (const l of leads) {
    const r = await sendTemplate({ to: l.telefono, template: cfg.plantilla, languageCode: cfg.idioma, parameters: [l.nombre], ...cred });
    if (r.ok) {
      enviados++;
      db.prepare('INSERT OR IGNORE INTO agente_contactos (cliente_id, telefono, nombre, negocio, nicho) VALUES (?, ?, ?, ?, ?)').run(clienteId, l.telefono, l.nombre, l.nombre, l.rubro);
      db.prepare('UPDATE agente_contactos SET sitio_web = ? WHERE cliente_id = ? AND telefono = ?').run(l.sitio_web || null, clienteId, l.telefono);
      db.prepare("UPDATE agente_contactos SET estado = 'contactado', primer_contacto = datetime('now'), actualizado_en = datetime('now') WHERE cliente_id = ? AND telefono = ? AND estado = 'nuevo'").run(clienteId, l.telefono);
      db.prepare("UPDATE agente_contactos SET primer_contacto = COALESCE(primer_contacto, datetime('now')) WHERE cliente_id = ? AND telefono = ?").run(clienteId, l.telefono);
      db.prepare("UPDATE leads_prospectos SET estado = 'contactado' WHERE id = ?").run(l.id);
      db.prepare(`INSERT INTO mensajes (telefono, direccion, tipo, texto, wa_message_id, estado, leido_por_agente, cliente_id, phone_number_id)
                  VALUES (?, 'saliente', 'plantilla', ?, ?, 'enviado', 1, ?, ?)`).run(l.telefono, `[Plantilla ${cfg.plantilla}] ${l.nombre}`, r.messageId || null, clienteId, cfg.phone_number_id);
      addChat(clienteId, l.telefono, 'assistant', `[Se envió la plantilla de presentación a ${l.nombre}]`);
    } else errores.push({ telefono: l.telefono, error: r.error });
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { enviados, errores, restante_hoy: restante - enviados };
}

// ==================== Router del panel ====================
export function crearRouterAgente() {
  const router = express.Router();

  router.use((req, res, next) => {
    const cliente = db.prepare('SELECT id, email FROM clientes WHERE id = ?').get(req.session?.clienteId);
    if (!esDuenoAgente(cliente)) return res.status(403).json({ error: 'Sin acceso al agente' });
    req.agenteClienteId = cliente.id;
    next();
  });

  const enmascarar = (s) => (s ? `••••${String(s).slice(-4)}` : '');
  const vistaCfg = (cfg) => ({
    ...cfg,
    anthropic_key: undefined,
    telegram_token: undefined,
    anthropic_key_set: Boolean(cfg.anthropic_key || process.env.ANTHROPIC_API_KEY),
    anthropic_key_mask: enmascarar(cfg.anthropic_key),
    telegram_token_set: Boolean(cfg.telegram_token),
    telegram_token_mask: enmascarar(cfg.telegram_token),
    prompt_default: promptPorDefecto({ crtUrl: cfg.crt_url, notaIva: cfg.nota_iva }),
  });

  router.get('/config', (req, res) => res.json({ config: vistaCfg(getCfg(req.agenteClienteId)) }));

  router.put('/config', (req, res) => {
    const id = req.agenteClienteId;
    getCfg(id);
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const poner = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

    if ('activo' in b) {
      if (b.activo) {
        const pn = b.phone_number_id ?? getCfg(id).phone_number_id;
        if (!pn || !credencialesNumero(id, pn)) return res.status(400).json({ error: 'Elige un número válido antes de activar el agente' });
        if (!apiKeyDe({ ...getCfg(id), ...(b.anthropic_key ? { anthropic_key: b.anthropic_key } : {}) })) return res.status(400).json({ error: 'Falta la API key de Anthropic' });
      }
      poner('activo', b.activo ? 1 : 0);
    }
    if ('phone_number_id' in b) {
      if (b.phone_number_id && !credencialesNumero(id, b.phone_number_id)) return res.status(400).json({ error: 'Ese número no está en tu pool' });
      poner('phone_number_id', b.phone_number_id || null);
    }
    for (const col of ['modelo', 'prompt_base', 'prompt_extra', 'plantilla', 'idioma', 'owner_phone', 'telegram_chat_id', 'crt_url', 'nota_iva']) {
      if (col in b) poner(col, b[col] === '' ? null : String(b[col]));
    }
    // Secretos: solo se actualizan si llegan no vacíos ("" = no cambiar; null explícito = borrar)
    for (const col of ['anthropic_key', 'telegram_token']) {
      if (b[col] === null) poner(col, null);
      else if (typeof b[col] === 'string' && b[col].trim()) poner(col, b[col].trim());
    }
    if ('limite_diario' in b) poner('limite_diario', Math.max(0, Math.min(500, parseInt(b.limite_diario, 10) || 0)));
    if (sets.length) db.prepare(`UPDATE agente_config SET ${sets.join(', ')} WHERE cliente_id = ?`).run(...vals, id);
    res.json({ config: vistaCfg(getCfg(id)) });
  });

  router.get('/numeros', (req, res) => {
    const numeros = db.prepare('SELECT DISTINCT phone_number_id, etiqueta FROM whatsapp_numeros WHERE cliente_id = ? ORDER BY etiqueta IS NULL, etiqueta').all(req.agenteClienteId);
    res.json({ numeros });
  });

  router.get('/estadisticas', (req, res) => {
    const id = req.agenteClienteId;
    const por = db.prepare('SELECT estado, COUNT(*) n FROM agente_contactos WHERE cliente_id = ? GROUP BY estado').all(id);
    const cfg = getCfg(id);
    res.json({ por_estado: Object.fromEntries(por.map((x) => [x.estado, x.n])), contactados_hoy: contactadosHoy(id), limite_diario: cfg.limite_diario });
  });

  router.get('/contactos', (req, res) => {
    const { estado } = req.query;
    const filas = estado
      ? db.prepare('SELECT * FROM agente_contactos WHERE cliente_id = ? AND estado = ? ORDER BY actualizado_en DESC LIMIT 500').all(req.agenteClienteId, estado)
      : db.prepare('SELECT * FROM agente_contactos WHERE cliente_id = ? ORDER BY actualizado_en DESC LIMIT 500').all(req.agenteClienteId);
    res.json({ contactos: filas });
  });

  router.get('/conversacion/:tel', (req, res) => {
    const id = req.agenteClienteId;
    res.json({
      contacto: getContacto(id, req.params.tel) || null,
      mensajes: db.prepare('SELECT rol, texto, creado_en FROM agente_chat WHERE cliente_id = ? AND telefono = ? ORDER BY id').all(id, req.params.tel),
    });
  });

  const cambiar = (campos) => (req, res) => {
    const tel = normalizePhone(req.params.tel);
    if (!tel || !getContacto(req.agenteClienteId, tel)) return res.status(404).json({ error: 'Contacto no encontrado' });
    actualizarContacto(req.agenteClienteId, tel, campos);
    res.json({ contacto: getContacto(req.agenteClienteId, tel) });
  };
  router.post('/contactos/:tel/tomar', cambiar({ modo: 'humano' }));
  router.post('/contactos/:tel/devolver', cambiar({ modo: 'agente', estado: 'conversando' }));
  router.post('/contactos/:tel/cerrado', cambiar({ estado: 'cerrado', modo: 'humano' }));
  router.post('/contactos/:tel/perdido', cambiar({ estado: 'perdido', modo: 'humano' }));

  router.post('/contactos/:tel/responder', async (req, res) => {
    const id = req.agenteClienteId;
    const tel = normalizePhone(req.params.tel);
    const texto = String(req.body?.texto || '').trim();
    if (!tel || !texto) return res.status(400).json({ error: 'Falta teléfono o texto' });
    const cfg = getCfg(id);
    try {
      await enviarTexto(id, cfg, tel, texto);
      if (!getContacto(id, tel)) crearContacto(id, tel);
      addChat(id, tel, 'nicolas', texto);
      actualizarContacto(id, tel, { modo: 'humano' });
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.post('/prospectar', async (req, res) => {
    const { nicho, ciudad } = req.body || {};
    if (!nicho || !ciudad) return res.status(400).json({ error: 'Falta nicho o ciudad' });
    const b = await buscarNegocios({ query: String(nicho).trim(), ciudad: String(ciudad).trim() });
    if (!b.ok) return res.status(502).json({ error: b.error });
    const ins = db.prepare(`INSERT INTO leads_prospectos (nombre, rubro, direccion, telefono, link_whatsapp, sitio_web, cliente_id, resenas, calificacion)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cliente_id, telefono) DO NOTHING`);
    let nuevos = 0;
    for (const r of b.resultados) {
      if (ins.run(r.nombre, r.rubro || nicho, r.direccion, r.telefono, r.link_whatsapp, r.sitio_web, req.agenteClienteId, r.resenas, r.calificacion).changes > 0) nuevos++;
    }
    res.json({ proveedor: b.proveedor, total_encontrados: b.resultados.length, nuevos, duplicados: b.resultados.length - nuevos });
  });

  router.get('/prospectos', (req, res) => {
    const filas = db.prepare("SELECT * FROM leads_prospectos WHERE cliente_id = ? AND estado = 'nuevo' ORDER BY fecha_encontrado DESC LIMIT 500").all(req.agenteClienteId);
    res.json({ prospectos: filas.map((l) => ({ ...l, puntaje: puntajeLead(l) })).sort((a, b) => b.puntaje - a.puntaje) });
  });

  router.post('/contactar', async (req, res) => {
    const id = req.agenteClienteId;
    const cfg = getCfg(id);
    const { nicho, ciudad, limite, prueba } = req.body || {};
    try {
      if (!prueba && !cfg.activo) return res.status(400).json({ error: 'Activa el agente antes de contactar (así sabe responder cuando contesten)' });
      res.json(await contactarProspectos(id, cfg, { nicho, ciudad, limite, prueba: Boolean(prueba) }));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Programar envío: fecha_hora = 'YYYY-MM-DDTHH:MM' en hora de Colombia (UTC-5)
  router.post('/programar', (req, res) => {
    const { fecha_hora, cantidad, nicho, ciudad, tipo } = req.body || {};
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(fecha_hora || ''));
    const n = parseInt(cantidad, 10);
    if (!m || !(n > 0 && n <= 200)) return res.status(400).json({ error: 'Falta fecha_hora (YYYY-MM-DDTHH:MM, hora Colombia) o cantidad (1-200)' });
    const utc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 5, +m[5]));
    if (utc.getTime() < Date.now()) return res.status(400).json({ error: 'La fecha ya pasó' });
    const ejecutarEn = utc.toISOString().slice(0, 19).replace('T', ' ');
    const r = db.prepare('INSERT INTO agente_programados (cliente_id, ejecutar_en, cantidad, nicho, ciudad, tipo) VALUES (?, ?, ?, ?, ?, ?)').run(req.agenteClienteId, ejecutarEn, n, String(nicho || '').trim(), String(ciudad || '').trim(), tipo === 'reenvio' ? 'reenvio' : 'primer');
    res.status(201).json({ id: r.lastInsertRowid, ejecutar_en_utc: ejecutarEn });
  });

  router.get('/programados', (req, res) => {
    res.json({ programados: db.prepare('SELECT * FROM agente_programados WHERE cliente_id = ? ORDER BY id DESC LIMIT 20').all(req.agenteClienteId) });
  });

  router.delete('/programados/:id', (req, res) => {
    const r = db.prepare("UPDATE agente_programados SET estado = 'cancelado' WHERE id = ? AND cliente_id = ? AND estado = 'pendiente'").run(req.params.id, req.agenteClienteId);
    res.status(r.changes ? 200 : 404).json({ ok: r.changes > 0 });
  });

  router.post('/probar-alertas', async (req, res) => {
    const id = req.agenteClienteId;
    const r = await avisar(id, getCfg(id), '✅ Prueba de alertas del agente CRT');
    res.status(r.ok ? 200 : 502).json(r);
  });

  return router;
}


// ==================== Monitoreo 24/7: caídas, reinicios y resumen diario ====================
function cfgActiva() {
  return db.prepare('SELECT * FROM agente_config WHERE activo = 1 AND phone_number_id IS NOT NULL LIMIT 1').get();
}

async function alertarServidor(texto) {
  try {
    const cfg = cfgActiva();
    if (cfg) await avisar(cfg.cliente_id, cfg, texto);
  } catch { /* nunca romper por una alerta */ }
}

/** Resumen del día a las 8:00 p. m. (hora Colombia), una sola vez por día. */
async function resumenDiarioSiToca() {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000); // UTC-5
  if (ahora.getUTCHours() !== 20 || ahora.getUTCMinutes() > 4) return;
  const hoy = ahora.toISOString().slice(0, 10);
  if (globalThis.__resumenEnviado === hoy) return;
  globalThis.__resumenEnviado = hoy;
  const cfg = cfgActiva();
  if (!cfg) return;
  const id = cfg.cliente_id;
  const dia = "date(%s, '-5 hours') = date('now', '-5 hours')";
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const contactados = n(`SELECT COUNT(*) n FROM agente_contactos WHERE cliente_id = ? AND ${dia.replace('%s', 'primer_contacto')}`, id);
  const mensajesCliente = n(`SELECT COUNT(*) n FROM agente_chat WHERE cliente_id = ? AND rol = 'user' AND ${dia.replace('%s', 'creado_en')}`, id);
  const hablaron = n(`SELECT COUNT(DISTINCT telefono) n FROM agente_chat WHERE cliente_id = ? AND rol = 'user' AND ${dia.replace('%s', 'creado_en')}`, id);
  const calientes = db.prepare("SELECT nombre, negocio, telefono FROM agente_contactos WHERE cliente_id = ? AND estado = 'caliente' ORDER BY actualizado_en DESC LIMIT 10").all(id);
  const sinResponder = n("SELECT COUNT(*) n FROM agente_contactos c WHERE c.cliente_id = ? AND c.modo = 'agente' AND c.estado NOT IN ('baja','perdido','cerrado','caliente') AND (SELECT rol FROM agente_chat WHERE cliente_id = c.cliente_id AND telefono = c.telefono ORDER BY id DESC LIMIT 1) = 'user'", id);
  const pend = db.prepare("SELECT tipo, ejecutar_en FROM agente_programados WHERE cliente_id = ? AND estado = 'pendiente' ORDER BY ejecutar_en LIMIT 3").all(id);
  const lineas = [
    '📊 RESUMEN DEL DÍA — Agente CRT',
    `📤 Presentaciones enviadas hoy: ${contactados}`,
    `💬 Clientes que escribieron hoy: ${hablaron} (${mensajesCliente} mensajes)`,
    '🔥 Calientes pendientes de cerrar: ' + calientes.length + calientes.map((c) => `\n   • ${c.nombre || c.telefono} — ${c.negocio || ''} wa.me/${c.telefono}`).join(''),
    sinResponder ? `⚠️ Sin responder ahora: ${sinResponder}` : '✅ Ningún cliente sin responder',
    pend.length ? `🗓 Programado: ${pend.map((p) => `${p.tipo} ${p.ejecutar_en} UTC`).join(' · ')}` : '',
  ].filter(Boolean);
  await avisar(id, cfg, lineas.join('\n'));
}

if (!globalThis.__agenteMonitor) {
  globalThis.__agenteMonitor = true;
  process.on('uncaughtException', async (e) => {
    console.error('[agente] uncaughtException', e);
    await alertarServidor(`🚨 El servidor del agente se cayó: ${String(e?.message || e).slice(0, 200)}. pm2 lo reinicia solo.`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error('[agente] unhandledRejection', e);
    alertarServidor(`⚠️ Error no controlado en el agente: ${String(e?.message || e).slice(0, 200)}`);
  });
  // Aviso de arranque/reinicio (para enterarte si el servidor se reinició solo)
  setTimeout(() => alertarServidor('ℹ️ Servidor del agente iniciado/reiniciado.'), 8000).unref?.();
}
