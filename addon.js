/**
 * Torrents Español HD - Stremio Addon
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
  version: '1.0.0',
  name: 'Torrents Español HD',
  description: 'Catálogo y buscador de torrents filtrados estrictamente en Español Castellano, Español Latino, Dual y Subtitulado en Español directamente desde Supabase.',
  icon: 'https://cdn-icons-png.flaticon.com/512/3172/3172520.png',
  background: 'https://dl.strem.io/bg.jpg',
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
  if (!id || typeof id !== 'string') return { imdbId: null, season: null, episode: null };
  
  const parts = id.split(':');
  const imdbId = parts[0];
  
  // Validación básica IMDB
  if (!/^tt\d{7,8}$/.test(imdbId)) {
    console.warn(`[Addon] ID no estándar: ${id}`);
  }

  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;

  return {
    imdbId,
    season: Number.isNaN(season) ? null : season,
    episode: Number.isNaN(episode) ? null : episode
  };
}

function isValidInfoHash(hash) {
  return typeof hash === 'string' && /^[a-fA-F0-9]{40}$/.test(hash.trim());
}

function extractInfoHashFromMagnet(magnetUrl) {
  if (!magnetUrl || typeof magnetUrl !== 'string') return null;
  const match = magnetUrl.match(/btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

function formatSizeGB(row) {
  // Prioriza size_bytes, luego size (bytes), luego size string, luego size_gb
  if (row.size_bytes) {
    return (Number(row.size_bytes) / 1024 / 1024 / 1024).toFixed(2);
  }
  if (row.size && !isNaN(Number(row.size)) && Number(row.size) > 1024) {
    // Asumimos bytes si es número grande
    return (Number(row.size) / 1024 / 1024 / 1024).toFixed(2);
  }
  if (row.size_gb) return Number(row.size_gb).toFixed(2);
  if (typeof row.size === 'string' && row.size.toLowerCase().includes('gb')) {
    return row.size.replace(/[^0-9.]/g, '') || '—';
  }
  if (typeof row.size === 'string' && row.size.toLowerCase().includes('mb')) {
    const mb = parseFloat(row.size);
    return (mb / 1024).toFixed(2);
  }
  return '—';
}

function getLanguageTag(row) {
  // Normaliza audio/lenguaje a etiquetas cortas para el `name`
  const audio = `${row.audio || ''} ${row.language || ''} ${row.lang || ''}`.toLowerCase();
  const title = `${row.title || row.release_name || ''}`.toLowerCase();
  const combined = audio + ' ' + title;

  // DUAL debe evaluarse primero (contiene 'cast' y 'lat')
  if (combined.includes('dual') || (combined.includes('cast') && combined.includes('lat'))) return 'DUAL';
  if (combined.includes('castellano') || combined.includes('cast ')) return 'CAST';
  if (combined.includes('latino') || combined.includes('lat ')) return 'LAT';
  if (combined.includes('subtitulado') || combined.includes('subs') || combined.includes('vose') || combined.includes('vos ')) return 'VOSE';
  if (combined.includes('esp') || combined.includes('español') || combined.includes('spanish')) return 'ESP';
  return 'ESP';
}

function getResolutionTag(row) {
  const str = `${row.resolution || row.quality || row.release_name || row.title || row.name || ''}`.toLowerCase();
  if (str.includes('2160') || str.includes('4k') || str.includes('uhd')) return '4K';
  if (str.includes('1080')) return '1080p';
  if (str.includes('720')) return '720p';
  if (str.includes('480')) return '480p';
  return row.quality || row.resolution || 'HD';
}

// ---------------------------------------------------------------------------
// 4. STREAM HANDLER - Lógica principal
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id }) => {
  const start = Date.now();
  console.log(`[Stream] → type=${type} id=${id}`);

  try {
    // Validación inicial
    if (!id || !type) {
      console.warn('[Stream] Parámetros faltantes');
      return { streams: [] };
    }

    const { imdbId, season, episode } = parseStremioId(id);

    if (!imdbId || !imdbId.startsWith('tt')) {
      console.warn(`[Stream] imdbId inválido: ${imdbId}`);
      return { streams: [] };
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      console.error('[Stream] Supabase no configurado - revisa SUPABASE_URL / KEY');
      return { streams: [] };
    }
    // Construcción de query
    let query = supabase
      .from('torrents')
      .select('*')
      .eq('imdb_id', imdbId)
      .order('seeders', { ascending: false })
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

    const { data, error } = await query;

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
          // Si no hay infoHash válido pero hay magnetUrl, usar `url` en vez de infoHash
          // Stremio soporta ambos. Preferimos infoHash pero damos fallback.
          const magnetUrl = row.magnet_url || row.magnetUrl || row.magnet || null;
          if (magnetUrl && magnetUrl.startsWith('magnet:')) {
            // Retornar stream con url (no infoHash)
            return buildStreamWithUrl(row, magnetUrl);
          }
          console.warn(`[Stream] Fila sin infoHash válido descartada: ${row.title || row.release_name}`);
          return null;
        }

        return buildStream(row, infoHash);
      })
      .filter(Boolean);

    console.log(`[Stream] → Enviando ${streams.length} streams válidos`);
    return { streams };

  } catch (err) {
    console.error('[Stream] Excepción no controlada:', err.message, err.stack?.slice(0, 500));
    return { streams: [] };
  }
});

// ---------------------------------------------------------------------------
// Formateadores de Stream
// ---------------------------------------------------------------------------
function buildStream(row, infoHash) {
  const langTag = getLanguageTag(row);
  const resolution = getResolutionTag(row);
  const sizeGB = formatSizeGB(row);
  const seeders = row.seeders ?? row.seed ?? 0;
  const audio = row.audio || row.language || 'Español';
  const subs = row.subtitles || row.subs || 'Español';
  const titleDisplay = row.title || row.release_name || row.name || 'Torrent Español';
  const codec = row.codec || row.video_codec || '—';
  const group = row.release_group || row.group || row.team || '—';
  const quality = row.quality || resolution;

  // name: cabecera corta visible en lista (máx ~30 chars)
  const name = `Torrents Español HD\n[${langTag}] ${resolution}`;

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
    behaviorHints: {
      bingeGroup: `torrents-es-${resolution.toLowerCase()}-${langTag.toLowerCase()}`,
      // Si tu tabla tiene edad/prioridad, úsala aquí
    },
    // Fuentes opcionales - Stremio las usa para complementar el magnet
    ...(sources ? { sources } : {})
  };
}

function buildStreamWithUrl(row, magnetUrl) {
  const langTag = getLanguageTag(row);
  const resolution = getResolutionTag(row);
  const sizeGB = formatSizeGB(row);
  const seeders = row.seeders ?? 0;

  return {
    name: `Torrents Español HD\n[${langTag}] ${resolution} (Magnet)`,
    title: [
      `🎬 ${row.title || row.release_name || 'Torrent Español'}`,
      `🔊 Audio: ${row.audio || 'Español'} | 📝 Subs: ${row.subtitles || 'Español'}`,
      `💾 Tamaño: ${sizeGB} GB`,
      `👥 Seeders: ${seeders}`,
      `🔗 Magnet Link`
    ].join('\n'),
    url: magnetUrl,
    behaviorHints: {
      bingeGroup: `torrents-es-magnet-${langTag.toLowerCase()}`
    }
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const addonInterface = builder.getInterface();
module.exports = addonInterface;
