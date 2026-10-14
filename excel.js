import { read, utils } from 'xlsx';
import { rowsToObjects, normalizeHeader } from './csv.js';
import { esColumnaFechaEnvio } from './fechas.js';

/**
 * Parsea un archivo Excel (.xlsx/.xls) tomando la primera hoja. Misma
 * forma de salida que `parseCsv`: array de objetos { telefono, nombre, ... }.
 *
 * Todo se lee como texto formateado (`raw: false`) — teléfonos y variables
 * como "9:00" salen tal cual se ven en Excel. La excepción es la columna de
 * fecha de envío: una celda con formato fecha se vería como "10/25/26" (mes
 * primero, según el formato de la celda), que en Colombia se leería al revés.
 * Para esa columna se toma el valor CRUDO (el número de serie de Excel) y
 * `fechas.js` lo convierte sin ambigüedad.
 *
 * @param {Buffer} buffer
 * @returns {Array<Object>}
 */
export function parseExcel(buffer) {
  const workbook = read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const rows = utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (rows.length < 2) return rowsToObjects(rows);

  const columnasFecha = rows[0]
    .map((h, idx) => (esColumnaFechaEnvio(normalizeHeader(h)) ? idx : -1))
    .filter((idx) => idx >= 0);

  if (columnasFecha.length > 0) {
    const crudas = utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    for (let i = 1; i < rows.length; i++) {
      for (const idx of columnasFecha) {
        const valor = crudas[i]?.[idx];
        if (typeof valor === 'number') rows[i][idx] = String(valor);
      }
    }
  }

  return rowsToObjects(rows);
}
