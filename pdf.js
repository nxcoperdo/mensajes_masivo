import zlib from 'node:zlib';
import { decodificarPng } from './png.js';

/**
 * Generador de PDF mínimo, sin dependencias npm.
 *
 * Cubre lo que necesitan las facturas y reportes de facturacion.js:
 * texto con las fuentes base de PDF (Helvetica), rectángulos con o sin
 * esquinas redondeadas, líneas, tablas paginadas e imágenes PNG.
 *
 * Se escribió a mano en vez de sumar `pdfkit` por dos razones: (1) este
 * repo evita dependencias pesadas a propósito — misma lógica por la que
 * db.js usa `node:sqlite`; (2) el `npm install` de este proyecto hoy
 * depende de un tarball servido por CDN, así que agregar paquetes es más
 * frágil de lo normal. Todo lo que se usa acá (zlib, Buffer) ya viene en
 * Node.
 *
 * Sistema de coordenadas: la API expone el origen ARRIBA a la izquierda
 * (`y` crece hacia abajo, como en CSS) porque es mucho más cómodo para
 * escribir layouts. Internamente se invierte al sistema de PDF, que
 * tiene el origen abajo a la izquierda.
 */

// ==================== CODIFICACIÓN DE TEXTO ====================
//
// Las fuentes se declaran con /WinAnsiEncoding (CP1252), que cubre todo
// el español (tildes, ñ, ¡, ¿) sin tener que embeber un archivo de
// fuente. Para los códigos 0x80–0x9F, CP1252 difiere de Latin-1 con
// comillas tipográficas y demás; el resto (0xA0–0xFF) coincide con el
// punto de código Unicode.

const UNICODE_A_WINANSI = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Convierte un string JS a bytes CP1252; lo no representable cae a '?'. */
function aWinAnsi(texto) {
  const bytes = [];
  for (const caracter of String(texto ?? '')) {
    const punto = caracter.codePointAt(0);
    if ((punto >= 32 && punto <= 126) || (punto >= 160 && punto <= 255)) {
      bytes.push(punto);
    } else if (UNICODE_A_WINANSI.has(punto)) {
      bytes.push(UNICODE_A_WINANSI.get(punto));
    } else if (punto === 9) {
      bytes.push(32);
    } else {
      bytes.push(63); // '?'
    }
  }
  return Buffer.from(bytes);
}

// ==================== MÉTRICAS DE FUENTE ====================
//
// Anchos oficiales (AFM) de las fuentes base, en milésimas de em. Sin
// esto no se puede centrar, alinear a la derecha, truncar ni justificar
// texto — el visor de PDF sabe los anchos, pero el que arma el layout
// somos nosotros.

// Códigos 32–126.
const ANCHOS_ASCII_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const ANCHOS_ASCII_NEGRITA = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Códigos 128–255 (los que no coinciden con una letra base se listan
// igual para no depender de suposiciones).
const ANCHOS_ALTOS_REGULAR = {
  128: 556, 130: 222, 131: 556, 132: 333, 133: 1000, 134: 556, 135: 556, 136: 333,
  137: 1000, 138: 667, 139: 333, 140: 1000, 142: 611, 145: 222, 146: 222, 147: 333,
  148: 333, 149: 350, 150: 556, 151: 1000, 152: 333, 153: 1000, 154: 500, 155: 333,
  156: 944, 158: 500, 159: 667, 160: 278, 161: 333, 162: 556, 163: 556, 164: 556,
  165: 556, 166: 260, 167: 556, 168: 333, 169: 737, 170: 370, 171: 556, 172: 584,
  173: 333, 174: 737, 175: 333, 176: 400, 177: 584, 178: 333, 179: 333, 180: 333,
  181: 556, 182: 537, 183: 278, 184: 333, 185: 333, 186: 365, 187: 556, 188: 834,
  189: 834, 190: 834, 191: 611, 192: 667, 193: 667, 194: 667, 195: 667, 196: 667,
  197: 667, 198: 1000, 199: 722, 200: 667, 201: 667, 202: 667, 203: 667, 204: 278,
  205: 278, 206: 278, 207: 278, 208: 722, 209: 722, 210: 778, 211: 778, 212: 778,
  213: 778, 214: 778, 215: 584, 216: 778, 217: 722, 218: 722, 219: 722, 220: 722,
  221: 667, 222: 667, 223: 611, 224: 556, 225: 556, 226: 556, 227: 556, 228: 556,
  229: 556, 230: 889, 231: 500, 232: 556, 233: 556, 234: 556, 235: 556, 236: 278,
  237: 278, 238: 278, 239: 278, 240: 556, 241: 556, 242: 556, 243: 556, 244: 556,
  245: 556, 246: 556, 247: 584, 248: 611, 249: 556, 250: 556, 251: 556, 252: 556,
  253: 500, 254: 556, 255: 500,
};

const ANCHOS_ALTOS_NEGRITA = {
  128: 556, 130: 278, 131: 556, 132: 500, 133: 1000, 134: 556, 135: 556, 136: 333,
  137: 1000, 138: 667, 139: 333, 140: 1000, 142: 611, 145: 278, 146: 278, 147: 500,
  148: 500, 149: 350, 150: 556, 151: 1000, 152: 333, 153: 1000, 154: 556, 155: 333,
  156: 944, 158: 500, 159: 667, 160: 278, 161: 333, 162: 556, 163: 556, 164: 556,
  165: 556, 166: 280, 167: 556, 168: 333, 169: 737, 170: 370, 171: 556, 172: 584,
  173: 333, 174: 737, 175: 333, 176: 400, 177: 584, 178: 333, 179: 333, 180: 333,
  181: 611, 182: 556, 183: 278, 184: 333, 185: 333, 186: 365, 187: 556, 188: 834,
  189: 834, 190: 834, 191: 611, 192: 722, 193: 722, 194: 722, 195: 722, 196: 722,
  197: 722, 198: 1000, 199: 722, 200: 667, 201: 667, 202: 667, 203: 667, 204: 278,
  205: 278, 206: 278, 207: 278, 208: 722, 209: 722, 210: 778, 211: 778, 212: 778,
  213: 778, 214: 778, 215: 584, 216: 778, 217: 722, 218: 722, 219: 722, 220: 722,
  221: 667, 222: 667, 223: 611, 224: 556, 225: 556, 226: 556, 227: 556, 228: 556,
  229: 556, 230: 889, 231: 556, 232: 556, 233: 556, 234: 556, 235: 556, 236: 278,
  237: 278, 238: 278, 239: 278, 240: 611, 241: 611, 242: 611, 243: 611, 244: 611,
  245: 611, 246: 611, 247: 584, 248: 611, 249: 611, 250: 611, 251: 611, 252: 611,
  253: 556, 254: 611, 255: 556,
};

function construirTablaAnchos(ascii, altos) {
  const tabla = new Uint16Array(256).fill(ascii[0]);
  for (let codigo = 32; codigo <= 126; codigo++) tabla[codigo] = ascii[codigo - 32];
  for (const [codigo, ancho] of Object.entries(altos)) tabla[Number(codigo)] = ancho;
  return tabla;
}

const TABLA_REGULAR = construirTablaAnchos(ANCHOS_ASCII_REGULAR, ANCHOS_ALTOS_REGULAR);
const TABLA_NEGRITA = construirTablaAnchos(ANCHOS_ASCII_NEGRITA, ANCHOS_ALTOS_NEGRITA);

/** Las fuentes base de PDF: no hay que embeber archivos, todo visor las tiene. */
export const FUENTES = {
  regular: { recurso: 'F1', base: 'Helvetica', anchos: TABLA_REGULAR },
  negrita: { recurso: 'F2', base: 'Helvetica-Bold', anchos: TABLA_NEGRITA },
  italica: { recurso: 'F3', base: 'Helvetica-Oblique', anchos: TABLA_REGULAR },
};

const ASCENSO = 0.718; // alto del ascendente de Helvetica, en em

/** Ancho de un texto en puntos, para una fuente y tamaño dados. */
export function anchoTexto(texto, fuente = 'regular', tamano = 10) {
  const tabla = (FUENTES[fuente] || FUENTES.regular).anchos;
  const bytes = aWinAnsi(texto);
  let milesimas = 0;
  for (const byte of bytes) milesimas += tabla[byte];
  return (milesimas / 1000) * tamano;
}

/** Corta con "…" al final si no entra en `maxAncho`. */
export function truncarTexto(texto, fuente, tamano, maxAncho) {
  const original = String(texto ?? '');
  if (anchoTexto(original, fuente, tamano) <= maxAncho) return original;

  const puntos = '…';
  let recortado = original;
  while (recortado.length > 1 && anchoTexto(recortado + puntos, fuente, tamano) > maxAncho) {
    recortado = recortado.slice(0, -1);
  }
  return recortado + puntos;
}

/** Parte el texto en líneas que entren en `maxAncho` (corta palabras muy largas). */
export function envolverTexto(texto, fuente, tamano, maxAncho) {
  const lineas = [];
  for (const parrafo of String(texto ?? '').split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      const tentativa = actual ? `${actual} ${palabra}` : palabra;
      if (anchoTexto(tentativa, fuente, tamano) <= maxAncho) {
        actual = tentativa;
        continue;
      }
      if (actual) lineas.push(actual);

      // Una sola palabra más ancha que la caja (una URL, por ejemplo).
      let resto = palabra;
      while (anchoTexto(resto, fuente, tamano) > maxAncho && resto.length > 1) {
        let corte = resto.length;
        while (corte > 1 && anchoTexto(resto.slice(0, corte), fuente, tamano) > maxAncho) corte--;
        lineas.push(resto.slice(0, corte));
        resto = resto.slice(corte);
      }
      actual = resto;
    }
    lineas.push(actual);
  }
  return lineas;
}

// ==================== UTILIDADES ====================

/** '#0ea5f9' o [r,g,b] 0–255 → componentes 0–1 que espera el PDF. */
function normalizarColor(color) {
  if (Array.isArray(color)) return color.map((c) => c / 255);
  const hex = String(color).replace('#', '');
  const completo = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [
    parseInt(completo.slice(0, 2), 16) / 255,
    parseInt(completo.slice(2, 4), 16) / 255,
    parseInt(completo.slice(4, 6), 16) / 255,
  ];
}

const n = (valor) => (Math.round(valor * 1000) / 1000).toString();

/** Escapa un texto ya en bytes WinAnsi como cadena literal de PDF. */
function cadenaPdf(texto) {
  const bytes = aWinAnsi(texto);
  const salida = [];
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) salida.push(0x5c); // ( ) \
    salida.push(byte);
  }
  return Buffer.concat([Buffer.from('('), Buffer.from(salida), Buffer.from(')')]);
}

// Constante de Bézier para aproximar un cuarto de círculo.
const K_CIRCULO = 0.5523;

// ==================== DOCUMENTO ====================

export class Documento {
  constructor({ ancho = 612, alto = 792 } = {}) {
    this.ancho = ancho;
    this.alto = alto;
    this.paginas = [];
    this.ops = [];
    this.imagenes = new Map(); // nombre -> { recurso, ancho, alto, rgb, alfa }
    this.nuevaPagina();
  }

  nuevaPagina() {
    this.ops = [];
    this.paginas.push(this.ops);
    return this;
  }

  get totalPaginas() {
    return this.paginas.length;
  }

  /** Convierte una `y` medida desde arriba a la `y` desde abajo del PDF. */
  _y(y) {
    return this.alto - y;
  }

  // ---------- Gráficos ----------

  rectangulo(x, y, ancho, alto, { relleno, borde, grosor = 1, radio = 0 } = {}) {
    if (!relleno && !borde) return this;
    const abajo = this._y(y + alto);
    this.ops.push('q');
    if (relleno) {
      const [r, g, b] = normalizarColor(relleno);
      this.ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
    }
    if (borde) {
      const [r, g, b] = normalizarColor(borde);
      this.ops.push(`${n(r)} ${n(g)} ${n(b)} RG`, `${n(grosor)} w`);
    }

    if (radio > 0) {
      const rad = Math.min(radio, ancho / 2, alto / 2);
      const c = rad * K_CIRCULO;
      const x0 = x;
      const x1 = x + ancho;
      const y0 = abajo;
      const y1 = abajo + alto;
      this.ops.push(
        `${n(x0 + rad)} ${n(y0)} m`,
        `${n(x1 - rad)} ${n(y0)} l`,
        `${n(x1 - rad + c)} ${n(y0)} ${n(x1)} ${n(y0 + rad - c)} ${n(x1)} ${n(y0 + rad)} c`,
        `${n(x1)} ${n(y1 - rad)} l`,
        `${n(x1)} ${n(y1 - rad + c)} ${n(x1 - rad + c)} ${n(y1)} ${n(x1 - rad)} ${n(y1)} c`,
        `${n(x0 + rad)} ${n(y1)} l`,
        `${n(x0 + rad - c)} ${n(y1)} ${n(x0)} ${n(y1 - rad + c)} ${n(x0)} ${n(y1 - rad)} c`,
        `${n(x0)} ${n(y0 + rad)} l`,
        `${n(x0)} ${n(y0 + rad - c)} ${n(x0 + rad - c)} ${n(y0)} ${n(x0 + rad)} ${n(y0)} c`,
        'h'
      );
    } else {
      this.ops.push(`${n(x)} ${n(abajo)} ${n(ancho)} ${n(alto)} re`);
    }

    this.ops.push(relleno && borde ? 'B' : relleno ? 'f' : 'S', 'Q');
    return this;
  }

  linea(x1, y1, x2, y2, { color = '#000000', grosor = 0.75 } = {}) {
    const [r, g, b] = normalizarColor(color);
    this.ops.push(
      'q',
      `${n(r)} ${n(g)} ${n(b)} RG`,
      `${n(grosor)} w`,
      `${n(x1)} ${n(this._y(y1))} m`,
      `${n(x2)} ${n(this._y(y2))} l`,
      'S',
      'Q'
    );
    return this;
  }

  // ---------- Texto ----------

  /**
   * Dibuja una línea de texto. `y` es el BORDE SUPERIOR de la línea (no
   * la línea de base), que es lo intuitivo al maquetar. Devuelve la `y`
   * justo debajo del texto.
   */
  texto(contenido, x, y, opciones = {}) {
    const {
      fuente = 'regular',
      tamano = 10,
      color = '#0f172a',
      alineacion = 'left',
      ancho = 0,
      maxAncho = 0,
      espaciado = 0,
    } = opciones;

    let texto = String(contenido ?? '');
    const limite = maxAncho || (alineacion !== 'left' ? ancho : 0);
    if (limite) texto = truncarTexto(texto, fuente, tamano, limite);
    if (!texto) return y + tamano * 1.2;

    const anchoReal = anchoTexto(texto, fuente, tamano) + espaciado * Math.max(0, texto.length - 1);
    let inicioX = x;
    if (alineacion === 'right') inicioX = x + ancho - anchoReal;
    else if (alineacion === 'center') inicioX = x + (ancho - anchoReal) / 2;

    const [r, g, b] = normalizarColor(color);
    const recurso = (FUENTES[fuente] || FUENTES.regular).recurso;
    const base = this._y(y) - tamano * ASCENSO;

    this.ops.push(
      'BT',
      `${n(r)} ${n(g)} ${n(b)} rg`,
      `/${recurso} ${n(tamano)} Tf`
    );
    if (espaciado) this.ops.push(`${n(espaciado)} Tc`);
    this.ops.push(`${n(inicioX)} ${n(base)} Td`, `${cadenaPdf(texto).toString('latin1')} Tj`);
    if (espaciado) this.ops.push('0 Tc');
    this.ops.push('ET');

    return y + tamano * 1.2;
  }

  /**
   * Texto con salto de línea automático dentro de `ancho`. Devuelve la
   * `y` debajo del último renglón.
   */
  parrafo(contenido, x, y, ancho, opciones = {}) {
    const { fuente = 'regular', tamano = 10, interlineado = 1.45, maxLineas = 0 } = opciones;
    let lineas = envolverTexto(contenido, fuente, tamano, ancho);
    if (maxLineas > 0 && lineas.length > maxLineas) {
      lineas = lineas.slice(0, maxLineas);
      lineas[maxLineas - 1] = truncarTexto(`${lineas[maxLineas - 1]}…`, fuente, tamano, ancho);
    }

    const alturaLinea = tamano * interlineado;
    let cursorY = y;
    for (const linea of lineas) {
      this.texto(linea, x, cursorY, { ...opciones, ancho, maxAncho: ancho });
      cursorY += alturaLinea;
    }
    return cursorY;
  }

  // ---------- Imágenes ----------

  /**
   * Registra un PNG bajo un nombre para poder dibujarlo. Se decodifica
   * una sola vez aunque se use en varias páginas o documentos.
   */
  registrarPng(nombre, buffer) {
    if (this.imagenes.has(nombre)) return this;
    const { ancho, alto, rgb, alfa } = decodificarPng(buffer);
    this.imagenes.set(nombre, {
      recurso: `Im${this.imagenes.size + 1}`,
      ancho,
      alto,
      rgb,
      alfa,
    });
    return this;
  }

  /** Relación alto/ancho de una imagen registrada, para escalarla sin deformar. */
  proporcionImagen(nombre) {
    const img = this.imagenes.get(nombre);
    return img ? img.alto / img.ancho : 1;
  }

  imagen(nombre, x, y, ancho, alto) {
    const img = this.imagenes.get(nombre);
    if (!img) throw new Error(`Imagen "${nombre}" no registrada`);
    const altoFinal = alto || ancho * (img.alto / img.ancho);
    this.ops.push(
      'q',
      `${n(ancho)} 0 0 ${n(altoFinal)} ${n(x)} ${n(this._y(y + altoFinal))} cm`,
      `/${img.recurso} Do`,
      'Q'
    );
    return this;
  }

  // ---------- Serialización ----------

  buffer() {
    const objetos = []; // índice 0 => objeto 1
    const reservar = () => {
      objetos.push(null);
      return objetos.length; // número de objeto
    };
    const escribir = (numero, contenido) => {
      objetos[numero - 1] = contenido;
    };

    const numCatalogo = reservar();
    const numPaginas = reservar();

    const numsFuente = {};
    for (const [clave, fuente] of Object.entries(FUENTES)) {
      const numero = reservar();
      numsFuente[clave] = numero;
      escribir(
        numero,
        Buffer.from(
          `<< /Type /Font /Subtype /Type1 /BaseFont /${fuente.base} /Encoding /WinAnsiEncoding >>`
        )
      );
    }

    // Imágenes: cada una es un XObject; si tiene transparencia se le
    // cuelga una SMask (imagen en escala de grises con el canal alfa).
    const recursosImagen = [];
    for (const img of this.imagenes.values()) {
      let refMascara = '';
      if (img.alfa) {
        const numMascara = reservar();
        const alfaComprimido = zlib.deflateSync(img.alfa, { level: 9 });
        escribir(
          numMascara,
          Buffer.concat([
            Buffer.from(
              `<< /Type /XObject /Subtype /Image /Width ${img.ancho} /Height ${img.alto} ` +
                `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
                `/Length ${alfaComprimido.length} >>\nstream\n`
            ),
            alfaComprimido,
            Buffer.from('\nendstream'),
          ])
        );
        refMascara = ` /SMask ${numMascara} 0 R`;
      }

      const numImagen = reservar();
      const rgbComprimido = zlib.deflateSync(img.rgb, { level: 9 });
      escribir(
        numImagen,
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${img.ancho} /Height ${img.alto} ` +
              `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${refMascara} ` +
              `/Length ${rgbComprimido.length} >>\nstream\n`
          ),
          rgbComprimido,
          Buffer.from('\nendstream'),
        ])
      );
      recursosImagen.push(`/${img.recurso} ${numImagen} 0 R`);
    }

    const recursos =
      `<< /Font << ${Object.entries(numsFuente)
        .map(([clave, numero]) => `/${FUENTES[clave].recurso} ${numero} 0 R`)
        .join(' ')} >>` +
      (recursosImagen.length ? ` /XObject << ${recursosImagen.join(' ')} >>` : '') +
      ' /ProcSet [/PDF /Text /ImageC /ImageB] >>';

    const numsPagina = [];
    for (const ops of this.paginas) {
      const numContenido = reservar();
      const comprimido = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'), { level: 9 });
      escribir(
        numContenido,
        Buffer.concat([
          Buffer.from(`<< /Filter /FlateDecode /Length ${comprimido.length} >>\nstream\n`),
          comprimido,
          Buffer.from('\nendstream'),
        ])
      );

      const numPagina = reservar();
      numsPagina.push(numPagina);
      escribir(
        numPagina,
        Buffer.from(
          `<< /Type /Page /Parent ${numPaginas} 0 R /MediaBox [0 0 ${n(this.ancho)} ${n(this.alto)}] ` +
            `/Resources ${recursos} /Contents ${numContenido} 0 R >>`
        )
      );
    }

    escribir(numCatalogo, Buffer.from(`<< /Type /Catalog /Pages ${numPaginas} 0 R >>`));
    escribir(
      numPaginas,
      Buffer.from(
        `<< /Type /Pages /Count ${numsPagina.length} /Kids [${numsPagina
          .map((num) => `${num} 0 R`)
          .join(' ')}] >>`
      )
    );

    const numInfo = reservar();
    const ahora = new Date();
    const dosDigitos = (valor) => String(valor).padStart(2, '0');
    const fechaPdf =
      `D:${ahora.getUTCFullYear()}${dosDigitos(ahora.getUTCMonth() + 1)}${dosDigitos(ahora.getUTCDate())}` +
      `${dosDigitos(ahora.getUTCHours())}${dosDigitos(ahora.getUTCMinutes())}${dosDigitos(ahora.getUTCSeconds())}Z`;
    escribir(
      numInfo,
      Buffer.concat([
        Buffer.from('<< /Producer '),
        cadenaPdf('Mensajes Masivos - Code Repair Tech Inc.'),
        Buffer.from(' /Creator '),
        cadenaPdf('Mensajes Masivos'),
        Buffer.from(` /CreationDate (${fechaPdf}) >>`),
      ])
    );

    // Ensamblado final: cabecera, objetos, tabla xref y trailer.
    const partes = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let desplazamiento = partes[0].length;
    const desplazamientos = [];

    objetos.forEach((contenido, indice) => {
      const numero = indice + 1;
      const cuerpo = Buffer.concat([
        Buffer.from(`${numero} 0 obj\n`),
        contenido ?? Buffer.from('<< >>'),
        Buffer.from('\nendobj\n'),
      ]);
      desplazamientos.push(desplazamiento);
      partes.push(cuerpo);
      desplazamiento += cuerpo.length;
    });

    const inicioXref = desplazamiento;
    let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const posicion of desplazamientos) {
      xref += `${String(posicion).padStart(10, '0')} 00000 n \n`;
    }
    xref +=
      `trailer\n<< /Size ${objetos.length + 1} /Root ${numCatalogo} 0 R /Info ${numInfo} 0 R >>\n` +
      `startxref\n${inicioXref}\n%%EOF\n`;
    partes.push(Buffer.from(xref, 'latin1'));

    return Buffer.concat(partes);
  }
}

export default Documento;
