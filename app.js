const express = require('express');
const path = require('node:path');
const compression = require('compression');
const { getRouter } = require('stremio-addon-sdk');
const addon = require('./addon');
const app = express();
app.disable('x-powered-by');
// gzip/deflate negociados; no comprimir imágenes ni respuestas pequeñas.
app.use(compression({ threshold: 1024, level: 4 }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD, OPTIONS').json({ error: 'Método no permitido' });
  next();
});
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d', index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok', version: addon.manifest.version }));
app.get('/manifest.json', (req, res) => {
  // Validate the origin before placing it in public metadata. Never inject request headers into HTML.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const valid = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && ['http', 'https'].includes(proto);
  // El manifiesto se cachea brevemente en el edge: absorbe las oleadas de
  // instalación sin invocar la función. El logo depende del host, pero el
  // despliegue productivo tiene un único dominio canónico.
  res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600').json({ ...addon.manifest,
    ...(valid ? { logo: `${proto}://${host}/assets/brand.png`, icon: `${proto}://${host}/assets/brand.png` } : {}) });
});
// El SDK solo emite max-age; duplicarlo como s-maxage habilita la caché de
// edge de Vercel también para las respuestas de streams, sin tocar la librería.
const sdkRouter = getRouter(addon);
const edgeCacheControl = (req, res, next) => {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (key, value) => {
    if (String(key).toLowerCase() === 'cache-control' && typeof value === 'string' && !value.includes('s-maxage')) {
      const match = /(?:^|,)\s*max-age=(\d+)/.exec(value);
      if (match) value = `s-maxage=${match[1]}, ${value}`;
    }
    return setHeader(key, value);
  };
  sdkRouter(req, res, next);
};
// Un fallo sin directivas del SDK nunca debe almacenarse por heurística.
app.use('/stream', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(edgeCacheControl);
app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno' });
});
module.exports = app;
module.exports.edgeCacheControl = edgeCacheControl;
