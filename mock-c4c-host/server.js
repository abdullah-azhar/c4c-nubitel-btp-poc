'use strict';
/**
 * Simulated C4C host (local testing only). In the real test, your C4C tenant
 * is the host: add Nubitel (or the mock Nubitel) as a mashup instead.
 * Env: PORT (default 8081), NUBITEL_URL (default http://localhost:8082/)
 */
const http = require('http');
const path = require('path');
const { serveStatic } = require('../lib/http-util');

function start(env = process.env) {
  const PORT = Number(env.PORT || 8081);
  const NUBITEL_URL = env.NUBITEL_URL || 'http://localhost:8082/';
  const server = http.createServer((req, res) => {
    if (req.url === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(`window.HOST_CONFIG = ${JSON.stringify({ nubitelUrl: NUBITEL_URL, nubitelOrigin: new URL(NUBITEL_URL).origin })};`);
    }
    serveStatic(__dirname, req, res);
  });
  server.listen(PORT, () => console.log(`[c4c-host]     http://localhost:${PORT}  (open this one)`));
  return server;
}

if (require.main === module) start();
module.exports = { start };
