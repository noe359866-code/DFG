const { test } = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../addon');
const { parseStremioId, getLanguageTag, getResolutionTag, formatSizeGB, parseSizeBytes, sanitizeOneLine, extractInfoHashFromMagnet, extractTrackersFromMagnet, streamHandler, torrentColumns } = addon.helpers;
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
  for (const method of ['from', 'select', 'eq', 'or', 'order', 'limit']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  query.abortSignal = async signal => { assert.ok(signal instanceof AbortSignal); return { data, error }; };
  return { client: () => query, calls };
}
test('episode filter, hash fallback, dedup and file index', async () => {
  const m = mock([{ info_hash: hash, file_idx: 0, season: 0, episode: 1, audio: 'English' }, { info_hash: hash, file_idx: 0, season: 0, episode: 1 }, { magnet: `magnet:?xt=urn:btih:${hash}`, file_idx: 1, season: 0, episode: 1 }, { magnet: 'magnet:bad', season: 0, episode: 1 }]);
  const result = await streamHandler({ type: 'series', id: 'tt1234567:0:1' }, m.client);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].fileIdx, 0);
  assert.match(result.streams[0].name, /ENG/);
  assert.ok(m.calls.some(c => c[0] === 'eq' && c[1] === 'season' && c[2] === 0));
  assert.ok(m.calls.some(c => c[0] === 'or' && c[1] === 'episode.eq.1,episode.is.null'), 'una sola consulta pide episodio y packs');
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
  assert.equal(result.streams[0].infoHash, '2'.repeat(40)); // 1080p con 5 seeders: fuente sana
  assert.equal(result.streams[1].infoHash, '1'.repeat(40)); // 720p con 50 seeders: mismo tramo de salud
  assert.equal(result.streams[2].infoHash, '3'.repeat(40)); // 4K con 2 seeders: por debajo de fuentes sanas
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
test('cache isolates returned objects, caches results and expires', async () => {
  let calls = 0;
  let clock = 0;
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    return { streams: [{ infoHash: hash }], cacheMaxAge: 60 };
  }, { now: () => clock });
  const args = { type: 'movie', id: 'tt1234567' };
  const [a, b] = await Promise.all([cached(args), cached(args)]);
  assert.equal(calls, 2, 'las promesas de requests concurrentes no se comparten en Workers');
  a.streams.length = 0;
  assert.equal(b.streams.length, 1);
  assert.equal((await cached(args)).streams.length, 1);
  clock = 60000;
  await cached(args);
  assert.equal(calls, 3, 'la respuesta cacheada expira a los 60 segundos');
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

test('cache never shares in-flight promises across concurrent cold requests', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cached = addon.helpers.createCachedStreamHandler(async () => {
    calls++;
    await gate;
    return { streams: [], cacheMaxAge: 60 };
  }, { maxEntries: 1 });
  const first = cached({ type: 'movie', id: 'tt1234567' });
  const other = cached({ type: 'movie', id: 'tt7654321' });
  const duplicate = cached({ type: 'movie', id: 'tt1234567' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3, 'cada request cold mantiene su propia promesa de I/O; nunca se espera una promesa de otra request');
  release();
  await Promise.all([first, other, duplicate]);
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

test('torrent column override is sanitized and used by Supabase SELECT', async t => {
  const { configure } = addon.helpers;
  t.after(() => configure(null));

  configure({ SUPABASE_TORRENT_COLUMNS: ' info_hash, title, seeders ' });
  assert.equal(torrentColumns(), 'info_hash,title,seeders');
  const selected = mock([{ info_hash: hash, title: 'Movie 1080p' }]);
  await streamHandler({ type: 'movie', id: 'tt1234567' }, selected.client);
  assert.ok(selected.calls.some(c => c[0] === 'select' && c[1] === 'info_hash,title,seeders'));

  configure({ SUPABASE_TORRENT_COLUMNS: 'info_hash);drop table torrents' });
  assert.equal(torrentColumns(), '*', 'una lista de columnas no válida vuelve a select(*)');
  const fallback = mock([{ info_hash: hash, title: 'Movie 1080p' }]);
  await streamHandler({ type: 'movie', id: 'tt1234567' }, fallback.client);
  assert.ok(fallback.calls.some(c => c[0] === 'select' && c[1] === '*'));
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

  let rejectedAttempts = 0;
  query.abortSignal = async () => {
    rejectedAttempts++;
    if (rejectedAttempts === 1) throw new TypeError('fetch failed');
    return { data: [{ info_hash: hash, seeders: 2 }], error: null };
  };
  const recovered = await streamHandler({ type: 'movie', id: 'tt9876543' }, () => query);
  assert.equal(rejectedAttempts, 2, 'también reintenta promesas rechazadas por fallos de red');
  assert.equal(recovered.streams.length, 1);
});

test('series query episode and season packs together, then scan only if needed', async () => {
  const m = sequenceMock([
    { data: [
      { info_hash: 'inválido', season: 2, episode: 5 },
      { info_hash: hash, season: 2, episode: null, title: 'Temporada completa 1080p Spanish', seeders: 4 }
    ], error: null }
  ]);
  const result = await streamHandler({ type: 'series', id: 'tt1234567:2:5' }, m.client);
  assert.equal(m.counters.queries, 1, 'una consulta recupera episodio exacto y pack');
  assert.ok(m.calls.some(c => c[0] === 'or' && c[1] === 'episode.eq.5,episode.is.null'));
  assert.equal(m.calls.filter(c => c[0] === 'is').length, 0, 'no se hace una consulta separada para los packs');
  assert.equal(result.streams.length, 1);
  assert.match(result.streams[0].name, /PACK T2/);
  assert.match(result.streams[0].title, /temporada 2 completa/);

  const movies = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock([]).client);
  assert.deepEqual(movies, { streams: [], cacheMaxAge: 60 });

  // Una fila exacta sin hash válido activa el cotejo de respaldo en memoria.
  const repair = sequenceMock([
    { data: [{ info_hash: 'inválido', season: 2, episode: 5 }], error: null },
    { data: [{ info_hash: hash, season: 2, episode: null, title: 'Pack 720p', seeders: 8 }], error: null }
  ]);
  const repaired = await streamHandler({ type: 'series', id: 'tt1234567:2:5' }, repair.client);
  assert.equal(repair.counters.queries, 2, 'la consulta de respaldo solo corre cuando no hay fuente válida');
  assert.match(repaired.streams[0].name, /PACK T2/);
});

// --- Procesado de datos (1.5.0) ---

// Mock que encadena resultados: sirve para los tres niveles de fallback, que
// consultan la base uno detrás de otro con la misma cadena de filtros.
function sequenceMock(results) {
  const calls = [];
  const query = {};
  for (const method of ['from', 'select', 'eq', 'or', 'is', 'order', 'limit']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  let index = 0;
  const counters = { queries: 0 };
  query.abortSignal = async () => { counters.queries++; return results[Math.min(index++, results.length - 1)]; };
  return { client: () => query, calls, counters };
}

const hexHash = n => n.toString(16).padStart(40, '0');

test('sizes accept every column, unit and notation, and tell "zero" from "missing"', () => {
  assert.equal(parseSizeBytes({ size: '1,5 GB' }), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseSizeBytes({ size: '700 MB' }), 700 * 1024 ** 2);
  assert.equal(parseSizeBytes({ size: '1.2 TB' }), Math.round(1.2 * 1024 ** 4));
  assert.equal(parseSizeBytes({ size: '2 GiB' }), 2 * 1024 ** 3);
  assert.equal(parseSizeBytes({ size_gb: '3' }), 3 * 1024 ** 3);
  assert.equal(parseSizeBytes({ size_bytes: 1024 }), 1024);
  assert.equal(parseSizeBytes({ size: 1024 }), 1024, 'un size numérico son bytes');
  assert.equal(parseSizeBytes({ size_bytes: 0 }), null, 'el cero no se anuncia como videoSize');
  assert.equal(parseSizeBytes({ size: 'lo que sea' }), null);
  assert.equal(parseSizeBytes({ size_bytes: -5 }), null, 'un tamaño negativo se descarta');
  assert.equal(formatSizeGB({ size: '1.2 TB' }), '1228.80');
  assert.equal(formatSizeGB({ size_bytes: 1073741824 }), '1.00');
  assert.equal(formatSizeGB({ size: '' }), '—');
  assert.equal(formatSizeGB({ size: 0 }), '0.00', 'un tamaño declarado en cero se muestra, no se oculta');
});

test('language falls back to the release name when the audio column says nothing', () => {
  assert.equal(getLanguageTag({ audio: 'Dolby Digital', title: 'La Película 1080p Castellano' }), 'CAST',
    'un audio genérico no debe tapar el idioma que sí declara el nombre');
  assert.equal(getLanguageTag({ audio: 'Dolby Digital', title: 'Película 1080p Latinoamérica' }), 'LAT');
  assert.equal(getLanguageTag({ title: 'Movie.2020.VOSTFR.1080p' }), 'VOST');
  assert.equal(getLanguageTag({ title: 'Movie 2020 SUB 1080p' }), 'SUB');
  assert.equal(getLanguageTag({ audio: 'Latino' }), 'LAT');
  assert.equal(getLanguageTag({ audio: 'LAT' }), 'LAT', 'las abreviaturas sueltas también se leen');
  assert.equal(getLanguageTag({ audio: 'English', title: 'Spanish story' }), 'ENG',
    'la columna de audio sigue mandando sobre el nombre');
  assert.equal(getLanguageTag({ audio: 'Dolby Digital', title: 'The Last Castle' }), 'N/D');
});

test('resolution covers the intermediate and top heights without false positives', () => {
  assert.equal(getResolutionTag({ quality: 'WEB-DL 1440p' }), '1440p');
  assert.equal(getResolutionTag({ title: 'Pelicula 8K' }), '8K');
  assert.equal(getResolutionTag({ quality: '1080i' }), '1080p', 'interlazado y progresivo comparten bucket');
  assert.equal(getResolutionTag({ title: '2160p HDR' }), '4K');
  assert.equal(getResolutionTag({ title: '14km away' }), 'N/D', '"14km" no es 4K');
  assert.equal(getResolutionTag({ quality: 'WEB-DL\nraro' }), 'WEB-DL raro',
    'lo que declara la base se sanea antes de eventualar en el nombre');
});

test('text from the database is flattened, stripped of control characters and capped', () => {
  assert.equal(sanitizeOneLine('a\u0000b\u200fc\td'), 'a b c d');
  assert.equal(sanitizeOneLine(null), '');
  assert.equal(sanitizeOneLine('x'.repeat(1000)).length, 300, 'el texto se acota para no inflar la respuesta');
});

test('trackers without a host are dropped instead of shipped to the client', () => {
  const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://&tr=udp://:80/announce&tr=${'a'.repeat(300)}&tr=udp://tracker.example.org:1337`;
  assert.deepEqual(extractTrackersFromMagnet(magnet), ['udp://tracker.example.org:1337']);
});

test('dead torrents sink below healthy ones whatever their quality', async () => {
  const m = mock([
    { info_hash: hexHash(1), title: 'Movie 4K', seeders: 0, audio: 'Spanish' },
    { info_hash: hexHash(2), title: 'Movie 1080p', seeders: 3, audio: 'Spanish' },
    { info_hash: hexHash(3), title: 'Movie 4K', seeders: 12, audio: 'Spanish' }
  ]);
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, m.client);
  assert.deepEqual(result.streams.map(s => s.infoHash), [hexHash(3), hexHash(2), hexHash(1)],
    'primero las vivas (por calidad), y la 4K muerta al final');
  assert.match(result.streams[2].title, /Sin seeders/, 'la ficha avisa de que no hay seeders');
});

test('at least five seeders form a healthier ranking tier than a high-resolution weak source', async () => {
  const rows = [
    { info_hash: hexHash(10), title: 'Movie 4K', seeders: 4 },
    { info_hash: hexHash(11), title: 'Movie 1080p', seeders: 5 },
    { info_hash: hexHash(12), title: 'Movie 8K', seeders: 1 },
    { info_hash: hexHash(13), title: 'Movie 8K', seeders: 0 }
  ];
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock(rows).client);
  assert.deepEqual(result.streams.map(stream => stream.infoHash), [
    hexHash(11), hexHash(12), hexHash(10), hexHash(13)
  ], 'la fuente con al menos cinco seeders va primero; dentro de cada tramo manda la calidad');
});

test('ranking breaks ties on leechers and finishes on a stable hash order', async () => {
  const rows = [
    { info_hash: hexHash(9), title: 'Movie 1080p Español', seeders: 4, leechers: 8, audio: 'Spanish' },
    { info_hash: hexHash(3), title: 'Movie 1080p Español', seeders: 4, leechers: 1, audio: 'Spanish' },
    { info_hash: hexHash(5), title: 'Movie 1080p Español', seeders: 4, audio: 'Spanish' }
  ];
  const first = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock(rows).client);
  assert.deepEqual(first.streams.map(s => s.infoHash), [hexHash(3), hexHash(9), hexHash(5)],
    'menos leechers primero y los desconocidos al final del tramo');
  const second = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock([...rows].reverse()).client);
  assert.deepEqual(second.streams.map(s => s.infoHash), first.streams.map(s => s.infoHash),
    'el mismo grupo de filas produce la misma lista en el mismo orden');
});

test('the response is capped even when the table offers many more sources', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    info_hash: hexHash(i + 1), title: `Movie ${i} 1080p Español`, seeders: 40 - i, audio: 'Spanish'
  }));
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock(rows).client);
  assert.equal(result.streams.length, 25, 'se devuelven como mucho 25 fuentes por título');
  assert.equal(result.streams[0].infoHash, hexHash(1), 'el recorte ocurre después de ordenar, no antes');
});

test('a season scan in memory recovers episodes stored as text', async () => {
  const m = sequenceMock([
    { data: [], error: null },
    { data: [
      { info_hash: hexHash(1), season: '2', episode: '05', title: 'Serie 1080p Español', seeders: 7 },
      { info_hash: hexHash(2), season: '2', episode: 6, title: 'Otro 1080p Español', seeders: 30 },
      { info_hash: hexHash(3), season: 1, episode: 5, title: 'Temporada previa 1080p Español', seeders: 40 }
    ], error: null }
  ]);
  const result = await streamHandler({ type: 'series', id: 'tt1234567:2:5' }, m.client);
  assert.equal(result.streams.length, 1, 'solo el episodio pedido de la temporada pedida');
  assert.equal(result.streams[0].infoHash, hexHash(1), 'el episode "05" se coteja como 5');
  assert.equal(m.calls.filter(c => c[0] === 'or').length, 1, 'la primera consulta incluye también los packs');
  assert.match(result.streams[0].behaviorHints.bingeGroup, /\|s2\|/, 'el bingeGroup distingue la temporada');
});

test('the in-memory scan also finds packs whose episode is empty instead of NULL', async () => {
  const m = sequenceMock([
    { data: [], error: null },
    { data: [{ info_hash: hexHash(4), season: 2, episode: '', title: 'Temporada completa 1080p Español', seeders: 12 }], error: null }
  ]);
  const result = await streamHandler({ type: 'series', id: 'tt1234567:2:9' }, m.client);
  assert.equal(result.streams.length, 1);
  assert.match(result.streams[0].name, /PACK T2/, 'un pack con episode vacío se etiqueta igual que uno con NULL');
  assert.match(result.streams[0].title, /temporada 2 completa/);
});

test('the in-memory scan never runs when the exact episode already answered', async () => {
  const m = sequenceMock([
    { data: [{ info_hash: hexHash(7), season: 1, episode: 4, title: 'Episodio 1080p Español', seeders: 5 }], error: null }
  ]);
  const result = await streamHandler({ type: 'anime', id: 'tt1234567:1:4' }, m.client);
  assert.equal(result.streams.length, 1);
  assert.equal(m.counters.queries, 1, 'ninguna consulta extra: el episodio exacto ya respondió');
  assert.equal(m.calls.filter(c => c[0] === 'is').length, 0, 'no se buscan packs ni se relee la temporada');
  assert.match(result.streams[0].behaviorHints.bingeGroup, /\|s1\|/);
});

test('movie binge groups do not invent a season', async () => {
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' },
    mock([{ info_hash: hexHash(8), title: 'Movie 1080p', seeders: 2 }]).client);
  assert.match(result.streams[0].behaviorHints.bingeGroup, /\|movie\|/);
});


test('language detection does not treat common Spanish/English words as language tags', () => {
  assert.equal(addon.helpers.detectLanguageTag('El episodio es en HD'), null);
  assert.equal(addon.helpers.detectLanguageTag('Movie in a city'), null);
  assert.equal(addon.helpers.detectLanguageTag('Audio es-ES'), 'ESP');
  assert.equal(addon.helpers.detectLanguageTag('Audio en-US'), 'ENG');
});

test('file_index is exposed as the Stremio fileIdx', () => {
  const entry = addon.helpers.buildStreamEntry({
    info_hash: hexHash(30),
    file_index: '7',
    title: 'Movie 1080p Español',
    seeders: 8
  }, hexHash(30), [], 'tt1234567');
  assert.equal(entry.stream.fileIdx, 7);
});

test('info_hash_clean is preferred when available', () => {
  const entry = addon.helpers.buildStreamEntry({
    info_hash: 'INVALID',
    info_hash_clean: hexHash(31),
    title: 'Movie 1080p Español',
    seeders: 8
  }, hexHash(31), [], 'tt1234567');
  assert.equal(entry.stream.infoHash, hexHash(31));
});

test('anime can recover a source by absolute_episode', async () => {
  const m = sequenceMock([
    { data: [], error: null },
    { data: [{ info_hash: hexHash(32), type: 'anime', absolute_episode: 25, title: 'Anime 1080p Japonés Sub', seeders: 8 }], error: null }
  ]);
  const result = await addon.helpers.streamHandler({ type: 'anime', id: 'tt1234567:1:25' }, m.client);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].infoHash, hexHash(32));
  assert.ok(m.calls.some(c => c[0] === 'eq' && c[1] === 'absolute_episode' && c[2] === 25));
});

test('stream queries include the requested content type', async () => {
  const m = sequenceMock([
    { data: [{ info_hash: hexHash(33), type: 'movie', title: 'Movie 1080p Español', seeders: 5 }], error: null }
  ]);
  await addon.helpers.streamHandler({ type: 'movie', id: 'tt1234567' }, m.client);
  assert.ok(m.calls.some(c => c[0] === 'eq' && c[1] === 'type' && c[2] === 'movie'));
});


test('structured language fields accept exact ISO codes without false positives', () => {
  assert.equal(addon.helpers.getLanguageTag({ language: 'es' }), 'ESP');
  assert.equal(addon.helpers.getLanguageTag({ language: 'en-US' }), 'ENG');
  assert.equal(addon.helpers.getLanguageTag({ lang: 'en', title: 'The Last Castle' }), 'ENG');
  assert.equal(addon.helpers.getLanguageTag({ language: 'en', title: 'Historia española' }), 'ENG');
});

test('poor release sources are penalized below clean WEB-DL sources', async () => {
  const rows = [
    { info_hash: hexHash(40), title: 'Movie 4K CAM', seeders: 8, language: 'es' },
    { info_hash: hexHash(41), title: 'Movie 1080p WEB-DL', seeders: 8, language: 'es' }
  ];
  const result = await streamHandler({ type: 'movie', id: 'tt1234567' }, mock(rows).client);
  assert.deepEqual(result.streams.map(stream => stream.infoHash), [hexHash(41), hexHash(40)]);
});

test('large result sets keep both Spanish and English represented', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    info_hash: hexHash(100 + i),
    title: i === 29 ? 'Movie 1080p English' : `Movie 1080p Español ${i}`,
    seeders: i === 29 ? 1 : 20 - (i % 10),
    language: i === 29 ? 'en' : 'es'
  }));
  const entries = rows.map(row => addon.helpers.buildStreamEntry(
    row, row.info_hash, [], 'tt1234567'
  ));
  const selected = addon.helpers.selectDiverseStreams(entries, 25);
  assert.ok(selected.some(entry => entry.langTag === 'ESP'));
  assert.ok(selected.some(entry => entry.langTag === 'ENG'));
  assert.equal(selected.length, 25);
});


test('anime prefers absolute_episode over a season pack', async () => {
  const m = sequenceMock([
    { data: [], error: null },
    { data: [{ info_hash: hexHash(51), type: 'anime', absolute_episode: 25, title: 'Anime E25 1080p WEB-DL', seeders: 8 }], error: null }
  ]);
  const result = await addon.helpers.streamHandler({ type: 'anime', id: 'tt1234567:1:25' }, m.client);
  assert.equal(result.streams[0].infoHash, hexHash(51));
});

test('exact episode query is preferred even when season packs have more seeders', async () => {
  const m = sequenceMock([
    { data: [{ info_hash: hexHash(70), type: 'series', season: 1, episode: 7, title: 'Episode 7 1080p', seeders: 2 }], error: null }
  ]);
  const result = await addon.helpers.streamHandler({ type: 'series', id: 'tt1234567:1:7' }, m.client);
  assert.equal(result.streams[0].infoHash, hexHash(70));
});

test('anime absolute episode can work without a matching season', async () => {
  const m = sequenceMock([
    { data: [], error: null },
    { data: [{ info_hash: hexHash(71), type: 'anime', season: null, absolute_episode: 25, title: 'Anime E25 1080p', seeders: 4 }], error: null }
  ]);
  const result = await addon.helpers.streamHandler({ type: 'anime', id: 'tt1234567:1:25' }, m.client);
  assert.equal(result.streams[0].infoHash, hexHash(71));
});

test('diversity selector never exceeds the requested limit', () => {
  const entries = ['es', 'en', 'dual'].map((language, i) =>
    addon.helpers.buildStreamEntry({
      info_hash: hexHash(60 + i),
      title: 'Movie 1080p',
      language,
      seeders: 10
    }, hexHash(60 + i), [], 'tt1234567')
  );
  const selected = addon.helpers.selectDiverseStreams(entries, 1);
  assert.equal(selected.length, 1);
});
