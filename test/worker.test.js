const { test } = require('node:test');
const assert = require('node:assert/strict');
const { default: worker } = require('../worker.mjs');

const ORIGIN = 'https://nexo.example';
const env = {}; // sin credenciales: mismos supuestos que test/http.test.js

// Caché de edge falsa con la semántica mínima de caches.default de Workers.
function installFakeCache() {
  const store = new Map();
  const fake = {
    async put(request, response) { store.set(request.url, response); },
    async match(request) {
      const hit = store.get(request.url);
      return hit ? hit.clone() : undefined;
    }
  };
  const original = globalThis.caches;
  globalThis.caches = { default: fake };
  return { store, restore: () => { if (original === undefined) delete globalThis.caches; else globalThis.caches = original; } };
}

const call = (path, { env: requestEnv = env, ctx = { waitUntil() {} }, ...init } = {}) =>
  worker.fetch(new Request(ORIGIN + path, init), requestEnv, ctx);

test('worker: manifest with edge cache headers, CORS and host logo', async () => {
  const response = await call('/manifest.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const manifest = await response.json();
  assert.equal(manifest.version, require('../package.json').version);
  assert.equal(manifest.logo, 'https://nexo.example/assets/brand.png');
  assert.equal(manifest.icon, 'https://nexo.example/assets/brand.png');
  assert.equal(manifest.stremioAddonsConfig.issuer, 'https://stremio-addons.net');
});

test('worker: health without cache directives', async () => {
  const response = await call('/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', version: require('../package.json').version });
});

test('worker: OPTIONS 204, POST 405 with Allow', async () => {
  const options = await call('/manifest.json', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  const post = await call('/manifest.json', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal((await post.json()).error, 'Método no permitido');
});

test('worker: streams without database return empty and are not cached', async () => {
  for (const path of ['/stream/movie/tt1234567.json', '/stream/series/tt0944947:1:5.json',
    '/stream/tv/tt1234567.json', '/stream/movie/tt1234567/gzip=1.json']) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), { streams: [] }, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.ok(!/(s-maxage|max-age)/.test(response.headers.get('cache-control') || ''), path);
  }
});

test('worker: unknown routes and missing .json are 404', async () => {
  for (const path of ['/', '/nope', '/health-anything', '/catalog/movie/tt1234567.json', '/stream/movie/tt1234567']) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error, 'No encontrado', path);
  }
});

test('worker: HEAD answers without body but with headers', async () => {
  const response = await call('/manifest.json', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
  assert.equal(await response.text(), '');
});

test('worker: edge cache stores cacheable responses and serves hits', async () => {
  const fake = installFakeCache();
  try {
    let waited = 0;
    const ctx = { waitUntil: () => waited++ };
    const first = await call('/manifest.json', { ctx });
    assert.notEqual(first.headers.get('x-nexo-cache'), 'hit');
    // El put ocurre vía waitUntil; se concede un turno al microtask queue.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(waited >= 1, 'cache.put debe ejecutarse vía ctx.waitUntil');
    assert.ok(fake.store.has(`${ORIGIN}/manifest.json`), 'la respuesta cacheable se guarda');
    assert.equal(fake.store.get(`${ORIGIN}/manifest.json`).headers.get('x-nexo-cache'), 'hit');

    const second = await call('/manifest.json', { ctx });
    assert.equal(second.headers.get('x-nexo-cache'), 'hit');
    assert.equal(second.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
    assert.equal((await second.json()).logo, 'https://nexo.example/assets/brand.png');
  } finally {
    fake.restore();
  }
});

test('worker: streams are stored in edge cache only when cacheable', async () => {
  const fake = installFakeCache();
  try {
    await call('/stream/movie/tt1234567.json', { ctx: { waitUntil() {} } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.store.size, 0, 'un fallo de base de datos no se cachea');
  } finally {
    fake.restore();
  }
});

test('worker: hydrates platform env for the Supabase client', async () => {
  const url = 'https://probe.supabase.co';
  await call('/health', { env: { SUPABASE_URL: url, SUPABASE_ANON_KEY: 'probe-key' } });
  assert.equal(process.env.SUPABASE_URL, url);
  assert.equal(process.env.SUPABASE_ANON_KEY, 'probe-key');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
});

test('worker: catch-all keeps 500 JSON without leaking internals', async () => {
  // Objeto duck-typed: el constructor Request validaría la URL antes de
  // llegar al worker, y aquí se prueba el catch interno del entrypoint.
  const response = await worker.fetch({ url: 'not a valid url', method: 'GET' }, env, { waitUntil() {} });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'Error interno');
});
