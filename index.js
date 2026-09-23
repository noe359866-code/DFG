module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  // Vercel ahora reescribe a /api/index, la ruta real viene en ?__path= o en headers
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const originalPath = parsedUrl.searchParams.get('__path') 
    || req.headers['x-matched-path'] 
    || req.headers['x-vercel-matched-path']
    || parsedUrl.pathname;
  // reconstruir URL limpia para el router
  const url = originalPath.split('?')[0];
  // mantener query original si había ?__path
  req.url = url + (parsedUrl.search ? '' : ''); // el router solo necesita el path
