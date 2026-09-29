# Historial de cambios

## 1.2.7 — 2026-09-29

**Descripción de la actualización:** Nexo Play puede desplegarse ahora en Cloudflare Workers sin abandonar Vercel. El objetivo es contener el consumo del plan gratuito de Vercel: Workers free incluye 100.000 solicitudes al día y ancho de banda sin coste adicional, sin arranques en frío.

- Nuevo `worker.mjs`: entrada para Cloudflare Workers con paridad de cabeceras respecto a `app.js` (CORS, 405/404, `no-store` en fallos de base de datos, `s-maxage` gemelo para el edge). El landing y los assets de `public/` se sirven como Static Assets, igual que el CDN de Vercel los entrega sin invocar la función.
- Caché de edge con la Cache API de Workers en lugar del `s-maxage` de Vercel; `x-nexo-cache: hit|miss` permite verificar aciertos en producción. El manejo del SDK se replica exactamente: se serializa la respuesta completa, incluidos los TTL internos.
- `addon.js` queda libre de plataforma: `setKeepAlive()` inyecta el `waitUntil` de cada plataforma (Vercel desde `api/index.js`, Workers desde `worker.mjs`, fire-and-forget en local y pruebas). El builder del SDK se importa por ruta directa para no arrastrar Express al bundle de Workers.
- El polyfill `ws` de Supabase Realtime solo se requiere en Node sin `WebSocket` nativo (Node <22); Vercel, Workers y navegadores usan el nativo.
- `wrangler.jsonc` con `nodejs_compat`, Static Assets y observabilidad; `public/_headers` replica las cabeceras públicas de `vercel.json`; `.dev.vars.example` para desarrollo local.
- Pruebas nuevas del worker (`test/worker.test.js`): manifiesto, salud, CORS, métodos, rutas 404, HEAD, hidratación de variables y caché de edge con caché simulada. La suite completa (34 pruebas) sigue en verde para Vercel y Workers.

No cambia la lógica de consultas ni el formato Stremio. Cambiar de hosting cambia la URL pública del addon: los usuarios deberán reinstalar con el enlace nuevo y la firma de stremio-addons.net corresponde al dominio verificado.

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
