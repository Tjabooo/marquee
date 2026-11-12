// Dev server for the Rust TV app: serves public/ and the TV shell, and passes API GETs through to a real
// Lilin (LILIN_URL). Anything that would change data (POST, PUT, DELETE) is refused, so browsing a live
// library from a desktop browser is safe.   LILIN_URL=http://host:8080 node tv/rust/dev/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../../..', import.meta.url).pathname);
const upstream = String(process.env.LILIN_URL || '').replace(/\/+$/, '');
const port = Number(process.argv[2] || 8099);
if (!upstream) { console.error('Set LILIN_URL'); process.exit(2); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/tv.html') {
    // The Tizen shell, pointed at this server.
    let html = fs.readFileSync(path.join(root, 'tv/tizen/index.html'), 'utf8')
      .replace('<script src="$WEBAPIS/webapis/webapis.js"></script>', '')
      .replace('<script src="config.js"></script>', `<script>window.LILIN_SERVER=location.origin;try{localStorage.setItem('lilin:tv-session', localStorage.getItem('lilin:tv-session')||'home')}catch(e){}</script>`)
      .replace('<script src="shell.js"></script>', (url.searchParams.has('mock') ? '<script src="/dev-avplay.js"></script>' : '') + '<script src="/shell.js"></script>');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  if (url.pathname === '/dev-avplay.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(fs.readFileSync(new URL('./avplay-mock.js', import.meta.url)));
  }
  if (url.pathname === '/shell.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(fs.readFileSync(path.join(root, 'tv/tizen/shell.js')));
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/c/')) {
    // Subtitles: the TV asks the server to fetch them on every play; that only fills its cache.
    const allowed = req.method === 'POST' && url.pathname === '/api/subs/fetch';
    if (req.method !== 'GET' && !allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'The dev server only reads (blocked ' + req.method + ').' }));
    }
    const headers = {};
    for (const h of ['x-lilin-tv', 'x-lilin-lang', 'x-lilin-session']) if (req.headers[h]) headers[h] = req.headers[h];
    try {
      let body;
      if (allowed) { headers['content-type'] = 'application/json'; body = await new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); }); }
      const r = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, body });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); return res.end(String(e)); }
  }
  const file = path.join(root, 'public', path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('TV dev server on http://localhost:' + port + ' → ' + upstream));
