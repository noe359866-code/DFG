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
    const manifest = await (await get('/manifest.json')).json();
    assert.equal(manifest.version, '1.2.1');
    assert.match(manifest.logo, /assets\/brand.png$/);
    const landing = await (await get('/', { headers: { 'x-forwarded-host': '<script>alert(1)</script>' } })).text();
    assert.match(landing, /Nexo Play/);
    assert.doesNotMatch(landing, /<script>alert/);
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
  });
}
