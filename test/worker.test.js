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

  const head = await fetchWorker('/stream/movie/tt1234567.json', { ctx, init: { method: 'HEAD' } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '', 'HEAD devuelve solo cabeceras');
  assert.equal(calls, 1, 'HEAD reutiliza el GET cacheado sin ejecutar de nuevo el handler');
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

test('TV catalog, metadata and stream routes are exposed by the Worker', async t => {
  const originalCatalog = addon.helpers.tvCatalogHandler;
  const originalMeta = addon.helpers.tvMetaHandler;
  const originalStream = addon.helpers.tvStreamHandler;
  const calls = [];
  addon.helpers.tvCatalogHandler = async args => {
    calls.push(['catalog', args]);
    return { metas: [{ id: 'nexo-tv:aWQ6MQ', type: 'tv', name: 'Canal Uno' }], cacheMaxAge: 120 };
  };
  addon.helpers.tvMetaHandler = async args => {
    calls.push(['meta', args]);
    return { meta: { id: args.id, type: 'tv', name: 'Canal Uno' }, cacheMaxAge: 120 };
  };
  addon.helpers.tvStreamHandler = async args => {
    calls.push(['stream', args]);
    return { streams: [{ url: 'https://video.example/live.m3u8' }], cacheMaxAge: 120 };
  };
  t.after(() => {
    addon.helpers.tvCatalogHandler = originalCatalog;
    addon.helpers.tvMetaHandler = originalMeta;
    addon.helpers.tvStreamHandler = originalStream;
  });

  const catalogResponse = await fetchWorker('/catalog/tv/tv_channels/search=Noticias&skip=100.json');
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.headers.get('cache-control'), 's-maxage=120, max-age=120, public');
  assert.equal((await catalogResponse.json()).metas[0].name, 'Canal Uno');
  assert.deepEqual(calls[0][1].extra, { search: 'Noticias', skip: '100' });
  assert.equal(calls[0][1].origin, 'https://example.com');

  const byCountry = await fetchWorker('/catalog/tv/tv_channels_country.json?genre=Nicaragua');
  assert.equal(byCountry.status, 200);
  assert.equal(calls[1][1].id, 'tv_channels_country', 'el catálogo por país enruta al mismo handler');
  assert.deepEqual(calls[1][1].extra, { genre: 'Nicaragua' });

  const channelId = 'nexo-tv:aWQ6MQ';
  const metadata = await fetchWorker(`/meta/tv/${channelId}.json`);
  assert.equal((await metadata.json()).meta.id, channelId);
  const playback = await fetchWorker(`/stream/tv/${channelId}.json`);
  assert.equal((await playback.json()).streams[0].url, 'https://video.example/live.m3u8');
  assert.deepEqual(calls.slice(2).map(call => call[0]), ['meta', 'stream']);
});

test('TV catalog query filters use separate edge-cache keys', async t => {
  const caches = mockCaches();
  globalThis.caches = caches;
  const original = addon.helpers.tvCatalogHandler;
  let calls = 0;
  addon.helpers.tvCatalogHandler = async ({ extra }) => {
    calls++;
    return { metas: [{ type: 'tv', name: extra.search }], cacheMaxAge: 60 };
  };
  t.after(() => {
    addon.helpers.tvCatalogHandler = original;
    delete globalThis.caches;
  });
  const tasks = [];
  const ctx = { waitUntil: task => tasks.push(task) };
  const news = await fetchWorker('/catalog/tv/tv_channels.json?search=Noticias&skip=0', { ctx });
  const sports = await fetchWorker('/catalog/tv/tv_channels.json?search=Deportes&skip=0', { ctx });
  assert.equal((await news.json()).metas[0].name, 'Noticias');
  assert.equal((await sports.json()).metas[0].name, 'Deportes');
  const reorderedNews = await fetchWorker('/catalog/tv/tv_channels.json?skip=0&search=Noticias', { ctx });
  assert.equal((await reorderedNews.json()).metas[0].name, 'Noticias');
  await Promise.all(tasks);
  assert.equal(calls, 2, 'cada filtro genera su catálogo una sola vez aunque cambie el orden de los parámetros');
  assert.equal(caches.puts, 2, 'la query normalizada forma parte de la clave del catálogo');
});

test('manifest publishes the TV filters discovered in the table', async t => {
  const original = addon.helpers.tvCatalogOptions;
  t.after(() => {
    addon.helpers.tvCatalogOptions = original;
    addon.helpers.resetTVGenreOptionsCache();
  });

  addon.helpers.tvCatalogOptions = async () => ({
    contentTypes: ['Noticias', 'Deportes'], countries: ['España', 'Nicaragua']
  });
  const manifest = await (await fetchWorker('/manifest.json')).json();
  assert.deepEqual(manifest.catalogs.map(catalog => catalog.id), ['tv_channels', 'tv_channels_country']);
  assert.deepEqual(manifest.catalogs[0].genres, ['Noticias', 'Deportes']);
  assert.deepEqual(manifest.catalogs[0].extra[0].options, ['Noticias', 'Deportes']);
  assert.deepEqual(manifest.catalogs[1].genres, ['España', 'Nicaragua']);
  assert.deepEqual(manifest.catalogs[1].extra[0].options, ['España', 'Nicaragua']);

  addon.helpers.tvCatalogOptions = async () => null;
  const fallback = await (await fetchWorker('/manifest.json')).json();
  assert.ok(fallback.catalogs[0].genres.includes('Deportes'),
    'sin datos descubiertos el manifiesto publica la lista de respaldo');
  assert.ok(fallback.catalogs[1].genres.includes('España'));
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
  const verification = await fetchWorker('/google2a0fb4fe78f89332.html', { env: { ASSETS: assets } });
  assert.equal(verification.status, 200, 'el archivo de Search Console se sirve en la raíz del sitio');
  assert.match(verification.headers.get('content-type') || '', /text\/html/);
  assert.equal(await verification.text(), 'google-site-verification: google2a0fb4fe78f89332.html\n');
  const missing = await fetchWorker('/assets/missing.png', { env: { ASSETS: assets } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'No encontrado' });

  const notModified = await fetchWorker('/assets/brand.png', {
    env: { ASSETS: { fetch: async () => new Response(null, { status: 304, headers: { ETag: '"asset"' } }) } }
  });
  assert.equal(notModified.status, 304, '304 de estáticos es una revalidación válida, no un 404');
  assert.equal(notModified.headers.get('etag'), '"asset"');
  const partial = await fetchWorker('/assets/brand.png', {
    env: { ASSETS: { fetch: async () => new Response('contenido parcial', { status: 206 }) } }
  });
  assert.equal(partial.status, 206, '206 de estáticos es válido para peticiones Range');
});

test('health never announces cache and the worker configures Supabase from env', async () => {
  const health = await fetchWorker('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const bare = await health.json();
  assert.equal(bare.version, addon.manifest.version);
  assert.deepEqual(bare.supabase, { configured: false, url: 'missing', key: 'missing' },
    '/health resume la presencia de la clave sin exponer su tipo ni valor');
  assert.deepEqual(bare.diagnostic, {
    code: 'SUPABASE_URL_MISSING',
    message: 'Define SUPABASE_URL en los secretos del despliegue.'
  }, 'el diagnóstico indica la acción correctiva sin mostrar secretos');

  const injected = await fetchWorker('/health', { env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' } });
  const healthyConfig = await injected.json();
  assert.deepEqual(healthyConfig.supabase, { configured: true, url: 'ok', key: 'present' });
  assert.equal(healthyConfig.diagnostic.code, 'CONFIG_PRESENT');
  assert.match(healthyConfig.diagnostic.message, /no comprueba la conexión/);
  const client = addon.helpers.getSupabaseClient();
  assert.ok(client, 'el Worker inyecta los secretos en el cliente de Supabase');
  assert.equal(client.supabaseUrl, 'https://example.supabase.co');
  // Restaura el estado sin credenciales para el resto de pruebas.
  addon.helpers.configure(null);
  assert.equal(addon.helpers.getSupabaseClient(), null);
});
