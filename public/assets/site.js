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

// Solo consultas al mismo origen; nunca insertar metadatos como HTML.
const searchForm = document.getElementById('search-form');
const searchType = document.getElementById('search-type');
const season = document.getElementById('search-season');
const episode = document.getElementById('search-episode');
const searchStatus = document.getElementById('search-status');
const results = document.getElementById('search-results');
const language = document.getElementById('filter-language');
const quality = document.getElementById('filter-quality');
let sources = [];
let controller;
function renderSources() {
  const filtered = sources.filter(stream => {
    const tags = /\[([^\]]+)\]\s+(.+)$/.exec(stream.name || '');
    return (!language.value || tags?.[1] === language.value) && (!quality.value || tags?.[2] === quality.value);
  });
  results.replaceChildren();
  for (const stream of filtered) {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    const details = document.createElement('p');
    heading.textContent = stream.name;
    details.textContent = stream.title;
    item.append(heading, details);
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
    if (controller === request) searchStatus.textContent = 'No se pudo completar la consulta. Inténtalo de nuevo.';
  } finally {
    clearTimeout(timeout);
    if (controller === request) {
      controller = null;
      results.setAttribute('aria-busy', 'false');
    }
  }
});
