/**
 * Nexo Play - Stremio Addon
 * Lógica principal del addon: catálogo de canales, metadatos y streams
 *
 * Diseñado para Cloudflare Workers + Supabase (PostgreSQL)
 * NO hace scraping ni DDL. Solo consulta public.torrents y public.tv_channels
 */

// Solo el builder: el índice del SDK arrastra serveHTTP/Express, que no corre
// en Workers. El enrutado vive en worker.js y la interfaz se construye abajo.
const addonBuilder = require('stremio-addon-sdk/src/builder');
const { createClient } = require('@supabase/supabase-js');
const { COUNTRY_NAMES, COUNTRY_ALPHA3 } = require('./tv-countries');

const TV_CHANNEL_CATALOG_ID = 'tv_channels';
const TV_CHANNEL_COUNTRY_CATALOG_ID = 'tv_channels_country';
const TV_CHANNEL_COUNTRY_CATALOG_NAME = 'Canales por país';
const TV_CHANNEL_CATALOG_IDS = [TV_CHANNEL_CATALOG_ID, TV_CHANNEL_COUNTRY_CATALOG_ID];
const TV_CHANNEL_TABLE = 'tv_channels';
const TV_CHANNEL_ID_PREFIX = 'nexo-tv:';
const TV_CHANNEL_QUERY_LIMIT = 1000;
const TV_CHANNEL_PAGE_SIZE = 100;
// El catálogo cambia poco: cinco minutos de caché edge reducen las consultas
// frías desde cada punto de presencia sin dejar los canales obsoletos demasiado tiempo.
const TV_CHANNEL_CACHE_SECONDS = 300;
const TV_CHANNEL_ROWS_TTL_MS = 30 * 1000;
const TV_CHANNEL_ROWS_STALE_MS = 10 * 60 * 1000;
const TV_CHANNEL_DEFAULT_COLUMNS = 'id,name,slug,logo_url,stream_url,stream_type,category,country_code,is_active';
const TV_CHANNEL_FALLBACK_POSTER = 'https://nexo-player-app.noe359866.workers.dev/assets/brand.png';
// Filtros que se publican en el manifiesto: el catálogo se lee de la base, así
// que la lista se descubre ahí y solo se recurre a estos valores por defecto
// cuando no hay datos (Preview sin secretos, Supabase caído...).
const TV_GENRE_OPTION_LIMIT = 80;
const TV_OPTIONS_TTL_MS = 10 * 60 * 1000;
const TV_OPTIONS_STALE_MS = 60 * 60 * 1000;
const TV_OPTIONS_WAIT_MS = 2500;
const TV_DEFAULT_CONTENT_TYPE = 'General';
const TV_FALLBACK_CONTENT_TYPES = [
  'Noticias', 'Deportes', 'Películas', 'Series', 'Infantil', 'Documentales',
  'Música', 'Entretenimiento', 'Cultura', TV_DEFAULT_CONTENT_TYPE
];
const TV_FALLBACK_COUNTRIES = [
  'España', 'México', 'Argentina', 'Colombia', 'Chile', 'Perú', 'Venezuela', 'Estados Unidos',
  'Ecuador', 'Uruguay', 'Paraguay', 'Bolivia', 'Costa Rica', 'Panamá', 'República Dominicana',
  'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Cuba', 'Puerto Rico'
];

// ---------------------------------------------------------------------------
// 1. MANIFEST - Especificación oficial Stremio
// ---------------------------------------------------------------------------
const manifest = {
  id: 'org.comunidad.torrents.espanol',
  version: require('./package.json').version,
  name: 'Nexo Play',
  description: 'Películas, series y anime en español e inglés, además de canales de TV en vivo filtrables por tipo de contenido y por país. Grupo de soporte: https://discord.com/invite/qEcdvvcA4',
  resources: [
    'catalog',
    { name: 'meta', types: ['tv'], idPrefixes: [TV_CHANNEL_ID_PREFIX] },
    { name: 'stream', types: ['movie', 'series', 'anime', 'tv'], idPrefixes: ['tt', TV_CHANNEL_ID_PREFIX] }
  ],
  types: ['movie', 'series', 'anime', 'tv'],
  // El Worker reemplaza las listas de filtros por las que descubre en la
  // tabla; aquí quedan las de respaldo para consumidores del SDK y pruebas.
  catalogs: tvCatalogDefinitions(null),
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
    SUPABASE_SERVICE_ROLE_KEY: overrides.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_TORRENT_COLUMNS: overrides.SUPABASE_TORRENT_COLUMNS,
    SUPABASE_TV_CHANNEL_COLUMNS: overrides.SUPABASE_TV_CHANNEL_COLUMNS,
    DFG_DEBUG: overrides.DFG_DEBUG
  } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(envOverrides);
  envOverrides = next;
  if (changed) {
    supabaseClient = null;
    resetTVChannelRowsCache();
    resetTVGenreOptionsCache();
  }
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

function debugEnabled() {
  const value = cleanEnvValue('DFG_DEBUG');
  return value === '1' || /^(true|yes|on)$/i.test(value || '');
}

function debugLog(...args) {
  if (debugEnabled()) console.log(...args);
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
    if (cleanEnvValue('SUPABASE_SERVICE_ROLE_KEY')) {
      console.warn('[Supabase] Usando SERVICE_ROLE_KEY (salta RLS). Para solo lectura es preferible SUPABASE_ANON_KEY con políticas SELECT en torrents y tv_channels.');
    }
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
  const value = id.trim();
  const match = /^(tt\d{7,10})(?::(\d{1,4}):(\d{1,5}))?$/.exec(value);
  if (!match) return empty;
  const season = match[2] === undefined ? null : Number(match[2]);
  const episode = match[3] === undefined ? null : Number(match[3]);
  if ((season !== null && !Number.isSafeInteger(season)) ||
      (episode !== null && !Number.isSafeInteger(episode))) return empty;
  return { imdbId: match[1], season, episode };
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

// Contadores de pares: algunas bases guardan «1.2k» o «3,5 mil» en seeders.
// Además de los números planos se aceptan los sufijos k/m (mil y millón).
const COUNT_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(k|m|mil|millon|millón)?$/i;
const COUNT_MULTIPLIERS = { k: 1e3, mil: 1e3, m: 1e6, millon: 1e6, 'millón': 1e6 };

function parseCount(value) {
  const number = toFiniteNumber(value);
  if (number !== null) return number;
  if (typeof value !== 'string') return null;
  const match = COUNT_PATTERN.exec(value.trim());
  if (!match) return null;
  const base = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(base)) return null;
  const suffix = (match[2] || '').toLowerCase();
  return Math.round(base * (COUNT_MULTIPLIERS[suffix] || 1));
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

// La columna trackers convive en tres formatos: array de Supabase, texto
// separado por comas/saltos y JSON serializado («["udp://..."]»). Los tres se
// aceptan; cualquier valor que no sea una URL utilizable se descarta igual.
function parseTrackerList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* no era JSON: se trata como lista de texto */ }
    return text.slice(1, -1).split(/[,;\s]+/).filter(Boolean);
  }
  return text.split(/[,;\n\r\t]+|\s{2,}/).map(item => item.trim()).filter(Boolean);
}

function buildTrackers(dbTrackersRaw, magnetTrackers = []) {
  const custom = [...magnetTrackers, ...parseTrackerList(dbTrackersRaw)]
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
function flattenLanguageValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  if (value === null || value === undefined) return '';
  return String(value);
}

const LANGUAGE_SOURCES = row => [
  [
    row.audio, row.language, row.lang, row.languages,
    row.audio_language, row.original_language
  ].map(flattenLanguageValue).filter(Boolean).join(' '),
  row.release_name, row.title, row.name
];

function hasIsolatedWord(text, word, wordBoundaryChars = /[a-záéíóúñ0-9]/i) {
  if (!text || !word) return false;
  const lowerText = text.toLowerCase();
  const lowerWord = word.toLowerCase();
  let position = 0;
  while ((position = lowerText.indexOf(lowerWord, position)) !== -1) {
    const before = position > 0 ? lowerText[position - 1] : '';
    const afterIndex = position + lowerWord.length;
    const after = afterIndex < lowerText.length ? lowerText[afterIndex] : '';
    // Si la palabra está incrustada en otras letras/números, no es un token
    // aislado ("engineer" no contiene "en" como código).
    if (wordBoundaryChars.test(before) || wordBoundaryChars.test(after)) {
      position++;
      continue;
    }
    // Para códigos de dos letras muy cortos (es/en), solo los aceptamos si
    // NO están rodeados por espacios en AMBOS lados: así evitamos confundir
    // la palabra española "es" o la preposición "en" con códigos de idioma
    // en frases como "El episodio es en HD". Los códigos en campos estructurados
    // ("es 5.1", "en es", "[ES]") siguen detectándose correctamente.
    if (lowerWord.length === 2 && before === ' ' && after === ' ') {
      position++;
      continue;
    }
    return true;
  }
  return false;
}

function detectLanguageTag(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lower = text.trim().toLowerCase();
  const has = pattern => pattern.test(lower);

  // Los códigos ISO exactos solo se aceptan como tokens completos. Se evita
  // confundir palabras comunes como "es" (verbo) o "en" (preposición) con
  // códigos cuando aparecen rodeadas de espacios dentro de una oración.
  const spanishIso = hasIsolatedWord(lower, 'es') ||
    hasIsolatedWord(lower, 'spa') ||
    /\bes[-_](?:es|mx|419|ar|cl|co|pe)\b/.test(lower);
  const englishIso = hasIsolatedWord(lower, 'en') ||
    hasIsolatedWord(lower, 'eng') ||
    /\ben[-_](?:us|gb|au|ca)\b/.test(lower);

  const spanish = spanishIso ||
    has(/\b(esp|español|spanish|castellano|cast|latino|lat|latam|latinoamérica|japonés|japones)\b/);
  const english = englishIso ||
    has(/\b(eng|english|inglés|ingles)\b/);

  if (has(/\b(dual|multi|dual-sub)\b/) || (spanish && english)) return 'DUAL';
  // «VO»/«V.O.» es la versión original (habitualmente subtitulada), así que se
  // agrupa con VOSE en lugar de quedar como idioma indeterminado.
  if (has(/\b(vose|vos|vo|v\.\s?o\.?|subtitulado|subtitulada)\b/)) return 'VOSE';
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

// Detección de HDR y formatos de audio premium para mostrarlos en la
// descripción del stream y mejorar la puntuación de calidad.
const HDR_TAGS = [
  [/\b(dolby\s*vision|dolbyvision|\bdv\b)/i, 'DV'],
  [/\bhdr10\+/i, 'HDR10+'],
  [/\bhdr10\b/i, 'HDR10'],
  [/\bhdr(?!10)/i, 'HDR']
];
const AUDIO_TAGS = [
  [/atmos|truehd/i, 'Atmos'],
  [/dts:?x|dts-?hd/i, 'DTS-HD'],
  [/dts(?!-?hd|:?x)/i, 'DTS'],
  [/ddp|eac3|dd\+|dolby\s*digital\s*\+/i, 'DD+'],
  [/ac3|dolby\s*digital(?!\s*\+)/i, 'DD'],
  [/aac(?!p)/i, 'AAC'],
  [/flac/i, 'FLAC']
];
const VIDEO_CODEC_TAGS = [
  [/\bav1\b/i, 'AV1'],
  [/\b(hevc|h\.?265|x265)\b/i, 'HEVC'],
  [/\b(h\.?264|x264|avc)\b/i, 'AVC'],
  [/\bvp9\b/i, 'VP9']
];
const EDITION_TAGS = [
  [/\b(remux|bdremux)\b/i, 'REMUX'],
  [/\b(3d|hsbs|hou|sbs)\b/i, '3D'],
  [/\bextended[\s.-]?(cut|edition)?\b/i, 'Extended'],
  [/\bdirector'?s?[\s.-]?cut\b/i, "Director's Cut"],
  [/\bunrated\b/i, 'Unrated'],
  [/\bimax\b/i, 'IMAX']
];
// Etiquetas de advertencia que indican baja calidad o fuente no oficial
const WARNING_TAGS = [
  [/\b(cam|hdcam|ts|telesync|tc|telecine)\b/i, '⚠️ CAM/TS'],
  [/\bscreener\b/i, 'SCREENER']
];

function detectTags(text, tagList) {
  if (!text) return [];
  const str = typeof text === 'string' ? text.toLowerCase() : '';
  const found = [];
  for (const [pattern, label] of tagList) {
    if (pattern.test(str) && !found.includes(label)) found.push(label);
  }
  return found;
}

// Elimina etiquetas HDR redundantes: si hay DV, no hace falta mostrar HDR genérico;
// si hay HDR10+, no hace falta HDR10 ni HDR.
function cleanHdrTags(tags) {
  if (!tags || !tags.length) return [];
  const result = [...tags];
  if (result.includes('HDR10+')) {
    const idx = result.indexOf('HDR10');
    if (idx >= 0) result.splice(idx, 1);
  }
  if (result.includes('DV') || result.includes('HDR10') || result.includes('HDR10+')) {
    const idx = result.indexOf('HDR');
    if (idx >= 0) result.splice(idx, 1);
  }
  return result;
}

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

// Anime y series comparten estructura de episodios: hay bases que etiquetan
// como «series» títulos de anime y al revés. En el cotejo de último recurso se
// aceptan las dos etiquetas entre sí; una película nunca se cuela por aquí.
function sameContentFamily(rowType, requestedType) {
  const left = String(rowType || '').toLowerCase();
  const right = String(requestedType || '').toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const episodic = ['series', 'anime'];
  return episodic.includes(left) && episodic.includes(right);
}

// Cuántas filas se piden, cuántas se releen para el cotejo en memoria y cuántas
// se devuelven. El ranking ordena por calidad e idioma, no por seeders, así que
// el grupo de candidatos tiene que ser mayor que la respuesta final.
const QUERY_TIMEOUT_MS = 4000;
const CANDIDATE_LIMIT = 50;
const SCAN_LIMIT = 50;
const MAX_STREAMS = 25;
const MAX_LANGUAGE_STREAMS = 2;

// Permite reducir el SELECT si el esquema no admite todas las columnas
// opcionales. La lista se valida para que solo acepte identificadores simples.
function torrentColumns() {
  const raw = cleanEnvValue('SUPABASE_TORRENT_COLUMNS');
  return raw && /^[a-z0-9_,\s*]+$/i.test(raw) ? raw.replace(/\s+/g, '') : '*';
}

// Hasta 2 intentos por consulta; los errores permanentes (401, sintaxis, RLS)
// no se reintentan para no duplicar la espera del usuario.
async function runQuery(query, label) {
  let lastResult = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const result = await query.abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
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

// ---------------------------------------------------------------------------
// Canales de TV: lectura defensiva de public.tv_channels. Se aceptan nombres
// habituales de columnas para no imponer un esquema único a la tabla.
// ---------------------------------------------------------------------------
const TV_CHANNEL_ID_COLUMNS = ['id', 'channel_id', 'uuid', 'slug', 'code'];
const TV_CHANNEL_NAME_COLUMNS = ['name', 'channel_name', 'display_name', 'title', 'label', 'channel'];
const TV_CHANNEL_STREAM_COLUMNS = [
  'stream_url', 'streaming_url', 'live_url', 'playback_url', 'playlist_url', 'm3u8_url', 'm3u_url', 'stream_link',
  'video_url', 'content_url', 'source_url', 'channel_url', 'url', 'link', 'src', 'm3u8', 'stream'
];
const TV_CHANNEL_POSTER_COLUMNS = ['logo_url', 'logo', 'image_url', 'poster_url', 'poster', 'icon_url', 'icon', 'thumbnail', 'image'];
const TV_CHANNEL_GENRE_COLUMNS = ['genres', 'category', 'category_name', 'group_title', 'group', 'genre', 'tags'];
const TV_CHANNEL_DESCRIPTION_COLUMNS = ['description', 'about', 'summary', 'info'];
const TV_CHANNEL_COUNTRY_COLUMNS = ['country', 'country_name', 'country_code'];
const TV_CHANNEL_LANGUAGE_COLUMNS = ['language', 'lang', 'audio_language'];
const TV_CHANNEL_SORT_COLUMNS = ['sort_order', 'display_order', 'position', 'channel_number', 'number', 'order'];
const TV_CHANNEL_ACTIVE_COLUMNS = ['is_active', 'active', 'enabled', 'is_enabled', 'published', 'visible'];

function channelRowValue(row, columns) {
  if (!row || typeof row !== 'object') return null;
  for (const column of columns) {
    const value = row[column];
    if (value !== null && value !== undefined && !(typeof value === 'string' && !value.trim())) return value;
  }
  return null;
}

function channelText(value, maxLength = 120) {
  if (Array.isArray(value)) {
    return sanitizeOneLine(value.map(item => channelText(item, maxLength)).filter(Boolean).join(', '), maxLength);
  }
  if (value && typeof value === 'object') {
    const nested = channelRowValue(value, ['name', 'label', 'title', 'value', 'url', 'src', 'stream_url', 'href']);
    return nested === null ? '' : channelText(nested, maxLength);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return sanitizeOneLine(String(value), maxLength);
}

function channelTextList(value, maxItems = 8) {
  const values = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/[,;|]/)
      : value === null || value === undefined ? [] : [value];
  return [...new Set(values.map(item => channelText(item, 60)).filter(Boolean))].slice(0, maxItems);
}

function normalizeChannelUrl(value, allowRtmp = false) {
  const raw = channelText(value, 2000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const allowed = allowRtmp ? ['http:', 'https:', 'rtmp:'] : ['http:', 'https:'];
    return allowed.includes(url.protocol) && url.hostname ? url.href : null;
  } catch (_) {
    return null;
  }
}

function isChannelEnabled(row) {
  if (row.deleted_at !== undefined && row.deleted_at !== null && row.deleted_at !== '') return false;
  if (row.is_deleted === true || row.deleted === true) return false;
  const value = channelRowValue(row, TV_CHANNEL_ACTIVE_COLUMNS);
  if (value === null) return true;
  if (value === false || value === 0) return false;
  return !['false', 'f', '0', 'no', 'off', 'inactive', 'disabled', 'archived']
    .includes(String(value).trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Clasificación del catálogo de TV: tipo de contenido y país. La tabla
// compartida declara categoría y país como texto libre, así que aquí se
// normalizan sin pedir cambios en la base de datos.
// ---------------------------------------------------------------------------

// Tipos de contenido: reúnen los alias en español e inglés que aparecen en las
// listas de IPTV. Coinciden por palabra completa y gana el alias más largo, así
// que «Sports HD» es Deportes, «Talk Show» es Entretenimiento y «deportistas»
// no se confunde con «deportes». Lo que no se reconoce se respeta tal cual y lo
// que llega vacío cae en «General».
const TV_CONTENT_TYPES = [
  { name: 'Noticias', aliases: ['noticias', 'noticia', 'noticiero', 'noticieros', 'news', 'informativo', 'informativos', 'actualidad', 'prensa'] },
  { name: 'Deportes', aliases: ['deportes', 'deporte', 'deportivo', 'deportiva', 'sports', 'sport', 'futbol', 'football', 'soccer', 'baloncesto', 'basketball', 'beisbol', 'baseball', 'tenis', 'tennis', 'boxeo', 'boxing', 'ufc', 'mma', 'motorsport', 'motor', 'formula 1', 'esports', 'ciclismo', 'golf'] },
  { name: 'Películas', aliases: ['peliculas', 'pelicula', 'movies', 'movie', 'cine', 'film', 'films', 'cinema', 'estrenos'] },
  { name: 'Series', aliases: ['series', 'serie', 'shows', 'show', 'tv shows', 'tvshow', 'ficcion', 'telenovelas', 'telenovela', 'novelas', 'novela'] },
  { name: 'Infantil', aliases: ['infantil', 'ninos', 'ninas', 'kids', 'kid', 'cartoon', 'cartoons', 'dibujos', 'dibujos animados', 'animacion', 'animation', 'juvenil'] },
  { name: 'Documentales', aliases: ['documental', 'documentales', 'documentary', 'documentaries', 'docs', 'naturaleza', 'nature', 'historia', 'history'] },
  { name: 'Música', aliases: ['musica', 'music', 'musical', 'musicales', 'conciertos', 'videoclips', 'mtv'] },
  { name: 'Cultura', aliases: ['cultura', 'culture', 'arte', 'artes', 'teatro'] },
  { name: 'Entretenimiento', aliases: ['entretenimiento', 'entertainment', 'variedades', 'variety', 'reality', 'realities', 'concursos', 'concurso', 'humor', 'comedia', 'comedy', 'talk show', 'magazine', 'corazon', 'cotilleo', 'celebridades'] },
  { name: 'Estilo de vida', aliases: ['estilo de vida', 'lifestyle', 'cocina', 'gastronomia', 'food', 'hogar', 'home', 'salud', 'health', 'bienestar', 'moda', 'fashion', 'belleza', 'decoracion'] },
  { name: 'Viajes', aliases: ['viajes', 'viaje', 'travel', 'turismo', 'tourism', 'outdoor'] },
  { name: 'Tecnología', aliases: ['tecnologia', 'tech', 'ciencia', 'ciencias', 'science', 'informatica', 'gadgets'] },
  { name: 'Religión', aliases: ['religion', 'religioso', 'religiosa', 'fe', 'cristiano', 'cristiana', 'catolico', 'catolica', 'iglesia', 'evangelica', 'espiritual'] },
  { name: 'Compras', aliases: ['compras', 'shopping', 'teletienda', 'teleshopping', 'ventas'] },
  { name: TV_DEFAULT_CONTENT_TYPE, aliases: ['general', 'generalista', 'misc', 'varios', 'otros', 'other', 'others', 'local', 'locales', 'regional', 'regionales', 'nacional', 'nacionales', 'autonomicas', 'autonomicos', 'comunitaria', 'publica', 'publicas', 'sin categoria', 'sin clasificar', 'uncategorized', 'unknown', 'desconocido', 'desconocida'] }
];

// Valores que solo describen la emisión y no el contenido («HD», «FHD 1080p»):
// no sirven como tipo y se ignoran al clasificar.
const TV_TECHNICAL_CATEGORY_WORDS = new Set([
  'hd', 'fhd', 'uhd', 'sd', 'hq', '4k', '8k', '2k', '1080p', '1080i', '720p', '576p', '480p', '360p',
  'full', 'fullhd', 'live', 'directo', 'en', 'alta', 'definicion', 'ultra', 'tv', 'canal'
]);

function isTechnicalTVValue(folded) {
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every(word => TV_TECHNICAL_CATEGORY_WORDS.has(word));
}
// Los alias y sus expresiones se compilan una sola vez al iniciar el módulo.
// Compilar una RegExp por alias y por canal en cada catálogo era trabajo
// repetido y especialmente caro en el límite de CPU de Workers Free.
const TV_CONTENT_TYPE_LOOKUPS = (() => {
  const exact = new Map();
  const matchers = [];
  for (const type of TV_CONTENT_TYPES) {
    const aliases = [...new Set(type.aliases.map(foldChannelSearch).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      if (!exact.has(alias)) exact.set(alias, type.name);
      matchers.push({
        name: type.name,
        alias,
        pattern: new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`)
      });
    }
  }
  // El sort de JavaScript es estable: los empates conservan la prioridad
  // histórica de TV_CONTENT_TYPES y de sus alias.
  matchers.sort((a, b) => b.alias.length - a.alias.length);
  return { exact, matchers };
})();

// Nombres de país que la tabla puede escribir a mano; se suman los alias que no
// coinciden con los nombres oficiales en español.
const TV_COUNTRY_NAME_ALIASES = {
  'estados unidos de america': 'US', 'ee uu': 'US', 'eeuu': 'US', usa: 'US', 'united states': 'US',
  'reino unido de gran bretana e irlanda del norte': 'GB', uk: 'GB', 'great britain': 'GB',
  holanda: 'NL', 'paises bajos holanda': 'NL', 'republica checa': 'CZ', chequia: 'CZ',
  birmania: 'MM', suazilandia: 'SZ', 'corea del sur': 'KR', 'corea del norte': 'KP',
  'republica de corea': 'KR', 'republica popular democratica de corea': 'KP',
  'republica arabe siria': 'SY', 'republica islamica de iran': 'IR', 'santa sede': 'VA',
  vaticano: 'VA', 'republica democratica del congo': 'CD', 'republica del congo': 'CG',
  'costa de marfil': 'CI', 'timor oriental': 'TL', 'sahara occidental': 'EH'
};
const TV_COUNTRY_NAME_INDEX = (() => {
  const index = new Map();
  for (const [code, name] of Object.entries(COUNTRY_NAMES)) index.set(foldChannelSearch(name), code);
  for (const [name, code] of Object.entries(TV_COUNTRY_NAME_ALIASES)) index.set(foldChannelSearch(name), code);
  return index;
})();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalTVContentTypeFolded(folded) {
  if (!folded) return '';
  const exact = TV_CONTENT_TYPE_LOOKUPS.exact.get(folded);
  if (exact) return exact;
  for (const matcher of TV_CONTENT_TYPE_LOOKUPS.matchers) {
    if (matcher.pattern.test(folded)) return matcher.name;
  }
  return '';
}

function canonicalTVContentType(value) {
  return canonicalTVContentTypeFolded(foldChannelSearch(value));
}

// Categorías declaradas en orden: la primera que se reconoce decide el tipo y,
// si ninguna lo hace, se conserva la primera con contenido para no perder
// información. Las etiquetas técnicas («HD», «1080p») no cuentan como tipo.
function channelContentType(genres) {
  const declared = Array.isArray(genres) ? genres : [];
  let fallback = '';
  for (const value of declared) {
    const folded = foldChannelSearch(value);
    if (!folded || isTechnicalTVValue(folded)) continue;
    const canonical = canonicalTVContentTypeFolded(folded);
    if (canonical) return canonical;
    if (!fallback) fallback = value;
  }
  return fallback || TV_DEFAULT_CONTENT_TYPE;
}

function countryCodeFromFolded(folded) {
  if (!folded) return '';
  if (/^[a-z]{2}$/.test(folded)) {
    const code = folded.toUpperCase();
    if (COUNTRY_NAMES[code]) return code;
  }
  if (/^[a-z]{3}$/.test(folded)) {
    const code = COUNTRY_ALPHA3[folded.toUpperCase()];
    if (code) return code;
  }
  return TV_COUNTRY_NAME_INDEX.get(folded) || '';
}

function countryCodeFromValue(value) {
  return countryCodeFromFolded(foldChannelSearch(value));
}

// El país se muestra con su nombre en español; si la tabla trae un valor que no
// se reconoce (por ejemplo una región o «Europa») se respeta literalmente.
function countryNameFromValue(value) {
  const raw = channelText(value, 80);
  if (!raw) return '';
  const code = countryCodeFromValue(raw);
  return code ? (COUNTRY_NAMES[code] || code) : raw;
}

function tvGenreMatcher(genre) {
  const folded = foldChannelSearch(genre);
  // Sin filtro (o con el «todos» que algunos clientes envían) no se recorta nada.
  if (!folded || ['todos', 'todas', 'all', 'any'].includes(folded)) return () => true;
  const canonical = canonicalTVContentTypeFolded(folded);
  const code = countryCodeFromFolded(folded);
  return channel => {
    if (foldChannelSearch(channel.contentType) === folded) return true;
    if (canonical && canonical === channel.contentType) return true;
    if (channel.genres.some(value => foldChannelSearch(value) === folded)) return true;
    if (foldChannelSearch(channel.country) === folded) return true;
    return Boolean(code && channel.countryCode === code);
  };
}

function channelMatchesTVGenre(channel, genre) {
  return tvGenreMatcher(genre)(channel);
}

function encodeBase64Url(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const TV_CHANNEL_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function tvChannelExplicitId(row) {
  return channelText(channelRowValue(row, TV_CHANNEL_ID_COLUMNS), 300);
}

function tvChannelId(row, name = '', streamUrl = '') {
  const explicitId = tvChannelExplicitId(row);
  const identity = explicitId ? `id:${explicitId}` : `row:${name}\u0000${streamUrl}`;
  return `${TV_CHANNEL_ID_PREFIX}${encodeBase64Url(identity)}`;
}

// Datos normalizados que hacen falta para ordenar y filtrar. No valida URL de
// stream/logo ni calcula el ID de cada fila: esas operaciones solo hacen falta
// para los canales de la página devuelta (salvo nombres repetidos al ordenar).
function tvChannelSortCandidate(row) {
  if (!row || typeof row !== 'object' || !isChannelEnabled(row)) return null;
  const name = channelText(channelRowValue(row, TV_CHANNEL_NAME_COLUMNS), 120);
  if (!name) return null;
  const sortOrder = toFiniteNumber(channelRowValue(row, TV_CHANNEL_SORT_COLUMNS));
  return {
    row,
    id: null,
    name,
    sortOrder: sortOrder !== null && sortOrder >= 0 ? sortOrder : null
  };
}

function tvChannelCatalogCandidate(row) {
  const base = tvChannelSortCandidate(row);
  if (!base) return null;

  const genres = channelTextList(channelRowValue(row, TV_CHANNEL_GENRE_COLUMNS));
  const countryRaw = channelText(channelRowValue(row, TV_CHANNEL_COUNTRY_COLUMNS), 80);
  const countryCode = countryCodeFromValue(countryRaw);
  return {
    ...base,
    type: 'tv',
    genres,
    contentType: channelContentType(genres),
    description: channelText(channelRowValue(row, TV_CHANNEL_DESCRIPTION_COLUMNS), 300),
    country: countryCode ? (COUNTRY_NAMES[countryCode] || countryCode) : countryRaw,
    countryCode,
    language: channelText(channelRowValue(row, TV_CHANNEL_LANGUAGE_COLUMNS), 80)
  };
}

function tvChannelCandidateId(candidate) {
  if (!candidate.id) {
    const explicitId = tvChannelExplicitId(candidate.row);
    // Solo hace falta una clave de desempate: no parsear/validar URL hasta que
    // la fila quede en la página final, incluso si varios canales comparten nombre.
    const streamUrl = explicitId ? '' : channelText(
      channelRowValue(candidate.row, TV_CHANNEL_STREAM_COLUMNS), 2000
    );
    candidate.id = tvChannelId(candidate.row, candidate.name, streamUrl || '');
  }
  return candidate.id;
}

function completeTVChannelCandidate(candidate) {
  if (!candidate) return null;
  const row = candidate.row;
  const streamUrl = normalizeChannelUrl(
    channelRowValue(row, TV_CHANNEL_STREAM_COLUMNS), true
  );
  const poster = normalizeChannelUrl(
    channelRowValue(row, TV_CHANNEL_POSTER_COLUMNS)
  );
  const declaredStreamType = channelText(row.stream_type, 24).toLowerCase();
  const { row: _row, id: _candidateId, ...channel } = candidate;
  return {
    ...channel,
    id: tvChannelId(row, candidate.name, streamUrl || ''),
    streamUrl,
    streamType: ['hls', 'dash', 'embed', 'custom'].includes(declaredStreamType) ? declaredStreamType : 'hls',
    poster
  };
}

function normalizeTVChannel(row) {
  return completeTVChannelCandidate(tvChannelCatalogCandidate(row));
}

function compareTVChannelSortFields(a, b) {
  if (a.sortOrder !== null && b.sortOrder !== null && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.sortOrder !== null && b.sortOrder === null) return -1;
  if (a.sortOrder === null && b.sortOrder !== null) return 1;
  return TV_CHANNEL_NAME_COLLATOR.compare(a.name, b.name);
}

function compareTVChannelCandidates(a, b) {
  const order = compareTVChannelSortFields(a, b);
  return order || tvChannelCandidateId(a).localeCompare(tvChannelCandidateId(b));
}

function channelPosterFallback(origin) {
  try {
    const url = new URL(origin);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname) return `${url.origin}/assets/brand.png`;
  } catch (_) { /* SDK callers do not have a request origin */ }
  return TV_CHANNEL_FALLBACK_POSTER;
}

function buildTVChannelMeta(channel, origin) {
  if (!channel) return null;
  // Los géneros que ve el usuario son el tipo de contenido y el país ya
  // normalizados: es la misma clasificación que ofrecen los filtros.
  const genres = [...new Set([channel.contentType, channel.country].filter(Boolean))];
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    poster: channel.poster || channelPosterFallback(origin),
    posterShape: 'square',
    ...(channel.description ? { description: channel.description } : {}),
    ...(genres.length ? { genres } : {}),
    ...(channel.country ? { country: channel.country } : {}),
    ...(channel.language ? { language: channel.language } : {}),
    behaviorHints: { isLive: true }
  };
}

function foldChannelSearch(value) {
  return channelText(value, 300).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

let tvChannelRowsCache = null;
let tvChannelRowsPending = null;
let tvChannelRowsGeneration = 0;
let tvChannelProjectionFallback = false;

function resetTVChannelRowsCache() {
  tvChannelRowsCache = null;
  tvChannelRowsPending = null;
  tvChannelRowsGeneration++;
  tvChannelProjectionFallback = false;
}

function tvChannelColumns() {
  const raw = cleanEnvValue('SUPABASE_TV_CHANNEL_COLUMNS');
  if (!raw) return tvChannelProjectionFallback ? '*' : TV_CHANNEL_DEFAULT_COLUMNS;
  if (!/^[a-z0-9_,\s*]+$/i.test(raw)) return tvChannelProjectionFallback ? '*' : TV_CHANNEL_DEFAULT_COLUMNS;
  return tvChannelProjectionFallback ? '*' : raw.replace(/\s+/g, '');
}

function isMissingTVChannelColumn(error) {
  const code = String(error && error.code || '').toUpperCase();
  const message = `${error && error.message || ''} ${error && error.details || ''}`;
  return code === '42703' || code === 'PGRST204' ||
    /column .+ (?:does not exist|not found|could not find)/i.test(message);
}

function staleTVChannelRows(now = Date.now()) {
  if (!tvChannelRowsCache) return null;
  const age = now - tvChannelRowsCache.at;
  if (age <= TV_CHANNEL_ROWS_STALE_MS) {
    return { rows: tvChannelRowsCache.rows, error: null, stale: true };
  }
  // No retener el catálogo compacto después de vencer su ventana de respaldo.
  tvChannelRowsCache = null;
  return null;
}

async function readTVChannelRows(clientFactory, { useIsolateCache, generation }) {
  const cacheIsCurrent = () => !useIsolateCache || generation === tvChannelRowsGeneration;
  const staleFallback = () => useIsolateCache && cacheIsCurrent()
    ? staleTVChannelRows()
    : null;

  let supabase;
  try {
    supabase = clientFactory();
    if (!supabase) return staleFallback() || { rows: [], error: new Error('Supabase no configurado') };

    let columns = tvChannelColumns();
    let result = await runQuery(
      supabase.from(TV_CHANNEL_TABLE).select(columns).limit(TV_CHANNEL_QUERY_LIMIT),
      'consulta public.tv_channels'
    );
    // Las tablas no canónicas conservan compatibilidad: si falta una columna
    // de la proyección compacta, usa SELECT * una vez y recuerda ese modo para
    // este isolate. En el esquema compartido solo viajan los campos necesarios.
    if (result.error && columns !== '*' && isMissingTVChannelColumn(result.error)) {
      if (useIsolateCache && cacheIsCurrent()) tvChannelProjectionFallback = true;
      result = await runQuery(
        supabase.from(TV_CHANNEL_TABLE).select('*').limit(TV_CHANNEL_QUERY_LIMIT),
        'consulta public.tv_channels (compatibilidad de esquema)'
      );
    }
    if (result.error) return staleFallback() || { rows: [], error: result.error };
    const rows = Array.isArray(result.data) ? result.data : [];
    if (useIsolateCache && cacheIsCurrent()) tvChannelRowsCache = { at: Date.now(), rows };
    return { rows, error: null };
  } catch (error) {
    console.error('[TV] Error leyendo tv_channels:', error && (error.message || error.name) || 'desconocido');
    return staleFallback() || { rows: [], error };
  }
}

async function fetchTVChannelRows(clientFactory = getSupabaseClient) {
  const useIsolateCache = clientFactory === getSupabaseClient;
  const startedAt = Date.now();
  if (useIsolateCache && tvChannelRowsCache && startedAt - tvChannelRowsCache.at < TV_CHANNEL_ROWS_TTL_MS) {
    return { rows: tvChannelRowsCache.rows, error: null, cached: true };
  }

  // Peticiones frías concurrentes comparten la misma lectura de Supabase, en
  // vez de descargar/procesar hasta mil filas repetidamente en un isolate.
  if (useIsolateCache && tvChannelRowsPending) return tvChannelRowsPending;
  const generation = tvChannelRowsGeneration;
  const pending = readTVChannelRows(clientFactory, { useIsolateCache, generation });
  if (!useIsolateCache) return pending;

  tvChannelRowsPending = pending;
  try {
    return await pending;
  } finally {
    if (tvChannelRowsPending === pending) tvChannelRowsPending = null;
  }
}

// Devuelve los tipos de contenido más frecuentes y los países por orden
// alfabético español a partir de contadores, sin crear una lista intermedia.
function tvGenreOptionsFromCounts(contentCounts, countryCounts) {
  const contentTypes = [...contentCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .slice(0, TV_GENRE_OPTION_LIMIT)
    .map(([name]) => name);
  const countries = [...countryCounts.keys()]
    .sort((a, b) => a.localeCompare(b, 'es'))
    .slice(0, TV_GENRE_OPTION_LIMIT);
  return { contentTypes, countries };
}

function tvGenreOptions(channels) {
  const contentCounts = new Map();
  const countryCounts = new Map();
  for (const channel of channels) {
    if (channel.contentType) contentCounts.set(channel.contentType, (contentCounts.get(channel.contentType) || 0) + 1);
    if (channel.country) countryCounts.set(channel.country, (countryCounts.get(channel.country) || 0) + 1);
  }
  return tvGenreOptionsFromCounts(contentCounts, countryCounts);
}

// El manifiesto solo necesita categorías y países; no debe normalizar URLs,
// logos ni IDs ni crear objetos intermedios por cada canal para descubrir
// dos listas de filtros.
function tvGenreOptionsFromRows(rows) {
  const contentCounts = new Map();
  const countryCounts = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !isChannelEnabled(row)) continue;
    if (!channelText(channelRowValue(row, TV_CHANNEL_NAME_COLUMNS), 120)) continue;
    const genres = channelTextList(channelRowValue(row, TV_CHANNEL_GENRE_COLUMNS));
    const contentType = channelContentType(genres);
    const countryRaw = channelText(channelRowValue(row, TV_CHANNEL_COUNTRY_COLUMNS), 80);
    const countryCode = countryCodeFromValue(countryRaw);
    const country = countryCode ? (COUNTRY_NAMES[countryCode] || countryCode) : countryRaw;
    if (contentType) contentCounts.set(contentType, (contentCounts.get(contentType) || 0) + 1);
    if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
  }
  return tvGenreOptionsFromCounts(contentCounts, countryCounts);
}

// Caché en memoria de los filtros descubiertos. El manifiesto se sirve desde
// la caché del edge, así que esta consulta no ocurre en cada petición; si la
// base falla se conserva la última lista buena dentro de la ventana obsoleta.
let tvGenreOptionsCache = { at: 0, value: null };

function resetTVGenreOptionsCache() {
  tvGenreOptionsCache = { at: 0, value: null };
}

async function discoverTVGenreOptions(clientFactory, now) {
  try {
    const result = await fetchTVChannelRows(clientFactory);
    if (!result.error) {
      const discovered = tvGenreOptionsFromRows(result.rows);
      if (discovered.contentTypes.length || discovered.countries.length) {
        if (!result.stale) tvGenreOptionsCache = { at: now, value: discovered };
        return discovered;
      }
    }
  } catch (error) {
    console.error('[TV] Error descubriendo los filtros:', error && (error.message || error.name) || 'desconocido');
  }
  return null;
}

/**
 * Devuelve los filtros descubiertos sin bloquear el manifiesto: si la lista
 * cacheada está fresca se usa tal cual; si está obsoleta se sirve de inmediato
 * mientras se refresca en segundo plano, y solo la primera consulta (sin nada
 * cacheado) espera un presupuesto corto antes de responder con el respaldo.
 */
async function tvCatalogOptions(clientFactory = getSupabaseClient, { now = Date.now(), force = false, budgetMs = TV_OPTIONS_WAIT_MS } = {}) {
  const cached = force ? { at: 0, value: null } : tvGenreOptionsCache;
  if (cached.value && now - cached.at < TV_OPTIONS_TTL_MS) return cached.value;
  const pending = discoverTVGenreOptions(clientFactory, now);
  if (cached.value && now - cached.at < TV_OPTIONS_STALE_MS) {
    discardInBackground(pending);
    return cached.value;
  }
  if (!(budgetMs > 0)) {
    discardInBackground(pending);
    return null;
  }
  return (await Promise.race([pending, sleep(budgetMs).then(() => null)])) || null;
}

// Catálogos que se publican en el manifiesto: uno por tipo de contenido y otro
// por país, cada uno con su listado de filtros. Sin datos descubiertos se usan
// las listas de respaldo para que Stremio siempre muestre un filtro utilizable.
function tvCatalogDefinitions(options) {
  const contentTypes = options && Array.isArray(options.contentTypes) && options.contentTypes.length
    ? options.contentTypes : TV_FALLBACK_CONTENT_TYPES;
  const countries = options && Array.isArray(options.countries) && options.countries.length
    ? options.countries : TV_FALLBACK_COUNTRIES;
  return [
    {
      type: 'tv',
      id: TV_CHANNEL_CATALOG_ID,
      name: 'Canales de TV',
      genres: contentTypes,
      extra: [{ name: 'genre', options: contentTypes }, { name: 'search' }, { name: 'skip' }]
    },
    {
      type: 'tv',
      id: TV_CHANNEL_COUNTRY_CATALOG_ID,
      name: TV_CHANNEL_COUNTRY_CATALOG_NAME,
      genres: countries,
      extra: [{ name: 'genre', options: countries }, { name: 'search' }, { name: 'skip' }]
    }
  ];
}

async function tvCatalogHandler({ type, id, extra = {}, origin } = {}, clientFactory = getSupabaseClient) {
  if (type !== 'tv' || !TV_CHANNEL_CATALOG_IDS.includes(id)) return { metas: [] };
  try {
    const result = await fetchTVChannelRows(clientFactory);
    if (result.error) return { metas: [] };

    const search = foldChannelSearch(extra.search || '');
    const genre = extra.genre || '';
    const foldedGenre = foldChannelSearch(genre);
    const noGenreFilter = !foldedGenre || ['todos', 'todas', 'all', 'any'].includes(foldedGenre);
    const sortOnly = !search && noGenreFilter;
    let candidates = result.rows.map(sortOnly ? tvChannelSortCandidate : tvChannelCatalogCandidate).filter(Boolean);
    if (search) {
      candidates = candidates.filter(channel => [
        channel.name, channel.description, channel.country, channel.countryCode,
        channel.contentType, channel.language, ...channel.genres
      ].some(value => foldChannelSearch(value).includes(search)));
    }
    if (!noGenreFilter) {
      const matchesGenre = tvGenreMatcher(genre);
      candidates = candidates.filter(matchesGenre);
    }

    const rawSkip = Number(extra.skip || 0);
    const skip = Number.isSafeInteger(rawSkip) && rawSkip > 0 ? Math.min(rawSkip, TV_CHANNEL_QUERY_LIMIT) : 0;
    // Sin filtros, se ordena usando solo nombre/posición/ID y se normaliza por
    // completo únicamente la página pedida. Los filtros calculan solo campos
    // textuales; URL y logo también quedan aplazados hasta esa misma página.
    const metas = candidates.sort(compareTVChannelCandidates)
      .slice(skip, skip + TV_CHANNEL_PAGE_SIZE)
      .map(candidate => sortOnly
        ? normalizeTVChannel(candidate.row)
        : completeTVChannelCandidate(candidate))
      .map(channel => buildTVChannelMeta(channel, origin));
    return {
      metas,
      cacheMaxAge: result.stale ? Math.min(TV_CHANNEL_CACHE_SECONDS, 60) : TV_CHANNEL_CACHE_SECONDS,
      staleRevalidate: 600,
      staleError: 600
    };
  } catch (error) {
    console.error('[TV] Error generando el catálogo:', error && (error.message || error.name) || 'desconocido');
    return { metas: [] };
  }
}

function decodeTVChannelIdentity(id) {
  if (typeof id !== 'string' || !id.startsWith(TV_CHANNEL_ID_PREFIX)) return null;
  const encoded = id.slice(TV_CHANNEL_ID_PREFIX.length);
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (_) {
    return null;
  }
}

function findTVChannelById(rows, id) {
  const identity = decodeTVChannelIdentity(id);
  if (!identity) return null;
  if (identity.startsWith('id:')) {
    const wanted = identity.slice(3);
    for (const row of rows) {
      if (tvChannelExplicitId(row) === wanted) return normalizeTVChannel(row);
    }
    return null;
  }
  if (identity.startsWith('row:')) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const name = channelText(channelRowValue(row, TV_CHANNEL_NAME_COLUMNS), 120);
      if (!name) continue;
      const streamUrl = normalizeChannelUrl(channelRowValue(row, TV_CHANNEL_STREAM_COLUMNS), true) || '';
      if (`row:${name}\u0000${streamUrl}` === identity) return normalizeTVChannel(row);
    }
  }
  return null;
}

async function tvMetaHandler({ type, id, origin } = {}, clientFactory = getSupabaseClient) {
  if (type !== 'tv' || typeof id !== 'string' || !id.startsWith(TV_CHANNEL_ID_PREFIX)) return { meta: {} };
  try {
    const result = await fetchTVChannelRows(clientFactory);
    if (result.error) return { meta: {} };
    const channel = findTVChannelById(result.rows, id);
    if (!channel) return { meta: {}, cacheMaxAge: 60 };
    return {
      meta: buildTVChannelMeta(channel, origin),
      cacheMaxAge: result.stale ? Math.min(TV_CHANNEL_CACHE_SECONDS, 60) : TV_CHANNEL_CACHE_SECONDS,
      staleRevalidate: 600,
      staleError: 600
    };
  } catch (error) {
    console.error('[TV] Error generando metadatos:', error && (error.message || error.name) || 'desconocido');
    return { meta: {} };
  }
}

async function tvStreamHandler({ type, id } = {}, clientFactory = getSupabaseClient) {
  if (type !== 'tv' || typeof id !== 'string' || !id.startsWith(TV_CHANNEL_ID_PREFIX)) return { streams: [] };
  try {
    const result = await fetchTVChannelRows(clientFactory);
    if (result.error) return { streams: [] };
    const channel = findTVChannelById(result.rows, id);
    if (!channel || !channel.streamUrl) return { streams: [], cacheMaxAge: 60 };

    const url = new URL(channel.streamUrl);
    const webReadyMp4 = url.protocol === 'https:' && /\.(?:mp4|m4v)$/i.test(url.pathname);
    const stream = {
      name: `Nexo Play · ${channel.streamType.toUpperCase()}`,
      title: `${channel.name}${channel.description ? `\n${channel.description}` : ''}`,
      ...(channel.streamType === 'embed' && ['http:', 'https:'].includes(url.protocol)
        ? { externalUrl: channel.streamUrl }
        : {
            url: channel.streamUrl,
            ...(!webReadyMp4 ? { behaviorHints: { notWebReady: true } } : {})
          })
    };
    return {
      streams: [stream],
      cacheMaxAge: result.stale ? Math.min(TV_CHANNEL_CACHE_SECONDS, 60) : TV_CHANNEL_CACHE_SECONDS,
      staleRevalidate: 600,
      staleError: 600
    };
  } catch (error) {
    console.error('[TV] Error generando el stream:', error && (error.message || error.name) || 'desconocido');
    return { streams: [] };
  }
}

async function streamHandler({ type, id } = {}, clientFactory = getSupabaseClient) {
  const start = Date.now();
  console.log(`[Stream] → type=${type} id=${id}`);

  try {
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

    const isSeries = type === 'series' || type === 'anime';
    const columns = torrentColumns();
    const bySeeders = (query, limit) => query
      .order('seeders', { ascending: false, nullsFirst: false })
      .limit(limit);
    const baseQuery = () => supabase.from('torrents').select(columns).eq('imdb_id', imdbId).eq('type', type);
    const mapRows = (rows, packSeason = null, seriesPack = false) => (Array.isArray(rows) ? rows : [])
      .map(row => {
        if (!row || typeof row !== 'object') return null;
        let infoHash = row.info_hash_clean || row.info_hash || row.infoHash || row.hash || null;
        if (infoHash) infoHash = infoHash.toString().trim().toLowerCase();
        const magnet = parseMagnetUrl(row.magnet_url || row.magnetUrl || row.magnet);
        if (!isValidInfoHash(infoHash)) infoHash = extractInfoHashFromMagnet(magnet);
        if (!isValidInfoHash(infoHash)) return null;

        const magnetTitle = extractTitleFromMagnet(magnet);
        const metadata = { ...row, name: row.name || magnetTitle };
        const rawLeechers = parseCount(row.leechers ?? row.leechs ?? row.peers);
        return {
          // Solo se calculan los campos de ranking ahora. Crear nombres largos,
          // badges, trackers y títulos detallados se aplaza a los 25 elegidos.
          row: metadata,
          sourceRow: row,
          infoHash: infoHash.toLowerCase(),
          resolution: getResolutionTag(metadata),
          langTag: getLanguageTag(metadata),
          seeders: Math.max(0, parseCount(row.seeders ?? row.seeds ?? row.seed) ?? 0),
          leecherCount: rawLeechers === null || rawLeechers < 0 ? null : rawLeechers,
          sizeBytes: parseSizeBytes(row) || 0,
          fileIdx: streamFileIndex(row),
          magnet,
          imdbId,
          magnetTitle,
          seasonPack: packSeason,
          season,
          seriesPack
        };
      })
      .filter(Boolean);

    let data = [];
    let streamEntries = [];
    if (isSeries) {
      // Una consulta trae el episodio exacto y los packs de temporada
      // (episode IS NULL); si PostgREST no encuentra filas, se coteja en memoria.
      console.log(`[Stream] Filtrando S:${season} E:${episode} para ${imdbId}`);
      const result = await runQuery(
        bySeeders(baseQuery().eq('season', season).or(`episode.eq.${episode},episode.is.null`), CANDIDATE_LIMIT),
        `consulta ${imdbId} S${season}E${episode}`
      );
      if (result.error) {
        const error = result.error;
        console.error('[Supabase] Error query:', error.message || error.name || 'desconocido', error.details || '');
        return { streams: [] };
      }

      const rows = Array.isArray(result.data) ? result.data : [];
      const exactRows = rows.filter(row => row && toFiniteNumber(row.episode) === episode);
      const packRows = rows.filter(row => row && toFiniteNumber(row.episode) === null);
      streamEntries = mapRows(exactRows);
      data = exactRows;
      if (!streamEntries.length) {
        const packEntries = mapRows(packRows, season);
        if (packEntries.length) {
          console.log(`[Stream] Sin fuente válida del episodio; usando pack de la temporada ${season} para ${imdbId}`);
          data = packRows;
          streamEntries = packEntries;
        }
      }

      if (!streamEntries.length && type === 'anime') {
        const absoluteResult = await runQuery(
          bySeeders(baseQuery().eq('absolute_episode', episode), CANDIDATE_LIMIT),
          'anime absoluto E' + episode + ' ' + imdbId
        );
        if (!absoluteResult.error) {
          const absoluteRows = Array.isArray(absoluteResult.data) ? absoluteResult.data : [];
          streamEntries = mapRows(absoluteRows);
          data = absoluteRows;
        }
      }

      if (!streamEntries.length) {
        // Último recurso: cotejar en memoria por si season/episode vienen con otro tipo.
        console.log(`[Stream] Sigue sin fuente; cotejando la temporada ${season} en memoria para ${imdbId}`);
        const scanned = await runQuery(bySeeders(baseQuery(), SCAN_LIMIT), `temporada ${season} ${imdbId}`);
        if (scanned.error) {
          console.error('[Supabase] Error query temporada:', scanned.error.message || scanned.error.name || 'desconocido', scanned.error.details || '');
          return { streams: [] };
        }
        const scannedRows = Array.isArray(scanned.data) ? scanned.data : [];
        const typedRows = scannedRows.filter(row => row && typeof row === 'object' &&
          (!row.type || sameContentFamily(row.type, type)));
        const sameSeason = typedRows.filter(row => toFiniteNumber(row.season) === season);
        const looseExact = sameSeason.filter(row => toFiniteNumber(row.episode) === episode);
        const absoluteExact = type === 'anime'
          ? typedRows.filter(row => toFiniteNumber(row.absolute_episode) === episode)
          : [];
        // Hay bases que guardan los episodios sin temporada (numeración
        // absoluta). En la temporada 1 absoluto y episodio coinciden, así que
        // solo ahí se acepta ese cotejo, y solo si no hubo uno exacto.
        const seasonlessExact = looseExact.length || absoluteExact.length || season !== 1 ? []
          : typedRows.filter(row => toFiniteNumber(row.season) === null && toFiniteNumber(row.episode) === episode);
        const selectedExact = looseExact.length ? looseExact : absoluteExact.length ? absoluteExact : seasonlessExact;
        const loosePack = selectedExact.length ? [] : sameSeason.filter(row => toFiniteNumber(row.episode) === null);
        // Sin pack de esa temporada, un pack de la serie completa (season y
        // episode nulos) sigue siendo mejor que no ofrecer nada: se etiqueta
        // como «SERIE COMPLETA» para que el usuario sepa qué descarga.
        const wholeSeriesPack = selectedExact.length || loosePack.length ? []
          : typedRows.filter(row => toFiniteNumber(row.season) === null && toFiniteNumber(row.episode) === null);
        const looseEntries = selectedExact.length
          ? mapRows(selectedExact)
          : loosePack.length
            ? mapRows(loosePack, season)
            : mapRows(wholeSeriesPack, null, true);
        if (looseEntries.length) {
          data = selectedExact.length ? selectedExact : loosePack.length ? loosePack : wholeSeriesPack;
          streamEntries = looseEntries;
          const source = looseExact.length ? 'episodio exacto'
            : absoluteExact.length ? 'episodio absoluto'
              : seasonlessExact.length ? 'episodio sin temporada'
                : loosePack.length ? 'pack de temporada' : 'pack de serie completa';
          console.log(`[Stream] Recuperadas ${looseEntries.length} fuentes cotejando en memoria (${source})`);
        }
      }
    } else {
      const result = await runQuery(bySeeders(baseQuery(), CANDIDATE_LIMIT), `consulta ${imdbId}`);
      if (result.error) {
        const error = result.error;
        console.error('[Supabase] Error query:', error.message || error.name || 'desconocido', error.details || '');
        return { streams: [] };
      }
      data = Array.isArray(result.data) ? result.data : [];
      streamEntries = mapRows(data);
    }

    if (!streamEntries.length) {
      console.log(`[Stream] Sin fuentes válidas para ${imdbId}${isSeries ? ` S:${season} E:${episode}` : ''}`);
      return { streams: [], cacheMaxAge: 60 };
    }
    console.log(`[Stream] ${data.length} filas procesadas para ${imdbId} en ${Date.now() - start}ms`);

    // Calcula la puntuación una sola vez antes de ordenar. El comparador puede
    // ejecutarse decenas de veces; precomputarla evita repetir detección de
    // codec/HDR/audio/formato para cada comparación.
    for (const entry of streamEntries) entry.rankingScore = metadataScore(entry);
    streamEntries.sort(compareStreamEntries);
    const seen = new Set();
    const dedupedEntries = streamEntries.filter(entry => {
      const key = `${entry.infoHash}:${entry.fileIdx ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Una fuente sin seeders puede tardar minutos en fallar: solo se ofrecen
    // como últimos recursos cuando no hay suficientes fuentes vivas para
    // llenar la lista. Con 25 opciones con pares, las muertas no aportan.
    const healthyEntries = dedupedEntries.filter(entry => entry.seeders > 0);
    const uniqueEntries = healthyEntries.length >= MAX_STREAMS ? healthyEntries : dedupedEntries;

    // Selección de streams: se prioriza el mejor candidato en español
    // (ESP/LAT/CAST) y el mejor en inglés como opciones principales. Si no
    // se encuentra ningún español, DUAL se usa como fallback. Después se
    // añaden el resto de candidatos (incluidos VOSE, VOST, SUB y N/D) hasta
    // el límite global para dar más opciones al usuario, manteniendo el
    // orden por salud/calidad/seeders.
    const selected = new Set();
    const bestByLanguage = [];
    let spanishSelected = false;
    let englishSelected = false;

    // 1. Mejor fuente en español
    const spanishEntry = uniqueEntries.find(entry =>
      ['ESP', 'LAT', 'CAST'].includes(entry.langTag)
    );
    if (spanishEntry) {
      bestByLanguage.push(spanishEntry);
      selected.add(spanishEntry);
      spanishSelected = true;
    }

    // 2. Mejor fuente en inglés
    const englishEntry = uniqueEntries.find(entry => entry.langTag === 'ENG');
    if (englishEntry) {
      bestByLanguage.push(englishEntry);
      selected.add(englishEntry);
      englishSelected = true;
    }

    // 3. Si no hay español, DUAL ocupa su lugar como fallback
    if (!spanishSelected) {
      const dualEntry = uniqueEntries.find(entry => entry.langTag === 'DUAL');
      if (dualEntry) {
        bestByLanguage.unshift(dualEntry);
        selected.add(dualEntry);
      }
    }

    // 4. Rellenar con el resto de fuentes, en orden, hasta MAX_STREAMS
    for (const entry of uniqueEntries) {
      if (bestByLanguage.length >= MAX_STREAMS) break;
      if (selected.has(entry)) continue;
      bestByLanguage.push(entry);
      selected.add(entry);
    }

    const streams = bestByLanguage.slice(0, MAX_STREAMS).map(entry => buildStreamEntry(
      entry.sourceRow, entry.infoHash, extractTrackersFromMagnet(entry.magnet), entry.imdbId,
      entry.magnetTitle, entry.seasonPack, entry.season, entry.seriesPack
    ).stream);

    console.log(`[Stream] → Enviando ${streams.length} streams válidos`);
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
  maxEntries = 250,
  now = Date.now,
  keepAlive = discardInBackground,
  retryDelay = 15000,
  failureCooldown
} = {}) {
  const cooldownMs = Number.isFinite(failureCooldown) ? failureCooldown : retryDelay;
  const REFRESH_LOCK_MS = 30000;
  const cache = new Map();
  // Solo guardamos marcas de tiempo, nunca promesas: en Workers una promesa creada
  // en una request no debe esperarse desde otra ("Cannot perform I/O on behalf of
  // a different request") y puede quedar colgada si la primera se cancela.
  const refreshing = new Map();
  const failureUntil = new Map();

  function markFailure(key) {
    failureUntil.set(key, now() + cooldownMs);
    while (failureUntil.size > maxEntries) failureUntil.delete(failureUntil.keys().next().value);
  }

  async function load(key, args, previous) {
    try {
      const value = await handler(args);
      if (value.cacheMaxAge > 0) {
        const expires = now() + value.cacheMaxAge * 1000;
        const staleSeconds = value.streams?.length ? Math.min(value.staleRevalidate || 0, 600) : 0;
        cache.delete(key);
        cache.set(key, {
          value: structuredClone(value),
          expires,
          staleUntil: expires + staleSeconds * 1000,
          retryAt: 0
        });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        failureUntil.delete(key);
      } else {
        if (previous) previous.retryAt = now() + retryDelay;
        markFailure(key);
      }
      return value;
    } catch (error) {
      if (previous) previous.retryAt = now() + retryDelay;
      markFailure(key);
      throw error;
    }
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
      value.cacheMaxAge = Math.max(0, Math.floor((hit.expires - time) / 1000));
      value.staleRevalidate = Math.max(0, Math.floor((hit.staleUntil - Math.max(time, hit.expires)) / 1000));
      if (Number.isInteger(value.staleError)) value.staleError = value.staleRevalidate;

      const lockedAt = refreshing.get(key);
      const locked = lockedAt !== undefined && time - lockedAt < REFRESH_LOCK_MS;
      if (hit.expires <= time && hit.retryAt <= time && !locked) {
        refreshing.set(key, time);
        requestKeepAlive(
          load(key, args, hit).catch(() => {}).finally(() => refreshing.delete(key))
        );
      }
      return value;
    }

    cache.delete(key);
    const failedUntil = failureUntil.get(key);
    if (failedUntil !== undefined) {
      if (failedUntil > time) return { streams: [] };
      failureUntil.delete(key);
    }
    return structuredClone(await load(key, args));
  };
}
// Singleton compartido: la interfaz del SDK y el Worker usan la misma caché.
const cachedStreamHandler = createCachedStreamHandler(streamHandler);

// El catálogo tiene un tipo de stream directo (tv) y conserva el handler
// existente de IMDb para películas, series y anime.
async function streamResourceHandler(args, requestKeepAlive = discardInBackground) {
  if (args?.type === 'tv') return tvStreamHandler(args);
  return cachedStreamHandler(args, requestKeepAlive);
}

builder.defineCatalogHandler(tvCatalogHandler);
builder.defineMetaHandler(tvMetaHandler);
builder.defineStreamHandler(streamResourceHandler);

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

// Antes de calidad, se separan las fuentes con al menos cinco seeders de las
// que tienen pocos o ninguno: una opción muy alta pero casi sin pares no debe
// encabezar una fuente 1080p mucho más disponible. El hash fija el orden final.
const HEALTHY_SEEDERS = 5;
const healthTier = seeders => seeders >= HEALTHY_SEEDERS ? 2 : seeders > 0 ? 1 : 0;

function numericNonNegative(value) {
  const number = toFiniteNumber(value);
  return number === null || number < 0 ? 0 : number;
}

const QUALITY_WEIGHT = {
  '8K': 100, '4K': 90, '1440p': 80, '1080p': 70,
  '720p': 55, '576p': 40, '480p': 30, '360p': 20
};

// Puntuación secundaria para metadatos que no cambian la resolución, pero sí
// ayudan a elegir una fuente reproducible cuando dos releases son equivalentes.
// Los formatos de baja calidad (CAM, TS, HDCAM) se penalizan explícitamente
// para que cualquier release digital les gane aunque tengan misma resolución.
const FORMAT_TOKENS = Object.freeze({
  'web-dl': 7, 'webdl': 7, 'web rip': 6, 'webrip': 6, 'bluray': 6, 'bdrip': 5,
  'brrip': 5, 'web': 4, 'hdtv': 4, 'hdrip': 3, 'dvdrip': 2, 'remux': 8
});
// La calidad baja se busca por palabra completa: «Torrents» no es «TS» ni
// «Webcam» es «CAM», así que el nombre de un sitio o de un documental no
// penaliza una fuente buena.
const LOW_QUALITY_PENALTIES = Object.freeze({
  'cam': -15, 'hdcam': -12, 'webcam': -12, 'ts': -10, 'hdts': -9, 'telesync': -10,
  'tc': -8, 'telecine': -8, 'screener': -4, 'dvdscr': -4, 'r5': -4, 'workprint': -10
});
const LOW_QUALITY_PATTERN = new RegExp(
  `(?<![a-z0-9])(${Object.keys(LOW_QUALITY_PENALTIES).map(escapeRegExp).join('|')})(?![a-z0-9])`, 'g'
);
const CODEC_WEIGHT = { av1: 8, hevc: 7, h265: 7, x265: 7, h264: 5, x264: 5, vp9: 4 };
const HDR_WEIGHT = { 'dolby vision': 8, dolbyvision: 8, 'dv': 7, 'hdr10+': 7, hdr10: 6, hdr: 5, sdr: 0 };

function textLower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function metadataScore(entry) {
  const row = entry?.row || {};
  const combinedText = [row.release_name, row.title, row.name, row.quality, row.source, row.format]
    .filter(Boolean).join(' ').toLowerCase();
  const resolutionScore = QUALITY_WEIGHT[entry.resolution] ?? 0;
  const langScore = LANGUAGE_WEIGHT[entry.langTag] ?? 0;
  const codec = textLower(row.codec || row.video_codec) + ' ' + combinedText;
  const hdr = textLower(row.hdr_format || row.hdr) + ' ' + combinedText;
  const codecScore = Object.entries(CODEC_WEIGHT).reduce((best, [token, weight]) =>
    codec.includes(token) ? Math.max(best, weight) : best, 0);
  const hdrScore = Object.entries(HDR_WEIGHT).reduce((best, [token, weight]) =>
    hdr.includes(token) ? Math.max(best, weight) : best, 0);
  const audioText = textLower(Array.isArray(row.audio) ? row.audio.join(' ') : row.audio) + ' ' + combinedText;
  const audioScore = /atmos|truehd|dts-hd|dts:x/.test(audioText) ? 5 :
    /dts(?!-?hd)/.test(audioText) ? 4 :
    /aac|ac3|eac3|ddp|dolby/.test(audioText) ? 3 : 0;
  const subtitleScore = (row.subtitles || row.subs || /subb?ed|subs\b|\bsub\b/.test(combinedText)) ? 1 : 0;
  // Se busca el formato en todo el nombre del release, no solo en columnas
  // específicas: muchas fuentes etiquetan WEB-DL/CAM directamente en el título.
  const formatText = combinedText;
  let formatScore = 0;
  for (const [token, weight] of Object.entries(FORMAT_TOKENS)) {
    if (formatText.includes(token)) formatScore = Math.max(formatScore, weight);
  }
  let qualityPenalty = 0;
  for (const match of formatText.match(LOW_QUALITY_PATTERN) || []) {
    const penalty = LOW_QUALITY_PENALTIES[match];
    if (penalty !== undefined) qualityPenalty = Math.min(qualityPenalty, penalty);
  }
  // Bonificación por ediciones especiales (Remux/IMAX/Extended)
  const editionBonus = /\bremux\b/.test(formatText) ? 3 :
    /\bimax\b|\bextended\b|director'?s/.test(formatText) ? 2 : 0;
  // Pequeña penalización para 3D si el usuario busca 2D (no excluyente, solo desempata)
  const threeDPenalty = /\b3d\b|hsbs|hou|\bsbs\b/.test(formatText) ? -1 : 0;
  const seedScore = Math.min(numericNonNegative(entry.seeders), 50);
  // Los leechers solo se usan como desempate en el comparador (menos leechers
  // primero, desconocidos al final), no en la puntuación de metadatos: su
  // impacto es transitorio y no refleja calidad intrínseca del release.
  return resolutionScore + langScore + codecScore + hdrScore + audioScore +
    subtitleScore + formatScore + qualityPenalty + editionBonus + threeDPenalty +
    seedScore * 0.4;
}

function compareStreamEntries(a, b) {
  // La disponibilidad sigue siendo un filtro duro: una fuente sin pares no
  // debe desplazar una fuente saludable solo por tener más resolución.
  const health = healthTier(b.seeders) - healthTier(a.seeders);
  if (health !== 0) return health;

  const scoreDiff = (b.rankingScore ?? metadataScore(b)) - (a.rankingScore ?? metadataScore(a));
  if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;

  const seederDiff = b.seeders - a.seeders;
  if (seederDiff !== 0) return seederDiff;
  if (a.leecherCount !== b.leecherCount) {
    // Valores desconocidos van al final; entre dos valores conocidos gana
    // el que tiene MENOS leechers (menos cola para descargar).
    if (a.leecherCount === null) return 1;
    if (b.leecherCount === null) return -1;
    return a.leecherCount - b.leecherCount;
  }
  if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.infoHash < b.infoHash ? -1 : a.infoHash > b.infoHash ? 1 : 0;
}

function streamFileIndex(row) {
  const raw = row.file_index ?? row.file_idx ?? row.fileIndex ?? row.fileIdx;
  const numeric = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

// seasonPack: número de temporada cuando la fila es un pack completo en vez
// del episodio exacto (se etiqueta para que el usuario sepa qué descarga).
// seriesPack: la fila es un pack de la serie entera (season/episode nulos).
function buildStreamEntry(row, infoHash, magnetTrackers = [], imdbId = '', magnetTitle = null, seasonPack = null, season = null, seriesPack = false) {
  const metadata = { ...row, name: row.name || magnetTitle };
  const combinedText = [row.release_name, row.title, row.name, magnetTitle, row.quality, row.source, row.format]
    .filter(Boolean).join(' ');
  const langTag = getLanguageTag(metadata);
  const resolution = getResolutionTag(metadata);
  const sizeGB = formatSizeGB(row);
  const sizeBytes = parseSizeBytes(row);
  const seeders = Math.max(0, parseCount(row.seeders ?? row.seeds ?? row.seed) ?? 0);
  const leecherCount = parseCount(row.leechers ?? row.leechs ?? row.peers);

  // Detectar etiquetas técnicas desde el nombre completo del release
  const hdrTags = cleanHdrTags(detectTags(combinedText, HDR_TAGS));
  const audioTags = detectTags(combinedText, AUDIO_TAGS);
  const codecTags = detectTags(combinedText, VIDEO_CODEC_TAGS);
  const editionTags = detectTags(combinedText, EDITION_TAGS);
  const warningTags = detectTags(combinedText, WARNING_TAGS);

  const audio = sanitizeOneLine(row.audio || row.language || row.lang) ||
    (audioTags.length ? audioTags.join(' · ') : 'No indicado');
  const subs = sanitizeOneLine(row.subtitles || row.subs);
  const rawTitle = row.title || row.release_name || row.name || magnetTitle || '';
  const titleDisplay = sanitizeOneLine(rawTitle) || 'Sin título';
  const codec = codecTags.length ? codecTags.join('/') :
    (sanitizeOneLine(row.codec || row.video_codec) || '—');
  const group = sanitizeOneLine(row.release_group || row.group || row.team) || '—';
  const quality = sanitizeOneLine(row.quality) || resolution;

  // Badges técnicos que se añaden al nombre corto cuando están presentes
  const badgeSuffix = [
    ...warningTags.slice(0, 1),
    ...hdrTags.slice(0, 1),
    ...editionTags.slice(0, warningTags.length ? 1 : 2)
  ].filter(Boolean).join(' · ');

  // name: cabecera corta visible en lista
  const packLabel = seriesPack ? 'SERIE COMPLETA' : seasonPack !== null ? `PACK T${seasonPack}` : '';
  const nameParts = [`[${langTag}] ${resolution}`];
  if (badgeSuffix) nameParts.push(badgeSuffix);
  if (packLabel) nameParts.push(packLabel);
  const name = `Nexo Play\n${nameParts.join(' · ')}`;

  // title: multilínea con detalles (Stremio lo muestra al hacer hover)
  const techBadges = [...hdrTags, ...codecTags.length ? [codec] : []].join(' · ');
  const titleLines = [
    `🎬 ${titleDisplay}`,
    ...(warningTags.length ? [`🚨 Calidad: ${warningTags.join(' · ')}`] : []),
    ...(editionTags.length ? [`🏷️ Edición: ${editionTags.join(' · ')}`] : []),
    ...(seriesPack ? ['🗂️ Pack de la serie completa (elige temporada y episodio al reproducir)']
      : seasonPack !== null ? [`🗂️ Pack de la temporada ${seasonPack} completa (elige el episodio al reproducir)`] : []),
    `🔊 Audio: ${audio}${audioTags.length ? ` (${audioTags.join('/')})` : ''}`,
    `📝 Subs: ${subs || 'No indicados'}${techBadges ? `  |  ⚡ ${techBadges}` : ''}`,
    `💾 Tamaño: ${sizeGB} GB`,
    `👥 Seeders: ${seeders}  |  🌱 Leechers: ${leecherCount ?? '—'}`,
    ...(seeders > 0 ? [] : ['⚠️ Sin seeders ahora mismo: puede que no se pueda reproducir']),
    `📦 Grupo: ${group}  |  ⭐ Calidad: ${quality}`
  ];

  // Trackers del torrent: los del magnet original más los de la columna
  // trackers, con fallback a trackers públicos de alta disponibilidad.
  const trackers = buildTrackers(row.trackers, magnetTrackers);

  const fileIdx = streamFileIndex(row);

  // Identifica título + temporada + calidad + idioma: la reproducción continua
  // solo agrupa episodios de la misma temporada y nunca títulos distintos, así
  // Stremio no encadena un 1080p con un 4K. Los packs llevan su propia marca
  // para que «siguiente episodio» no salte a un pack de temporada completa.
  const seasonKey = seriesPack ? 'allpack' : seasonPack !== null ? `s${seasonPack}pack`
    : season === null ? 'movie' : `s${season}`;

  const stream = {
    name,
    title: titleLines.join('\n'),
    infoHash: infoHash.toLowerCase(),
    ...(fileIdx !== undefined ? { fileIdx } : {}),
    behaviorHints: {
      bingeGroup: `nexo-play|${imdbId}|${seasonKey}|${resolution.toLowerCase()}-${langTag.toLowerCase()}`,
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
    infoHash: infoHash.toLowerCase(),
    row: metadata
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

module.exports.helpers = { numericNonNegative, debugEnabled, metadataScore, parseCount, sameContentFamily, parseTrackerList, parseStremioId, getLanguageTag, getResolutionTag, detectLanguageTag, formatSizeGB, parseSizeBytes, extractInfoHashFromMagnet, extractTrackersFromMagnet, extractTitleFromMagnet, sanitizeOneLine, buildStreamEntry, compareStreamEntries, streamHandler, createCachedStreamHandler, cachedStreamHandler, streamResourceHandler, tvChannelId, normalizeTVChannel, buildTVChannelMeta, canonicalTVContentType, channelContentType, countryCodeFromValue, countryNameFromValue, channelMatchesTVGenre, tvGenreOptions, tvGenreOptionsFromRows, tvCatalogOptions, tvCatalogDefinitions, resetTVGenreOptionsCache, fetchTVChannelRows, tvChannelColumns, resetTVChannelRowsCache, findTVChannelById, tvCatalogHandler, tvMetaHandler, tvStreamHandler, getSupabaseClient, configure, configStatus, normalizeSupabaseUrl, cleanEnvValue, torrentColumns };
