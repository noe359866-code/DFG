const { waitUntil } = require('@vercel/functions');
const app = require('../app');
// Vercel inyecta su waitUntil para que la revalidación en segundo plano de
// addon.js sobreviva a la respuesta (Cloudflare Workers hace lo propio con
// ctx.waitUntil desde worker.mjs).
require('../addon').setKeepAlive(waitUntil);
module.exports = (req, res) => {
  // Vercel forwards rewrites through __path; the SDK must see the original route.
  const url = new URL(req.url || '/', 'http://internal');
  const route = url.searchParams.get('__path');
  if (route && route.startsWith('/') && !route.startsWith('//') && !/[\r\n?#]/.test(route)) {
    url.searchParams.delete('__path');
    req.url = route + (url.searchParams.size ? `?${url.searchParams}` : '');
  }
  return app(req, res);
};
