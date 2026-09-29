# Historial de cambios

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
