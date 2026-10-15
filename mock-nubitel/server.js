'use strict';
/**
 * Mock Nubitel: stands in for the Nubitel agent app so the BTP view and the
 * C4C mashup can be tested before Nubitel builds their side.
 *
 * Its "backend" (/nubitel-api/token) signs a short-lived token that carries the
 * phone number and the external ID of the phone call activity; the page hands the
 * token to the BTP view, which calls C4C itself (security option B).
 *
 * Env:
 *   PORT                 default 8082
 *   VIEW_URL             URL of the BTP view, default http://localhost:8083/
 *   FRAME_ANCESTORS      who may frame Nubitel (the C4C tenant), default http://localhost:8081
 *   HOST_ORIGIN          origin of the C4C host page, for diagnostics messages
 *   TOKEN_SECRET         must match the BTP view
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const token = require('../lib/token');
const { serveStatic, send, readJson, list } = require('../lib/http-util');

function start(env = process.env) {
  const PORT = Number(env.PORT || 8082);
  const VIEW_URL = env.VIEW_URL || 'http://localhost:8083/';
  const FRAME_ANCESTORS = list(env.FRAME_ANCESTORS || 'http://localhost:8081');
  const HOST_ORIGIN = env.HOST_ORIGIN || FRAME_ANCESTORS[0] || '';
  const SECRET = env.TOKEN_SECRET || 'poc-only-change-me';

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

      // Nubitel backend signs a short-lived token for one conversation
      if (url.pathname === '/nubitel-api/token' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.cid || !b.phone) return send(res, 400, { error: 'cid and phone required' }, api);
        const claims = { cid: String(b.cid), phone: String(b.phone), agent: b.agent || 'agent.poc' };
        if (typeof b.externalId === 'string' && b.externalId.length <= 64) claims.ext = b.externalId;
        const ttl = Math.min(Math.max(Number(b.ttl) || 60, 1), 60); // ttl below 60 is only for the expiry test
        return send(res, 200, { token: token.sign(claims, SECRET, ttl) }, api);
      }

      // Third-party cookie test: set a "session" cookie, then check it comes back when framed
      if (url.pathname === '/nubitel-api/cookie-set') {
        const v = crypto.randomUUID();
        return send(res, 200, { set: true }, { ...api, 'Set-Cookie': `nb_session=${v}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600` });
      }
      if (url.pathname === '/nubitel-api/cookie-check') {
        const has = /(?:^|;\s*)nb_session=/.test(req.headers.cookie || '');
        return send(res, 200, { cookieReceived: has }, api);
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
