/**
 * Comprueba qué versión sirve un despliegue de Nexo Play.
 *
 *   npm run check:live
 *   node scripts/check-live.js --url https://nexo-player-app.noe359866.workers.dev
 *
 * Lee `/health` y `/manifest.json` del dominio indicado y los compara con la
 * versión de `package.json`. Termina con código 1 si el despliegue no responde
 * o si publica otra versión (por ejemplo, cuando el build de producción no
 * llegó a la web, o cuando se mira un Preview congelado de una rama).
 */
const DEFAULT_URL = 'https://nexo-player-app.noe359866.workers.dev';
// Los Preview de Workers Builds usan <alias de rama o hash>-<worker>.<subdominio>.workers.dev.
const PREVIEW_HOST = /^[a-z0-9][a-z0-9-]*-(nexo-player-app)\.([a-z0-9.-]+\.workers\.dev)$/i;

function targetUrl(argv = [], env = {}) {
  const flag = argv.indexOf('--url');
  const candidate = flag !== -1 ? argv[flag + 1] : (env.CHECK_LIVE_URL || DEFAULT_URL);
  if (!candidate) throw new Error('Falta la URL del despliegue: usa --url o CHECK_LIVE_URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Protocolo no soportado: ${url.protocol}`);
  return url;
}

/** Devuelve la URL publicada cuando el dominio es un Preview de una rama. */
function productionUrlFor(hostname) {
  const match = PREVIEW_HOST.exec(hostname || '');
  return match ? `https://${match[1]}.${match[2]}` : null;
}

async function jsonOrNull(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function checkLive(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const expected = options.expected || require('../package.json').version;
  const base = new URL(String(url instanceof URL ? url.href : url));
  const origin = base.origin;
  const health = await jsonOrNull(fetchImpl, `${origin}/health`);
  const manifest = await jsonOrNull(fetchImpl, `${origin}/manifest.json`);
  const healthVersion = health && health.version ? String(health.version) : null;
  const manifestVersion = manifest && manifest.version ? String(manifest.version) : null;
  const versions = [healthVersion, manifestVersion].filter(Boolean);
  return {
    url: origin,
    expected,
    health: healthVersion,
    manifest: manifestVersion,
    supabase: health && health.supabase ? health.supabase.configured === true : null,
    responded: versions.length > 0,
    matches: versions.length > 0 && versions.every(version => version === expected),
    preview: productionUrlFor(base.hostname)
  };
}

async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  let url;
  try {
    url = targetUrl(argv, env);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return 1;
  }
  const result = await checkLive(url);
  const supabase = result.supabase === null ? '' : result.supabase ? ' (Supabase configurado)' : ' (sin Supabase configurado)';
  log('Nexo Play · comprobación del despliegue');
  log(`  URL           ${result.url}`);
  log(`  /health       ${result.health || 'sin respuesta'}${result.health ? supabase : ''}`);
  log(`  /manifest     ${result.manifest || 'sin respuesta'}`);
  log(`  package.json  ${result.expected}`);
  if (result.preview) {
    log(`  Nota          ${result.url} parece un Preview de una rama: es una copia congelada y nunca recibe los cambios de main.`);
    log(`  Producción    ${result.preview}`);
  }
  if (!result.responded) {
    log('ERROR: el despliegue no respondió en /health ni en /manifest.json.');
    return 1;
  }
  if (!result.matches) {
    log(`AVISO: el despliegue no publica la versión del paquete (${result.expected}). Revisa el build de producción en Cloudflare.`);
    return 1;
  }
  log('OK: el despliegue publica la versión del paquete.');
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(`ERROR: ${err && err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_URL, PREVIEW_HOST, targetUrl, productionUrlFor, checkLive, main };
