const app = require('../app');
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
