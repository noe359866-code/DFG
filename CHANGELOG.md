# Historial de cambios

## 1.7.0 — 2026-10-04

**El catálogo de TV se ordena solo por tipo de contenido y por país:** los canales de `tv_channels` se clasifican a partir de la categoría y el país que ya declaran, y Stremio publica dos catálogos con sus desplegables de filtros.

- **Clasificación por tipo de contenido:** la categoría declarada (`category`, `genres`, `group_title`…) se agrupa en Noticias, Deportes, Películas, Series, Infantil, Documentales, Música, Cultura, Entretenimiento, Estilo de vida, Viajes, Tecnología, Religión, Compras y General, reconociendo alias en español e inglés por palabra completa y con prioridad para el alias más largo («Sports HD» → Deportes, «TV Shows» → Series, «Home Shopping» → Compras). Las categorías desconocidas se conservan tal cual y las vacías caen en «General»; no se modifica la base de datos.
- **Catálogo «Canales por país»:** nuevo catálogo `tv_channels_country` con el país como filtro. El país se resuelve desde `ES`, `ESP`, `es`, «España» o «Nicaragua» (con alias como `EEUU`, `UK` u `Holanda`) y se muestra con su nombre en español; `tv-countries.js` aporta la tabla ISO 3166-1 completa (250 países) sin dependencias ni peticiones externas.
- **Filtros descubiertos en la tabla:** el manifiesto publica solo los tipos y países que existen de verdad (hasta 80 por catálogo, tipos por número de canales y países en orden alfabético español), con listas de respaldo si la base no responde o el despliegue no tiene secretos. La consulta de descubrimiento se cachea diez minutos, con una hora de ventana obsoleta, se refresca en segundo plano y nunca bloquea el manifiesto más de 2,5 segundos.
- **Fichas y filtros coherentes:** `genres` en los metadatos pasa a ser el tipo de contenido y el país normalizados; `country` se muestra con su nombre en español; el filtro acepta el valor normalizado o el original de la tabla y sigue combinándose con `search` y `skip`.
- **Manifiesto:** un catálogo por dimensión («Canales de TV» y «Canales por país»), ambos con `genre` (con `options`), `search` y `skip`. Stremio guarda el manifiesto en caché, así que puede hacer falta quitar y volver a añadir el complemento para ver los catálogos nuevos.
- **Pruebas:** la clasificación de tipos y países, la agregación y caché de filtros, el catálogo por país y los filtros publicados en el manifiesto del Worker.
- **Versión sincronizada:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.7.0`.

## 1.6.2 — 2026-10-04

**Canales de TV en vivo desde Supabase:** el addon ahora publica un catálogo de televisión propio en Stremio, además de las fuentes existentes de películas, series y anime.

- **Catálogo y fichas:** declara el tipo `tv`, el catálogo «Canales de TV» y recursos para catálogo, metadatos y streams.
- **Tabla `public.tv_channels`:** mapea la estructura Supabase compartida (`id`, `name`, `slug`, `logo_url`, `stream_url`, `stream_type`, `category`, `country_code`, `is_active`); no realiza migraciones ni scraping.
- **Búsqueda y reproducción:** admite búsqueda, filtro de categoría y paginación; `hls`, `dash` y `custom` se ofrecen como streams directos, mientras `embed` se devuelve como enlace externo.
- **Caché y seguridad:** respuestas del catálogo, metadatos y streams se cachean en el edge cuando Supabase responde correctamente; se rechazan esquemas de URL no reproducibles. Para la clave ANON hace falta una política RLS SELECT en `tv_channels`.
- **Pruebas y documentación:** se añaden pruebas para el mapeo de filas, las rutas Fetch y la caché de filtros, y se documentan los campos reconocidos.
- **Versión sincronizada:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.6.2`.

## 1.6.1 — 2026-10-03

**La web deja de poder mostrar una versión que no es la suya:** la portada lee la versión del Worker que responde, avisa cuando se visita un Preview congelado y se documenta qué URL es la publicada.

- **Versión viva en la portada:** la insignia `STREMIO ADDON` y el rótulo `NOVEDADES ·` se rellenan desde `/health` del mismo dominio (una sola petición, `no-store`, con tolerancia a fallos: si no responde, el HTML conserva su valor). Una página servida por un Worker antiguo muestra su versión real, no la del archivo.
- **Aviso al abrir un Preview:** si el dominio tiene forma de Preview de Workers Builds (`<alias de rama>-nexo-player-app.…` o `<hash>-nexo-player-app.…`) y el despliegue no trae Supabase configurado, la portada muestra un aviso con el motivo (0 fuentes) y un enlace a la URL publicada. Antes, abrir por error la URL de una rama fusionada parecía «la web no se actualiza»: esas URLs son copias congeladas del commit que las generó.
- **Portada revalidada siempre:** `public/_headers` declara `Cache-Control: public, max-age=0, must-revalidate` en `/` (el comportamiento por defecto de Workers Static Assets, ahora explícito y documentado) para que el navegador revalide con ETag y no conserve el HTML anterior tras un despliegue. `/assets/` mantiene su día de caché.
- **`npm run check:live`:** nuevo `scripts/check-live.js`; lee `/health` y `/manifest.json` del dominio indicado (o `CHECK_LIVE_URL`, o la URL publicada por defecto), los compara con `package.json`, avisa cuando la URL es un Preview y termina con código 1 si el despliegue no responde o publica otra versión. Sirve para distinguir un despliegue atrasado de un problema de caché del navegador.
- **README:** nueva sección «URLs: la publicada y los Preview» con la URL publicada, la comprobación por `/health` y la nota de que la ficha de stremio-addons.net solo se refresca desde el panel de su mantenedor (su API pública es de solo lectura).
- **Pruebas:** seis pruebas nuevas cubren la resolución de la URL (`--url`, `CHECK_LIVE_URL`, valor por defecto, protocolo inválido), la detección del host de Preview, la comparación de versiones, el caso sin red (código 1) y las cabeceras de revalidación y la versión publicada en `public/`.
- **Versión:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.6.1`.

La consulta a Supabase y la selección de fuentes son las mismas de 1.6.0; este parche solo afecta a la portada, a las cabeceras de la portada, a las herramientas y a la documentación.

## 1.6.0 — 2026-10-03

**Mejoras de rendimiento, selección de streams y detección de calidad/idioma:** el addon clasifica mejor las fuentes, evita falsos positivos de idioma y penaliza lanzamientos de baja calidad.

- **Detección de idioma sin falsos positivos:** las palabras comunes en español ("es", "en") ya no se confunden con códigos ISO cuando aparecen rodeadas de espacios dentro de oraciones (ej: "El episodio es en HD" se detecta correctamente como sin idioma marcado). Los códigos en campos estructurados, etiquetas `[ES]` y variantes regionales (`es-ES`, `en-US`) siguen funcionando.
- **Detección de calidad en el título completo:** el formato de lanzamiento (WEB-DL, BluRay, WEBRip, HDTV, etc.) se busca en todo el nombre del release, no solo en columnas específicas. Se añade penalización explícita para fuentes de baja calidad: `CAM`, `HDCAM`, `TS`, `TeleSync`, `TC`, `TeleCine` y `Screener` quedan siempre por debajo de lanzamientos digitales o de disco de la misma resolución.
- **Selección de streams mejorada:** se priorizan siempre los dos mejores candidatos (mejor español, mejor inglés), con fallback automático a DUAL si no existe fuente en español puro. Después se añaden el resto de fuentes ordenadas por salud/calidad hasta el límite histórico de 25 resultados, manteniendo compatibilidad con el comportamiento anterior.
- **Desempate por leechers corregido:** entre dos fuentes de la misma calidad e idioma, se ordena primero la que tiene menos leechers (menos cola de descarga); las fuentes sin dato de leechers quedan al final del tramo.
- **Soporte completo para anime:** se mantiene la recuperación de episodios por `absolute_episode` cuando la numeración por temporada/episodio no coincide, sin romper la selección de streams para series y películas.
- **Ranking más eficiente:** la puntuación de cada fuente se calcula una sola vez antes del `sort`, evitando repetir el análisis de codec/HDR/audio/formato en cada comparación.
- **Logs de depuración opcionales:** los logs de flujo de nivel informativo quedan desactivados por defecto y se pueden activar con `DFG_DEBUG=1`; los avisos y errores operativos se mantienen.
- **Procesamiento estable:** se mantienen la validación de BTIH, saneamiento de texto, normalización de trackers, deduplicación por hash+archivo, reintentos transitorios y caché stale-while-revalidate.
- **Portada actualizada:** la página de instalación muestra la versión 1.6.0 y destaca las nuevas mejoras de selección y calidad.
- **Pruebas:** las 54 pruebas del suite pasan correctamente, incluyendo regresiones para detección de idioma, ranking de formatos, desempates, recuperación de episodios de anime y respuestas HTTP.
- **Versión:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.6.0`.

- **Detección de etiquetas técnicas avanzada:** se reconocen automáticamente Dolby Vision (DV), HDR10+, HDR10, HDR, codecs (AV1/HEVC/AVC/VP9), formatos de audio (Atmos, TrueHD, DTS-HD, DTS, DD+, DD, AAC, FLAC) y ediciones especiales (REMUX, 3D, Extended, Director's Cut, Unrated, IMAX) directamente desde el nombre del release, sin depender de columnas específicas.
- **Interfaz mejorada en la página de búsqueda:** las fuentes muestran badges de colores diferenciados para idioma, resolución, HDR y ediciones especiales; los detalles se organizan por líneas legibles y se añaden filtros para 8K, 1440p, 360p, VOST y SUB.
- **Advertencias de calidad baja:** releases CAM, HDCAM, Telesync (TS), Telecine (TC) y Screeners se marcan con una advertencia visible y se penalizan fuertemente en el ranking para que no aparezcan por encima de fuentes WEB-DL/BluRay incluso si tienen más seeders.
- **Etiquetas HDR limpias:** se evita redundancia mostrando "HDR" cuando ya está presente "DV" o "HDR10+", y "HDR10" cuando está "HDR10+".
- **Línea de audio mejorada:** se muestra el tipo de audio detectado (Atmos, DD+, DTS-HD...) junto con la descripción del audio para que el usuario sepa qué esperar antes de reproducir.
- **Badges en el nombre corto del stream:** la lista de Stremio ahora muestra el formato HDR o edición especial más relevante directamente en el encabezado del stream (ej: `[ESP] 4K · DV · REMUX`), ahorrando tener que abrir los detalles.
- **Detección de subtítulos desde el nombre del release:** se reconocen releases etiquetados como `SUBBED`, `SUBS` o `SUB` para indicar presencia de subtítulos cuando la columna de la base está vacía.
- **Bonificación de ranking para ediciones premium:** REMUX, IMAX y Extended reciben una ligera bonificación; 3D se penaliza levemente como desempate ya que la mayoría de usuarios busca versiones 2D.

No modifica el esquema de Supabase ni garantiza mayor velocidad de descarga P2P; la latencia real depende de Supabase, Cloudflare, red y disponibilidad de pares.

## 1.5.0 — 2026-09-29

**Mejora del procesado de datos:** las fuentes se ordenan por salud y calidad, se detecta más información de cada fila y un cotejo en memoria rescata episodios con tipos inconsistentes.

- **Orden de fuentes por salud y calidad:** primero se priorizan las fuentes con al menos cinco seeders; las de uno a cuatro seeders forman el tramo siguiente y las fuentes sin seeders quedan al final. Dentro de cada tramo se decide por resolución, idioma, seeders, leechers y tamaño, con el hash como desempate estable.
- **Más calidad detectada:** se reconocen 8K, 1440p, 576p, 360p y el entrelazado (`1080i`), con límites de palabra para que `14km` no se lea como 4K. Las resoluciones que la base declara sin altura reconocible (`WEBRip`, `HDTV`) conservan su texto, ya saneado, y pesan según la altura que digan.
- **El idioma se lee también en el nombre del release:** si la columna de audio solo trae algo genérico como `Dolby Digital`, antes la fila quedaba como `N/D`; ahora se consulta el nombre, que es donde sí está el idioma. Aparecen además las etiquetas `VOST` (audio foreign con subs) y `SUB`, y `Latinoamérica`/`latam` se leen como `LAT`.
- **Tamaños con una sola fuente de verdad:** el texto visible y `videoSize` salen del mismo cálculo, que acepta las tres columnas de la tabla, decimales con coma o punto y unidades de B a TB. Se distingue "tamaño cero" de "tamaño ausente": el cero se muestra y no se anuncia como pista de vídeo.
- **Menos consultas de series/anime:** el episodio exacto y los packs de temporada (`episode` NULL) se buscan en una sola consulta. Si ninguna fila trae un torrent válido, se releen hasta 50 filas y se coteja en memoria; así se recuperan `season`/`episode` almacenados como texto y packs con `episode` vacío, sin ofrecer otro episodio por error.
- **Texto de la base saneado:** se eliminan los caracteres de control, invisibles y bidi que rompen la ficha, y el texto se acota a 300 caracteres para que una fila corrupta no convierta la respuesta en un payload enorme. Los trackers sin host (`udp://`, `udp://:80/announce`) o desmedidos se descartan en vez de viajar al cliente.
- **Más candidatos, misma respuesta:** la consulta trae hasta 50 filas en vez de 25, porque el orden final prioriza calidad y la base solo sabe ordenar por seeders; lo que sale al usuario se recorta aparte a 25 fuentes, ya deduplicadas por hash y archivo.
- `SUPABASE_TORRENT_COLUMNS` permite escoger de forma validada las columnas de `torrents`; el timeout por consulta baja a cuatro segundos. El cliente avisa si se configura `SERVICE_ROLE_KEY`, y `/health` solo informa si la clave está presente.
- La revalidación obsoleta del Worker se bloquea con marcas de tiempo, no con promesas compartidas entre requests; el endpoint de estáticos conserva respuestas `304` y `206` válidas.
- `bingeGroup` incluye la temporada (`nexo-play|<imdb>|s2|1080p-esp`), así la reproducción continua agrupa los episodios de una temporada sin mezclar otras. La ficha avisa cuando una fuente no tiene seeders.
- Nuevas pruebas de las tres notaciones de tamaño, el idioma en el release, las alturas nuevas, el saneado de texto, trackers sin host, salud de seeders y desempates, selección segura de columnas, consulta combinada y rescate en memoria, caché entre requests, endpoints estáticos `304`/`206` y `/health` sin revelar el tipo de clave.

No modifica la base de datos, el manifiesto público más allá de la versión ni garantiza mayor velocidad de descarga P2P.

## 1.4.0 — 2026-09-29

**Más contenido visible y despliegues a prueba de errores de configuración:** series que antes respondían vacío ofrecen ahora el pack de su temporada, los cortes de red puntuales se reintentan al instante y las variables de entorno se sanean y diagnostican solas.

- **Fallback a packs de temporada:** si una serie/anime no tiene el episodio exacto en la base, se consultan los packs de temporada completa (`episode` NULL) y se ofrecen etiquetados como `PACK T<temporada>` en el nombre, con una línea informativa en la descripción. Las películas nunca disparan esta segunda consulta.
- **Reintento de errores transitorios:** cada consulta a la base reintenta una vez (pausa de 300 ms) ante cortes de red, timeouts y 502/503/504. Los errores permanentes (JWT inválido, RLS, sintaxis) no se reintentan para no duplicar la espera; cada intento conserva su límite de ocho segundos y se registra su duración.
- **Entorno a prueba de copiar y pegar:** los valores de `SUPABASE_URL` y las claves se recortan de espacios, saltos de línea y comillas envolventes; los placeholders de `.env.example` / `.dev.vars.example` (`tu_clave_anon`, `xxxxxxxx…`) se descartan en vez de intentar conectar. La URL acepta pegarse sin `https://` o con barra final y se valida antes de crear el cliente.
- **`/health` con diagnóstico:** además de `status` y `version`, informa de `supabase.configured`, `supabase.url` (`ok` / `invalid` / `missing`) y `supabase.keyType` (`anon` / `service_role` / `none`), sin exponer jamás los valores. El aviso de configuración incompleta indica ahora exactamente qué variable falta o es inválida.
- Nuevas pruebas de saneamiento de entorno, normalización de URL, prioridad de `SERVICE_ROLE`, reintento transitorio único, no reintento de errores permanentes y fallback de packs (incluido que las películas nunca lo consultan) y del diagnóstico de `/health`.

No modifica la base de datos, el manifiesto público más allá de la versión ni garantiza mayor velocidad de descarga P2P.

## 1.3.0 — 2026-09-29

**Migración a Cloudflare Workers:** el complemento se despliega ahora en Workers; desaparecen Vercel, Express y los adaptadores de reescritura. Las respuestas y la lógica del addon no cambian.

- `worker.js` sustituye a la aplicación Express: mismas rutas (`/manifest.json`, `/stream/:type/:id.json`, `/health`, portada e imagen) sobre la API Fetch, con el mismo CORS, los mismos códigos y las mismas directivas de caché.
- `worker.mjs` es el punto de entrada ESM para Wrangler; `server.js` adapta ese mismo manejador al servidor HTTP de Node para `npm start`.
- `ctx.waitUntil` mantiene la actualización en segundo plano tras responder (antes `waitUntil` de `@vercel/functions`); el handler de streams acepta el keep-alive por llamada y conserva la misma caché en memoria.
- Workers Static Assets sirve `public/` desde el edge sin invocar el Worker y `public/_headers` declara un día de caché para `/assets/` más una semana de `stale-while-revalidate` y las cabeceras CORS; los archivos ausentes siguen cayendo a un 404 en JSON sin caché.
- Caché del edge con la Cache API de Cloudflare: claves normalizadas sin cadena de consulta para no fragmentar la caché por parámetros irrelevantes, solo `GET` con `200` y `s-maxage` explícito, y los fallos y `/health` en `no-store`; un `Cache-Control: no-store` del cliente obliga a regenerar.
- El manifiesto solo recibe `logo`/`icon` absolutos a partir del origen de la petición validado, nunca de cabeceras del cliente. Incluye **ETag** y devuelve `304 Not Modified` con `If-None-Match` (también desde la caché del edge), anuncia `max-age`/`s-maxage` de cinco minutos para navegadores y edge, `stale-while-revalidate` de una hora y `stale-if-error`; los streams añaden `stale-if-error` igual a su ventana obsoleta, y el preflight CORS memoriza un día con `Access-Control-Max-Age`. Las respuestas HTTPS añaden HSTS y los errores anuncian `no-store`.
- Tras un fallo de la base de datos en frío, el handler de streams no repite la consulta hasta quince segundos de cooldown (respuesta vacía sin caché, reintentos al expirar); en caliente sigue sirviendo las fuentes obsoletas mientras revalida. Evita martillar la base durante una caída sin prolongar la antigüedad máxima de las fuentes.
- La compresión la negocia el edge de Cloudflare; se retira el middleware gzip local y su prueba.
- El SDK de Stremio se importa por su módulo `builder` (valida el manifiesto igual que antes); se eliminan del bundle Express, `@vercel/functions` y `ws`, imprescindibles hasta ahora solo en Vercel/Node antiguos. Smart placement queda desactivado a propósito: el trabajo predomina en contenido cacheado con una sola consulta saliente.
- Secretos con `npx wrangler secret put` en producción y `.dev.vars` en local (también lo lee `npm start`); `wrangler.toml` fija `nodejs_compat`, el binding `ASSETS` y la observabilidad. Nuevas pruebas de la Cache API, `ctx.waitUntil`, ETag/304, claves normalizadas, cooldown de fallos y configuración de Supabase desde el entorno del Worker.

No modifica la base de datos, el manifiesto público más allá de la versión ni garantiza mayor velocidad de descarga P2P.

## 1.2.6 — 2026-09-28

**Entrega de fuentes más ágil a Stremio:** respuestas comprimidas, actualización de fuentes recientes sin bloquear la entrega y mayor resistencia a fallos temporales de la base de datos.

- Caché stale-while-revalidate en memoria: entrega fuentes conocidas durante hasta 600 segundos después de sus 120 segundos de frescura, mientras una sola consulta las actualiza. Vercel utiliza `waitUntil` para completar el trabajo tras responder.
- Los fallos de actualización no borran fuentes útiles ni prolongan su antigüedad máxima. Reintentos con pausa de 15 segundos; resultados vacíos confirmados reemplazan los anteriores y no se sirven caducados.
- Corrección de TTL: las respuestas desde memoria anuncian únicamente la frescura restante para evitar renovar artificialmente la caché del navegador o CDN.
- Compresión gzip/deflate negociada, nivel 4, sin cambiar el formato Stremio; clientes sin soporte siguen recibiendo JSON normal.
- Un solo análisis de URL por magnet al construir las fuentes.
- Respuestas de streams sin directivas de caché válidas usan `no-store`.
- Benchmark reproducible con datos simulados y pruebas de revalidación, fallo, caducidad y negociación HTTP.

No modifica la base de datos ni garantiza mayor velocidad de descarga P2P. Las mejoras deben medirse también en el despliegue real.

## 1.2.5 — 2026-09-29

**Descripción de la actualización:** Nexo Play incorpora un nuevo buscador web de fuentes por ID o enlace de IMDb, con filtros de idioma y calidad. Esta versión reduce consultas repetidas, agiliza la eliminación de duplicados y corrige la detección de idioma y resolución en títulos de enlaces magnet.

### Nuevas funciones
- Buscador en la página de instalación para películas, series y anime; selección de temporada y episodio, incluidos especiales (temporada cero).
- Filtros locales de idioma y calidad sin nuevas consultas al servidor, contador de fuentes y mensajes de carga, resultados vacíos y errores.
- Validación de enlaces IMDb, cancelación de búsquedas anteriores y límite de espera de doce segundos. Los metadatos se muestran como texto, nunca como HTML.

### Rendimiento y correcciones
- Caché en memoria por instancia, limitada a 250 respuestas: 120 segundos para resultados y 60 para búsquedas vacías. Las solicitudes simultáneas iguales comparten consulta; los fallos no se guardan.
- Eliminación de duplicados con `Set`, sin recorrer repetidamente toda la lista; conserva archivos diferentes del mismo torrent.
- El título del magnet también aporta idioma y calidad cuando faltan títulos en la fila. Textos como «14km» ya no se detectan como 4K.
- Pruebas de regresión para caducidad, concurrencia, aislamiento de respuestas, expulsión de caché y recuperación tras fallos.

El buscador no es un catálogo ni busca títulos por nombre. No se modifica el esquema de la base de datos. Las mejoras de rendimiento son de implementación; no se ha medido una aceleración en producción.

## 1.2.4 — 2026-09-28

### Optimización y Reproducción
- **Algoritmo de ordenación inteligente (Smart Ranking):** las opciones de reproducción ahora se ordenan de forma óptima para el usuario priorizando resolución (4K → 1080p → 720p → 480p), afinidad de idioma (DUAL → CAST → LAT → ESP → VOSE → ENG), cantidad de semillas (seeders) y tamaño.
- **Trackers de alta disponibilidad:** si el torrent o enlace magnet en la base no cuenta con trackers definidos, se inyectan automáticamente trackers públicos de alta tasa de éxito (`opentrackr`, `demonii`, `stealth.si`, etc.) para agilizar el descubrimiento de pares P2P y evitar que el reproductor quede en espera.
- **Hints avanzados de subtítulos y buffering (`behaviorHints`):** cada stream incluye ahora `filename` (nombre sanitizado del archivo o título magnet) y `videoSize` (tamaño exacto en bytes) para que los complementos de subtítulos (como OpenSubtitles) sincronicen subtítulos precisos de forma automática.
- **Extracción de títulos desde magnets (`dn=`):** si un registro carece de título en la columna de texto pero viene con parámetro `dn` en el magnet, se aprovecha como nombre de release en vez de mostrar un título genérico.
- **Sanitización de cadenas y saltos de línea:** limpieza preventiva de caracteres invisibles y saltos de línea accidentales en metadatos para garantizar compatibilidad con interfaces de Stremio en Android TV, Web y Desktop.
- **Resiliencia en enlace de instalación web:** en entornos locales o sin protocolo seguro directo, el botón de añadir a Stremio mantiene el fallback URL en vez de romper el protocolo.
- Nuevas pruebas automatizadas para ordenación inteligente, hints de subtítulos y fallback de trackers.

## 1.2.3 — 2026-09-27

### Reproducción (torrents)
- Los trackers del magnet original (`tr=`) y los de la columna `trackers` viajan ahora en `sources` de cada stream, normalizados como fuentes `tracker:`, sin duplicados y con un máximo de diez: Stremio encuentra pares más rápido al iniciar la descarga.
- `bingeGroup` identifica el título (`imdb_id`), la calidad y el idioma: la reproducción continua solo agrupa episodios de la misma serie, nunca títulos distintos.

### Rendimiento
- La página de instalación y los archivos de `assets/` se sirven como archivos estáticos: el CDN de Vercel los entrega sin invocar la función serverless. La portada deja de consumir invocaciones con cada visita.
- `/assets/` anuncia un día de `Cache-Control` también en el edge (antes el día de caché solo aplicaba al navegador del visitante).
- `/manifest.json` se cachea cinco minutos en el edge con `stale-while-revalidate` de una hora: las oleadas de instalación tras una publicación en el catálogo no se traducen en una invocación por cada descarga.
- Los streams con resultados anuncian 120 segundos de caché más diez minutos de `stale-while-revalidate`, duplicados como `s-maxage`: el edge de Vercel sirve títulos populares sin invocar la función.
- Los títulos sin torrents en la base se cachean sesenta segundos; los fallos de base de datos siguen sin anunciar caché.
- La portada añade `theme-color`, botón y acceso al canal de soporte en Discord, y explica que las opciones de reproducción son torrents que Stremio reproduce por P2P; su versión mostrada se verifica contra el manifiesto en las pruebas.

## 1.2.2 — 2026-09-27

### Verificación
- El manifiesto público incluye `stremioAddonsConfig` con el emisor y la firma emitidos por stremio-addons.net. La configuración viaja en `/manifest.json` para todo el mundo, sin depender de archivos ni variables locales.

## 1.2.1 — 2026-09-27

### Identidad
- Nuevo nombre Nexo Play, adecuado para contenido en español e inglés.
- Descripción pública sin referencias a la base de datos o infraestructura.
- Imagen original generada con IA, alojada en el propio despliegue.
- Nueva página adaptable a móviles, con instalación y copia de enlace accesible.

### Correcciones
- Los archivos en inglés ya no se etiquetan por defecto como españoles.
- Audio, subtítulos y calidad desconocidos no se inventan.
- Validación estricta de IDs y episodios; soporte de temporada cero.
- Lectura de hashes BTIH base32 y hexadecimal, descarte de magnets inválidos.
- Eliminación de streams duplicados y respeto del índice de archivo.
- Tamaños con coma decimal, cero y valores inválidos.
- Rutas reescritas de Vercel, incluidos manifiesto, streams e imagen.
- Sin interpolar cabeceras HTTP en HTML o JavaScript.
- Recuperación cuando el navegador no permite copiar al portapapeles.

### Mantenimiento
- Aplicación HTTP compartida entre local y Vercel.
- Consultas con timeout de ocho segundos, nulos al final y caché HTTP de 120 segundos para resultados correctos.
- Actualización de dependencias vulnerables y dotenv disponible en producción.
- Diez pruebas automatizadas unitarias y HTTP.

Las pruebas utilizan datos simulados: la reproducción y la conexión con la base real requieren validación en el despliegue configurado.
