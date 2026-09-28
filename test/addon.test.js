const { test } = require('node:test');
const assert = require('node:assert/strict');
const addon = require('../addon');
const { parseStremioId, getLanguageTag, formatSizeGB, extractInfoHashFromMagnet, extractTrackersFromMagnet, streamHandler } = addon.helpers;
const hash = 'a'.repeat(40);
test('consistent release and private public description', () => {
  assert.equal(addon.manifest.version, require('../package.json').version);
  assert.equal(addon.manifest.name, 'Nexo Play');
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
