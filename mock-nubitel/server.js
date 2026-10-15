'use strict';
/**
 * Mock Nubitel: stands in for the Nubitel agent app so the BTP view and the
 * C4C mashup can be tested before Nubitel builds their side.
 *
 * It plays both roles Nubitel would have:
 *   Option A: its "backend" (/nubitel-api/lookup) calls C4C and the page pushes
 *             section.update messages into the BTP view.
 *   Option B: its "backend" (/nubitel-api/token) signs a short-lived token and
 *             the page hands it to the BTP view.
 *
 * Env:
 *   PORT                 default 8082
 *   VIEW_URL             URL of the BTP view, default http://localhost:8083/
 *   FRAME_ANCESTORS      who may frame Nubitel (the C4C tenant), default http://localhost:8081
 *   HOST_ORIGIN          origin of the C4C host page, for diagnostics messages
 *   TOKEN_SECRET         must match the BTP view (Option B)
 *   DATA_SOURCE, C4C_*   see lib/c4c-adapter.js (Option A calls C4C from here)
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { createAdapter, SECTIONS } = require('../lib/c4c-adapter');
const token = require('../lib/token');
const { serveStatic, send, readJson, list } = require('../lib/http-util');

function start(env = process.env) {
  const PORT = Number(env.PORT || 8082);
  const VIEW_URL = env.VIEW_URL || 'http://localhost:8083/';
  const FRAME_ANCESTORS = list(env.FRAME_ANCESTORS || 'http://localhost:8081');
  const HOST_ORIGIN = env.HOST_ORIGIN || FRAME_ANCESTORS[0] || '';
  const SECRET = env.TOKEN_SECRET || 'poc-only-change-me';
  const adapter = createAdapter(env);

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
        return res.end(`window.NB_CONFIG = ${JSON.stringify({ viewUrl: VIEW_URL, viewOrigin: new URL(VIEW_URL).origin, hostOrigin: HOST_ORIGIN, sections: SECTIONS })};`);
      }

      // Option A: Nubitel backend calls C4C (server-side, credentials never reach the browser)
      if (url.pathname === '/nubitel-api/lookup') {
        const section = url.searchParams.get('section');
        try {
          if (section === 'customer') return send(res, 200, await adapter.lookupCustomer(url.searchParams.get('phone')), api);
          return send(res, 200, await adapter.getSection(section, url.searchParams.get('accountId')), api);
        } catch (e) {
          return send(res, 200, { status: 'error' }, api);
        }
      }

      // Option B: Nubitel backend signs a short-lived token for one conversation
      if (url.pathname === '/nubitel-api/token' && req.method === 'POST') {
        const b = await readJson(req);
        if (!b.cid || !b.phone) return send(res, 400, { error: 'cid and phone required' }, api);
        return send(res, 200, { token: token.sign({ cid: b.cid, phone: b.phone, agent: b.agent || 'agent.poc' }, SECRET, 60) }, api);
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
