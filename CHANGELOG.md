# Historial de cambios

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
