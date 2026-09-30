# Nexo Play · 1.4.0

![Nexo Play](public/assets/brand.png)

**Tu próxima historia, más cerca.** Películas, series y anime en español e inglés. Encuentra opciones de reproducción con información de idioma y calidad, en un solo lugar.

Complemento de fuentes de reproducción para Stremio. No incluye un catálogo propio; las opciones aparecen en las fichas compatibles. Idiomas, calidad y disponibilidad dependen de los archivos disponibles. Utiliza únicamente contenido que tengas derecho a reproducir.

## Novedades de 1.4.0

- **Más contenido visible:** si una serie o anime no tiene el episodio exacto en la base, se ofrecen los **packs de su temporada completa** (`episode` NULL) etiquetados como `PACK T<temporada>`, en lugar de responder vacío.
- **Más rápido ante cortes puntuales:** las consultas reintentan una vez (pausa de 300 ms) frente a errores de red, timeouts y 502/503/504; los errores permanentes no se reintentan y cada intento mantiene su límite de ocho segundos.
- **Environment a prueba de copiar y pegar:** los valores de `SUPABASE_URL` y las claves se limpian de espacios, saltos de línea y comillas; la URL admite pegarse sin `https://` y los placeholders de los archivos `.example` se descartan en vez de intentar conectar.
- **`/health` diagnostica tu despliegue:** indica `supabase.configured`, si la URL es `ok`/`invalid`/`missing` y el tipo de clave activa (`anon`/`service_role`/`none`), sin exponer los valores.

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

En Cloudflare Workers, `ctx.waitUntil` mantiene activa la actualización después de responder. La caché sigue siendo por instancia y se pierde con reinicios; una instancia nueva o un título nunca consultado debe esperar a la base de datos. Las consultas mantienen su límite de ocho segundos. No se hacen consultas anticipadas a episodios que el usuario no solicitó.

Ejecuta `npm run benchmark` para una medición **simulada** de consultas concurrentes, caché y compresión; no representa latencias de producción ni velocidad de reproducción P2P.

## Buscador incorporado en 1.2.5

Nuevo buscador web de fuentes por **ID o enlace de IMDb**, con filtros de idioma y calidad. Selecciona película, serie o anime; para episodios indica temporada y número de episodio (temporada cero para especiales). Consulta fuentes sin salir de la página y reprodúcelas desde Stremio. No busca por nombre ni añade un catálogo propio.

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

```sh
npm test
npm run test:manifest
npm audit --omit=dev
```

## Configuración privada del servidor

Estas instrucciones son para administradores, no forman parte de la descripción pública del complemento.

- `SUPABASE_URL`: URL del proyecto. Se acepta con o sin `https://` y con barra final; se recorta de espacios y comillas.
- `SUPABASE_ANON_KEY`: clave para consultas con políticas RLS de solo lectura.
- `SUPABASE_SERVICE_ROLE_KEY`: alternativa privilegiada, **solo en servidor**. Si existe tiene prioridad; evita utilizarla si no es necesaria.
- Los placeholders de `.env.example` / `.dev.vars.example` se ignoran solos, y `/health` confirma si la configuración quedó activa (`supabase.configured`) sin exponer los valores.
- No publiques `.env` ni credenciales. Ocultar la infraestructura en la descripción no sustituye RLS ni el control de acceso. Si alguna clave real fue publicada, revócala y rótala.

La aplicación consulta `torrents` por `imdb_id`; para series/anime también exige `season` y `episode`, con **segunda consulta automática a packs de temporada** (`episode` NULL, hasta 10 filas, etiquetados `PACK`) cuando el episodio exacto no existe, y una **tercera relectura de la temporada** (hasta 50 filas) que coteja temporada y episodio en memoria antes de rendirse. Esa última pasada recupera las filas con `season`/`episode` guardados como texto (`"2"`, `"05"`) y los packs con `episode` vacío en vez de `NULL`, que los filtros de PostgREST no encuentran. Ordena por `seeders` descendente, con nulos al final, y trae hasta 50 filas candidatas: el orden definitivo lo pone la aplicación, no la base. De ellas se devuelven como mucho 25 fuentes por título, ya deduplicadas por hash y archivo. Ante errores transitorios (red, timeout, 502/503/504) cada consulta reintenta una vez tras 300 ms; los errores permanentes no se reintentan. Se recomienda un índice sobre `(imdb_id, season, episode)` en bases grandes. No se ejecutan migraciones automáticamente.

El orden final prioriza, en este orden: fuentes vivas (cualquier torrent sin seeders baja por debajo de todos los demás), resolución (8K, 4K, 1440p, 1080p, 720p, 576p, 480p, 360p), idioma (DUAL, CAST, LAT, ESP, VOSE, VOST, SUB, ENG), seeders, leechers y tamaño. El hash rompe el último empate, así que dos peticiones con las mismas filas devuelven exactamente la misma lista. El idioma se lee primero de la columna de audio y, si no declara nada, del nombre del release; la resolución reconoce alturas y etiquetas (`4K`, `UHD`, `1440p`, `1080i`…) con límites de palabra, de modo que un título como `14km` no se toma por un 4K.

Campos utilizados: `info_hash` (alternativas `infoHash`, `hash`) o `magnet_url` (`magnetUrl`, `magnet`), título, idioma/audio, resolución/calidad y tamaño (`size_bytes`, `size_gb` o `size` con unidades en inglés, decimales con coma o punto, hasta TB). Opcionalmente `file_idx`/`fileIdx` indica el archivo del torrent y `leechers` afina el orden dentro de un mismo tramo. Los campos de metadatos ausentes se muestran como no indicados, sin inventar idioma, subtítulos ni calidad.

Los magnets admiten BTIH hexadecimal o base32; las filas sin hash válido se descartan. Los trackers del magnet original (`tr=`) y los de la columna `trackers` viajan en `sources` de cada stream, normalizados y sin duplicados, para acelerar la búsqueda de pares. Las consultas tienen un límite de tiempo de ocho segundos. Además, cada instancia mantiene hasta 250 respuestas en memoria con 120 segundos de frescura y hasta 600 segundos adicionales para revalidar fuentes no vacías; agrupa consultas simultáneas idénticas. No se comparten entre instancias ni se almacenan errores: tras un fallo de la base de datos no se repite la consulta hasta pasados quince segundos, y las respuestas vacías confirmadas se cachean sesenta segundos. Los resultados con torrents anuncian 120 segundos de caché (navegador y edge) más diez minutos de `stale-while-revalidate` y `stale-if-error`; los fallos no anuncian caché. El manifiesto anuncia `max-age`/`s-maxage` de cinco minutos con `stale-while-revalidate` de una hora, sirve `304` con su ETag y cachea en el borde ignorando la cadena de consulta. `/health` confirma que la aplicación responde y que las variables de Supabase son válidas (sin exponer valores); no comprueba la conectividad con la base de datos.

## Estructura

- `addon.js`: manifiesto, validación, consulta y formato de streams.
- `worker.js`: rutas sobre la API Fetch (manifiesto, streams, salud, estáticos), CORS y caché del edge con la Cache API.
- `worker.mjs`: punto de entrada ESM que expone el manejador a Wrangler.
- `server.js`: adaptador local del mismo manejador al servidor HTTP de Node.
- `wrangler.toml`: configuración del Worker y binding de estáticos.
- `public/`: página de instalación e imagen de marca generada con IA. `index.html` y `assets/` son archivos estáticos: Workers Static Assets los sirve desde el edge sin invocar el Worker, `/assets/` anuncia un día de caché y `public/_headers` declara esas cabeceras.
- `test/`: pruebas unitarias y HTTP con datos simulados, incluida la caché del edge.

La imagen se sirve desde el propio despliegue; no depende de un proveedor externo. El manifiesto HTTP incluye su URL absoluta. Las versiones fijadas mediante `overrides` corrigen dependencias transitivas del SDK sin degradarlo a una versión incompatible.

Consulta [CHANGELOG.md](CHANGELOG.md) para las novedades.
