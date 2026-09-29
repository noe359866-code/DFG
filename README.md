# Nexo Play · 1.2.7

![Nexo Play](public/assets/brand.png)

**Tu próxima historia, más cerca.** Películas, series y anime en español e inglés. Encuentra opciones de reproducción con información de idioma y calidad, en un solo lugar.

Complemento de fuentes de reproducción para Stremio. No incluye un catálogo propio; las opciones aparecen en las fichas compatibles. Idiomas, calidad y disponibilidad dependen de los archivos disponibles. Utiliza únicamente contenido que tengas derecho a reproducir.

## Novedades de 1.2.7

- **Despliegue dual: Vercel y Cloudflare Workers.** Nuevo `worker.mjs` con paridad de cabeceras respecto a la versión Express/Vercel (CORS, `no-store` en fallos, `s-maxage` gemelo). El landing y los assets se sirven como Static Assets; el API usa la Cache API de Workers para el edge, con `x-nexo-cache: hit|miss` para verificar aciertos en producción.
- `addon.js` ya no depende de la plataforma: cada entrada inyecta su `waitUntil` con `setKeepAlive()` (Vercel: `@vercel/functions`; Workers: `ctx.waitUntil`; local: fire-and-forget). El builder del SDK se importa directamente para no arrastrar Express al bundle de Workers.
- El polyfill `ws` solo se carga en Node sin `WebSocket` nativo (Node <22).

## Novedades de 1.2.6

- Entrega inmediata de fuentes recientes desde memoria mientras una única consulta las actualiza. Tras sus 120 segundos de frescura, se pueden servir durante un máximo adicional de 600 segundos; los resultados vacíos no se sirven caducados.
- Si una actualización falla, conserva las fuentes anteriores dentro de ese límite y espera 15 segundos antes del siguiente intento. No guarda el error como resultado.
- Compresión HTTP negociada (gzip/deflate) para reducir bytes transferidos, con compatibilidad para clientes sin compresión.
- Cada magnet se analiza una vez por fila. La caché HTTP recibe el tiempo de vida restante, no un plazo nuevo en cada lectura.

En Vercel y Cloudflare Workers, `waitUntil` mantiene activa la actualización después de responder. La caché sigue siendo por instancia y se pierde con reinicios; una instancia nueva o un título nunca consultado debe esperar a la base de datos. Las consultas mantienen su límite de ocho segundos. No se hacen consultas anticipadas a episodios que el usuario no solicitó.

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

El servidor escucha en `0.0.0.0:7000` (configurable con `PORT`). En Vercel, configura las variables de entorno en el proyecto y despliega con `vercel.json`. Local y serverless utilizan la misma aplicación HTTP.

### Despliegue en Cloudflare Workers (alternativa a Vercel)

El mismo código corre en Workers sin cambios de lógica: `worker.mjs` sirve el API y `public/` se publica como Static Assets.

```sh
npm ci
npx wrangler login
# Secretos del API (mismos nombres que .env):
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
# o SUPABASE_SERVICE_ROLE_KEY si la usas
npm run deploy:cloudflare
```

Desarrollo local con `npm run dev:cloudflare` y las credenciales en `.dev.vars` (copia `.dev.vars.example`). Notas:

- En `wrangler dev` local la Cache API no guarda aciertos (limitación conocida del modo local); en producción `x-nexo-cache: hit` confirma el edge. Cloudflare comprime las respuestas automáticamente, sin `compression`.
- `wrangler.jsonc` define el worker, los assets y `nodejs_compat`. Las cabeceras públicas de los assets están en `public/_headers` (espejo de las de `vercel.json`).
- **Cambiar de hosting cambia la URL pública del addon**: los usuarios deberán reinstalar con la URL nueva (p. ej. `https://nexo-play.<cuenta>.workers.dev/manifest.json`) y la firma de stremio-addons.net corresponde al dominio verificado. Con un dominio propio apuntado a Cloudflare el enlace se conserva.
- Vercel y Workers pueden convivir; el cambio de la URL del manifiesto decide cuál sirve a los usuarios.

```sh
npm test
npm run test:manifest
npm audit --omit=dev
```

## Configuración privada del servidor

Estas instrucciones son para administradores, no forman parte de la descripción pública del complemento.

- `SUPABASE_URL`: URL del proyecto.
- `SUPABASE_ANON_KEY`: clave para consultas con políticas RLS de solo lectura.
- `SUPABASE_SERVICE_ROLE_KEY`: alternativa privilegiada, **solo en servidor**. Si existe tiene prioridad; evita utilizarla si no es necesaria.
- No publiques `.env` ni credenciales. Ocultar la infraestructura en la descripción no sustituye RLS ni el control de acceso. Si alguna clave real fue publicada, revócala y rótala.

La aplicación consulta `torrents` por `imdb_id`; para series/anime también exige `season` y `episode`. Ordena por `seeders` descendente, con nulos al final y un límite de 25 filas. Se recomienda un índice sobre `(imdb_id, season, episode)` en bases grandes. No se ejecutan migraciones automáticamente.

Campos utilizados: `info_hash` (alternativas `infoHash`, `hash`) o `magnet_url` (`magnetUrl`, `magnet`), título, idioma/audio, resolución/calidad y tamaño. Opcionalmente `file_idx`/`fileIdx` indica el archivo del torrent. Los campos de metadatos ausentes se muestran como no indicados, sin inventar idioma, subtítulos ni calidad.

Los magnets admiten BTIH hexadecimal o base32; las filas sin hash válido se descartan. Los trackers del magnet original (`tr=`) y los de la columna `trackers` viajan en `sources` de cada stream, normalizados y sin duplicados, para acelerar la búsqueda de pares. Las consultas tienen un límite de tiempo de ocho segundos. Además, cada instancia mantiene hasta 250 respuestas en memoria con 120 segundos de frescura y hasta 600 segundos adicionales para revalidar fuentes no vacías; agrupa consultas simultáneas idénticas. No se comparten entre instancias ni se almacenan errores. Los resultados con torrents anuncian 120 segundos de caché (navegador y edge) más diez minutos de `stale-while-revalidate`; los títulos sin torrents en la base se cachean sesenta segundos; los fallos no anuncian caché. `/health` comprueba que la aplicación responde, no la conectividad con la base de datos.

## Estructura

- `addon.js`: manifiesto, validación, consulta y formato de streams.
- `app.js`: rutas HTTP compartidas, CORS, imagen y manifiesto público.
- `server.js`: arranque local.
- `api/index.js`: adaptación de reescrituras de Vercel.
- `worker.mjs`: entrada para Cloudflare Workers (API) con `wrangler.jsonc`.
- `public/`: página de instalación e imagen de marca generada con IA. `index.html` y `assets/` son archivos estáticos: Vercel los sirve desde su CDN y Cloudflare como Static Assets, sin invocar la función ni pagar invocación; `/assets/` anuncia un día de caché.
- `test/`: pruebas unitarias y HTTP con datos simulados.

La imagen se sirve desde el propio despliegue; no depende de un proveedor externo. El manifiesto HTTP incluye su URL absoluta. Las versiones fijadas mediante `overrides` corrigen dependencias transitivas del SDK sin degradarlo a una versión incompatible.

Consulta [CHANGELOG.md](CHANGELOG.md) para las novedades.
