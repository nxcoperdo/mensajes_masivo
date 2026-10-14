import { db } from './db.js';
import { sendTemplate } from './whatsapp.js';
import { normalizeHeader } from './csv.js';
import { costoPorMensaje, registrarMovimientoCreditos } from './creditos.js';
import { clienteTienePlanActivo, pesoMensaje, cuotaRestante, registrarConsumoPlan } from './planes.js';

/**
 * Resuelve los valores finales de los parámetros de plantilla para un
 * contacto puntual. Se ejecuta acá (al momento de mandar), no al crear
 * la campaña, para que una campaña programada siempre use el dato más
 * reciente del contacto (ej: si le corrigieron la fecha de la cita
 * después de armar la campaña).
 *
 * Tipos soportados en `parametrosDef`:
 *  - { tipo: 'fijo', valor }     -> el mismo valor para todos
 *  - { tipo: 'nombre' }          -> nombre del contacto
 *  - { tipo: 'variable', clave } -> contacto.variables_json[clave]
 *    (datos libres por contacto cargados vía CSV, ej: fecha_cita, hora, servicio)
 *
 * El valor viaja literal a WhatsApp: nunca se inventa uno. Si un contacto no
 * tiene el dato (sin nombre, o sin esa columna), el parámetro queda en
 * `faltantes` y el contacto se omite en vez de mandar vacío o su teléfono.
 *
 * @returns {{ valores: string[], faltantes: string[] }}
 */
export function resolverParametros(parametrosDef, contacto) {
  let variables = null;
  const faltantes = [];
  const valores = parametrosDef.map((p, idx) => {
    let valor = '';
    if (p.tipo === 'nombre') {
      valor = String(contacto.nombre || '').trim();
      if (!valor) faltantes.push(`{{${idx + 1}}} (nombre del contacto)`);
    } else if (p.tipo === 'variable') {
      if (!variables) {
        try {
          variables = JSON.parse(contacto.variables_json || '{}');
        } catch {
          variables = {};
        }
      }
      valor = String(variables[normalizeHeader(p.clave)] ?? '').trim();
      if (!valor) faltantes.push(`{{${idx + 1}}} (columna «${p.clave}»)`);
    } else {
      valor = String(p.valor || '').trim();
    }
    return valor;
  });
  return { valores, faltantes };
}

/**
 * Valida la definición de parámetros que llega del frontend. Devuelve el
 * mensaje de error (para un 400) o null si está bien.
 */
export function validarParametrosDef(parametros) {
  if (!Array.isArray(parametros)) return 'Los parámetros tienen un formato inválido';
  for (let i = 0; i < parametros.length; i += 1) {
    const p = parametros[i];
    const n = i + 1;
    if (!p || !['nombre', 'variable', 'fijo'].includes(p.tipo)) {
      return `El parámetro {{${n}}} no tiene un tipo válido. Elige nombre, columna o texto fijo.`;
    }
    if (p.tipo === 'fijo' && !String(p.valor || '').trim()) {
      return `Escribe el texto fijo del parámetro {{${n}}}.`;
    }
    if (p.tipo === 'variable' && !String(p.clave || '').trim()) {
      return `Indica la columna del archivo para el parámetro {{${n}}}.`;
    }
  }
  return null;
}

/**
 * Separa los contactos que se pueden enviar de los que se omiten porque les
 * falta el dato de algún parámetro.
 */
export function particionarPorParametros(parametrosDef, contactos) {
  const enviables = [];
  const omitidos = [];
  for (const contacto of contactos) {
    const { faltantes } = resolverParametros(parametrosDef, contacto);
    if (faltantes.length > 0) omitidos.push({ contacto, telefono: contacto.telefono, faltantes });
    else enviables.push(contacto);
  }
  return { enviables, omitidos };
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
      `INSERT INTO campanas (template_nombre, idioma, parametros_json, imagen_media_id, encabezado_tipo, total_contactos, estado, cliente_id, fecha_programada, contacto_ids_json, recurrente_mensual, flow_boton, flow_action_data_json, categoria_plantilla)
       VALUES (?, ?, ?, ?, ?, ?, 'programada', ?, ?, ?, 1, ?, ?, ?)`
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
      campana.contacto_ids_json,
      campana.flow_boton ? 1 : 0,
      campana.flow_action_data_json || null,
      campana.categoria_plantilla || null
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
  contactos: todosLosContactos,
  phoneNumberId,
  accessToken,
  flowBoton = false,
  flowActionData = null,
  clienteId = null,
  categoriaPlantilla = null,
}) {
  // Contactos a los que les falta el dato de algún parámetro no se envían
  // (ni se cobran): quedan en el historial como fallidos con el motivo, para
  // que el usuario vea exactamente quién se quedó afuera y por qué.
  const { enviables: contactos, omitidos } = particionarPorParametros(parametrosDef, todosLosContactos);
  // Chequeo defensivo de créditos justo antes de mandar — cubre el caso de
  // una campaña programada, donde pasó tiempo desde que se creó (y se validó
  // el saldo) hasta que el scheduler la dispara de verdad. Si ya no alcanza,
  // no se manda NADA (bloqueo total, no parcial) y queda 'cancelada'.
  // `categoriaPlantilla` viene null para admin/empresas gestionadas — ahí
  // este bloque entero no hace nada, cero cambio de comportamiento.
  if (categoriaPlantilla) {
    const cliente = db.prepare('SELECT creditos, plan_id FROM clientes WHERE id = ?').get(clienteId);
    if (!cliente) {
      console.error(`[campañas] campaña ${campanaId} cancelada: cliente ${clienteId} no encontrado`);
      db.prepare(`UPDATE campanas SET estado = 'cancelada' WHERE id = ?`).run(campanaId);
      return;
    }
    if (clienteTienePlanActivo(cliente)) {
      const necesarios = pesoMensaje(categoriaPlantilla) * contactos.length;
      const { mediosLibres } = cuotaRestante(clienteId);
      if (necesarios > mediosLibres) {
        console.error(`[campañas] campaña ${campanaId} cancelada: cuota de plan insuficiente (necesita ${necesarios} medios, quedan ${mediosLibres})`);
        db.prepare(`UPDATE campanas SET estado = 'cancelada' WHERE id = ?`).run(campanaId);
        return;
      }
    } else {
      const costoTotal = costoPorMensaje(categoriaPlantilla, encabezadoTipo) * contactos.length;
      if (cliente.creditos < costoTotal) {
        console.error(`[campañas] campaña ${campanaId} cancelada: créditos insuficientes (necesita ${costoTotal}, tiene ${cliente.creditos})`);
        db.prepare(`UPDATE campanas SET estado = 'cancelada' WHERE id = ?`).run(campanaId);
        return;
      }
    }
  }

  // Cómo se cobra esta campaña — se decide una sola vez, antes del loop.
  // Se descuenta mensaje a mensaje (solo los que salen OK) para que el saldo
  // baje en vivo en el header del cliente. Un envío paralelo de la misma
  // cuenta podría dejar el saldo apenas por debajo de 0 en una carrera; no se
  // corta la campaña a mitad porque ya se validó que alcanzaba antes de empezar.
  let cobro = null; // { tipo: 'plan' | 'creditos', porMensaje }
  if (categoriaPlantilla) {
    const clienteCobro = db.prepare('SELECT plan_id FROM clientes WHERE id = ?').get(clienteId);
    cobro = clienteTienePlanActivo(clienteCobro)
      ? { tipo: 'plan', porMensaje: pesoMensaje(categoriaPlantilla) }
      : { tipo: 'creditos', porMensaje: costoPorMensaje(categoriaPlantilla, encabezadoTipo) };
  }
  const motivoCobro = `Campaña "${template_nombre}" (${categoriaPlantilla})`;

  const delayMs = Number(process.env.ENVIO_DELAY_MS) || 250;
  const insertEnvio = db.prepare(`
    INSERT INTO envios (campana_id, contacto_id, telefono, nombre, estado, error, wa_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const { contacto, faltantes } of omitidos) {
    insertEnvio.run(
      campanaId,
      contacto.id,
      contacto.telefono,
      contacto.nombre || null,
      'fallido',
      `Omitido: no se envió porque este contacto no tiene el dato para el parámetro ${faltantes.join(', ')}`,
      null
    );
  }

  for (const contacto of contactos) {
    const parametrosResueltos = resolverParametros(parametrosDef, contacto).valores;

    const resultado = await sendTemplate({
      to: contacto.telefono,
      template: template_nombre,
      languageCode: idioma,
      parameters: parametrosResueltos,
      phoneNumberId,
      accessToken,
      headerMediaId: imagenMediaId,
      headerMediaTipo: encabezadoTipo,
      flowButton: !!flowBoton,
      // El teléfono vuelve en el webhook `flow` cuando el contacto
      // completa el formulario, así se sabe quién respondió.
      flowToken: flowBoton ? contacto.telefono : undefined,
      flowActionData: flowActionData || undefined,
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

    if (cobro && resultado.ok && cobro.porMensaje > 0) {
      if (cobro.tipo === 'plan') {
        registrarConsumoPlan({ clienteId, medios: cobro.porMensaje, motivo: motivoCobro, campanaId, acumular: true });
      } else {
        registrarMovimientoCreditos({ clienteId, cantidad: -cobro.porMensaje, motivo: motivoCobro, campanaId, acumular: true });
      }
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  db.prepare(`UPDATE campanas SET estado = 'completada' WHERE id = ?`).run(campanaId);

  // El saldo ya se descontó mensaje a mensaje arriba (solo los que salieron
  // OK; los fallidos no se cobran, mismo criterio que la facturación por
  // tarifa/mensaje). Acá solo se deja el resumen en la campaña para el
  // historial — sin volver a tocar el saldo.
  if (cobro) {
    const exitosos = db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado = 'enviado'`).get(campanaId).n;
    const consumido = exitosos * cobro.porMensaje;
    if (cobro.tipo === 'plan') {
      db.prepare(`UPDATE campanas SET categoria_plantilla = ?, canal_cobro = 'plan', plan_medios_consumidos = ? WHERE id = ?`).run(categoriaPlantilla, consumido, campanaId);
    } else {
      db.prepare(`UPDATE campanas SET categoria_plantilla = ?, canal_cobro = 'creditos', creditos_consumidos = ? WHERE id = ?`).run(categoriaPlantilla, consumido, campanaId);
    }
  }

  const campana = db.prepare('SELECT * FROM campanas WHERE id = ?').get(campanaId);
  if (campana?.recurrente_mensual) {
    clonarParaElMesSiguiente(campana);
  }
}
