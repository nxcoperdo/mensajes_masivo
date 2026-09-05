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
 * Suma un mes calendario a una fecha SQL 'YYYY-MM-DD HH:MM:SS', recortando
 * el día al último válido del mes destino (31 ene -> 28/29 feb). Se usa
 * para reprogramar un recordatorio mensual (`recurrente_mensual`).
 */
export function agregarUnMes(fechaSql) {
  const fecha = new Date(`${fechaSql.replace(' ', 'T')}Z`);
  const dia = fecha.getUTCDate();
  const objetivo = new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, 1, fecha.getUTCHours(), fecha.getUTCMinutes(), fecha.getUTCSeconds())
  );
  const ultimoDiaMes = new Date(Date.UTC(objetivo.getUTCFullYear(), objetivo.getUTCMonth() + 1, 0)).getUTCDate();
  objetivo.setUTCDate(Math.min(dia, ultimoDiaMes));
  return objetivo.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Clona una campaña ya completada para el mismo día del mes siguiente —
 * mismo template/parámetros/imagen/contactos, en estado 'programada'. El
 * scheduler (scheduler.js) la recoge sola cuando llegue esa fecha. También
 * adelanta `fecha_recordatorio` de los contactos involucrados, para que su
 * ficha siempre muestre cuándo es su próximo recordatorio.
 */
function clonarParaElMesSiguiente(campana) {
  const fechaBase = campana.fecha_programada || campana.creado_en;
  if (!fechaBase) return null;
  const siguienteFecha = agregarUnMes(fechaBase);

  const result = db
    .prepare(
      `INSERT INTO campanas (template_nombre, idioma, parametros_json, imagen_media_id, encabezado_tipo, total_contactos, estado, cliente_id, fecha_programada, contacto_ids_json, recurrente_mensual)
       VALUES (?, ?, ?, ?, ?, ?, 'programada', ?, ?, ?, 1)`
    )
    .run(
      campana.template_nombre,
      campana.idioma,
      campana.parametros_json,
      campana.imagen_media_id,
      campana.encabezado_tipo,
      campana.total_contactos,
      campana.cliente_id,
      siguienteFecha,
      campana.contacto_ids_json
    );

  let contactoIds = [];
  try {
    contactoIds = JSON.parse(campana.contacto_ids_json || '[]');
  } catch {
    contactoIds = [];
  }
  if (contactoIds.length > 0) {
    const marcadores = contactoIds.map(() => '?').join(',');
    db.prepare(`UPDATE contactos SET fecha_recordatorio = ? WHERE id IN (${marcadores})`).run(siguienteFecha, ...contactoIds);
  }

  return result.lastInsertRowid;
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

  const campana = db.prepare('SELECT * FROM campanas WHERE id = ?').get(campanaId);
  if (campana?.recurrente_mensual) {
    clonarParaElMesSiguiente(campana);
  }
}
