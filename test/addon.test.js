const { test } = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../addon');
const { parseStremioId, getLanguageTag, formatSizeGB, extractInfoHashFromMagnet, extractTrackersFromMagnet, streamHandler } = addon.helpers;
const hash = 'a'.repeat(40);
test('consistent release and private public description', () => {
  assert.equal(addon.manifest.version, require('../package.json').version);
  assert.equal(addon.manifest.name, 'Nexo Play');
  assert.ok(addon.manifest.description.includes('Grupo de soporte: https://discord.com/invite/qEcdvvcA4'));
  assert.doesNotMatch(addon.manifest.description, /supabase|public\.torrents|service_role/i);
});
test('public stremio-addons.net verification in manifest', () => {
  assert.equal(addon.manifest.stremioAddonsConfig.issuer, 'https://stremio-addons.net');
  assert.match(addon.manifest.stremioAddonsConfig.signature, /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]*$/);
});
test('strict ids and specials', () => {
  for (const id of ['ttbad', 'tt1234567:1x:2', 'tt1234567:1', 'tt1234567:1:2:3', null]) assert.equal(parseStremioId(id).imdbId, null);
  assert.deepEqual(parseStremioId('tt1234567:0:2'), { imdbId: 'tt1234567', season: 0, episode: 2 });
});
test('language does not default to Spanish or match title substrings', () => {
  for (const [row, tag] of [[{ audio: 'English' }, 'ENG'], [{ language: 'es' }, 'ESP'], [{ audio: 'en-US' }, 'ENG'], [{ title: 'The Last Castle' }, 'N/D'], [{ audio: 'English Spanish' }, 'DUAL'], [{ audio: 'Castellano' }, 'CAST'], [{ title: 'Movie VOSE' }, 'VOSE'], [{ audio: 'English', title: 'Spanish story' }, 'ENG']]) assert.equal(getLanguageTag(row), tag);
});
test('sizes are finite and handle decimal commas', () => {
  assert.equal(formatSizeGB({ size: '1,5 GB' }), '1.50');
  assert.equal(formatSizeGB({ size: '512 MB' }), '0.50');
  assert.equal(formatSizeGB({ size_bytes: 'bad' }), '—');
  assert.equal(formatSizeGB({ size_bytes: 0 }), '0.00');
});
test('magnet parsing validates complete hex and base32 hashes', () => {
  assert.equal(extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${hash}`), hash);
  assert.equal(extractInfoHashFromMagnet('magnet:?xt=urn:btih:' + 'A'.repeat(32)), '0'.repeat(40));
  assert.equal(extractInfoHashFromMagnet(`https://x/urn:btih:${hash}`), null);
  assert.equal(extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${hash}fff`), null);
});
test('magnet trackers must be udp or http(s) urls', () => {
  assert.deepEqual(
    extractTrackersFromMagnet(`magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337&tr=javascript:alert(1)&tr=ws://x&tr=https://tracker.example.org/announce`),
    ['udp://tracker.opentrackr.org:1337', 'https://tracker.example.org/announce']
  );
  assert.deepEqual(extractTrackersFromMagnet('magnet:malformed'), []);
  assert.deepEqual(extractTrackersFromMagnet(null), []);
});
function mock(data, error = null) {
  const calls = [];
  const query = {};
  for (const method of ['from', 'select', 'eq', 'order', 'limit']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  query.abortSignal = async signal => { assert.ok(signal instanceof AbortSignal); return { data, error }; };
  return { client: () => query, calls };
}
test('episode filter, hash fallback, dedup and file index', async () => {
  const m = mock([{ info_hash: hash, file_idx: 0, audio: 'English' }, { info_hash: hash, file_idx: 0 }, { magnet: `magnet:?xt=urn:btih:${hash}`, file_idx: 1 }, { magnet: 'magnet:bad' }]);
  const result = await streamHandler({ type: 'series', id: 'tt1234567:0:1' }, m.client);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].fileIdx, 0);
  assert.match(result.streams[0].name, /ENG/);
  assert.ok(m.calls.some(c => c[0] === 'eq' && c[1] === 'season' && c[2] === 0));
});
test('reject invalid requests before database access', async () => {
  for (const args of [{ type: 'series', id: 'tt1234567' }, { type: 'movie', id: 'tt1234567:1:1' }, { type: 'bad', id: 'tt1234567' }]) {
    assert.deepEqual(await streamHandler(args, () => { throw Error('must not query'); }), { streams: [] });
  }
});
test('database errors return empty streams', async () => {
  const m = mock(null, { message: 'test error' });
  assert.deepEqual(await streamHandler({ type: 'movie', id: 'tt1234567' }, m.client), { streams: [] });
});
test('magnet trackers travel in sources and bingeGroup identifies the title', async () => {
  const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337&tr=udp://open.demonii.com:1337`;
  const m = mock([{ magnet, title: 'Ejemplo 1080p', seeders: 3, size: '2 GB' }]);
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, m.client);
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.streams[0].sources, ['tracker:udp://tracker.opentrackr.org:1337', 'tracker:udp://open.demonii.com:1337']);
  assert.match(result.streams[0].behaviorHints.bingeGroup, /tt1234567/);
  assert.equal(result.streams[0].behaviorHints.videoSize, 2147483648);
  assert.equal(result.streams[0].behaviorHints.filename, 'Ejemplo 1080p');
  assert.equal(result.cacheMaxAge, 120);
  assert.ok(result.staleRevalidate >= result.cacheMaxAge);
});
test('smart ranking prioritizes resolution, language and seeders, with default trackers fallback', async () => {
  const m = mock([
    { info_hash: '1'.repeat(40), title: 'Movie 720p', seeders: 50, audio: 'English' },
    { info_hash: '2'.repeat(40), title: 'Movie 1080p', seeders: 5, audio: 'Spanish' },
    { info_hash: '3'.repeat(40), title: 'Movie 4K', seeders: 2, audio: 'Spanish' }
  ]);
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, m.client);
  assert.equal(result.streams.length, 3);
  assert.equal(result.streams[0].infoHash, '3'.repeat(40)); // 4K first
  assert.equal(result.streams[1].infoHash, '2'.repeat(40)); // 1080p second
  assert.equal(result.streams[2].infoHash, '1'.repeat(40)); // 720p third
  assert.ok(result.streams[0].sources.length > 0, 'debe incluir trackers por defecto cuando no hay trackers en DB');
  assert.match(result.streams[0].sources[0], /^tracker:udp:\/\//);
});
test('empty results announce a short cache; failures announce none', async () => {
  assert.deepEqual(await streamHandler({ type: 'movie', id: 'tt1234567' }, mock([]).client), { streams: [], cacheMaxAge: 60 });
  assert.deepEqual(await streamHandler({ type: 'movie', id: 'tt1234567' }, mock(null, { message: 'fallo' }).client), { streams: [] });
});

test('magnet title supplies language and resolution; 4k substrings are not quality', async () => {
  const m = mock([{ magnet: `magnet:?xt=urn:btih:${hash}&dn=Example%201080p%20English` }]);
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, m.client);
  assert.match(result.streams[0].name, /\[ENG\] 1080p/);
  const other = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock([{ info_hash: hash, title: '14km away' }]).client);
  assert.match(other.streams[0].name, /N\/D$/);
});
test('cache coalesces requests, isolates returned objects and expires', async () => {
  let calls = 0;
  let clock = 0;
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    return { streams: [{ infoHash: hash }], cacheMaxAge: 60 };
  }, { now: () => clock });
  const args = { type: 'movie', id: 'tt1234567' };
  const [a, b] = await Promise.all([cached(args), cached(args)]);
  assert.equal(calls, 1);
  a.streams.length = 0;
  assert.equal(b.streams.length, 1);
  assert.equal((await cached(args)).streams.length, 1);
  clock = 60000;
  await cached(args);
  assert.equal(calls, 2);
});
test('cache bounded eviction, type isolation and failed-query retries', async () => {
  let calls = 0;
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    return { streams: [], cacheMaxAge: 60 };
  }, { maxEntries: 1 });
  await cached({ type: 'series', id: 'tt1234567:1:1' });
  await cached({ type: 'anime', id: 'tt1234567:1:1' });
  await cached({ type: 'series', id: 'tt1234567:1:1' });
  assert.equal(calls, 3);
  await cached({ type: 'movie', id: 'invalid' });
  assert.equal(calls, 3);
  let failures = 0;
  let failClock = 0;
  const failed = addon.helpers.createCachedStreamHandler(async () => {
    failures++;
    return { streams: [] };
  }, { now: () => failClock });
  assert.deepEqual(await failed({ type: 'movie', id: 'tt1234567' }), { streams: [] });
  assert.deepEqual(await failed({ type: 'movie', id: 'tt1234567' }), { streams: [] });
  assert.equal(failures, 1, 'un fallo reciente no vuelve a martillar la base de datos');
  failClock += 15001;
  await failed({ type: 'movie', id: 'tt1234567' });
  assert.equal(failures, 2, 'expirado el cooldown se reintenta la consulta');
  const rejected = addon.helpers.createCachedStreamHandler(async () => { throw Error('offline'); }, { now: () => failClock });
  await assert.rejects(rejected({ type: 'movie', id: 'tt1234567' }), /offline/);
  assert.deepEqual(await rejected({ type: 'movie', id: 'tt1234567' }), { streams: [] },
    'durante el cooldown las excepciones se responden como lista vacía');
  failClock += 15001;
  await assert.rejects(rejected({ type: 'movie', id: 'tt1234567' }), /offline/);
});

test('stale streams return before refresh finishes; one background refresh and decreasing TTL', async () => {
  let clock = 0;
  let calls = 0;
  let release;
  const tasks = [];
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    if (calls > 1) await new Promise(resolve => { release = resolve; });
    return { streams: [{ infoHash: hash }], cacheMaxAge: 120, staleRevalidate: 600 };
  }, { now: () => clock, keepAlive: task => tasks.push(task) });
  const args = { type: 'movie', id: 'tt1234567' };
  await cached(args);
  clock = 30000;
  assert.equal((await cached(args)).cacheMaxAge, 90);
  clock = 125000;
  const stale = await cached(args);
  assert.equal(stale.cacheMaxAge, 0);
  assert.equal(stale.staleRevalidate, 595);
  assert.equal(stale.streams.length, 1);
  await cached(args);
  assert.equal(calls, 2);
  assert.equal(tasks.length, 1);
  release();
  await tasks[0];
  assert.equal((await cached(args)).cacheMaxAge, 120);
});
test('stale fallback retries with cooldown, never extends its deadline and replaces with confirmed empty', async () => {
  let clock = 0;
  let calls = 0;
  const tasks = [];
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    if (calls === 1) return { streams: [{ infoHash: hash }], cacheMaxAge: 120, staleRevalidate: 600 };
    if (calls === 2) throw Error('database unavailable');
    return { streams: [], cacheMaxAge: 60 };
  }, { now: () => clock, keepAlive: task => tasks.push(task) });
  const args = { type: 'movie', id: 'tt1234567' };
  await cached(args);
  clock = 120000;
  assert.equal((await cached(args)).streams.length, 1);
  await tasks[0];
  clock = 130000;
  await cached(args);
  assert.equal(calls, 2);
  clock = 135000;
  await cached(args);
  await tasks[1];
  assert.equal((await cached(args)).streams.length, 0);
  clock = 200000;
  await cached(args);
  assert.equal(calls, 4, 'empty cache expires without stale fallback');
});
test('stale streams are not returned after the absolute deadline', async () => {
  let clock = 0;
  let calls = 0;
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    return calls === 1 ? { streams: [{ infoHash: hash }], cacheMaxAge: 120, staleRevalidate: 600 } : { streams: [] };
  }, { now: () => clock });
  const args = { type: 'movie', id: 'tt1234567' };
  await cached(args);
  clock = 720000;
  assert.deepEqual(await cached(args), { streams: [] });
  assert.equal(calls, 2);
});

// --- Entorno, reintentos y packs de temporada (1.4.0) ---

test('environment values are trimmed, unquoted and placeholders rejected', t => {
  const { configure, getSupabaseClient, configStatus, cleanEnvValue, normalizeSupabaseUrl } = addon.helpers;
  t.after(() => configure(null));

  configure({ SUPABASE_URL: '  https://demo.supabase.co/  ', SUPABASE_ANON_KEY: '  "clave real" \n' });
  assert.equal(cleanEnvValue('SUPABASE_URL'), 'https://demo.supabase.co/');
  assert.equal(cleanEnvValue('SUPABASE_ANON_KEY'), '"clave real" \n'.trim().replace(/^["']+|["']+$/g, '').trim());
  const client = getSupabaseClient();
  assert.ok(client, 'acepta credenciales con espacios o comillas alrededor');
  assert.equal(client.supabaseUrl, 'https://demo.supabase.co');
  assert.deepEqual(configStatus(), { configured: true, url: 'ok', keyType: 'anon' });

  configure({ SUPABASE_URL: 'https://xxxxxxxx.supabase.co', SUPABASE_ANON_KEY: 'tu_clave_anon' });
  assert.equal(getSupabaseClient(), null, 'los placeholders de .env.example no conectan');
  assert.deepEqual(configStatus(), { configured: false, url: 'missing', keyType: 'none' });

  configure({ SUPABASE_URL: 'demo.supabase.co', SUPABASE_ANON_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 's' });
  assert.equal(normalizeSupabaseUrl('demo.supabase.co'), 'https://demo.supabase.co');
  assert.equal(configStatus().keyType, 'service_role', 'la clave privilegiada tiene prioridad');

  configure({ SUPABASE_URL: 'no es una url', SUPABASE_ANON_KEY: 'k' });
  assert.equal(configStatus().url, 'invalid');
  configure(null);
  assert.deepEqual(configStatus(), { configured: false, url: 'missing', keyType: 'none' });
});

test('transient database errors are retried once; permanent ones are not', async () => {
  let attempts = 0;
  const query = {};
  for (const method of ['from', 'select', 'eq', 'order', 'limit']) query[method] = () => query;
  query.abortSignal = async () => {
    attempts++;
    return attempts === 1
      ? { data: null, error: { message: 'Network connection lost.' } }
      : { data: [{ info_hash: hash, seeders: 9 }], error: null };
  };
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, () => query);
  assert.equal(attempts, 2, 'un corte de red reintenta y acaba mostrando el contenido');
  assert.equal(result.streams.length, 1);

  let permanent = 0;
  query.abortSignal = async () => { permanent++; return { data: null, error: { message: 'JWT expired' } }; };
  const denied = await streamHandler({ type: 'movie', id: 'tt7654321' }, () => query);
  assert.equal(permanent, 1, 'los errores permanentes no duplican la espera');
  assert.deepEqual(denied, { streams: [] });
});

test('series fall back to season packs when the exact episode is missing', async () => {
  const usedIs = [];
  const query = {};
  for (const method of ['from', 'select', 'eq', 'order', 'limit']) query[method] = () => query;
  query.is = (...args) => { usedIs.push(args); return query; };
  query.abortSignal = async () => usedIs.length
    ? { data: [{ info_hash: hash, title: 'Temporada completa 1080p Spanish', seeders: 4 }], error: null }
    : { data: [], error: null };

  const result = await streamHandler({ type: 'series', id: 'tt1234567:2:5' }, () => query);
  assert.deepEqual(usedIs, [['episode', null]], 'el fallback pregunta por episodios NULL (packs)');
  assert.equal(result.streams.length, 1);
  assert.match(result.streams[0].name, /PACK T2/);
  assert.match(result.streams[0].title, /temporada 2 completa/);

  usedIs.length = 0;
  const movies = await streamHandler({ type: 'movie', id: 'tt1234567' }, () => query);
  assert.deepEqual(movies, { streams: [], cacheMaxAge: 60 });
  assert.equal(usedIs.length, 0, 'las películas nunca consultan packs');
});
