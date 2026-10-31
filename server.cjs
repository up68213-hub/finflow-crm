const http = require('http');
const fs = require('fs');
const path = require('path');
const { dbPath, getState, replaceState } = require('./database.cjs');

const root = path.join(__dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };

http.createServer((req, res) => {
  if (req.url === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getState()));
    return;
  }
  if (req.url === '/api/state' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try { replaceState(JSON.parse(body)); res.writeHead(204).end(); }
      catch (error) { console.error(error); res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({error:error.message})); }
    });
    return;
  }
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(3000, '127.0.0.1', () => { console.log('FinFlow CRM: http://localhost:3000'); console.log('SQLite:', dbPath); });
