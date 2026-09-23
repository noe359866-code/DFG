/**
 * server.js - Servidor universal (local y producción)
 * Ya no usa localhost hardcodeado. Detecta el host real del request.
 * En Vercel no se usa (ahí usa api/index.js), pero si lo despliegas
 * en otro hosting funcionará igual.
 */

require('dotenv').config();
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app = express();
const PORT = process.env.PORT || 7000;

// CORS global
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Landing minimalista (igual que en Vercel) - sin localhost
app.get('/', (req, res) => {
  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioInstallUrl = `stremio://${host}/manifest.json`;

  // Si es localhost, muestra pista local
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Torrents Español HD</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#080a0f;--card:#11131a;--line:#1e2333;--txt:#eef1f8;--muted:#9aa0b6;--accent:#6c5ce7;--accent2:#a78bfa}
  body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,sans-serif}
  .card{width:100%;max-width:520px;background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));border:1px solid var(--line);border-radius:28px;padding:32px 24px;text-align:center}
  .icon{width:64px;height:64px;margin:0 auto 14px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:20px}
  h1{font-size:26px;font-weight:800} h1 span{color:var(--accent)}
  .sub{color:var(--muted);font-size:14px;margin:8px 0 18px}
  .url{font-family:monospace;font-size:12px;color:#a5b4fc;background:#0a0c12;border:1px solid var(--line);border-radius:12px;padding:12px;word-break:break-all;margin-bottom:14px}
  .btn{display:flex;gap:10px;margin-bottom:12px}
  .btn a,.btn button{flex:1;padding:12px;border-radius:12px;font-weight:700;text-decoration:none;cursor:pointer;border:0}
  .primary{background:linear-gradient(135deg,var(--accent),#7c6af0);color:#fff}
  .ghost{background:#151a27;color:#d0d6ea;border:1px solid var(--line) !important}
  .hint{font-size:12px;color:#7a819a} .hint a{color:#a5b4fc}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">★</div>
    <h1><span>Torrents</span> Español HD</h1>
    <p class="sub">Películas, series y anime en Español<br>Castellano · Latino · Dual · VOS</p>
    <div class="url"><small style="letter-spacing:.1em;color:#7a819a">MANIFEST URL</small><br>${manifestUrl}</div>
    <div class="btn">
      <a class="primary" href="${stremioInstallUrl}">Instalar en Stremio</a>
      <button class="ghost" onclick="navigator.clipboard.writeText('${manifestUrl}');this.textContent='¡Copiado!'">Copiar URL</button>
    </div>
    <p class="hint">
      ${isLocal ? `Local: <a href="${manifestUrl}">${manifestUrl}</a>` : `Pega la URL en Stremio → Addons → <a href="${manifestUrl}" target="_blank">ver manifest.json</a>`}
      <br><small><a href="${baseUrl}/health">health</a> · <a href="${baseUrl}/stream/movie/tt0111161.json">test stream</a></small>
    </p>
  </div>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', manifest: addonInterface.manifest, env: !!process.env.SUPABASE_URL });
});

// Montar router Stremio (maneja /manifest.json y /stream/*)
app.use(getRouter(addonInterface));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Torrents Español HD corriendo`);
  console.log(`   Local → http://localhost:${PORT}/manifest.json`);
  console.log(`   Red   → Configurado para detectar host automáticamente (ya no hardcodea localhost)\n`);
});

module.exports = app;
