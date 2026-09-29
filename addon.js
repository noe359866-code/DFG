/**
 * Nexo Play - Stremio Addon
 * Lógica principal del addon: Manifest + Stream Handler
 *
 * Diseñado para Cloudflare Workers + Supabase (PostgreSQL)
 * NO hace scraping ni DDL. Solo consulta la tabla public.torrents
 */

// Solo el builder: el índice del SDK arrastra serveHTTP/Express, que no corre
// en Workers. El enrutado vive en worker.js y la interfaz se construye abajo.
const addonBuilder = require('stremio-addon-sdk/src/builder');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// 1. MANIFEST - Especificación oficial Stremio
// ---------------------------------------------------------------------------
const manifest = {
  id: 'org.comunidad.torrents.espanol',
  version: require('./package.json').version,
  name: 'Nexo Play',
  description: 'Películas, series y anime en español e inglés. Encuentra opciones de reproducción con información de idioma y calidad, en un solo lugar. Grupo de soporte: https://discord.com/invite/qEcdvvcA4',
  resources: ['stream'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  },
  // Verificación pública emitida por stremio-addons.net. Se sirve en el
  // manifiesto para todo el mundo; no es un secreto ni depende de .env.
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..g42ZuVG1dWzDRcFDdl2fSg.XTSmojbOIelhstXtRYc4quyFOTqqzzpM5A37XgsUCQFnXn0-CvOqL4-_cB0Ici9r4PKbof275NCBIoyHkfXYEcjZGKHnoEekJ06szsimbfujDbMlELhpntPJ-KR5uH0n.nl6gG0luYfRKGH23oOt-YQ'
  }
};

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// 2. SUPABASE CLIENT - Singleton con cache
// ---------------------------------------------------------------------------
let supabaseClient = null;
// Variables del Worker (secrets/bindings de Cloudflare). En Node local se
// complementan con process.env, que sigue siendo el respaldo.
let envOverrides = null;

function configure(overrides) {
  const next = overrides && typeof overrides === 'object' ? {
    SUPABASE_URL: overrides.SUPABASE_URL,
    SUPABASE_ANON_KEY: overrides.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: overrides.SUPABASE_SERVICE_ROLE_KEY
  } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(envOverrides);
  envOverrides = next;
  if (changed) supabaseClient = null;
}

function envValue(name) {
  const value = envOverrides && envOverrides[name];
  if (value) return value;
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const supabaseUrl = envValue('SUPABASE_URL');
  const supabaseKey = envValue('SUPABASE_SERVICE_ROLE_KEY') || envValue('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Addon] ⚠️ Faltan variables SUPABASE_URL / SUPABASE_ANON_KEY');
    return null;
  }

  try {
    // No se usa realtime; WebSocket global (Node 22 y Cloudflare Workers)
    // cubre su inicialización sin dependencias adicionales.
    supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return supabaseClient;
  } catch (err) {
    console.error('[Supabase] Error inicializando cliente:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. HELPERS
// ---------------------------------------------------------------------------

/**
 * Parsea IDs de Stremio
 * movie:  "tt0111161"
 * series: "tt0944947:1:5" -> { imdbId: 'tt0944947', season: 1, episode: 5 }
 * anime:  "tt0388629:2:10" (mismo formato)
 */
function parseStremioId(id) {
  const empty = { imdbId: null, season: null, episode: null };
  if (typeof id !== 'string') return empty;
  const match = /^(tt\d{7,10})(?::(\d{1,4}):(\d{1,5}))?$/.exec(id);
  if (!match) return empty;
  return { imdbId: match[1], season: match[2] === undefined ? null : Number(match[2]),
    episode: match[3] === undefined ? null : Number(match[3]) };
}

function isValidInfoHash(hash) {
  return typeof hash === 'string' && /^[a-fA-F0-9]{40}$/.test(hash.trim());
}

function parseMagnetUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === 'magnet:' ? url : null;
  } catch (_) { return null; }
}

function extractInfoHashFromMagnet(magnetUrl) {
  try {
    const url = parseMagnetUrl(magnetUrl);
    if (!url) return null;
    for (const xt of url.searchParams.getAll('xt')) {
      const hash = xt.replace(/^urn:btih:/i, '');
      if (hash === xt) continue;
      if (isValidInfoHash(hash)) return hash.toLowerCase();
      if (/^[a-z2-7]{32}$/i.test(hash)) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const char of hash.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
        return bits.match(/.{8}/g).map(byte => parseInt(byte, 2).toString(16).padStart(2, '0')).join('');
      }
    }
  } catch (_) { /* malformed magnet */ }
  return null;
}

function extractTrackersFromMagnet(magnetUrl) {

  try {
    const url = parseMagnetUrl(magnetUrl);
    if (!url) return [];
    return url.searchParams.getAll('tr')
      .map(tr => tr.trim())
      .filter(tr => /^(udp|https?):\/\//i.test(tr))
      .slice(0, 10);
  } catch (_) { /* magnet malformado */ return []; }
}

function extractTitleFromMagnet(magnetUrl) {

  try {
    const url = parseMagnetUrl(magnetUrl);
    if (!url) return null;
    const dn = url.searchParams.get('dn');
    return dn && dn.trim() ? dn.trim() : null;
  } catch (_) { /* magnet malformado */ return null; }
}

function sanitizeOneLine(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t\f\v]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSizeBytes(row) {
  for (const [val, mult] of [[row.size_bytes, 1], [row.size_gb, 1024 ** 3]]) {
    if (val !== null && val !== undefined && val !== '' && Number.isFinite(Number(val)) && Number(val) > 0) {
      return Math.round(Number(val) * mult);
    }
  }
  if (row.size !== null && row.size !== undefined && row.size !== '') {
    if (Number.isFinite(Number(row.size)) && Number(row.size) > 0) return Math.round(Number(row.size));
    const match = typeof row.size === 'string' && /^(\d+(?:[.,]\d+)?)\s*(gib|gb|mib|mb|kib|kb)$/i.exec(row.size.trim());
    if (match) {
      const num = Number(match[1].replace(',', '.'));
      const unit = match[2].toLowerCase();
      const mult = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : 1024;
      return Math.round(num * mult);
    }
  }
  return null;
}

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

function buildTrackers(dbTrackersRaw, magnetTrackers = []) {
  const dbTrackers = Array.isArray(dbTrackersRaw) ? dbTrackersRaw
    : (typeof dbTrackersRaw === 'string' && dbTrackersRaw.trim() ? [dbTrackersRaw] : []);
  const custom = [...magnetTrackers, ...dbTrackers]
    .map(tr => typeof tr === 'string' ? tr.trim() : '')
    .filter(tr => /^(udp|https?):\/\//i.test(tr));
  const candidateList = custom.length ? custom : DEFAULT_TRACKERS;
  return [...new Set(candidateList)]
    .slice(0, 10)
    .map(tr => tr.startsWith('tracker:') ? tr : `tracker:${tr}`);
}

function formatSizeGB(row) {
  for (const [value, divisor] of [[row.size_bytes, 1024 ** 3], [row.size_gb, 1], [row.size, 1024 ** 3]]) {
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return (Number(value) / divisor).toFixed(2);
  }
  const match = typeof row.size === 'string' && /^(\d+(?:[.,]\d+)?)\s*(gib|gb|mib|mb|kib|kb)$/i.exec(row.size.trim());
  if (!match) return '—';
  return (Number(match[1].replace(',', '.')) / (/^g/i.test(match[2]) ? 1 : /^m/i.test(match[2]) ? 1024 : 1024 ** 2)).toFixed(2);
}

function getLanguageTag(row) {
  const metadata = [row.audio, row.language, row.lang].filter(Boolean).join(' ');
  const text = (metadata || row.release_name || row.title || row.name || '').toLowerCase();
  const has = pattern => pattern.test(text);
  const spanish = has(/\b(es|esp|español|spanish|castellano|cast|latino|lat)\b/);
  const english = has(/\b(en|eng|english|inglés|ingles)\b/);
  if (has(/\b(dual|multi)\b/) || (spanish && english)) return 'DUAL';
  if (has(/\b(vose|vos|subtitulado)\b/)) return 'VOSE';
  if (has(/\b(castellano|cast)\b/)) return 'CAST';
  if (has(/\b(latino|lat)\b/)) return 'LAT';
  if (spanish) return 'ESP';
  if (english) return 'ENG';
  return 'N/D';
}

function getResolutionTag(row) {
  const str = [row.resolution, row.quality, row.release_name, row.title, row.name].filter(Boolean).join(' ').toLowerCase();
  if (str.includes('2160') || /\b4k\b/.test(str) || /\buhd\b/.test(str)) return '4K';
  if (str.includes('1080')) return '1080p';
  if (str.includes('720')) return '720p';
  if (str.includes('480')) return '480p';
  return row.quality || row.resolution || 'N/D';
}

// ---------------------------------------------------------------------------
// 4. STREAM HANDLER - Lógica principal
// ---------------------------------------------------------------------------
async function streamHandler({ type, id } = {}, clientFactory = getSupabaseClient) {
  const start = Date.now();
  console.log(`[Stream] → type=${type} id=${id}`);

  try {
    // Validación inicial
    if (!id || !manifest.types.includes(type)) {
      console.warn('[Stream] Parámetros faltantes');
      return { streams: [] };
    }

    const { imdbId, season, episode } = parseStremioId(id);

    if (!imdbId || (type === 'movie' ? season !== null : season === null || episode === null || episode < 1)) {
      console.warn(`[Stream] imdbId inválido: ${imdbId}`);
      return { streams: [] };
    }

    const supabase = clientFactory();
    if (!supabase) {
      console.error('[Stream] Supabase no configurado - revisa SUPABASE_URL / KEY');
      return { streams: [] };
    }
    // Construcción de query
    let query = supabase
      .from('torrents')
      .select('*')
      .eq('imdb_id', imdbId)
      .order('seeders', { ascending: false, nullsFirst: false })
      .limit(25);

    // Para series/anime: filtrar por temporada y episodio si vienen en el ID
    const isSeries = type === 'series' || type === 'anime';
    if (isSeries && season !== null && episode !== null) {
      // Soporta columnas como integer o text - probamos con int
      query = query.eq('season', season).eq('episode', episode);
      console.log(`[Stream] Filtrando S:${season} E:${episode} para ${imdbId}`);
    } else if (isSeries && (season !== null || episode !== null)) {
      // Caso borde: solo uno de los dos (raro) - filtrar lo que tengamos
      if (season !== null) query = query.eq('season', season);
      if (episode !== null) query = query.eq('episode', episode);
    }
    // Para movie no filtramos season/episode aunque existan nulos en DB

    const { data, error } = await query.abortSignal(AbortSignal.timeout(8000));

    if (error) {
      console.error('[Supabase] Error query:', error.message, error.details || '');
      return { streams: [] };
    }

    if (!data || data.length === 0) {
      console.log(`[Stream] Sin resultados para ${imdbId}${isSeries ? ` S:${season} E:${episode}` : ''}`);
      // Respuesta vacía válida (no es un fallo): se cachea brevemente para no
      // repetir la consulta por cada cliente que pregunte por el mismo título.
      return { streams: [], cacheMaxAge: 60 };
    }

    console.log(`[Stream] ${data.length} resultados para ${imdbId} en ${Date.now() - start}ms`);

    // Mapeo a formato Stremio y ordenación optimizada por calidad, idioma y semillas
    const streamEntries = data
      .map((row) => {
        // --- InfoHash con fallback a magnetUrl ---
        let infoHash = row.info_hash || row.infoHash || row.hash || null;
        if (infoHash) infoHash = infoHash.toString().trim().toLowerCase();

        const magnet = parseMagnetUrl(row.magnet_url || row.magnetUrl || row.magnet);
        if (!isValidInfoHash(infoHash)) {
          // Intentar extraer de magnet
          const extracted = extractInfoHashFromMagnet(magnet);
          if (extracted) infoHash = extracted;
        }

        if (!isValidInfoHash(infoHash)) {
          return null;
        }

        const magnetTrackers = extractTrackersFromMagnet(magnet);
        const magnetTitle = extractTitleFromMagnet(magnet);
        return buildStreamEntry(row, infoHash, magnetTrackers, imdbId, magnetTitle);
      })
      .filter(Boolean);

    // Ordenar de forma determinista para ofrecer la mejor experiencia:
    // Mayor resolución -> Mejor compatibilidad de idioma -> Más seeders -> Mayor tamaño
    streamEntries.sort(compareStreamEntries);

    const seen = new Set();
    const streams = streamEntries.map(entry => entry.stream).filter(stream => {
      const key = `${stream.infoHash}:${stream.fileIdx ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[Stream] → Enviando ${streams.length} streams válidos`);
    return { streams, cacheMaxAge: 120, staleRevalidate: 600 };

  } catch (err) {
    console.error('[Stream] Excepción no controlada:', err.message, err.stack?.slice(0, 500));
    return { streams: [] };
  }
}
// Cumplimiento tras responder: en Cloudflare Workers la ruta pasa ctx.waitUntil
// por llamada; fuera de Workers solo se evita el rechazo no manejado.
function discardInBackground(task) {
  Promise.resolve(task).catch(() => {});
}
// Cache por instancia con revalidación única y antigüedad máxima absoluta.
function createCachedStreamHandler(handler, {
  maxEntries = 250, now = Date.now, keepAlive = discardInBackground, retryDelay = 15000
} = {}) {
  const cache = new Map();
  const pending = new Map();
  function refresh(key, args, previous) {
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve().then(() => handler(args)).then(value => {
      if (value.cacheMaxAge > 0) {
        const expires = now() + value.cacheMaxAge * 1000;
        // Los vacíos nunca se sirven obsoletos.
        const staleSeconds = value.streams?.length ? Math.min(value.staleRevalidate || 0, 600) : 0;
        cache.delete(key);
        cache.set(key, { value: structuredClone(value), expires,
          staleUntil: expires + staleSeconds * 1000, retryAt: 0 });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      } else if (previous) previous.retryAt = now() + retryDelay;
      return value;
    }).catch(error => {
      if (previous) previous.retryAt = now() + retryDelay;
      throw error;
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    if (pending.size < maxEntries) pending.set(key, request);
    return request;
  }
  return async function cached(args, requestKeepAlive = keepAlive) {
    const { imdbId, season, episode } = parseStremioId(args?.id);
    if (!imdbId || !manifest.types.includes(args?.type) ||
        (args.type === 'movie' ? season !== null : season === null || episode < 1)) return { streams: [] };
    const key = `${args.type}:${imdbId}:${season}:${episode}`;
    const hit = cache.get(key);
    const time = now();
    if (hit && hit.staleUntil > time) {
      cache.delete(key);
      cache.set(key, hit);
      const value = structuredClone(hit.value);
      // No reiniciar el TTL HTTP cada vez que se lee la caché local.
      value.cacheMaxAge = Math.max(0, Math.floor((hit.expires - time) / 1000));
      value.staleRevalidate = Math.max(0, Math.floor((hit.staleUntil - Math.max(time, hit.expires)) / 1000));
      if (hit.expires <= time && hit.retryAt <= time && !pending.has(key) && pending.size < maxEntries) {
        const background = refresh(key, args, hit).catch(() => {});
        // El Worker mantiene vivo el isolate después de enviar la respuesta
        // con ctx.waitUntil; en local el trabajo sigue su curso normal.
        requestKeepAlive(background);
      }
      return value;
    }
    cache.delete(key);
    return structuredClone(await refresh(key, args));
  };
}
// Singleton compartido: la interfaz del SDK y el Worker usan la misma caché.
const cachedStreamHandler = createCachedStreamHandler(streamHandler);
builder.defineStreamHandler(cachedStreamHandler);

// ---------------------------------------------------------------------------
// Formateadores y comparadores de Stream
// ---------------------------------------------------------------------------
const RESOLUTION_WEIGHT = {
  '4K': 4000,
  '1080p': 3000,
  '720p': 2000,
  '480p': 1000,
  'N/D': 0
};

const LANGUAGE_WEIGHT = {
  'DUAL': 500,
  'CAST': 400,
  'LAT': 350,
  'ESP': 300,
  'VOSE': 200,
  'ENG': 100,
  'N/D': 0
};

function compareStreamEntries(a, b) {
  const resDiff = (RESOLUTION_WEIGHT[b.resolution] ?? 0) - (RESOLUTION_WEIGHT[a.resolution] ?? 0);
  if (resDiff !== 0) return resDiff;

  const langDiff = (LANGUAGE_WEIGHT[b.langTag] ?? 0) - (LANGUAGE_WEIGHT[a.langTag] ?? 0);
  if (langDiff !== 0) return langDiff;

  const seederDiff = (b.seeders ?? 0) - (a.seeders ?? 0);
  if (seederDiff !== 0) return seederDiff;

  return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

function buildStreamEntry(row, infoHash, magnetTrackers = [], imdbId = '', magnetTitle = null) {
  const metadata = { ...row, name: row.name || magnetTitle };
  const langTag = getLanguageTag(metadata);
  const resolution = getResolutionTag(metadata);
  const sizeGB = formatSizeGB(row);
  const sizeBytes = parseSizeBytes(row);
  const seeders = row.seeders ?? row.seed ?? 0;
  const audio = sanitizeOneLine(row.audio || row.language || row.lang) || 'No indicado';
  const subs = sanitizeOneLine(row.subtitles || row.subs) || 'No indicados';
  const rawTitle = row.title || row.release_name || row.name || magnetTitle || 'Sin título';
  const titleDisplay = sanitizeOneLine(rawTitle) || 'Sin título';
  const codec = sanitizeOneLine(row.codec || row.video_codec) || '—';
  const group = sanitizeOneLine(row.release_group || row.group || row.team) || '—';
  const quality = sanitizeOneLine(row.quality) || resolution;

  // name: cabecera corta visible en lista (máx ~30 chars)
  const name = `Nexo Play\n[${langTag}] ${resolution}`;

  // title: multilínea con detalles (Stremio lo muestra al hacer hover)
  const titleLines = [
    `🎬 ${titleDisplay}`,
    `🔊 Audio: ${audio} | 📝 Subs: ${subs}`,
    `💾 Tamaño: ${sizeGB} GB`,
    `👥 Seeders: ${seeders}  |  🌱 Leechers: ${row.leechers ?? '—'}`,
    `⚙️ Codec: ${codec}  |  📦 Grupo: ${group}`,
    `⭐ Calidad: ${quality}`
  ];

  // Trackers del torrent: los del magnet original más los de la columna
  // trackers, con fallback a trackers públicos de alta disponibilidad.
  const trackers = buildTrackers(row.trackers, magnetTrackers);

  const fileIdx = Number.isSafeInteger(row.file_idx ?? row.fileIdx) && (row.file_idx ?? row.fileIdx) >= 0
    ? (row.file_idx ?? row.fileIdx)
    : undefined;

  const stream = {
    name,
    title: titleLines.join('\n'),
    infoHash: infoHash.toLowerCase(),
    ...(fileIdx !== undefined ? { fileIdx } : {}),
    behaviorHints: {
      // Identifica título + calidad + idioma: la reproducción continua solo
      // agrupa episodios de la misma serie, nunca títulos distintos.
      bingeGroup: `nexo-play|${imdbId}|${resolution.toLowerCase()}-${langTag.toLowerCase()}`,
      ...(sizeBytes ? { videoSize: sizeBytes } : {}),
      ...(rawTitle ? { filename: titleDisplay } : {})
    },
    ...(trackers.length ? { sources: trackers } : {})
  };

  return {
    stream,
    resolution,
    langTag,
    seeders: Number.isFinite(Number(seeders)) ? Number(seeders) : 0,
    sizeBytes: sizeBytes || 0
  };
}

function buildStream(row, infoHash, magnetTrackers = [], imdbId = '') {
  return buildStreamEntry(row, infoHash, magnetTrackers, imdbId).stream;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const addonInterface = builder.getInterface();
module.exports = addonInterface;

module.exports.helpers = { parseStremioId, getLanguageTag, formatSizeGB, extractInfoHashFromMagnet, extractTrackersFromMagnet, streamHandler, createCachedStreamHandler, cachedStreamHandler, getSupabaseClient, configure };
