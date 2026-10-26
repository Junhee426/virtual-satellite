// Minimal static server for dist/ (no dependencies). Module scripts and workers need a JavaScript MIME type.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const port = Number(process.env.PORT) || 8000;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = path.join(root, decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}).listen(port, () => console.log(`Virtual Satellite Lab: http://localhost:${port}`));
