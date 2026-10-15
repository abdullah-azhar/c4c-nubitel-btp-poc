'use strict';
/**
 * BTP lean view: the page Nubitel embeds in an iframe.
 *
 * Serves:
 *   /            the view (public/)
 *   /config.js   runtime config for the page (allowed message origins, deep link)
 *   /api/customer, /api/section/:name   Option B only: token-checked C4C reads
 *
 * Env:
 *   PORT                      default 8083 (BTP Cloud Foundry sets this)
 *   MESSAGE_ORIGINS           origins allowed to postMessage to the view (Nubitel only)
 *   FRAME_ANCESTORS           origins allowed to frame the view: Nubitel AND C4C,
 *                             because browsers check the whole ancestor chain
 *   TOKEN_SECRET              shared secret with Nubitel (Option B)
 *   C4C_UI_URL                C4C tenant URL, for "Open in C4C" deep links
 *   C4C_DEEPLINK_TEMPLATE     optional override; {base} {accountId}
 *   SECTION_TIMEOUT_MS        default 6000
 *   DATA_SOURCE, C4C_*        see lib/c4c-adapter.js
 */
const http = require('http');
const path = require('path');
const { createAdapter, SECTIONS } = require('../lib/c4c-adapter');
const token = require('../lib/token');
const { maskPhone, normalisePhone } = require('../lib/phone');
const { serveStatic, send, list } = require('../lib/http-util');

function start(env = process.env) {
  const PORT = Number(env.PORT || 8083);
  const MESSAGE_ORIGINS = list(env.MESSAGE_ORIGINS || 'http://localhost:8082');
  const FRAME_ANCESTORS = list(env.FRAME_ANCESTORS || 'http://localhost:8082,http://localhost:8081');
  const SECRET = env.TOKEN_SECRET || 'poc-only-change-me';
  const C4C_UI_URL = (env.C4C_UI_URL || 'https://myXXXXXX.crm.ondemand.com').replace(/\/$/, '');
  // TODO confirm the deep-link format for your C4C release (thing-type inspector link)
  const DEEPLINK = env.C4C_DEEPLINK_TEMPLATE ||
    '{base}/sap/public/byd/runtime?bo_ns=http://sap.com/thingTypes&bo=COD_GENERIC&node=Root&operation=OnExtInspect&param.Type=COD_ACCOUNT_TT&param.InternalID={accountId}&sapbyd-agent=TAB';
  const adapter = createAdapter(env);

  if (SECRET === 'poc-only-change-me') console.warn('[btp-view] TOKEN_SECRET not set: using POC default. Never use this outside local testing.');

  const securityHeaders = {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
      `frame-ancestors ${FRAME_ANCESTORS.join(' ')}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
  };
  const apiHeaders = { ...securityHeaders, 'Cache-Control': 'no-store' };

  // Option B: tiny in-memory cache so one token resolves the account once,
  // plus a per-token request budget (basic rate limit).
  const tokenCache = new Map(); // jti -> { exp, account, calls }
  setInterval(() => { const now = Date.now() / 1000; for (const [k, v] of tokenCache) if (v.exp < now) tokenCache.delete(k); }, 30_000).unref();

  function auth(req) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const claims = token.verify(t, SECRET);
    const entry = tokenCache.get(claims.jti) || { exp: claims.exp, account: null, calls: 0 };
    entry.calls += 1;
    if (entry.calls > 20) throw Object.assign(new Error('rate limit'), { code: 429 });
    tokenCache.set(claims.jti, entry);
    return { claims, entry };
  }

  function audit(claims, what, status, ms) {
    console.log(`[audit] agent=${claims.agent || '-'} cid=${claims.cid} phone=${maskPhone(normalisePhone(claims.phone))} ${what} status=${status} ${ms}ms`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/config.js') {
        const cfg = {
          messageOrigins: MESSAGE_ORIGINS,
          deepLinkTemplate: DEEPLINK.replace('{base}', C4C_UI_URL),
          sectionTimeoutMs: Number(env.SECTION_TIMEOUT_MS || 6000),
          sections: SECTIONS,
        };
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders });
        return res.end(`window.VIEW_CONFIG = ${JSON.stringify(cfg)};`);
      }

      if (url.pathname === '/api/customer' && req.method === 'GET') {
        const t0 = Date.now();
        const { claims, entry } = auth(req);
        const r = await adapter.lookupCustomer(claims.phone);
        if (r.status === 'ok') entry.account = r.data.accountId;
        audit(claims, 'customer', r.status, Date.now() - t0);
        return send(res, 200, r, apiHeaders);
      }

      const m = url.pathname.match(/^\/api\/section\/([a-z]+)$/);
      if (m && req.method === 'GET') {
        const t0 = Date.now();
        const { claims, entry } = auth(req);
        // The account always comes from the token's phone number, never from
        // the browser, so a token can only read its own customer's data.
        if (!entry.account) {
          const r = await adapter.lookupCustomer(claims.phone);
          if (r.status !== 'ok') return send(res, 404, { status: r.status }, apiHeaders);
          entry.account = r.data.accountId;
        }
        const r = await adapter.getSection(m[1], entry.account);
        audit(claims, `section=${m[1]}`, r.status, Date.now() - t0);
        return send(res, 200, r, apiHeaders);
      }

      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' }, apiHeaders);
      if (url.pathname === '/health') return send(res, 200, { ok: true, source: adapter.source }, apiHeaders);
      return serveStatic(path.join(__dirname, 'public'), req, res, securityHeaders);
    } catch (e) {
      const code = e.code === 429 ? 429 : /signature|expired|malformed|claims|lifetime/.test(e.message) ? 401 : 502;
      if (code === 502) console.error('[btp-view] error:', e.message);
      return send(res, code, { status: 'error', error: code === 502 ? 'upstream error' : e.message }, apiHeaders);
    }
  });

  server.listen(PORT, () => console.log(`[btp-view] http://localhost:${PORT}  data=${adapter.source}  frame-ancestors=${FRAME_ANCESTORS.join(' ')}`));
  return server;
}

if (require.main === module) start();
module.exports = { start };
