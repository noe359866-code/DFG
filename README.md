# Nexo Play · 1.2.2

![Nexo Play](public/brand.png)

**Tu próxima historia, más cerca.** Películas, series y anime en español e inglés. Encuentra opciones de reproducción con información de idioma y calidad, en un solo lugar.

Complemento de fuentes de reproducción para Stremio. No incluye un catálogo propio; las opciones aparecen en las fichas compatibles. Idiomas, calidad y disponibilidad dependen de los archivos disponibles. Utiliza únicamente contenido que tengas derecho a reproducir.

## Instalación

Abre la página de tu despliegue y pulsa **Añadir a Stremio**, o copia su enlace `/manifest.json` en la sección Complementos de Stremio.

El identificador histórico se conserva para mantener la identidad del complemento existente. El nombre visible cambia a **Nexo Play**; ya no promete contenido exclusivamente en español.

## Desarrollo y despliegue

Requiere Node.js 22.

```sh
npm ci
cp .env.example .env
# Completa las variables del servidor en .env
npm start
```

El servidor escucha en `0.0.0.0:7000` (configurable con `PORT`). En Vercel, configura las variables de entorno en el proyecto y despliega con `vercel.json`. Local y serverless utilizan la misma aplicación HTTP.

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

Los magnets admiten BTIH hexadecimal o base32; las filas sin hash válido se descartan. Las consultas tienen un límite de tiempo de ocho segundos. Los resultados correctos anuncian 120 segundos de caché HTTP; los fallos no anuncian esa caché. `/health` comprueba que la aplicación responde, no la conectividad con la base de datos.

## Estructura

- `addon.js`: manifiesto, validación, consulta y formato de streams.
- `app.js`: rutas HTTP compartidas, CORS, imagen y manifiesto público.
- `server.js`: arranque local.
- `api/index.js`: adaptación de reescrituras de Vercel.
- `public/`: página de instalación e imagen de marca generada con IA.
- `test/`: pruebas unitarias y HTTP con datos simulados.

La imagen se sirve desde el propio despliegue; no depende de un proveedor externo. El manifiesto HTTP incluye su URL absoluta. Las versiones fijadas mediante `overrides` corrigen dependencias transitivas del SDK sin degradarlo a una versión incompatible.

Consulta [CHANGELOG.md](CHANGELOG.md) para las novedades.
