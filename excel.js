import { read, utils } from 'xlsx';
import { rowsToObjects } from './csv.js';

/**
 * Parsea un archivo Excel (.xlsx/.xls) tomando la primera hoja. Misma
 * forma de salida que `parseCsv`: array de objetos { telefono, nombre, ... }.
 *
 * @param {Buffer} buffer
 * @returns {Array<Object>}
 */
export function parseExcel(buffer) {
  const workbook = read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const rows = utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  return rowsToObjects(rows);
}
