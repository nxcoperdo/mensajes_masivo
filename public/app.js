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
      cargarCampanas();
    }
    if (btn.dataset.tab === 'leads') {
      cargarLeads();
    }
    if (btn.dataset.tab === 'webhook') {
      cargarConversaciones();
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

    if (data.cliente.estado !== 'conectado') {
      document.getElementById('navTabs').classList.add('hidden');
      document.getElementById('appMain').classList.add('hidden');
      document.getElementById('pantallaConectar').classList.remove('hidden');
      await prepararConectarWhatsApp(data.facebookAppId, data.facebookEmbeddedConfigId);
      return false;
    }

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

async function prepararConectarWhatsApp(appId, configId) {
  const box = document.getElementById('conectarResultado');
  const btn = document.getElementById('btnConectarWhatsApp');

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
          window.location.reload();
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

async function cargarCampanas() {
  const res = await fetch('/api/campanas');
  const data = await res.json();
  const tbody = document.getElementById('tablaCampanas');
  tbody.innerHTML = '';

  if (data.campanas.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">Todavía no enviaste ninguna campaña.</div>
      </td></tr>
    `;
    return;
  }

  data.campanas.forEach((c) => {
    const tr = document.createElement('tr');
    const fecha = new Date(c.creado_en).toLocaleString('es-CO');
    tr.innerHTML = `
      <td>${c.id}</td>
      <td>${c.template_nombre}</td>
      <td>${fecha}</td>
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
}

async function verDetalleCampana(id) {
  const res = await fetch(`/api/campanas/${id}/envios`);
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

function formatearHora(fechaTexto) {
  if (!fechaTexto) return '';
  return new Date(fechaTexto).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
