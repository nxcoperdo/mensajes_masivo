import { db } from './db.js';

/**
 * Planes mensuales (prepago con cuota fija) para clientes independientes —
 * alternativa a los créditos sueltos de `creditos.js`. Un cliente
 * independiente usa UNO de los dos caminos en un momento dado: si tiene
 * `plan_id` asignado, sus campañas descuentan de acá; si no, sigue el
 * camino de créditos (ver `esClienteIndependiente` en creditos.js). No hay
 * desborde automático de plan a crédito — si la cuota no alcanza, el
 * frontend avisa cuántos mensajes quedan y deja elegir entre "recargar" o
 * mandar solo esos (ver `btnEnviarCampana` en public/app.js).
 */

export function clienteTienePlanActivo(cliente) {
  return !!cliente?.plan_id;
}

/** Todas las categorías (Marketing, Utility, Authentication) gastan lo
 * mismo de la cuota — 1 mensaje entero cada una, sin distinción. Decisión
 * explícita del usuario (2026-09-23): "todo vale igual, si el plan incluye
 * 400 mensajes son 400 sean de utilidad o de marketing". */
export function pesoMensaje(categoria) {
  return 1;
}

export function obtenerPlanesCatalogo() {
  return db.prepare('SELECT id, nombre, mensajes_mes, precio_sin_iva, orden FROM planes_mensuales ORDER BY orden').all();
}

export function guardarPlanesCatalogo(planes) {
  if (!Array.isArray(planes) || planes.length === 0) {
    throw new Error('Envía al menos un plan');
  }
  const normalizados = planes.map((p, i) => {
    const nombre = String(p.nombre || '').trim();
    const mensajesMes = Number(p.mensajes_mes);
    const precio = Number(p.precio_sin_iva);
    if (!nombre) throw new Error('Cada plan necesita un nombre');
    if (!Number.isInteger(mensajesMes) || mensajesMes <= 0) {
      throw new Error(`"${nombre}": los mensajes/mes deben ser un entero mayor a 0`);
    }
    if (!Number.isInteger(precio) || precio < 0) {
      throw new Error(`"${nombre}": el precio debe ser un entero mayor o igual a 0`);
    }
    return { id: p.id || null, nombre, mensajesMes, precio, orden: i };
  });

  // UPDATE en vez de borrar-y-reinsertar: `clientes.plan_id` referencia
  // `planes_mensuales(id)`, así que un DELETE de un plan con clientes
  // asignados rompe la foreign key. Un plan sin `id` (nuevo, agregado desde
  // el frontend) se inserta.
  db.exec('BEGIN');
  try {
    const actualizar = db.prepare(
      'UPDATE planes_mensuales SET nombre = ?, mensajes_mes = ?, precio_sin_iva = ?, orden = ? WHERE id = ?'
    );
    const insertar = db.prepare(
      'INSERT INTO planes_mensuales (nombre, mensajes_mes, precio_sin_iva, orden) VALUES (?, ?, ?, ?)'
    );
    for (const p of normalizados) {
      if (p.id) {
        const cambiadas = actualizar.run(p.nombre, p.mensajesMes, p.precio, p.orden, p.id).changes;
        if (cambiadas === 0) insertar.run(p.nombre, p.mensajesMes, p.precio, p.orden);
      } else {
        insertar.run(p.nombre, p.mensajesMes, p.precio, p.orden);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return obtenerPlanesCatalogo();
}

/**
 * Recorta un timestamp SQL 'YYYY-MM-DD HH:MM:SS' al día-del-mes de
 * `fechaActivacionSql`, yendo hacia atrás desde `ahora` hasta encontrar el
 * inicio del ciclo de facturación vigente — espejo (dirección inversa) de
 * `agregarUnMes` en campanas.js, mismo recorte de fin de mes (31 ene activa
 * el plan -> el ciclo de febrero arranca el 28/29, no "31 de feb").
 */
export function inicioCicloActual(fechaActivacionSql, ahora = new Date()) {
  const activacion = new Date(`${fechaActivacionSql.replace(' ', 'T')}Z`);
  const diaActivacion = activacion.getUTCDate();

  let candidato = new Date(
    Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1, activacion.getUTCHours(), activacion.getUTCMinutes(), activacion.getUTCSeconds())
  );
  const ultimoDiaMesActual = new Date(Date.UTC(candidato.getUTCFullYear(), candidato.getUTCMonth() + 1, 0)).getUTCDate();
  candidato.setUTCDate(Math.min(diaActivacion, ultimoDiaMesActual));

  if (candidato > ahora) {
    // Todavía no llegó el aniversario este mes calendario — el ciclo vigente arrancó el mes anterior.
    candidato = new Date(
      Date.UTC(candidato.getUTCFullYear(), candidato.getUTCMonth() - 1, 1, activacion.getUTCHours(), activacion.getUTCMinutes(), activacion.getUTCSeconds())
    );
    const ultimoDiaMesAnterior = new Date(Date.UTC(candidato.getUTCFullYear(), candidato.getUTCMonth() + 1, 0)).getUTCDate();
    candidato.setUTCDate(Math.min(diaActivacion, ultimoDiaMesAnterior));
  }

  // Nunca antes de la activación real (cliente recién asignado este mismo mes).
  if (candidato < activacion) candidato = activacion;

  return candidato.toISOString().slice(0, 19).replace('T', ' ');
}

/** `null` si el cliente no tiene plan activo. */
export function cuotaRestante(clienteId) {
  const cliente = db.prepare('SELECT plan_id, plan_activado_en FROM clientes WHERE id = ?').get(clienteId);
  if (!cliente?.plan_id || !cliente.plan_activado_en) return null;

  const plan = db.prepare('SELECT id, nombre, mensajes_mes, precio_sin_iva FROM planes_mensuales WHERE id = ?').get(cliente.plan_id);
  if (!plan) return null;

  const inicioCiclo = inicioCicloActual(cliente.plan_activado_en);
  // "medios mensajes" quedó como unidad interna del ledger, pero como
  // pesoMensaje() ahora es siempre 1, acá 1 medio = 1 mensaje real.
  const mediosDisponibles = plan.mensajes_mes;
  const mediosUsados = db
    .prepare('SELECT COALESCE(SUM(medios_mensajes), 0) AS n FROM plan_consumos WHERE cliente_id = ? AND creado_en >= ?')
    .get(clienteId, inicioCiclo).n;

  return { plan, mediosDisponibles, mediosUsados, mediosLibres: Math.max(0, mediosDisponibles - mediosUsados) };
}

/** Cuántos contactos de esta categoría entran en lo que queda de cuota — lo
 * que el frontend necesita para avisar "te quedan N mensajes". */
export function contactosQueEntran(clienteId, categoria) {
  const cuota = cuotaRestante(clienteId);
  if (!cuota) return 0;
  return Math.floor(cuota.mediosLibres / pesoMensaje(categoria));
}

export function registrarConsumoPlan({ clienteId, medios, motivo, campanaId = null }) {
  const mediosEnteros = Math.trunc(Number(medios));
  if (!mediosEnteros) return;
  db.prepare(
    'INSERT INTO plan_consumos (cliente_id, medios_mensajes, motivo, campana_id) VALUES (?, ?, ?, ?)'
  ).run(clienteId, mediosEnteros, motivo || null, campanaId);
}
