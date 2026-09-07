import { db } from './db.js';
import { procesarCampana } from './campanas.js';

const INTERVALO_MS = 60 * 1000;

/**
 * Dispara las campañas cuya `fecha_programada` ya venció. Cada una se
 * reclama con un UPDATE condicionado a `estado = 'programada'`: si el
 * tick anterior todavía sigue mandando mensajes de esa misma campaña
 * cuando corre este (poco probable con el intervalo de 60s, pero
 * posible con muchos contactos), el UPDATE de acá no cambia ninguna
 * fila y se salta — evita mandarla dos veces.
 */
async function revisarProgramadas() {
  let vencidas;
  try {
    vencidas = db
      .prepare(`SELECT id FROM campanas WHERE estado = 'programada' AND fecha_programada <= datetime('now')`)
      .all();
  } catch (err) {
    console.error('[scheduler] error buscando campañas programadas:', err.message);
    return;
  }

  for (const { id } of vencidas) {
    const reclamada = db
      .prepare(`UPDATE campanas SET estado = 'procesando' WHERE id = ? AND estado = 'programada'`)
      .run(id);
    if (reclamada.changes === 0) continue;

    const campana = db.prepare('SELECT * FROM campanas WHERE id = ?').get(id);
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(campana.cliente_id);
    if (!cliente || !cliente.phone_number_id || !cliente.access_token) {
      console.error(`[scheduler] campaña ${id} programada pero el cliente ${campana.cliente_id} no tiene WhatsApp conectado`);
      db.prepare(`UPDATE campanas SET estado = 'completada' WHERE id = ?`).run(id);
      continue;
    }

    let contactoIds = [];
    try {
      contactoIds = JSON.parse(campana.contacto_ids_json || '[]');
    } catch {
      contactoIds = [];
    }
    if (!Array.isArray(contactoIds) || contactoIds.length === 0) {
      console.error(`[scheduler] campaña ${id} programada sin contacto_ids_json`);
      db.prepare(`UPDATE campanas SET estado = 'completada' WHERE id = ?`).run(id);
      continue;
    }

    const placeholders = contactoIds.map(() => '?').join(',');
    const contactos = db
      .prepare(`SELECT * FROM contactos WHERE id IN (${placeholders}) AND cliente_id = ?`)
      .all(...contactoIds, campana.cliente_id);

    let parametrosDef = [];
    try {
      parametrosDef = JSON.parse(campana.parametros_json || '[]');
    } catch {
      parametrosDef = [];
    }

    let flowActionData = null;
    try {
      flowActionData = campana.flow_action_data_json ? JSON.parse(campana.flow_action_data_json) : null;
    } catch {
      flowActionData = null;
    }

    try {
      await procesarCampana({
        campanaId: campana.id,
        template_nombre: campana.template_nombre,
        idioma: campana.idioma,
        parametrosDef,
        imagenMediaId: campana.imagen_media_id,
        encabezadoTipo: campana.encabezado_tipo,
        contactos,
        phoneNumberId: cliente.phone_number_id,
        accessToken: cliente.access_token,
        flowBoton: !!campana.flow_boton,
        flowActionData,
      });
    } catch (err) {
      console.error(`[scheduler] error procesando campaña ${id}:`, err.message);
    }
  }
}

/** Arranca el polling. Se llama una sola vez al iniciar el servidor. */
export function iniciarScheduler() {
  setInterval(() => {
    revisarProgramadas().catch((err) => console.error('[scheduler] error inesperado:', err.message));
  }, INTERVALO_MS);
}
