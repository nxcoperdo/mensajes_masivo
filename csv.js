/**
 * Parser de CSV minimalista (sin dependencia externa). Soporta campos
 * entre comillas dobles con comas adentro (ej: "Pérez, Juan"), que es
 * lo único un poco delicado en un CSV de "telefono,nombre" exportado
 * desde Excel/Google Sheets.
 *
 * Devuelve un array de objetos usando la primera fila como headers,
 * con las claves en minúscula y sin espacios/acentos raros.
 */
function normalizeHeader(h) {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quita acentos: teléfono -> telefono
}

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === ';') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * @param {string} text - contenido crudo del CSV
 * @returns {Array<Object>} filas como objetos { telefono, nombre, ... }
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseLine(lines[0]).map(normalizeHeader);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}
