const manifestUrl = new URL('/manifest.json', window.location.origin).href;
const input = document.getElementById('url');
input.value = manifestUrl;
const installLink = document.getElementById('install');
const host = window.location.host;
const isSecure = window.location.protocol === 'https:';
installLink.href = isSecure ? `stremio://${host}/manifest.json` : manifestUrl;
document.getElementById('copy').addEventListener('click', async () => {
  const feedback = document.getElementById('feedback');
  try {
    await navigator.clipboard.writeText(manifestUrl);
    feedback.textContent = 'Enlace copiado. Pégalo en Complementos de Stremio.';
  } catch (_) {
    document.querySelector('details').open = true;
    input.focus();
    input.select();
    feedback.textContent = 'No se pudo copiar automáticamente. Copia el enlace seleccionado.';
  }
});

// La versión que anuncia la portada sale del Worker desplegado (/health), no de
// una constante del HTML: así la página nunca muestra una versión distinta de
// la que responde en su propio dominio.
const versionBadge = document.getElementById('version');
const releaseLabel = document.getElementById('release');
function applyLiveVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) return;
  if (versionBadge) versionBadge.textContent = version;
  if (releaseLabel) releaseLabel.textContent = `NOVEDADES · ${version}`;
}

// Un Preview de Workers Builds vive en <alias o hash>-nexo-player-app.<subdominio>.workers.dev:
// es una copia congelada de una rama, nunca recibe los cambios de main y no
// hereda los secretos. El aviso evita confundirlo con la web publicada.
const PREVIEW_HOST = /^[a-z0-9][a-z0-9-]*-(nexo-player-app)\.([a-z0-9.-]+\.workers\.dev)$/i;
function productionUrlFor(hostname) {
  const match = PREVIEW_HOST.exec(hostname || '');
  return match ? `https://${match[1]}.${match[2]}` : null;
}
function showDeploymentNotice(productionUrl) {
  if (document.querySelector('.deployment-notice')) return;
  const notice = document.createElement('p');
  notice.className = 'deployment-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = productionUrl
    ? 'Este dominio es un Preview de una rama: es una copia congelada, sin Supabase configurado, y no recibe los cambios de main. La versión publicada está en '
    : 'Este despliegue no tiene Supabase configurado, así que la búsqueda devolverá 0 fuentes. Revisa /health para ver el diagnóstico.';
  if (productionUrl) {
    const link = document.createElement('a');
    link.href = productionUrl;
    link.textContent = productionUrl.replace('https://', '');
    notice.append(link, document.createTextNode('.'));
  }
  const header = document.querySelector('header');
  if (header) header.insertAdjacentElement('afterend', notice);
  else document.body.prepend(notice);
}

function syncLiveVersion() {
  fetch('/health', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null))
    .then(health => {
      if (!health || typeof health !== 'object') return;
      applyLiveVersion(health.version);
      const supabase = health.supabase || {};
      if (supabase.configured === false) showDeploymentNotice(productionUrlFor(window.location.hostname));
    })
    .catch(() => { /* sin /health la insignia conserva el valor del HTML */ });
}
syncLiveVersion();

// Solo consultas al mismo origen; nunca insertar metadatos como HTML.
const searchForm = document.getElementById('search-form');
const searchType = document.getElementById('search-type');
const season = document.getElementById('search-season');
const episode = document.getElementById('search-episode');
const searchStatus = document.getElementById('search-status');
const results = document.getElementById('search-results');
const language = document.getElementById('filter-language');
const quality = document.getElementById('filter-quality');
const searchSubmit = document.getElementById('search-submit');
const searchButtonText = searchSubmit.querySelector('span');
const defaultSubmitLabel = searchButtonText?.textContent || 'Buscar fuentes';
let sources = [];
let controller;
function setSearchPending(pending) {
  searchSubmit.disabled = pending;
  searchSubmit.setAttribute('aria-busy', String(pending));
  if (searchButtonText) searchButtonText.textContent = pending ? 'Buscando…' : defaultSubmitLabel;
  searchStatus.classList.toggle('is-loading', pending);
}
function parseStreamHeader(name) {
  if (!name) return { lang: null, quality: null, badges: [] };
  const lines = name.split('\n');
  const header = lines[1] || lines[0] || '';
  // Header format: [LANG] RESOLUTION · BADGE1 · BADGE2 · PACK
  const langMatch = /\[([A-Z/]+)\]/.exec(header);
  const afterLang = header.replace(/\[[^\]]+\]\s*/, '').trim();
  const parts = afterLang.split('·').map(p => p.trim()).filter(Boolean);
  const resolution = parts[0] || null;
  const badges = parts.slice(1).filter(p => !p.startsWith('PACK'));
  return {
    lang: langMatch ? langMatch[1] : null,
    quality: resolution,
    badges
  };
}

function renderSources() {
  searchStatus.classList.remove('is-loading');
  const filtered = sources.map(stream => ({ stream, meta: parseStreamHeader(stream.name) }))
    .filter(({ meta }) => (!language.value || meta.lang === language.value) &&
      (!quality.value || meta.quality === quality.value));
  results.replaceChildren();
  for (const { stream, meta } of filtered) {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    const badgeRow = document.createElement('div');
    const details = document.createElement('p');
    badgeRow.className = 'badges';
    if (meta.lang) {
      const langBadge = document.createElement('span');
      langBadge.className = 'badge lang-' + meta.lang.toLowerCase();
      langBadge.textContent = meta.lang;
      badgeRow.append(langBadge);
    }
    if (meta.quality) {
      const qBadge = document.createElement('span');
      qBadge.className = 'badge quality';
      qBadge.textContent = meta.quality;
      badgeRow.append(qBadge);
    }
    for (const badge of meta.badges) {
      const b = document.createElement('span');
      b.className = 'badge tech';
      b.textContent = badge;
      badgeRow.append(b);
    }
    const titleLines = (stream.title || '').split('\n');
    heading.textContent = titleLines[0] || 'Fuente';
    for (const line of titleLines.slice(1)) {
      if (!line.trim()) continue;
      const lineEl = document.createElement('span');
      lineEl.className = 'detail-line';
      lineEl.textContent = line;
      details.append(lineEl);
    }
    item.append(heading, badgeRow, details);
    results.append(item);
  }
  searchStatus.textContent = sources.length
    ? `${filtered.length} de ${sources.length} fuentes. ${filtered.length ? '' : 'Prueba otros filtros.'}`
    : 'No hay fuentes disponibles o el servicio no pudo consultarlas. Prueba más tarde.';
}
language.addEventListener('change', () => { if (!controller) renderSources(); });
quality.addEventListener('change', () => { if (!controller) renderSources(); });
searchType.addEventListener('change', () => {
  season.disabled = episode.disabled = searchType.value === 'movie';
});
searchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const raw = document.getElementById('search-id').value.trim();
  let id = /^tt\d{7,10}$/.test(raw) ? raw : null;
  if (!id) {
    try {
      const url = new URL(raw);
      if (['https:', 'http:'].includes(url.protocol) && /^(www\.|m\.)?imdb\.com$/i.test(url.hostname)) {
        id = /^\/title\/(tt\d{7,10})(?:\/|$)/.exec(url.pathname)?.[1];
      }
    } catch (_) { /* validation below */ }
  }
  if (!id) {
    controller?.abort();
    controller = null;
    setSearchPending(false);
    sources = [];
    results.replaceChildren();
    results.setAttribute('aria-busy', 'false');
    searchStatus.classList.remove('is-loading');
    searchStatus.textContent = 'Sustituye el texto por un ID (tt0111161) o un enlace de título de IMDb válido.';
    return;
  }
  if (searchType.value !== 'movie') id += `:${Number(season.value)}:${Number(episode.value)}`;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const timeout = setTimeout(() => request.abort(), 12000);
  sources = [];
  results.replaceChildren();
  searchStatus.textContent = 'Buscando fuentes…';
  setSearchPending(true);
  results.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/stream/${searchType.value}/${encodeURIComponent(id)}.json`, { signal: request.signal });
    if (!response.ok) throw new Error('HTTP');
    const data = await response.json();
    if (!Array.isArray(data.streams)) throw new Error('Formato');
    if (controller !== request) return;
    sources = data.streams;
    renderSources();
  } catch (_) {
    if (controller === request) {
      searchStatus.textContent = request.signal.aborted
        ? 'La consulta tardó demasiado. Inténtalo de nuevo.'
        : 'No se pudo completar la consulta. Inténtalo de nuevo.';
      searchStatus.classList.remove('is-loading');
    }
  } finally {
    clearTimeout(timeout);
    if (controller === request) {
      controller = null;
      setSearchPending(false);
      results.setAttribute('aria-busy', 'false');
    }
  }
});
