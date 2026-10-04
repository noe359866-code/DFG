# Nexo Play · 1.6.4

![Nexo Play](public/assets/brand.png)

**Tu próxima historia, más cerca.** Películas, series y anime en español e inglés, junto con un catálogo de canales de TV en vivo clasificado **por tipo de contenido y por país**.

Complemento para Stremio con fuentes de reproducción en fichas compatibles y un catálogo propio de **Canales de TV**. Los canales se leen desde `public.tv_channels`; utiliza únicamente contenidos y enlaces que tengas derecho a reproducir.

## Novedades de 1.6.4

**Catálogo de Discover más ligero para evitar los 503 de Cloudflare por Error 1102 (CPU/memoria).**

- **Consulta reducida:** el esquema compartido selecciona por defecto solo los nueve campos necesarios para ID, nombre, logo, stream, tipo, categoría, país y estado, en lugar de traer todas las columnas de `tv_channels`. Si falta una columna seleccionada, se detecta el error y se conserva la compatibilidad con `SELECT *`; en un esquema distinto, configura `SUPABASE_TV_CHANNEL_COLUMNS` con sus columnas reales para mantener la consulta estrecha. La variable también permite añadir campos opcionales o definir literalmente `*` para solicitarlos todos (con mayor coste de respuesta/memoria).
- **Menos trabajo por catálogo:** sin filtros se ordenan los candidatos con datos mínimos y se validan URLs/logos únicamente para los 100 canales de la página devuelta. Con filtros se normalizan solo los campos de texto necesarios; los patrones de categoría se compilan una vez, no una vez por alias y canal.
- **Menos consultas repetidas:** resultados de `tv_channels` se conservan 30 segundos por isolate y, si Supabase falla, se pueden servir hasta diez minutos como respaldo; las peticiones frías simultáneas comparten una sola lectura a Supabase y el catálogo correcto se guarda en el edge durante cinco minutos.
- **Metadatos y streams de TV más baratos:** se busca el canal por el ID codificado sin normalizar ni ordenar toda la tabla; el descubrimiento de filtros tampoco analiza logos ni URLs.
- **Streams de torrents más ligeros:** se calculan ranking y deduplicación con candidatos pequeños; los títulos detallados, badges y trackers para Stremio se construyen solo para las 25 fuentes finales, sin cambiar el orden ni el límite de respuesta.
- **Caché del Worker:** las claves de catálogo ordenan sus parámetros para reutilizar la misma respuesta aunque cambie su orden; las peticiones `HEAD` aprovechan una respuesta `GET` ya cacheada sin volver a ejecutar el handler.
- **Portada renovada y ligera:** navegación más clara, diseño adaptable a móvil, pasos de instalación y consulta rápida con estado de carga accesible. El arte principal usa WebP optimizado (unos 28 KB) y no se añaden librerías ni fuentes externas; CSS/JS llevan versión en la URL para renovar la caché del navegador.
- **Límites reales de Cloudflare:** este cambio reduce uso de CPU, memoria y llamadas a Supabase en las rutas del catálogo; no altera los topes absolutos del plan ni puede impedir errores causados por límites externos.

## Novedades de 1.6.3

**Fuentes de películas, series y anime mejor seleccionadas:** menos listas de fuentes muertas, más recuperación de episodios y packs, y metadatos que entienden los formatos reales de la tabla.

- **Se descartan las fuentes muertas cuando sobran alternativas:** si hay al menos 25 fuentes con seeders, las de cero seeders no se ofrecen (antes podían ocupar media lista y hacer perder minutos en un intento que no arranca). Si hay pocas fuentes vivas, las muertas vuelven al final con su aviso «Sin seeders», para no dejar al usuario sin ninguna opción.
- **Packs de serie completa:** cuando el episodio exacto y el pack de temporada no existen, se rescata un pack de la serie entera (`season` y `episode` nulos) etiquetado como **SERIE COMPLETA**, en lugar de devolver «sin fuentes».
- **Episodios guardados sin temporada:** las bases que numeran en absoluto (`season` nulo) ya se recuperan en la temporada 1, donde absoluto y episodio coinciden; en otras temporadas se sigue exigiendo coincidencia y no se inventan episodios.
- **Los packs ya no se encadenan con los episodios:** cada pack (de temporada o de serie completa) lleva su propio `bingeGroup`, así «siguiente episodio» no salta a un pack que descargaría la temporada completa.
- **Anime y series intercambiables:** hay bases que etiquetan los títulos de anime como `series` (y al revés). En el cotejo de último recurso se aceptan las dos etiquetas entre sí, sin que una película pueda colarse; el resto de la consulta sigue filtrando por el tipo pedido.
- **Seeders y leechers como vengan:** se aceptan las columnas `seeders`/`seeds`/`seed` y `leechers`/`leechs`/`peers`, y notaciones compactas como «1.2k» o «3,5 mil». Un valor ilegible no inventa pares.
- **Trackers en cualquier formato:** la columna `trackers` puede ser un array, una lista separada por comas o saltos, o JSON serializado; se filtran las entradas que no son UDP/HTTP(s) y, si no queda ninguna usable, se usan los trackers públicos de respaldo.
- **Calidad baja detectada por palabra completa:** «Torrents.com» ya no se lee como `TS` ni «Webcam» como `CAM`; se reconocen además `HDTS`, `DVDScr`, `R5` y `Workprint`, y se suman `BDRip`, `HDRip` y `WEB` como formatos reproducibles.
- **VOSE y «V.O.»:** la versión original subtitulada se reconoce como VOSE en lugar de quedar como idioma indeterminado («Voz original» sigue siendo N/D).
- **Versión sincronizada:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.6.3`. Stremio guarda el manifiesto en caché: si acabas de actualizar y no ves «Canales por país» ni los filtros nuevos, quita y vuelve a añadir el complemento.

### Catálogo de TV (desde 1.6.2 y clasificado en 1.6.3)

- **Los canales se clasifican solos:** la categoría declarada en la tabla (`category`, `genres`, `group_title`…) se agrupa en tipos de contenido legibles —Noticias, Deportes, Películas, Series, Infantil, Documentales, Música, Cultura, Entretenimiento, Estilo de vida, Viajes, Tecnología, Religión, Compras y General— reconociendo alias en español e inglés («Sports HD» → Deportes, «TV Shows» → Series, «Dibujos animados» → Infantil). Las categorías que no se reconocen se respetan tal cual y las que vienen vacías caen en «General». No hay que tocar la base de datos.
- **Dos catálogos en Stremio:** «Canales de TV» filtra por tipo de contenido y «Canales por país» por país, cada uno con su desplegable de filtros y su búsqueda. Los valores salen de la propia tabla: se publican en el manifiesto los tipos y países que existen de verdad (hasta 80 de cada uno, los tipos ordenados por número de canales y los países alfabéticamente). Si la base no responde o el despliegue no tiene secretos, se anuncian listas de respaldo para que el filtro nunca aparezca vacío.
- **País en español y en cualquier formato:** `country_code` puede venir como `ES`, `ESP`, `es` o incluso «España»; todos se resuelven al mismo país y la ficha muestra «España», «Nicaragua» o «México» en lugar del código. La tabla ISO 3166 vive en `tv-countries.js` (250 países, sin dependencias ni llamadas externas).
- **Filtros combinables:** `search` sigue buscando por nombre, descripción, tipo, país e idioma, y el filtro admite tanto el tipo/catálogo normalizado como el valor original de la tabla (`genre=deportes` y `genre=Deportes HD` funcionan igual). La paginación (`skip`) se mantiene.
- **Filtros descubiertos con coste acotado:** la consulta que los descubre se cachea en memoria diez minutos (una hora de ventana obsoleta si la base falla) y el manifiesto se sigue sirviendo desde la caché del edge; la primera consulta espera como mucho 2,5 segundos y, a partir de ahí, el refresco ocurre en segundo plano sin bloquear el manifiesto.

## Novedades de 1.6.2

- **Catálogo de TV en vivo:** Stremio muestra un catálogo llamado «Canales de TV» leído desde la tabla `tv_channels` de Supabase. Cada elemento usa su nombre, logo, categoría y enlace de reproducción; permite búsqueda, filtro por género/categoría y paginación.
- **Reproducción:** los tipos `hls`, `dash` y `custom` devuelven `stream_url` como stream directo de tipo `tv`; `embed` aparece como enlace externo. También se exponen metadatos y se ocultan filas con `is_active=false`.
- **Esquema de Supabase:** compatible con la tabla `public.tv_channels` compartida: usa `id`, `name`, `slug`, `logo_url`, `stream_url`, `stream_type`, `category`, `country_code` e `is_active`.
- **Permisos de Supabase:** la clave `anon` necesita política RLS `SELECT` para las tablas `torrents` y `tv_channels`.
- **Versión sincronizada:** manifiesto, paquete y página anuncian `1.6.2`; puede ser necesario actualizar/reinstalar el complemento en Stremio para que descargue el catálogo del manifiesto nuevo.

## Novedades de 1.6.1

- **La portada muestra la versión viva:** la insignia del encabezado y el rótulo de novedades se rellenan desde `/health` del propio dominio, no desde una constante del HTML. Si el despliegue es antiguo, la página lo dice con la versión real en lugar de repetir el texto del archivo.
- **Aviso de Preview:** cuando el dominio es un Preview de Workers Builds (`<alias de rama>-nexo-player-app.…` o `<hash>-nexo-player-app.…`) o el despliegue no tiene Supabase configurado, la portada avisa de que la búsqueda devolverá 0 fuentes y enlaza la URL publicada. Los Preview son copias congeladas de una rama: nunca reciben los cambios de `main`.
- **Portada siempre revalidada:** `public/_headers` declara `Cache-Control: public, max-age=0, must-revalidate` en `/` (el valor por defecto de Workers Static Assets, ahora explícito): el navegador revalida con su ETag y no conserva la versión anterior tras un despliegue.
- **`npm run check:live`:** compara `/health` y `/manifest.json` de un despliegue con la versión de `package.json`, avisa si el dominio es un Preview y devuelve código 1 cuando la web no publica la versión del paquete.
- **Documentación de URLs:** la sección de despliegue separa la URL publicada de las URLs de Preview y explica cómo verificar la versión.
- **Versión sincronizada:** `package.json`, `package-lock.json`, manifiesto y página pública quedan en `1.6.1`.

No cambia la consulta a la base de datos ni la lógica de selección de fuentes: es la misma de 1.6.0.

## Novedades de 1.6.0

- **Detección de idioma más precisa:** acepta códigos ISO estructurados (`es`, `spa`, `en`, `eng`, `en-US`, etc.) en campos de idioma/audio sin convertir palabras normales de títulos en idiomas.
- **Más compatibilidad con datos importados:** procesa arrays de audio y campos alternativos como `languages`, `audio_language` y `original_language`.
- **Ranking de releases mejorado:** además de resolución, idioma, seeders, codec y HDR, considera formatos como WEB-DL, WEBRip, BluRay y HDTV como señal secundaria de calidad/reproducibilidad.
- **Procesamiento defensivo:** conserva la validación existente de hashes, magnets, tamaños, trackers, episodios y textos antes de generar streams.
- **Pruebas de regresión ampliadas:** cubren códigos ISO exactos, arrays de audio y el nuevo componente de ranking.
- **Versión sincronizada:** `package.json`, `package-lock.json` y el manifiesto publican `1.6.0`.

Las mejoras de ranking y procesamiento son deterministas; no garantizan una mayor velocidad de descarga P2P, que depende de la red, disponibilidad de pares y fuente.

## Novedades de 1.5.0

- **Menos consultas en series/anime:** episodio y pack de temporada se buscan juntos; solo si no hay una fuente válida se coteja una lectura más amplia en memoria.
- **Disponibilidad ponderada:** las fuentes con al menos cinco seeders se ordenan antes de las que tienen pocos, antes de comparar resolución e idioma.
- **SELECT configurable:** `SUPABASE_TORRENT_COLUMNS` permite limitar las columnas de la tabla (por defecto se leen todas); la lista se valida antes de enviarla a Supabase.
- **Más tolerante a Workers:** las consultas tienen un timeout de cuatro segundos y la revalidación obsoleta usa un bloqueo por marca de tiempo, sin compartir promesas de I/O entre requests.
- **Diagnóstico más discreto:** `/health` informa si hay una clave (`present`/`missing`), pero no expone si es anon o service role ni ningún valor secreto.

## Novedades de 1.3.0

- El complemento se despliega ahora en **Cloudflare Workers**: `worker.js` es la única capa HTTP (manifiesto, streams, salud y estáticos) sobre la API Fetch, sin Express ni adaptadores de Vercel.
- Los archivos de `public/` los sirve Workers Static Assets desde el edge sin invocar el Worker, con las cabeceras de `public/_headers` (`/assets/` anuncia un día de caché más una semana de `stale-while-revalidate`).
- Caché del edge con la Cache API de Cloudflare: claves normalizadas sin cadena de consulta para no fragmentar la caché, manifiesto cinco minutos (`max-age` para navegadores y `s-maxage` para el edge) con `stale-while-revalidate` de una hora y `stale-if-error` en streams; los fallos siguen en `no-store`.
- El manifiesto incluye **ETag**: los navegadores que repiten petición reciben `304 Not Modified` sin cuerpo. El preflight CORS se memoriza un día con `Access-Control-Max-Age`, y las respuestas HTTPS añaden HSTS.
- `ctx.waitUntil` mantiene la actualización de fuentes en segundo plano tras responder (antes `waitUntil` de Vercel). Tras un fallo de la base de datos no se repite la consulta hasta quince segundos de cooldown, sin martillar la base durante caídas. La compresión la negocia el propio edge de Cloudflare.
- La configuración secreta va en secrets de Workers (`wrangler secret put`) y, en local, en `.dev.vars` (también lo lee `npm start`); la observabilidad queda activada en el panel de Cloudflare y con `npm run tail`. `npm start` sigue ofreciendo el servidor de Node en el puerto 7000.

## Novedades de 1.2.6

- Entrega inmediata de fuentes recientes desde memoria mientras una única consulta las actualiza. Tras sus 120 segundos de frescura, se pueden servir durante un máximo adicional de 600 segundos; los resultados vacíos no se sirven caducados.
- Si una actualización falla, conserva las fuentes anteriores dentro de ese límite y espera 15 segundos antes del siguiente intento. No guarda el error como resultado.
- Compresión HTTP negociada (gzip/deflate) para reducir bytes transferidos, con compatibilidad para clientes sin compresión.
- Cada magnet se analiza una vez por fila. La caché HTTP recibe el tiempo de vida restante, no un plazo nuevo en cada lectura.

En Cloudflare Workers, `ctx.waitUntil` mantiene activa la actualización después de responder. La caché sigue siendo por instancia y se pierde con reinicios; una instancia nueva o un título nunca consultado debe esperar a la base de datos. Cada intento de consulta tiene un límite de cuatro segundos. Las revalidaciones obsoletas se bloquean por clave, pero las peticiones frías concurrentes mantienen su propio I/O para no esperar promesas creadas por otra request. No se hacen consultas anticipadas a episodios que el usuario no solicitó.

Ejecuta `npm run benchmark` para una medición **simulada** de consultas concurrentes, caché y compresión; no representa latencias de producción ni velocidad de reproducción P2P.

## Buscador incorporado en 1.2.5

Buscador web de fuentes por **ID o enlace de IMDb**, con filtros de idioma y calidad. Selecciona película, serie o anime; para episodios indica temporada y número de episodio (temporada cero para especiales). Consulta fuentes sin salir de la página y reprodúcelas desde Stremio. El catálogo independiente de canales de TV está disponible dentro de Stremio.

El parche reutiliza consultas recientes y simultáneas, elimina duplicados con menos trabajo y corrige metadatos obtenidos de enlaces magnet. No se promete una velocidad de reproducción: depende de la red y de los pares disponibles.

## Instalación

Abre la página de tu despliegue y pulsa **Añadir a Stremio**, o copia su enlace `/manifest.json` en la sección Complementos de Stremio.

El identificador histórico se conserva para mantener la identidad del complemento existente. El nombre visible cambia a **Nexo Play**; ya no promete contenido exclusivamente en español.

## Soporte

¿Problemas para instalar, ideas o torrents caídos? Únete al canal de soporte en Discord: <https://discord.gg/qEcdvvcA4>

## Desarrollo y despliegue

Requiere Node.js 22.

```sh
npm ci
cp .env.example .env
# Completa las variables del servidor en .env
npm start
```

El servidor local escucha en `0.0.0.0:7000` (configurable con `PORT`) y ejecuta el mismo manejador Fetch del Worker adaptado a Node.

Para desarrollar y desplegar en Cloudflare Workers:

```sh
cp .dev.vars.example .dev.vars
# Completa SUPABASE_URL / SUPABASE_ANON_KEY en .dev.vars
npm run dev        # wrangler dev en http://localhost:8787
npm run deploy     # wrangler deploy (requiere wrangler login)
npm run tail       # registros en vivo del Worker desplegado
```

En producción, los secretos no van en `wrangler.toml`: usa `npx wrangler secret put SUPABASE_URL` (y `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`). El empaquetado se puede validar sin desplegar con `npx wrangler deploy --dry-run`.

### Despliegue automático (Workers Builds)

El repositorio está conectado a Cloudflare Workers Builds: cada push a `main` publica el Worker `nexo-player-app` y cada rama genera un Preview. Para que funcione:

- `name` en `wrangler.toml` debe ser exactamente el nombre del Worker del panel (`nexo-player-app`). Si no coincide, Workers Builds lo marca como error de nombre y `npm run deploy` crearía un Worker distinto.
- En el panel (Worker → *Settings* → *Build*): **Build command** vacío (o `npm test`), **Deploy command** = `npx wrangler deploy` y **Non-production branch deploy command** = `npx wrangler preview` o `npx wrangler versions upload`. Un `npx wrangler preview` en producción nunca actualiza el sitio vivo.
- Los secretos (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) se definen en *Settings* → *Variables and Secrets* del Worker; los Preview no los heredan.
- Si un build falla, el log está en *Deployments* → *View build* del Worker; el check `Workers Builds: nexo-player-app` del commit en GitHub enlaza directamente a él. Un build fallido no rompe la web (sigue sirviendo el último despliegue correcto), pero el cambio no llega hasta que el build termina bien; se puede reintentar desde el panel.

### URLs: la publicada y los Preview

- **Publicada (la única que conviene usar o instalar en Stremio):** <https://nexo-player-app.noe359866.workers.dev>. Se actualiza con cada merge a `main` y es la que responden `/manifest.json`, `/health` y la portada.
- **Preview (`<alias de rama>-nexo-player-app.noe359866.workers.dev` o `<hash>-nexo-player-app.noe359866.workers.dev`):** cada rama y cada build tienen su propia URL. Son **copias congeladas** del commit que las generó: al fusionar la rama no se actualizan jamás, y al no heredar los secretos del Worker devuelven 0 fuentes. Un Preview de la época de 1.5.0 seguirá anunciando 1.5.0 para siempre, así que no sirve para comprobar si un cambio llegó a la web.
- **Comprobación rápida de lo que hay publicado:**

  ```sh
  npm run check:live
  # o contra otro dominio:
  npm run check:live -- --url https://nexo-player-app.noe359866.workers.dev
  ```

  El script lee `/health` y `/manifest.json`, los compara con `package.json`, avisa si la URL es un Preview y termina con código 1 si el despliegue no publica la versión del paquete. La misma información, a mano: `curl -s https://nexo-player-app.noe359866.workers.dev/health`.
- **Catálogo de stremio-addons.net:** la versión que muestra la ficha del complemento la actualiza el propio servicio cuando su mantenedor vuelve a guardar o refrescar la entrada desde su panel con sesión iniciada; su API pública es de solo lectura. Si la ficha sigue en una versión anterior, no es un fallo del despliegue: hay que refrescar la entrada allí.

```sh
npm test
npm run test:manifest
npm run check:live
npm audit --omit=dev
```

## Configuración privada del servidor

Estas instrucciones son para administradores, no forman parte de la descripción pública del complemento.

- `SUPABASE_URL`: URL del proyecto. Se acepta con o sin `https://` y con barra final; se recorta de espacios y comillas.
- `SUPABASE_ANON_KEY`: clave para consultas con políticas RLS de solo lectura.
- `SUPABASE_SERVICE_ROLE_KEY`: alternativa privilegiada, **solo en servidor**. Si existe tiene prioridad; evita utilizarla si no es necesaria. El addon avisa en los logs si la usa; para lectura se recomienda ANON con políticas SELECT en `torrents` y `tv_channels`.
- `SUPABASE_TORRENT_COLUMNS` (opcional): lista de columnas separadas por comas. Si se omite, se usa `*`; al restringirla, conserva al menos los campos de consulta y los metadatos que quieras mostrar (`imdb_id`, `season`, `episode`, hash o magnet, `seeders`, título, idioma, calidad y tamaño).
- `SUPABASE_TV_CHANNEL_COLUMNS` (opcional): proyección separada por comas para `tv_channels`. Por defecto usa `id,name,slug,logo_url,stream_url,stream_type,category,country_code,is_active`; campos como `description`, `language` o `sort_order` no se cargan a menos que los añadas aquí. También acepta literalmente `*` para pedir todas las columnas, aunque aumenta el tamaño de respuesta y memoria. Si falta una columna elegida, se reintenta con `*` y se recuerda ese modo en el isolate para conservar compatibilidad; en un esquema distinto, define la lista de columnas que sí existen para mantener la consulta reducida.
- Los placeholders de `.env.example` / `.dev.vars.example` se ignoran solos. `/health` indica `supabase.configured`, el estado de formato de la URL y si hay una clave (`present`/`missing`), sin revelar su tipo ni valor.
- No publiques `.env` ni credenciales. Ocultar la infraestructura en la descripción no sustituye RLS ni el control de acceso. Si alguna clave real fue publicada, revócala y rótala.

La aplicación consulta `torrents` por `imdb_id`; para series/anime una consulta combina episodio exacto y packs de temporada (`episode` NULL) y etiqueta estos últimos como `PACK`. Si no encuentra una fuente válida, lee hasta 50 filas y coteja temporada/episodio en memoria: recupera valores guardados como texto (`2`, `05`), packs con `episode` vacío, episodios numerados en absoluto cuando la temporada pedida es la 1 y, como último recurso, un pack de la serie completa (`season` y `episode` nulos), etiquetado `SERIE COMPLETA`. Ordena por `seeders` descendente, con nulos al final, y trae hasta 50 filas candidatas; devuelve como mucho 25 fuentes por título, deduplicadas por hash y archivo, y descarta las de cero seeders cuando ya hay 25 fuentes con pares (si hay pocas fuentes vivas, las muertas vuelven al final con su aviso). Cada pack lleva su propio `bingeGroup` (`sNpack`/`allpack`), así que la reproducción continua nunca encadena un episodio con un pack. Anime y series se aceptan entre sí en ese cotejo (una película nunca), porque hay bases que etiquetan el anime como `series`. Ante errores transitorios (red, timeout, 502/503/504) cada consulta reintenta una vez tras 300 ms; los errores permanentes no se reintentan. Cada intento tiene un timeout de cuatro segundos. Se recomienda un índice sobre `(imdb_id, season, episode)` en bases grandes. No se ejecutan migraciones automáticamente.

El orden final agrupa primero la salud de la fuente: 5 o más seeders, de 1 a 4 seeders y sin seeders; luego prioriza resolución (8K, 4K, 1440p, 1080p, 720p, 576p, 480p, 360p), idioma (DUAL, CAST, LAT, ESP, VOSE, VOST, SUB, ENG), seeders, leechers y tamaño. El hash rompe el último empate, así que dos peticiones con las mismas filas devuelven exactamente la misma lista. El idioma se lee primero de la columna de audio y, si no declara nada, del nombre del release; `VOSE` cubre también `VO`/`V.O.`. La resolución reconoce alturas y etiquetas (`4K`, `UHD`, `1440p`, `1080i`…) con límites de palabra, de modo que un título como `14km` no se toma por un 4K. Los contadores admiten las columnas `seeders`/`seeds`/`seed` y `leechers`/`leechs`/`peers`, con notaciones como `1.2k` o `3,5 mil`; la columna `trackers` acepta array, lista separada por comas o saltos, o JSON serializado. Las etiquetas de baja calidad (`CAM`, `TS`, `HDTS`, `DVDScr`, `R5`, `Workprint`…) se buscan por palabra completa, así que «Torrents.com» no penaliza una fuente buena, y los formatos reproducibles suman `WEB-DL`, `WEBRip`, `BluRay`, `BDRip`, `BRRip`, `HDRip`, `HDTV` y `REMUX`.

El catálogo consulta `public.tv_channels` (la estructura documentada incluye `id`, `name`, `slug`, `logo_url`, `stream_url`, `stream_type`, `category`, `country_code` e `is_active`) con una proyección de esas nueve columnas —o `SUPABASE_TV_CHANNEL_COLUMNS`—, hasta 1000 filas y páginas de 100 canales. Usa `id` como identificador estable, muestra `name`, `logo_url`, la categoría y el país ya normalizados, y omite filas donde `is_active` es falso. `stream_type=hls`, `dash` y `custom` devuelven `stream_url` como stream directo; `embed` se ofrece como enlace externo. Se admiten búsqueda, filtro por tipo de contenido o país y `skip`. No se incluye guía EPG: la tabla solo aporta canales y enlaces. Con `SUPABASE_ANON_KEY`, configura una política RLS `SELECT` en `tv_channels` (además de la política existente para `torrents`). Las filas consultadas se mantienen 30 segundos por isolate, con respaldo de hasta diez minutos ante errores, y las respuestas exitosas del catálogo se cachean cinco minutos en el edge.

### Clasificación del catálogo de TV

La clasificación no exige cambiar la base: se deduce de las columnas que ya existen y se publica en el manifiesto para que Stremio muestre los desplegables.

- **Tipos de contenido** (`TV_CONTENT_TYPES` en `addon.js`): cada tipo reúne alias en español e inglés que se comparan por **palabra completa** sobre el valor sin tildes ni mayúsculas, y gana el alias más largo (`Home Shopping` → Compras, no Estilo de vida; `deportistas` no es `deportes`). Se revisan las categorías declaradas en orden y decide la primera reconocible; si ninguna lo es, se conserva la primera tal cual, y sin categorías el canal queda en «General». Añadir un alias es una línea en esa tabla.
- **Países** (`tv-countries.js`): `country_code` o `country` se resuelven desde `ES`, `ESP`, `es`, «España» o «Nicaragua» (también `EEUU`, `UK`, `Holanda` como alias) al mismo país, y se muestran con el nombre oficial en español. Lo que no es un país (por ejemplo «Europa» o «Región andina») se respeta literalmente. La tabla es estática: 250 países, sin dependencias ni peticiones externas.
- **Filtros del manifiesto** (`tvCatalogOptions`): antes de servir `/manifest.json` se agregan los tipos y países presentes en la tabla y se cachean diez minutos (una hora de ventana obsoleta ante fallos) para publicar solo opciones que devuelven resultados. El catálogo por tipo de contenido ordena los tipos por número de canales; el de país, alfabéticamente. `tvCatalogDefinitions` limita a 80 opciones por catálogo y recurre a listas de respaldo si no hay datos.
- **Coste:** la consulta de descubrimiento no bloquea el manifiesto más de 2,5 segundos y, cuando ya hay una lista cacheada, se refresca en segundo plano. En 1.6.4 la proyección compacta y el resumen por campos evitan validar mil URLs/logos; la lista del manifiesto sigue cacheada diez minutos en memoria y cinco minutos en el edge.
- **Detalles de la ficha:** los `genres` que ve el usuario en Stremio son el tipo de contenido y el país normalizados; `country` pasa a mostrarse con su nombre en español.

Campos utilizados: `info_hash` (alternativas `infoHash`, `hash`) o `magnet_url` (`magnetUrl`, `magnet`), título, idioma/audio, resolución/calidad y tamaño (`size_bytes`, `size_gb` o `size` con unidades en inglés, decimales con coma o punto, hasta TB). Opcionalmente `file_idx`/`fileIdx` indica el archivo del torrent y `leechers` afina el orden dentro de un mismo tramo. Los campos de metadatos ausentes se muestran como no indicados, sin inventar idioma, subtítulos ni calidad.

Los magnets admiten BTIH hexadecimal o base32; las filas sin hash válido se descartan. Los trackers del magnet original (`tr=`) y los de la columna `trackers` viajan en `sources` de cada stream, normalizados y sin duplicados, para acelerar la búsqueda de pares. Las consultas tienen un límite de cuatro segundos por intento. Cada instancia mantiene hasta 250 respuestas en memoria con 120 segundos de frescura y hasta 600 segundos adicionales para revalidar fuentes no vacías; la revalidación obsoleta se bloquea por clave, pero las peticiones frías concurrentes no comparten promesas de I/O. No se comparte caché entre instancias ni se almacenan errores: tras un fallo de la base de datos no se repite la consulta hasta pasados quince segundos, y las respuestas vacías confirmadas se cachean sesenta segundos. Los resultados con torrents anuncian 120 segundos de caché (navegador y edge) más diez minutos de `stale-while-revalidate` y `stale-if-error`; los fallos no anuncian caché. El manifiesto anuncia `max-age`/`s-maxage` de cinco minutos con `stale-while-revalidate` de una hora, sirve `304` con su ETag y cachea en el borde ignorando la cadena de consulta. `/health` confirma que la aplicación responde y que las variables de Supabase tienen formato válido (sin exponer valores); no comprueba la conectividad con la base de datos.

## Estructura

- `addon.js`: manifiesto, clasificación y catálogo/metadatos de TV, consulta y formato de streams.
- `tv-countries.js`: tabla estática ISO 3166-1 (alpha-2, alpha-3 y nombre en español) del catálogo de TV.
- `worker.js`: rutas sobre la API Fetch (manifiesto, catálogo, metadatos, streams, salud y estáticos), CORS y caché del edge con la Cache API.
- `worker.mjs`: punto de entrada ESM que expone el manejador a Wrangler.
- `server.js`: adaptador local del mismo manejador al servidor HTTP de Node.
- `wrangler.toml`: configuración del Worker y binding de estáticos.
- `scripts/`: `benchmark.js` (medición simulada con datos de prueba) y `check-live.js` (`npm run check:live`).
- `public/`: página de instalación e imagen de marca generada con IA. `index.html` y `assets/` son archivos estáticos: Workers Static Assets los sirve desde el edge sin invocar el Worker, `/assets/` anuncia un día de caché y la portada revalida en cada visita; `public/_headers` declara ambas cabeceras.
- `test/`: pruebas unitarias y HTTP con datos simulados, incluida la caché del edge.

La imagen se sirve desde el propio despliegue; no depende de un proveedor externo. El manifiesto HTTP incluye su URL absoluta. Las versiones fijadas mediante `overrides` corrigen dependencias transitivas del SDK sin degradarlo a una versión incompatible.

Consulta [CHANGELOG.md](CHANGELOG.md) para las novedades.
