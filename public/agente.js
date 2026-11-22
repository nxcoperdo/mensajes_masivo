// Pestaña "Agente" (solo visible para el dueño del agente: /api/agente/* responde 403 al resto)
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let cfg = null;
  let telAbierto = null;

  async function api(ruta, opts = {}) {
    const res = await fetch(`/api/agente${ruta}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
    return data;
  }

  function aviso(texto, ok = true) {
    const b = $('agMsg');
    b.textContent = texto;
    b.className = `result-box ${ok ? '' : 'result-error'}`;
    setTimeout(() => b.classList.add('hidden'), 8000);
  }

  function pintarConfig() {
    $('agEstadoBadge').textContent = cfg.activo ? 'Activo' : 'Apagado';
    $('agEstadoBadge').className = `badge ${cfg.activo ? 'badge-ok' : 'badge-muted'}`;
    $('agToggle').textContent = cfg.activo ? 'Apagar agente' : 'Activar agente';
    $('agModelo').value = cfg.modelo;
    $('agLimite').value = cfg.limite_diario;
    $('agPlantilla').value = cfg.plantilla || '';
    $('agPlantillaReenvio').value = cfg.plantilla_reenvio || '';
    $('agIdioma').value = cfg.idioma || '';
    $('agCrtUrl').value = cfg.crt_url || '';
    $('agOwner').value = cfg.owner_phone || '';
    $('agTgChat').value = cfg.telegram_chat_id || '';
    $('agIva').value = cfg.nota_iva || '';
    $('agPromptExtra').value = cfg.prompt_extra || '';
    $('agPromptBase').value = cfg.prompt_base || '';
    $('agAnthropicMask').textContent = cfg.anthropic_key_set ? `(configurada ${cfg.anthropic_key_mask})` : '(falta)';
    $('agTgMask').textContent = cfg.telegram_token_set ? `(configurado ${cfg.telegram_token_mask})` : '';
  }

  async function cargarNumeros() {
    const { numeros } = await api('/numeros');
    $('agNumero').innerHTML = '<option value="">— elige un número —</option>' +
      numeros.map((n) => `<option value="${esc(n.phone_number_id)}">${esc(n.etiqueta || n.phone_number_id)}</option>`).join('');
    $('agNumero').value = cfg.phone_number_id || '';
  }

  async function cargarStats() {
    const s = await api('/estadisticas');
    const p = s.por_estado;
    $('agStats').textContent = `Hoy: ${s.contactados_hoy}/${s.limite_diario} primeros contactos · 🔥 ${p.caliente || 0} calientes · ${p.conversando || 0} conversando · ${p.contactado || 0} contactados · ${p.cerrado || 0} cerrados`;
  }

  function cuerpoConfig() {
    const b = {
      phone_number_id: $('agNumero').value,
      modelo: $('agModelo').value,
      limite_diario: $('agLimite').value,
      plantilla: $('agPlantilla').value,
      plantilla_reenvio: $('agPlantillaReenvio').value,
      idioma: $('agIdioma').value,
      crt_url: $('agCrtUrl').value,
      owner_phone: $('agOwner').value,
      telegram_chat_id: $('agTgChat').value,
      nota_iva: $('agIva').value,
      prompt_extra: $('agPromptExtra').value,
      prompt_base: $('agPromptBase').value,
    };
    if ($('agAnthropic').value.trim()) b.anthropic_key = $('agAnthropic').value.trim();
    if ($('agTgToken').value.trim()) b.telegram_token = $('agTgToken').value.trim();
    return b;
  }

  async function guardar(extra = {}) {
    const r = await api('/config', { method: 'PUT', body: { ...cuerpoConfig(), ...extra } });
    cfg = r.config;
    $('agAnthropic').value = '';
    $('agTgToken').value = '';
    pintarConfig();
  }

  async function cargarProspectos() {
    const { prospectos } = await api('/prospectos');
    $('agTablaProspectos').innerHTML = prospectos.slice(0, 100).map((l) =>
      `<tr><td>${l.puntaje}</td><td>${esc(l.nombre)}</td><td>${esc(l.rubro)}</td><td>${esc(l.telefono)}</td><td>${esc(l.sitio_web || '— sin web —')}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="muted">Sin prospectos nuevos. Busca negocios arriba.</td></tr>';
  }

  async function cargarContactos() {
    const estado = $('agFiltroEstado').value;
    const { contactos } = await api(`/contactos${estado ? `?estado=${estado}` : ''}`);
    $('agTablaContactos').innerHTML = contactos.map((c) => `
      <tr>
        <td>${esc(c.nombre || '-')}<br><span class="muted">${esc(c.telefono)}</span></td>
        <td>${esc(c.negocio || '-')}</td>
        <td>${esc(c.estado)}</td>
        <td>${c.modo === 'humano' ? '👤 Tú' : '🤖 Agente'}</td>
        <td>${esc(c.resumen || c.necesidad || '')}</td>
        <td>
          <button class="btn btn-sm btn-outline" data-ac="ver" data-tel="${esc(c.telefono)}">Ver chat</button>
          ${c.modo === 'humano'
            ? `<button class="btn btn-sm btn-outline" data-ac="devolver" data-tel="${esc(c.telefono)}">Devolver al agente</button>`
            : `<button class="btn btn-sm btn-outline" data-ac="tomar" data-tel="${esc(c.telefono)}">Tomar</button>`}
          <button class="btn btn-sm btn-outline" data-ac="cerrado" data-tel="${esc(c.telefono)}">Cerrado</button>
          <button class="btn btn-sm btn-outline" data-ac="perdido" data-tel="${esc(c.telefono)}">Perdido</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Aún no hay conversaciones.</td></tr>';
  }

  async function abrirChat(tel) {
    telAbierto = tel;
    const { contacto, mensajes } = await api(`/conversacion/${tel}`);
    $('agChatCard').classList.remove('hidden');
    $('agChatTitulo').textContent = `${contacto?.nombre || tel} — ${contacto?.negocio || ''}`;
    $('agChatMensajes').innerHTML = mensajes.map((m) =>
      `<div style="align-self:${m.rol === 'user' || m.rol === 'auto' ? 'flex-start' : 'flex-end'};max-width:80%;padding:6px 10px;border-radius:8px;background:${m.rol === 'user' ? 'var(--color-surface-2, #eee)' : m.rol === 'nicolas' ? '#dbeafe' : m.rol === 'auto' ? '#e5e7eb' : '#dcfce7'};color:#111">
        <small>${m.rol === 'user' ? 'Cliente' : m.rol === 'nicolas' ? 'Tú' : m.rol === 'auto' ? 'Respuesta automática del negocio' : 'Agente'}</small><br>${esc(m.texto)}</div>`).join('');
    $('agChatMensajes').scrollTop = 1e9;
  }

  async function refrescar() {
    await Promise.all([cargarStats(), cargarContactos(), cargarProspectos()]);
  }

  async function iniciar() {
    try {
      cfg = (await api('/config')).config;
    } catch {
      return; // no es el dueño del agente: la pestaña sigue oculta
    }
    document.querySelector('.tab-btn[data-tab="agente"]').classList.remove('hidden');
    pintarConfig();
    await cargarNumeros();
    await refrescar();

    const seguro = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, false); } };

    $('agToggle').onclick = seguro(async () => { await guardar({ activo: !cfg.activo }); aviso(cfg.activo ? 'Agente activado ✓' : 'Agente apagado'); });
    $('agGuardar').onclick = seguro(async () => { await guardar(); aviso('Configuración guardada ✓'); });
    $('agProbarAlertas').onclick = seguro(async () => { await guardar(); const r = await api('/probar-alertas', { method: 'POST' }); aviso(`Alerta enviada por ${r.via} ✓`); });
    $('agPromptDefault').onclick = () => { $('agPromptBase').value = cfg.prompt_default; };
    $('agRefrescar').onclick = seguro(refrescar);
    $('agFiltroEstado').onchange = seguro(cargarContactos);
    $('agChatCerrar').onclick = () => { telAbierto = null; $('agChatCard').classList.add('hidden'); };

    $('agFormProspectar').onsubmit = seguro(async (e) => {
      e.preventDefault();
      const r = await api('/prospectar', { method: 'POST', body: { nicho: $('agNicho').value, ciudad: $('agCiudad').value } });
      aviso(`Encontrados ${r.total_encontrados} (${r.proveedor}): ${r.nuevos} nuevos, ${r.duplicados} repetidos`);
      await cargarProspectos();
    });

    const contactar = (prueba) => seguro(async () => {
      if (!prueba && !confirm('¿Enviar la plantilla de presentación a los prospectos? Esto escribe a negocios reales.')) return;
      const r = await api('/contactar', { method: 'POST', body: { nicho: $('agNichoContactar').value, limite: $('agLimiteContactar').value || undefined, prueba } });
      const box = $('agProspResultado');
      box.classList.remove('hidden');
      box.textContent = prueba
        ? `Prueba: escribiría a ${r.a_contactar.length} (quedan ${r.restante_hoy} hoy):\n` + r.a_contactar.map((x) => `${x.puntaje} · ${x.nombre} · ${x.telefono}`).join('\n')
        : `Enviados: ${r.enviados}. Errores: ${r.errores.length}. Quedan hoy: ${r.restante_hoy}.` + r.errores.map((x) => `\n${x.telefono}: ${x.error}`).join('');
      box.style.whiteSpace = 'pre-wrap';
      await refrescar();
    });
    $('agPrueba').onclick = contactar(true);
    $('agContactar').onclick = contactar(false);

    $('agTablaContactos').onclick = seguro(async (e) => {
      const btn = e.target.closest('button[data-ac]');
      if (!btn) return;
      const { ac, tel } = btn.dataset;
      if (ac === 'ver') return abrirChat(tel);
      await api(`/contactos/${tel}/${ac}`, { method: 'POST' });
      await refrescar();
    });

    $('agChatForm').onsubmit = seguro(async (e) => {
      e.preventDefault();
      const texto = $('agChatTexto').value.trim();
      if (!texto || !telAbierto) return;
      await api(`/contactos/${telAbierto}/responder`, { method: 'POST', body: { texto } });
      $('agChatTexto').value = '';
      await abrirChat(telAbierto);
      await cargarContactos();
    });

    setInterval(() => { if (document.getElementById('tab-agente').classList.contains('active')) { refrescar().catch(() => {}); if (telAbierto) abrirChat(telAbierto).catch(() => {}); } }, 15000);
  }

  iniciar();
})();
