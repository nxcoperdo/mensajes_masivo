import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Documento, anchoTexto, truncarTexto } from './pdf.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Facturación y estadísticas de campañas.
 *
 * ============ REGLA DE COBRO ============
 * Se cobra POR MENSAJE ENVIADO. Un mensaje cuenta como enviado (y por
 * lo tanto se factura) cuando la API de Meta lo aceptó — es decir,
 * cuando la fila de `envios` NO quedó en 'fallido'.
 *
 * 'entregado' y 'leido' son estados POSTERIORES que el webhook de Meta
 * va escalando sobre un mensaje que ya se envió (ver ESTADO_RANK en
 * server.js): no son categorías aparte, son el mismo mensaje más
 * adelante en su vida. Por eso facturar por "enviado" incluye a los
 * entregados y a los leídos, y NO depende de que el webhook esté
 * configurado ni de que el destinatario abra el chat.
 *
 * Los 'fallido' no se cobran nunca.
 */
export const ESTADOS_FACTURABLES = ['enviado', 'entregado', 'leido'];

// ==================== DATOS DEL EMISOR ====================

/** Quién emite la factura. Configurable por .env, con Code Repair Tech por defecto. */
export function datosEmisor() {
  return {
    nombre: process.env.EMPRESA_NOMBRE || 'Code Repair Tech Inc.',
    nit: process.env.EMPRESA_NIT || '',
    direccion: process.env.EMPRESA_DIRECCION || '',
    ciudad: process.env.EMPRESA_CIUDAD || '',
    email: process.env.EMPRESA_EMAIL || '',
    telefono: process.env.EMPRESA_TELEFONO || '',
    web: process.env.EMPRESA_WEB || '',
    datosPago: process.env.FACTURA_DATOS_PAGO || '',
    prefijo: process.env.FACTURA_PREFIJO || 'CRT',
  };
}

// ==================== FORMATO ====================

const ZONA_HORARIA = process.env.FACTURA_TIMEZONE || 'America/Bogota';
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * SQLite guarda las fechas con `datetime('now')`, que es UTC en formato
 * 'YYYY-MM-DD HH:MM:SS' — sin la 'T' ni la 'Z', así que `new Date()` lo
 * interpretaría como hora LOCAL y correría la fecha varias horas. Acá se
 * lo marca explícitamente como UTC antes de convertir.
 */
export function parsearFecha(texto) {
  if (!texto) return null;
  const normalizado = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(texto)
    ? `${texto.replace(' ', 'T')}Z`
    : texto;
  const fecha = new Date(normalizado);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Partes de la fecha ya en la zona horaria de facturación. */
function partesFecha(fecha) {
  const formateador = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = Object.fromEntries(formateador.formatToParts(fecha).map((p) => [p.type, p.value]));
  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: partes.hour,
    minuto: partes.minute,
  };
}

export function fechaCorta(valor) {
  const fecha = valor instanceof Date ? valor : parsearFecha(valor);
  if (!fecha) return '—';
  const { anio, mes, dia } = partesFecha(fecha);
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio}`;
}

export function fechaConHora(valor) {
  const fecha = valor instanceof Date ? valor : parsearFecha(valor);
  if (!fecha) return '—';
  const { anio, mes, dia, hora, minuto } = partesFecha(fecha);
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio} ${hora}:${minuto}`;
}

export function fechaLarga(valor) {
  const fecha = valor instanceof Date ? valor : parsearFecha(valor);
  if (!fecha) return '—';
  const { anio, mes, dia } = partesFecha(fecha);
  return `${dia} de ${MESES[mes - 1]} de ${anio}`;
}

/** Monedas que en la práctica no se escriben con decimales. */
const MONEDAS_SIN_DECIMALES = new Set(['COP', 'CLP', 'PYG', 'JPY', 'KRW', 'ARS', 'VES']);

function separarMiles(entero) {
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function formatearNumero(valor) {
  return separarMiles(String(Math.round(Number(valor) || 0)));
}

/** Formato es-CO: punto para miles, coma para decimales. */
export function formatearMoneda(valor, moneda = 'COP', { conCodigo = true } = {}) {
  const numero = Number(valor) || 0;
  const decimales = MONEDAS_SIN_DECIMALES.has(moneda) ? 0 : 2;
  const fijo = Math.abs(numero).toFixed(decimales);
  const [entero, decimal] = fijo.split('.');
  const cuerpo = separarMiles(entero) + (decimal ? `,${decimal}` : '');
  return `${numero < 0 ? '-' : ''}$ ${cuerpo}${conCodigo ? ` ${moneda}` : ''}`;
}

/**
 * La tarifa unitaria puede ser un valor chico y fraccionado (ej: 38,75
 * COP por mensaje), así que acá sí se muestran decimales aunque la
 * moneda normalmente no los use.
 */
export function formatearTarifa(valor, moneda = 'COP') {
  const numero = Number(valor) || 0;
  const decimales = Number.isInteger(numero) ? (MONEDAS_SIN_DECIMALES.has(moneda) ? 0 : 2) : 2;
  const [entero, decimal] = numero.toFixed(decimales).split('.');
  return `$ ${separarMiles(entero)}${decimal ? `,${decimal}` : ''} ${moneda}`;
}

function porcentaje(parte, total) {
  if (!total) return 0;
  return (parte / total) * 100;
}

export function formatearPorcentaje(parte, total) {
  if (!total) return '—';
  return `${porcentaje(parte, total).toFixed(1).replace('.', ',')}%`;
}

// ==================== CÁLCULO ====================

/**
 * Arma el resumen facturable de un conjunto de campañas.
 *
 * `campanas` viene de la consulta de server.js con los conteos por
 * estado ya agregados. Devuelve el detalle por campaña más los totales,
 * con `mensajes_facturables` = enviados (excluye fallidos).
 */
export function calcularResumen({ campanas, tarifa = 0, ivaPorcentaje = 0, moneda = 'COP' }) {
  const detalle = campanas.map((campana) => {
    const enviados = Number(campana.enviados) || 0;
    return {
      campana_id: campana.id,
      template_nombre: campana.template_nombre,
      idioma: campana.idioma,
      creado_en: campana.creado_en,
      estado: campana.estado,
      total_contactos: Number(campana.total_contactos) || 0,
      enviados,
      entregados: Number(campana.entregados) || 0,
      leidos: Number(campana.leidos) || 0,
      fallidos: Number(campana.fallidos) || 0,
      mensajes_facturables: enviados,
      importe: redondear(enviados * tarifa),
    };
  });

  const totales = detalle.reduce(
    (acumulado, fila) => ({
      campanas: acumulado.campanas + 1,
      contactos: acumulado.contactos + fila.total_contactos,
      enviados: acumulado.enviados + fila.enviados,
      entregados: acumulado.entregados + fila.entregados,
      leidos: acumulado.leidos + fila.leidos,
      fallidos: acumulado.fallidos + fila.fallidos,
    }),
    { campanas: 0, contactos: 0, enviados: 0, entregados: 0, leidos: 0, fallidos: 0 }
  );

  const mensajesFacturables = totales.enviados;
  const subtotal = redondear(mensajesFacturables * tarifa);
  const ivaMonto = redondear(subtotal * (ivaPorcentaje / 100));

  const fechas = detalle.map((fila) => parsearFecha(fila.creado_en)).filter(Boolean);
  const desde = fechas.length ? new Date(Math.min(...fechas.map((f) => f.getTime()))) : null;
  const hasta = fechas.length ? new Date(Math.max(...fechas.map((f) => f.getTime()))) : null;

  return {
    detalle,
    totales: {
      ...totales,
      intentos: totales.enviados + totales.fallidos,
      mensajes_facturables: mensajesFacturables,
      tasa_entrega: porcentaje(totales.entregados, totales.enviados),
      tasa_lectura: porcentaje(totales.leidos, totales.enviados),
      tasa_fallo: porcentaje(totales.fallidos, totales.enviados + totales.fallidos),
    },
    moneda,
    tarifa,
    iva_porcentaje: ivaPorcentaje,
    subtotal,
    iva_monto: ivaMonto,
    total: redondear(subtotal + ivaMonto),
    periodo_desde: desde ? desde.toISOString() : null,
    periodo_hasta: hasta ? hasta.toISOString() : null,
  };
}

/** Redondea a 2 decimales evitando la basura binaria de los float. */
function redondear(valor) {
  return Math.round((Number(valor) || 0) * 100) / 100;
}

/**
 * Estimación de costo para mandarle una campaña a `totalContactos`, usando
 * la misma tarifa/IVA que ya se configura por cliente (Historial →
 * Tarifa). No depende de campañas/envíos reales — es una proyección de
 * ANTES de mandar, no un reemplazo de `calcularResumen` (que factura lo
 * que ya se envió de verdad).
 */
export function calcularCotizacion({ totalContactos, tarifa = 0, ivaPorcentaje = 0, moneda = 'COP' }) {
  const subtotal = redondear(totalContactos * tarifa);
  const ivaMonto = redondear(subtotal * (ivaPorcentaje / 100));
  return {
    total_contactos: totalContactos,
    moneda,
    tarifa,
    iva_porcentaje: ivaPorcentaje,
    subtotal,
    iva_monto: ivaMonto,
    total: redondear(subtotal + ivaMonto),
  };
}

// ==================== PALETA Y BLOQUES DE PDF ====================
//
// Los colores replican los design tokens de public/style.css para que
// los PDFs se vean como la app.

const COLOR = {
  negro: '#030303', // fondo exacto del PNG del logo — hace invisible el borde de la imagen
  tinta: '#0f172a',
  suave: '#64748b',
  tenue: '#94a3b8',
  borde: '#e2e8f0',
  fondo: '#f6f8fa',
  fondo2: '#eef2f7',
  azul: '#0ea5f9',
  azulOscuro: '#0369a1',
  verde: '#16a34a',
  verdeFondo: '#dcfce7',
  rojo: '#dc2626',
  rojoFondo: '#fee2e2',
  ambar: '#b45309',
  blanco: '#ffffff',
};

const MARGEN = 44;
const ANCHO_PAGINA = 612;
const ALTO_PAGINA = 792;
const ANCHO_UTIL = ANCHO_PAGINA - MARGEN * 2;

let logoCache;
function logoLockup() {
  if (logoCache === undefined) {
    try {
      logoCache = fs.readFileSync(path.join(__dirname, 'public', 'assets', 'code-repair-tech-lockup.png'));
    } catch {
      logoCache = null; // sin logo el PDF igual sale, solo con el nombre en texto
    }
  }
  return logoCache;
}

function crearDocumento() {
  const doc = new Documento({ ancho: ANCHO_PAGINA, alto: ALTO_PAGINA });
  const logo = logoLockup();
  if (logo) doc.registrarPng('lockup', logo);
  return doc;
}

/**
 * Banda superior negra con el logo. El fondo se pinta con el mismo negro
 * que tiene el PNG del logo, así la imagen se funde con la banda y no se
 * ve el rectángulo.
 */
function cabecera(doc, { titulo, subtitulo, lineasDerecha = [] }) {
  const alto = 104;
  doc.rectangulo(0, 0, ANCHO_PAGINA, alto, { relleno: COLOR.negro });
  doc.rectangulo(0, alto, ANCHO_PAGINA, 3, { relleno: COLOR.azul });

  if (doc.imagenes.has('lockup')) {
    const anchoLogo = 178;
    doc.imagen('lockup', MARGEN, 24, anchoLogo, anchoLogo * doc.proporcionImagen('lockup'));
  } else {
    doc.texto('Code Repair Tech Inc.', MARGEN, 40, { fuente: 'negrita', tamano: 16, color: COLOR.blanco });
  }

  const anchoDerecha = 260;
  const xDerecha = ANCHO_PAGINA - MARGEN - anchoDerecha;
  doc.texto(titulo, xDerecha, 26, {
    fuente: 'negrita',
    tamano: 17,
    color: COLOR.blanco,
    alineacion: 'right',
    ancho: anchoDerecha,
    espaciado: 0.6,
  });
  if (subtitulo) {
    doc.texto(subtitulo, xDerecha, 48, {
      tamano: 9,
      color: COLOR.azul,
      alineacion: 'right',
      ancho: anchoDerecha,
      espaciado: 1.1,
    });
  }

  let y = 64;
  for (const linea of lineasDerecha) {
    doc.texto(linea, xDerecha, y, {
      tamano: 8.5,
      color: COLOR.tenue,
      alineacion: 'right',
      ancho: anchoDerecha,
    });
    y += 12;
  }

  return alto + 3;
}

function pie(doc, numeroPagina, textoIzquierda) {
  const y = ALTO_PAGINA - 42;
  doc.linea(MARGEN, y, ANCHO_PAGINA - MARGEN, y, { color: COLOR.borde });
  doc.texto(textoIzquierda, MARGEN, y + 10, { tamano: 7.5, color: COLOR.tenue, maxAncho: ANCHO_UTIL - 90 });
  doc.texto(`Página ${numeroPagina}`, MARGEN, y + 10, {
    tamano: 7.5,
    color: COLOR.tenue,
    alineacion: 'right',
    ancho: ANCHO_UTIL,
  });
}

/** Rótulo chico en mayúsculas espaciadas, el patrón visual del logo. */
function rotulo(doc, texto, x, y, opciones = {}) {
  return doc.texto(String(texto).toUpperCase(), x, y, {
    fuente: 'negrita',
    tamano: 7.5,
    color: COLOR.suave,
    espaciado: 0.9,
    ...opciones,
  });
}

/**
 * Tarjeta de indicador: número grande arriba y etiqueta abajo. Es el
 * bloque que hace que el reporte se lea de un vistazo.
 */
function tarjetaIndicador(doc, x, y, ancho, alto, { etiqueta, valor, detalle, acento = COLOR.azul, destacada = false }) {
  doc.rectangulo(x, y, ancho, alto, {
    relleno: destacada ? COLOR.negro : COLOR.fondo,
    borde: destacada ? null : COLOR.borde,
    radio: 8,
  });
  doc.rectangulo(x, y, 3.5, alto, { relleno: acento, radio: 1.75 });

  rotulo(doc, etiqueta, x + 12, y + 11, {
    color: destacada ? COLOR.tenue : COLOR.suave,
    maxAncho: ancho - 20,
  });

  const tamanoValor = anchoTexto(valor, 'negrita', 17) > ancho - 24 ? 13 : 17;
  doc.texto(valor, x + 12, y + 25, {
    fuente: 'negrita',
    tamano: tamanoValor,
    color: destacada ? COLOR.blanco : COLOR.tinta,
    maxAncho: ancho - 20,
  });

  if (detalle) {
    doc.texto(detalle, x + 12, y + alto - 17, {
      tamano: 7.5,
      color: destacada ? COLOR.tenue : COLOR.suave,
      maxAncho: ancho - 20,
    });
  }
}

/**
 * Dibuja una tabla con encabezado oscuro, filas alternadas y salto de
 * página automático. `columnas` = [{ titulo, clave, ancho, alineacion,
 * fuente, color }]. Devuelve la `y` debajo de la tabla.
 */
function tabla(doc, { x, y, columnas, filas, alSaltarPagina, altoFila = 20, sinFilas = 'Sin datos' }) {
  const limiteInferior = ALTO_PAGINA - 62;
  let cursorY = y;

  const dibujarEncabezado = () => {
    doc.rectangulo(x, cursorY, ANCHO_UTIL, 22, { relleno: COLOR.negro, radio: 4 });
    let cursorX = x;
    for (const columna of columnas) {
      doc.texto(String(columna.titulo).toUpperCase(), cursorX + 8, cursorY + 7, {
        fuente: 'negrita',
        tamano: 7.5,
        color: COLOR.blanco,
        espaciado: 0.5,
        alineacion: columna.alineacion || 'left',
        ancho: columna.ancho - 16,
        maxAncho: columna.ancho - 16,
      });
      cursorX += columna.ancho;
    }
    cursorY += 22;
  };

  dibujarEncabezado();

  if (filas.length === 0) {
    doc.rectangulo(x, cursorY, ANCHO_UTIL, altoFila + 6, { relleno: COLOR.fondo, borde: COLOR.borde });
    doc.texto(sinFilas, x, cursorY + 9, {
      tamano: 9,
      color: COLOR.suave,
      alineacion: 'center',
      ancho: ANCHO_UTIL,
    });
    return cursorY + altoFila + 6;
  }

  filas.forEach((fila, indice) => {
    if (cursorY + altoFila > limiteInferior) {
      if (alSaltarPagina) cursorY = alSaltarPagina();
      dibujarEncabezado();
    }

    if (indice % 2 === 1) {
      doc.rectangulo(x, cursorY, ANCHO_UTIL, altoFila, { relleno: COLOR.fondo });
    }
    doc.linea(x, cursorY + altoFila, x + ANCHO_UTIL, cursorY + altoFila, { color: COLOR.borde, grosor: 0.5 });

    let cursorX = x;
    for (const columna of columnas) {
      const celda = fila[columna.clave];
      const valor = celda && typeof celda === 'object' ? celda.texto : celda;
      const color = (celda && typeof celda === 'object' && celda.color) || columna.color || COLOR.tinta;
      const fuente = (celda && typeof celda === 'object' && celda.fuente) || columna.fuente || 'regular';
      doc.texto(valor ?? '—', cursorX + 8, cursorY + (altoFila - 9) / 2, {
        tamano: 8.5,
        fuente,
        color,
        alineacion: columna.alineacion || 'left',
        ancho: columna.ancho - 16,
        maxAncho: columna.ancho - 16,
      });
      cursorX += columna.ancho;
    }
    cursorY += altoFila;
  });

  return cursorY;
}

// ==================== PDF: FACTURA ====================

/**
 * Factura de venta lista para mandar al cliente. Recibe la fila de
 * `facturas` ya guardada (con su detalle congelado) para que el PDF sea
 * reproducible: regenerarlo un año después da exactamente lo mismo.
 */
export function generarFacturaPdf({ factura, detalle, datosCliente, emisor = datosEmisor() }) {
  const doc = crearDocumento();
  const moneda = factura.moneda || 'COP';
  const piePagina = `${emisor.nombre}  ·  Factura ${factura.numero}  ·  Generada el ${fechaConHora(new Date())}`;

  const ESTADO_ETIQUETA = { emitida: 'EMITIDA', pagada: 'PAGADA', anulada: 'ANULADA' };
  const ESTADO_COLOR = {
    emitida: { fondo: COLOR.fondo2, texto: COLOR.azulOscuro },
    pagada: { fondo: COLOR.verdeFondo, texto: COLOR.verde },
    anulada: { fondo: COLOR.rojoFondo, texto: COLOR.rojo },
  };

  const nuevaPaginaContinuacion = () => {
    pie(doc, doc.totalPaginas, piePagina);
    doc.nuevaPagina();
    const alto = cabecera(doc, {
      titulo: 'FACTURA DE VENTA',
      subtitulo: `${factura.numero} · continuación`,
    });
    return alto + 24;
  };

  let y = cabecera(doc, {
    titulo: 'FACTURA DE VENTA',
    subtitulo: factura.numero,
    lineasDerecha: [
      `Fecha de emisión: ${fechaLarga(factura.creado_en)}`,
      factura.periodo_desde && factura.periodo_hasta
        ? `Período facturado: ${fechaCorta(factura.periodo_desde)} – ${fechaCorta(factura.periodo_hasta)}`
        : null,
    ].filter(Boolean),
  });

  y += 22;

  // ---- Emisor / cliente, en dos columnas ----
  const anchoColumna = (ANCHO_UTIL - 16) / 2;
  const yBloques = y;

  const lineasEmisor = [
    emisor.nombre,
    emisor.nit ? `NIT ${emisor.nit}` : null,
    emisor.direccion || null,
    emisor.ciudad || null,
    emisor.telefono ? `Tel. ${emisor.telefono}` : null,
    emisor.email || null,
    emisor.web || null,
  ].filter(Boolean);

  const lineasCliente = [
    datosCliente.nombre_negocio || datosCliente.email || 'Cliente',
    datosCliente.nit ? `NIT ${datosCliente.nit}` : null,
    datosCliente.direccion_fiscal || null,
    datosCliente.ciudad || null,
    datosCliente.telefono_contacto ? `Tel. ${datosCliente.telefono_contacto}` : null,
    datosCliente.email || null,
  ].filter(Boolean);

  const altoBloque = 22 + Math.max(lineasEmisor.length, lineasCliente.length) * 12 + 12;

  const dibujarBloque = (x, titulo, lineas) => {
    doc.rectangulo(x, yBloques, anchoColumna, altoBloque, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
    rotulo(doc, titulo, x + 12, yBloques + 11);
    let cursor = yBloques + 26;
    lineas.forEach((linea, indice) => {
      doc.texto(linea, x + 12, cursor, {
        fuente: indice === 0 ? 'negrita' : 'regular',
        tamano: indice === 0 ? 10 : 8.5,
        color: indice === 0 ? COLOR.tinta : COLOR.suave,
        maxAncho: anchoColumna - 24,
      });
      cursor += indice === 0 ? 14 : 12;
    });
  };

  dibujarBloque(MARGEN, 'Emisor', lineasEmisor);
  dibujarBloque(MARGEN + anchoColumna + 16, 'Facturar a', lineasCliente);
  y = yBloques + altoBloque + 18;

  // ---- Sello de estado (solo si no es una factura vigente común) ----
  if (factura.estado !== 'emitida') {
    const paleta = ESTADO_COLOR[factura.estado] || ESTADO_COLOR.emitida;
    const etiqueta = ESTADO_ETIQUETA[factura.estado] || factura.estado.toUpperCase();
    const anchoSello = anchoTexto(etiqueta, 'negrita', 10) + 26;
    doc.rectangulo(ANCHO_PAGINA - MARGEN - anchoSello, y, anchoSello, 22, {
      relleno: paleta.fondo,
      borde: paleta.texto,
      radio: 11,
    });
    doc.texto(etiqueta, ANCHO_PAGINA - MARGEN - anchoSello, y + 6, {
      fuente: 'negrita',
      tamano: 10,
      color: paleta.texto,
      alineacion: 'center',
      ancho: anchoSello,
      espaciado: 0.8,
    });
    y += 32;
  }

  // ---- Concepto ----
  rotulo(doc, 'Detalle de la facturación', MARGEN, y);
  y += 16;

  // Anchos calculados para que ningún encabezado se corte: ver
  // anchoTexto() — "MSJ. ENVIADOS" en negrita 7.5 con espaciado pide ~81pt
  // más los 16pt de padding de celda.
  const anchos = [40, 168, 70, 86, 76, ANCHO_UTIL - 40 - 168 - 70 - 86 - 76];
  const columnas = [
    { titulo: '#', clave: 'id', ancho: anchos[0], fuente: 'negrita' },
    { titulo: 'Campaña (plantilla)', clave: 'plantilla', ancho: anchos[1] },
    { titulo: 'Fecha', clave: 'fecha', ancho: anchos[2] },
    { titulo: 'Msj. enviados', clave: 'enviados', ancho: anchos[3], alineacion: 'right', fuente: 'negrita' },
    { titulo: 'Valor unit.', clave: 'unitario', ancho: anchos[4], alineacion: 'right' },
    { titulo: 'Importe', clave: 'importe', ancho: anchos[5], alineacion: 'right', fuente: 'negrita' },
  ];

  const filas = detalle.map((linea) => ({
    id: String(linea.campana_id),
    plantilla: linea.template_nombre,
    fecha: fechaCorta(linea.creado_en),
    enviados: formatearNumero(linea.mensajes_facturables),
    unitario: formatearTarifa(factura.tarifa_unitaria, moneda).replace(` ${moneda}`, ''),
    importe: formatearMoneda(linea.importe, moneda, { conCodigo: false }),
  }));

  y = tabla(doc, {
    x: MARGEN,
    y,
    columnas,
    filas,
    alSaltarPagina: nuevaPaginaContinuacion,
    sinFilas: 'La factura no tiene campañas asociadas.',
  });

  y += 18;

  // ---- Totales ----
  const anchoTotales = 250;
  const xTotales = ANCHO_PAGINA - MARGEN - anchoTotales;

  if (y + 130 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();

  const filasTotales = [
    ['Mensajes enviados facturados', formatearNumero(factura.total_mensajes)],
    ['Valor por mensaje', formatearTarifa(factura.tarifa_unitaria, moneda)],
    ['Subtotal', formatearMoneda(factura.subtotal, moneda)],
  ];
  if (Number(factura.iva_porcentaje) > 0) {
    filasTotales.push([`IVA (${String(factura.iva_porcentaje).replace('.', ',')}%)`, formatearMoneda(factura.iva_monto, moneda)]);
  }

  let yTotal = y;
  for (const [etiqueta, valor] of filasTotales) {
    doc.texto(etiqueta, xTotales, yTotal + 4, { tamano: 9, color: COLOR.suave });
    doc.texto(valor, xTotales, yTotal + 4, {
      tamano: 9,
      fuente: 'negrita',
      color: COLOR.tinta,
      alineacion: 'right',
      ancho: anchoTotales,
    });
    yTotal += 18;
    doc.linea(xTotales, yTotal, xTotales + anchoTotales, yTotal, { color: COLOR.borde, grosor: 0.5 });
  }

  yTotal += 6;
  doc.rectangulo(xTotales, yTotal, anchoTotales, 40, { relleno: COLOR.negro, radio: 8 });
  doc.rectangulo(xTotales, yTotal, 3.5, 40, { relleno: COLOR.azul, radio: 1.75 });
  rotulo(doc, 'Total a pagar', xTotales + 14, yTotal + 9, { color: COLOR.tenue });
  doc.texto(formatearMoneda(factura.total, moneda), xTotales + 14, yTotal + 21, {
    fuente: 'negrita',
    tamano: 15,
    color: COLOR.blanco,
    alineacion: 'right',
    ancho: anchoTotales - 28,
  });

  // ---- Nota de la regla de cobro, a la izquierda de los totales ----
  const anchoNota = ANCHO_UTIL - anchoTotales - 20;
  doc.rectangulo(MARGEN, y, anchoNota, 84, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
  rotulo(doc, 'Cómo se calcula', MARGEN + 12, y + 11);
  doc.parrafo(
    'Se factura únicamente por MENSAJE ENVIADO, es decir, cada mensaje que la ' +
      'plataforma de WhatsApp Business aceptó y despachó. Los mensajes fallidos ' +
      'no se cobran. Los estados "entregado" y "leído" son informativos y no ' +
      'modifican el valor facturado.',
    MARGEN + 12,
    y + 26,
    anchoNota - 24,
    { tamano: 7.8, color: COLOR.suave, interlineado: 1.42 }
  );

  y = Math.max(yTotal + 40, y + 84) + 20;

  // ---- Pago y notas ----
  if (emisor.datosPago || factura.notas) {
    if (y + 70 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();
    if (emisor.datosPago) {
      rotulo(doc, 'Forma de pago', MARGEN, y);
      y = doc.parrafo(emisor.datosPago, MARGEN, y + 14, ANCHO_UTIL, { tamano: 8.5, color: COLOR.tinta }) + 10;
    }
    if (factura.notas) {
      rotulo(doc, 'Observaciones', MARGEN, y);
      y = doc.parrafo(factura.notas, MARGEN, y + 14, ANCHO_UTIL, { tamano: 8.5, color: COLOR.tinta }) + 10;
    }
  }

  pie(doc, doc.totalPaginas, piePagina);
  return doc.buffer();
}

// ==================== PDF: REPORTE DE ESTADÍSTICAS ====================

/** Barra horizontal con etiqueta, valor y porcentaje — el "gráfico" del reporte. */
function barra(doc, x, y, ancho, { etiqueta, valor, total, color, nota }) {
  const proporcion = total > 0 ? Math.min(1, valor / total) : 0;
  const anchoEtiqueta = 118;
  const anchoValor = 96;
  const anchoPista = ancho - anchoEtiqueta - anchoValor - 16;

  doc.texto(etiqueta, x, y + 1, { tamano: 8.5, fuente: 'negrita', color: COLOR.tinta, maxAncho: anchoEtiqueta - 8 });

  const xPista = x + anchoEtiqueta;
  doc.rectangulo(xPista, y, anchoPista, 11, { relleno: COLOR.fondo2, radio: 5.5 });
  if (proporcion > 0) {
    doc.rectangulo(xPista, y, Math.max(4, anchoPista * proporcion), 11, { relleno: color, radio: 5.5 });
  }

  doc.texto(
    `${formatearNumero(valor)}${total > 0 ? `  (${formatearPorcentaje(valor, total)})` : ''}`,
    xPista + anchoPista + 12,
    y + 1,
    { tamano: 8.5, color: COLOR.tinta, alineacion: 'right', ancho: anchoValor }
  );

  if (nota) {
    doc.texto(nota, x, y + 14, { tamano: 7, color: COLOR.tenue, maxAncho: ancho });
    return y + 30;
  }
  return y + 22;
}

/**
 * Reporte de estadísticas de las campañas seleccionadas. Es el
 * documento de respaldo de la factura: mismos números, más el desglose
 * de entrega/lectura/fallos que la factura no necesita mostrar.
 */
export function generarReportePdf({ resumen, cliente, emisor = datosEmisor(), generadoEn = new Date() }) {
  const doc = crearDocumento();
  const { totales, detalle, moneda } = resumen;
  const piePagina = `${emisor.nombre}  ·  Reporte de campañas de ${cliente.nombre_negocio || cliente.email}  ·  ${fechaConHora(generadoEn)}`;

  const nuevaPaginaContinuacion = () => {
    pie(doc, doc.totalPaginas, piePagina);
    doc.nuevaPagina();
    const alto = cabecera(doc, { titulo: 'REPORTE DE CAMPAÑAS', subtitulo: 'continuación' });
    return alto + 24;
  };

  let y = cabecera(doc, {
    titulo: 'REPORTE DE CAMPAÑAS',
    subtitulo: 'ESTADÍSTICAS Y FACTURACIÓN',
    lineasDerecha: [
      `Cliente: ${cliente.nombre_negocio || cliente.email}`,
      resumen.periodo_desde && resumen.periodo_hasta
        ? `Período: ${fechaCorta(resumen.periodo_desde)} – ${fechaCorta(resumen.periodo_hasta)}`
        : null,
      `Generado el ${fechaConHora(generadoEn)}`,
    ].filter(Boolean),
  });

  y += 22;

  // ---- Indicadores principales ----
  rotulo(doc, 'Resumen del período', MARGEN, y);
  y += 16;

  const separacion = 10;
  const anchoTarjeta = (ANCHO_UTIL - separacion * 3) / 4;
  const altoTarjeta = 58;

  const tarjetas = [
    {
      etiqueta: 'Campañas',
      valor: formatearNumero(totales.campanas),
      detalle: `${formatearNumero(totales.contactos)} contactos apuntados`,
      acento: COLOR.tenue,
    },
    {
      etiqueta: 'Mensajes enviados',
      valor: formatearNumero(totales.mensajes_facturables),
      detalle: 'Base de facturación',
      acento: COLOR.azul,
    },
    {
      etiqueta: 'Fallidos',
      valor: formatearNumero(totales.fallidos),
      detalle: 'No se facturan',
      acento: COLOR.rojo,
    },
    {
      etiqueta: 'Total a facturar',
      valor: formatearMoneda(resumen.total, moneda, { conCodigo: false }),
      detalle: `${formatearTarifa(resumen.tarifa, moneda)} por mensaje`,
      acento: COLOR.azul,
      destacada: true,
    },
  ];

  tarjetas.forEach((tarjeta, indice) => {
    tarjetaIndicador(doc, MARGEN + indice * (anchoTarjeta + separacion), y, anchoTarjeta, altoTarjeta, tarjeta);
  });
  y += altoTarjeta + 22;

  // ---- Embudo ----
  rotulo(doc, 'Recorrido de los mensajes', MARGEN, y);
  y += 18;

  doc.rectangulo(MARGEN, y, ANCHO_UTIL, 116, { relleno: COLOR.blanco, borde: COLOR.borde, radio: 8 });
  let yBarra = y + 16;
  yBarra = barra(doc, MARGEN + 16, yBarra, ANCHO_UTIL - 32, {
    etiqueta: 'Enviados',
    valor: totales.mensajes_facturables,
    total: totales.intentos,
    color: COLOR.azul,
    nota: 'Aceptados por WhatsApp — esto es lo que se factura.',
  });
  yBarra = barra(doc, MARGEN + 16, yBarra, ANCHO_UTIL - 32, {
    etiqueta: 'Entregados',
    valor: totales.entregados,
    total: totales.mensajes_facturables,
    color: COLOR.verde,
    nota: 'Confirmados por el webhook. No altera el valor facturado.',
  });
  yBarra = barra(doc, MARGEN + 16, yBarra, ANCHO_UTIL - 32, {
    etiqueta: 'Leídos',
    valor: totales.leidos,
    total: totales.mensajes_facturables,
    color: COLOR.azulOscuro,
  });
  barra(doc, MARGEN + 16, yBarra, ANCHO_UTIL - 32, {
    etiqueta: 'Fallidos',
    valor: totales.fallidos,
    total: totales.intentos,
    color: COLOR.rojo,
  });
  y += 116 + 22;

  // ---- Detalle por campaña ----
  if (y + 90 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();
  rotulo(doc, 'Detalle por campaña', MARGEN, y);
  y += 16;

  // Igual que en la factura: cada ancho entra el encabezado completo
  // ("ENVIADOS" pide ~59pt con padding, "FALLIDOS" ~57pt).
  const anchos = [34, 120, 62, 60, 54, 50, 58, ANCHO_UTIL - 34 - 120 - 62 - 60 - 54 - 50 - 58];
  const columnas = [
    { titulo: '#', clave: 'id', ancho: anchos[0], fuente: 'negrita' },
    { titulo: 'Plantilla', clave: 'plantilla', ancho: anchos[1] },
    { titulo: 'Fecha', clave: 'fecha', ancho: anchos[2] },
    { titulo: 'Enviados', clave: 'enviados', ancho: anchos[3], alineacion: 'right', fuente: 'negrita' },
    { titulo: 'Entreg.', clave: 'entregados', ancho: anchos[4], alineacion: 'right' },
    { titulo: 'Leídos', clave: 'leidos', ancho: anchos[5], alineacion: 'right' },
    { titulo: 'Fallidos', clave: 'fallidos', ancho: anchos[6], alineacion: 'right' },
    { titulo: 'Importe', clave: 'importe', ancho: anchos[7], alineacion: 'right', fuente: 'negrita' },
  ];

  const filas = detalle.map((linea) => ({
    id: String(linea.campana_id),
    plantilla: linea.template_nombre,
    fecha: fechaCorta(linea.creado_en),
    enviados: formatearNumero(linea.enviados),
    entregados: formatearNumero(linea.entregados),
    leidos: formatearNumero(linea.leidos),
    fallidos: {
      texto: formatearNumero(linea.fallidos),
      color: linea.fallidos > 0 ? COLOR.rojo : COLOR.suave,
    },
    importe: formatearMoneda(linea.importe, moneda, { conCodigo: false }),
  }));

  y = tabla(doc, {
    x: MARGEN,
    y,
    columnas,
    filas,
    alSaltarPagina: nuevaPaginaContinuacion,
    sinFilas: 'No se seleccionaron campañas.',
  });

  // ---- Fila de totales ----
  doc.rectangulo(MARGEN, y, ANCHO_UTIL, 24, { relleno: COLOR.fondo2, radio: 4 });
  const totalesFila = [
    { valor: 'TOTAL', ancho: anchos[0] + anchos[1] + anchos[2], alineacion: 'left' },
    { valor: formatearNumero(totales.mensajes_facturables), ancho: anchos[3], alineacion: 'right' },
    { valor: formatearNumero(totales.entregados), ancho: anchos[4], alineacion: 'right' },
    { valor: formatearNumero(totales.leidos), ancho: anchos[5], alineacion: 'right' },
    { valor: formatearNumero(totales.fallidos), ancho: anchos[6], alineacion: 'right' },
    { valor: formatearMoneda(resumen.subtotal, moneda, { conCodigo: false }), ancho: anchos[7], alineacion: 'right' },
  ];
  let xTotales = MARGEN;
  for (const celda of totalesFila) {
    doc.texto(celda.valor, xTotales + 8, y + 7, {
      fuente: 'negrita',
      tamano: 8.5,
      color: COLOR.tinta,
      alineacion: celda.alineacion,
      ancho: celda.ancho - 16,
      maxAncho: celda.ancho - 16,
    });
    xTotales += celda.ancho;
  }
  y += 24 + 22;

  // ---- Cierre: tasas y liquidación ----
  if (y + 120 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();

  const anchoColumna = (ANCHO_UTIL - 16) / 2;

  doc.rectangulo(MARGEN, y, anchoColumna, 108, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
  rotulo(doc, 'Indicadores de rendimiento', MARGEN + 12, y + 11);
  let yIndicador = y + 28;
  const indicadores = [
    ['Tasa de entrega', formatearPorcentaje(totales.entregados, totales.mensajes_facturables)],
    ['Tasa de lectura', formatearPorcentaje(totales.leidos, totales.mensajes_facturables)],
    ['Tasa de fallo', formatearPorcentaje(totales.fallidos, totales.intentos)],
    ['Intentos totales', formatearNumero(totales.intentos)],
  ];
  for (const [etiqueta, valor] of indicadores) {
    doc.texto(etiqueta, MARGEN + 12, yIndicador, { tamano: 8.5, color: COLOR.suave });
    doc.texto(valor, MARGEN + 12, yIndicador, {
      tamano: 8.5,
      fuente: 'negrita',
      color: COLOR.tinta,
      alineacion: 'right',
      ancho: anchoColumna - 24,
    });
    yIndicador += 19;
  }

  const xLiquidacion = MARGEN + anchoColumna + 16;
  doc.rectangulo(xLiquidacion, y, anchoColumna, 108, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
  rotulo(doc, 'Liquidación', xLiquidacion + 12, y + 11);
  let yLiquidacion = y + 28;
  const liquidacion = [
    ['Mensajes facturables', formatearNumero(totales.mensajes_facturables)],
    ['Valor por mensaje', formatearTarifa(resumen.tarifa, moneda)],
    ['Subtotal', formatearMoneda(resumen.subtotal, moneda, { conCodigo: false })],
  ];
  if (resumen.iva_porcentaje > 0) {
    liquidacion.push([
      `IVA (${String(resumen.iva_porcentaje).replace('.', ',')}%)`,
      formatearMoneda(resumen.iva_monto, moneda, { conCodigo: false }),
    ]);
  }
  liquidacion.push(['TOTAL', formatearMoneda(resumen.total, moneda)]);

  liquidacion.forEach(([etiqueta, valor], indice) => {
    const esUltimo = indice === liquidacion.length - 1;
    doc.texto(etiqueta, xLiquidacion + 12, yLiquidacion, {
      tamano: esUltimo ? 9.5 : 8.5,
      fuente: esUltimo ? 'negrita' : 'regular',
      color: esUltimo ? COLOR.tinta : COLOR.suave,
    });
    doc.texto(valor, xLiquidacion + 12, yLiquidacion, {
      tamano: esUltimo ? 9.5 : 8.5,
      fuente: 'negrita',
      color: esUltimo ? COLOR.azulOscuro : COLOR.tinta,
      alineacion: 'right',
      ancho: anchoColumna - 24,
    });
    if (esUltimo) {
      doc.linea(xLiquidacion + 12, yLiquidacion - 6, xLiquidacion + anchoColumna - 12, yLiquidacion - 6, {
        color: COLOR.borde,
      });
    }
    yLiquidacion += esUltimo ? 20 : 19;
  });

  y += 108 + 16;

  if (y + 34 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();
  doc.parrafo(
    'Criterio de cobro: se factura por MENSAJE ENVIADO — cada mensaje aceptado y despachado por la ' +
      'plataforma de WhatsApp Business. Los mensajes fallidos no generan cobro. "Entregado" y "leído" ' +
      'son estados posteriores que informa el webhook de Meta y no modifican el valor facturado.',
    MARGEN,
    y,
    ANCHO_UTIL,
    { tamano: 7.8, color: COLOR.suave, interlineado: 1.45 }
  );

  pie(doc, doc.totalPaginas, piePagina);
  return doc.buffer();
}

// ==================== PDF: HISTORIAL DETALLADO ====================

/**
 * Listado envío por envío de las campañas seleccionadas: plantilla,
 * teléfono, nombre del contacto, estado y el detalle técnico del envío
 * (el error de Meta si falló, o el ID del mensaje si salió bien — el
 * mismo dato que ya se ve en "Detalle de campaña" en la app, acá
 * agregado para varias campañas a la vez en un PDF descargable).
 */
export function generarHistorialDetalladoPdf({ campanas, envios, cliente, emisor = datosEmisor(), generadoEn = new Date() }) {
  const doc = crearDocumento();
  const piePagina = `${emisor.nombre}  ·  Historial detallado de ${cliente.nombre_negocio || cliente.email}  ·  ${fechaConHora(generadoEn)}`;

  const nuevaPaginaContinuacion = () => {
    pie(doc, doc.totalPaginas, piePagina);
    doc.nuevaPagina();
    const alto = cabecera(doc, { titulo: 'HISTORIAL DETALLADO', subtitulo: 'ENVÍOS POR CONTACTO' });
    return alto + 24;
  };

  let y = cabecera(doc, {
    titulo: 'HISTORIAL DETALLADO',
    subtitulo: 'ENVÍOS POR CONTACTO',
    lineasDerecha: [
      `Cliente: ${cliente.nombre_negocio || cliente.email}`,
      `${campanas.length} campaña${campanas.length === 1 ? '' : 's'} — ${formatearNumero(envios.length)} envíos`,
      `Generado el ${fechaConHora(generadoEn)}`,
    ],
  });

  y += 22;

  const conteos = envios.reduce((acc, e) => {
    acc[e.estado] = (acc[e.estado] || 0) + 1;
    return acc;
  }, {});

  rotulo(doc, 'Resumen', MARGEN, y);
  y += 16;
  doc.rectangulo(MARGEN, y, ANCHO_UTIL, 40, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
  doc.texto(
    `Enviados: ${formatearNumero(conteos.enviado || 0)}      Entregados: ${formatearNumero(conteos.entregado || 0)}      ` +
      `Leídos: ${formatearNumero(conteos.leido || 0)}      Fallidos: ${formatearNumero(conteos.fallido || 0)}`,
    MARGEN + 14,
    y + 14,
    { tamano: 9.5, fuente: 'negrita', color: COLOR.tinta }
  );
  y += 40 + 22;

  rotulo(doc, 'Detalle por contacto', MARGEN, y);
  y += 16;

  const anchos = [130, 85, 110, 65, ANCHO_UTIL - 130 - 85 - 110 - 65];
  const columnas = [
    { titulo: 'Plantilla', clave: 'plantilla', ancho: anchos[0] },
    { titulo: 'Teléfono', clave: 'telefono', ancho: anchos[1] },
    { titulo: 'Nombre', clave: 'nombre', ancho: anchos[2] },
    { titulo: 'Estado', clave: 'estado', ancho: anchos[3] },
    { titulo: 'Detalle / log', clave: 'detalle', ancho: anchos[4] },
  ];

  const colorEstado = {
    enviado: COLOR.azul,
    entregado: COLOR.verde,
    leido: COLOR.azulOscuro,
    fallido: COLOR.rojo,
  };

  const filas = envios.map((e) => ({
    plantilla: e.template_nombre,
    telefono: e.telefono,
    nombre: e.nombre || '—',
    estado: {
      texto: e.estado.charAt(0).toUpperCase() + e.estado.slice(1),
      color: colorEstado[e.estado] || COLOR.suave,
      fuente: 'negrita',
    },
    detalle: e.error || (e.wa_message_id ? `ID: ${e.wa_message_id}` : '—'),
  }));

  tabla(doc, {
    x: MARGEN,
    y,
    columnas,
    filas,
    altoFila: 22,
    alSaltarPagina: nuevaPaginaContinuacion,
    sinFilas: 'No hay envíos para las campañas seleccionadas.',
  });

  pie(doc, doc.totalPaginas, piePagina);
  return doc.buffer();
}

// ==================== PDF: COTIZACIÓN ====================

/**
 * Estimación de costo en PDF para un grupo de contactos, ANTES de
 * mandarles una campaña — mismo cálculo que `calcularCotizacion`, con el
 * detalle de a quiénes se les mandaría. No es un documento fiscal (no
 * lleva numeración ni se guarda), es solo una proyección para decidir.
 */
export function generarCotizacionPdf({ contactos, cotizacion, cliente, emisor = datosEmisor(), generadoEn = new Date() }) {
  const doc = crearDocumento();
  const moneda = cotizacion.moneda || 'COP';
  const piePagina = `${emisor.nombre}  ·  Cotización para ${cliente.nombre_negocio || cliente.email}  ·  ${fechaConHora(generadoEn)}`;

  const nuevaPaginaContinuacion = () => {
    pie(doc, doc.totalPaginas, piePagina);
    doc.nuevaPagina();
    const alto = cabecera(doc, { titulo: 'COTIZACIÓN', subtitulo: 'continuación' });
    return alto + 24;
  };

  let y = cabecera(doc, {
    titulo: 'COTIZACIÓN',
    subtitulo: 'ESTIMACIÓN DE ENVÍO',
    lineasDerecha: [
      `Cliente: ${cliente.nombre_negocio || cliente.email}`,
      `${formatearNumero(cotizacion.total_contactos)} contacto${cotizacion.total_contactos === 1 ? '' : 's'} seleccionado${cotizacion.total_contactos === 1 ? '' : 's'}`,
      `Generado el ${fechaConHora(generadoEn)}`,
    ],
  });

  y += 22;

  rotulo(doc, 'Contactos incluidos', MARGEN, y);
  y += 16;

  const anchos = [ANCHO_UTIL - 220, 220];
  const columnas = [
    { titulo: 'Teléfono', clave: 'telefono', ancho: anchos[0] },
    { titulo: 'Nombre', clave: 'nombre', ancho: anchos[1] },
  ];
  const filas = contactos.map((c) => ({ telefono: c.telefono, nombre: c.nombre || '—' }));

  y = tabla(doc, {
    x: MARGEN,
    y,
    columnas,
    filas,
    alSaltarPagina: nuevaPaginaContinuacion,
    sinFilas: 'No hay contactos seleccionados.',
  });

  y += 18;

  // ---- Totales (mismo bloque visual que la factura) ----
  const anchoTotales = 250;
  const xTotales = ANCHO_PAGINA - MARGEN - anchoTotales;

  if (y + 130 > ALTO_PAGINA - 62) y = nuevaPaginaContinuacion();

  const filasTotales = [
    ['Contactos', formatearNumero(cotizacion.total_contactos)],
    ['Valor por mensaje', formatearTarifa(cotizacion.tarifa, moneda)],
    ['Subtotal', formatearMoneda(cotizacion.subtotal, moneda)],
  ];
  if (Number(cotizacion.iva_porcentaje) > 0) {
    filasTotales.push([`IVA (${String(cotizacion.iva_porcentaje).replace('.', ',')}%)`, formatearMoneda(cotizacion.iva_monto, moneda)]);
  }

  let yTotal = y;
  for (const [etiqueta, valor] of filasTotales) {
    doc.texto(etiqueta, xTotales, yTotal + 4, { tamano: 9, color: COLOR.suave });
    doc.texto(valor, xTotales, yTotal + 4, {
      tamano: 9,
      fuente: 'negrita',
      color: COLOR.tinta,
      alineacion: 'right',
      ancho: anchoTotales,
    });
    yTotal += 18;
    doc.linea(xTotales, yTotal, xTotales + anchoTotales, yTotal, { color: COLOR.borde, grosor: 0.5 });
  }

  yTotal += 6;
  doc.rectangulo(xTotales, yTotal, anchoTotales, 40, { relleno: COLOR.negro, radio: 8 });
  doc.rectangulo(xTotales, yTotal, 3.5, 40, { relleno: COLOR.azul, radio: 1.75 });
  rotulo(doc, 'Total estimado', xTotales + 14, yTotal + 9, { color: COLOR.tenue });
  doc.texto(formatearMoneda(cotizacion.total, moneda), xTotales + 14, yTotal + 21, {
    fuente: 'negrita',
    tamano: 15,
    color: COLOR.blanco,
    alineacion: 'right',
    ancho: anchoTotales - 28,
  });

  // ---- Nota ----
  const anchoNota = ANCHO_UTIL - anchoTotales - 20;
  doc.rectangulo(MARGEN, y, anchoNota, 84, { relleno: COLOR.fondo, borde: COLOR.borde, radio: 8 });
  rotulo(doc, 'Sobre esta cotización', MARGEN + 12, y + 11);
  doc.parrafo(
    'Es una estimación con la tarifa configurada hoy — el valor final que se ' +
      'factura depende de los mensajes que WhatsApp acepte y despache de verdad ' +
      '(los fallidos no se cobran). No es un documento fiscal.',
    MARGEN + 12,
    y + 26,
    anchoNota - 24,
    { tamano: 7.8, color: COLOR.suave, interlineado: 1.42 }
  );

  pie(doc, doc.totalPaginas, piePagina);
  return doc.buffer();
}

/** Nombre de archivo seguro para la descarga. */
export function nombreArchivo(base) {
  return String(base)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export { truncarTexto };
