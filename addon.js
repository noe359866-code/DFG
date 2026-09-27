/**
 * Nexo Play - Stremio Addon
 * Lógica principal del addon: Manifest + Stream Handler
 * 
 * Diseñado para Vercel Serverless + Supabase (PostgreSQL)
 * NO hace scraping ni DDL. Solo consulta la tabla public.torrents
 */

const { addonBuilder } = require('stremio-addon-sdk');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// 1. MANIFEST - Especificación oficial Stremio
// ---------------------------------------------------------------------------
const manifest = {
  id: 'org.comunidad.torrents.espanol',
  version: '1.2.1',
  name: 'Nexo Play',
  description: 'Películas, series y anime en español e inglés. Encuentra opciones de reproducción con información de idioma y calidad, en un solo lugar.',
  resources: ['stream'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// 2. SUPABASE CLIENT - Singleton con cache
// ---------------------------------------------------------------------------
let supabaseClient = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Addon] ⚠️ Faltan variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }

  try {
    // Node <22 necesita polyfill ws para el Realtime client de Supabase
    // Aunque no usamos realtime, el SDK lo inicializa igual
    let wsTransport = undefined;
    try {
      wsTransport = require('ws');
    } catch (_) {
      // ws no instalado - en Vercel con Node 22+ no es necesario
    }

    const options = {
      auth: { persistSession: false, autoRefreshToken: false }
    };
    // Solo inyectamos transport si existe (evita el throw en Node 20)
    if (wsTransport) {
      options.global = { fetch: global.fetch };
      options.realtime = { transport: wsTransport };
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey, options);
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

function extractInfoHashFromMagnet(magnetUrl) {
  if (typeof magnetUrl !== 'string') return null;
  try {
    const url = new URL(magnetUrl);
    if (url.protocol !== 'magnet:') return null;
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
  if (str.includes('2160') || str.includes('4k') || str.includes('uhd')) return '4K';
  if (str.includes('1080')) return '1080p';
  if (str.includes('720')) return '720p';
  if (str.includes('480')) return '480p';
  return row.quality || row.resolution || 'N/D';
}

// ---------------------------------------------------------------------------
// 4. STREAM HANDLER - Lógica principal
// ---------------------------------------------------------------------------
async function streamHandler({ type, id }, clientFactory = getSupabaseClient) {
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
      return { streams: [] };
    }

    console.log(`[Stream] ${data.length} resultados para ${imdbId} en ${Date.now() - start}ms`);

    // Mapeo a formato Stremio
    const streams = data
      .map((row) => {
        // --- InfoHash con fallback a magnetUrl ---
        let infoHash = row.info_hash || row.infoHash || row.hash || null;
        if (infoHash) infoHash = infoHash.toString().trim().toLowerCase();
        
        if (!isValidInfoHash(infoHash)) {
          // Intentar extraer de magnet
          const magnet = row.magnet_url || row.magnetUrl || row.magnet || null;
          const extracted = extractInfoHashFromMagnet(magnet);
          if (extracted) infoHash = extracted;
        }

        if (!isValidInfoHash(infoHash)) {
          return null;
        }

        return buildStream(row, infoHash);
      })
      .filter(Boolean)
      .filter((stream, index, all) => all.findIndex(item => item.infoHash === stream.infoHash && item.fileIdx === stream.fileIdx) === index);

    console.log(`[Stream] → Enviando ${streams.length} streams válidos`);
    return { streams, cacheMaxAge: 120 };

  } catch (err) {
    console.error('[Stream] Excepción no controlada:', err.message, err.stack?.slice(0, 500));
    return { streams: [] };
  }
}
builder.defineStreamHandler(streamHandler);

// ---------------------------------------------------------------------------
// Formateadores de Stream
// ---------------------------------------------------------------------------
function buildStream(row, infoHash) {
  const langTag = getLanguageTag(row);
  const resolution = getResolutionTag(row);
  const sizeGB = formatSizeGB(row);
  const seeders = row.seeders ?? row.seed ?? 0;
  const audio = row.audio || row.language || row.lang || 'No indicado';
  const subs = row.subtitles || row.subs || 'No indicados';
  const titleDisplay = row.title || row.release_name || row.name || 'Sin título';
  const codec = row.codec || row.video_codec || '—';
  const group = row.release_group || row.group || row.team || '—';
  const quality = row.quality || resolution;

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

  // Fuentes alternativas para tracker (opcional pero ayuda)
  const sources = row.trackers ? 
    (Array.isArray(row.trackers) ? row.trackers : [row.trackers]) : 
    undefined;

  return {
    name,
    title: titleLines.join('\n'),
    infoHash: infoHash.toLowerCase(),
    ...(Number.isSafeInteger(row.file_idx ?? row.fileIdx) && (row.file_idx ?? row.fileIdx) >= 0 ? { fileIdx: row.file_idx ?? row.fileIdx } : {}),
    behaviorHints: {
      bingeGroup: `nexo-play-${resolution.toLowerCase()}-${langTag.toLowerCase()}`,
      // Si tu tabla tiene edad/prioridad, úsala aquí
    },
    // Fuentes opcionales - Stremio las usa para complementar el magnet
    ...(sources ? { sources } : {})
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const addonInterface = builder.getInterface();
module.exports = addonInterface;

module.exports.helpers = { parseStremioId, getLanguageTag, formatSizeGB, extractInfoHashFromMagnet, streamHandler };
