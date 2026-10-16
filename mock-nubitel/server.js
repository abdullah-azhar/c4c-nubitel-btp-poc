'use strict';
/**
 * Mock Nubitel: stands in for the Nubitel agent app so the BTP view and the
 * C4C mashup can be tested before Nubitel builds their side.
 *
 * The agent signs in first (session cookie, see lib/nubitel-routes.js). Its "backend"
 * (/nubitel-api/*) then lists the agent's conversations and signs a short-lived token
 * for the BTP view that carries the phone number and the external ID of the phone call
 * activity (security option B).
 *
 * Env:
 *   PORT                 default 8082
 *   VIEW_URL             URL of the BTP view, default http://localhost:8083/
 *   FRAME_ANCESTORS      who may frame Nubitel (the C4C tenant), default http://localhost:8081
 *   HOST_ORIGIN          origin of the C4C host page, for diagnostics messages
 *   TOKEN_SECRET         must match the BTP view
 *   MOCK_USERS, SESSION_SECRET, SESSION_IDLE_SECONDS, SESSION_MAX_HOURS, ALLOW_TEST_HOOKS
 *                        sign-in and session settings, see lib/nubitel-routes.js
 */
const http = require('http');
const path = require('path');
const { createRoutes } = require('../lib/nubitel-routes');
const { serveStatic, send, readJson, list } = require('../lib/http-util');

function start(env = process.env) {
  const PORT = Number(env.PORT || 8082);
  const VIEW_URL = env.VIEW_URL || 'http://localhost:8083/';
  const FRAME_ANCESTORS = list(env.FRAME_ANCESTORS || 'http://localhost:8081');
  const HOST_ORIGIN = env.HOST_ORIGIN || FRAME_ANCESTORS[0] || '';
  const route = createRoutes(env);

  const headers = {
    'Content-Security-Policy': `frame-ancestors 'self' ${FRAME_ANCESTORS.join(' ')}`,
    'X-Content-Type-Options': 'nosniff',
  };
  const api = { ...headers, 'Cache-Control': 'no-store' };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', ...headers });
        return res.end(`window.NB_CONFIG = ${JSON.stringify({ viewUrl: VIEW_URL, viewOrigin: new URL(VIEW_URL).origin, hostOrigin: HOST_ORIGIN })};`);
      }

      if (url.pathname.startsWith('/nubitel-api/')) {
        const name = url.pathname.slice('/nubitel-api/'.length);
        let body = {};
        if (req.method === 'POST') { try { body = await readJson(req, 2000); } catch (_) { return send(res, 400, { error: 'bad request' }, api); } }
        const r = await route(name, { method: req.method, headers: req.headers, body, ip: req.socket.remoteAddress });
        const h = { ...api };
        if (r.cookies.length) h['Set-Cookie'] = r.cookies;
        return send(res, r.status, r.json, h);
      }

      return serveStatic(path.join(__dirname, 'public'), req, res, headers);
    } catch (e) {
      return send(res, 500, { error: 'server error' }, api);
    }
  });

  server.listen(PORT, () => console.log(`[mock-nubitel] http://localhost:${PORT}  view=${VIEW_URL}  frame-ancestors=${FRAME_ANCESTORS.join(' ')}`));
  return server;
}

if (require.main === module) start();
module.exports = { start };
