/**
 * Fechas de envío programado (individual por contacto o común de campaña).
 *
 * Todo lo que entra — columna `fecha_envio` de un CSV/Excel, el input
 * `datetime-local` del panel, una fecha ISO — pasa por acá y sale como
 * 'YYYY-MM-DD HH:MM:SS' en UTC (el mismo formato de `datetime('now')` de
 * SQLite, para poder compararlas directo en el scheduler).
 *
 * Reglas:
 *  - Con zona explícita (`...Z`, `-05:00`) se respeta.
 *  - Sin zona se interpreta en HORA DE COLOMBIA (UTC-5, sin horario de
 *    verano), no en la zona del servidor — antes dependía de en qué zona
 *    estuviera el VPS.
 *  - Con barras/guiones el orden es DÍA/MES/AÑO (como se escribe en
 *    Colombia). `05/10/2026` es el 5 de octubre, nunca el 10 de mayo.
 *  - Solo fecha, sin hora → `HORA_ENVIO_POR_DEFECTO`.
 *  - Un número es un serial de Excel (días desde 1899-12-30; el decimal es
 *    la hora) — así llega una celda con formato fecha leída "cruda".
 */

// Minutos respecto a UTC de la hora local de los envíos (Colombia = -300).
const offsetEnv = process.env.ENVIOS_TZ_OFFSET_MIN;
const OFFSET_ENVIOS_MIN = offsetEnv !== undefined && offsetEnv !== '' && Number.isFinite(Number(offsetEnv)) ? Number(offsetEnv) : -300;

export const HORA_ENVIO_POR_DEFECTO = 9; // para fechas sin hora, ej: "25/10/2026"

const RE_ISO_CON_ZONA = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i;
const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const RE_DIA_PRIMERO = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?)?$/i;
const RE_SERIAL_EXCEL = /^\d+(?:\.\d+)?$/;

// Cabeceras (ya normalizadas por `normalizeHeader`, con espacios → "_") que
// significan "fecha de envío de ESTE contacto".
const CABECERAS_FECHA_ENVIO = new Set([
  'fecha_envio', 'fecha_de_envio', 'fecha_recordatorio', 'fecha_de_recordatorio', 'recordatorio',
]);

/** `true` si la cabecera de una columna del CSV/Excel es la fecha de envío individual (acepta "Fecha de envío", "fecha_envio", etc.). */
export function esColumnaFechaEnvio(cabecera) {
  return CABECERAS_FECHA_ENVIO.has(String(cabecera).trim().toLowerCase().replace(/\s+/g, '_'));
}

function aSql(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Arma el instante UTC (ms) de una hora de pared de Colombia, validando que la fecha exista (ej: 31/02 no). */
function desdeHoraLocal(anio, mes, dia, hora, minuto, segundo) {
  if (mes < 1 || mes > 12 || dia < 1 || hora < 0 || hora > 23 || minuto < 0 || minuto > 59 || segundo < 0 || segundo > 59) return null;
  const pared = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo);
  const control = new Date(pared);
  if (control.getUTCMonth() !== mes - 1 || control.getUTCDate() !== dia) return null;
  return pared - OFFSET_ENVIOS_MIN * 60000;
}

/**
 * Analiza una fecha de envío y dice QUÉ pasó, no solo si salió bien — la
 * importación necesita distinguir "celda vacía" de "no entendí lo que
 * escribieron" para avisarle al usuario.
 *
 * @returns {{estado: 'vacia'|'ok'|'invalida', fecha: string|null}}
 */
export function analizarFechaEnvio(valor) {
  if (valor === null || valor === undefined) return { estado: 'vacia', fecha: null };

  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? { estado: 'invalida', fecha: null } : { estado: 'ok', fecha: aSql(valor.getTime()) };
  }

  const texto = String(valor).trim();
  if (!texto) return { estado: 'vacia', fecha: null };

  const ok = (ms) => (ms === null ? { estado: 'invalida', fecha: null } : { estado: 'ok', fecha: aSql(ms) });

  // Serial de Excel. Con >= 20000 (año 1954) evita confundirlo con un "2026" suelto.
  if (RE_SERIAL_EXCEL.test(texto) && Number(texto) >= 20000 && Number(texto) < 2958466) {
    let pared = Math.round((Number(texto) - 25569) * 86400) * 1000; // 25569 = días entre 1899-12-30 y 1970-01-01
    // Serial entero = celda con solo el día (sin hora) → misma hora por defecto que "25/10/2026".
    if (Number.isInteger(Number(texto))) pared += HORA_ENVIO_POR_DEFECTO * 3600000;
    return ok(pared - OFFSET_ENVIOS_MIN * 60000);
  }

  if (RE_ISO_CON_ZONA.test(texto)) {
    const ms = new Date(texto.replace(/\s+/, 'T')).getTime();
    return Number.isNaN(ms) ? { estado: 'invalida', fecha: null } : ok(ms);
  }

  let m = RE_ISO.exec(texto);
  if (m) {
    const [, anio, mes, dia, hora, minuto, segundo] = m;
    return ok(desdeHoraLocal(+anio, +mes, +dia, hora === undefined ? HORA_ENVIO_POR_DEFECTO : +hora, +(minuto || 0), +(segundo || 0)));
  }

  m = RE_DIA_PRIMERO.exec(texto);
  if (m) {
    const [, dia, mes, anioTxt, horaTxt, minuto, segundo, meridiano] = m;
    const anio = anioTxt.length === 2 ? 2000 + +anioTxt : +anioTxt;
    let hora = horaTxt === undefined ? HORA_ENVIO_POR_DEFECTO : +horaTxt;
    if (meridiano) {
      if (hora < 1 || hora > 12) return { estado: 'invalida', fecha: null };
      const pm = meridiano.toLowerCase() === 'p';
      hora = (hora % 12) + (pm ? 12 : 0);
    }
    return ok(desdeHoraLocal(anio, +mes, +dia, hora, +(minuto || 0), +(segundo || 0)));
  }

  return { estado: 'invalida', fecha: null };
}

/** Atajo: la fecha en UTC ('YYYY-MM-DD HH:MM:SS') o `null` si está vacía o no se entendió. */
export function parsearFechaEnvio(valor) {
  return analizarFechaEnvio(valor).fecha;
}
