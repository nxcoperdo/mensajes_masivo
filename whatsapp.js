import dotenv from 'dotenv';
dotenv.config();

/**
 * Envío de plantillas de WhatsApp vía Meta Business Cloud API.
 * Mismo patrón que `notificationService.js` de GigantYA (llamada
 * directa a graph.facebook.com), pero standalone.
 */

/**
 * Arma la config de la Cloud API. Cada cliente tiene sus propias
 * credenciales (guardadas en `clientes.phone_number_id`/
 * `clientes.access_token` tras el Embedded Signup) y el caller SIEMPRE
 * las pasa explícitas — sin fallback al .env global acá, porque eso
 * permitiría que un cliente sin WhatsApp conectado mande mensajes con
 * el número de otro cliente (el primero que haya sembrado el .env).
 */
function getConfig(phoneId, token) {
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  if (!phoneId || !token) return null;
  return { base: `https://graph.facebook.com/${apiVersion}/${phoneId}`, token };
}

export function isWhatsAppConfigured(phoneId, token) {
  return getConfig(phoneId, token) !== null;
}

/**
 * Normaliza un teléfono a E.164 sin '+' (formato que exige la Cloud
 * API). Si no trae el código de país 57 (Colombia), se lo agrega.
 */
export function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.startsWith('57') ? digits : `57${digits}`;
}

/**
 * Meta manda el motivo corto en `error.message` (ej: "Parameter format
 * does not match format in the created template") pero el detalle que
 * de verdad dice QUÉ componente/parámetro no matchea suele venir en
 * `error.error_data.details` — sin esto, errores como el 132012 quedan
 * imposibles de diagnosticar solo con el mensaje corto.
 */
function mensajeErrorMeta(data, status) {
  const base = data.error?.message || `HTTP ${status}`;
  const detalle = data.error?.error_data?.details;
  const codigo = data.error?.code;
  const partes = [base];
  if (detalle && detalle !== base) partes.push(detalle);
  if (codigo) partes.push(`(código ${codigo})`);
  return partes.join(' — ');
}

/**
 * Sube una imagen a Meta (Media API) para usarla como encabezado de
 * una plantilla. Devuelve un media_id reusable por un tiempo limitado
 * (Meta lo vence a los pocos días), así que se sube una vez por
 * campaña y se reusa ese id para todos los envíos de esa campaña.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype - ej: 'image/jpeg', 'image/png'
 * @param {string} phoneNumberId - de `clientes.phone_number_id`
 * @param {string} accessToken   - de `clientes.access_token`
 * @returns {Promise<{ok: boolean, mediaId?: string, error?: string}>}
 */
export async function subirMedia(buffer, mimetype, phoneNumberId, accessToken) {
  const config = getConfig(phoneNumberId, accessToken);
  if (!config) {
    return { ok: false, error: 'WhatsApp no configurado para este cliente (conectá tu cuenta de WhatsApp Business)' };
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimetype }), 'imagen');

  try {
    const res = await fetch(`${config.base}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: mensajeErrorMeta(data, res.status) };
    }
    return { ok: true, mediaId: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Manda una plantilla aprobada a un número.
 *
 * @param {Object} params
 * @param {string} params.to           - teléfono (se normaliza acá)
 * @param {string} params.template     - nombre exacto de la plantilla en Meta
 * @param {string} [params.languageCode]
 * @param {string[]} [params.parameters] - valores para {{1}}, {{2}}...
 * @param {string} [params.phoneNumberId] - de `clientes.phone_number_id`
 * @param {string} [params.accessToken]   - de `clientes.access_token`
 * @param {string} [params.headerMediaId] - media_id (de subirMedia) si la
 *   plantilla tiene una imagen o un video en el encabezado
 * @param {'image'|'video'} [params.headerMediaTipo] - tipo del media de
 *   encabezado (default 'image')
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function sendTemplate({ to, template, languageCode, parameters = [], phoneNumberId, accessToken, headerMediaId, headerMediaTipo }) {
  const config = getConfig(phoneNumberId, accessToken);
  if (!config) {
    return { ok: false, error: 'WhatsApp no configurado para este cliente (conectá tu cuenta de WhatsApp Business)' };
  }

  const finalTo = normalizePhone(to);
  if (!finalTo) {
    return { ok: false, error: `Teléfono inválido: "${to}"` };
  }

  const components = [];
  if (headerMediaId) {
    const tipo = headerMediaTipo === 'video' ? 'video' : 'image';
    components.push({ type: 'header', parameters: [{ type: tipo, [tipo]: { id: headerMediaId } }] });
  }
  if (parameters.length) {
    components.push({ type: 'body', parameters: parameters.map((p) => ({ type: 'text', text: String(p) })) });
  }

  const body = {
    messaging_product: 'whatsapp',
    to: finalTo,
    type: 'template',
    template: {
      name: template,
      language: { code: languageCode || process.env.WHATSAPP_LANGUAGE_CODE || 'es' },
      components,
    },
  };

  try {
    const res = await fetch(`${config.base}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: mensajeErrorMeta(data, res.status) };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Manda un mensaje de texto libre (no plantilla) para responder una
 * conversación. Meta solo permite esto dentro de la "ventana de
 * servicio al cliente" de 24hs desde el último mensaje del usuario —
 * fuera de esa ventana la API devuelve error y hay que usar plantilla.
 *
 * @param {Object} params
 * @param {string} params.to   - teléfono (se normaliza acá)
 * @param {string} params.body - texto del mensaje
 * @param {string} [params.phoneNumberId] - de `clientes.phone_number_id`
 * @param {string} [params.accessToken]   - de `clientes.access_token`
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function sendTextMessage({ to, body, phoneNumberId, accessToken }) {
  const config = getConfig(phoneNumberId, accessToken);
  if (!config) {
    return { ok: false, error: 'WhatsApp no configurado para este cliente (conectá tu cuenta de WhatsApp Business)' };
  }

  const finalTo = normalizePhone(to);
  if (!finalTo) {
    return { ok: false, error: `Teléfono inválido: "${to}"` };
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: finalTo,
    type: 'text',
    text: { body: String(body) },
  };

  try {
    const res = await fetch(`${config.base}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: mensajeErrorMeta(data, res.status) };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
