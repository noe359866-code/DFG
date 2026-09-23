/**
 * server.js - Servidor local para desarrollo
 * No se usa en Vercel (allí se usa api/index.js), solo para `npm start`
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

// Landing simple en local
app.get('/', (req, res) => {
  const manifestUrl = `http://localhost:${PORT}/manifest.json`;
  res.send(`
    <h2>Torrents Español HD - Local Dev</h2>
    <p>Manifest: <a href="${manifestUrl}">${manifestUrl}</a></p>
    <p>Ejemplo movie: <a href="http://localhost:${PORT}/stream/movie/tt0111161.json">/stream/movie/tt0111161.json</a></p>
    <p>Ejemplo serie: <a href="http://localhost:${PORT}/stream/series/tt0944947:1:1.json">/stream/series/tt0944947:1:1.json</a></p>
    <p>Health: <a href="http://localhost:${PORT}/health">/health</a></p>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', manifest: addonInterface.manifest, env: !!process.env.SUPABASE_URL });
});

// Montar router Stremio (maneja /manifest.json y /stream/*)
app.use(getRouter(addonInterface));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Torrents Español HD corriendo en http://localhost:${PORT}`);
  console.log(`   Manifest → http://localhost:${PORT}/manifest.json`);
  console.log(`   Test movie → http://localhost:${PORT}/stream/movie/tt0111161.json`);
  console.log(`   Test series → http://localhost:${PORT}/stream/series/tt0944947:1:1.json\n`);
});
