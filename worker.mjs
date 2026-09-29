/**
 * Nexo Play - Entrada para Cloudflare Workers
 *
 * Sirve el API (manifest.json, /stream, /health) con paridad de cabeceras
 * respecto a app.js (Express/Vercel). El landing y los assets de public/ se
 * sirven como Static Assets antes de invocar este worker (ver wrangler.jsonc),
 * igual que el CDN de Vercel sirve assets sin invocar la función.
 *
 * Cache de edge: la Cache API de Workers reemplaza el s-maxage de Vercel.
 * x-nexo-cache: hit|miss permite verificar el acierto en producción.
 */

import addon from './addon.js';
import nodeProcess from 'node:process';

// ---------------------------------------------------------------------------
// Cabeceras comunes del API (espejo del middleware de app.js)
// ---------------------------------------------------------------------------
const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...API_HEADERS, ...headers }
  });
}

// Supabase se configura con variables/secretos de Workers; se copian a
// process.env (nodejs_compat) para reutilizar addon.js sin cambios.
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
function hydrateEnv(env) {
  if (!env) return;
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value && !process.env[key]) process.env[key] = value;
  }
}

const cacheStorage = () => {
  try { return globalThis.caches?.default ?? null; } catch (_) { return null; }
};

async function matchCache(key) {
  const cache = cacheStorage();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (hit) hit.headers.set('x-nexo-cache', 'hit');
    return hit;
  } catch (_) { return null; }
}

// Guarda en el edge solo lo que el SDK declara cacheable (con max-age y sin
// no-store), replicando el efecto del s-maxage añadido por app.js en Vercel.
function edgeCache(key, response, ctx) {
  const control = response.headers.get('Cache-Control') || '';
  const cache = cacheStorage();
  if (!cache || !control || control.includes('no-store') || !/(^|,)\s*(s-maxage|max-age)=\d+/.test(control)) return response;
  try {
    const stored = response.clone();
    stored.headers.set('x-nexo-cache', 'hit');
    ctx.waitUntil(cache.put(key, stored).catch(err => {
      console.warn('[Worker] cache.put falló:', err?.message || err);
    }));
  } catch (err) { /* un fallo de caché nunca debe romper la respuesta */ }
  return response;
}

// Espejo exacto de getRouter.js del SDK + edgeCacheControl de app.js:
// "max-age=120, stale-while-revalidate=600, public" → "s-maxage=120, ..."
function buildCacheControl(result) {
  const directives = [
    ['cacheMaxAge', 'max-age'],
    ['staleRevalidate', 'stale-while-revalidate'],
    ['staleError', 'stale-if-error']
  ].map(([prop, name]) => Number.isInteger(result?.[prop]) ? `${name}=${result[prop]}` : null)
    .filter(Boolean);
  let control = directives.join(', ');
  if (control) control += ', public';
  if (!control) return 'no-store';
  const match = /(?:^|,)\s*max-age=(\d+)/.exec(control);
  if (match) control = `s-maxage=${match[1]}, ${control}`;
  return control;
}

function buildManifestResponse(url) {
  // El logo depende del host; se valida como en app.js antes de inyectarlo.
  const host = url.hostname + (url.port ? `:${url.port}` : '');
  const proto = url.protocol.replace(':', '');
  const valid = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && ['http', 'https'].includes(proto);
  const body = { ...addon.manifest, ...(valid ? {
    logo: `${proto}://${host}/assets/brand.png`, icon: `${proto}://${host}/assets/brand.png`
  } : {}) };
  return json(body, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' } });
}

// /stream/:type/:id.json y /stream/:type/:id/:extra.json (mismas rutas que el
// SDK sirve en Vercel a través del rewrite y el catch-all de vercel.json).
const STREAM_ROUTE = /^\/stream\/([^/]+)\/([^/]+?)(?:\/([^/]*))?\.json$/i;

function parseExtra(segment) {
  if (!segment) return {};
  try { return Object.fromEntries(new URLSearchParams(segment)); } catch (_) { return {}; }
}

async function handle(request, env, ctx) {
  hydrateEnv(env);
  addon.setKeepAlive(promise => ctx.waitUntil(promise));

  const url = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: API_HEADERS });
  if (method !== 'GET' && method !== 'HEAD') {
    return json({ error: 'Método no permitido' }, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }

  const respond = response => method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;

  if (url.pathname === '/health') {
    return respond(json({ status: 'ok', version: addon.manifest.version }, { headers: { 'Cache-Control': 'no-store' } }));
  }

  if (url.pathname === '/manifest.json') {
    const key = new Request(url.href, { method: 'GET' });
    const hit = await matchCache(key);
    if (hit) return respond(hit);
    return respond(edgeCache(key, buildManifestResponse(url), ctx));
  }

  const stream = STREAM_ROUTE.exec(url.pathname);
  if (stream) {
    const [, type, id, extraSegment] = stream;
    const key = new Request(url.href, { method: 'GET' });
    const hit = await matchCache(key);
    if (hit) return respond(hit);
    let result;
    try {
      result = await addon.get('stream', type, id, parseExtra(extraSegment));
    } catch (err) {
      console.error('[Worker] handler error:', err?.message || err);
      return respond(json({ err: 'handler error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }));
    }
    // El SDK serializa la respuesta completa, incluidos los TTL internos.
    return respond(edgeCache(key, json(result, { headers: { 'Cache-Control': buildCacheControl(result) } }), ctx));
  }

  return respond(json({ error: 'No encontrado' }, { status: 404 }));
}

// Formato ES Module (requerido por Wrangler); addon.js y el resto siguen en CJS.
export default {
  async fetch(request, env = {}, ctx = { waitUntil() {} }) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error('[Worker] Error no controlado:', err?.message || err);
      return json({ error: 'Error interno' }, { status: 500 });
    }
  }
};
