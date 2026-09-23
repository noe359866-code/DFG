/**
 * api/index.js - Vercel Serverless Function
 * Adaptador HTTP para stremio-addon-sdk + CORS + manejo serverless
 * 
 * Vercel invoca este handler para TODAS las rutas mediante vercel.json rewrites:
 *  /manifest.json
 *  /stream/:type/:id.json
 *  / (landing page)
 */

const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('../addon');

// Creamos el router del addon (es un router Express/Connect compatible)
const router = getRouter(addonInterface);

// ---------------------------------------------------------------------------
// Handler principal exportado para Vercel
// ---------------------------------------------------------------------------
module.exports = (req, res) => {
  // 1. CORS - Obligatorio para Stremio Web y clientes
  // Nota: con '*' no se debe enviar Allow-Credentials:true (spec CORS), Stremio no lo necesita
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 2. Normalizar URL (quitar querystring)
  const rawUrl = req.url || '/';
  const url = rawUrl.split('?')[0];

  // 3. Landing page HTML en "/" - Útil para verificar deploy
  if (url === '/' || url === '/api' || url === '/api/index' || url === '/api/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Cache corto para landing
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.statusCode = 200;
    res.end(getLandingHtml(req));
    return;
  }

  // 4. Health check
  if (url.startsWith('/health') || url.startsWith('/api/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(JSON.stringify({ 
      status: 'ok', 
      addon: addonInterface.manifest.id,
      version: addonInterface.manifest.version,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 5. Delegar al router de stremio-addon-sdk
  // El router maneja automáticamente:
  //  - GET /manifest.json
  //  - GET /stream/:type/:id.json
  // Configuramos cache headers según la ruta
  if (url.includes('/manifest.json')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  } else if (url.includes('/stream/')) {
    // Streams cambian por seeders - cache moderado
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=600');
  }

  // Log útil en Vercel Functions
  console.log(`[Vercel] ${req.method} ${url} - UA: ${req.headers['user-agent']?.slice(0, 80) || '-'}`);

  // Invocar router (compatible con (req,res,next))
  router(req, res, (err) => {
    if (err) {
      console.error('[Router] Error:', err);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 500;
        res.end(JSON.stringify({ err: 'internal error', streams: [] }));
      }
      return;
    }
    // Si el router no manejó la ruta -> 404
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 404;
      res.end(JSON.stringify({ err: 'not found', streams: [] }));
    }
  });
};

// ---------------------------------------------------------------------------
// Landing HTML - Minimalista, moderna y clara
// ---------------------------------------------------------------------------
function getLandingHtml(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'tu-proyecto.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioInstallUrl = `stremio://${host}/manifest.json`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<title>Torrents Español HD — Stremio Addon</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#080a0f;--card:#11131a;--line:#1e2333;--txt:#eef1f8;--muted:#9aa0b6;--accent:#6c5ce7;--accent2:#a78bfa}
  body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;background:radial-gradient(600px 400px at 50% -10%, rgba(108,92,231,.22), transparent 70%), radial-gradient(500px 500px at 90% 100%, rgba(167,139,250,.12), transparent 60%);pointer-events:none}
  .card{position:relative;width:100%;max-width:520px;background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));backdrop-filter:blur(16px);border:1px solid var(--line);border-radius:28px;padding:36px 28px 24px;box-shadow:0 20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);text-align:center;overflow:hidden}
  .card::after{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:70%;height:1px;background:linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent)}
  .icon{width:64px;height:64px;margin:0 auto 16px;display:grid;place-items:center;background:linear-gradient(135deg, var(--accent), var(--accent2));border-radius:20px;box-shadow:0 10px 24px rgba(108,92,231,.4)}
  .icon svg{width:32px;height:32px;color:white}
  .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(108,92,231,.14);border:1px solid rgba(108,92,231,.25);color:#c4b5fd;font-size:11px;font-weight:700;letter-spacing:.12em;padding:5px 10px;border-radius:999px;margin-bottom:14px}
  .badge i{width:6px;height:6px;background:#22c55e;border-radius:50%;box-shadow:0 0 8px #22c55e;display:inline-block}
  h1{font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
  h1 span{background:linear-gradient(135deg, var(--accent), var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{margin:10px auto 22px;max-width:36ch;color:var(--muted);font-size:14.5px;line-height:1.5}
  .url-wrap{position:relative;text-align:left;background:#0a0c12;border:1px solid var(--line);border-radius:14px;padding:12px 44px 12px 14px;margin:0 0 18px;overflow:hidden}
  .url-label{font-size:10px;letter-spacing:.14em;color:#7a819a;font-weight:700;margin-bottom:4px}
  .url{font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12.5px;color:#a5b4fc;word-break:break-all;line-height:1.4}
  .copy{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:32px;height:32px;display:grid;place-items:center;background:#1a1f2e;border:1px solid var(--line);border-radius:9px;color:#cbd5e1;cursor:pointer;transition:.15s}
  .copy:hover{background:#222840;color:#fff;border-color:#2d3550}
  .copy:active{transform:translateY(-50%) scale(.96)}
  .actions{display:flex;gap:10px;margin-bottom:14px}
  .btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:13px 16px;border-radius:12px;font-weight:700;font-size:14.5px;text-decoration:none;cursor:pointer;transition:.15s;border:0}
  .btn-primary{background:linear-gradient(135deg, var(--accent), #7c6af0);color:#fff;box-shadow:0 8px 20px rgba(108,92,231,.35)}
  .btn-primary:hover{transform:translateY(-1px);box-shadow:0 12px 26px rgba(108,92,231,.45);filter:brightness(1.05)}
  .btn-primary:active{transform:translateY(0)}
  .btn-ghost{background:#151a27;color:#d0d6ea;border:1px solid var(--line)}
  .btn-ghost:hover{background:#1c2233;color:#fff}
  .hint{font-size:12px;color:#7a819a;line-height:1.4}
  .hint a{color:#a5b4fc;text-decoration:none;border-bottom:1px dotted rgba(165,180,252,.4)}
  .hint a:hover{color:#c4b5fd}
  .foot{margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;gap:8px;color:#6b728a;font-size:11.5px}
  .foot code{font-family:ui-monospace,monospace;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.06);padding:2px 6px;border-radius:6px;color:#9aa0b6}
  @media(max-width:520px){.card{padding:28px 18px 18px;border-radius:22px} h1{font-size:24px} .actions{flex-direction:column}}
</style>
</head>
<body>
  <main class="card">
    <div class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>
    </div>
    <div class="badge"><i></i> ONLINE • VERCEL</div>
    <h1><span>Torrents</span> Español HD</h1>
    <p class="sub">Películas, series y anime en Español.<br>Castellano · Latino · Dual · VOS</p>

    <div class="url-wrap" onclick="navigator.clipboard.writeText('${manifestUrl}'); const b=document.getElementById('copyBtn'); b.innerHTML='✓'; setTimeout(()=>b.innerHTML='❐',1200)">
      <div class="url-label">MANIFEST URL</div>
      <div class="url" id="manifestUrl">${manifestUrl}</div>
      <button class="copy" id="copyBtn" title="Copiar" aria-label="Copiar URL" onclick="event.stopPropagation(); navigator.clipboard.writeText('${manifestUrl}'); this.textContent='✓'; setTimeout(()=>this.textContent='❐',1200)">❐</button>
    </div>

    <div class="actions">
      <a class="btn btn-primary" href="${stremioInstallUrl}">Instalar en Stremio</a>
      <button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${manifestUrl}'); this.textContent='¡Copiado!'; setTimeout(()=>this.textContent='Copiar URL',1500)">Copiar URL</button>
    </div>

    <p class="hint">Pega la URL en Stremio → Addons → <a href="${manifestUrl}" target="_blank" rel="noopener">ver manifest.json</a></p>

    <div class="foot">
      <span>v1.0.0</span><span>·</span><code>org.comunidad.torrents.espanol</code>
    </div>
  </main>
<script>
// Feedback simple para copiar en móviles antiguos
document.getElementById('manifestUrl').addEventListener('click', ()=> {
  navigator.clipboard.writeText('${manifestUrl}');
});
</script>
</body>
</html>`;
}

