const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
for (const [name, handler] of [['local', require('../app')], ['vercel', require('../api')]]) {
  test(`${name}: routes, image, CORS, methods and safe landing`, async t => {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const route = path => name === 'vercel' ? `/api/index?__path=${encodeURIComponent(path)}` : path;
    const get = (path, options) => fetch(base + route(path), options);
    const manifestResponse = await get('/manifest.json');
    assert.equal(manifestResponse.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
    const manifest = await (await get('/manifest.json')).json();
    assert.equal(manifest.version, '1.2.4');
    assert.deepEqual(manifest.stremioAddonsConfig, {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..g42ZuVG1dWzDRcFDdl2fSg.XTSmojbOIelhstXtRYc4quyFOTqqzzpM5A37XgsUCQFnXn0-CvOqL4-_cB0Ici9r4PKbof275NCBIoyHkfXYEcjZGKHnoEekJ06szsimbfujDbMlELhpntPJ-KR5uH0n.nl6gG0luYfRKGH23oOt-YQ'
    });
    assert.match(manifest.logo, /assets\/brand.png$/);
    const landing = await (await get('/', { headers: { 'x-forwarded-host': '<script>alert(1)</script>' } })).text();
    assert.match(landing, /Nexo Play/);
    assert.doesNotMatch(landing, /<script>alert/);
    assert.match(landing, /href="https:\/\/discord\.gg\/qEcdvvcA4" target="_blank" rel="noopener noreferrer"/, 'el canal de soporte de Discord debe estar en la portada');
    assert.equal((await get('/assets/brand.png')).headers.get('content-type'), 'image/png');
    assert.equal((await get('/health')).status, 200);
    assert.equal((await get('/health-anything')).status, 404);
    const options = await get('/manifest.json', { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');
    assert.equal((await get('/manifest.json', { method: 'POST' })).status, 405);
    const streams = await get('/stream/movie/tt1234567.json');
    assert.equal(streams.status, 200);
    assert.deepEqual((await streams.json()).streams, []);
    assert.ok(!/(s-maxage|max-age)/.test(streams.headers.get('cache-control') || ''), 'los fallos de base de datos no se cachean');
  });
}
test('landing version matches the manifest version', async t => {
  const server = http.createServer(require('../app'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const landing = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  assert.match(landing, new RegExp(`id="version">${require('../addon').manifest.version}</b>`), 'la versión de la portada debe coincidir con el manifiesto');
});
test('sdk cache headers gain an s-maxage twin for the edge', () => {
  const { edgeCacheControl } = require('../app');
  const run = value => {
    const headers = {};
    const res = { setHeader: (key, headerValue) => { headers[String(key).toLowerCase()] = headerValue; } };
    edgeCacheControl({}, res, () => {});
    res.setHeader('Cache-Control', value);
    return headers['cache-control'];
  };
  assert.equal(run('max-age=120, stale-while-revalidate=600, public'), 's-maxage=120, max-age=120, stale-while-revalidate=600, public');
  assert.equal(run('no-store'), 'no-store');
});
