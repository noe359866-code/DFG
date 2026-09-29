/**
 * Nexo Play - Cloudflare Worker
 * Única capa HTTP sobre la API Fetch: manifiesto, streams, salud y estáticos.
 * La lógica del addon (consulta y formato) vive en addon.js; aquí solo se
 * enruta, aplica CORS y administra la caché del edge con la Cache API.
 */

const addon = require('./addon');

const JSON_TYPE = 'application/json; charset=utf-8';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
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
    headers: { 'Content-Type': JSON_TYPE, ...extraHeaders }
  }));
}

/**
 * Cache-Control de una respuesta de streams, igual que antes:
 * el máximo del handler con su gemelo s-maxage para el edge, y no-store
 * cuando no hay directivas válidas (fallo de base de datos).
 */
function streamCacheControl(result) {
  if (!Number.isInteger(result.cacheMaxAge)) return 'no-store';
  const parts = [`s-maxage=${result.cacheMaxAge}`, `max-age=${result.cacheMaxAge}`];
  if (Number.isInteger(result.staleRevalidate)) parts.push(`stale-while-revalidate=${result.staleRevalidate}`);
  if (Number.isInteger(result.staleError)) parts.push(`stale-if-error=${result.staleError}`);
  parts.push('public');
  return parts.join(', ');
}

function manifestResponse(url) {
  const proto = url.protocol.replace(/:$/, '');
  const host = url.host;
  // El origen solo se coloca en metadatos públicos si el host es válido;
  // nunca se inyectan cabeceras de la petición en la respuesta.
  const valid = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && ['http', 'https'].includes(proto);
  const brand = `${proto}://${host}/assets/brand.png`;
  return decorate(new Response(JSON.stringify({
    ...addon.manifest,
    ...(valid ? { logo: brand, icon: brand } : {})
  }), {
    headers: {
      'Content-Type': JSON_TYPE,
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600'
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

function healthResponse() {
  return decorate(new Response(JSON.stringify({ status: 'ok', version: addon.manifest.version }), {
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' }
  }));
}

async function staticResponse(request, url, env) {
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    const response = await env.ASSETS.fetch(request);
    // Un archivo ausente cae al 404 en JSON, como antes: sin caché implícita.
    if (!response.ok) return jsonResponse({ error: 'No encontrado' }, 404);
    const cacheControl = url.pathname.startsWith('/assets/') ? 'public, max-age=86400' : undefined;
    return decorate(response, { 'Cache-Control': cacheControl });
  }
  // Sin binding de estáticos (pruebas directas): 404 en lugar de romper.
  return jsonResponse({ error: 'No encontrado' }, 404);
}

/**
 * Caché del edge con la Cache API: solo GET, solo 200 y solo respuestas que
 * anuncian s-maxage explícito; los fallos y /health nunca se almacenan.
 */
async function edgeCache(request, ctx, generate) {
  const store = typeof caches !== 'undefined' && caches ? caches.default : null;
  const cacheableMethod = request.method === 'GET';
  const bypass = /no-store/.test(request.headers.get('cache-control') || '');
  if (store && cacheableMethod && !bypass) {
    try {
      const hit = await store.match(request);
      if (hit) return hit;
    } catch (_) { /* cache no disponible */ }
  }
  const response = await generate();
  if (store && cacheableMethod && !bypass && response.status === 200 &&
      /s-maxage=\d+/.test(response.headers.get('cache-control') || '')) {
    keepAliveFor(ctx)(store.put(request, response.clone()));
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
      response = await edgeCache(request, ctx, () => manifestResponse(url));
    } else if (url.pathname === '/health') {
      response = healthResponse();
    } else {
      const streamMatch = STREAM_ROUTE.exec(url.pathname);
      if (streamMatch) {
        response = await edgeCache(request, ctx, () => streamResponse(streamMatch, url, ctx));
      } else if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
        response = await staticResponse(request, url, env);
      } else {
        response = jsonResponse({ error: 'No encontrado' }, 404);
      }
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
