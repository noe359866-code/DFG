const { test } = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../addon');
const { handleRequest } = require('../worker');

const fetchWorker = (path, { env = {}, ctx, init } = {}) =>
  handleRequest(new Request(`https://example.com${path}`, init), env, ctx);

// Cache API simulada: almacena por URL y devuelve copias reutilizables.
function mockCaches() {
  const store = new Map();
  let puts = 0;
  let matches = 0;
  return {
    store,
    get puts() { return puts; },
    get matches() { return matches; },
    default: {
      async match(request) {
        matches++;
        const stored = store.get(request.url);
        return stored ? stored.clone() : undefined;
      },
      async put(request, response) {
        puts++;
        store.set(request.url, response);
      }
    }
  };
}

test('manifest is served from the edge cache after the first miss', async t => {
  const caches = mockCaches();
  globalThis.caches = caches;
  t.after(() => { delete globalThis.caches; });
  const tasks = [];
  const ctx = { waitUntil: task => tasks.push(task) };

  const first = await fetchWorker('/manifest.json', { ctx });
  assert.equal(first.status, 200);
  const expectedCache = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600, stale-if-error=3600';
  assert.equal(first.headers.get('cache-control'), expectedCache);
  assert.equal(first.headers.get('strict-transport-security'), 'max-age=31536000', 'HTTPS añade HSTS');
  const etag = first.headers.get('etag');
  assert.match(etag || '', /^"/, 'el manifiesto incluye ETag');
  await Promise.all(tasks);
  assert.equal(caches.puts, 1, 'la respuesta cacheable se guarda en la Cache API');

  const second = await fetchWorker('/manifest.json?utm=irrelevante', { ctx });
  assert.equal(caches.puts, 1, 'la clave de caché ignora la cadena de consulta');
  assert.equal(second.headers.get('cache-control'), expectedCache);
  assert.equal((await second.json()).id, addon.manifest.id);

  const notModified = await fetchWorker('/manifest.json?otra=variante', {
    ctx, init: { headers: { 'if-none-match': etag } }
  });
  assert.equal(notModified.status, 304, 'el 304 funciona también desde la caché del edge');
  assert.equal(notModified.headers.get('etag'), etag);
  assert.equal(caches.puts, 1, 'un 304 no vuelve a guardar nada');
});

test('stream success announces edge cache, waits on ctx and is stored once', async t => {
  const caches = mockCaches();
  globalThis.caches = caches;
  const original = addon.helpers.cachedStreamHandler;
  let calls = 0;
  addon.helpers.cachedStreamHandler = async () => {
    calls++;
    return { streams: [{ infoHash: 'a'.repeat(40), name: 'Nexo Play\n[ESP] 1080p', title: 'Título' }],
      cacheMaxAge: 120, staleRevalidate: 600, staleError: 600 };
  };
  t.after(() => {
    addon.helpers.cachedStreamHandler = original;
    delete globalThis.caches;
  });
  const tasks = [];
  const ctx = { waitUntil: task => tasks.push(task) };

  const first = await fetchWorker('/stream/movie/tt1234567.json', { ctx });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 's-maxage=120, max-age=120, stale-while-revalidate=600, stale-if-error=600, public');
  const body = await first.json();
  assert.equal(body.streams.length, 1);
  assert.equal(body.cacheMaxAge, 120);
  await Promise.all(tasks);
  assert.equal(caches.puts, 1, 'ctx.waitUntil recibe el guardado en caché');

  const second = await fetchWorker('/stream/movie/tt1234567.json', { ctx });
  assert.equal(calls, 1, 'el edge responde sin volver a llamar al handler');
  assert.equal(second.headers.get('cache-control'), 's-maxage=120, max-age=120, stale-while-revalidate=600, stale-if-error=600, public');
  assert.equal((await second.json()).streams.length, 1);
});

test('failures and client no-store never reach the edge cache', async t => {
  const caches = mockCaches();
  globalThis.caches = caches;
  const original = addon.helpers.cachedStreamHandler;
  let calls = 0;
  addon.helpers.cachedStreamHandler = async () => ({ streams: [] });
  t.after(() => {
    addon.helpers.cachedStreamHandler = original;
    delete globalThis.caches;
  });
  const tasks = [];
  const ctx = { waitUntil: task => tasks.push(task) };

  const failed = await fetchWorker('/stream/movie/tt1234567.json', { ctx });
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  await Promise.all(tasks);
  assert.equal(caches.puts, 0, 'los fallos no se almacenan');

  addon.helpers.cachedStreamHandler = async () => { calls++; return { streams: [], cacheMaxAge: 60 }; };
  const plain = await fetchWorker('/stream/movie/tt7654321.json', { ctx });
  assert.equal(plain.headers.get('cache-control'), 's-maxage=60, max-age=60, public');
  await Promise.all(tasks);
  assert.equal(caches.puts, 1);
  const bypass = await fetchWorker('/stream/movie/tt7654321.json', {
    ctx, init: { headers: { 'cache-control': 'no-store' } }
  });
  assert.equal(calls, 2, 'no-store del cliente obliga a regenerar');
  assert.equal(bypass.status, 200);
  await Promise.all(tasks);
  assert.equal(caches.puts, 1, 'no-store del cliente tampoco almacena en el edge');
});

test('static assets are served through the ASSETS binding with one day of cache', async t => {
  const assets = require('../server').assets;
  const landing = await fetchWorker('/', { env: { ASSETS: assets } });
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /text\/html/);
  assert.equal(landing.headers.get('access-control-allow-origin'), '*');
  const image = await fetchWorker('/assets/brand.png', { env: { ASSETS: assets } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');
  const missing = await fetchWorker('/assets/missing.png', { env: { ASSETS: assets } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'No encontrado' });
});

test('health never announces cache and the worker configures Supabase from env', async () => {
  const health = await fetchWorker('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).version, addon.manifest.version);

  await fetchWorker('/health', { env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' } });
  const client = addon.helpers.getSupabaseClient();
  assert.ok(client, 'el Worker inyecta los secretos en el cliente de Supabase');
  assert.equal(client.supabaseUrl, 'https://example.supabase.co');
  // Restaura el estado sin credenciales para el resto de pruebas.
  addon.helpers.configure(null);
  assert.equal(addon.helpers.getSupabaseClient(), null);
});
