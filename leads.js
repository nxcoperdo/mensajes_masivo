import dotenv from 'dotenv';
dotenv.config();

import { normalizePhone } from './whatsapp.js';

/**
 * Prospección de leads B2B: busca negocios por rubro/ciudad para que el
 * usuario los contacte manualmente y les ofrezca el servicio de
 * mensajería masiva. Módulo standalone — no toca contactos/campanas.
 *
 * Proveedor: si GOOGLE_PLACES_API_KEY está seteada en .env, usa Google
 * Places (Text Search + Place Details). Si no, cae automáticamente a
 * Nominatim + Overpass (OpenStreetMap), gratis y sin key. `server.js`
 * llama únicamente a `buscarNegocios` y no necesita saber cuál está activo.
 */
export async function buscarNegocios({ query, ciudad }) {
  if (!query || !String(query).trim()) return { ok: false, error: 'Falta el término de búsqueda (query)' };
  if (!ciudad || !String(ciudad).trim()) return { ok: false, error: 'Falta la ciudad' };

  try {
    const usaGoogle = Boolean(process.env.GOOGLE_PLACES_API_KEY);
    const crudos = usaGoogle
      ? await buscarGooglePlaces({ query, ciudad })
      : await buscarOsm({ query, ciudad });

    const resultados = crudos.map(normalizarResultado).filter((r) => r !== null);

    return { ok: true, resultados, proveedor: usaGoogle ? 'google' : 'osm' };
  } catch (err) {
    return { ok: false, error: err.message || 'Error buscando negocios' };
  }
}

/**
 * Limpia el teléfono (reusa normalizePhone de whatsapp.js) y arma el
 * link de WhatsApp. Descarta el resultado si no hay teléfono utilizable.
 */
function normalizarResultado({ nombre, direccion, rubro, telefono, sitio_web }) {
  const tel = normalizePhone(telefono);
  if (!tel) return null;
  return {
    nombre: nombre || 'Sin nombre',
    direccion: direccion || null,
    rubro: rubro || null,
    telefono: tel,
    sitio_web: sitio_web || null,
    link_whatsapp: `https://wa.me/${tel}`,
  };
}

// ==================== PROVEEDOR: GOOGLE PLACES ====================

/**
 * Text Search da nombre/dirección pero no teléfono ni sitio web — hace
 * falta un Place Details por cada candidato para completar esos datos.
 */
async function buscarGooglePlaces({ query, ciudad }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const maxResultados = Number(process.env.LEADS_MAX_RESULTADOS) || 20;
  const textQuery = `${query} en ${ciudad}, Colombia`;

  const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(textQuery)}&key=${key}`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();
  if (searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places: ${searchData.status} ${searchData.error_message || ''}`.trim());
  }

  const candidatos = (searchData.results || []).slice(0, maxResultados);

  const detalles = await Promise.all(
    candidatos.map(async (c) => {
      const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${c.place_id}&fields=formatted_phone_number,website&key=${key}`;
      try {
        const detRes = await fetch(detUrl);
        const detData = await detRes.json();
        return detData.result || {};
      } catch {
        return {};
      }
    })
  );

  return candidatos.map((c, i) => ({
    nombre: c.name,
    direccion: c.formatted_address,
    rubro: (c.types || [])[0] || null,
    telefono: detalles[i].formatted_phone_number,
    sitio_web: detalles[i].website,
  }));
}

// ==================== PROVEEDOR: NOMINATIM + OVERPASS (gratis, sin key) ====================

const CATEGORIA_OSM = {
  restaurante: 'amenity=restaurant',
  concesionario: 'shop=car',
  ferreteria: 'shop=hardware',
  hotel: 'tourism=hotel',
  farmacia: 'amenity=pharmacy',
  peluqueria: 'shop=hairdresser',
  'salon de belleza': 'shop=beauty',
  panaderia: 'shop=bakery',
  veterinaria: 'amenity=veterinary',
  gimnasio: 'leisure=fitness_centre',
  supermercado: 'shop=supermarket',
  ropa: 'shop=clothes',
  papeleria: 'shop=stationery',
  optica: 'shop=optician',
  joyeria: 'shop=jewelry',
  floristeria: 'shop=florist',
  cafeteria: 'amenity=cafe',
  bar: 'amenity=bar',
  clinica: 'amenity=clinic',
  consultorio: 'amenity=doctors',
  colegio: 'amenity=school',
  inmobiliaria: 'office=estate_agent',
  abogado: 'office=lawyer',
  taller: 'shop=car_repair',
  mecanico: 'shop=car_repair',
};

function quitarAcentos(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function mapearCategoria(query) {
  const q = quitarAcentos(String(query).toLowerCase().trim());
  for (const [palabra, tag] of Object.entries(CATEGORIA_OSM)) {
    if (q.includes(palabra)) return tag;
  }
  return null;
}

function escaparRegexOverpass(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function userAgentOsm() {
  return process.env.NOMINATIM_USER_AGENT || 'whatsapp-broadcast-leads/1.0';
}

async function geocodificarCiudad(ciudad) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q=${encodeURIComponent(`${ciudad}, Colombia`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': userAgentOsm() } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`No se pudo ubicar la ciudad "${ciudad}"`);
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

function formatearDireccionOsm(t) {
  const partes = [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean);
  return partes.length ? partes.join(' ') : null;
}

// El servidor público principal de Overpass (overpass-api.de) es un
// recurso gratuito compartido y devuelve 504 seguido cuando está
// saturado. Probamos espejos alternativos antes de rendirnos.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function consultarOverpass(overpassQl) {
  let ultimoError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': userAgentOsm() },
        body: overpassQl,
        signal: controller.signal,
      });
      if (!res.ok) {
        ultimoError = new Error(`Overpass (${endpoint}) HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      ultimoError = err.name === 'AbortError' ? new Error(`Overpass (${endpoint}) sin respuesta`) : err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw ultimoError || new Error('Todos los servidores de Overpass fallaron');
}

async function buscarOsm({ query, ciudad }) {
  const { lat, lon } = await geocodificarCiudad(ciudad);
  const radio = Number(process.env.LEADS_RADIO_METROS) || 5000;
  const maxResultados = Number(process.env.LEADS_MAX_RESULTADOS) || 20;
  const tag = mapearCategoria(query);

  const filtro = tag ? `["${tag.split('=')[0]}"="${tag.split('=')[1]}"]` : null;

  const overpassQl = filtro
    ? `
      [out:json][timeout:25];
      (
        node${filtro}(around:${radio},${lat},${lon});
        way${filtro}(around:${radio},${lat},${lon});
      );
      out center tags;
    `
    : `
      [out:json][timeout:25];
      (
        node["name"~"${escaparRegexOverpass(query)}",i](around:${radio},${lat},${lon});
        way["name"~"${escaparRegexOverpass(query)}",i](around:${radio},${lat},${lon});
      );
      out center tags;
    `;

  const data = await consultarOverpass(overpassQl);

  return (data.elements || []).slice(0, maxResultados).map((el) => {
    const t = el.tags || {};
    return {
      nombre: t.name,
      direccion: formatearDireccionOsm(t),
      rubro: tag || t.shop || t.amenity || t.office || t.leisure || t.tourism || null,
      telefono: t.phone || t['contact:phone'],
      sitio_web: t.website || t['contact:website'],
    };
  });
}
