/*
 * Extrae teléfono / sitio web / reseñas de los negocios de una búsqueda de Google Maps.
 * Uso: abrir https://www.google.com/maps/search/<rubro>+en+<ciudad> en el navegador, pegar este archivo en la consola
 * (o ejecutarlo con una herramienta de automatización del navegador) y llamar:
 *     window.__res = []; await window.__scrape(30); window.__persist('<rubro>');
 * Los resultados se acumulan en localStorage['__all'] para juntar varios rubros.
 * Luego: filtrar celulares colombianos (3XXXXXXXXX), quitar cadenas, ordenar por puntaje y cargar a leads_prospectos.
 * Nota: respetar los términos de Google Maps y la Ley 1581 (habeas data) en el uso de los datos.
 */
window.__scrape = async (max) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const limpio = (s) => (s || '').replace(/·.*$/, '').trim(); // Google agrega "·Enlace visitado"
  const feed = document.querySelector('div[role="feed"]');
  for (let i = 0; i < 5 && feed; i++) { feed.scrollBy(0, 2500); await sleep(1000); }
  const links = [...document.querySelectorAll('a.hfpxzc')];
  for (const a of links.slice(0, max)) {
    const card = a.closest('div[role="article"]') || a.parentElement;
    const meta = (card?.innerText || '').split('\n').filter(Boolean).slice(0, 5).join(' | ');
    const name = limpio(a.getAttribute('aria-label'));
    a.click();
    let phone = null, web = null, found = false;
    for (let t = 0; t < 16; t++) {
      await sleep(300);
      const h1 = [...document.querySelectorAll('h1')].map((x) => limpio(x.innerText)).find((x) => x === name);
      if (h1) {
        found = true;
        const p = document.querySelector('button[data-item-id^="phone"]');
        phone = p ? p.getAttribute('data-item-id').replace('phone:tel:', '') : null;
        const w = document.querySelector('a[data-item-id="authority"]');
        web = w ? w.href : null;
        if (p || t > 5) break;
      }
    }
    window.__res.push({ name, phone, web, meta, found });
  }
};
window.__persist = (nicho) => {
  const old = JSON.parse(localStorage.getItem('__all') || '[]');
  localStorage.setItem('__all', JSON.stringify(old.concat(window.__res.map((r) => ({ ...r, nicho })))));
  return old.length + window.__res.length;
};
