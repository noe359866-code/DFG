const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_URL, targetUrl, productionUrlFor, checkLive, main } = require('../scripts/check-live');

function jsonFetch(payloads) {
  return async url => {
    for (const [suffix, body] of Object.entries(payloads)) {
      if (url.endsWith(suffix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

test('check:live resolves the target URL from the flag, the environment and the default', () => {
  assert.equal(targetUrl([], {}).href, `${DEFAULT_URL}/`);
  assert.equal(targetUrl([], { CHECK_LIVE_URL: 'ejemplo.workers.dev' }).href, 'https://ejemplo.workers.dev/');
  assert.equal(targetUrl(['--url', 'http://127.0.0.1:8787'], {}).href, 'http://127.0.0.1:8787/');
  assert.equal(targetUrl(['--url', 'https://ejemplo.dev/health'], {}).pathname, '/health');
  assert.throws(() => targetUrl(['--url', 'ftp://ejemplo.dev'], {}), /Protocolo no soportado/);
});

test('check:live tells a Preview hostname from the published one', () => {
  assert.equal(
    productionUrlFor('arena-01a0efe3-dfg-nexo-player-app.noe359866.workers.dev'),
    'https://nexo-player-app.noe359866.workers.dev'
  );
  assert.equal(
    productionUrlFor('2593777b-nexo-player-app.noe359866.workers.dev'),
    'https://nexo-player-app.noe359866.workers.dev'
  );
  assert.equal(productionUrlFor('nexo-player-app.noe359866.workers.dev'), null);
  assert.equal(productionUrlFor('ejemplo.workers.dev'), null);
});

test('check:live compares the deployed version with the package and reports Supabase', async () => {
  const url = new URL('https://nexo-player-app.noe359866.workers.dev');
  const fetchImpl = jsonFetch({ '/health': { version: '9.9.9', supabase: { configured: true } }, '/manifest.json': { version: '9.9.9' } });
  const same = await checkLive(url, { fetchImpl, expected: '9.9.9' });
  assert.equal(same.matches, true);
  assert.equal(same.supabase, true);
  assert.equal(same.preview, null);

  const stale = await checkLive(url, { fetchImpl, expected: '1.0.0' });
  assert.equal(stale.matches, false, 'una versión distinta a la del paquete no cuadra');
  assert.equal(stale.health, '9.9.9');

  const preview = await checkLive(new URL('https://2593777b-nexo-player-app.noe359866.workers.dev'), { fetchImpl, expected: '9.9.9' });
  assert.equal(preview.preview, 'https://nexo-player-app.noe359866.workers.dev');
});

test('check:live survives an unreachable deployment and exits non-zero', async () => {
  const offline = async () => { throw new Error('sin red'); };
  const result = await checkLive(new URL('https://ejemplo.dev'), { fetchImpl: offline, expected: '1.6.1' });
  assert.equal(result.responded, false);
  assert.equal(result.matches, false);
  const lines = [];
  const code = await main(['--url', 'https://ejemplo.dev'], {}, line => lines.push(line));
  assert.equal(code, 1, 'sin respuesta el proceso devuelve 1');
  assert.match(lines.join('\n'), /no respondió/);
});

test('check:live reports the published version when it matches', async () => {
  const fetchImpl = jsonFetch({ '/health': { version: '9.9.9', supabase: { configured: false } }, '/manifest.json': { version: '9.9.9' } });
  const result = await checkLive(new URL('https://ejemplo.dev'), { fetchImpl, expected: '9.9.9' });
  assert.equal(result.supabase, false);
  assert.equal(result.matches, true);
});

test('the landing revalidates on every visit and publishes the manifest version', () => {
  const headers = fs.readFileSync(path.join(__dirname, '..', 'public', '_headers'), 'utf8');
  const rootRule = headers.split(/^\/(?:index\.html)?$/m)[1] || '';
  assert.match(rootRule, /Cache-Control: public, max-age=0, must-revalidate/, 'la portada no se queda cacheada con la versión anterior');
  assert.doesNotMatch(rootRule, /max-age=[1-9]/, 'la portada no anuncia frescura propia');
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(landing, new RegExp(`id="version">${require('../addon').manifest.version}</b>`), 'el HTML de reserva usa la versión del manifiesto');
  assert.match(landing, new RegExp(`id="release">NOVEDADES · ${require('../addon').manifest.version}<`), 'el rótulo de novedades usa la versión del manifiesto');
});
