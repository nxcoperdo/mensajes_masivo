import zlib from 'node:zlib';

/**
 * Decodificador de PNG mínimo, sin dependencias npm.
 *
 * Existe para poder meter los logos de Code Repair Tech dentro de los
 * PDFs de facturación (ver pdf.js). Se hizo a mano en vez de sumar
 * `pdfkit`/`sharp` por la misma razón que db.js usa `node:sqlite` en vez
 * de `better-sqlite3`: este proyecto evita dependencias que compilen o
 * que compliquen el `npm install` en el VPS. Un PNG es, básicamente,
 * scanlines filtradas comprimidas con zlib — y zlib ya viene en Node.
 *
 * Soporta lo que necesitamos y nada más: 8 bits por canal, sin
 * entrelazado (los assets de `public/assets/` cumplen). Cualquier otra
 * cosa tira error en vez de devolver píxeles mal decodificados.
 */

const CANALES_POR_TIPO = {
  0: 1, // escala de grises
  2: 3, // RGB
  3: 1, // paleta (índice)
  4: 2, // gris + alfa
  6: 4, // RGBA
};

/**
 * Deshace el filtro por scanline que define la spec del PNG. Cada fila
 * viene precedida de un byte que dice con cuál de los 5 filtros se
 * codificó, y todos se resuelven contra bytes ya reconstruidos (el de la
 * izquierda, el de arriba, y el de arriba-izquierda).
 */
function desfiltrar(crudo, ancho, alto, bytesPorPixel) {
  const bytesPorFila = ancho * bytesPorPixel;
  const salida = Buffer.alloc(alto * bytesPorFila);
  let origen = 0;

  for (let y = 0; y < alto; y++) {
    const tipoFiltro = crudo[origen++];
    const filaDestino = y * bytesPorFila;
    const filaArriba = (y - 1) * bytesPorFila;

    for (let x = 0; x < bytesPorFila; x++) {
      const izquierda = x >= bytesPorPixel ? salida[filaDestino + x - bytesPorPixel] : 0;
      const arriba = y > 0 ? salida[filaArriba + x] : 0;
      const arribaIzquierda = x >= bytesPorPixel && y > 0 ? salida[filaArriba + x - bytesPorPixel] : 0;
      let valor = crudo[origen + x];

      switch (tipoFiltro) {
        case 0: // None
          break;
        case 1: // Sub
          valor += izquierda;
          break;
        case 2: // Up
          valor += arriba;
          break;
        case 3: // Average
          valor += (izquierda + arriba) >> 1;
          break;
        case 4: { // Paeth
          const estimado = izquierda + arriba - arribaIzquierda;
          const dIzq = Math.abs(estimado - izquierda);
          const dArr = Math.abs(estimado - arriba);
          const dDiag = Math.abs(estimado - arribaIzquierda);
          valor += dIzq <= dArr && dIzq <= dDiag ? izquierda : dArr <= dDiag ? arriba : arribaIzquierda;
          break;
        }
        default:
          throw new Error(`PNG con tipo de filtro desconocido (${tipoFiltro})`);
      }

      salida[filaDestino + x] = valor & 0xff;
    }
    origen += bytesPorFila;
  }

  return salida;
}

/**
 * Devuelve `{ ancho, alto, rgb, alfa }` donde `rgb` son 3 bytes por
 * píxel y `alfa` es 1 byte por píxel — o `null` si la imagen es
 * totalmente opaca (así el PDF se ahorra la máscara de transparencia,
 * que es el caso de los logos: tienen canal alfa pero todo en 255).
 */
export function decodificarPng(buffer) {
  const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(FIRMA)) {
    throw new Error('El archivo no es un PNG válido');
  }

  let ancho = 0;
  let alto = 0;
  let profundidad = 0;
  let tipoColor = 0;
  let entrelazado = 0;
  let paleta = null;
  let paletaAlfa = null;
  const trozosDatos = [];

  let cursor = 8;
  while (cursor + 8 <= buffer.length) {
    const largo = buffer.readUInt32BE(cursor);
    const tipo = buffer.toString('ascii', cursor + 4, cursor + 8);
    const datos = buffer.subarray(cursor + 8, cursor + 8 + largo);

    if (tipo === 'IHDR') {
      ancho = datos.readUInt32BE(0);
      alto = datos.readUInt32BE(4);
      profundidad = datos[8];
      tipoColor = datos[9];
      entrelazado = datos[12];
    } else if (tipo === 'PLTE') {
      paleta = Buffer.from(datos);
    } else if (tipo === 'tRNS') {
      paletaAlfa = Buffer.from(datos);
    } else if (tipo === 'IDAT') {
      trozosDatos.push(datos);
    } else if (tipo === 'IEND') {
      break;
    }

    cursor += 12 + largo; // largo(4) + tipo(4) + datos + crc(4)
  }

  if (!ancho || !alto) throw new Error('PNG sin cabecera IHDR válida');
  if (profundidad !== 8) throw new Error(`PNG con profundidad ${profundidad} bits (solo se soporta 8)`);
  if (entrelazado !== 0) throw new Error('PNG entrelazado (Adam7) no soportado');

  const canales = CANALES_POR_TIPO[tipoColor];
  if (!canales) throw new Error(`PNG con tipo de color desconocido (${tipoColor})`);
  if (tipoColor === 3 && !paleta) throw new Error('PNG con paleta pero sin trozo PLTE');

  const crudo = zlib.inflateSync(Buffer.concat(trozosDatos));
  const pixeles = desfiltrar(crudo, ancho, alto, canales);

  const totalPixeles = ancho * alto;
  const rgb = Buffer.alloc(totalPixeles * 3);
  const alfa = Buffer.alloc(totalPixeles, 255);
  let hayTransparencia = false;

  for (let i = 0; i < totalPixeles; i++) {
    const origen = i * canales;
    let r;
    let g;
    let b;
    let a = 255;

    switch (tipoColor) {
      case 0:
        r = g = b = pixeles[origen];
        break;
      case 2:
        r = pixeles[origen];
        g = pixeles[origen + 1];
        b = pixeles[origen + 2];
        break;
      case 3: {
        const indice = pixeles[origen];
        r = paleta[indice * 3];
        g = paleta[indice * 3 + 1];
        b = paleta[indice * 3 + 2];
        if (paletaAlfa && indice < paletaAlfa.length) a = paletaAlfa[indice];
        break;
      }
      case 4:
        r = g = b = pixeles[origen];
        a = pixeles[origen + 1];
        break;
      default: // 6
        r = pixeles[origen];
        g = pixeles[origen + 1];
        b = pixeles[origen + 2];
        a = pixeles[origen + 3];
        break;
    }

    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    alfa[i] = a;
    if (a !== 255) hayTransparencia = true;
  }

  return { ancho, alto, rgb, alfa: hayTransparencia ? alfa : null };
}

export default decodificarPng;
