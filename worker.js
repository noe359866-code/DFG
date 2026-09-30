/**
 * Nexo Play - Cloudflare Worker
 * Única capa HTTP sobre la API Fetch: manifiesto, streams, salud y estáticos.
 * La lógica del addon (consulta y formato) vive en addon.js; aquí solo se
 * enruta, aplica CORS y administra la caché del edge con la Cache API.
 *
 * La Cache API honora s-maxage/max-age pero no stale-while-revalidate ni
 * stale-if-error: esas ventanas viajan en la respuesta para el navegador,
 * mientras que el frescura restante y la ventana obsoleta viven en la caché
 * en memoria del isolate (addon.js).
 */

const addon = require('./addon');

const JSON_TYPE = 'application/json; charset=utf-8';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const HSTS = 'Strict-Transport-Security';
const MANIFEST_CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600, stale-if-error=3600';
const ASSET_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
// /stream/:type/:id.json con segmento opcional :extra, como el router del SDK.
const STREAM_ROUTE = /^\/stream\/([^/]+)\/([^/]+)(?:\/([^/]+))?\.json$/;

// Fuera de Workers no hay ctx.waitUntil: basta con evitar el rechazo no
// manejado para que el trabajo en segundo plano no rompa el proceso local.
function discardInBackground(task) {
  Promise.resolve(task).catch(() => {});
}

function keepAliveFor(ctx) {
  return ctx && typeof ctx.waitUntil === 'function'
    ? task => ctx.waitUntil(task)
    : discardInBackground;
}

function decorate(response, extraHeaders) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value !== undefined && value !== null) headers.set(key, value);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body, status, extraHeaders) {
  return decorate(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', ...extraHeaders }
  }));
}

/**
 * Cache-Control de una respuesta de streams: el frescura restante con su
 * gemelo s-maxage para el edge, las ventanas obsoletas para el navegador y
 * no-store cuando el handler no dio directivas (fallo de base de datos).
 */
function streamCacheControl(result) {
  if (!Number.isInteger(result.cacheMaxAge)) return 'no-store';
  const parts = [`s-maxage=${result.cacheMaxAge}`, `max-age=${result.cacheMaxAge}`];
  if (Number.isInteger(result.staleRevalidate)) parts.push(`stale-while-revalidate=${result.staleRevalidate}`);
  if (Number.isInteger(result.staleError)) parts.push(`stale-if-error=${result.staleError}`);
  parts.push('public');
  return parts.join(', ');
}

async function computeEtag(body) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `"${btoa(binary)}"`;
}

function etagMatches(headerValue, etag) {
  if (!etag || !headerValue) return false;
  if (headerValue.trim() === '*') return true;
  return headerValue.split(',').some(candidate => candidate.trim() === etag);
}

async function manifestResponse(url) {
  const proto = url.protocol.replace(/:$/, '');
  const host = url.host;
  // El origen solo se coloca en metadatos públicos si el host es válido;
  // nunca se inyectan cabeceras de la petición en la respuesta.
  const valid = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && ['http', 'https'].includes(proto);
  const brand = `${proto}://${host}/assets/brand.png`;
  const body = JSON.stringify({
    ...addon.manifest,
    ...(valid ? { logo: brand, icon: brand } : {})
  });
  return decorate(new Response(body, {
    headers: {
      'Content-Type': JSON_TYPE,
      'Cache-Control': MANIFEST_CACHE_CONTROL,
      'ETag': await computeEtag(body)
    }
  }));
}

async function streamResponse(match, url, ctx) {
  let type = '';
  let id = '';
  try {
    type = decodeURIComponent(match[1]);
    id = decodeURIComponent(match[2]);
  } catch (_) {
    // URI malformada: el validador del handler devolverá lista vacía.
  }
  let extra = {};
  if (match[3]) {
    try {
      extra = Object.fromEntries(new URLSearchParams(match[3]));
    } catch (_) { /* segmento extra irrelevante para el handler */ }
  }
  const query = Object.fromEntries(url.searchParams);
  let result;
  try {
    // El mismo singleton de caché que usa la interfaz del SDK; el keepAlive
    // por llamada permite registrar la revalidación en ctx.waitUntil.
    result = await addon.helpers.cachedStreamHandler(
      { type, id, extra: { ...query, ...extra }, config: {} },
      keepAliveFor(ctx)
    );
  } catch (err) {
    console.error('[Stream] Excepción no controlada:', err && err.message);
    result = { streams: [] };
  }
  return decorate(new Response(JSON.stringify(result), {
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': streamCacheControl(result) }
  }));
}

// /health confirma que el Worker responde y si las variables de Supabase son
// válidas (sin exponer sus valores), para diagnosticar despliegues al instante.
function healthResponse() {
  const supabase = addon.helpers.configStatus();
  let diagnostic;
  if (supabase.url === 'missing') {
    diagnostic = { code: 'SUPABASE_URL_MISSING', message: 'Define SUPABASE_URL en los secretos del despliegue.' };
  } else if (supabase.url === 'invalid') {
    diagnostic = { code: 'SUPABASE_URL_INVALID', message: 'SUPABASE_URL no tiene un formato válido; comprueba que incluya el host del proyecto.' };
  } else if (supabase.keyType === 'none') {
    diagnostic = { code: 'SUPABASE_KEY_MISSING', message: 'Define SUPABASE_ANON_KEY (o SUPABASE_SERVICE_ROLE_KEY si es imprescindible).' };
  } else {
    diagnostic = { code: 'CONFIG_PRESENT', message: 'La URL tiene formato válido y hay una clave; /health no comprueba la conexión ni los permisos de la base de datos.' };
  }
  return decorate(new Response(JSON.stringify({
    status: 'ok',
    version: addon.manifest.version,
    supabase,
    diagnostic
  }), {
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' }
  }));
}

async function staticResponse(request, url, env) {
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    const response = await env.ASSETS.fetch(request);
    // Un archivo ausente cae al 404 en JSON, como antes: sin caché implícita.
    if (!response.ok) return jsonResponse({ error: 'No encontrado' }, 404);
    const cacheControl = url.pathname.startsWith('/assets/') ? ASSET_CACHE_CONTROL : undefined;
    return decorate(response, { 'Cache-Control': cacheControl });
  }
  // Sin binding de estáticos (pruebas directas): 404 en lugar de romper.
  return jsonResponse({ error: 'No encontrado' }, 404);
}

/**
 * Caché del edge con la Cache API: solo GET, solo 200 y solo respuestas que
 * anuncian s-maxage explícito; los fallos y /health nunca se almacenan. La
 * clave ignora la cadena de consulta: los parámetros no cambian la respuesta
 * y normalizarla evita fragmentar la caché por variaciones irrelevantes.
 */
async function edgeCache(request, url, ctx, generate) {
  const store = typeof caches !== 'undefined' && caches ? caches.default : null;
  const cacheableMethod = request.method === 'GET';
  const bypass = /no-store/.test(request.headers.get('cache-control') || '');
  const key = cacheableMethod ? new Request(`${url.origin}${url.pathname}`) : null;
  if (store && key && !bypass) {
    try {
      const hit = await store.match(key);
      if (hit) return hit;
    } catch (_) { /* cache no disponible */ }
  }
  const response = await generate();
  if (store && key && !bypass && response.status === 200 &&
      /s-maxage=\d+/.test(response.headers.get('cache-control') || '')) {
    keepAliveFor(ctx)(store.put(key, response.clone()));
  }
  return response;
}

async function handleRequest(request, env = {}, ctx = undefined) {
  try {
    if (env && typeof env === 'object') addon.helpers.configure(env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return decorate(new Response(null, { status: 204 }));
    if (!['GET', 'HEAD'].includes(request.method)) {
      return jsonResponse({ error: 'Método no permitido' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    }

    let response;
    if (url.pathname === '/manifest.json') {
      response = await edgeCache(request, url, ctx, () => manifestResponse(url));
      // Validación condicional: mismas cabeceras, sin cuerpo, cuando el
      // navegador ya tiene exactamente este manifiesto.
      const ifNoneMatch = request.headers.get('if-none-match');
      if (response.status === 200 && etagMatches(ifNoneMatch, response.headers.get('etag'))) {
        response = new Response(null, {
          status: 304,
          headers: {
            'ETag': response.headers.get('etag'),
            'Cache-Control': response.headers.get('cache-control'),
            ...CORS_HEADERS
          }
        });
      }
    } else if (url.pathname === '/health') {
      response = healthResponse();
    } else {
      const streamMatch = STREAM_ROUTE.exec(url.pathname);
      if (streamMatch) {
        response = await edgeCache(request, url, ctx, () => streamResponse(streamMatch, url, ctx));
      } else if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
        response = await staticResponse(request, url, env);
      } else {
        response = jsonResponse({ error: 'No encontrado' }, 404);
      }
    }

    // Solo en HTTPS; las cabeceras procedentes de la caché son inmutables,
    // así que decorate vuelve a envolver la respuesta.
    if (url.protocol === 'https:') {
      response = decorate(response, { [HSTS]: 'max-age=31536000' });
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  } catch (err) {
    console.error('[Worker] Error no controlado:', err && err.message);
    return jsonResponse({ error: 'Error interno' }, 500);
  }
}

module.exports = {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  handleRequest,
  streamCacheControl
};
