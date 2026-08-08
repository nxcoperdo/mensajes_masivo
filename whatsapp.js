import dotenv from 'dotenv';
dotenv.config();

/**
 * Envío de plantillas de WhatsApp vía Meta Business Cloud API.
 * Mismo patrón que `notificationService.js` de GigantYA (llamada
 * directa a graph.facebook.com), pero standalone.
 */

function getConfig() {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  if (!phoneId || !token) return null;
  return { base: `https://graph.facebook.com/${apiVersion}/${phoneId}`, token };
}

export function isWhatsAppConfigured() {
  return getConfig() !== null;
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
 * Manda una plantilla aprobada a un número.
 *
 * @param {Object} params
 * @param {string} params.to           - teléfono (se normaliza acá)
 * @param {string} params.template     - nombre exacto de la plantilla en Meta
 * @param {string} [params.languageCode]
 * @param {string[]} [params.parameters] - valores para {{1}}, {{2}}...
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function sendTemplate({ to, template, languageCode, parameters = [] }) {
  const config = getConfig();
  if (!config) {
    return { ok: false, error: 'WhatsApp no configurado (faltan WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_API_TOKEN en .env)' };
  }

  const finalTo = normalizePhone(to);
  if (!finalTo) {
    return { ok: false, error: `Teléfono inválido: "${to}"` };
  }

  const body = {
    messaging_product: 'whatsapp',
    to: finalTo,
    type: 'template',
    template: {
      name: template,
      language: { code: languageCode || process.env.WHATSAPP_LANGUAGE_CODE || 'es' },
      components: parameters.length
        ? [{ type: 'body', parameters: parameters.map((p) => ({ type: 'text', text: String(p) })) }]
        : [],
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
      return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
