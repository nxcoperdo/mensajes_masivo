// Estado en memoria del frontend (sin framework — proyecto chico a propósito).
let contactos = [];
const seleccionados = new Set();
let parametros = []; // [{ tipo: 'fijo'|'nombre'|'variable', valor: '', clave: '' }]

// Empresas creadas desde el panel admin — cada una tiene su propio espacio de
// contactos/campañas (ver sección EMPRESAS más abajo); estas pestañas de acá
// arriba (Contactos/Nueva campaña) siempre operan sobre la cuenta logueada.
let empresas = [];
let esClienteAdmin = false; // seteado en cargarConfig() — gatea la gestión de números en Webhook
let misCreditos = null; // { creditos, costos: {MARKETING,UTILITY,AUTHENTICATION}, movimientos } — null si no aplica (admin o cliente con plan)
let misPlan = null; // { plan, mediosDisponibles, mediosLibres, contactosQueEntran: {MARKETING,UTILITY,AUTHENTICATION} } — null si no aplica
let planesAdminCache = []; // catálogo de planes, para el panel admin
let contactoWhatsappAdmin = null; // seteado en cargarConfig() — para el botón "Recargar" del modal de cuota
let refrescoSaldoProgramado = null;

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
// El oscuro (marca "Daemon Leads") es el default del panel — el botón
// permite pasar a claro para quien lo prefiera, y lo recuerda en
// localStorage.

const THEME_KEY = 'wa-broadcast-theme';

function aplicarTema(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function temaActualEfectivo() {
  const guardado = localStorage.getItem(THEME_KEY);
  return guardado === 'light' ? 'light' : 'dark';
}

aplicarTema(temaActualEfectivo());

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
      document.getElementById('alertContactosCampana').classList.toggle('alert-empty', seleccionados.size === 0);
      actualizarEstimadoCreditos();
    }
    if (btn.dataset.tab === 'empresas') {
      cargarEmpresas();
      cargarPlanesAdminCache().then(() => cargarClientesIndependientes());
      cargarConfigCreditos();
    }
    if (btn.dataset.tab === 'historial') {
      abrirHistorial();
    }
    if (btn.dataset.tab === 'encuestas') {
      cargarEncuestas();
    }
    if (btn.dataset.tab === 'leads') {
      cargarLeads();
    }
    if (btn.dataset.tab === 'webhook') {
      cargarConversaciones();
      if (esClienteAdmin) cargarNumeros();
    }
    if (btn.dataset.tab === 'plantillas') {
      cargarMisPlantillas();
    }
    if (btn.dataset.tab === 'solicitudes-admin') {
      cargarSolicitudesAdmin();
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
    configurarBotonNumeroPersonalizado(data.contactoWhatsapp);
    contactoWhatsappAdmin = data.contactoWhatsapp;
    esClienteAdmin = Boolean(data.cliente.es_admin);

    // El plan (y los créditos) no dependen de tener un número conectado —
    // el admin puede asignar el plan antes de asignar el número — así que
    // se cargan siempre para un cliente independiente, incluso en la rama
    // de abajo donde el panel completo todavía no se muestra.
    if (!esClienteAdmin) {
      await cargarMiPlan();
      if (!misPlan?.aplica) await cargarMisCreditos();
      // Ni plan ni saldo de créditos: no puede mandar nada todavía — le
      // ofrecemos la landing de planes (/planes.html) para que elija uno.
      const sinNadaConQueEnviar = !misPlan?.aplica && (!misCreditos?.aplica || misCreditos.creditos <= 0);
      document.getElementById('cardVerPlanes').classList.toggle('hidden', !sinNadaConQueEnviar);
      iniciarGuia(data.cliente.estado === 'conectado');
    }

    if (data.cliente.estado !== 'conectado') {
      // Todavía no tiene número asignado — igual puede pedir plantillas (el
      // admin le asigna uno de los suyos cuando la aprueba), así que no lo
      // bloqueamos del todo: dejamos solo la pestaña "Plantillas" visible en
      // vez de la pantalla completa de "Conectar WhatsApp".
      await prepararBotonConectar('btnConectarWhatsApp', () => window.location.reload());
      document.getElementById('navTabs').classList.remove('hidden');
      document.getElementById('appMain').classList.remove('hidden');
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('hidden', b.dataset.tab !== 'plantillas'));
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector('[data-tab="plantillas"]').classList.add('active');
      document.getElementById('tab-plantillas').classList.add('active');
      document.getElementById('avisoConectarPlantillas').classList.remove('hidden');
      cargarMisPlantillas();
      return false;
    }

    if (data.cliente.es_admin) {
      document.getElementById('tabBtnEmpresas').classList.remove('hidden');
      document.getElementById('tabBtnSolicitudes').classList.remove('hidden');
      document.getElementById('tabBtnLeads').classList.remove('hidden');
      document.getElementById('cardNumerosAdmin').classList.remove('hidden');
      document.getElementById('cardConfigWebhook').classList.remove('hidden');
      await prepararBotonConectar('btnAgregarNumero', () => {
        window.location.reload();
      });
    } else {
      // Un cliente independiente no gestiona números acá (eso lo hace el
      // admin desde Empresas > Empresas independientes) — solo ve, de
      // forma informativa, cuál le quedó asignado.
      document.getElementById('cardNumeroAsignado').classList.remove('hidden');
      document.getElementById('miNumeroValor').textContent = data.miNumero?.etiqueta || data.miNumero?.phone_number_id || 'Sin asignar';
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
    renumerarPasosCampana();
    return true;
  } catch {
    badge.textContent = 'No se pudo conectar al servidor';
    badge.className = 'badge badge-error';
    return false;
  }
}

/** Los pasos de "Nueva campaña" (1. Plantilla, 2. Parámetros, …) están
 * numerados a mano en el HTML — si algún paso queda oculto (ej. el de
 * "Plan" para admin, o para un cliente con plan que ya no lo necesita ver),
 * hay que renumerar los que quedan visibles para no dejar un salto. */
function renumerarPasosCampana() {
  const tarjetas = document.querySelectorAll('#tab-campana > .card, #tab-campana > #bloqueCreditosCampana');
  let n = 1;
  tarjetas.forEach((tarjeta) => {
    if (tarjeta.classList.contains('hidden') || tarjeta.classList.contains('send-bar-card')) return;
    const badge = tarjeta.querySelector('.section-header-badge');
    if (badge) badge.textContent = n++;
  });
}

// Desde "Plantillas" (cuando todavía no hay número asignado), un cliente que
// ya tiene su propia cuenta de WhatsApp Business puede igual conectarla acá.
document.getElementById('btnConectarDesdePlantillas')?.addEventListener('click', () => {
  document.getElementById('navTabs').classList.add('hidden');
  document.getElementById('appMain').classList.add('hidden');
  document.getElementById('pantallaConectar').classList.remove('hidden');
});

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

    // El SDK de Facebook valida en runtime que este callback sea una
    // función común (no async) — un callback `async` tira "Expression is
    // of type asyncfunction, not function" antes de llegar a ejecutarlo.
    // Por eso acá adentro se llama a una función async aparte en vez de
    // marcar este callback como async directamente.
    FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code || !datosEmbeddedSignup?.waba_id || !datosEmbeddedSignup?.phone_number_id) {
          btn.disabled = false;
          btn.classList.remove('is-loading');
          if (response.status !== 'unknown') {
            box.classList.remove('hidden');
            box.classList.add('error');
            box.textContent = 'No se completó la conexión con WhatsApp. Prueba de nuevo.';
          }
          return;
        }

        (async () => {
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
        })();
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

const formNumeroManual = document.getElementById('formNumeroManual');
if (formNumeroManual) {
  formNumeroManual.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('inputNumeroManual');
    const btn = formNumeroManual.querySelector('button[type="submit"]');
    const box = document.getElementById('numerosResultado');

    btn.disabled = true;
    box.classList.add('hidden');
    box.classList.remove('error', 'ok');

    try {
      const res = await fetch('/api/whatsapp/numeros/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number_id: input.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo agregar el número');
      input.value = '';
      await cargarNumeros();
    } catch (err) {
      box.classList.remove('hidden');
      box.classList.add('error');
      box.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ==================== CONTACTOS ====================

async function cargarContactos() {
  const res = await fetch('/api/contactos');
  const data = await res.json();
  contactos = Array.isArray(data.contactos) ? data.contactos : [];
  renderContactos();
  actualizarGuia();
}

const ICONO_ELIMINAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" /></svg>';
const ICONO_VER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>';
const ICONO_CONTACTOS_VACIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>';

/**
 * Convierte lo guardado (UTC, formato SQL 'YYYY-MM-DD HH:MM:SS') a la hora
 * LOCAL que espera un input datetime-local — la misma que muestra la tabla
 * (`formatearFechaHora`), para que el campo editable y la columna no se
 * contradigan.
 */
function aInputDatetimeLocal(valor) {
  const fecha = parsearFechaUtc(valor);
  if (!fecha) return '';
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}T${dosDigitos(fecha.getHours())}:${dosDigitos(fecha.getMinutes())}`;
}

/** Hasta `max` teléfonos separados por coma, y «y N más» si hay más. */
function listaCorta(items, max = 5) {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} y ${items.length - max} más`;
}

/**
 * Texto de resultado de una importación de contactos, incluyendo qué pasó
 * con la columna de fecha de envío (si el archivo la traía): cuántos quedan
 * programados, y avisos de las fechas que no se entendieron o ya pasaron.
 */
function textoResumenImportacion(data) {
  let texto = `Importados: ${data.importados} de ${data.total_filas} filas.`;
  if (data.invalidos.length > 0) {
    texto += `\nNúmeros inválidos (omitidos): ${data.invalidos.join(', ')}`;
  }

  const f = data.fechas;
  if (f && f.futuras === 0 && f.invalidas.length === 0 && f.pasadas.length === 0) {
    texto += '\nFecha de envío individual: el archivo no trajo fechas (columna fecha_envio vacía o ausente). Estos contactos no se pueden usar con "Fecha individual por contacto" hasta que les pongas una fecha; con envío inmediato o fecha común no importa.';
  }
  if (f && (f.futuras > 0 || f.invalidas.length > 0 || f.pasadas.length > 0)) {
    texto += `\nFecha de envío individual: ✓ ${f.futuras} con fecha programada · ${f.sin_fecha} sin fecha en el archivo (si ya tenían una fecha, se conserva).`;
    if (f.invalidas.length > 0) {
      texto += `\n⚠ ${f.invalidas.length} con una fecha que no se entendió (no se cambió su fecha anterior): ${listaCorta(f.invalidas.map((i) => `${i.telefono} → "${i.valor}"`), 3)}. Usa por ejemplo 25/10/2026 9:00.`;
    }
    if (f.pasadas.length > 0) {
      texto += `\n⚠ ${f.pasadas.length} con una fecha que ya pasó: en "Fecha individual por contacto" se enviarían de inmediato (${listaCorta(f.pasadas.map((p) => p.telefono))}).`;
    }
  }
  return texto;
}

/**
 * Aviso para el cuadro de confirmación del modo "Fecha individual por
 * contacto": cuántos de los contactos elegidos no tienen fecha propia (se
 * omiten) o la tienen en el pasado (se mandan ya). Vacío si no hay nada que avisar.
 */
function avisoFechasIndividuales(contactosElegidos) {
  const ahora = Date.now();
  const sinFecha = contactosElegidos.filter((c) => !c.fecha_recordatorio).length;
  const pasadas = contactosElegidos.filter((c) => {
    const fecha = parsearFechaUtc(c.fecha_recordatorio);
    return fecha && fecha.getTime() <= ahora;
  }).length;
  let aviso = '';
  if (sinFecha > 0) aviso += `\n\n⚠ ${sinFecha} contacto(s) no tienen fecha de envío propia y se van a omitir.`;
  if (pasadas > 0) aviso += `${sinFecha > 0 ? '\n' : '\n\n'}⚠ ${pasadas} contacto(s) tienen una fecha que ya pasó y se enviarán ahora mismo.`;
  return aviso;
}

const ICONO_RELOJ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>';
const ICONO_ALERTA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>';
const ICONO_VACIO_FECHA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>';

/** Etiqueta de estado de la fecha de envío individual (icono + texto, no solo color). */
function htmlBadgeFecha(contacto) {
  const estado = estadoFechaContacto(contacto);
  if (estado === 'sin') {
    return `<span class="fecha-badge fecha-badge-sin" title="Sin fecha propia: se omite si activas 'Fecha individual por contacto'">${ICONO_VACIO_FECHA} Sin fecha</span>`;
  }
  const cuando = formatearFechaHora(contacto.fecha_recordatorio);
  if (estado === 'vencida') {
    return `<span class="fecha-badge fecha-badge-vencida" title="Esta fecha ya pasó: con 'Fecha individual por contacto' se enviaría ahora mismo">${ICONO_ALERTA} Vencida · ${cuando}</span>`;
  }
  return `<span class="fecha-badge fecha-badge-ok">${ICONO_RELOJ} Programada · ${cuando}</span>`;
}

// Filtro de la lista de contactos por estado de su fecha: 'todos' | 'futura' | 'vencida' | 'sin'.
let filtroFechaContactos = 'todos';

const ETIQUETAS_FILTRO_FECHA = [
  ['todos', 'Todos'],
  ['futura', 'Con fecha'],
  ['vencida', 'Vencidas'],
  ['sin', 'Sin fecha'],
];

/** Resumen "N con fecha · M sin fecha · K vencidas" + chips para filtrar (solo si hay contactos). */
function pintarResumenFechasContactos() {
  const resumen = document.getElementById('resumenFechasContactos');
  const chips = document.getElementById('chipsFiltroFecha');
  if (contactos.length === 0) {
    resumen.classList.add('hidden');
    chips.classList.add('hidden');
    return;
  }
  const conteo = conteoFechas(contactos);
  resumen.classList.remove('hidden');
  chips.classList.remove('hidden');
  resumen.innerHTML = `
    <span class="fecha-badge fecha-badge-ok">${ICONO_RELOJ} ${conteo.futura} con fecha</span>
    <span class="fecha-badge fecha-badge-vencida">${ICONO_ALERTA} ${conteo.vencida} vencidas</span>
    <span class="fecha-badge fecha-badge-sin">${ICONO_VACIO_FECHA} ${conteo.sin} sin fecha</span>
    <button type="button" class="btn btn-sm btn-outline" id="btnSeleccionarConFecha">Seleccionar solo los que tienen fecha</button>
  `;
  chips.innerHTML = ETIQUETAS_FILTRO_FECHA.map(([clave, texto]) => {
    const n = clave === 'todos' ? contactos.length : conteo[clave];
    return `<button type="button" class="chip-filtro${filtroFechaContactos === clave ? ' activo' : ''}" data-filtro-fecha="${clave}" aria-pressed="${filtroFechaContactos === clave}">${texto} (${n})</button>`;
  }).join('');
  chips.querySelectorAll('[data-filtro-fecha]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filtroFechaContactos = btn.dataset.filtroFecha;
      renderContactos();
    });
  });
  document.getElementById('btnSeleccionarConFecha').addEventListener('click', () => {
    seleccionados.clear();
    contactos.filter((c) => estadoFechaContacto(c) !== 'sin').forEach((c) => seleccionados.add(c.id));
    renderContactos();
  });
}

/**
 * Dibuja la tabla de contactos (checkbox, teléfono, nombre, fecha de envío
 * individual, acciones) dentro de `tbody` — la usan tanto la pestaña
 * general Contactos como los contactos de una empresa, cada una con su
 * propio array/Set/callbacks, para no duplicar este bloque de UI. Un
 * contacto en edición (`editandoId`) muestra inputs en vez de texto.
 */
function renderTablaContactos({ tbody, lista, seleccionados, editandoId, totalEl, onCambioSeleccion, onEliminar, onEditar, onCancelarEdicion, onGuardarEdicion, vacioFiltrado = false }) {
  tbody.innerHTML = '';

  if (lista.length === 0 && vacioFiltrado) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          <div>Ningún contacto coincide con este filtro.</div>
          <div style="margin-top: 12px;"><button type="button" class="btn btn-sm btn-outline" data-quitar-filtro>Ver todos los contactos</button></div>
        </div>
      </td></tr>
    `;
    tbody.querySelector('[data-quitar-filtro]').addEventListener('click', () => {
      filtroFechaContactos = 'todos';
      renderContactos();
    });
    if (totalEl) totalEl.textContent = 0;
    onCambioSeleccion();
    return;
  }

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          ${ICONO_CONTACTOS_VACIO}
          <div>Todavía no has cargado contactos. Importa un CSV/Excel o agrega uno manual.</div>
          ${tbody.id === 'tablaContactos' ? `
            <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 12px;">
              <button type="button" class="btn btn-sm btn-primary" data-ir-importar>Importar archivo</button>
              <button type="button" class="btn btn-sm btn-outline" data-descargar-ejemplo>Descargar ejemplo</button>
            </div>` : ''}
        </div>
      </td></tr>
    `;
    if (totalEl) totalEl.textContent = 0;
    onCambioSeleccion();
    return;
  }

  lista.forEach((c) => {
    const tr = document.createElement('tr');
    const checked = seleccionados.has(c.id) ? 'checked' : '';
    if (editandoId === c.id) {
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${c.id}" ${checked} /></td>
        <td>${c.telefono}</td>
        <td><input type="text" class="edit-nombre" value="${c.nombre ? escapeHtml(c.nombre) : ''}" placeholder="Nombre" /></td>
        <td><input type="datetime-local" class="edit-fecha" value="${aInputDatetimeLocal(c.fecha_recordatorio)}" /></td>
        <td>
          <button type="button" class="btn btn-sm btn-primary" data-guardar="${c.id}">Guardar</button>
          <button type="button" class="btn btn-sm btn-outline" data-cancelar="${c.id}">Cancelar</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${c.id}" ${checked} /></td>
        <td>${c.telefono}</td>
        <td>${c.nombre ? escapeHtml(c.nombre) : '<span class="muted">(sin nombre)</span>'}</td>
        <td>${htmlBadgeFecha(c)}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline" data-editar="${c.id}">Editar</button>
          <button type="button" class="btn btn-sm btn-outline" data-del="${c.id}">${ICONO_ELIMINAR} Eliminar</button>
        </td>
      `;
    }
    tbody.appendChild(tr);
  });
  if (totalEl) totalEl.textContent = lista.length;
  onCambioSeleccion();

  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) seleccionados.add(id);
      else seleccionados.delete(id);
      onCambioSeleccion();
    });
  });
  tbody.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => onEliminar(Number(btn.dataset.del)));
  });
  tbody.querySelectorAll('[data-editar]').forEach((btn) => {
    btn.addEventListener('click', () => onEditar(Number(btn.dataset.editar)));
  });
  tbody.querySelectorAll('[data-cancelar]').forEach((btn) => {
    btn.addEventListener('click', () => onCancelarEdicion());
  });
  tbody.querySelectorAll('[data-guardar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      onGuardarEdicion(Number(btn.dataset.guardar), {
        nombre: tr.querySelector('.edit-nombre').value.trim(),
        fecha_recordatorio: tr.querySelector('.edit-fecha').value || null,
      });
    });
  });
}

/**
 * Dibuja la tabla de "listas guardadas" (importaciones reutilizables) — la
 * usan tanto Contactos general como los contactos de una empresa. Cada
 * importación de CSV/Excel queda acá como un grupo de ids reutilizable
 * (ver POST /api/contactos/importar), para volver a seleccionarlo sin
 * reimportar el archivo.
 */
function renderListasGuardadas({ tbody, totalEl, listas, onUsar, onEliminar }) {
  tbody.innerHTML = '';
  if (totalEl) totalEl.textContent = listas.length;

  if (listas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Todavía no hay ninguna importación guardada.</div></td></tr>`;
    return;
  }

  listas.forEach((l) => {
    const tr = document.createElement('tr');
    const notaObsoletos = l.obsoletos > 0
      ? ` <span class="muted">(${l.obsoletos} ya no existen)</span>`
      : '';
    tr.innerHTML = `
      <td>${escapeHtml(l.nombre)}</td>
      <td>${l.total}${notaObsoletos}</td>
      <td>${formatearFechaHora(l.creado_en)}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline" data-usar-lista="${l.id}"${l.total === 0 ? ' disabled' : ''}>Usar esta lista</button>
        <button type="button" class="btn btn-sm btn-outline" data-borrar-lista="${l.id}">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-usar-lista]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lista = listas.find((l) => l.id === Number(btn.dataset.usarLista));
      if (lista) onUsar(lista);
    });
  });
  tbody.querySelectorAll('[data-borrar-lista]').forEach((btn) => {
    btn.addEventListener('click', () => onEliminar(Number(btn.dataset.borrarLista)));
  });
}

/**
 * Mensaje después de "Usar esta lista": distingue entre "no quedó nada"
 * (todos los contactos de esa lista se borraron) y "quedaron algunos"
 * (se reimportó parte, o se borraron algunos sueltos).
 */
function avisarSeleccionParcial(seleccionados, guardadosEnLista) {
  if (seleccionados === 0) {
    alert('Esa lista ya no tiene contactos: se borraron después de importarla (o se reimportó el archivo). Vuelve a importar el CSV/Excel.');
  } else if (seleccionados < guardadosEnLista) {
    alert(`Se seleccionaron ${seleccionados} de ${guardadosEnLista}. Los otros ya no existen; vuelve a importar el archivo si los necesitas.`);
  }
}

let listasGuardadas = [];

async function cargarListas() {
  const res = await fetch('/api/listas');
  const data = await res.json();
  listasGuardadas = data.listas || [];
  renderListasGuardadas({
    tbody: document.getElementById('tablaListas'),
    totalEl: document.getElementById('totalListas'),
    listas: listasGuardadas,
    onUsar: async (lista) => {
      // Recargamos la tabla de contactos antes de tildar, y solo
      // seleccionamos ids que EXISTEN de verdad en la lista cargada — así
      // no queda "N seleccionados" fantasma cuando esos contactos ya se
      // borraron o se reimportaron con otro id.
      await cargarContactos();
      const cargados = new Set(contactos.map((c) => c.id));
      seleccionados.clear();
      lista.contacto_ids.forEach((id) => { if (cargados.has(id)) seleccionados.add(id); });
      renderContactos();
      const card = document.getElementById('tablaContactos').closest('.card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      avisarSeleccionParcial(seleccionados.size, lista.contacto_ids.length);
    },
    onEliminar: async (id) => {
      await fetch(`/api/listas/${id}`, { method: 'DELETE' });
      cargarListas();
    },
  });
}

/**
 * Calcula y muestra la cotización (contactos seleccionados × tarifa + IVA)
 * usando la misma tarifa que ya se configura en Historial → Tarifa —
 * la usan tanto Contactos general como la campaña de una empresa.
 * `clienteId`: null para la cuenta propia, o el id de la empresa.
 */
async function calcularYMostrarCotizacion({ contactoIds, clienteId, box, btnDescargar }) {
  if (contactoIds.length === 0) {
    alert('No hay contactos seleccionados');
    return;
  }

  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Calculando…';
  btnDescargar.classList.add('hidden');

  const qs = clienteId ? `?cliente_id=${encodeURIComponent(clienteId)}` : '';
  try {
    const res = await fetch(`/api/facturacion/config${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo obtener la tarifa configurada');

    const { tarifa_por_mensaje: tarifa, moneda, iva_porcentaje: iva } = data.config;
    if (!(tarifa > 0)) {
      box.classList.add('error');
      box.textContent = 'Todavía no hay una tarifa configurada para este cliente (botón "Tarifa" en Historial, o "Configurar tarifa" aquí).';
      return;
    }

    const subtotal = contactoIds.length * tarifa;
    const ivaMonto = subtotal * (iva / 100);
    const total = subtotal + ivaMonto;

    box.classList.add('ok');
    box.textContent = `${contactoIds.length} contactos × ${formatearTarifa(tarifa, moneda)} = ${formatearMoneda(subtotal, moneda)}` +
      (iva > 0 ? `  +  IVA (${iva}%) ${formatearMoneda(ivaMonto, moneda)}` : '') +
      `  =  Total estimado: ${formatearMoneda(total, moneda)}`;

    btnDescargar.classList.remove('hidden');
    btnDescargar.onclick = () => {
      descargarPdf(
        '/api/facturacion/cotizacion.pdf',
        `cotizacion-${new Date().toISOString().slice(0, 10)}.pdf`,
        btnDescargar,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacto_ids: contactoIds, cliente_id: clienteId || undefined }),
        }
      );
    };
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  }
}

document.getElementById('btnCotizacion').addEventListener('click', () => {
  calcularYMostrarCotizacion({
    contactoIds: Array.from(seleccionados),
    clienteId: null,
    box: document.getElementById('cotizacionResultado'),
    btnDescargar: document.getElementById('btnDescargarCotizacionPdf'),
  });
});

let editandoContactoId = null;

function renderContactos() {
  pintarResumenFechasContactos();
  const visibles = filtroFechaContactos === 'todos' ? contactos : contactos.filter((c) => estadoFechaContacto(c) === filtroFechaContactos);
  renderTablaContactos({
    tbody: document.getElementById('tablaContactos'),
    lista: visibles,
    vacioFiltrado: filtroFechaContactos !== 'todos' && contactos.length > 0,
    seleccionados,
    editandoId: editandoContactoId,
    totalEl: document.getElementById('totalContactos'),
    onCambioSeleccion: actualizarContadorSeleccion,
    onEliminar: async (id) => {
      await fetch(`/api/contactos/${id}`, { method: 'DELETE' });
      seleccionados.delete(id);
      cargarContactos();
    },
    onEditar: (id) => {
      editandoContactoId = id;
      renderContactos();
    },
    onCancelarEdicion: () => {
      editandoContactoId = null;
      renderContactos();
    },
    onGuardarEdicion: async (id, cambios) => {
      const res = await fetch(`/api/contactos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'No se pudo guardar el contacto');
        return;
      }
      editandoContactoId = null;
      cargarContactos();
    },
  });
}

function actualizarContadorSeleccion() {
  document.getElementById('seleccionadosCount').textContent = `${seleccionados.size} seleccionados`;
  actualizarEstimadoCreditos();
  // Los avisos de "Nueva campaña" dependen de qué contactos están elegidos.
  renderParametros();
  actualizarResumenFechasIndividual();
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
  const fecha_recordatorio = form.fecha_recordatorio.value || null;
  const res = await fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono, nombre, fecha_recordatorio }),
  });
  if (res.ok) {
    form.reset();
    cargarContactos();
  } else {
    const data = await res.json();
    alert(data.error || 'No se pudo agregar el contacto');
  }
});

document.getElementById('inputArchivo').addEventListener('change', (e) => {
  document.getElementById('inputArchivoNombre').textContent = e.target.files[0]?.name || 'Ningún archivo seleccionado';
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
    box.textContent = textoResumenImportacion(data);
    document.getElementById('formImportar').reset();
    document.getElementById('inputArchivoNombre').textContent = 'Ningún archivo seleccionado';
    (data.contacto_ids || []).forEach((id) => seleccionados.add(id));
    cargarContactos();
    cargarListas();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

// ==================== EMPRESAS (panel admin) ====================
//
// Cada empresa (ej: una odontología) es un espacio propio dentro del panel
// del admin: no tiene login ni conecta su propio WhatsApp — el admin elige
// acá con cuál de SUS números ya conectados manda, sube sus contactos y
// arma sus campañas. Reusa exactamente los mismos endpoints de contactos y
// campañas que las pestañas generales, pasando siempre `cliente_id =
// empresaDetalleId` en vez de operar sobre la cuenta logueada.

async function cargarEmpresas() {
  const res = await fetch('/api/admin/empresas');
  if (!res.ok) return;
  const data = await res.json();
  empresas = data.empresas || [];
  renderEmpresas();
}

function renderEmpresas() {
  document.getElementById('totalEmpresas').textContent = empresas.length;
  const tbody = document.getElementById('tablaEmpresas');
  tbody.innerHTML = '';
  if (empresas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Todavía no creaste ninguna empresa.</div></td></tr>`;
    return;
  }
  empresas.forEach((e) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(e.nombre_negocio || '(sin nombre)')}</td>
      <td>${e.phone_number_id ? escapeHtml(e.phone_number_id) : '<span class="muted">Sin asignar</span>'}</td>
      <td>${e.whatsapp_conectado ? '✓' : '—'}</td>
      <td><button class="btn btn-sm btn-outline" data-gestionar="${e.id}">Gestionar</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-gestionar]').forEach((btn) => {
    btn.addEventListener('click', () => abrirEmpresa(Number(btn.dataset.gestionar)));
  });
}

/**
 * Cuentas que se registraron solas (registro.html) — a diferencia de las
 * "empresas gestionadas" de arriba, tienen su propio login y su propio
 * panel; acá solo se les asigna uno de los números del admin para que dejen
 * de estar "pendiente_whatsapp" y puedan mandar campañas con sus plantillas.
 */
async function cargarClientesIndependientes() {
  await cargarNumerosParaSolicitudes();
  const res = await fetch('/api/admin/clientes-independientes');
  if (!res.ok) return;
  const data = await res.json();
  const tbody = document.getElementById('tablaClientesIndependientes');
  document.getElementById('totalClientesIndependientes').textContent = data.clientes.length;

  if (data.clientes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Todavía no hay cuentas registradas por su cuenta.</div></td></tr>`;
    return;
  }

  const opcionesNumero = (seleccionadoId) => `<option value="">— Sin asignar —</option>` +
    numerosAdminCache.map((n) => `<option value="${n.id}" ${seleccionadoId && n.phone_number_id === seleccionadoId ? 'selected' : ''}>${escapeHtml(n.etiqueta || n.phone_number_id)}</option>`).join('');

  const opcionesPlan = (planId) => `<option value="">— Sin plan (créditos) —</option>` +
    planesAdminCache.map((p) => `<option value="${p.id}" ${planId === p.id ? 'selected' : ''}>${escapeHtml(p.nombre)} (${p.mensajes_mes}/mes)</option>`).join('');

  tbody.innerHTML = data.clientes.map((c) => `
    <tr>
      <td>${escapeHtml(c.nombre_negocio || c.email)}</td>
      <td><select data-independiente-numero="${c.id}" class="estado-factura-select">${opcionesNumero(c.phone_number_id)}</select></td>
      <td><span class="estado-pill ${c.whatsapp_conectado ? 'estado-lista_para_enviar' : 'estado-pendiente'}">${c.whatsapp_conectado ? 'Conectada' : 'Pendiente'}</span></td>
      <td>
        <select data-independiente-plan="${c.id}" class="estado-factura-select">${opcionesPlan(c.plan_id)}</select>
        ${c.plan_contactos_disponibles ? `<div class="muted" style="font-size: 11.5px; margin-top: 4px;">Quedan ${c.plan_contactos_disponibles.MARKETING} de ${c.plan_mensajes_mes}/mes</div>` : ''}
      </td>
      <td>${c.creditos}</td>
      <td>
        <form class="inline-form" data-form-cargar-creditos="${c.id}" style="margin: 0;">
          <input type="number" step="1" placeholder="± créditos" required style="max-width: 100px" />
          <input type="text" placeholder="Motivo" required style="max-width: 150px" />
          <button type="submit" class="btn btn-sm btn-outline">Cargar</button>
        </form>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-independiente-numero]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const res2 = await fetch(`/api/admin/clientes-independientes/${e.target.dataset.independienteNumero}/numero`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp_numero_id: e.target.value || null }),
      });
      if (!res2.ok) {
        const errData = await res2.json().catch(() => ({}));
        alert(errData.error || 'No se pudo asignar el número');
      }
      cargarClientesIndependientes();
    });
  });

  tbody.querySelectorAll('[data-independiente-plan]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const res2 = await fetch(`/api/admin/clientes-independientes/${e.target.dataset.independientePlan}/plan`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: e.target.value || null }),
      });
      if (!res2.ok) {
        const errData = await res2.json().catch(() => ({}));
        alert(errData.error || 'No se pudo asignar el plan');
      }
      cargarClientesIndependientes();
    });
  });

  tbody.querySelectorAll('[data-form-cargar-creditos]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const [inputCantidad, inputMotivo] = form.querySelectorAll('input');
      const res2 = await fetch(`/api/admin/clientes-independientes/${form.dataset.formCargarCreditos}/creditos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cantidad: Number(inputCantidad.value), motivo: inputMotivo.value.trim() }),
      });
      const data2 = await res2.json();
      if (!res2.ok) {
        alert(data2.error || 'No se pudo cargar el crédito');
        return;
      }
      cargarClientesIndependientes();
    });
  });
}

async function cargarConfigCreditos() {
  const res = await fetch('/api/admin/configuracion-creditos');
  if (!res.ok) return;
  const { costos } = await res.json();
  document.getElementById('inputCostoMarketingTexto').value = costos.MARKETING.TEXTO;
  document.getElementById('inputCostoMarketingImagen').value = costos.MARKETING.IMAGEN;
  document.getElementById('inputCostoMarketingVideo').value = costos.MARKETING.VIDEO;
  document.getElementById('inputCostoUtilityTexto').value = costos.UTILITY.TEXTO;
  document.getElementById('inputCostoUtilityImagen').value = costos.UTILITY.IMAGEN;
  document.getElementById('inputCostoUtilityVideo').value = costos.UTILITY.VIDEO;
  document.getElementById('inputCostoAuthentication').value = costos.AUTHENTICATION;
}

document.getElementById('formConfigCreditos').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = document.getElementById('configCreditosResultado');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Guardando…';
  try {
    const res = await fetch('/api/admin/configuracion-creditos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        MARKETING: {
          TEXTO: Number(document.getElementById('inputCostoMarketingTexto').value),
          IMAGEN: Number(document.getElementById('inputCostoMarketingImagen').value),
          VIDEO: Number(document.getElementById('inputCostoMarketingVideo').value),
        },
        UTILITY: {
          TEXTO: Number(document.getElementById('inputCostoUtilityTexto').value),
          IMAGEN: Number(document.getElementById('inputCostoUtilityImagen').value),
          VIDEO: Number(document.getElementById('inputCostoUtilityVideo').value),
        },
        AUTHENTICATION: Number(document.getElementById('inputCostoAuthentication').value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
    box.classList.add('ok');
    box.textContent = 'Costos actualizados.';
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  }
});

/** Trae el catálogo de planes y lo renderiza en filas editables. Se espera
 * (`await`) antes de listar las empresas independientes, que necesitan el
 * catálogo cargado para armar su selector de plan. */
async function cargarPlanesAdminCache() {
  const res = await fetch('/api/admin/planes');
  if (!res.ok) return;
  const { planes } = await res.json();
  planesAdminCache = planes;

  const tbody = document.getElementById('tablaPlanesMensuales');
  tbody.innerHTML = planesAdminCache.map((p) => `
    <tr data-plan-id="${p.id}">
      <td><input type="text" value="${escapeHtml(p.nombre)}" data-campo="nombre" style="max-width: 140px" required /></td>
      <td><input type="number" min="1" step="1" value="${p.mensajes_mes}" data-campo="mensajes_mes" style="max-width: 110px" required /></td>
      <td><input type="number" min="0" step="1" value="${p.precio_sin_iva}" data-campo="precio_sin_iva" style="max-width: 130px" required /></td>
    </tr>
  `).join('');
}

document.getElementById('btnGuardarPlanes').addEventListener('click', async () => {
  const box = document.getElementById('configPlanesResultado');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Guardando…';
  try {
    const filas = Array.from(document.querySelectorAll('#tablaPlanesMensuales tr'));
    const planes = filas.map((fila) => ({
      id: Number(fila.dataset.planId) || null,
      nombre: fila.querySelector('[data-campo="nombre"]').value.trim(),
      mensajes_mes: Number(fila.querySelector('[data-campo="mensajes_mes"]').value),
      precio_sin_iva: Number(fila.querySelector('[data-campo="precio_sin_iva"]').value),
    }));
    const res = await fetch('/api/admin/planes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
    box.classList.add('ok');
    box.textContent = 'Planes actualizados.';
    await cargarPlanesAdminCache();
    cargarClientesIndependientes();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  }
});

document.getElementById('formCrearEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const nombre_negocio = document.getElementById('inputEmpresaNombre').value.trim();
  const box = document.getElementById('crearEmpresaResultado');
  const btn = form.querySelector('button[type="submit"]');

  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Creando…';
  btn.disabled = true;

  try {
    const res = await fetch('/api/admin/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre_negocio }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa');

    box.classList.add('ok');
    box.textContent = `Empresa "${data.empresa.nombre_negocio}" creada.`;
    form.reset();
    await cargarEmpresas();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Detalle de una empresa: número asignado + sus contactos + sus campañas ----

let empresaDetalleId = null;
let empresaContactos = [];
const empresaSeleccionados = new Set();
let empresaParametros = [];
let empresaLoteOffset = 0;

async function abrirEmpresa(id) {
  empresaDetalleId = id;
  const empresa = empresas.find((e) => e.id === id);
  document.getElementById('empresaDetalleNombre').textContent = empresa?.nombre_negocio || '';
  document.getElementById('empresasListado').classList.add('hidden');
  document.getElementById('empresaDetalle').classList.remove('hidden');

  empresaSeleccionados.clear();
  empresaLoteOffset = 0;
  empresaEditandoContactoId = null;
  empresaParametros = [];
  renderParametrosEmpresa();
  document.getElementById('empresaCampanaProgreso').classList.add('hidden');
  document.getElementById('cotizacionResultadoEmpresa').classList.add('hidden');
  document.getElementById('btnDescargarCotizacionPdfEmpresa').classList.add('hidden');

  await Promise.all([cargarNumerosParaEmpresa(), cargarContactosEmpresa(), cargarListasEmpresa()]);
}

document.getElementById('btnVolverEmpresas').addEventListener('click', () => {
  empresaDetalleId = null;
  document.getElementById('empresaDetalle').classList.add('hidden');
  document.getElementById('empresasListado').classList.remove('hidden');
});

/** Números ya conectados por el admin (misma fuente que la pestaña Webhook). */
async function cargarNumerosParaEmpresa() {
  const res = await fetch('/api/whatsapp/numeros');
  const data = await res.json();
  const select = document.getElementById('selectNumeroEmpresa');
  const empresa = empresas.find((e) => e.id === empresaDetalleId);
  select.innerHTML = `<option value="">— Sin asignar —</option>` +
    data.numeros.map((n) => `<option value="${n.id}">${escapeHtml(n.etiqueta || n.phone_number_id)}</option>`).join('');
  const actual = data.numeros.find((n) => n.phone_number_id === empresa?.phone_number_id);
  select.value = actual ? String(actual.id) : '';
}

document.getElementById('formNumeroEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const whatsapp_numero_id = document.getElementById('selectNumeroEmpresa').value;
  const box = document.getElementById('numeroEmpresaResultado');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Guardando…';

  try {
    const res = await fetch(`/api/admin/empresas/${empresaDetalleId}/numero`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whatsapp_numero_id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo asignar el número');
    empresas = empresas.map((e) => (e.id === data.empresa.id ? { ...e, ...data.empresa } : e));
    box.classList.add('ok');
    box.textContent = 'Número asignado.';
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  }
});

/** Query string con la empresa que se está gestionando — la usan todos los fetch de este bloque. */
function paramsEmpresaDetalle() {
  return `?cliente_id=${encodeURIComponent(empresaDetalleId)}`;
}

async function cargarContactosEmpresa() {
  const res = await fetch(`/api/contactos${paramsEmpresaDetalle()}`);
  const data = await res.json();
  empresaContactos = Array.isArray(data.contactos) ? data.contactos : [];
  renderContactosEmpresa();
}

let empresaListasGuardadas = [];

async function cargarListasEmpresa() {
  const res = await fetch(`/api/listas${paramsEmpresaDetalle()}`);
  const data = await res.json();
  empresaListasGuardadas = data.listas || [];
  renderListasGuardadas({
    tbody: document.getElementById('tablaListasEmpresa'),
    totalEl: document.getElementById('totalListasEmpresa'),
    listas: empresaListasGuardadas,
    onUsar: async (lista) => {
      await cargarContactosEmpresa();
      const cargados = new Set(empresaContactos.map((c) => c.id));
      empresaSeleccionados.clear();
      lista.contacto_ids.forEach((id) => { if (cargados.has(id)) empresaSeleccionados.add(id); });
      renderContactosEmpresa();
      const card = document.getElementById('tablaContactosEmpresa').closest('.card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      avisarSeleccionParcial(empresaSeleccionados.size, lista.contacto_ids.length);
    },
    onEliminar: async (id) => {
      await fetch(`/api/listas/${id}${paramsEmpresaDetalle()}`, { method: 'DELETE' });
      cargarListasEmpresa();
    },
  });
}

document.getElementById('btnCotizacionEmpresa').addEventListener('click', () => {
  calcularYMostrarCotizacion({
    contactoIds: Array.from(empresaSeleccionados),
    clienteId: empresaDetalleId,
    box: document.getElementById('cotizacionResultadoEmpresa'),
    btnDescargar: document.getElementById('btnDescargarCotizacionPdfEmpresa'),
  });
});

/**
 * Abre Historial con esta empresa elegida en el selector admin y dispara
 * el mismo formulario de tarifa que ya existe ahí — para no duplicar esa
 * UI, se reusa el flujo entero (cargarClientesFacturables/facturacionConfig).
 */
document.getElementById('btnConfigurarTarifaEmpresa').addEventListener('click', async () => {
  document.querySelector('.tab-btn[data-tab="historial"]').click();
  await cargarClientesFacturables();
  const empresaComoCliente = clientesFacturables.find((c) => c.cliente_id === empresaDetalleId);
  if (empresaComoCliente) {
    facturacionConfig = empresaComoCliente;
    document.getElementById('clienteFacturar').value = String(empresaDetalleId);
  }
  renderResumenTarifa();
  await cargarCampanas();
  cargarFacturas();
  document.getElementById('btnConfigTarifa').click();
});

let empresaEditandoContactoId = null;

function renderContactosEmpresa() {
  renderTablaContactos({
    tbody: document.getElementById('tablaContactosEmpresa'),
    lista: empresaContactos,
    seleccionados: empresaSeleccionados,
    editandoId: empresaEditandoContactoId,
    totalEl: document.getElementById('totalContactosEmpresa'),
    onCambioSeleccion: actualizarContadorSeleccionEmpresa,
    onEliminar: async (id) => {
      await fetch(`/api/contactos/${id}${paramsEmpresaDetalle()}`, { method: 'DELETE' });
      empresaSeleccionados.delete(id);
      cargarContactosEmpresa();
    },
    onEditar: (id) => {
      empresaEditandoContactoId = id;
      renderContactosEmpresa();
    },
    onCancelarEdicion: () => {
      empresaEditandoContactoId = null;
      renderContactosEmpresa();
    },
    onGuardarEdicion: async (id, cambios) => {
      const res = await fetch(`/api/contactos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cambios, cliente_id: empresaDetalleId }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'No se pudo guardar el contacto');
        return;
      }
      empresaEditandoContactoId = null;
      cargarContactosEmpresa();
    },
  });
}

function actualizarContadorSeleccionEmpresa() {
  document.getElementById('seleccionadosCountEmpresa').textContent = `${empresaSeleccionados.size} seleccionados`;
  document.getElementById('empresaCampanaContactosCount').textContent = empresaSeleccionados.size;
  renderParametrosEmpresa();
  actualizarResumenFechasIndividualEmpresa();
}

document.getElementById('btnSeleccionarTodosEmpresa').addEventListener('click', () => {
  const todosSeleccionados = empresaContactos.every((c) => empresaSeleccionados.has(c.id));
  if (todosSeleccionados) {
    empresaContactos.forEach((c) => empresaSeleccionados.delete(c.id));
  } else {
    empresaContactos.forEach((c) => empresaSeleccionados.add(c.id));
  }
  renderContactosEmpresa();
});

document.getElementById('btnSeleccionarLoteEmpresa').addEventListener('click', () => {
  if (empresaContactos.length === 0) return;
  const tamano = Math.max(1, Number(document.getElementById('tamanoLoteEmpresa').value) || 100);
  if (empresaLoteOffset >= empresaContactos.length) empresaLoteOffset = 0;

  const lote = empresaContactos.slice(empresaLoteOffset, empresaLoteOffset + tamano);
  empresaSeleccionados.clear();
  lote.forEach((c) => empresaSeleccionados.add(c.id));
  empresaLoteOffset += lote.length;
  renderContactosEmpresa();
});

document.getElementById('btnReiniciarLoteEmpresa').addEventListener('click', () => {
  empresaLoteOffset = 0;
});

document.getElementById('btnEliminarTodosEmpresa').addEventListener('click', async () => {
  if (empresaContactos.length === 0) return;
  if (!confirm(`¿Eliminar los ${empresaContactos.length} contactos de esta empresa? Esta acción no se puede deshacer.`)) return;
  await fetch(`/api/contactos${paramsEmpresaDetalle()}`, { method: 'DELETE' });
  empresaSeleccionados.clear();
  cargarContactosEmpresa();
});

document.getElementById('formAgregarContactoEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const telefono = form.telefono.value.trim();
  const nombre = form.nombre.value.trim();
  const fecha_recordatorio = form.fecha_recordatorio.value || null;
  const res = await fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono, nombre, fecha_recordatorio, cliente_id: empresaDetalleId }),
  });
  if (res.ok) {
    form.reset();
    cargarContactosEmpresa();
  } else {
    const data = await res.json();
    alert(data.error || 'No se pudo agregar el contacto');
  }
});

document.getElementById('formImportarEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const archivo = document.getElementById('inputArchivoEmpresa').files[0];
  if (!archivo) return;

  const formData = new FormData();
  formData.append('archivo', archivo);
  formData.append('cliente_id', empresaDetalleId);

  const box = document.getElementById('importarResultadoEmpresa');
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
    box.textContent = textoResumenImportacion(data);
    document.getElementById('formImportarEmpresa').reset();
    (data.contacto_ids || []).forEach((id) => empresaSeleccionados.add(id));
    cargarContactosEmpresa();
    cargarListasEmpresa();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

function renderParametrosEmpresa() {
  renderParametrosEn(document.getElementById('parametrosListaEmpresa'), empresaParametros, () => renderParametrosEmpresa(), {
    contactosElegidos: () => empresaContactos.filter((c) => empresaSeleccionados.has(c.id)),
    datalistId: 'columnasContactosEmpresaLista',
  });
  document.getElementById('columnasContactosEmpresaLista').innerHTML = columnasDeContactos(empresaContactos.filter((c) => empresaSeleccionados.has(c.id)))
    .map((k) => `<option value="${escapeHtml(k)}"></option>`).join('');
}

document.getElementById('btnAgregarParametroEmpresa').addEventListener('click', () => {
  empresaParametros.push({ tipo: 'nombre', valor: '', clave: '' });
  renderParametrosEmpresa();
});

document.getElementById('checkFechaIndividualEmpresa').addEventListener('change', (e) => {
  document.getElementById('campoFechaComunEmpresa').classList.toggle('hidden', e.target.checked);
  actualizarResumenFechasIndividualEmpresa();
});

document.getElementById('checkFlowBotonEmpresa').addEventListener('change', (e) => {
  document.getElementById('campoFlowActionDataEmpresa').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('btnEnviarCampanaEmpresa').addEventListener('click', async () => {
  const template_nombre = document.getElementById('templateNombreEmpresa').value.trim();
  const idioma = document.getElementById('templateIdiomaEmpresa').value.trim() || 'es';
  const contacto_ids = Array.from(empresaSeleccionados);
  const box = document.getElementById('empresaCampanaProgreso');
  const individual = document.getElementById('checkFechaIndividualEmpresa').checked;
  const fechaProgramada = document.getElementById('inputFechaProgramadaEmpresa').value;

  if (!template_nombre) {
    mostrarErrorEnvio(box, 'Escribe el nombre exacto de la plantilla.', document.getElementById('templateNombreEmpresa'));
    return;
  }
  if (contacto_ids.length === 0) {
    mostrarErrorEnvio(box, 'No hay contactos seleccionados para esta empresa. Márcalos en la lista de arriba.');
    return;
  }
  const flowBoton = document.getElementById('checkFlowBotonEmpresa').checked;
  const flowActionData = leerFlowActionData(document.getElementById('inputFlowActionDataEmpresa'));
  if (flowBoton && !flowActionData.ok) {
    mostrarErrorEnvio(box, 'El JSON de "Datos para la primera pantalla del formulario" no es válido. Déjalo vacío si no lo necesitas.', document.getElementById('inputFlowActionDataEmpresa'));
    return;
  }
  const errorParam = validarParametrosCliente(empresaParametros);
  if (errorParam) {
    mostrarErrorEnvio(box, errorParam.mensaje, document.querySelectorAll(`#parametrosListaEmpresa ${errorParam.selector}`)[errorParam.idx]);
    return;
  }
  const analisis = analizarEnvio(empresaContactos.filter((c) => empresaSeleccionados.has(c.id)), empresaParametros, individual);
  if (analisis.enviables.length === 0) {
    const motivos = [];
    if (analisis.sinDato.length > 0) motivos.push(`${analisis.sinDato.length} no tienen el dato de algún parámetro`);
    if (analisis.sinFecha.length > 0) motivos.push(`${analisis.sinFecha.length} no tienen fecha de envío propia`);
    mostrarErrorEnvio(box, `Ningún contacto seleccionado se puede enviar: ${motivos.join(' y ')}.`);
    return;
  }
  box.classList.add('hidden');
  const confirmado = await confirmarEnModal({
    cuerpoHtml: htmlResumenEnvio({
      template_nombre,
      idioma,
      cuerpo: '',
      lista: empresaParametros,
      individual,
      fechaProgramada,
      recurrente: document.getElementById('checkRecurrenteMensualEmpresa').checked,
      analisis,
    }),
    textoConfirmar: individual || fechaProgramada
      ? `Programar para ${analisis.enviables.length} ${analisis.enviables.length === 1 ? 'contacto' : 'contactos'}`
      : `Enviar a ${analisis.enviables.length} ${analisis.enviables.length === 1 ? 'contacto' : 'contactos'}`,
  });
  if (!confirmado) return;

  const btn = document.getElementById('btnEnviarCampanaEmpresa');
  btn.disabled = true;
  btn.classList.add('is-loading');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = individual ? 'Creando recordatorios…' : 'Iniciando envío…';

  try {
    const formData = new FormData();
    formData.append('cliente_id', empresaDetalleId);
    formData.append('template_nombre', template_nombre);
    formData.append('idioma', idioma);
    formData.append('contacto_ids', JSON.stringify(contacto_ids));
    formData.append('parametros', JSON.stringify(empresaParametros));
    if (individual) {
      formData.append('individual', 'true');
    } else if (fechaProgramada) {
      formData.append('fecha_programada', fechaProgramada);
    }
    if (document.getElementById('checkRecurrenteMensualEmpresa').checked) {
      formData.append('recurrente_mensual', 'true');
    }
    if (flowBoton) {
      formData.append('flow_boton', 'true');
      if (flowActionData.valor) formData.append('flow_action_data', flowActionData.valor);
    }
    const archivoImagen = document.getElementById('templateImagenEmpresa').files[0];
    if (archivoImagen) formData.append('imagen', archivoImagen);

    const res = await fetch('/api/campanas', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear la campaña');

    btn.classList.remove('is-loading');

    if (individual) {
      const hayOmitidos = data.omitidos.length > 0 || (data.omitidos_parametros || []).length > 0;
      box.classList.add(hayOmitidos ? 'error' : 'ok');
      let texto = `Se crearon ${data.creadas} envíos individuales de ${data.total} contactos. Cada uno sale en su propia fecha.`;
      if (data.omitidos.length > 0) {
        texto += `\nOmitidos (sin fecha de envío propia): ${listaCorta(data.omitidos)}`;
      }
      texto += textoOmitidosParametros(data.omitidos_parametros);
      box.textContent = texto;
      btn.disabled = false;
    } else if (data.programada) {
      box.classList.add('ok');
      box.textContent = `Campaña programada para ${new Date(fechaProgramada).toLocaleString('es-CO')}. Se mandará sola llegado el momento.`;
      btn.disabled = false;
    } else {
      pollProgresoCampana(data.campana_id, data.total, box, btn, paramsEmpresaDetalle());
    }
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

// ==================== CAMPAÑA (parámetros dinámicos) ====================

// Mismo criterio que normalizeHeader() del servidor (csv.js): minúsculas y sin acentos.
function normalizarClaveColumna(texto) {
  return String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function variablesDeContacto(contacto) {
  try {
    return JSON.parse(contacto.variables_json || '{}') || {};
  } catch {
    return {};
  }
}

/** Valor literal que recibiría este contacto en el parámetro `p` ('' si no tiene el dato). Igual que resolverParametros() del servidor. */
function valorDeParametro(p, contacto) {
  if (p.tipo === 'nombre') return String(contacto.nombre || '').trim();
  if (p.tipo === 'variable') return String(variablesDeContacto(contacto)[normalizarClaveColumna(p.clave)] ?? '').trim();
  return String(p.valor || '').trim();
}

/** Columnas extra (variables) que traen los contactos dados, para sugerirlas al elegir "dato de una columna". */
function columnasDeContactos(lista) {
  const columnas = new Set();
  lista.forEach((c) => Object.keys(variablesDeContacto(c)).forEach((k) => columnas.add(k)));
  return Array.from(columnas).sort();
}

function recortar(texto, max = 60) {
  const t = String(texto);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Texto de ayuda bajo cada parámetro: qué se enviará y a cuántos contactos les falta el dato. */
function ayudaDeParametro(p, elegidos) {
  if (p.tipo === 'fijo') {
    const valor = String(p.valor || '').trim();
    if (!valor) return { texto: 'Escribe el texto que se enviará: ahora está vacío.', nivel: 'error' };
    return { texto: `Todos recibirán exactamente: «${recortar(valor)}»`, nivel: 'ok' };
  }
  if (p.tipo === 'variable' && !String(p.clave || '').trim()) {
    return { texto: 'Indica el nombre de la columna de tu archivo que trae este dato.', nivel: 'error' };
  }
  const queDato = p.tipo === 'nombre' ? 'nombre' : `dato de la columna «${String(p.clave).trim()}»`;
  if (elegidos.length === 0) {
    return { texto: `Cada contacto recibirá tal cual su ${queDato}. Selecciona contactos para comprobarlo.`, nivel: '' };
  }
  const faltan = elegidos.filter((c) => !valorDeParametro(p, c)).length;
  if (faltan === 0) return { texto: `Los ${elegidos.length} contactos seleccionados tienen este ${p.tipo === 'nombre' ? 'nombre' : 'dato'}.`, nivel: 'ok' };
  if (faltan === elegidos.length && p.tipo === 'variable') {
    const columnas = columnasDeContactos(elegidos);
    return {
      texto: `Ningún contacto seleccionado tiene la columna «${String(p.clave).trim()}».${columnas.length ? ` Columnas disponibles: ${columnas.join(', ')}.` : ' Tus contactos no traen columnas extra.'}`,
      nivel: 'error',
    };
  }
  return { texto: `${faltan} de ${elegidos.length} contactos no tienen este ${p.tipo === 'nombre' ? 'nombre' : 'dato'} y se omitirán (no se envía vacío ni con su teléfono).`, nivel: 'warn' };
}

/** Primer error de la lista de parámetros (para frenar el envío con un mensaje claro), o null. */
function validarParametrosCliente(lista) {
  for (let i = 0; i < lista.length; i += 1) {
    const p = lista[i];
    if (p.tipo === 'fijo' && !String(p.valor || '').trim()) return { idx: i, mensaje: `Escribe el texto fijo del parámetro {{${i + 1}}} o cambia su tipo.`, selector: '.param-valor' };
    if (p.tipo === 'variable' && !String(p.clave || '').trim()) return { idx: i, mensaje: `Indica la columna del archivo para el parámetro {{${i + 1}}}.`, selector: '.param-clave' };
  }
  return null;
}

/** Texto de la plantilla con los {{N}} resaltados; con `valores` los reemplaza (y marca los que faltan). */
function htmlCuerpoPlantilla(cuerpo, valores = null) {
  return escapeHtml(cuerpo).replace(/\{\{(\d+)\}\}/g, (hueco, n) => {
    if (!valores) return `<mark class="param-hueco">${hueco}</mark>`;
    const valor = valores[Number(n) - 1];
    if (valor === undefined) return `<mark class="param-hueco param-hueco-falta">${hueco}</mark>`;
    if (valor === '') return '<mark class="param-hueco param-hueco-falta">[falta el dato]</mark>';
    return `<mark class="param-valor-previo">${escapeHtml(valor)}</mark>`;
  });
}

/** Cantidad de parámetros que pide el texto de una plantilla (el {{N}} más alto). */
function cantidadParametrosDeCuerpo(cuerpo) {
  let max = 0;
  String(cuerpo || '').replace(/\{\{(\d+)\}\}/g, (_, n) => { max = Math.max(max, Number(n)); return ''; });
  return max;
}

// Cuerpo de la plantilla elegida en "Nueva campaña" (vacío si se escribió el nombre a mano o no tiene texto cargado).
let plantillaCuerpoActual = '';

/** Refresca el texto de la plantilla, el aviso de cantidad, las columnas sugeridas y la vista previa del mensaje. */
function actualizarPanelParametros() {
  const elegidos = contactos.filter((c) => seleccionados.has(c.id));
  const bloqueCuerpo = document.getElementById('plantillaCuerpoBloque');
  const aviso = document.getElementById('parametrosAviso');
  const vista = document.getElementById('parametrosVistaPrevia');

  document.getElementById('columnasContactosLista').innerHTML = columnasDeContactos(elegidos)
    .map((k) => `<option value="${escapeHtml(k)}"></option>`).join('');

  if (!plantillaCuerpoActual) {
    bloqueCuerpo.classList.add('hidden');
    aviso.classList.add('hidden');
    vista.classList.add('hidden');
    return;
  }

  bloqueCuerpo.classList.remove('hidden');
  document.getElementById('plantillaCuerpoTexto').innerHTML = htmlCuerpoPlantilla(plantillaCuerpoActual);

  const pedidos = cantidadParametrosDeCuerpo(plantillaCuerpoActual);
  if (pedidos !== parametros.length) {
    aviso.className = 'param-aviso param-aviso-warn';
    aviso.textContent = pedidos === 0
      ? `Esta plantilla no usa parámetros, pero tienes ${parametros.length} configurados. Quítalos para no enviar datos de más.`
      : `Esta plantilla tiene ${pedidos} ${pedidos === 1 ? 'parámetro' : 'parámetros'} y tienes ${parametros.length} configurados. Deben coincidir.`;
  } else {
    aviso.className = 'param-aviso hidden';
    aviso.textContent = '';
  }

  // Vista previa con el primer contacto seleccionado que tenga todos los datos (si no hay, con el primero).
  const ejemplo = elegidos.find((c) => parametros.every((p) => valorDeParametro(p, c))) || elegidos[0];
  vista.classList.remove('hidden');
  const quien = document.getElementById('parametrosVistaPreviaQuien');
  if (ejemplo) {
    quien.textContent = `· con los datos de ${ejemplo.nombre || ejemplo.telefono}`;
    document.getElementById('parametrosVistaPreviaTexto').innerHTML = htmlCuerpoPlantilla(plantillaCuerpoActual, parametros.map((p) => valorDeParametro(p, ejemplo)));
  } else {
    quien.textContent = '· selecciona contactos para ver un ejemplo real';
    document.getElementById('parametrosVistaPreviaTexto').innerHTML = htmlCuerpoPlantilla(plantillaCuerpoActual, parametros.map((p) => (p.tipo === 'fijo' ? String(p.valor || '').trim() : undefined)));
  }
}

// ---- Estado de la fecha de envío individual de un contacto ----

/** 'sin' (no tiene), 'vencida' (ya pasó: se enviaría ahora mismo) o 'futura' (queda programada). */
function estadoFechaContacto(contacto) {
  const fecha = parsearFechaUtc(contacto.fecha_recordatorio);
  if (!fecha) return 'sin';
  return fecha.getTime() <= Date.now() ? 'vencida' : 'futura';
}

function conteoFechas(lista) {
  const conteo = { futura: 0, vencida: 0, sin: 0 };
  lista.forEach((c) => { conteo[estadoFechaContacto(c)] += 1; });
  return conteo;
}

/** Pinta bajo el checkbox "Fecha individual" cuántos de los contactos elegidos quedan programados, se envían ya o se omiten. */
function pintarResumenFechasIndividual(box, activo, elegidos) {
  if (!activo) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  if (elegidos.length === 0) {
    box.textContent = 'Selecciona contactos para ver cuántos tienen fecha propia. Con esta opción se ignora la fecha común.';
    return;
  }
  const { futura, vencida, sin } = conteoFechas(elegidos);
  const partes = [`De ${elegidos.length} contactos seleccionados: ${futura} con fecha futura (se programan)`];
  if (vencida > 0) partes.push(`${vencida} con fecha vencida (se enviarán ahora mismo)`);
  if (sin > 0) partes.push(`${sin} sin fecha (se omitirán)`);
  box.textContent = `${partes.join(' · ')}. Con esta opción se ignora la fecha común.`;
}

function actualizarResumenFechasIndividual() {
  pintarResumenFechasIndividual(
    document.getElementById('resumenFechasIndividual'),
    document.getElementById('checkFechaIndividual').checked,
    contactos.filter((c) => seleccionados.has(c.id))
  );
}

function actualizarResumenFechasIndividualEmpresa() {
  pintarResumenFechasIndividual(
    document.getElementById('resumenFechasIndividualEmpresa'),
    document.getElementById('checkFechaIndividualEmpresa').checked,
    empresaContactos.filter((c) => empresaSeleccionados.has(c.id))
  );
}

// ---- Revisión previa al envío ----

/**
 * Separa los contactos elegidos en: se enviarán, les falta el dato de un
 * parámetro, o (modo individual) no tienen fecha propia. Igual criterio que
 * el servidor, para que lo que se muestra antes sea lo que pasa después.
 */
function analizarEnvio(elegidos, lista, individual) {
  const analisis = { enviables: [], sinDato: [], sinFecha: [], vencidas: 0, futuras: 0 };
  elegidos.forEach((c) => {
    const faltantes = lista.map((p, i) => (valorDeParametro(p, c) ? 0 : i + 1)).filter(Boolean);
    if (faltantes.length > 0) {
      analisis.sinDato.push({ contacto: c, faltantes });
      return;
    }
    if (individual) {
      const estado = estadoFechaContacto(c);
      if (estado === 'sin') {
        analisis.sinFecha.push(c);
        return;
      }
      if (estado === 'vencida') analisis.vencidas += 1;
      else analisis.futuras += 1;
    }
    analisis.enviables.push(c);
  });
  return analisis;
}

function etiquetaParametro(p, idx) {
  if (p.tipo === 'nombre') return `{{${idx + 1}}} → nombre del contacto`;
  if (p.tipo === 'variable') return `{{${idx + 1}}} → columna «${escapeHtml(String(p.clave).trim())}»`;
  return `{{${idx + 1}}} → texto fijo «${escapeHtml(recortar(String(p.valor).trim()))}»`;
}

/** HTML del modal "Revisa antes de enviar". */
function htmlResumenEnvio({ template_nombre, idioma, cuerpo, lista, individual, fechaProgramada, recurrente, analisis }) {
  const filas = [];
  filas.push(`<div class="resumen-fila"><dt>Plantilla</dt><dd>${escapeHtml(template_nombre)} <span class="muted">· idioma ${escapeHtml(idioma)}</span></dd></div>`);

  if (lista.length > 0) {
    filas.push(`<div class="resumen-fila"><dt>Parámetros</dt><dd><ul class="resumen-lista">${lista.map((p, i) => `<li>${etiquetaParametro(p, i)}</li>`).join('')}</ul></dd></div>`);
  }
  if (cuerpo && analisis.enviables.length > 0) {
    const ejemplo = analisis.enviables[0];
    filas.push(`<div class="resumen-fila"><dt>Mensaje de ejemplo <span class="muted">(para ${escapeHtml(ejemplo.nombre || ejemplo.telefono)})</span></dt><dd><div class="param-preview-texto">${htmlCuerpoPlantilla(cuerpo, lista.map((p) => valorDeParametro(p, ejemplo)))}</div></dd></div>`);
  }

  let cuando;
  if (individual) {
    cuando = `Cada contacto en su propia fecha: ${analisis.futuras} programados`;
    if (analisis.vencidas > 0) cuando += `, <strong>${analisis.vencidas} con fecha vencida que se enviarán ahora mismo</strong>`;
  } else if (fechaProgramada) {
    cuando = `Programado para ${escapeHtml(new Date(fechaProgramada).toLocaleString('es-CO'))}`;
  } else {
    cuando = '<strong>Ahora mismo</strong>';
  }
  if (recurrente) cuando += ' · se repite cada mes';
  filas.push(`<div class="resumen-fila"><dt>Cuándo</dt><dd>${cuando}</dd></div>`);

  let destinatarios = `<strong>${analisis.enviables.length}</strong> ${analisis.enviables.length === 1 ? 'contacto' : 'contactos'} recibirán el mensaje`;
  filas.push(`<div class="resumen-fila"><dt>Se enviará a</dt><dd>${destinatarios}</dd></div>`);

  if (analisis.sinDato.length > 0) {
    const nombres = analisis.sinDato.map((o) => `${escapeHtml(o.contacto.telefono)} (falta {{${o.faltantes.join('}}, {{')}}})`);
    filas.push(`<div class="resumen-fila resumen-aviso"><dt>Se omitirán por falta de dato</dt><dd>${analisis.sinDato.length}: ${nombres.slice(0, 5).join(', ')}${nombres.length > 5 ? ` y ${nombres.length - 5} más` : ''}</dd></div>`);
  }
  if (analisis.sinFecha.length > 0) {
    const tels = analisis.sinFecha.map((c) => escapeHtml(c.telefono));
    filas.push(`<div class="resumen-fila resumen-aviso"><dt>Se omitirán por no tener fecha de envío</dt><dd>${analisis.sinFecha.length}: ${tels.slice(0, 5).join(', ')}${tels.length > 5 ? ` y ${tels.length - 5} más` : ''}</dd></div>`);
  }
  return `<dl>${filas.join('')}</dl>`;
}

/** Abre el modal de revisión y resuelve `true` si el usuario confirma, `false` si vuelve a corregir (botón, Esc o clic fuera). */
function confirmarEnModal({ cuerpoHtml, textoConfirmar }) {
  const modal = document.getElementById('modalResumenEnvio');
  const btnConfirmar = document.getElementById('modalResumenEnvioConfirmar');
  const btnVolver = document.getElementById('modalResumenEnvioVolver');
  const previoFoco = document.activeElement;
  document.getElementById('modalResumenEnvioCuerpo').innerHTML = cuerpoHtml;
  btnConfirmar.textContent = textoConfirmar;
  modal.classList.remove('hidden');
  btnConfirmar.focus();

  return new Promise((resolve) => {
    const cerrar = (resultado) => {
      modal.classList.add('hidden');
      document.removeEventListener('keydown', alTeclear);
      modal.removeEventListener('click', alClicFuera);
      btnConfirmar.onclick = null;
      btnVolver.onclick = null;
      if (previoFoco && previoFoco.focus) previoFoco.focus();
      resolve(resultado);
    };
    const alTeclear = (e) => { if (e.key === 'Escape') cerrar(false); };
    const alClicFuera = (e) => { if (e.target === modal) cerrar(false); };
    document.addEventListener('keydown', alTeclear);
    modal.addEventListener('click', alClicFuera);
    btnConfirmar.onclick = () => cerrar(true);
    btnVolver.onclick = () => cerrar(false);
  });
}

/** Muestra un error de validación en la caja de resultado (en vez de un alert) y lleva el foco al campo con el problema. */
function mostrarErrorEnvio(box, mensaje, campo = null) {
  box.classList.remove('hidden', 'ok');
  box.classList.add('error');
  box.textContent = mensaje;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (campo) campo.focus();
}

/** Texto de los contactos que el servidor dejó afuera por falta de dato en un parámetro. */
function textoOmitidosParametros(omitidosParametros) {
  if (!omitidosParametros || omitidosParametros.length === 0) return '';
  const detalle = omitidosParametros.map((o) => `${o.telefono} (falta ${o.faltantes.join(', ')})`);
  return `\nOmitidos por falta de dato en un parámetro: ${listaCorta(detalle)}`;
}

/**
 * Dibuja el builder de parámetros ({{1}}, {{2}}, …) dentro de `cont`, a
 * partir del array `lista` — la usan tanto la pestaña general Nueva
 * campaña como la campaña de una empresa, cada una con su propio
 * contenedor y su propio array, para no duplicar este bloque de UI.
 */
function renderParametrosEn(cont, lista, onChange, { contactosElegidos = () => [], datalistId = 'columnasContactosLista', onEdit = () => {} } = {}) {
  cont.innerHTML = '';
  lista.forEach((p, idx) => {
    const fila = document.createElement('div');
    fila.className = 'param-fila';
    const esFijo = p.tipo === 'fijo';
    const esVariable = p.tipo === 'variable';
    fila.innerHTML = `
      <div class="param-row">
        <span class="param-index" aria-hidden="true">{{${idx + 1}}}</span>
        <select data-idx="${idx}" class="param-tipo" aria-label="¿Qué va en {{${idx + 1}}}?">
          <option value="nombre" ${p.tipo === 'nombre' ? 'selected' : ''}>Nombre del contacto</option>
          <option value="variable" ${esVariable ? 'selected' : ''}>Dato de una columna del archivo</option>
          <option value="fijo" ${esFijo ? 'selected' : ''}>Texto fijo (igual para todos)</option>
        </select>
        <input type="text" data-idx="${idx}" class="param-valor${esFijo ? '' : ' hidden'}" placeholder="Escribe el texto exacto que se enviará"
          aria-label="Texto fijo de {{${idx + 1}}}" value="${escapeHtml(p.valor || '')}" />
        <input type="text" data-idx="${idx}" class="param-clave${esVariable ? '' : ' hidden'}" placeholder="Nombre de la columna (ej: fecha_cita)"
          aria-label="Columna del archivo para {{${idx + 1}}}" list="${datalistId}" autocomplete="off" value="${escapeHtml(p.clave || '')}" />
        <button type="button" class="btn-danger-sm" data-remove="${idx}" title="Quitar" aria-label="Quitar parámetro ${idx + 1}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="param-ayuda" data-ayuda="${idx}" role="status" aria-live="polite"></div>
    `;
    cont.appendChild(fila);
  });

  // Mensaje bajo cada fila: qué se enviará y a cuántos contactos les falta el dato.
  const pintarAyudas = () => {
    const elegidos = contactosElegidos();
    cont.querySelectorAll('[data-ayuda]').forEach((el) => {
      const idx = Number(el.dataset.ayuda);
      const p = lista[idx];
      const { texto, nivel } = ayudaDeParametro(p, elegidos);
      el.textContent = texto;
      el.className = `param-ayuda${nivel ? ` param-ayuda-${nivel}` : ''}`;
    });
    onEdit();
  };

  cont.querySelectorAll('.param-tipo').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.idx);
      lista[idx].tipo = e.target.value;
      onChange();
    });
  });
  cont.querySelectorAll('.param-valor').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      lista[idx].valor = e.target.value;
      pintarAyudas();
    });
    inp.addEventListener('blur', pintarAyudas);
  });
  cont.querySelectorAll('.param-clave').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.idx);
      lista[idx].clave = e.target.value;
      pintarAyudas();
    });
    inp.addEventListener('blur', pintarAyudas);
  });
  pintarAyudas();
  cont.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      lista.splice(Number(btn.dataset.remove), 1);
      onChange();
    });
  });
}

function renderParametros() {
  renderParametrosEn(document.getElementById('parametrosLista'), parametros, renderParametros, {
    contactosElegidos: () => contactos.filter((c) => seleccionados.has(c.id)),
    onEdit: actualizarPanelParametros,
  });
}

document.getElementById('btnAgregarParametro').addEventListener('click', () => {
  parametros.push({ tipo: 'nombre', valor: '', clave: '' });
  renderParametros();
});

document.getElementById('checkFechaIndividual').addEventListener('change', (e) => {
  document.getElementById('campoFechaComun').classList.toggle('hidden', e.target.checked);
  actualizarResumenFechasIndividual();
});

document.getElementById('checkFlowBoton').addEventListener('change', (e) => {
  document.getElementById('campoFlowActionData').classList.toggle('hidden', !e.target.checked);
});

/**
 * Valida el JSON opcional de `flow_action_data` antes de mandar la
 * campaña. Devuelve `{ ok, valor }`: `valor` es el string a mandar (o
 * '' si está vacío), y `ok=false` si el usuario escribió algo que no
 * parsea como JSON.
 */
function leerFlowActionData(input) {
  const texto = input.value.trim();
  if (!texto) return { ok: true, valor: '' };
  try {
    JSON.parse(texto);
    return { ok: true, valor: texto };
  } catch {
    return { ok: false, valor: texto };
  }
}

document.getElementById('btnEnviarCampana').addEventListener('click', async () => {
  const template_nombre = document.getElementById('templateNombre').value.trim();
  const idioma = document.getElementById('templateIdioma').value.trim() || 'es';
  const contacto_ids = Array.from(seleccionados);
  const box = document.getElementById('campanaProgreso');
  const individual = document.getElementById('checkFechaIndividual').checked;
  const fechaProgramada = document.getElementById('inputFechaProgramada').value;

  if (!template_nombre) {
    mostrarErrorEnvio(box, 'Escribe el nombre exacto de la plantilla (paso 1).', document.getElementById('templateNombre'));
    return;
  }
  if (contacto_ids.length === 0) {
    mostrarErrorEnvio(box, 'No hay contactos seleccionados. Elígelos en la pestaña "Contactos" y vuelve aquí.');
    return;
  }
  const flowBoton = document.getElementById('checkFlowBoton').checked;
  const flowActionData = leerFlowActionData(document.getElementById('inputFlowActionData'));
  if (flowBoton && !flowActionData.ok) {
    mostrarErrorEnvio(box, 'El JSON de "Datos para la primera pantalla del formulario" no es válido. Déjalo vacío si no lo necesitas.', document.getElementById('inputFlowActionData'));
    return;
  }

  const errorParam = validarParametrosCliente(parametros);
  if (errorParam) {
    mostrarErrorEnvio(box, errorParam.mensaje, document.querySelectorAll(`#parametrosLista ${errorParam.selector}`)[errorParam.idx]);
    return;
  }
  const elegidos = contactos.filter((c) => seleccionados.has(c.id));
  const analisis = analizarEnvio(elegidos, parametros, individual);
  if (analisis.enviables.length === 0) {
    const motivos = [];
    if (analisis.sinDato.length > 0) motivos.push(`${analisis.sinDato.length} no tienen el dato de algún parámetro`);
    if (analisis.sinFecha.length > 0) motivos.push(`${analisis.sinFecha.length} no tienen fecha de envío propia`);
    mostrarErrorEnvio(box, `Ningún contacto seleccionado se puede enviar: ${motivos.join(' y ')}. Revisa los parámetros (paso 2)${individual ? ' o las fechas en la pestaña "Contactos"' : ''}.`);
    return;
  }
  box.classList.add('hidden');

  // Solo los que se pueden enviar de verdad cuentan para la cuota o el saldo.
  const idsEnviables = analisis.enviables.map((c) => c.id);

  // Cliente con plan: si la campaña pide más de lo que queda de cuota, no
  // se reparte solo con créditos — se avisa y se deja elegir entre
  // recargar o mandar solo a los que entran (ver mostrarModalCuota).
  const categoriaCampana = document.getElementById('selectCategoriaCampana').value;
  if (misPlan?.aplica) {
    const disponibles = misPlan.contactosQueEntran[categoriaCampana] || 0;
    if (idsEnviables.length > disponibles) {
      mostrarModalCuota({
        disponibles,
        categoria: categoriaCampana,
        onEnviarParcial: () => continuarEnvioCampana(idsEnviables.slice(0, disponibles), { template_nombre, idioma, individual, fechaProgramada, flowBoton, flowActionData, categoriaCampana }),
      });
      return;
    }
  }

  const recurrente = document.getElementById('checkRecurrenteMensual').checked;
  const confirmado = await confirmarEnModal({
    cuerpoHtml: htmlResumenEnvio({ template_nombre, idioma, cuerpo: plantillaCuerpoActual, lista: parametros, individual, fechaProgramada, recurrente, analisis }),
    textoConfirmar: individual || fechaProgramada
      ? `Programar para ${analisis.enviables.length} ${analisis.enviables.length === 1 ? 'contacto' : 'contactos'}`
      : `Enviar a ${analisis.enviables.length} ${analisis.enviables.length === 1 ? 'contacto' : 'contactos'}`,
  });
  if (!confirmado) return;

  continuarEnvioCampana(contacto_ids, { template_nombre, idioma, individual, fechaProgramada, flowBoton, flowActionData, categoriaCampana });
});

/** Muestra el modal de "cuota insuficiente" con las opciones Recargar / Enviar mensajes / Cancelar. */
function mostrarModalCuota({ disponibles, categoria, onEnviarParcial }) {
  const modal = document.getElementById('modalCuotaPlan');
  document.getElementById('modalCuotaPlanTexto').textContent =
    `Te quedan ${disponibles} mensaje(s) disponibles este mes en tu plan. Puedes recargar tu plan o enviar solo a esos ${disponibles} contactos.`;

  const btnEnviar = document.getElementById('modalCuotaPlanEnviar');
  btnEnviar.textContent = disponibles > 0 ? `Enviar a ${disponibles}` : 'Enviar mensajes';
  btnEnviar.classList.toggle('hidden', disponibles <= 0);

  const linkRecargar = document.getElementById('modalCuotaPlanRecargar');
  const mensaje = encodeURIComponent(`Hola, quiero recargar/ampliar mi plan de mensajes${misPlan?.plan ? ` (${misPlan.plan.nombre})` : ''}.`);
  linkRecargar.classList.toggle('hidden', !contactoWhatsappAdmin);
  linkRecargar.href = contactoWhatsappAdmin ? `https://wa.me/${contactoWhatsappAdmin}?text=${mensaje}` : '#';

  modal.classList.remove('hidden');
  const cerrar = () => modal.classList.add('hidden');
  document.getElementById('modalCuotaPlanCancelar').onclick = cerrar;
  document.getElementById('modalCuotaPlanRecargar').onclick = () => setTimeout(cerrar, 0);
  btnEnviar.onclick = () => {
    cerrar();
    onEnviarParcial();
  };
}

/** Arma el FormData y manda la campaña — separado del handler de click para poder reusarlo desde el modal de cuota con una lista de contactos recortada. */
async function continuarEnvioCampana(contacto_ids, { template_nombre, idioma, individual, fechaProgramada, flowBoton, flowActionData, categoriaCampana }) {
  const box = document.getElementById('campanaProgreso');
  const btn = document.getElementById('btnEnviarCampana');
  btn.disabled = true;
  btn.classList.add('is-loading');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = individual ? 'Creando recordatorios…' : 'Iniciando envío…';

  try {
    const formData = new FormData();
    formData.append('template_nombre', template_nombre);
    formData.append('idioma', idioma);
    formData.append('contacto_ids', JSON.stringify(contacto_ids));
    formData.append('parametros', JSON.stringify(parametros));
    if (individual) {
      formData.append('individual', 'true');
    } else if (fechaProgramada) {
      formData.append('fecha_programada', fechaProgramada);
    }
    if (document.getElementById('checkRecurrenteMensual').checked) {
      formData.append('recurrente_mensual', 'true');
    }
    if (flowBoton) {
      formData.append('flow_boton', 'true');
      if (flowActionData.valor) formData.append('flow_action_data', flowActionData.valor);
    }
    if (!esClienteAdmin) {
      formData.append('categoria_plantilla', categoriaCampana);
    }
    const archivoImagen = document.getElementById('templateImagen').files[0];
    if (archivoImagen) formData.append('imagen', archivoImagen);

    const res = await fetch('/api/campanas', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'cuota_insuficiente') {
        box.classList.add('hidden');
        btn.disabled = false;
        btn.classList.remove('is-loading');
        mostrarModalCuota({
          disponibles: data.contactosDisponibles || 0,
          categoria: categoriaCampana,
          onEnviarParcial: () => continuarEnvioCampana(contacto_ids.slice(0, data.contactosDisponibles || 0), { template_nombre, idioma, individual, fechaProgramada, flowBoton, flowActionData, categoriaCampana }),
        });
        return;
      }
      throw new Error(data.error || 'Error al crear la campaña');
    }

    btn.classList.remove('is-loading');
    if (guia.activa) refrescarDatosGuia();

    if (individual) {
      const hayOmitidos = data.omitidos.length > 0 || (data.omitidos_parametros || []).length > 0;
      box.classList.add(hayOmitidos ? 'error' : 'ok');
      let texto = `Se crearon ${data.creadas} envíos individuales de ${data.total} contactos. Cada uno sale en su propia fecha: revísalos en "Historial".`;
      if (data.omitidos.length > 0) {
        texto += `\nOmitidos (sin fecha de envío propia): ${listaCorta(data.omitidos)}`;
      }
      texto += textoOmitidosParametros(data.omitidos_parametros);
      box.textContent = texto;
      btn.disabled = false;
    } else if (data.programada) {
      box.classList.add('ok');
      box.textContent = `Campaña programada para ${new Date(fechaProgramada).toLocaleString('es-CO')}. Se mandará sola llegado el momento — revisa "Historial".`;
      btn.disabled = false;
    } else {
      pollProgresoCampana(data.campana_id, data.total, box, btn);
    }
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/** Trae el saldo/costos de créditos del cliente logueado (no-op si es admin o si tiene plan). */
async function cargarMisCreditos() {
  const res = await fetch('/api/creditos');
  const data = await res.json();
  if (!data.aplica) {
    misCreditos = null;
    document.getElementById('bloqueCreditosCampana').classList.add('hidden');
    actualizarChipSaldo();
    return;
  }
  misCreditos = data;
  document.getElementById('bloqueCreditosCampana').classList.remove('hidden');
  document.getElementById('notaCostoCampana').textContent = 'El costo por mensaje varía si la plantilla lleva imagen o video adjunto (arriba). El estimado es en pesos, sin IVA — el 19% se muestra aparte como referencia, no se descuenta del saldo.';
  actualizarEstimadoCreditos();
  actualizarChipSaldo();
}

// ==================== CHIP DE SALDO (HEADER) ====================

let chipSaldoUltimoValor = null; // último número mostrado — de ahí arranca la animación
let chipSaldoAnimacion = null;

/** Hace "correr" el número desde `desde` hasta `hasta` en vez de saltar. */
function animarNumeroChip(elemento, desde, hasta, formato) {
  if (chipSaldoAnimacion) cancelAnimationFrame(chipSaldoAnimacion);
  const sinAnimacion = window.matchMedia('(prefers-reduced-motion: reduce)').matches || desde === hasta;
  if (sinAnimacion) {
    elemento.textContent = formato(hasta);
    return;
  }
  const duracion = 600;
  const inicio = performance.now();
  const paso = (ahora) => {
    const t = Math.min(1, (ahora - inicio) / duracion);
    const suave = 1 - Math.pow(1 - t, 3); // easeOutCubic
    elemento.textContent = formato(Math.round(desde + (hasta - desde) * suave));
    chipSaldoAnimacion = t < 1 ? requestAnimationFrame(paso) : null;
  };
  chipSaldoAnimacion = requestAnimationFrame(paso);
}

/**
 * Pinta el chip del header con lo que le queda al cliente independiente:
 * mensajes del plan (+ barra de cuota) o saldo en $ si usa créditos. Oculto
 * para el admin o si no tiene ni plan ni créditos. Se llama cada vez que se
 * recarga el plan/saldo, así baja en vivo mientras se envía una campaña.
 */
function actualizarChipSaldo() {
  const chip = document.getElementById('chipSaldo');
  if (!chip) return;

  let valor;
  let formato;
  let etiqueta;
  let detalle;
  let fraccion = null; // 0..1 de la cuota que queda (solo plan)
  let bajo = false;
  let vacio = false;

  if (!esClienteAdmin && misPlan?.aplica) {
    valor = misPlan.contactosQueEntran.MARKETING;
    const total = misPlan.plan.mensajes_mes;
    formato = (n) => `${n.toLocaleString('es-CO')} ${n === 1 ? 'mensaje' : 'mensajes'}`;
    etiqueta = 'disponibles';
    detalle = `Plan ${misPlan.plan.nombre} · ${valor.toLocaleString('es-CO')} de ${total.toLocaleString('es-CO')} mensajes este mes`;
    fraccion = total > 0 ? Math.max(0, Math.min(1, misPlan.mediosLibres / total)) : 0;
    vacio = valor <= 0;
    bajo = !vacio && fraccion < 0.15;
  } else if (!esClienteAdmin && misCreditos?.aplica) {
    valor = misCreditos.creditos;
    formato = (n) => `$${n.toLocaleString('es-CO')}`;
    etiqueta = 'saldo';
    detalle = `Saldo disponible: $${valor.toLocaleString('es-CO')} COP`;
    const costoBase = misCreditos.costos?.UTILITY?.TEXTO || misCreditos.costos?.MARKETING?.TEXTO || 0;
    vacio = valor <= 0;
    bajo = !vacio && costoBase > 0 && valor < costoBase * 10;
  } else {
    chip.classList.add('hidden');
    chipSaldoUltimoValor = null;
    return;
  }

  chip.classList.remove('hidden');
  chip.classList.toggle('sin-barra', fraccion === null);
  chip.classList.toggle('is-bajo', bajo);
  chip.classList.toggle('is-vacio', vacio);
  chip.title = detalle;
  document.getElementById('chipSaldoLabel').textContent = etiqueta;
  document.getElementById('chipSaldoBarra').firstElementChild.style.width = `${Math.round((fraccion ?? 0) * 100)}%`;

  const elValor = document.getElementById('chipSaldoValor');
  const anterior = chipSaldoUltimoValor ?? valor;
  animarNumeroChip(elValor, anterior, valor, formato);
  if (valor < anterior) {
    chip.classList.remove('is-bajando');
    void chip.offsetWidth; // reinicia la animación si baja varias veces seguidas
    chip.classList.add('is-bajando');
    setTimeout(() => chip.classList.remove('is-bajando'), 500);
  }
  chipSaldoUltimoValor = valor;
}

document.getElementById('chipSaldo')?.addEventListener('click', () => {
  if (chipSaldoUltimoValor !== null && chipSaldoUltimoValor <= 0 && !misPlan?.aplica) {
    window.open('/planes.html', '_blank', 'noopener');
    return;
  }
  document.querySelector('.tab-btn[data-tab="plantillas"]')?.click();
});

async function refrescarEstadoCobro() {
  if (esClienteAdmin) return;
  if (misPlan?.aplica) {
    await cargarMiPlan();
    return;
  }
  await cargarMisCreditos();
}

function iniciarRefrescoEstadoCobro() {
  if (refrescoSaldoProgramado) return;
  refrescoSaldoProgramado = setInterval(() => {
    if (document.hidden) return;
    refrescarEstadoCobro();
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refrescarEstadoCobro();
  });
  window.addEventListener('focus', () => {
    refrescarEstadoCobro();
  });
}

/** Trae la cuota del plan mensual del cliente logueado (no-op si no tiene plan asignado). */
async function cargarMiPlan() {
  const res = await fetch('/api/plan');
  const data = await res.json();
  if (!data.aplica) {
    misPlan = null;
    document.getElementById('cardMiPlan').classList.add('hidden');
    actualizarChipSaldo();
    return;
  }
  misPlan = data;
  // A un cliente con plan ya no le mostramos la tarjeta "Plan" de "Nueva
  // campaña" (categoría + estimado) — con la regla de "todo vale igual" no
  // le aporta nada verla. El <select> de categoría sigue en el DOM oculto,
  // así que la campaña se sigue mandando con una categoría válida por
  // detrás (el backend la sigue pidiendo, pero ya no afecta el costo).
  document.getElementById('bloqueCreditosCampana').classList.add('hidden');

  document.getElementById('cardMiPlan').classList.remove('hidden');
  document.getElementById('miPlanNombre').textContent = misPlan.plan.nombre;
  document.getElementById('miPlanAsignados').textContent = `${misPlan.plan.mensajes_mes} mensajes/mes`;
  const disponibles = misPlan.contactosQueEntran.MARKETING;
  document.getElementById('miPlanDisponibles').textContent = `${disponibles} mensajes`;

  // Se le acabó la cuota del mes — el botón grande lo manda por WhatsApp a
  // pedir que le renueven/amplíen el plan (no hay pasarela de pagos
  // todavía, es 100% manual por el admin).
  const btnRestaurar = document.getElementById('btnRestaurarPlan');
  btnRestaurar.classList.toggle('hidden', disponibles > 0 || !contactoWhatsappAdmin);
  if (contactoWhatsappAdmin) {
    const mensaje = encodeURIComponent(`Hola, ya usé todos los mensajes de mi plan ${misPlan.plan.nombre} este mes — quiero restaurarlo/ampliarlo.`);
    btnRestaurar.href = `https://wa.me/${contactoWhatsappAdmin}?text=${mensaje}`;
  }
  actualizarChipSaldo();
}

/** Mismo criterio que `tipoEncabezado` del server: null = texto plano. */
const EXTENSIONES_VIDEO_ENCABEZADO = ['.mp4', '.3gp', '.3gpp'];
function tipoEncabezadoSeleccionado() {
  const archivo = document.getElementById('templateImagen')?.files?.[0];
  if (!archivo) return null;
  const ext = archivo.name.slice(archivo.name.lastIndexOf('.')).toLowerCase();
  return EXTENSIONES_VIDEO_ENCABEZADO.includes(ext) ? 'video' : 'image';
}

/** Recalcula el estimado en "Nueva campaña" — en pesos si el cliente usa créditos, en mensajes de cuota si tiene plan. */
function actualizarEstimadoCreditos() {
  const texto = document.getElementById('estimadoCreditosCampana');
  if (!texto) return;
  const categoria = document.getElementById('selectCategoriaCampana').value;

  if (misPlan?.aplica) {
    const disponibles = misPlan.contactosQueEntran[categoria] || 0;
    const alcanza = seleccionados.size <= disponibles;
    texto.textContent = `Te quedan ${disponibles} mensaje(s) disponibles este mes en el plan ${misPlan.plan.nombre}.${
      seleccionados.size > 0 ? ` Elegiste ${seleccionados.size} contacto(s)${alcanza ? '' : ' — no alcanza, te va a avisar al enviar'}.` : ''
    }`;
    texto.classList.toggle('error-text', seleccionados.size > 0 && !alcanza);
    return;
  }

  if (!misCreditos) return;
  let costoUnitario = 0;
  if (categoria === 'AUTHENTICATION') {
    costoUnitario = misCreditos.costos.AUTHENTICATION || 0;
  } else {
    const tipo = tipoEncabezadoSeleccionado();
    const clave = tipo === 'video' ? 'VIDEO' : tipo === 'image' ? 'IMAGEN' : 'TEXTO';
    costoUnitario = misCreditos.costos[categoria]?.[clave] || 0;
  }
  const total = costoUnitario * seleccionados.size;
  const conIva = Math.round(total * (1 + (misCreditos.ivaPorcentaje || 0)));
  const restante = misCreditos.creditos - total;
  texto.textContent = `${seleccionados.size} contacto(s) × $${costoUnitario} = $${total} (+ IVA 19% = $${conIva} si se factura). Saldo actual: $${misCreditos.creditos}${
    total > 0 ? ` — te quedarían $${restante}${restante < 0 ? ' (no te alcanza)' : ''}` : ''
  }.`;
  texto.classList.toggle('error-text', restante < 0);
}

document.getElementById('selectCategoriaCampana').addEventListener('change', actualizarEstimadoCreditos);
document.getElementById('templateImagen').addEventListener('change', actualizarEstimadoCreditos);
document.getElementById('templateImagen').addEventListener('change', (e) => {
  document.getElementById('templateImagenNombre').textContent = e.target.files[0]?.name || 'Ningún archivo seleccionado';
});

/** `paramsCliente`: query string opcional (ej: `?cliente_id=5`) cuando se está polleando la campaña de una empresa en vez de la cuenta propia. */
async function pollProgresoCampana(campanaId, total, box, btn, paramsCliente = '') {
  const interval = setInterval(async () => {
    const res = await fetch(`/api/campanas/${campanaId}${paramsCliente}`);
    const data = await res.json();
    const c = data.campana;
    const procesados = c.enviados + c.fallidos;

    box.textContent = `Procesando: ${procesados} / ${total} (✓ ${c.enviados} enviados, ✕ ${c.fallidos} fallidos)`;

    // El servidor descuenta mensaje a mensaje — refrescamos el saldo en cada
    // tick para que el chip del header vaya bajando mientras se envía.
    if (c.estado !== 'completada') refrescarEstadoCobro();

    if (c.estado === 'completada') {
      clearInterval(interval);
      box.classList.add(c.fallidos > 0 ? 'error' : 'ok');
      box.textContent = `Listo. ✓ ${c.enviados} enviados, ✕ ${c.fallidos} fallidos de ${total}. Revisa el detalle en "Historial".`;
      btn.disabled = false;
      refrescarEstadoCobro();
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

/**
 * Mientras haya alguna campaña en 'procesando' (una programada que ya
 * arrancó a mandar sola, o un envío en curso desde otra pestaña/sesión),
 * se sigue refrescando la lista sola cada 2s — mismo criterio que
 * `pollProgresoCampana` para un envío inmediato, pero a nivel de toda la
 * tabla porque acá no hay un único `campanaId` que observar. Se corta
 * sola en cuanto no queda nada en curso, y el `timeout` guardado evita
 * que se dupare la cadena si `cargarCampanas()` se llama desde otro lado
 * (cambio de cliente, etc.) mientras ya hay una corriendo.
 */
let refrescoCampanasProgramado = null;

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

  const hayEnCurso = campanas.some((c) => c.estado === 'procesando');
  if (hayEnCurso && !refrescoCampanasProgramado) {
    refrescoCampanasProgramado = setTimeout(() => {
      refrescoCampanasProgramado = null;
      if (document.getElementById('tab-historial').classList.contains('active')) {
        cargarCampanas();
      }
    }, 2000);
  }
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
      <td>
        <span class="estado-pill estado-${c.estado}">${c.estado}${c.recurrente_mensual ? ' 🔁' : ''}</span>
        ${c.estado === 'programada' && c.fecha_programada ? `<div class="muted" style="margin-top:4px;font-size:11px;">Para: ${formatearFechaHora(c.fecha_programada)}</div>` : ''}
      </td>
      <td>${c.enviados}</td>
      <td>${c.entregados}</td>
      <td>${c.leidos}</td>
      <td>${c.fallidos}</td>
      <td>
        <button class="btn btn-sm btn-outline" data-ver="${c.id}">${ICONO_VER} Ver detalle</button>
        ${c.estado === 'programada' ? `<button class="btn btn-sm btn-danger" data-cancelar="${c.id}">Cancelar</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-ver]').forEach((btn) => {
    btn.addEventListener('click', () => verDetalleCampana(Number(btn.dataset.ver)));
  });
  tbody.querySelectorAll('[data-cancelar]').forEach((btn) => {
    btn.addEventListener('click', () => cancelarCampana(Number(btn.dataset.cancelar)));
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

  for (const id of ['btnEstadisticas', 'btnReportePdf', 'btnHistorialPdf', 'btnGenerarFactura']) {
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

/** Cancela una campaña todavía no disparada (solo tiene sentido en estado 'programada') — si era mensual, corta la cadena. */
async function cancelarCampana(id) {
  if (!confirm('¿Cancelar esta campaña programada? No se va a mandar (ni a repetirse el próximo mes, si era mensual).')) return;
  const res = await fetch(`/api/campanas/${id}/cancelar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliente_id: esAdminFacturacion && facturacionConfig ? facturacionConfig.cliente_id : undefined }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'No se pudo cancelar la campaña');
    return;
  }
  cargarCampanas();
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

// ==================== ENCUESTAS (respuestas de WhatsApp Flow) ====================

let encuestaCampanas = [];

async function cargarEncuestas() {
  const box = document.getElementById('encuestaResultado');
  box.classList.add('hidden');
  try {
    const res = await fetch('/api/flow/campanas');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las campañas de formulario');
    encuestaCampanas = data.campanas || [];
  } catch (err) {
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
    return;
  }

  const vacia = document.getElementById('encuestaVacia');
  const resumen = document.getElementById('encuestaResumen');
  const select = document.getElementById('selectEncuesta');

  if (encuestaCampanas.length === 0) {
    vacia.classList.remove('hidden');
    resumen.classList.add('hidden');
    select.innerHTML = '';
    document.getElementById('btnDescargarRespuestasCsv').classList.add('hidden');
    return;
  }

  vacia.classList.add('hidden');
  const seleccionActual = select.value;
  select.innerHTML = encuestaCampanas
    .map((c) => `<option value="${c.id}">#${c.id} · ${escapeHtml(c.template_nombre)} · ${c.respondidos}/${c.enviados} respondieron</option>`)
    .join('');
  if (seleccionActual && encuestaCampanas.some((c) => String(c.id) === seleccionActual)) {
    select.value = seleccionActual;
  }
  await cargarEstadisticasEncuesta();
}

async function cargarEstadisticasEncuesta() {
  const select = document.getElementById('selectEncuesta');
  const campanaId = select.value;
  if (!campanaId) return;
  const box = document.getElementById('encuestaResultado');
  const resumen = document.getElementById('encuestaResumen');
  box.classList.add('hidden');

  try {
    const res = await fetch(`/api/flow/estadisticas?campana_id=${encodeURIComponent(campanaId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las estadísticas');
    renderEstadisticasEncuesta(data);
    resumen.classList.remove('hidden');
    document.getElementById('btnDescargarRespuestasCsv').classList.toggle('hidden', data.respondidos === 0);
  } catch (err) {
    resumen.classList.add('hidden');
    box.classList.remove('hidden');
    box.classList.add('error');
    box.textContent = err.message;
  }
}

function renderEstadisticasEncuesta(data) {
  document.getElementById('encuestaEnviados').textContent = formatearNumero(data.enviados);
  document.getElementById('encuestaRespondidos').textContent = formatearNumero(data.respondidos);
  document.getElementById('encuestaTasa').textContent = `${Math.round((data.tasa || 0) * 100)}%`;

  const cont = document.getElementById('encuestaPreguntas');
  if (!data.preguntas || data.preguntas.length === 0) {
    cont.innerHTML = `<p class="muted">Todavía no llegó ninguna respuesta de este formulario.</p>`;
    return;
  }

  cont.innerHTML = data.preguntas
    .map((p) => {
      if (p.tipo === 'opciones') {
        const barras = p.opciones
          .map((o) => {
            const pct = Math.round((o.pct || 0) * 100);
            return `
              <div class="encuesta-barra">
                <span class="encuesta-barra-valor">${escapeHtml(o.valor)}</span>
                <span class="encuesta-barra-track"><span class="encuesta-barra-fill" style="width:${pct}%"></span></span>
                <span class="encuesta-barra-num">${o.n} · ${pct}%</span>
              </div>`;
          })
          .join('');
        return `<div class="encuesta-pregunta"><h4>${escapeHtml(p.etiqueta)} <span>(${p.total} respuestas)</span></h4>${barras}</div>`;
      }
      const items = p.textos
        .map((t) => `<li>${escapeHtml(t.valor)} <span>— ${escapeHtml(t.nombre || t.telefono)}</span></li>`)
        .join('');
      return `<div class="encuesta-pregunta"><h4>${escapeHtml(p.etiqueta)} <span>(${p.total} respuestas abiertas)</span></h4><ul class="encuesta-textos">${items || '<li class="muted">Sin respuestas todavía</li>'}</ul></div>`;
    })
    .join('');
}

document.getElementById('selectEncuesta').addEventListener('change', cargarEstadisticasEncuesta);
document.getElementById('btnRefrescarEncuesta').addEventListener('click', cargarEncuestas);
document.getElementById('btnDescargarRespuestasCsv').addEventListener('click', (e) => {
  const campanaId = document.getElementById('selectEncuesta').value;
  if (!campanaId) return;
  descargarPdf(
    `/api/flow/respuestas.csv?campana_id=${encodeURIComponent(campanaId)}`,
    `respuestas-formulario-${campanaId}.csv`,
    e.currentTarget
  );
});

// ---- Descargas de PDF ----

/**
 * Los PDF se piden con fetch (no con un `window.open`) para poder
 * mostrar el mensaje de error del servidor si algo sale mal, en vez de
 * abrir una pestaña con un JSON crudo. `opcionesFetch` permite pedirlo
 * por POST (con body) en vez de GET — necesario cuando el parámetro no
 * entra en una URL (ej: cientos de `contacto_ids` se pasan del límite de
 * largo de request que aceptan navegadores/proxies, ver cotización).
 */
async function descargarPdf(url, nombreSugerido, btn, opcionesFetch = {}) {
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const res = await fetch(url, opcionesFetch);
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

document.getElementById('btnHistorialPdf').addEventListener('click', () => {
  const ids = idsSeleccionados();
  if (ids.length === 0) return;
  const params = new URLSearchParams({ ids: ids.join(',') });
  if (esAdminFacturacion && facturacionConfig) params.set('cliente_id', facturacionConfig.cliente_id);
  descargarPdf(
    `/api/facturacion/historial.pdf?${params}`,
    `historial-detallado-${new Date().toISOString().slice(0, 10)}.pdf`,
    document.getElementById('btnHistorialPdf')
  );
});

document.getElementById('btnGenerarFactura').addEventListener('click', async () => {
  const ids = idsSeleccionados();
  if (ids.length === 0) return;

  if (!facturacionConfig || !(facturacionConfig.tarifa_por_mensaje > 0)) {
    mostrarResultadoFacturacion('Configura primero la tarifa por mensaje (botón "Tarifa").', 'error');
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
        <div class="empty-state">Todavía no emitiste facturas. Selecciona campañas arriba y usa "Generar factura".</div>
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
          <div>Todavía no hay leads. Busca un rubro y una ciudad arriba.</div>
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
  if (guia.activa) {
    guia.conversaciones = data.conversaciones;
    actualizarGuia();
  }
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
    cont.innerHTML = esClienteAdmin
      ? `<div class="empty-state">${ICONO_CONVERSACIONES_VACIO}<div>Todavía no han llegado mensajes al webhook.</div></div>`
      : `<div class="empty-state">${ICONO_CONVERSACIONES_VACIO}
          <div>Todavía no te han respondido. Cuando alguien responda una de tus campañas, la conversación aparece aquí.</div>
          <button type="button" class="btn btn-sm btn-outline" data-ir-a="campana" style="margin-top: 12px;">Enviar una campaña</button>
        </div>`;
    return;
  }

  cont.innerHTML = '';
  conversaciones.forEach((c) => {
    const nombreMostrar = c.nombre || c.telefono;
    const prefijo = c.ultimo_direccion === 'saliente' ? 'Tú: ' : '';
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
        ${esClienteAdmin && c.via ? `<span class="conv-via">vía ${escapeHtml(c.via)}</span>` : ''}
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

// ==================== PLANTILLAS (solicitudes) ====================
//
// Cualquier cliente arma acá su plantilla con el mismo formato que pide el
// creador de plantillas de Meta y la manda como "solicitud" (POST
// /api/plantillas). El admin ve todas las de todos los clientes en la
// pestaña "Solicitudes" (GET /api/admin/plantillas) y les va cambiando el
// estado y asignando un número (PATCH /api/admin/plantillas/:id).

let botonesPlantilla = []; // [{ tipo: 'QUICK_REPLY'|'URL'|'PHONE_NUMBER', texto, url, telefono }]
let numerosAdminCache = []; // números del admin, para el selector de "Solicitudes"

/** Arma el botón "Escribirnos por WhatsApp" de la tarjeta de número personalizado. */
function configurarBotonNumeroPersonalizado(contactoWhatsapp) {
  const link = document.getElementById('linkNumeroPersonalizado');
  const sinContacto = document.getElementById('sinContactoWhatsapp');
  if (!contactoWhatsapp) {
    link.classList.add('hidden');
    sinContacto.classList.remove('hidden');
    return;
  }
  const mensaje = encodeURIComponent('Hola! Quiero un número de WhatsApp personalizado (con perfil de WhatsApp Business propio) para mis plantillas.');
  link.href = `https://wa.me/${contactoWhatsapp}?text=${mensaje}`;
  link.classList.remove('hidden');
  sinContacto.classList.add('hidden');
}

const ETIQUETAS_ESTADO_PLANTILLA = {
  pendiente: 'Pendiente',
  esperando_confirmacion: 'Esperando confirmación',
  lista_para_enviar: 'Lista para enviar',
  rechazada: 'Rechazada',
  cancelada: 'Cancelada',
};

function renderBotonesPlantilla() {
  const cont = document.getElementById('listaBotonesPlantilla');
  cont.innerHTML = '';
  botonesPlantilla.forEach((b, idx) => {
    const row = document.createElement('div');
    row.className = 'param-row';
    row.innerHTML = `
      <span class="param-index">${idx + 1}</span>
      <select data-idx="${idx}" class="boton-tipo">
        <option value="QUICK_REPLY" ${b.tipo === 'QUICK_REPLY' ? 'selected' : ''}>Respuesta rápida</option>
        <option value="URL" ${b.tipo === 'URL' ? 'selected' : ''}>Ir a un sitio (URL)</option>
        <option value="PHONE_NUMBER" ${b.tipo === 'PHONE_NUMBER' ? 'selected' : ''}>Llamar a un número</option>
      </select>
      <input type="text" data-idx="${idx}" class="boton-texto" placeholder="Texto del botón" value="${escapeHtml(b.texto || '')}" maxlength="25" />
      <input type="text" data-idx="${idx}" class="boton-url" placeholder="https://…" value="${escapeHtml(b.url || '')}" ${b.tipo === 'URL' ? '' : 'disabled'} />
      <input type="text" data-idx="${idx}" class="boton-telefono" placeholder="Teléfono (ej: 3001234567)" value="${escapeHtml(b.telefono || '')}" ${b.tipo === 'PHONE_NUMBER' ? '' : 'disabled'} />
      <button type="button" class="btn-danger-sm" data-remove="${idx}" title="Quitar" aria-label="Quitar botón ${idx + 1}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    `;
    cont.appendChild(row);
  });

  cont.querySelectorAll('.boton-tipo').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      botonesPlantilla[Number(e.target.dataset.idx)].tipo = e.target.value;
      renderBotonesPlantilla();
    });
  });
  cont.querySelectorAll('.boton-texto').forEach((inp) => {
    inp.addEventListener('input', (e) => { botonesPlantilla[Number(e.target.dataset.idx)].texto = e.target.value; });
  });
  cont.querySelectorAll('.boton-url').forEach((inp) => {
    inp.addEventListener('input', (e) => { botonesPlantilla[Number(e.target.dataset.idx)].url = e.target.value; });
  });
  cont.querySelectorAll('.boton-telefono').forEach((inp) => {
    inp.addEventListener('input', (e) => { botonesPlantilla[Number(e.target.dataset.idx)].telefono = e.target.value; });
  });
  cont.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      botonesPlantilla.splice(Number(btn.dataset.remove), 1);
      renderBotonesPlantilla();
    });
  });
}

document.getElementById('btnAgregarBotonPlantilla').addEventListener('click', () => {
  botonesPlantilla.push({ tipo: 'QUICK_REPLY', texto: '', url: '', telefono: '' });
  renderBotonesPlantilla();
});

document.getElementById('selectPlantillaHeaderTipo').addEventListener('change', (e) => {
  document.getElementById('campoPlantillaHeaderTexto').classList.toggle('hidden', e.target.value !== 'TEXT');
  document.getElementById('campoPlantillaHeaderMuestra').classList.toggle('hidden', !['IMAGE', 'VIDEO', 'DOCUMENT'].includes(e.target.value));
});

document.getElementById('inputPlantillaMuestra').addEventListener('change', (e) => {
  document.getElementById('inputPlantillaMuestraNombre').textContent = e.target.files[0]?.name || 'Ningún archivo seleccionado';
});

document.getElementById('inputPlantillaNombre').addEventListener('input', (e) => {
  const limpio = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (limpio !== e.target.value) e.target.value = limpio;
});

document.getElementById('inputPlantillaBody').addEventListener('input', (e) => {
  const contador = document.getElementById('contadorPlantillaBody');
  contador.textContent = `${e.target.value.length} / 1024`;
  contador.classList.toggle('error-text', e.target.value.length > 900);
});

document.getElementById('formSolicitudPlantilla').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = document.getElementById('solicitudPlantillaResultado');
  box.classList.remove('hidden', 'error', 'ok');
  box.textContent = 'Enviando…';

  const formData = new FormData();
  formData.append('nombre', document.getElementById('inputPlantillaNombre').value.trim().toLowerCase());
  formData.append('categoria', document.getElementById('selectPlantillaCategoria').value);
  formData.append('idioma', document.getElementById('inputPlantillaIdioma').value.trim() || 'es');
  formData.append('header_tipo', document.getElementById('selectPlantillaHeaderTipo').value);
  formData.append('header_texto', document.getElementById('inputPlantillaHeaderTexto').value.trim());
  formData.append('body_texto', document.getElementById('inputPlantillaBody').value.trim());
  formData.append('footer_texto', document.getElementById('inputPlantillaFooter').value.trim());
  formData.append('botones_json', JSON.stringify(botonesPlantilla));
  const muestra = document.getElementById('inputPlantillaMuestra').files[0];
  if (muestra) formData.append('muestra_encabezado', muestra);

  try {
    const res = await fetch('/api/plantillas', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo enviar la solicitud');

    box.classList.add('ok');
    box.textContent = 'Solicitud enviada — te avisamos aquí mismo cuando cambie de estado.';
    e.target.reset();
    botonesPlantilla = [];
    renderBotonesPlantilla();
    document.getElementById('campoPlantillaHeaderTexto').classList.add('hidden');
    document.getElementById('campoPlantillaHeaderMuestra').classList.add('hidden');
    document.getElementById('contadorPlantillaBody').textContent = '0 / 1024';
    document.getElementById('contadorPlantillaBody').classList.remove('error-text');
    document.getElementById('inputPlantillaMuestraNombre').textContent = 'Ningún archivo seleccionado';
    cargarMisPlantillas();
  } catch (err) {
    box.classList.add('error');
    box.textContent = err.message;
  }
});

function renderResumenPlantilla(p) {
  const partes = [];
  if (p.header_tipo !== 'NONE') partes.push(`Encabezado: ${p.header_tipo}`);
  partes.push(p.body_texto.length > 80 ? `${p.body_texto.slice(0, 80)}…` : p.body_texto);
  if (p.botones?.length) partes.push(`${p.botones.length} botón(es)`);
  let resumen = escapeHtml(partes.join(' — '));
  if (p.header_media_url) {
    resumen += ` <a href="${escapeHtml(p.header_media_url)}" target="_blank" rel="noopener">📎 ver muestra</a>`;
  }
  return resumen;
}

async function cargarMisPlantillas() {
  const res = await fetch('/api/plantillas');
  const data = await res.json();
  const tbody = document.getElementById('tablaMisPlantillas');
  document.getElementById('totalMisPlantillas').textContent = data.solicitudes.length;

  tbody.innerHTML = data.solicitudes.map((p) => `
    <tr>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${escapeHtml(p.categoria)}</td>
      <td>${escapeHtml(p.numero_asignado || 'Sin asignar')}</td>
      <td><span class="estado-pill estado-${p.estado}">${ETIQUETAS_ESTADO_PLANTILLA[p.estado] || p.estado}</span></td>
      <td>${new Date(p.creado_en).toLocaleDateString('es-CO')}</td>
    </tr>
  `).join('') || `<tr><td colspan="5">
      <div class="empty-state">
        <div>Todavía no has pedido ninguna plantilla. Completa el formulario de arriba para pedir la primera.</div>
        <button type="button" class="btn btn-sm btn-outline" data-ir-form-plantilla style="margin-top: 12px;">Pedir mi primera plantilla</button>
      </div>
    </td></tr>`;

  if (guia.activa) {
    guia.plantillas = data.solicitudes;
    actualizarDatalistPlantillas(guia.plantillas);
    actualizarGuia();
  }
}

/** Números ya conectados por el admin — misma fuente que la pestaña Webhook. */
async function cargarNumerosParaSolicitudes() {
  const res = await fetch('/api/whatsapp/numeros');
  const data = await res.json();
  numerosAdminCache = data.numeros;
}

async function cargarSolicitudesAdmin() {
  await cargarNumerosParaSolicitudes();
  const estado = document.getElementById('filtroEstadoSolicitudes').value;
  const url = estado ? `/api/admin/plantillas?estado=${encodeURIComponent(estado)}` : '/api/admin/plantillas';
  const res = await fetch(url);
  const data = await res.json();
  const tbody = document.getElementById('tablaSolicitudesAdmin');
  document.getElementById('totalSolicitudesAdmin').textContent = data.solicitudes.length;

  const opcionesNumero = (seleccionadoId) => `<option value="">— Sin asignar —</option>` +
    numerosAdminCache.map((n) => `<option value="${n.id}" ${Number(seleccionadoId) === n.id ? 'selected' : ''}>${escapeHtml(n.etiqueta || n.phone_number_id)}</option>`).join('');

  const opcionesEstado = (actual) => Object.entries(ETIQUETAS_ESTADO_PLANTILLA)
    .map(([valor, etiqueta]) => `<option value="${valor}" ${valor === actual ? 'selected' : ''}>${etiqueta}</option>`)
    .join('');

  tbody.innerHTML = data.solicitudes.map((p) => `
    <tr>
      <td>${escapeHtml(p.cliente_nombre)}</td>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${escapeHtml(p.categoria)}</td>
      <td>${renderResumenPlantilla(p)}</td>
      <td><select data-plantilla-numero="${p.id}" class="estado-factura-select">${opcionesNumero(p.whatsapp_numero_id)}</select></td>
      <td><select data-plantilla-estado="${p.id}" class="estado-factura-select">${opcionesEstado(p.estado)}</select></td>
      <td><input type="text" data-plantilla-nota="${p.id}" value="${escapeHtml(p.nota_admin || '')}" placeholder="Nota interna…" /></td>
      <td><button type="button" class="btn btn-sm btn-outline" data-plantilla-ver="${p.id}">Ver JSON</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="muted">No hay solicitudes con ese filtro.</td></tr>';

  tbody.querySelectorAll('[data-plantilla-estado]').forEach((sel) => {
    sel.addEventListener('change', (e) => actualizarSolicitudAdmin(e.target.dataset.plantillaEstado, { estado: e.target.value }));
  });
  tbody.querySelectorAll('[data-plantilla-numero]').forEach((sel) => {
    sel.addEventListener('change', (e) => actualizarSolicitudAdmin(e.target.dataset.plantillaNumero, { whatsapp_numero_id: e.target.value || null }));
  });
  tbody.querySelectorAll('[data-plantilla-nota]').forEach((inp) => {
    inp.addEventListener('blur', (e) => actualizarSolicitudAdmin(e.target.dataset.plantillaNota, { nota_admin: e.target.value }));
  });
  tbody.querySelectorAll('[data-plantilla-ver]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const solicitud = data.solicitudes.find((p) => p.id === Number(btn.dataset.plantillaVer));
      document.getElementById('jsonSolicitudAdmin').textContent = JSON.stringify(solicitud.componentes_meta, null, 2);

      const muestraCont = document.getElementById('muestraSolicitudAdmin');
      if (solicitud.header_media_url) {
        const url = solicitud.header_media_url;
        let visor;
        if (solicitud.header_tipo === 'VIDEO') {
          visor = `<video src="${url}" controls style="max-width: 320px; border-radius: 8px;"></video>`;
        } else if (solicitud.header_tipo === 'IMAGE') {
          visor = `<img src="${url}" alt="Muestra de encabezado" style="max-width: 320px; border-radius: 8px;" />`;
        } else {
          visor = `<a href="${url}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">Descargar documento adjunto</a>`;
        }
        muestraCont.innerHTML = `<h3>Muestra del encabezado</h3>${visor}`;
        muestraCont.classList.remove('hidden');
      } else {
        muestraCont.innerHTML = '';
        muestraCont.classList.add('hidden');
      }

      document.getElementById('detalleSolicitudAdmin').classList.remove('hidden');
    });
  });
}

async function actualizarSolicitudAdmin(id, cambios) {
  const res = await fetch(`/api/admin/plantillas/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cambios),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'No se pudo actualizar la solicitud');
  }
  cargarSolicitudesAdmin();
}

document.getElementById('filtroEstadoSolicitudes').addEventListener('change', () => cargarSolicitudesAdmin());
document.getElementById('btnCerrarDetalleSolicitud').addEventListener('click', () => {
  document.getElementById('detalleSolicitudAdmin').classList.add('hidden');
});

renderBotonesPlantilla();

// ==================== GUÍA DE PRIMEROS PASOS (empresas independientes) ====================
// Checklist global arriba del panel + "¿Cómo funciona?" plegable por pestaña.
// Todo se calcula en el navegador con endpoints que ya existen; el admin no
// la ve. Preferencias (minimizada/oculta/secciones plegadas) en localStorage,
// siempre con try/catch porque puede no estar disponible.

const GUIA_KEYS = { minimizada: 'dl-guia-minimizada', oculta: 'dl-guia-oculta', completada: 'dl-guia-completada' };
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage: la guía igual funciona */ } }

const guia = { activa: false, conectado: false, plantillas: [], campanas: [], conversaciones: [] };

const GUIA_ICONO_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const GUIA_ICONO_RELOJ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const GUIA_ICONO_CANDADO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/** Cambia de pestaña reusando el handler de tabs existente (ver TABS arriba). */
function irAPestana(tab) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (!btn || btn.classList.contains('hidden')) return;
  btn.click();
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

async function iniciarGuia(conectado) {
  guia.activa = true;
  guia.conectado = conectado;
  document.querySelectorAll('.guia-seccion').forEach(prepararGuiaSeccion);

  const panel = document.getElementById('guiaPrimerosPasos');
  if (lsGet(GUIA_KEYS.oculta) !== '1' && lsGet(GUIA_KEYS.completada) !== '1') {
    panel.classList.remove('hidden');
    aplicarGuiaMinimizada(lsGet(GUIA_KEYS.minimizada) === '1');
  }
  await refrescarDatosGuia();
}

async function refrescarDatosGuia() {
  const traer = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [p, c, v] = await Promise.all([traer('/api/plantillas'), traer('/api/campanas'), traer('/api/conversaciones')]);
  guia.plantillas = p?.solicitudes || [];
  guia.campanas = c?.campanas || [];
  guia.conversaciones = v?.conversaciones || [];
  actualizarDatalistPlantillas(guia.plantillas);
  actualizarGuia();
}

function aplicarGuiaMinimizada(minimizada) {
  const panel = document.getElementById('guiaPrimerosPasos');
  const btn = document.getElementById('btnGuiaMinimizar');
  panel.classList.toggle('minimizada', minimizada);
  btn.textContent = minimizada ? 'Continuar' : 'Minimizar';
  btn.setAttribute('aria-expanded', String(!minimizada));
}

function actualizarGuia() {
  if (!guia.activa) return;
  const panel = document.getElementById('guiaPrimerosPasos');
  if (panel.classList.contains('hidden')) return;

  const aprobada = guia.plantillas.some((p) => p.estado === 'lista_para_enviar');
  const bloqueoTexto = 'Disponible cuando tengas tu número de WhatsApp asignado.';
  const pasos = [
    {
      titulo: 'Pide tu primera plantilla',
      hecho: guia.plantillas.length > 0,
      detalle: guia.plantillas.length === 0
        ? 'Es el mensaje que vas a enviar; Meta tiene que aprobarlo.'
        : aprobada ? 'Aprobada: ya la puedes usar.' : 'En revisión: te avisamos cuando esté lista.',
      accion: { texto: 'Ir a Plantillas', tab: 'plantillas' },
    },
    {
      titulo: 'Número de WhatsApp asignado',
      hecho: guia.conectado,
      espera: !guia.conectado,
      detalle: guia.conectado ? 'Listo.' : 'Nuestro equipo te lo asigna cuando aprobamos tu plantilla. No tienes que hacer nada.',
    },
    {
      titulo: 'Activa tu plan',
      hecho: Boolean(misPlan?.aplica),
      detalle: misPlan?.aplica ? `Plan ${misPlan.plan.nombre}.` : 'Elige cuántos mensajes al mes necesitas.',
      accion: { texto: 'Ver planes', href: '/planes.html' },
    },
    {
      titulo: 'Carga tus contactos',
      hecho: contactos.length > 0,
      bloqueado: !guia.conectado,
      detalle: contactos.length > 0 ? `${contactos.length} contacto(s) cargado(s).` : 'Importa un archivo CSV o Excel con tus clientes.',
      accion: { texto: 'Ir a Contactos', tab: 'contactos' },
    },
    {
      titulo: 'Envía tu primera campaña',
      hecho: guia.campanas.length > 0,
      bloqueado: !guia.conectado,
      detalle: guia.campanas.length > 0 ? 'Listo.' : 'Elige la plantilla y los contactos, y envía.',
      accion: { texto: 'Ir a Nueva campaña', tab: 'campana' },
    },
    {
      titulo: 'Revisa las respuestas',
      hecho: guia.conversaciones.length > 0,
      bloqueado: !guia.conectado,
      detalle: guia.conversaciones.length > 0 ? 'Ya te respondieron.' : 'Aparecen aquí cuando alguien responde tu campaña.',
      accion: { texto: 'Ir a Webhook', tab: 'webhook' },
    },
  ];

  const hechos = pasos.filter((p) => p.hecho).length;
  document.getElementById('guiaConteo').textContent = `${hechos} de ${pasos.length}`;
  document.getElementById('guiaBarraRelleno').style.width = `${(hechos / pasos.length) * 100}%`;
  document.querySelector('#guiaPrimerosPasos .guia-barra').setAttribute('aria-valuenow', String(hechos));

  document.getElementById('guiaPasos').innerHTML = pasos.map((p, i) => {
    let icono = String(i + 1);
    let estadoSr = 'Pendiente';
    if (p.hecho) { icono = GUIA_ICONO_CHECK; estadoSr = 'Completado'; }
    else if (p.espera) { icono = GUIA_ICONO_RELOJ; estadoSr = 'En espera'; }
    else if (p.bloqueado) { icono = GUIA_ICONO_CANDADO; estadoSr = 'Bloqueado'; }

    let accion = '';
    if (!p.hecho && !p.bloqueado && p.accion) {
      accion = p.accion.href
        ? `<a class="btn btn-sm btn-outline guia-paso-accion" href="${p.accion.href}" target="_blank" rel="noopener">${p.accion.texto} →</a>`
        : `<button type="button" class="btn btn-sm btn-outline guia-paso-accion" data-ir-a="${p.accion.tab}">${p.accion.texto} →</button>`;
    }
    return `
      <li class="guia-paso${p.hecho ? ' hecho' : ''}">
        <span class="guia-paso-icono">${icono}</span>
        <div class="guia-paso-texto">
          <div class="guia-paso-titulo"><span class="sr-only">${estadoSr}: </span>${p.titulo}</div>
          <div class="guia-paso-detalle">${p.bloqueado && !p.hecho ? bloqueoTexto : p.detalle}</div>
        </div>
        ${accion}
      </li>`;
  }).join('');

  const completa = hechos === pasos.length;
  document.getElementById('guiaListo').classList.toggle('hidden', !completa);
  if (completa) lsSet(GUIA_KEYS.completada, '1');
}

/** "¿Cómo funciona esta sección?": abierto la primera vez, después recuerda lo que eligió el usuario. */
function prepararGuiaSeccion(det) {
  const clave = `dl-guia-seccion-${det.dataset.guia}`;
  det.classList.remove('hidden');
  det.open = lsGet(clave) !== '0';
  det.addEventListener('toggle', () => lsSet(clave, det.open ? '1' : '0'));
}

/** Sugiere en "Nueva campaña" las plantillas ya aprobadas, y completa el idioma al elegir una. */
function actualizarDatalistPlantillas(plantillas) {
  const aprobadas = plantillas.filter((p) => p.estado === 'lista_para_enviar');
  document.getElementById('plantillasAprobadas').innerHTML = aprobadas
    .map((p) => `<option value="${escapeHtml(p.nombre)}">${escapeHtml(`${p.categoria} · ${p.idioma}`)}</option>`)
    .join('');
  guia.plantillasAprobadas = aprobadas;
}

function alElegirPlantilla() {
  const nombre = document.getElementById('templateNombre').value.trim();
  const elegida = (guia.plantillasAprobadas || []).find((p) => p.nombre === nombre);
  if (elegida?.idioma) document.getElementById('templateIdioma').value = elegida.idioma;

  plantillaCuerpoActual = elegida?.body_texto || '';
  // Si aún no hay parámetros, se crean tantos como {{N}} pida la plantilla.
  const pedidos = cantidadParametrosDeCuerpo(plantillaCuerpoActual);
  if (pedidos > 0 && parametros.length === 0) {
    for (let i = 0; i < pedidos; i += 1) parametros.push({ tipo: 'nombre', valor: '', clave: '' });
  }
  renderParametros();
}

document.getElementById('templateNombre').addEventListener('change', alElegirPlantilla);
document.getElementById('templateNombre').addEventListener('input', () => {
  // Al escribir a mano un nombre que ya no coincide, se quita el texto de la plantilla anterior.
  const nombre = document.getElementById('templateNombre').value.trim();
  if (plantillaCuerpoActual && !(guia.plantillasAprobadas || []).some((p) => p.nombre === nombre)) {
    plantillaCuerpoActual = '';
    actualizarPanelParametros();
  }
});

/** CSV de ejemplo con las columnas que entiende la importación (ver /api/contactos/importar). */
function descargarCsvEjemplo() {
  // Mismo formato día/mes/año hora que entiende la importación (ver fechas.js).
  const enDias = (n, hora) => {
    const d = new Date(Date.now() + n * 86400000);
    return `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)}/${d.getFullYear()} ${hora}`;
  };
  const filas = [
    'telefono,nombre,fecha_cita,fecha_envio',
    `3001234567,Ana Gómez,Martes 10:00 am,${enDias(7, '9:00')}`,
    `3109876543,Carlos Pérez,Miércoles 3:00 pm,${enDias(8, '3:30 p. m.')}`,
    '3205551234,Laura Díaz,,',
  ];
  const blob = new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ejemplo-contactos.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('btnGuiaMinimizar').addEventListener('click', () => {
  const minimizada = !document.getElementById('guiaPrimerosPasos').classList.contains('minimizada');
  aplicarGuiaMinimizada(minimizada);
  lsSet(GUIA_KEYS.minimizada, minimizada ? '1' : '0');
});

document.getElementById('btnGuiaOcultar').addEventListener('click', () => {
  document.getElementById('guiaPrimerosPasos').classList.add('hidden');
  lsSet(GUIA_KEYS.oculta, '1');
});

// Acciones de la guía y de los empty states (delegado: esos botones se re-renderizan).
document.addEventListener('click', (e) => {
  const irA = e.target.closest('[data-ir-a]');
  if (irA) { irAPestana(irA.dataset.irA); return; }

  if (e.target.closest('[data-descargar-ejemplo]')) { descargarCsvEjemplo(); return; }

  if (e.target.closest('[data-ir-importar]')) {
    irAPestana('contactos');
    document.getElementById('formImportar').scrollIntoView({ block: 'center' });
    document.getElementById('inputArchivo').focus();
    return;
  }

  if (e.target.closest('[data-ir-form-plantilla]')) {
    document.getElementById('formSolicitudPlantilla').scrollIntoView({ block: 'start' });
    document.getElementById('inputPlantillaNombre').focus();
  }
});

// ==================== INIT ====================

(async () => {
  const conectado = await cargarConfig();
  if (!conectado) return; // pantalla "Conectar WhatsApp" ya se mostró — no hay nada más para cargar
  iniciarRefrescoEstadoCobro();
  cargarContactos();
  cargarListas();
  renderParametros();
  cargarConversaciones();
  setInterval(cargarConversaciones, 10000); // refresco periódico para el badge de "no leídos" en la pestaña
})();
