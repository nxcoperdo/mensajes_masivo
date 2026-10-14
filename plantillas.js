/**
 * Reglas de contenido de las solicitudes de plantilla de WhatsApp. Son puras
 * (sin base de datos ni Express) para poder probarlas solas; el frontend
 * (public/app.js) repite las mismas reglas para avisar mientras se escribe,
 * pero ESTE módulo es la fuente de verdad.
 *
 * Reglas de Meta que se validan:
 *  - Las variables son {{1}}, {{2}}… consecutivas desde 1 (sin saltos).
 *  - El cuerpo no puede empezar ni terminar con una variable.
 *  - Dos variables no pueden ir pegadas ({{1}}{{2}}).
 *  - Cada variable necesita un ejemplo para que Meta apruebe la plantilla.
 *  - El pie y el encabezado de texto no llevan variables (se mantiene simple).
 */

export const MAX_NOMBRE_PLANTILLA = 512;
export const MAX_BODY = 1024;
export const MAX_HEADER_TEXTO = 60;
export const MAX_FOOTER = 60;
export const MAX_EJEMPLO = 100;
export const MAX_TEXTO_BOTON = 25;
export const MAX_TELEFONO_BOTON = 20;

const RE_VARIABLE = /\{\{\s*(\d+)\s*\}\}/g;

/** Números de variable ({{N}}) que aparecen en el texto, en orden de aparición. */
export function variablesDeTexto(texto) {
  const numeros = [];
  for (const m of String(texto || '').matchAll(RE_VARIABLE)) numeros.push(Number(m[1]));
  return numeros;
}

/** Cantidad de variables distintas que pide el texto (ya validado como consecutivo). */
export function cantidadVariables(texto) {
  return new Set(variablesDeTexto(texto)).size;
}

/**
 * Valida el contenido de una solicitud. Devuelve el mensaje de error (en
 * español, diciendo qué corregir) o `null` si todo está bien.
 */
export function validarContenidoPlantilla({ nombre, idioma, headerTipo, headerTexto, bodyTexto, footerTexto, ejemplos }) {
  if (!nombre || !/^[a-z0-9_]+$/.test(nombre)) {
    return 'El nombre debe ir en minúsculas, sin espacios ni acentos (solo letras, números y guion bajo)';
  }
  if (nombre.length > MAX_NOMBRE_PLANTILLA) return `El nombre no puede superar ${MAX_NOMBRE_PLANTILLA} caracteres`;
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(idioma)) {
    return 'El idioma debe ser un código como es, es_CO, en o en_US';
  }

  if (!bodyTexto) return 'Falta el cuerpo de la plantilla';
  if (bodyTexto.length > MAX_BODY) return `El cuerpo no puede superar ${MAX_BODY} caracteres`;

  if (headerTipo === 'TEXT') {
    if (!headerTexto) return `El texto del encabezado es obligatorio y no puede superar ${MAX_HEADER_TEXTO} caracteres`;
    if (headerTexto.length > MAX_HEADER_TEXTO) return `El texto del encabezado no puede superar ${MAX_HEADER_TEXTO} caracteres`;
    if (variablesDeTexto(headerTexto).length > 0) return 'El encabezado no puede llevar variables ({{1}}). Déjalas para el cuerpo';
  }
  if (footerTexto) {
    if (footerTexto.length > MAX_FOOTER) return `El pie no puede superar ${MAX_FOOTER} caracteres`;
    if (variablesDeTexto(footerTexto).length > 0) return 'El pie no puede llevar variables ({{1}}). Déjalas para el cuerpo';
  }

  // ---- Variables del cuerpo ----
  const usadas = variablesDeTexto(bodyTexto);
  const distintas = Array.from(new Set(usadas)).sort((a, b) => a - b);
  for (let i = 0; i < distintas.length; i += 1) {
    if (distintas[i] !== i + 1) {
      return `Las variables deben ir en orden y sin saltos: {{1}}, {{2}}, {{3}}… Falta {{${i + 1}}} antes de {{${distintas[i]}}}`;
    }
  }
  if (distintas.length > 0) {
    if (/^\s*\{\{\s*\d+\s*\}\}/.test(bodyTexto)) return 'El cuerpo no puede empezar con una variable. Escribe un saludo o una palabra antes (ej: «Hola {{1}}»)';
    if (/\{\{\s*\d+\s*\}\}\s*$/.test(bodyTexto)) return 'El cuerpo no puede terminar con una variable. Agrega un punto o una frase después';
    if (/\}\}\{\{/.test(bodyTexto)) return 'Dos variables no pueden ir pegadas ({{1}}{{2}}). Sepáralas con texto o un espacio';
  }

  const lista = Array.isArray(ejemplos) ? ejemplos : [];
  if (lista.length !== distintas.length) {
    return distintas.length === 0
      ? 'Esta plantilla no tiene variables, así que no lleva ejemplos'
      : `Meta pide un ejemplo por cada variable: tu cuerpo tiene ${distintas.length} y recibimos ${lista.length} ejemplos`;
  }
  for (let i = 0; i < lista.length; i += 1) {
    const ejemplo = String(lista[i] ?? '').trim();
    if (!ejemplo) return `Escribe un ejemplo para la variable {{${i + 1}}} (ej: un nombre o una fecha reales)`;
    if (ejemplo.length > MAX_EJEMPLO) return `El ejemplo de {{${i + 1}}} no puede superar ${MAX_EJEMPLO} caracteres`;
  }

  return null;
}

/**
 * Valida y limpia los botones: hasta 10 en total, 3 de respuesta rápida, 2 de
 * URL y 1 de llamada; texto ≤25, teléfono con código de país (solo dígitos,
 * ≤20) y URL https. Lanza Error con el mensaje para el usuario.
 */
export function validarBotones(botonesRaw) {
  if (botonesRaw === undefined || botonesRaw === null || botonesRaw === '') return [];
  const lista = Array.isArray(botonesRaw) ? botonesRaw : JSON.parse(botonesRaw);
  if (!Array.isArray(lista)) throw new Error('Los botones deben ser una lista');
  if (lista.length > 10) throw new Error('Máximo 10 botones por plantilla');

  const contador = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 };
  const limpios = lista.map((b, i) => {
    const tipo = String(b?.tipo || '').toUpperCase();
    if (!Object.hasOwn(contador, tipo)) throw new Error(`Botón ${i + 1}: tipo inválido`);
    const texto = String(b?.texto || '').trim();
    if (!texto) throw new Error(`Botón ${i + 1}: falta el texto`);
    if (texto.length > MAX_TEXTO_BOTON) throw new Error(`Botón ${i + 1}: el texto no puede superar ${MAX_TEXTO_BOTON} caracteres`);
    contador[tipo] += 1;

    const boton = { tipo, texto };
    if (tipo === 'URL') {
      boton.url = String(b?.url || '').trim();
      if (!boton.url) throw new Error(`Botón ${i + 1}: falta la URL`);
      if (!/^https?:\/\/\S+\.\S+$/i.test(boton.url)) throw new Error(`Botón ${i + 1}: la URL debe empezar por https:// (ej: https://tutienda.com)`);
    }
    if (tipo === 'PHONE_NUMBER') {
      boton.telefono = String(b?.telefono || '').trim().replace(/^\+/, '');
      if (!boton.telefono) throw new Error(`Botón ${i + 1}: falta el teléfono`);
      if (!/^\d{8,15}$/.test(boton.telefono) || boton.telefono.length > MAX_TELEFONO_BOTON) {
        throw new Error(`Botón ${i + 1}: el teléfono debe llevar el código de país y solo números (ej: 573001234567)`);
      }
    }
    return boton;
  });

  if (contador.QUICK_REPLY > 3) throw new Error('Máximo 3 botones de respuesta rápida');
  if (contador.URL > 2) throw new Error('Máximo 2 botones de URL');
  if (contador.PHONE_NUMBER > 1) throw new Error('Máximo 1 botón de llamada telefónica');
  return limpios;
}
