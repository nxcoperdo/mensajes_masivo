import { systemPrompt } from './knowledge.js';

const TOOLS = [
  {
    name: 'guardar_datos',
    description: 'Guarda o actualiza lo que sabes del cliente. Úsala cada vez que aprendas algo nuevo. Envía solo los campos que conozcas.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre de la persona' },
        negocio: { type: 'string', description: 'Nombre y tipo de negocio' },
        ciudad: { type: 'string' },
        necesidad: { type: 'string', description: 'Qué quiere resolver y qué solución le sirve' },
        presupuesto: { type: 'string', description: 'Presupuesto aproximado, tal como lo dijo' },
        urgencia: { type: 'string', description: 'Para cuándo lo necesita' },
      },
    },
  },
  {
    name: 'pasar_a_nicolas',
    description: 'Pasa el cliente a Nicolás para que cierre la venta. Úsala cuando pida cotización/precio exacto, pregunte cómo pagar, quiera empezar, diga que no puede pagar todo de una (cuotas), acepte llamada o pida hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por qué está listo (ej: "pidió cotización de tienda online")' },
        resumen: { type: 'string', description: 'Resumen en 2-4 líneas: negocio, necesidad, presupuesto, urgencia, objeciones' },
        propuesta_sugerida: { type: 'string', description: 'Qué le propondrías y rango de precio sugerido' },
      },
      required: ['motivo', 'resumen'],
    },
  },
  {
    name: 'marcar_no_interesado',
    description: 'El cliente dijo que no le interesa o pidió que no le escriban más.',
    input_schema: {
      type: 'object',
      properties: { razon: { type: 'string' }, pidio_baja: { type: 'boolean' } },
    },
  },
];

/**
 * Loop de conversación con herramientas.
 * `ctx` provee: cfg, contacto(), historial (mensajes ya en formato Claude),
 * ejecutarHerramienta(nombre, input) -> string. Devuelve el texto a enviar ('' si nada).
 */
export async function generarRespuesta({ cfg, apiKey, mensajes, contacto, ejecutarHerramienta }) {
  if (!apiKey) throw new Error('Falta la API key de Anthropic (configúrala en la pestaña Agente)');
  let textoFinal = '';
  // El system prompt se fija UNA vez por respuesta: si cambiara entre vueltas (la ficha se
  // actualiza con guardar_datos), Claude rechaza los bloques de razonamiento ya generados.
  const system = systemPrompt(contacto(), cfg);
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.modelo || 'claude-sonnet-5-5',
        max_tokens: 2048,
        thinking: { type: 'between_tools' },
        system,
        tools: TOOLS,
        messages: mensajes,
      }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${res.error?.message || JSON.stringify(res)}`);

    const textos = res.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    if (textos.length) textoFinal = textos.join('\n');

    // Si hay herramientas pedidas se ejecutan SIEMPRE, aunque stop_reason sea 'end_turn'
    // (Claude a veces lo devuelve así y antes se perdía la respuesta).
    const usos = res.content.filter((b) => b.type === 'tool_use');
    if (!usos.length) {
      if (!textos.length) console.error('[agente] vuelta sin texto:', res.stop_reason, JSON.stringify(res.content).slice(0, 300));
      break;
    }

    mensajes.push({ role: 'assistant', content: res.content });
    const resultados = [];
    for (const u of usos) {
      let out;
      try {
        out = await ejecutarHerramienta(u.name, u.input || {});
      } catch (e) {
        console.error('[agente] error en herramienta', u.name, e);
        out = 'Error al ejecutar, continúa la conversación normalmente.';
      }
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: out });
    }
    mensajes.push({ role: 'user', content: resultados });
  }
  return textoFinal;
}
