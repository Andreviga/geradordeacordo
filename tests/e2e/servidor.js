// tests/e2e/servidor.js — servidor estático mínimo para os smoke tests
// Usa apenas módulos nativos do Node.js (sem dependências npm).
// Não expõe /api/ — as chamadas de API são interceptadas pelo Playwright.

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 4321;
const ROOT = path.resolve(__dirname, '../../');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // Não servir arquivos fora do ROOT (path traversal protection)
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // /api/* retorna 503 no servidor de testes (devem ser mockadas pelo Playwright)
  if (urlPath.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'API não disponível no servidor de testes. Use page.route() para mockar.' }));
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Servidor de testes em http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT',  () => server.close());
