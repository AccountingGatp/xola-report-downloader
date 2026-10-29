// Local test server: serves public/ and runs every api/*.js handler.
// Usage: APP_PASSWORD=x XOLA_API_KEY=y node dev-server.js 3000        (add XOLA_BASE=http://localhost:4010 to use test/mock-xola.js)
const http = require('http'), fs = require('fs'), path = require('path');
http.createServer((req, res) => {
  const m = req.url.match(/^\/api\/([A-Za-z0-9_-]+)/);
  if (m && !m[1].startsWith('_') && fs.existsSync(path.join(__dirname, 'api', m[1] + '.js'))) {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { req.body = d ? JSON.parse(d) : undefined; } catch (e) { req.body = undefined; } require('./api/' + m[1] + '.js')(req, res); });
    return;
  }
  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(+process.argv[2] || 3000);
