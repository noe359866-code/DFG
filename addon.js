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

// Al copiar desde el panel de Supabase es habitual arrastrar espacios, saltos
// de línea o comillas; eso rompe el JWT de forma silenciosa. También se
// descartan los placeholders de .env.example / .dev.vars.example para no
// intentar conexiones con credenciales de muestra.
function isPlaceholderValue(value) {
  const text = value.toLowerCase();
  return text.startsWith('tu_') || text.includes('xxxxxxxx') || text === 'changeme';
}

function cleanEnvValue(name) {
  const raw = envValue(name);
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!value || isPlaceholderValue(value)) return undefined;
  return value;
}

// Acepta la URL con o sin esquema y con barra final, como se copia desde el
// panel; devuelve null si no parece un host válido.
function normalizeSupabaseUrl(raw) {
  if (!raw) return null;
  let url = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(url) ? url : null;
}

// Estado de la configuración sin filtrar valores: pensado para /health y
// registros, nunca expone la clave ni la URL completas.
function configStatus() {
  const rawUrl = cleanEnvValue('SUPABASE_URL');
  const url = normalizeSupabaseUrl(rawUrl);
  const keyType = cleanEnvValue('SUPABASE_SERVICE_ROLE_KEY') ? 'service_role'
    : cleanEnvValue('SUPABASE_ANON_KEY') ? 'anon' : 'none';
  return {
    configured: Boolean(url && keyType !== 'none'),
    url: rawUrl ? (url ? 'ok' : 'invalid') : 'missing',
    keyType
  };
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const supabaseUrl = normalizeSupabaseUrl(cleanEnvValue('SUPABASE_URL'));
  const supabaseKey = cleanEnvValue('SUPABASE_SERVICE_ROLE_KEY') || cleanEnvValue('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseKey) {
    const status = configStatus();
    console.warn(`[Addon] ⚠️ Supabase sin configurar (url: ${status.url}, clave: ${status.keyType}). Revisa SUPABASE_URL / SUPABASE_ANON_KEY.`);
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
      .filter(isUsableTracker)
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

// Los títulos vienen de una tabla ajena: se aplastan a una línea, se limpian
// los caracteres de control y bidi que rompen la interfaz, y se acotan para
// que una fila corrupta no convierta la respuesta en un payload enorme.
const MAX_TEXT_LENGTH = 300;

function sanitizeOneLine(str, maxLength = MAX_TEXT_LENGTH) {
  if (typeof str !== 'string') return '';
  return str
    // \r\n\t\f\v y el resto de controles, más los invisibles y bidi.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Tamaños: una sola fuente de verdad para el texto visible y para videoSize.
// Acepta las tres columnas que conviven en la tabla (size_bytes, size_gb y el
// size libre con unidades) y las tres notaciones habituales: entero en bytes,
// decimal con coma y sufijo en inglés. Sin cambios en el formato publicado.
// ---------------------------------------------------------------------------
const SIZE_UNITS = {
  b: 1, kb: 1024, kib: 1024,
  mb: 1024 ** 2, mib: 1024 ** 2,
  gb: 1024 ** 3, gib: 1024 ** 3,
  tb: 1024 ** 4, tib: 1024 ** 4
};
const SIZE_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)$/i;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isFinite(number) ? number : null;
}

// Distingue "no hay tamaño" de "hay tamaño y es cero": el texto muestra 0.00
// GB cuando la fila lo declara, y — cuando la columna está vacía o es basura.
function resolveSize(row) {
  for (const [value, factor] of [[row.size_bytes, 1], [row.size_gb, 1024 ** 3]]) {
    const number = toFiniteNumber(value);
    if (number !== null && number >= 0) return { bytes: number * factor, present: true };
  }
  if (row.size !== null && row.size !== undefined && row.size !== '') {
    const bare = toFiniteNumber(row.size);
    if (bare !== null && bare >= 0) return { bytes: bare, present: true };
    const match = typeof row.size === 'string' ? SIZE_PATTERN.exec(row.size.trim()) : null;
    if (match) {
      return { bytes: Number(match[1].replace(',', '.')) * SIZE_UNITS[match[2].toLowerCase()], present: true };
    }
  }
  return { bytes: null, present: false };
}

// Bytes para behaviorHints.videoSize: solo cuando hay un tamaño real que
// anunciarle a Stremio (el cero y los valores ausentes se omiten).
function parseSizeBytes(row) {
  const { bytes } = resolveSize(row);
  return bytes !== null && bytes > 0 ? Math.round(bytes) : null;
}

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

// Un tracker solo sirve si es una URL udp/http(s) con host: "udp://", "udp://:80"
// o una cadena sin:// no arrancan clientes y solo ocupan sitio en el stream.
function isUsableTracker(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 200) return false;
  try {
    const url = new URL(text);
    if (!/^(udp|https?)$/i.test(url.protocol.replace(/:$/, '')) || !url.hostname) return false;
    return /^[a-z0-9.-]+$/i.test(url.hostname);
  } catch (_) { return false; }
}

function buildTrackers(dbTrackersRaw, magnetTrackers = []) {
  const dbTrackers = Array.isArray(dbTrackersRaw) ? dbTrackersRaw
    : (typeof dbTrackersRaw === 'string' && dbTrackersRaw.trim() ? [dbTrackersRaw] : []);
  const custom = [...magnetTrackers, ...dbTrackers]
    .map(tr => typeof tr === 'string' ? tr.trim() : '')
    .filter(isUsableTracker);
  const candidateList = custom.length ? custom : DEFAULT_TRACKERS;
  return [...new Set(candidateList)]
    .slice(0, 10)
    .map(tr => tr.startsWith('tracker:') ? tr : `tracker:${tr}`);
}

function formatSizeGB(row) {
  const { bytes, present } = resolveSize(row);
  return present ? (bytes / 1024 ** 3).toFixed(2) : '—';
}

// ---------------------------------------------------------------------------
// Idioma y resolución
// ---------------------------------------------------------------------------

// Se consulta primero la columna que declara el audio y, si no dice nada, el
// nombre del release: muchas filas traen audio genérico ("Dolby Digital") pero
// su título sí declara el idioma. Antes solo se miraba la primera fuente y esas
// filas quedaban como N/D.
// ---------------------------------------------------------------------------
const LANGUAGE_SOURCES = row => [
  [row.audio, row.language, row.lang].filter(Boolean).join(' '),
  row.release_name, row.title, row.name
];

function detectLanguageTag(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lower = text.toLowerCase();
  const has = pattern => pattern.test(lower);
  const spanish = has(/\b(es|esp|español|spanish|castellano|cast|latino|lat|latam|latinoamérica)\b/);
  const english = has(/\b(en|eng|english|inglés|ingles)\b/);
  if (has(/\b(dual|multi|dual-sub)\b/) || (spanish && english)) return 'DUAL';
  if (has(/\b(vose|vos|subtitulado)\b/)) return 'VOSE';
  // Audio foreign con subtítulos o subtítulos sampled: no es un idioma concreto.
  if (has(/\b(vost|vostfr|vosto|vosteng)\b/)) return 'VOST';
  if (has(/\b(sub|subt|subsample)\b/)) return 'SUB';
  if (has(/\b(castellano|cast)\b/)) return 'CAST';
  if (has(/\b(latino|lat|latam|latinoamérica)\b/)) return 'LAT';
  if (spanish) return 'ESP';
  if (english) return 'ENG';
  return null;
}

function getLanguageTag(row) {
  for (const source of LANGUAGE_SOURCES(row)) {
    const tag = detectLanguageTag(source);
    if (tag) return tag;
  }
  return 'N/D';
}

// Reconoce alturas y etiquetas de marketing; los límites de palabra evitan que
// un título como "14km" se lea como 4K. El orden es de mayor a menor porque el
// primero que casa es el que manda ("2160p HDR" es 4K, no 1080p).
const RESOLUTION_TOKENS = [
  [/\b(4320p?|8k)\b/, '8K'],
  [/\b(2160p?|4k|uhd)\b/, '4K'],
  [/\b1440p?\b/, '1440p'],
  [/\b1080[pi]?\b/, '1080p'],
  [/\b720[pi]?\b/, '720p'],
  [/\b576[pi]?\b/, '576p'],
  [/\b480[pi]?\b/, '480p'],
  [/\b360[pi]?\b/, '360p']
];

function getResolutionTag(row) {
  const str = [row.resolution, row.quality, row.release_name, row.title, row.name]
    .filter(Boolean).join(' ').toLowerCase();
  for (const [pattern, tag] of RESOLUTION_TOKENS) {
    if (pattern.test(str)) return tag;
  }
  // Sin altura reconocible se conserva lo que declara la base, ya saneado: el
  // texto se muestra en varias líneas de la ficha y en el nombre corto.
  const declared = sanitizeOneLine(row.quality || row.resolution, 24);
  return declared || 'N/D';
}

// ---------------------------------------------------------------------------
// 4. STREAM HANDLER - Lógica principal
// ---------------------------------------------------------------------------

// Errores que suelen resolverse solos al instante (red cortada, cold starts,
// 5xx puntuales): vale la pena un segundo intento antes de rendirse.
const TRANSIENT_ERROR = /network|fetch|timed?\s*out|timeout|econn|socket|abort|gateway|temporar|502|503|504/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Cuántas filas se piden, cuántas se releen para el cotejo en memoria y cuántas
// se devuelven. El ranking ordena por calidad e idioma, no por seeders, así que
// el grupo de candidatos tiene que ser mayor que la respuesta final.
const CANDIDATE_LIMIT = 50;
const SCAN_LIMIT = 50;
const MAX_STREAMS = 25;

// Hasta 2 intentos por consulta; los errores permanentes (401, sintaxis, RLS)
// no se reintentan para no duplicar la espera del usuario.
async function runQuery(query, label) {
  let lastResult = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const result = await query.abortSignal(AbortSignal.timeout(8000));
      lastResult = result || { data: null, error: new Error('Supabase devolvió una respuesta vacía') };
    } catch (error) {
      // Fallos de transporte/AbortSignal también pueden rechazar la promesa.
      lastResult = { data: null, error };
    }
    if (!lastResult.error) return lastResult;
    const err = lastResult.error;
    const blob = `${err.message || ''} ${err.details || ''} ${err.hint || ''} ${err.code || ''} ${err.status || ''} ${err.name || ''}`;
    const transient = TRANSIENT_ERROR.test(blob);
    console.warn(`[Supabase] Error en ${label} (intento ${attempt}/2, ${Date.now() - started}ms): ${err.message || err.name || 'desconocido'}${transient && attempt < 2 ? ' — reintentando…' : ''}`);
    if (!transient || attempt === 2) return lastResult;
    await sleep(300);
  }
  return lastResult;
}

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
    // select('*') a propósito: la tabla admite varias alternativas por campo
    // (info_hash/hash, size/size_bytes, audio/lang…) y una lista fija de
    // columnas haría que PostgREST fallara si alguna no existe. El coste se
    // acota con el límite, que sube a 50 candidatos porque el orden final
    // prioriza calidad e idioma mientras la base solo sabe ordenar por
    // seeders: con 25, el 4K con cuatro seeders se quedaba fuera sin llegar a
    // valorarse. Lo que sale al usuario se recorta aparte a MAX_STREAMS.
    let query = supabase
      .from('torrents')
      .select('*')
      .eq('imdb_id', imdbId)
      .order('seeders', { ascending: false, nullsFirst: false })
      .limit(CANDIDATE_LIMIT);

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

    const mapRows = (rows, packSeason = null) => (Array.isArray(rows) ? rows : [])
      .map(row => {
        if (!row || typeof row !== 'object') return null;
        let infoHash = row.info_hash || row.infoHash || row.hash || null;
        if (infoHash) infoHash = infoHash.toString().trim().toLowerCase();
        // El magnet se analiza una vez por fila: los tres extractores reciben
        // la URL ya parseada y no vuelven a construirla.
        const magnet = parseMagnetUrl(row.magnet_url || row.magnetUrl || row.magnet);
        if (!isValidInfoHash(infoHash)) infoHash = extractInfoHashFromMagnet(magnet);
        if (!isValidInfoHash(infoHash)) return null;
        return buildStreamEntry(row, infoHash, extractTrackersFromMagnet(magnet), imdbId,
          extractTitleFromMagnet(magnet), packSeason, season);
      })
      .filter(Boolean);

    const exact = await runQuery(query, `consulta ${imdbId}`);
    let data = exact.data;
    if (exact.error) {
      const error = exact.error;
      console.error('[Supabase] Error query:', error.message || error.name || 'desconocido', error.details || '');
      return { streams: [] };
    }
    let streamEntries = mapRows(data);

    // Si no hay episodio exacto o sus filas no contienen ningún torrent válido,
    // intenta packs de temporada: fallback útil ante filas huérfanas/malformadas.
    if (isSeries && season !== null && episode !== null && streamEntries.length === 0) {
      console.log(`[Stream] Sin fuente válida del episodio; buscando pack de la temporada ${season} para ${imdbId}`);
      const packQuery = supabase
        .from('torrents')
        .select('*')
        .eq('imdb_id', imdbId)
        .eq('season', season)
        .is('episode', null)
        .order('seeders', { ascending: false, nullsFirst: false })
        .limit(10);
      const pack = await runQuery(packQuery, `pack T${season} ${imdbId}`);
      if (pack.error) {
        console.error('[Supabase] Error query pack:', pack.error.message || pack.error.name || 'desconocido', pack.error.details || '');
        return { streams: [] };
      }
      const packEntries = mapRows(pack.data, season);
      if (packEntries.length) {
        data = pack.data;
        streamEntries = packEntries;
      }
    }

    // Último recurso: releer la temporada completa y descartar en memoria todo
    // lo que no sea el episodio pedido. Resuelve las filas con season/episode
    // como texto ("2", "05"), que el filtro de PostgREST no encuentra, y los
    // packs guardados con episode vacío en vez de NULL. El cotejo se hace
    // siempre aquí, así que no puede colarse un episodio equivocado.
    if (isSeries && season !== null && episode !== null && streamEntries.length === 0) {
      console.log(`[Stream] Sigue sin fuente; cotejando la temporada ${season} en memoria para ${imdbId}`);
      const seasonQuery = supabase
        .from('torrents')
        .select('*')
        .eq('imdb_id', imdbId)
        .order('seeders', { ascending: false, nullsFirst: false })
        .limit(SCAN_LIMIT);
      const scanned = await runQuery(seasonQuery, `temporada ${season} ${imdbId}`);
      if (scanned.error) {
        console.error('[Supabase] Error query temporada:', scanned.error.message || scanned.error.name || 'desconocido', scanned.error.details || '');
        return { streams: [] };
      }
      const rows = Array.isArray(scanned.data) ? scanned.data : [];
      const sameSeason = rows.filter(row => row && typeof row === 'object' && toFiniteNumber(row.season) === season);
      const exactRows = sameSeason.filter(row => toFiniteNumber(row.episode) === episode);
      // Sin episodio exacto solo se aceptan los packs de la temporada: un
      // capítulo vecino nunca se ofrece como si fuera el pedido.
      const packRows = exactRows.length ? [] : sameSeason.filter(row => toFiniteNumber(row.episode) === null);
      const looseEntries = mapRows(exactRows.length ? exactRows : packRows, exactRows.length ? null : season);
      if (looseEntries.length) {
        data = exactRows.length ? exactRows : packRows;
        streamEntries = looseEntries;
        console.log(`[Stream] Recuperadas ${looseEntries.length} fuentes cotejando en memoria (${exactRows.length ? 'episodio exacto' : 'pack de temporada'})`);
      }
    }

    if (!streamEntries.length) {
      console.log(`[Stream] Sin fuentes válidas para ${imdbId}${isSeries ? ` S:${season} E:${episode}` : ''}`);
      // Vacío confirmado y sano: cache corto para evitar repetir consultas.
      return { streams: [], cacheMaxAge: 60 };
    }
    console.log(`[Stream] ${data.length} filas procesadas para ${imdbId} en ${Date.now() - start}ms`);

    // Ordenar de forma determinista: disponibilidad, calidad, idioma, seeders,
    // leechers y tamaño.
    streamEntries.sort(compareStreamEntries);

    const seen = new Set();
    const streams = streamEntries.map(entry => entry.stream).filter(stream => {
      const key = `${stream.infoHash}:${stream.fileIdx ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_STREAMS);

    console.log(`[Stream] → Enviando ${streams.length} streams válidos`);
    // stale-if-error: si una actualización falla en el borde o en el
    // navegador, se conserva la última respuesta buena durante diez minutos.
    return { streams, cacheMaxAge: 120, staleRevalidate: 600, staleError: 600 };

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
// Tras un fallo de la base de datos no se repite la consulta hasta completar
// el cooldown: los fallos no se cachean, pero tampoco martillan la base.
function createCachedStreamHandler(handler, {
  maxEntries = 250, now = Date.now, keepAlive = discardInBackground, retryDelay = 15000,
  failureCooldown
} = {}) {
  const cooldownMs = Number.isFinite(failureCooldown) ? failureCooldown : retryDelay;
  const cache = new Map();
  const pending = new Map();
  const failureUntil = new Map();
  function markFailure(key) {
    failureUntil.set(key, now() + cooldownMs);
    while (failureUntil.size > maxEntries) failureUntil.delete(failureUntil.keys().next().value);
  }
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
        failureUntil.delete(key);
      } else {
        if (previous) previous.retryAt = now() + retryDelay;
        markFailure(key);
      }
      return value;
    }).catch(error => {
      if (previous) previous.retryAt = now() + retryDelay;
      markFailure(key);
      throw error;
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
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
      // stale-if-error del navegador termina junto con la ventana absoluta.
      if (Number.isInteger(value.staleError)) value.staleError = value.staleRevalidate;
      if (hit.expires <= time && hit.retryAt <= time && !pending.has(key)) {
        const background = refresh(key, args, hit).catch(() => {});
        // El Worker mantiene vivo el isolate después de enviar la respuesta
        // con ctx.waitUntil; en local el trabajo sigue su curso normal.
        requestKeepAlive(background);
      }
      return value;
    }
    cache.delete(key);
    // Entradas obsoletas ya caducadas sí se sirven arriba; aquí solo frenamos
    // consultas nuevas mientras dure el cooldown de un fallo reciente.
    const failedUntil = failureUntil.get(key);
    if (failedUntil !== undefined) {
      if (failedUntil > time) return { streams: [] };
      failureUntil.delete(key);
    }
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
  '8K': 8000,
  '4K': 4000,
  '1440p': 3500,
  '1080p': 3000,
  '720p': 2000,
  '576p': 1300,
  '480p': 1000,
  '360p': 600,
  'N/D': 0
};

const LANGUAGE_WEIGHT = {
  'DUAL': 500,
  'CAST': 400,
  'LAT': 350,
  'ESP': 300,
  'VOSE': 200,
  'VOST': 180,
  'SUB': 120,
  'ENG': 100,
  'N/D': 0
};

// Peso de una resolución que no está en la tabla ("WEBRip", "HDTV"): se le
// busca la altura que declare y, si no dice ninguna, vale 0 como N/D.
function resolutionWeight(tag) {
  if (typeof tag !== 'string') return 0;
  if (tag in RESOLUTION_WEIGHT) return RESOLUTION_WEIGHT[tag];
  for (const [pattern, known] of RESOLUTION_TOKENS) {
    if (pattern.test(tag)) return RESOLUTION_WEIGHT[known] ?? 0;
  }
  return 0;
}

// Orden de preferencia. Lo primero es que la fuente esté viva: un 4K sin
// seeders no reproduce, así que baja por debajo de cualquier fuente sana sea
// cual sea su calidad. Después manda la calidad, luego el idioma, y solo dentro
// de un mismo tramo la disponibilidad. El hash al final fija un orden estable:
// dos peticiones idénticas devuelven la misma lista, byte a byte.
function compareStreamEntries(a, b) {
  const health = (b.seeders > 0 ? 1 : 0) - (a.seeders > 0 ? 1 : 0);
  if (health !== 0) return health;

  const resDiff = resolutionWeight(b.resolution) - resolutionWeight(a.resolution);
  if (resDiff !== 0) return resDiff;

  const langDiff = (LANGUAGE_WEIGHT[b.langTag] ?? 0) - (LANGUAGE_WEIGHT[a.langTag] ?? 0);
  if (langDiff !== 0) return langDiff;

  const seederDiff = b.seeders - a.seeders;
  if (seederDiff !== 0) return seederDiff;

  if (a.leecherCount !== b.leecherCount) {
    // Sin leechers declarados seisitúa al final del tramo, no en el primero.
    if (a.leecherCount === null) return 1;
    if (b.leecherCount === null) return -1;
    return a.leecherCount - b.leecherCount;
  }

  if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.infoHash < b.infoHash ? -1 : a.infoHash > b.infoHash ? 1 : 0;
}

// seasonPack: número de temporada cuando la fila es un pack completo en vez
// del episodio exacto (se etiqueta para que el usuario sepa qué descarga).
function buildStreamEntry(row, infoHash, magnetTrackers = [], imdbId = '', magnetTitle = null, seasonPack = null, season = null) {
  const metadata = { ...row, name: row.name || magnetTitle };
  const langTag = getLanguageTag(metadata);
  const resolution = getResolutionTag(metadata);
  const sizeGB = formatSizeGB(row);
  const sizeBytes = parseSizeBytes(row);
  const seeders = Math.max(0, toFiniteNumber(row.seeders ?? row.seed) ?? 0);
  const leecherCount = toFiniteNumber(row.leechers);
  const audio = sanitizeOneLine(row.audio || row.language || row.lang) || 'No indicado';
  const subs = sanitizeOneLine(row.subtitles || row.subs) || 'No indicados';
  const rawTitle = row.title || row.release_name || row.name || magnetTitle || '';
  const titleDisplay = sanitizeOneLine(rawTitle) || 'Sin título';
  const codec = sanitizeOneLine(row.codec || row.video_codec) || '—';
  const group = sanitizeOneLine(row.release_group || row.group || row.team) || '—';
  const quality = sanitizeOneLine(row.quality) || resolution;

  // name: cabecera corta visible en lista (máx ~30 chars)
  const name = `Nexo Play\n[${langTag}] ${resolution}${seasonPack !== null ? ` · PACK T${seasonPack}` : ''}`;

  // title: multilínea con detalles (Stremio lo muestra al hacer hover)
  const titleLines = [
    `🎬 ${titleDisplay}`,
    ...(seasonPack !== null ? [`🗂️ Pack de la temporada ${seasonPack} completa (elige el episodio al reproducir)`] : []),
    `🔊 Audio: ${audio} | 📝 Subs: ${subs}`,
    `💾 Tamaño: ${sizeGB} GB`,
    `👥 Seeders: ${seeders}  |  🌱 Leechers: ${leecherCount ?? '—'}`,
    ...(seeders > 0 ? [] : ['⚠️ Sin seeders ahora mismo: puede que no se pueda reproducir']),
    `⚙️ Codec: ${codec}  |  📦 Grupo: ${group}`,
    `⭐ Calidad: ${quality}`
  ];

  // Trackers del torrent: los del magnet original más los de la columna
  // trackers, con fallback a trackers públicos de alta disponibilidad.
  const trackers = buildTrackers(row.trackers, magnetTrackers);

  const rawFileIdx = row.file_idx ?? row.fileIdx;
  const numericFileIdx = rawFileIdx === '' || rawFileIdx === null || rawFileIdx === undefined ? NaN : Number(rawFileIdx);
  const fileIdx = Number.isSafeInteger(numericFileIdx) && numericFileIdx >= 0 ? numericFileIdx : undefined;

  const stream = {
    name,
    title: titleLines.join('\n'),
    infoHash: infoHash.toLowerCase(),
    ...(fileIdx !== undefined ? { fileIdx } : {}),
    behaviorHints: {
      // Identifica título + temporada + calidad + idioma: la reproducción
      // continua solo agrupa episodios de la misma temporada y nunca títulos
      // distintos, así Stremio no encadena un 1080p con un 4K.
      bingeGroup: `nexo-play|${imdbId}|${season === null ? 'movie' : `s${season}`}|${resolution.toLowerCase()}-${langTag.toLowerCase()}`,
      ...(sizeBytes ? { videoSize: sizeBytes } : {}),
      ...(rawTitle ? { filename: titleDisplay } : {})
    },
    ...(trackers.length ? { sources: trackers } : {})
  };

  return {
    stream,
    resolution,
    langTag,
    seeders,
    leecherCount: leecherCount === null || leecherCount < 0 ? null : leecherCount,
    sizeBytes: sizeBytes || 0,
    infoHash: infoHash.toLowerCase()
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

module.exports.helpers = { parseStremioId, getLanguageTag, getResolutionTag, detectLanguageTag, formatSizeGB, parseSizeBytes, extractInfoHashFromMagnet, extractTrackersFromMagnet, extractTitleFromMagnet, sanitizeOneLine, buildStreamEntry, compareStreamEntries, streamHandler, createCachedStreamHandler, cachedStreamHandler, getSupabaseClient, configure, configStatus, normalizeSupabaseUrl, cleanEnvValue };
