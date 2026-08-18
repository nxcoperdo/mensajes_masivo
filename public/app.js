// Estado en memoria del frontend (sin framework — proyecto chico a propósito).
let contactos = [];
const seleccionados = new Set();
let parametros = []; // [{ tipo: 'fijo'|'nombre', valor: '' }]

// ==================== SESIÓN ====================
// Cualquier fetch que devuelva 401 (sesión vencida o cerrada en otra
// pestaña) manda directo al login, sin tener que agregar el chequeo en
// cada llamada del archivo.

const fetchOriginal = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await fetchOriginal(...args);
  if (res.status === 401) {
    window.location.href = '/login.html';
  }
  return res;
};

document.getElementById('btnLogout').addEventListener('click', async () => {
  await fetchOriginal('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ==================== TEMA (claro/oscuro) ====================
// Sigue prefers-color-scheme por defecto; el botón permite forzar un
// modo y lo recuerda en localStorage.

const THEME_KEY = 'wa-broadcast-theme';

function aplicarTema(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function temaActualEfectivo() {
  const guardado = localStorage.getItem(THEME_KEY);
  if (guardado === 'light' || guardado === 'dark') return guardado;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

aplicarTema(localStorage.getItem(THEME_KEY));

document.getElementById('btnTheme').addEventListener('click', () => {
  const siguiente = temaActualEfectivo() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, siguiente);
  aplicarTema(siguiente);
});

// ==================== TABS ====================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'campana') {
      document.getElementById('campanaContactosCount').textContent = seleccionados.size;
    }
    if (btn.dataset.tab === 'historial') {
      abrirHistorial();
    }
    if (btn.dataset.tab === 'leads') {
      cargarLeads();
    }
    if (btn.dataset.tab === 'webhook') {
      cargarConversaciones();
      cargarNumeros();
    }
  });
});

// ==================== CONFIG / CONECTAR WHATSAPP ====================

/**
 * Carga /api/config, que además de la info de webhook trae el estado
 * del cliente logueado. Si todavía no conectó su WhatsApp Business,
 * muestra la pantalla "Conectar WhatsApp" en vez de las pestañas
 * normales, y devuelve `false` para que el resto del INIT no arranque
 * (no tiene sentido cargar contactos/conversaciones de un cliente que
 * todavía no tiene número).
 */
async function cargarConfig() {
  const badge = document.getElementById('configBadge');
  try {
    const res = await fetch('/api/config');
    const data = await res.json();

    datosFacebookApp = { appId: data.facebookAppId, configId: data.facebookEmbeddedConfigId };

    if (data.cliente.estado !== 'conectado') {
      document.getElementById('navTabs').classList.add('hidden');
      document.getElementById('appMain').classList.add('hidden');
      document.getElementById('pantallaConectar').classList.remove('hidden');
      await prepararBotonConectar('btnConectarWhatsApp', () => window.location.reload());
      return false;
    }

    await prepararBotonConectar('btnAgregarNumero', () => {
      window.location.reload();
    });

    if (data.whatsappConfigured) {
      badge.textContent = 'WhatsApp configurado ✓';
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = '⚠️ Falta configurar .env';
      badge.className = 'badge badge-error';
    }

    document.getElementById('webhookUrl').textContent = `${window.location.origin}/webhook`;

    const tokenBadge = document.getElementById('webhookTokenBadge');
    if (data.webhookVerifyTokenConfigured) {
      tokenBadge.textContent = 'Configurado ✓';
      tokenBadge.className = 'badge badge-ok';
    } else {
      tokenBadge.textContent = 'Falta WHATSAPP_VERIFY_TOKEN en .env';
      tokenBadge.className = 'badge badge-error';
    }

    const firmaBadge = document.getElementById('webhookFirmaBadge');
    if (data.webhookSignatureConfigured) {
      firmaBadge.textContent = 'Activa ✓';
      firmaBadge.className = 'badge badge-ok';
    } else {
      firmaBadge.textContent = 'Sin validar (opcional)';
      firmaBadge.className = 'badge badge-muted';
    }
    return true;
  } catch {
    badge.textContent = 'No se pudo conectar al servidor';
    badge.className = 'badge badge-error';
    return false;
  }
}

// ---- Embedded Signup (popup de Meta para conectar WhatsApp Business) ----

let datosFacebookApp = null; // { appId, configId }, viene de /api/config
let datosEmbeddedSignup = null; // { waba_id, phone_number_id }, llega por postMessage

window.addEventListener('message', (event) => {
  if (typeof event.origin !== 'string' || !event.origin.endsWith('.facebook.com')) return;
  try {
    const data = JSON.parse(event.data);
    if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
      datosEmbeddedSignup = data.data;
    }
  } catch {
    // Meta manda otros mensajes por este mismo canal que no son JSON (heartbeats, etc.) — se ignoran.
  }
});

function cargarSdkFacebook(appId) {
  return new Promise((resolve) => {
    if (window.FB) return resolve();
    window.fbAsyncInit = () => {
      FB.init({ appId, xfbml: false, version: 'v20.0' });
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/es_LA/sdk.js';
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
  });
}

/**
 * Cablea un botón (el de la pantalla inicial "Conectar WhatsApp" o el de
 * "+ Agregar número" en Configuración) al popup de Embedded Signup de
 * Meta. Ambos comparten la misma lógica: abrir el popup, juntar
 * {code, waba_id, phone_number_id} y mandarlo al backend. `onSuccess` es
 * lo único que cambia según desde dónde se llame.
 */
async function prepararBotonConectar(btnId, onSuccess) {
  const btn = document.getElementById(btnId);
  if (!btn) return; // el botón de agregar número solo existe si ya pasamos la pantalla inicial

  const boxId = btnId === 'btnConectarWhatsApp' ? 'conectarResultado' : 'numerosResultado';
  const box = document.getElementById(boxId);
  const { appId, configId } = datosFacebookApp || {};

  if (!appId || !configId) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = 'Falta configurar FACEBOOK_APP_ID / FACEBOOK_EMBEDDED_CONFIG_ID en el servidor.';
    btn.disabled = true;
    return;
  }

  await cargarSdkFacebook(appId);

  btn.addEventListener('click', () => {
    box.classList.add('hidden');
    box.classList.remove('error', 'ok');
    btn.disabled = true;
    btn.classList.add('is-loading');
    datosEmbeddedSignup = null;

    FB.login(
      async (response) => {
        const code = response.authResponse?.code;
        if (!code || !datosEmbeddedSignup?.waba_id || !datosEmbeddedSignup?.phone_number_id) {
          btn.disabled = false;
          btn.classList.remove('is-loading');
          if (response.status !== 'unknown') {
            box.classList.remove('hidden');
            box.classList.add('error');
            box.textContent = 'No se completó la conexión con WhatsApp. Probá de nuevo.';
          }
          return;
        }

        try {
          const res = await fetch('/api/clientes/whatsapp/conectar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code,
              waba_id: datosEmbeddedSignup.waba_id,
              phone_number_id: datosEmbeddedSignup.phone_number_id,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'No se pudo conectar WhatsApp');
          onSuccess();
        } catch (err) {
          btn.disabled = false;
          btn.classList.remove('is-loading');
          box.classList.remove('hidden');
          box.classList.add('error');
          box.textContent = err.message;
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { sessionInfoVersion: 3 },
      }
    );
  });
}

// ---- Selector de número activo (Configuración > pestaña Webhook) ----

async function cargarNumeros() {
  const cont = document.getElementById('listaNumeros');
  if (!cont) return;

  const res = await fetch('/api/whatsapp/numeros');
  const data = await res.json();

  if (!data.numeros || data.numeros.length === 0) {
    cont.innerHTML = '<div class="empty-state">Todavía no conectaste ningún número.</div>';
    return;
  }

  cont.innerHTML = '';
  data.numeros.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'numero-row' + (n.activo ? ' numero-activo' : '');
    row.innerHTML = `
      <div>
        <strong>${n.etiqueta || n.phone_number_id}</strong>
        ${n.etiqueta ? `<span class="muted">· ${n.phone_number_id}</span>` : ''}
      </div>
      ${n.activo
        ? '<span class="badge badge-ok">Activo ✓</span>'
        : `<button type="button" class="btn btn-sm btn-outline" data-activar="${n.id}">Usar este número</button>`}
    `;
    cont.appendChild(row);
  });

  cont.querySelectorAll('[data-activar]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Activando…';
      try {
        const res = await fetch(`/api/whatsapp/numeros/${btn.dataset.activar}/activar`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo activar el número');
        await cargarNumeros();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Usar este número';
        alert(err.message);
      }
    });
  });
}

// ==================== CONTACTOS ====================

async function cargarContactos() {
  const res = await fetch('/api/contactos');
  const data = await res.json();
  contactos = data.contactos;
  renderContactos();
}

const ICONO_ELIMINAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" /></svg>';
const ICONO_VER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>';
const ICONO_CONTACTOS_VACIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>';

function renderContactos() {
  const tbody = document.getElementById('tablaContactos');
  tbody.innerHTML = '';

  if (contactos.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="4">
        <div class="empty-state">
          ${ICONO_CONTACTOS_VACIO}
          <div>Todavía no cargaste contactos. Importá un CSV/Excel o agregá uno manual.</div>
        </div>
      </td></tr>
    `;
    document.getElementById('totalContactos').textContent = 0;
    actualizarContadorSeleccion();
    return;
  }

  contactos.forEach((c) => {
    const tr = document.createElement('tr');
    const checked = seleccionados.has(c.id) ? 'checked' : '';
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${c.id}" ${checked} /></td>
      <td>${c.telefono}</td>
      <td>${c.nombre || '<span class="muted">(sin nombre)</span>'}</td>
      <td><button class="btn btn-sm btn-outline" data-del="${c.id}">${ICONO_ELIMINAR} Eliminar</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('totalContactos').textContent = contactos.length;
  actualizarContadorSeleccion();

  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) seleccionados.add(id);
      else seleccionados.delete(id);
      actualizarContadorSeleccion();
    });
  });
  tbody.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.del);
      await fetch(`/api/contactos/${id}`, { method: 'DELETE' });
      seleccionados.delete(id);
      cargarContactos();
    });
  });
}

function actualizarContadorSeleccion() {
  document.getElementById('seleccionadosCount').textContent = `${seleccionados.size} seleccionados`;
}

document.getElementById('btnSeleccionarTodos').addEventListener('click', () => {
  const todosSeleccionados = contactos.every((c) => seleccionados.has(c.id));
  if (todosSeleccionados) {
    contactos.forEach((c) => seleccionados.delete(c.id));
  } else {
    contactos.forEach((c) => seleccionados.add(c.id));
  }
  renderContactos();
});

// ==================== ENVÍO POR LOTES ====================
// Selecciona los próximos N contactos (reemplaza la selección actual)
// para mandar campañas cortas una atrás de otra, en vez de una sola
// campaña gigante — así una campaña larga no queda a mitad de camino
// si el servidor se reinicia, y es más fácil no pasarse del límite
// diario de conversaciones que da Meta.
let loteOffset = 0;

function actualizarLoteInfo() {
  const info = document.getElementById('loteInfo');
  if (loteOffset === 0 || contactos.length === 0) {
    info.textContent = '';
  } else {
    info.textContent = `Lote actual: contactos ${loteOffset - seleccionados.size + 1}–${Math.min(loteOffset, contactos.length)} de ${contactos.length}`;
  }
}

document.getElementById('btnSeleccionarLote').addEventListener('click', () => {
  if (contactos.length === 0) return;
  const tamano = Math.max(1, Number(document.getElementById('tamanoLote').value) || 100);
  if (loteOffset >= contactos.length) loteOffset = 0; // dio toda la vuelta a la lista, arranca de nuevo

  const lote = contactos.slice(loteOffset, loteOffset + tamano);
  seleccionados.clear();
  lote.forEach((c) => seleccionados.add(c.id));
  loteOffset += lote.length;

  renderContactos();
  actualizarLoteInfo();
});

document.getElementById('btnReiniciarLote').addEventListener('click', () => {
  loteOffset = 0;
  actualizarLoteInfo();
});

document.getElementById('btnEliminarTodos').addEventListener('click', async () => {
  if (contactos.length === 0) return;
  if (!confirm(`¿Eliminar los ${contactos.length} contactos? Esta acción no se puede deshacer.`)) return;
  await fetch('/api/contactos', { method: 'DELETE' });
  seleccionados.clear();
  cargarContactos();
});

document.getElementById('formAgregarContacto').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const telefono = form.telefono.value.trim();
  const nombre = form.nombre.value.trim();
  const res = await fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono, nombre }),
  });
  if (res.ok) {
    form.reset();
    cargarContactos();
  } else {
    const data = await res.json();
    alert(data.error || 'No se pudo agregar el contacto');
  }
});

document.getElementById('formImportar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const archivo = document.getElementById('inputArchivo').files[0];
  if (!archivo) return;

  const formData = new FormData();
  formData.append('archivo', archivo);

  const box = document.getElementById('importarResultado');
  const btn = e.target.querySelector('button[type="submit"]');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Importando…';
  btn.disabled = true;
  btn.classList.add('is-loading');

  try {
    const res = await fetch('/api/contactos/importar', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al importar');

    box.classList.add('ok');
    let texto = `Importados: ${data.importados} de ${data.total_filas} filas.`;
    if (data.invalidos.length > 0) {
      texto += `\nNúmeros inválidos (omitidos): ${data.invalidos.join(', ')}`;
    }
    box.textContent = texto;
    document.getElementById('formImportar').reset();
    cargarContactos();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

// ==================== CAMPAÑA (parámetros dinámicos) ====================

function renderParametros() {
  const cont = document.getElementById('parametrosLista');
  cont.innerHTML = '';
  parametros.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'param-row';
    row.innerHTML = `
      <span class="param-index">{{${idx + 1}}}</span>
      <select data-idx="${idx}" class="param-tipo">
        <option value="nombre" ${p.tipo === 'nombre' ? 'selected' : ''}>Nombre del contacto</option>
        <option value="fijo" ${p.tipo === 'fijo' ? 'selected' : ''}>Texto fijo (igual para todos)</option>
      </select>
      <input type="text" data-idx="${idx}" class="param-valor" placeholder="Texto fijo…"
        value="${p.tipo === 'fijo' ? (p.valor || '') : ''}"
        ${p.tipo === 'nombre' ? 'disabled' : ''} />
      <button type="button" class="btn-danger-sm" data-remove="${idx}" title="Quitar" aria-label="Quitar parámetro ${idx + 1}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    `;
    cont.appendChild(row);
  });

  cont.querySelectorAll('.param-tipo').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      parametros[idx].tipo = e.target.value;
      renderParametros();
    });
  });
  cont.querySelectorAll('.param-valor').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      parametros[idx].valor = e.target.value;
    });
  });
  cont.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      parametros.splice(Number(btn.dataset.remove), 1);
      renderParametros();
    });
  });
}

document.getElementById('btnAgregarParametro').addEventListener('click', () => {
  parametros.push({ tipo: 'nombre', valor: '' });
  renderParametros();
});

document.getElementById('btnEnviarCampana').addEventListener('click', async () => {
  const template_nombre = document.getElementById('templateNombre').value.trim();
  const idioma = document.getElementById('templateIdioma').value.trim() || 'es';
  const contacto_ids = Array.from(seleccionados);
  const box = document.getElementById('campanaProgreso');

  if (!template_nombre) {
    alert('Escribí el nombre exacto de la plantilla');
    return;
  }
  if (contacto_ids.length === 0) {
    alert('No hay contactos seleccionados (elegilos en la pestaña "Contactos")');
    return;
  }
  if (!confirm(`¿Enviar "${template_nombre}" a ${contacto_ids.length} contactos?`)) return;

  const btn = document.getElementById('btnEnviarCampana');
  btn.disabled = true;
  btn.classList.add('is-loading');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Iniciando envío…';

  try {
    const res = await fetch('/api/campanas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_nombre, idioma, contacto_ids, parametros }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear la campaña');

    btn.classList.remove('is-loading');
    pollProgresoCampana(data.campana_id, data.total, box, btn);
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

async function pollProgresoCampana(campanaId, total, box, btn) {
  const interval = setInterval(async () => {
    const res = await fetch(`/api/campanas/${campanaId}`);
    const data = await res.json();
    const c = data.campana;
    const procesados = c.enviados + c.fallidos;

    box.textContent = `Procesando: ${procesados} / ${total} (✓ ${c.enviados} enviados, ✕ ${c.fallidos} fallidos)`;

    if (c.estado === 'completada') {
      clearInterval(interval);
      box.classList.add(c.fallidos > 0 ? 'error' : 'ok');
      box.textContent = `Listo. ✓ ${c.enviados} enviados, ✕ ${c.fallidos} fallidos de ${total}. Revisá el detalle en "Historial".`;
      btn.disabled = false;
    }
  }, 1500);
}

// ==================== HISTORIAL ====================

let campanas = [];
const campanasSeleccionadas = new Set();

/**
 * SQLite guarda las fechas con `datetime('now')`, o sea UTC en formato
 * 'YYYY-MM-DD HH:MM:SS'. Sin la 'T' y la 'Z' el navegador lo interpreta
 * como hora LOCAL y muestra la campaña corrida varias horas (y a veces
 * en otro día). Como las facturas se emiten por período, esto tiene que
 * estar bien acá y en el PDF (ver `parsearFecha` en facturacion.js).
 */
function parsearFechaUtc(texto) {
  if (!texto) return null;
  const normalizado = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(texto)
    ? `${texto.replace(' ', 'T')}Z`
    : texto;
  const fecha = new Date(normalizado);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

const dosDigitos = (valor) => String(valor).padStart(2, '0');

/**
 * `toLocaleString('es-CO')` devuelve "23/7/2026, 1:05:00 p. m.", que en
 * la columna de fecha ocupa tres renglones y desborda la tabla. Este
 * formato fijo entra en uno solo.
 */
function formatearFechaHora(texto) {
  const fecha = parsearFechaUtc(texto);
  if (!fecha) return '—';
  return `${formatearFechaCorta(texto)} ${dosDigitos(fecha.getHours())}:${dosDigitos(fecha.getMinutes())}`;
}

function formatearFechaCorta(texto) {
  const fecha = parsearFechaUtc(texto);
  if (!fecha) return '—';
  return `${dosDigitos(fecha.getDate())}/${dosDigitos(fecha.getMonth() + 1)}/${fecha.getFullYear()}`;
}

/**
 * Entrada a la pestaña. La lista de clientes facturables se carga
 * primero porque define a cuál cliente apuntan las demás llamadas
 * (`paramsClienteFacturacion`), y solo hace falta una vez por sesión.
 */
async function abrirHistorial() {
  if (!facturacionConfig) await cargarClientesFacturables();
  await cargarCampanas();
  cargarFacturas();
}

async function cargarCampanas() {
  const res = await fetch(`/api/campanas${paramsClienteFacturacion()}`);
  const data = await res.json();
  campanas = data.campanas;

  // Una campaña que ya no está no puede seguir seleccionada (pasa al
  // cambiar de cliente en el selector de admin).
  const idsVigentes = new Set(campanas.map((c) => c.id));
  for (const id of campanasSeleccionadas) {
    if (!idsVigentes.has(id)) campanasSeleccionadas.delete(id);
  }

  renderCampanas();
}

function renderCampanas() {
  const tbody = document.getElementById('tablaCampanas');
  tbody.innerHTML = '';

  if (campanas.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="10">
        <div class="empty-state">Todavía no enviaste ninguna campaña.</div>
      </td></tr>
    `;
    actualizarSeleccionCampanas();
    return;
  }

  campanas.forEach((c) => {
    const tr = document.createElement('tr');
    const checked = campanasSeleccionadas.has(c.id) ? 'checked' : '';
    tr.innerHTML = `
      <td><input type="checkbox" data-campana="${c.id}" ${checked} aria-label="Seleccionar campaña ${c.id}" /></td>
      <td>${c.id}</td>
      <td>${escapeHtml(c.template_nombre)}</td>
      <td>${formatearFechaHora(c.creado_en)}</td>
      <td><span class="estado-pill estado-${c.estado}">${c.estado}</span></td>
      <td>${c.enviados}</td>
      <td>${c.entregados}</td>
      <td>${c.leidos}</td>
      <td>${c.fallidos}</td>
      <td><button class="btn btn-sm btn-outline" data-ver="${c.id}">${ICONO_VER} Ver detalle</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-ver]').forEach((btn) => {
    btn.addEventListener('click', () => verDetalleCampana(Number(btn.dataset.ver)));
  });
  tbody.querySelectorAll('[data-campana]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.campana);
      if (e.target.checked) campanasSeleccionadas.add(id);
      else campanasSeleccionadas.delete(id);
      actualizarSeleccionCampanas();
    });
  });

  actualizarSeleccionCampanas();
}

function actualizarSeleccionCampanas() {
  const total = campanasSeleccionadas.size;
  document.getElementById('campanasSeleccionadasCount').textContent =
    total === 1 ? '1 seleccionada' : `${total} seleccionadas`;

  const enviadosSeleccionados = campanas
    .filter((c) => campanasSeleccionadas.has(c.id))
    .reduce((acumulado, c) => acumulado + (c.enviados || 0), 0);

  for (const id of ['btnEstadisticas', 'btnReportePdf', 'btnGenerarFactura']) {
    document.getElementById(id).disabled = total === 0;
  }
  document.getElementById('btnGenerarFactura').disabled = total === 0 || enviadosSeleccionados === 0;
}

document.getElementById('btnSeleccionarCampanas').addEventListener('click', () => {
  const todasSeleccionadas = campanas.length > 0 && campanas.every((c) => campanasSeleccionadas.has(c.id));
  campanasSeleccionadas.clear();
  if (!todasSeleccionadas) campanas.forEach((c) => campanasSeleccionadas.add(c.id));
  renderCampanas();
});

async function verDetalleCampana(id) {
  const res = await fetch(`/api/campanas/${id}/envios${paramsClienteFacturacion()}`);
  const data = await res.json();
  document.getElementById('detalleCampana').classList.remove('hidden');
  document.getElementById('detalleCampanaId').textContent = `#${id}`;
  const tbody = document.getElementById('tablaEnvios');
  tbody.innerHTML = '';
  data.envios.forEach((e) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.telefono}</td>
      <td>${e.nombre || '-'}</td>
      <td><span class="estado-pill estado-${e.estado}">${e.estado}</span></td>
      <td>${e.error || (e.wa_message_id ? `id: ${e.wa_message_id}` : '-')}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==================== FACTURACIÓN ====================
//
// Regla de cobro (misma que aplica el servidor): se cobra POR MENSAJE
// ENVIADO. Los fallidos no se cobran; entregado y leído son estados
// posteriores del mismo mensaje ya enviado y no cambian el importe.

let facturacionConfig = null; // tarifa/moneda/IVA del cliente elegido
let clientesFacturables = [];
let esAdminFacturacion = false;

/** Query string con el cliente elegido — vacío cuando es el propio. */
function paramsClienteFacturacion() {
  if (!esAdminFacturacion || !facturacionConfig) return '';
  return `?cliente_id=${encodeURIComponent(facturacionConfig.cliente_id)}`;
}

function idsSeleccionados() {
  return Array.from(campanasSeleccionadas).sort((a, b) => a - b);
}

function mostrarResultadoFacturacion(mensaje, tipo) {
  const box = document.getElementById('facturacionResultado');
  box.classList.remove('hidden', 'error', 'ok');
  if (tipo) box.classList.add(tipo);
  box.textContent = mensaje;
}

const MONEDAS_SIN_DECIMALES = new Set(['COP', 'CLP', 'PYG', 'JPY', 'KRW', 'ARS', 'VES']);

function formatearMoneda(valor, moneda = 'COP', conCodigo = true) {
  const decimales = MONEDAS_SIN_DECIMALES.has(moneda) ? 0 : 2;
  const numero = Number(valor) || 0;
  const texto = numero.toLocaleString('es-CO', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
  return `$ ${texto}${conCodigo ? ` ${moneda}` : ''}`;
}

function formatearTarifa(valor, moneda = 'COP') {
  const numero = Number(valor) || 0;
  const decimales = Number.isInteger(numero) ? (MONEDAS_SIN_DECIMALES.has(moneda) ? 0 : 2) : 2;
  return `$ ${numero.toLocaleString('es-CO', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  })} ${moneda}`;
}

function formatearNumero(valor) {
  return (Number(valor) || 0).toLocaleString('es-CO');
}

function formatearPorcentaje(parte, total) {
  if (!total) return '—';
  return `${((parte / total) * 100).toFixed(1).replace('.', ',')}%`;
}

// ---- Carga inicial: clientes facturables + config del elegido ----

async function cargarClientesFacturables() {
  const res = await fetch('/api/facturacion/clientes');
  if (!res.ok) return;
  const data = await res.json();
  esAdminFacturacion = Boolean(data.es_admin);
  clientesFacturables = data.clientes || [];

  const contenedor = document.getElementById('selectorClienteFacturar');
  const select = document.getElementById('clienteFacturar');

  if (!esAdminFacturacion || clientesFacturables.length <= 1) {
    contenedor.classList.add('hidden');
    facturacionConfig = clientesFacturables[0] || null;
  } else {
    contenedor.classList.remove('hidden');
    select.innerHTML = clientesFacturables
      .map((c) => `<option value="${c.cliente_id}">${escapeHtml(c.nombre_negocio || c.email)}</option>`)
      .join('');
    const elegido = facturacionConfig
      ? clientesFacturables.find((c) => c.cliente_id === facturacionConfig.cliente_id)
      : null;
    facturacionConfig = elegido || clientesFacturables[0];
    select.value = String(facturacionConfig.cliente_id);
  }

  renderResumenTarifa();
}

function renderResumenTarifa() {
  const span = document.getElementById('tarifaResumen');
  if (!facturacionConfig) {
    span.textContent = '';
    return;
  }
  const { tarifa_por_mensaje: tarifa, moneda, iva_porcentaje: iva } = facturacionConfig;
  span.textContent = tarifa > 0
    ? `Tarifa: ${formatearTarifa(tarifa, moneda)} por mensaje enviado${iva > 0 ? ` · IVA ${iva}%` : ''}`
    : 'Sin tarifa configurada — definila antes de facturar.';
}

document.getElementById('clienteFacturar').addEventListener('change', async (e) => {
  const id = Number(e.target.value);
  facturacionConfig = clientesFacturables.find((c) => c.cliente_id === id) || facturacionConfig;
  campanasSeleccionadas.clear();
  document.getElementById('cardEstadisticas').classList.add('hidden');
  document.getElementById('detalleCampana').classList.add('hidden');
  document.getElementById('facturacionResultado').classList.add('hidden');
  renderResumenTarifa();
  await cargarCampanas();
  cargarFacturas();
});

// ---- Configuración de tarifa ----

document.getElementById('btnConfigTarifa').addEventListener('click', () => {
  const card = document.getElementById('cardTarifa');
  card.classList.toggle('hidden');
  if (card.classList.contains('hidden') || !facturacionConfig) return;

  document.getElementById('tarifaPorMensaje').value = facturacionConfig.tarifa_por_mensaje || '';
  document.getElementById('tarifaMoneda').value = facturacionConfig.moneda || 'COP';
  document.getElementById('tarifaIva').value = facturacionConfig.iva_porcentaje || 0;
  document.getElementById('tarifaNit').value = facturacionConfig.nit || '';
  document.getElementById('tarifaDireccion').value = facturacionConfig.direccion_fiscal || '';
  document.getElementById('tarifaCiudad').value = facturacionConfig.ciudad || '';
  document.getElementById('tarifaTelefono').value = facturacionConfig.telefono_contacto || '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('btnCerrarTarifa').addEventListener('click', () => {
  document.getElementById('cardTarifa').classList.add('hidden');
});

document.getElementById('formTarifa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = document.getElementById('tarifaResultado');
  const btn = e.target.querySelector('button[type="submit"]');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Guardando…';
  btn.disabled = true;

  try {
    const res = await fetch('/api/facturacion/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: facturacionConfig?.cliente_id,
        tarifa_por_mensaje: document.getElementById('tarifaPorMensaje').value,
        moneda: document.getElementById('tarifaMoneda').value,
        iva_porcentaje: document.getElementById('tarifaIva').value || 0,
        nit: document.getElementById('tarifaNit').value,
        direccion_fiscal: document.getElementById('tarifaDireccion').value,
        ciudad: document.getElementById('tarifaCiudad').value,
        telefono_contacto: document.getElementById('tarifaTelefono').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar la tarifa');

    facturacionConfig = data.config;
    clientesFacturables = clientesFacturables.map((c) =>
      c.cliente_id === data.config.cliente_id ? data.config : c
    );
    renderResumenTarifa();
    actualizarSeleccionCampanas();
    box.classList.add('ok');
    box.textContent = 'Tarifa guardada.';
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Estadísticas ----

document.getElementById('btnCerrarEstadisticas').addEventListener('click', () => {
  document.getElementById('cardEstadisticas').classList.add('hidden');
});

document.getElementById('btnEstadisticas').addEventListener('click', async () => {
  const ids = idsSeleccionados();
  if (ids.length === 0) return;

  const btn = document.getElementById('btnEstadisticas');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const res = await fetch('/api/facturacion/estadisticas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente_id: facturacionConfig?.cliente_id, campana_ids: ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron calcular las estadísticas');

    facturacionConfig = data.config;
    renderResumenTarifa();
    renderEstadisticas(data.resumen);
    document.getElementById('facturacionResultado').classList.add('hidden');
  } catch (err) {
    mostrarResultadoFacturacion(err.message, 'error');
  } finally {
    btn.classList.remove('is-loading');
    actualizarSeleccionCampanas();
  }
});

function renderEstadisticas(resumen) {
  const { totales, detalle, moneda } = resumen;
  document.getElementById('cardEstadisticas').classList.remove('hidden');

  const kpis = [
    { etiqueta: 'Campañas', valor: formatearNumero(totales.campanas), detalle: `${formatearNumero(totales.contactos)} contactos apuntados` },
    { etiqueta: 'Mensajes enviados', valor: formatearNumero(totales.mensajes_facturables), detalle: 'Base de facturación', acento: 'azul' },
    { etiqueta: 'Entregados', valor: formatearNumero(totales.entregados), detalle: formatearPorcentaje(totales.entregados, totales.mensajes_facturables) + ' de los enviados' },
    { etiqueta: 'Leídos', valor: formatearNumero(totales.leidos), detalle: formatearPorcentaje(totales.leidos, totales.mensajes_facturables) + ' de los enviados' },
    { etiqueta: 'Fallidos', valor: formatearNumero(totales.fallidos), detalle: 'No se cobran', acento: 'rojo' },
    { etiqueta: 'Total a facturar', valor: formatearMoneda(resumen.total, moneda, false), detalle: `${formatearTarifa(resumen.tarifa, moneda)} × mensaje${resumen.iva_porcentaje > 0 ? ` · IVA ${resumen.iva_porcentaje}%` : ''}`, destacada: true },
  ];

  document.getElementById('kpiGrid').innerHTML = kpis
    .map(
      (kpi) => `
      <div class="kpi${kpi.destacada ? ' kpi-destacada' : ''}${kpi.acento ? ` kpi-${kpi.acento}` : ''}">
        <span class="kpi-etiqueta">${escapeHtml(kpi.etiqueta)}</span>
        <strong class="kpi-valor">${escapeHtml(kpi.valor)}</strong>
        <span class="kpi-detalle">${escapeHtml(kpi.detalle)}</span>
      </div>`
    )
    .join('');

  const barras = [
    { etiqueta: 'Enviados', valor: totales.mensajes_facturables, base: totales.intentos, clase: 'azul' },
    { etiqueta: 'Entregados', valor: totales.entregados, base: totales.mensajes_facturables, clase: 'verde' },
    { etiqueta: 'Leídos', valor: totales.leidos, base: totales.mensajes_facturables, clase: 'azul-oscuro' },
    { etiqueta: 'Fallidos', valor: totales.fallidos, base: totales.intentos, clase: 'rojo' },
  ];

  document.getElementById('embudoStats').innerHTML = barras
    .map((barra) => {
      const proporcion = barra.base > 0 ? Math.min(100, (barra.valor / barra.base) * 100) : 0;
      return `
      <div class="embudo-fila">
        <span class="embudo-etiqueta">${barra.etiqueta}</span>
        <span class="embudo-pista"><span class="embudo-barra embudo-${barra.clase}" style="width: ${proporcion.toFixed(1)}%"></span></span>
        <span class="embudo-valor">${formatearNumero(barra.valor)} <span class="muted">(${formatearPorcentaje(barra.valor, barra.base)})</span></span>
      </div>`;
    })
    .join('');

  document.getElementById('tablaEstadisticas').innerHTML = detalle
    .map(
      (linea) => `
      <tr>
        <td>${linea.campana_id}</td>
        <td>${escapeHtml(linea.template_nombre)}</td>
        <td>${formatearFechaCorta(linea.creado_en)}</td>
        <td><strong>${formatearNumero(linea.enviados)}</strong></td>
        <td>${formatearNumero(linea.entregados)}</td>
        <td>${formatearNumero(linea.leidos)}</td>
        <td class="${linea.fallidos > 0 ? 'texto-error' : ''}">${formatearNumero(linea.fallidos)}</td>
        <td>${formatearMoneda(linea.importe, moneda, false)}</td>
      </tr>`
    )
    .join('');

  document.getElementById('pieEstadisticas').innerHTML = `
    <tr>
      <td colspan="3"><strong>TOTAL</strong></td>
      <td><strong>${formatearNumero(totales.mensajes_facturables)}</strong></td>
      <td>${formatearNumero(totales.entregados)}</td>
      <td>${formatearNumero(totales.leidos)}</td>
      <td>${formatearNumero(totales.fallidos)}</td>
      <td><strong>${formatearMoneda(resumen.subtotal, moneda, false)}</strong></td>
    </tr>
  `;

  document.getElementById('cardEstadisticas').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- Descargas de PDF ----

/**
 * Los PDF se piden con fetch (no con un `window.open`) para poder
 * mostrar el mensaje de error del servidor si algo sale mal, en vez de
 * abrir una pestaña con un JSON crudo.
 */
async function descargarPdf(url, nombreSugerido, btn) {
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo generar el PDF');
    }
    const blob = await res.blob();
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombreSugerido;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(enlace.href);
  } catch (err) {
    mostrarResultadoFacturacion(err.message, 'error');
  } finally {
    btn.classList.remove('is-loading');
    actualizarSeleccionCampanas();
  }
}

document.getElementById('btnReportePdf').addEventListener('click', () => {
  const ids = idsSeleccionados();
  if (ids.length === 0) return;
  const params = new URLSearchParams({ ids: ids.join(',') });
  if (esAdminFacturacion && facturacionConfig) params.set('cliente_id', facturacionConfig.cliente_id);
  descargarPdf(
    `/api/facturacion/reporte.pdf?${params}`,
    `reporte-campanas-${new Date().toISOString().slice(0, 10)}.pdf`,
    document.getElementById('btnReportePdf')
  );
});

document.getElementById('btnGenerarFactura').addEventListener('click', async () => {
  const ids = idsSeleccionados();
  if (ids.length === 0) return;

  if (!facturacionConfig || !(facturacionConfig.tarifa_por_mensaje > 0)) {
    mostrarResultadoFacturacion('Configurá primero la tarifa por mensaje (botón "Tarifa").', 'error');
    document.getElementById('btnConfigTarifa').click();
    return;
  }

  const enviados = campanas
    .filter((c) => campanasSeleccionadas.has(c.id))
    .reduce((acumulado, c) => acumulado + (c.enviados || 0), 0);
  const estimado = formatearMoneda(
    enviados * facturacionConfig.tarifa_por_mensaje * (1 + (facturacionConfig.iva_porcentaje || 0) / 100),
    facturacionConfig.moneda
  );

  const confirmado = confirm(
    `¿Emitir factura por ${ids.length} campaña(s)?\n\n` +
      `Mensajes enviados a cobrar: ${formatearNumero(enviados)}\n` +
      `Total estimado: ${estimado}\n\n` +
      'Los mensajes fallidos no se incluyen.'
  );
  if (!confirmado) return;

  const notas = prompt('Observaciones para la factura (opcional):', '') ?? '';

  const btn = document.getElementById('btnGenerarFactura');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const res = await fetch('/api/facturacion/facturas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: facturacionConfig?.cliente_id,
        campana_ids: ids,
        notas: notas.trim() || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo generar la factura');

    mostrarResultadoFacturacion(
      `Factura ${data.factura.numero} emitida por ${formatearMoneda(data.factura.total, data.factura.moneda)} ` +
        `(${formatearNumero(data.factura.total_mensajes)} mensajes enviados). Descargala en la tabla de abajo.`,
      'ok'
    );
    await cargarFacturas();
    await descargarPdf(
      `/api/facturacion/facturas/${data.factura.id}/pdf`,
      `factura-${data.factura.numero}.pdf`,
      btn
    );
  } catch (err) {
    mostrarResultadoFacturacion(err.message, 'error');
  } finally {
    btn.classList.remove('is-loading');
    actualizarSeleccionCampanas();
  }
});

// ---- Facturas emitidas ----

const ESTADOS_FACTURA = ['emitida', 'pagada', 'anulada'];

async function cargarFacturas() {
  const res = await fetch(`/api/facturacion/facturas${paramsClienteFacturacion()}`);
  if (!res.ok) return;
  const data = await res.json();
  renderFacturas(data.facturas || []);
}

function renderFacturas(facturas) {
  const tbody = document.getElementById('tablaFacturas');
  document.getElementById('totalFacturas').textContent = facturas.length;

  if (facturas.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">Todavía no emitiste facturas. Seleccioná campañas arriba y usá "Generar factura".</div>
      </td></tr>
    `;
    return;
  }

  tbody.innerHTML = facturas
    .map(
      (f) => `
      <tr class="${f.estado === 'anulada' ? 'fila-anulada' : ''}">
        <td><strong>${escapeHtml(f.numero)}</strong></td>
        <td>${formatearFechaCorta(f.creado_en)}</td>
        <td>${f.periodo_desde ? `${formatearFechaCorta(f.periodo_desde)} – ${formatearFechaCorta(f.periodo_hasta)}` : '—'}</td>
        <td>${f.campana_ids.length}</td>
        <td>${formatearNumero(f.total_mensajes)}</td>
        <td><strong>${formatearMoneda(f.total, f.moneda)}</strong></td>
        <td>
          <select data-factura-estado="${f.id}" class="estado-factura-select">
            ${ESTADOS_FACTURA.map((op) => `<option value="${op}" ${op === f.estado ? 'selected' : ''}>${op}</option>`).join('')}
          </select>
        </td>
        <td><button class="btn btn-sm btn-outline" data-factura-pdf="${f.id}" data-numero="${escapeHtml(f.numero)}">Descargar PDF</button></td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-factura-pdf]').forEach((btn) => {
    btn.addEventListener('click', () =>
      descargarPdf(
        `/api/facturacion/facturas/${btn.dataset.facturaPdf}/pdf`,
        `factura-${btn.dataset.numero}.pdf`,
        btn
      )
    );
  });

  tbody.querySelectorAll('[data-factura-estado]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      const res = await fetch(`/api/facturacion/facturas/${e.target.dataset.facturaEstado}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: e.target.value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        mostrarResultadoFacturacion(data.error || 'No se pudo actualizar la factura', 'error');
      }
      cargarFacturas();
    });
  });
}

document.getElementById('btnRefrescarFacturas').addEventListener('click', () => cargarFacturas());

// ==================== LEADS (PROSPECCIÓN B2B) ====================

const ICONO_LEADS_VACIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>';
const ESTADOS_LEADS = ['nuevo', 'contactado', 'interesado', 'cliente', 'descartado'];

async function cargarLeads() {
  const estado = document.getElementById('filtroEstadoLeads').value;
  const url = estado ? `/api/leads?estado=${encodeURIComponent(estado)}` : '/api/leads';
  const res = await fetch(url);
  const data = await res.json();
  renderLeads(data.leads);
}

function renderLeads(leads) {
  const tbody = document.getElementById('tablaLeads');
  tbody.innerHTML = '';
  document.getElementById('totalLeads').textContent = leads.length;

  if (leads.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          ${ICONO_LEADS_VACIO}
          <div>Todavía no hay leads. Buscá un rubro y una ciudad arriba.</div>
        </div>
      </td></tr>
    `;
    return;
  }

  leads.forEach((l) => {
    const tr = document.createElement('tr');
    const opciones = ESTADOS_LEADS.includes(l.estado)
      ? ESTADOS_LEADS
      : [l.estado, ...ESTADOS_LEADS]; // conserva un estado no estándar si ya lo tenía
    tr.innerHTML = `
      <td>${l.nombre}</td>
      <td>${l.rubro || '-'}</td>
      <td>${l.direccion || '-'}</td>
      <td>${l.telefono}</td>
      <td>${l.sitio_web ? `<a href="${l.sitio_web}" target="_blank" rel="noopener noreferrer">Sitio</a>` : '-'}</td>
      <td><a href="${l.link_whatsapp}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline">WhatsApp</a></td>
      <td>
        <select data-id="${l.id}" class="estado-lead-select">
          ${opciones.map((op) => `<option value="${op}" ${op === l.estado ? 'selected' : ''}>${op}</option>`).join('')}
        </select>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.estado-lead-select').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const id = Number(e.target.dataset.id);
      await fetch(`/api/leads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: e.target.value }),
      });
    });
  });
}

document.getElementById('filtroEstadoLeads').addEventListener('change', cargarLeads);

document.getElementById('formBuscarLeads').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = document.getElementById('leadsQuery').value.trim();
  const ciudad = document.getElementById('leadsCiudad').value.trim();
  const box = document.getElementById('leadsBusquedaResultado');
  const btn = e.target.querySelector('button[type="submit"]');

  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Buscando… esto puede tardar unos segundos.';
  btn.disabled = true;
  btn.classList.add('is-loading');

  try {
    const res = await fetch('/api/leads/buscar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ciudad }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al buscar');

    box.classList.add('ok');
    box.textContent = `Encontrados: ${data.total_encontrados} (proveedor: ${data.proveedor}). Nuevos: ${data.nuevos}, ya existían: ${data.duplicados}.`;
    cargarLeads();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

// ==================== WEBHOOK / CONVERSACIONES ====================

let conversacionActual = null; // teléfono de la conversación abierta en el chat
let pollMensajesActuales = null;

const ICONO_CONVERSACIONES_VACIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>';
const ICONOS_ESTADO_MSG = { enviado: '✓', entregado: '✓✓', leido: '✓✓', fallido: '✕' };

function inicialesDe(nombre, telefono) {
  return (nombre || telefono || '?').trim().slice(0, 2).toUpperCase();
}

/**
 * SQLite guarda `creado_en` como "YYYY-MM-DD HH:MM:SS" en UTC (lo que
 * da `datetime('now')`), sin indicador de zona horaria. `new Date()`
 * de JS interpreta ese formato como hora LOCAL si no le decimos lo
 * contrario, así que la fecha se ve corrida por el offset horario del
 * navegador. Convertirlo a formato ISO con "Z" antes de parsear le
 * aclara que es UTC, y `toLocaleString` ya lo muestra en tu hora local.
 */
function parseFechaUTC(fechaTexto) {
  if (!fechaTexto) return null;
  return new Date(fechaTexto.replace(' ', 'T') + 'Z');
}

function formatearHora(fechaTexto) {
  if (!fechaTexto) return '';
  return parseFechaUTC(fechaTexto).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function cargarConversaciones() {
  const res = await fetch('/api/conversaciones');
  const data = await res.json();
  renderConversaciones(data.conversaciones);
  actualizarBadgeWebhook(data.conversaciones);
}

function actualizarBadgeWebhook(conversaciones) {
  const total = conversaciones.reduce((acc, c) => acc + (c.no_leidos || 0), 0);
  const badge = document.getElementById('webhookBadgeTab');
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderConversaciones(conversaciones) {
  const cont = document.getElementById('listaConversaciones');
  document.getElementById('totalConversaciones').textContent = conversaciones.length;

  if (conversaciones.length === 0) {
    cont.innerHTML = `<div class="empty-state">${ICONO_CONVERSACIONES_VACIO}<div>Todavía no llegaron mensajes al webhook.</div></div>`;
    return;
  }

  cont.innerHTML = '';
  conversaciones.forEach((c) => {
    const nombreMostrar = c.nombre || c.telefono;
    const prefijo = c.ultimo_direccion === 'saliente' ? 'Vos: ' : '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conv-item' + (c.telefono === conversacionActual ? ' active' : '');
    btn.innerHTML = `
      <span class="conv-avatar">${inicialesDe(c.nombre, c.telefono)}</span>
      <span class="conv-body">
        <span class="conv-top">
          <span class="conv-nombre">${escapeHtml(nombreMostrar)}</span>
          <span class="conv-hora">${formatearHora(c.ultimo_en)}</span>
        </span>
        <span class="conv-preview"><span>${escapeHtml(prefijo + (c.ultimo_mensaje || '').slice(0, 40))}</span></span>
      </span>
      ${c.no_leidos > 0 ? `<span class="conv-unread-badge">${c.no_leidos}</span>` : ''}
    `;
    btn.addEventListener('click', () => abrirConversacion(c.telefono, c.nombre));
    cont.appendChild(btn);
  });
}

async function abrirConversacion(telefono, nombre) {
  conversacionActual = telefono;
  document.getElementById('chatVacio').classList.add('hidden');
  document.getElementById('chatActivo').classList.remove('hidden');
  document.getElementById('chatContactoNombre').textContent = nombre || telefono;
  document.getElementById('chatContactoTelefono').textContent = nombre ? telefono : '';

  await cargarMensajes(telefono);
  cargarConversaciones(); // refresca la lista para marcar esta conversación como activa y sacar su badge

  clearInterval(pollMensajesActuales);
  pollMensajesActuales = setInterval(() => cargarMensajes(telefono), 4000);
}

async function cargarMensajes(telefono) {
  const res = await fetch(`/api/conversaciones/${encodeURIComponent(telefono)}/mensajes`);
  const data = await res.json();
  if (conversacionActual !== telefono) return; // se cambió de conversación mientras esperaba la respuesta
  renderMensajes(data.mensajes);
}

const TIPOS_CON_MEDIA = new Set(['image', 'sticker', 'video', 'audio', 'document']);

/**
 * Placeholders tipo "[Imagen]" que guarda el servidor cuando el mensaje
 * no trae caption — no tiene sentido repetirlos como texto debajo de la
 * vista previa del archivo, así que se ocultan (el media ya lo dice).
 */
const PLACEHOLDERS_MEDIA = new Set(['[Imagen]', '[Sticker]', '[Video]', '[Audio]', '[Nota de voz]']);

function renderMediaMensaje(m) {
  if (!TIPOS_CON_MEDIA.has(m.tipo) || !m.media_id) return '';
  const url = `/api/mensajes/${m.id}/media`;

  if (m.tipo === 'image' || m.tipo === 'sticker') {
    return `<img src="${url}" alt="" class="msg-media-img" loading="lazy" />`;
  }
  if (m.tipo === 'video') {
    return `<video src="${url}" controls preload="metadata" class="msg-media-video"></video>`;
  }
  if (m.tipo === 'audio') {
    return `<audio src="${url}" controls preload="metadata" class="msg-media-audio"></audio>`;
  }
  if (m.tipo === 'document') {
    const nombre = (m.texto || '').replace(/^\[Documento\]\s*/, '') || 'Descargar documento';
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-media-doc">📄 ${escapeHtml(nombre)}</a>`;
  }
  return '';
}

function renderMensajes(mensajes) {
  const cont = document.getElementById('chatMensajes');
  const estabaAbajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 40;
  cont.innerHTML = '';

  if (mensajes.length === 0) {
    cont.innerHTML = `<div class="empty-state">Todavía no hay mensajes en esta conversación.</div>`;
    return;
  }

  mensajes.forEach((m) => {
    const div = document.createElement('div');
    div.className = `msg-burbuja ${m.direccion === 'saliente' ? 'msg-saliente' : 'msg-entrante'}`;
    const tick = m.direccion === 'saliente' ? (ICONOS_ESTADO_MSG[m.estado] || '') : '';
    const media = renderMediaMensaje(m);
    const mostrarTexto = m.texto && !(media && PLACEHOLDERS_MEDIA.has(m.texto));
    div.innerHTML = `
      ${media}
      ${mostrarTexto ? `<div>${escapeHtml(m.texto)}</div>` : ''}
      <div class="msg-meta${m.estado === 'fallido' ? ' error' : ''}">
        <span class="msg-hora">${formatearHora(m.creado_en)}</span>
        ${tick ? `<span>${tick}</span>` : ''}
      </div>
    `;
    if (m.estado === 'fallido' && m.error) div.title = m.error;
    cont.appendChild(div);
  });

  if (estabaAbajo) cont.scrollTop = cont.scrollHeight;
}

document.getElementById('formResponder').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!conversacionActual) return;
  const input = document.getElementById('inputRespuesta');
  const texto = input.value.trim();
  if (!texto) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/conversaciones/${encodeURIComponent(conversacionActual)}/responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo enviar la respuesta');
    input.value = '';
    await cargarMensajes(conversacionActual);
    cargarConversaciones();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnRefrescarConversaciones').addEventListener('click', () => cargarConversaciones());

// ==================== INIT ====================

(async () => {
  const conectado = await cargarConfig();
  if (!conectado) return; // pantalla "Conectar WhatsApp" ya se mostró — no hay nada más para cargar
  cargarContactos();
  renderParametros();
  cargarConversaciones();
  setInterval(cargarConversaciones, 10000); // refresco periódico para el badge de "no leídos" en la pestaña
})();
