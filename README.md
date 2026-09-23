# Torrents Español HD — Stremio Addon (Vercel + Supabase)

Addon de Stremio 100% Serverless para buscar y servir **torrents en Español** (Castellano, Latino, Dual, Vose/Subtitulado) consultando directamente tu base de datos **Supabase** (`public.torrents`). Sin scraping, sin DDL — solo la API limpia que Stremio necesita.

> **Stack:** Node.js • `stremio-addon-sdk` • `@supabase/supabase-js` • Vercel Serverless Functions (gratis) • Express (solo local)

---

## 📦 Estructura del Proyecto

```
.
├── addon.js         # Manifest + defineStreamHandler (lógica principal)
├── api/
│   └── index.js     # Handler Vercel Serverless (CORS + getRouter)
├── server.js        # Servidor local Express (npm start)
├── vercel.json      # Rewrites para /manifest.json y /stream/*
├── package.json
├── .env.example     # Plantilla variables Supabase
└── README.md
```

---

## ⚙️ Manifest (Especificación Entregada)

```js
{
  id: 'org.comunidad.torrents.espanol',
  version: '1.0.0',
  name: 'Torrents Español HD',
  description: 'Catálogo y buscador de torrents filtrados estrictamente en Español Castellano, Español Latino, Dual y Subtitulado en Español directamente desde Supabase.',
  icon: 'https://cdn-icons-png.flaticon.com/512/3172/3172520.png',
  background: 'https://dl.strem.io/bg.jpg',
  resources: ['stream'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: false, configurationRequired: false }
}
```

---

## 🧠 Lógica del Handler (`addon.js`)

### Variables de entorno
Lee `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (fallback a `SUPABASE_ANON_KEY`).

### Parseo de IDs
- **Películas:** `tt0111161` → `imdb_id = tt0111161`
- **Series/Anime:** `tt0944947:1:5` → `imdb_id = tt0944947, season = 1, episode = 5`

Soporta ambos con `parseStremioId()` robusto (valida `tt\d+`).

### Consulta Supabase
```js
supabase
  .from('torrents')
  .select('*')
  .eq('imdb_id', imdbId)
  // si es serie/anime y hay temporada/episodio:
  .eq('season', 1).eq('episode', 5)
  .order('seeders', { ascending: false })
  .limit(25)
```

- Tabla: `public.torrents`
- Orden: `seeders DESC`
- Límite seguridad: **25** (dentro del rango 20-30 pedido)
- Si no hay resultados o hay error → `{ streams: [] }` limpio (Stremio no muestra error).

### Mapeo a Stream de Stremio
Cada fila →:

```js
{
  name: "Torrents Español HD\n[CAST] 1080p", // encabezado corto
  title: `🎬 Nombre del Release
🔊 Audio: Castellano, Latino | 📝 Subs: Español
💾 Tamaño: 4.32 GB
👥 Seeders: 45 | 🌱 Leechers: 8
⚙️ Codec: x265  |  📦 Grupo: YTS
⭐ Calidad: 1080p`,
  infoHash: "a1b2c3... (40 hex lowercased)",
  behaviorHints: { bingeGroup: "torrents-es-1080p-cast" }
}
```

- `infoHash` se normaliza a **40 hex lowercase**. Si no es válido, intenta extraerlo del `magnetUrl` (`btih:`). 
- Si solo hay `magnetUrl` válido sin hash, se responde con `{ url: "magnet:..." }` (Stremio lo soporta).
- `name` y `title` incluyen resolución, idioma, tamaño GB, seeders, codec y grupo.
- Filas sin hash/magnet válido se descartan silenciosamente.

---

## 🌐 Compatibilidad Vercel Serverless (`api/index.js`)

Usa `getRouter` del SDK (recomendación oficial) envuelto en un handler serverless:

- **CORS obligatorio:**
  ```
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Headers: *
  Access-Control-Allow-Methods: GET, POST, OPTIONS
  Content-Type: application/json
  ```
- Maneja `OPTIONS` → `204`
- Headers de cache:
  - `/manifest.json` → `max-age=3600, s-maxage=86400`
  - `/stream/*` → `max-age=300, s-maxage=600, stale-while-revalidate=600`
- Landing page HTML en `/` con Manifest URL y botón `stremio://`
- Health check en `/health`

### `vercel.json`
Rewrites modernos (sin `builds` legacy):

```json
{
  "version": 2,
  "rewrites": [
    { "source": "/manifest.json", "destination": "/api/index" },
    { "source": "/stream/:type/:id.json", "destination": "/api/index" },
    { "source": "/(.*)", "destination": "/api/index" }
  ]
}
```

> También incluye `headers` globales de CORS por si Vercel los inyecta a nivel CDN.

---

## 🧪 Probar en Local

### 1. Clonar e instalar
```bash
git clone https://github.com/tu-usuario/torrents-espanol-addon.git
cd torrents-espanol-addon
npm install
```

### 2. Variables de entorno
```bash
cp .env.example .env
# Edita .env con tu SUPABASE_URL y SERVICE_ROLE_KEY
# Puedes obtenerlas en: https://supabase.com/dashboard/project/_/settings/api
```

**.env mínimo:**
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
PORT=7000
```

### 3. Correr
```bash
npm start
# → http://localhost:7000/manifest.json
# → http://localhost:7000/stream/movie/tt0111161.json
# → http://localhost:7000/stream/series/tt0944947:1:1.json
# → http://localhost:7000/stream/anime/tt0388629:1:1.json
```

**Test rápido con curl:**
```bash
curl http://localhost:7000/manifest.json | jq
curl http://localhost:7000/stream/movie/tt0111161.json | jq .streams[0]
```

Si ves `{ "streams": [] }` y el registro dice `Sin resultados`, es normal — significa que tu tabla aún no tiene ese `imdb_id`.

---

## 🚀 Despliegue en Vercel (Gratis) — Paso a Paso

### Opción A: Desde GitHub (Recomendada)

1. **Sube el proyecto a GitHub:**
   ```bash
   git init
   git add .
   git commit -m "feat: addon torrents español HD v1.0.0"
   git branch -M main
   git remote add origin https://github.com/tu-usuario/torrents-espanol-addon.git
   git push -u origin main
   ```

2. **Importa en Vercel:**
   - Ve a https://vercel.com/new
   - `Import Git Repository` → selecciona tu repo → `Import`
   - Framework Preset: **Other** (no Next.js)
   - Root Directory: `./` (por defecto)
   - `Deploy` (puedes dejarlo fallar la primera vez, luego configuramos env vars)

3. **Configura Variables de Entorno en Vercel:**
   - En tu proyecto Vercel → **Settings** → **Environment Variables**
   - Añade:
     | Key | Value | Environments |
     |-----|-------|----------------|
     | `SUPABASE_URL` | `https://xxxx.supabase.co` | Production, Preview, Development |
     | `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` | Production, Preview, Development |
   - *Alternativa:* si usas RLS público, usa `SUPABASE_ANON_KEY` en lugar de service_role.

4. **Redeploy:**
   - Ve a **Deployments** → último deployment → `...` → **Redeploy** → `Redeploy`
   - Espera a que diga **Ready**

5. **Verifica:**
   - Abre `https://tu-proyecto.vercel.app/` → debe mostrar la landing page
   - Abre `https://tu-proyecto.vercel.app/manifest.json` → debe devolver el manifest JSON
   - Abre `https://tu-proyecto.vercel.app/health` → `{ status: "ok" }`

### Opción B: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel --prod
# Sigue el wizard, luego:
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel --prod
```

---

## 📲 Instalar en Stremio

### URL final (formato exacto)
```
https://tu-proyecto.vercel.app/manifest.json
```
Ejemplo real si tu proyecto se llama `torrents-espanol-hd`:
```
https://torrents-espanol-hd.vercel.app/manifest.json
```
> **Importante:** Siempre con `/manifest.json` al final y con `https://`.

### En Stremio Desktop (Windows/Mac/Linux)
1. Copia tu URL `https://tu-proyecto.vercel.app/manifest.json`
2. Abre Stremio → icono **Addons** (pieza de puzzle en el menú superior)
3. En la barra **"Add-on Repository URL"** (arriba), pega la URL y presiona **Enter** o **Install**
4. Confirma → verás *Torrents Español HD* en "Mis Addons"

### Método directo (un clic)
Haz clic en este esquema desde tu navegador (con Stremio instalado):
```
stremio://tu-proyecto.vercel.app/manifest.json
```
En la landing page (`https://tu-proyecto.vercel.app/`) ya tienes el botón **📲 Instalar en Stremio**.

### En Stremio Web / Android / iOS
- **Web:** https://web.strem.io → Addons → pega la URL
- **Android TV / Móvil:** Misma ruta desde la app Stremio

### Verificar streams
1. Busca cualquier película (ej: *Cadena Perpetua* → `tt0111161`) o serie (ej: *Juego de Tronos* → `tt0944947:1:1`)
2. Entra al detalle → lista de **Streams**
3. Deben aparecer entradas como:
   - `[CAST] 1080p` — `Torrents Español HD`
   - `[LAT] 4K` — `Torrents Español HD`
   - `[DUAL] 720p`
   - Al hacer hover verás el `title` multilínea con tamaño, seeders y codec.

Si no aparecen, revisa que tu tabla `public.torrents` tenga filas con ese `imdb_id` y `seeders > 0`.

---

## 🗄️ Esquema Esperado en Supabase

> **No necesitas crear tablas** — ya existen vía GitHub Actions. Solo referencia:

**Tabla `public.torrents` (columnas relevantes):**

| Columna | Tipo | Notas |
|---------|------|-------|
| `imdb_id` | `text` | `tt` + números. Ej: `tt0111161` |
| `season` | `int` | Null para películas. Ej: `1` |
| `episode` | `int` | Null para películas. Ej: `5` |
| `info_hash` | `text` | 40 hex. Alternativas: `infoHash`, `hash` |
| `magnet_url` | `text` | Fallback si no hay `info_hash` |
| `title` / `release_name` | `text` | Nombre completo del torrent |
| `audio` / `language` | `text` | `Castellano`, `Latino`, `Dual` |
| `subtitles` / `subs` | `text` | `Español`, `Vose` |
| `size_bytes` / `size` | `bigint`/`text` | Tamaño en bytes o string `4.5 GB` |
| `seeders` | `int` | Para `ORDER BY seeders DESC` |
| `leechers` | `int` | Opcional |
| `resolution` / `quality` | `text` | `1080p`, `4K` |
| `codec` | `text` | `x264`, `x265`, `HEVC` |
| `release_group` | `text` | Grupo de release |

El addon es **tolerante a nombres de columnas**: busca múltiples variantes (`title`/`release_name`/`name`, `info_hash`/`infoHash`/`hash`, etc.).

---

## 🔍 Debugging

**Logs en Vercel:**
- Dashboard → tu proyecto → **Logs** → **Runtime Logs**
- Verás: `[Stream] → type=movie id=tt0111161` y `X resultados en Yms`

**Errores comunes:**

| Síntoma | Causa | Solución |
|---------|-------|----------|
| `{ streams: [] }` siempre | Tabla vacía o `imdb_id` no coincide | Inserta datos de prueba con `tt0111161` |
| `Supabase no configurado` en logs | Env vars no seteadas | Verifica Settings → Environment Variables → Redeploy |
| CORS error en Stremio Web | `vercel.json` sin headers | Usa el `vercel.json` provisto (ya incluye headers) |
| 404 en `/manifest.json` | Rewrites mal | Copia exacto el `vercel.json` del proyecto |

**Test directo a Supabase (local):**
```js
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
s.from('torrents').select('*').limit(1).then(r=>console.log(r.data, r.error));
"
```

---

## 📄 Licencia

MIT — Úsalo libremente. No distribuye contenido, solo consulta tu propia DB.

---

## 🙌 Créditos

- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [Supabase JS](https://supabase.com/docs/reference/javascript/introduction)
- Vercel Serverless Functions
