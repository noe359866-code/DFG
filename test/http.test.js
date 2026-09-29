const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const listener = require('../server');

test('routes, image, CORS, methods and safe landing', async t => {
  const server = http.createServer(listener);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, options) => fetch(base + path, options);
  const manifestResponse = await get('/manifest.json');
  assert.equal(manifestResponse.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
  assert.equal(manifestResponse.headers.get('x-content-type-options'), 'nosniff');
  const manifest = await (await get('/manifest.json')).json();
  assert.equal(manifest.version, '1.3.0');
  assert.deepEqual(manifest.stremioAddonsConfig, {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..g42ZuVG1dWzDRcFDdl2fSg.XTSmojbOIelhstXtRYc4quyFOTqqzzpM5A37XgsUCQFnXn0-CvOqL4-_cB0Ici9r4PKbof275NCBIoyHkfXYEcjZGKHnoEekJ06szsimbfujDbMlELhpntPJ-KR5uH0n.nl6gG0luYfRKGH23oOt-YQ'
  });
  assert.match(manifest.logo, /assets\/brand.png$/);
  assert.match(manifest.logo, /^http:\/\//, 'el manifiesto local usa el origen de la petición');
  const landing = await (await get('/', { headers: { 'x-forwarded-host': '<script>alert(1)</script>' } })).text();
  assert.match(landing, /Nexo Play/);
  assert.doesNotMatch(landing, /<script>alert/);
  assert.match(landing, /href="https:\/\/discord\.gg\/qEcdvvcA4" target="_blank" rel="noopener noreferrer"/, 'el canal de soporte de Discord debe estar en la portada');
  const image = await get('/assets/brand.png');
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(image.headers.get('access-control-allow-origin'), '*');
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/health-anything')).status, 404);
  const options = await get('/manifest.json', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  const post = await get('/manifest.json', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
  const head = await get('/manifest.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '', 'HEAD no lleva cuerpo');
  const streams = await get('/stream/movie/tt1234567.json');
  assert.equal(streams.status, 200);
  assert.deepEqual((await streams.json()).streams, []);
  assert.ok(!/(s-maxage|max-age)/.test(streams.headers.get('cache-control') || ''), 'los fallos de base de datos no se cachean');
  assert.equal(streams.headers.get('cache-control'), 'no-store');
});
test('landing version matches the manifest version', async t => {
  const server = http.createServer(listener);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const landing = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  assert.match(landing, new RegExp(`id="version">${require('../addon').manifest.version}</b>`), 'la versión de la portada debe coincidir con el manifiesto');
});
test('stream cache control mirrors the handler result for the edge', () => {
  const { streamCacheControl } = require('../worker');
  assert.equal(
    streamCacheControl({ streams: [{ infoHash: 'a'.repeat(40) }], cacheMaxAge: 120, staleRevalidate: 600 }),
    's-maxage=120, max-age=120, stale-while-revalidate=600, public'
  );
  assert.equal(streamCacheControl({ streams: [], cacheMaxAge: 60 }), 's-maxage=60, max-age=60, public');
  assert.equal(streamCacheControl({ streams: [] }), 'no-store');
  assert.equal(streamCacheControl({ streams: [], cacheMaxAge: '120' }), 'no-store');
});
test('stream ids with path extras still resolve like the SDK router', async t => {
  const server = http.createServer(listener);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const encoded = await fetch(`${base}/stream/series/tt1234567%3A1%3A5.json`);
  assert.equal(encoded.status, 200);
  assert.deepEqual((await encoded.json()).streams, []);
  const withExtra = await fetch(`${base}/stream/series/tt1234567:1:5/video_id=abc.json`);
  assert.equal(withExtra.status, 200);
  assert.deepEqual((await withExtra.json()).streams, []);
  const badType = await fetch(`${base}/stream/tv/tt1234567.json`);
  assert.equal(badType.status, 200);
  assert.deepEqual((await badType.json()).streams, []);
});
