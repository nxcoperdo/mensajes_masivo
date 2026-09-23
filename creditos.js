import { db } from './db.js';

/**
 * Sistema de créditos (prepago) para clientes independientes. Standalone
 * (sin Express) para que lo puedan importar tanto server.js como
 * campanas.js/scheduler.js sin import circular. Ver db.js para el esquema.
 */

export const CATEGORIAS_CREDITO = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

/** IVA informativo (modelo de cobro Daemon Leads, sept. 2026) — se muestra
 * en la estimación de costo al cliente, no se aplica al descuento real de
 * créditos (que sigue siendo el precio base). Ver memoria
 * `modelo-cobro-daemon-leads`. */
export const IVA_PORCENTAJE = 0.19;

/** Un cliente "independiente" pagó su cuenta sola y maneja sus propios
 * créditos — a diferencia del admin (dueño de la instalación) o una
 * "empresa gestionada" (sin login, facturada aparte). */
export function esClienteIndependiente(cliente) {
  return !cliente.es_admin && !cliente.es_empresa_gestionada;
}

/**
 * Precios reales en pesos COP (1 crédito = 1 peso). A diferencia del modelo
 * viejo, Marketing y Utility varían según el tipo de contenido del
 * encabezado — Authentication no (el modelo de cobro no le define un precio
 * propio, usa un único valor).
 */
export function obtenerConfigCreditos() {
  const fila = db
    .prepare(
      `SELECT costo_marketing_texto, costo_marketing_imagen, costo_marketing_video,
              costo_utility_texto, costo_utility_imagen, costo_utility_video,
              costo_authentication
       FROM configuracion_creditos WHERE id = 1`
    )
    .get();
  return {
    MARKETING: { TEXTO: fila.costo_marketing_texto, IMAGEN: fila.costo_marketing_imagen, VIDEO: fila.costo_marketing_video },
    UTILITY: { TEXTO: fila.costo_utility_texto, IMAGEN: fila.costo_utility_imagen, VIDEO: fila.costo_utility_video },
    AUTHENTICATION: fila.costo_authentication,
  };
}

export function guardarConfigCreditos({ MARKETING, UTILITY, AUTHENTICATION }) {
  const valores = [
    MARKETING?.TEXTO, MARKETING?.IMAGEN, MARKETING?.VIDEO,
    UTILITY?.TEXTO, UTILITY?.IMAGEN, UTILITY?.VIDEO,
    AUTHENTICATION,
  ].map(Number);
  if (valores.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error('Los costos deben ser números enteros mayores o iguales a 0');
  }
  db.prepare(
    `UPDATE configuracion_creditos SET
       costo_marketing_texto = ?, costo_marketing_imagen = ?, costo_marketing_video = ?,
       costo_utility_texto = ?, costo_utility_imagen = ?, costo_utility_video = ?,
       costo_authentication = ?
     WHERE id = 1`
  ).run(...valores);
  return obtenerConfigCreditos();
}

/** `tipoContenido` es el mismo valor que `encabezado_tipo` usa en toda la
 * base: `'image' | 'video' | null` (null/otro = texto plano). */
export function costoPorMensaje(categoria, tipoContenido) {
  const cfg = obtenerConfigCreditos();
  if (categoria === 'AUTHENTICATION') return cfg.AUTHENTICATION;
  const tipo = tipoContenido === 'video' ? 'VIDEO' : tipoContenido === 'image' ? 'IMAGEN' : 'TEXTO';
  return cfg[categoria]?.[tipo] ?? 0;
}

/**
 * Suma (o resta, con `cantidad` negativo) créditos al saldo de un cliente y
 * deja constancia en el ledger. Único punto de escritura de saldo — tanto la
 * carga manual del admin como el descuento al terminar una campaña pasan
 * por acá, para que el saldo y el ledger nunca queden desincronizados.
 */
export function registrarMovimientoCreditos({ clienteId, cantidad, motivo, campanaId = null }) {
  const cantidadEntera = Math.trunc(Number(cantidad));
  if (!cantidadEntera) return;

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE clientes SET creditos = creditos + ? WHERE id = ?').run(cantidadEntera, clienteId);
    db.prepare(
      'INSERT INTO creditos_movimientos (cliente_id, cantidad, motivo, campana_id) VALUES (?, ?, ?, ?)'
    ).run(clienteId, cantidadEntera, motivo || null, campanaId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
