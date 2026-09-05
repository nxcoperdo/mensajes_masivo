import { db } from './db.js';
import { sendTemplate } from './whatsapp.js';

/**
 * Resuelve los valores finales de los parámetros de plantilla para un
 * contacto puntual. Se ejecuta acá (al momento de mandar), no al crear
 * la campaña, para que una campaña programada siempre use el dato más
 * reciente del contacto (ej: si le corrigieron la fecha de la cita
 * después de armar la campaña).
 *
 * Tipos soportados en `parametrosDef`:
 *  - { tipo: 'fijo', valor }     -> el mismo valor para todos
 *  - { tipo: 'nombre' }          -> nombre del contacto (o el teléfono si no tiene)
 *  - { tipo: 'variable', clave } -> contacto.variables_json[clave]
 *    (datos libres por contacto cargados vía CSV, ej: fecha_cita, hora, servicio)
 */
export function resolverParametros(parametrosDef, contacto) {
  let variables = null;
  return parametrosDef.map((p) => {
    if (p.tipo === 'nombre') return contacto.nombre || contacto.telefono;
    if (p.tipo === 'variable') {
      if (!variables) {
        try {
          variables = JSON.parse(contacto.variables_json || '{}');
        } catch {
          variables = {};
        }
      }
      return variables[p.clave] || '';
    }
    return p.valor || '';
  });
}

/**
 * Manda la plantilla de una campaña a cada uno de sus contactos y deja
 * constancia en `envios`. Es el único lugar que sabe mandar una campaña
 * — lo usa tanto el envío inmediato (POST /api/campanas) como el
 * scheduler (campañas con `fecha_programada`), para no duplicar esta
 * lógica entre los dos casos.
 */
export async function procesarCampana({
  campanaId,
  template_nombre,
  idioma,
  parametrosDef,
  imagenMediaId,
  encabezadoTipo,
  contactos,
  phoneNumberId,
  accessToken,
}) {
  const delayMs = Number(process.env.ENVIO_DELAY_MS) || 250;
  const insertEnvio = db.prepare(`
    INSERT INTO envios (campana_id, contacto_id, telefono, nombre, estado, error, wa_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const contacto of contactos) {
    const parametrosResueltos = resolverParametros(parametrosDef, contacto);

    const resultado = await sendTemplate({
      to: contacto.telefono,
      template: template_nombre,
      languageCode: idioma,
      parameters: parametrosResueltos,
      phoneNumberId,
      accessToken,
      headerMediaId: imagenMediaId,
      headerMediaTipo: encabezadoTipo,
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
