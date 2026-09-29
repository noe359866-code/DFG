/**
 * Arranque local: adapta el manejador Fetch del Worker (worker.js) al
 * servidor HTTP de Node. En producción el mismo handler corre en
 * Cloudflare Workers y los estáticos los sirve Workers Static Assets.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { handleRequest } = require('./worker');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// Emulación del binding ASSETS de Workers Static Assets para Node local.
const assets = {
  async fetch(request) {
    let relative;
    try {
      const pathname = new URL(request.url).pathname;
      relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
    const file = path.resolve(PUBLIC_DIR, relative);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const data = await fs.readFile(file);
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }
      });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  }
};

function toRequest(req) {
  const headers = [];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(item => headers.push([key, item]));
    else headers.push([key, String(value)]);
  }
  return new Request(`http://${req.headers.host || '127.0.0.1'}${req.url || '/'}`, {
    method: req.method,
    headers
  });
}

function nodeListener(req, res) {
  const env = { ...process.env, ASSETS: assets };
  // Equivalente local de ctx.waitUntil: el trabajo sigue su curso y los
  // errores en segundo plano no rompen la respuesta.
  const ctx = { waitUntil: task => { Promise.resolve(task).catch(() => {}); } };
  handleRequest(toRequest(req), env, ctx).then(async response => {
    const outHeaders = {};
    response.headers.forEach((value, key) => { outHeaders[key] = value; });
    res.writeHead(response.status, outHeaders);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  }).catch(err => {
    console.error('[Server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Error interno' }));
  });
}

if (require.main === module) {
  require('dotenv').config();
  http.createServer(nodeListener).listen(process.env.PORT || 7000, '0.0.0.0', () =>
    console.log(`Nexo Play ${require('./package.json').version} listo`));
}

module.exports = nodeListener;
module.exports.assets = assets;
