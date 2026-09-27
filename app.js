const express = require('express');
const path = require('node:path');
const { getRouter } = require('stremio-addon-sdk');
const addon = require('./addon');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD, OPTIONS').json({ error: 'Método no permitido' });
  next();
});
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1d', index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok', version: addon.manifest.version }));
app.get('/manifest.json', (req, res) => {
  // Validate the origin before placing it in public metadata. Never inject request headers into HTML.
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const valid = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && ['http', 'https'].includes(proto);
  res.set('Cache-Control', 'no-cache').json({ ...addon.manifest,
    ...(valid ? { logo: `${proto}://${host}/assets/brand.png`, icon: `${proto}://${host}/assets/brand.png` } : {}) });
});
app.use(getRouter(addon));
app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno' });
});
module.exports = app;
