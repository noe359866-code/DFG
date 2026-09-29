// Medición local reproducible con datos simulados, no de Supabase ni de P2P.
const { performance } = require('node:perf_hooks');
const { gzipSync } = require('node:zlib');
const { helpers } = require('../addon');
async function main() {
  const data = Array.from({ length: 25 }, (_, i) => ({
    info_hash: i.toString(16).padStart(40, 'a'), title: `Título de prueba ${i} 1080p`,
    audio: 'Spanish English', size_gb: 2, seeders: 50 - i
  }));
  const query = {};
  for (const method of ['from', 'select', 'eq', 'order', 'limit']) query[method] = () => query;
  query.abortSignal = async () => ({ data });
  const response = await helpers.streamHandler({ type: 'movie', id: 'tt1234567' }, () => query);
  let queries = 0;
  const cached = helpers.createCachedStreamHandler(async () => {
    queries++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return response;
  });
  const args = { type: 'movie', id: 'tt1234567' };
  let start = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => cached(args)));
  const cold = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < 100; i++) await cached(args);
  const warm = (performance.now() - start) / 100;
  const raw = Buffer.from(JSON.stringify(response));
  const compressed = gzipSync(raw, { level: 4 });
  console.log(JSON.stringify({ environment: 'Simulado: consulta con espera artificial de 40 ms',
    concurrentRequests: 50, databaseCalls: queries, coldBatchMs: +cold.toFixed(2),
    warmAverageMs: +warm.toFixed(3), jsonBytes: raw.length, gzipBytes: compressed.length,
    reductionPercent: +(100 * (1 - compressed.length / raw.length)).toFixed(1) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
