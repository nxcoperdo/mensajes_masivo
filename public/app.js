// Estado en memoria del frontend (sin framework — proyecto chico a propósito).
let contactos = [];
const seleccionados = new Set();
let parametros = []; // [{ tipo: 'fijo'|'nombre', valor: '' }]

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
  });
});

// ==================== CONFIG ====================

async function cargarConfig() {
  const badge = document.getElementById('configBadge');
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.whatsappConfigured) {
      badge.textContent = 'WhatsApp configurado ✓';
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = '⚠️ Falta configurar .env';
      badge.className = 'badge badge-error';
    }
  } catch {
    badge.textContent = 'No se pudo conectar al servidor';
    badge.className = 'badge badge-error';
  }
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
      <tr><td colspan="7">
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

// ==================== INIT ====================

cargarConfig();
cargarContactos();
renderParametros();
