'use strict';
/**
 * BTP lean view: the page Nubitel embeds in an iframe. Security option B only:
 * Nubitel's backend signs a short-lived token (phone number, external ID of the
 * phone call activity, agent); this server verifies it and calls C4C.
 *
 * Serves:
 *   /               the view (public/), ONLY when loaded as a frame by a browser;
 *                   opened directly it shows a locked screen
 *   /config.js      runtime config for the page (same rule as above)
 *   /health         liveness, no data
 *   /api/customer                     who is on the line (activity external ID first, then phone)
 *   /api/section/:name?contact=<id>   order | tasks | reco for that contact's account
 *   /api/contacts/search?q=           existing contacts (unknown-caller flow)
 *   /api/accounts/search?q=           accounts (create-contact form)
 *   POST /api/contact                 create a contact / save the number on a contact (needs ALLOW_WRITES)
 *
 * Env:
 *   PORT                      default 8083 (BTP sets this)
 *   MESSAGE_ORIGINS           origins allowed to postMessage to the view (Nubitel only)
 *   FRAME_ANCESTORS           origins allowed to frame the view: Nubitel AND C4C
 *   TOKEN_SECRET              shared secret with Nubitel
 *   C4C_UI_URL                C4C tenant URL, for "open in C4C" links
 *   C4C_LINK_BASE             optional: the sign-in part of those links (default has saml2=disabled,
 *                             right for user/password tenants; drop it for single sign-on)
 *   SECTION_TIMEOUT_MS        default 6000
 *   CACHE_TTL_SECONDS         how long the page reuses what it loaded (default 300, 0 = off)
 *   ALLOW_WRITES              "true" lets the view create/update contacts (default off)
 *   ALLOW_DIRECT_OPEN         "true" lets the page open outside a frame (debugging only)
 *   SHOW_DIAGNOSTICS          "true" shows the timing footer (testing only)
 *   DATA_SOURCE, C4C_*        see lib/c4c-adapter.js
 */
const http = require('http');
const path = require('path');
const { createAdapter, SECTIONS } = require('../lib/c4c-adapter');
const token = require('../lib/token');
const { maskPhone, normalisePhone } = require('../lib/phone');
const { defaultLinks } = require('../lib/c4c-links');
const { serveStatic, send, readJson, list } = require('../lib/http-util');

const CALL_BUDGET = 80;            // data calls one token may make (typing in search counts)
const CTX_TTL_MS = 120_000;        // how long "who is this" is remembered for validating later calls
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const LOCKED_PAGE = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Locked</title>' +
  '<style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1f2a2e;background:#f6f8f8}' +
  'main{text-align:center;max-width:320px;padding:16px}h1{font-size:16px;margin:0 0 6px}p{margin:0;color:#556066}</style>' +
  '<main><h1>Customer snapshot is locked</h1><p>This view opens only inside the agent application. Open a conversation there.</p></main>';

function start(env = process.env) {
  const PORT = Number(env.PORT || 8083);
  const MESSAGE_ORIGINS = list(env.MESSAGE_ORIGINS || 'http://localhost:8082');
  const FRAME_ANCESTORS = list(env.FRAME_ANCESTORS || 'http://localhost:8082,http://localhost:8081');
  const SECRET = env.TOKEN_SECRET || 'poc-only-change-me';
  const C4C_UI_URL = (env.C4C_UI_URL || 'https://myXXXXXX.crm.ondemand.com').replace(/\/$/, '');
  const ALLOW_WRITES = env.ALLOW_WRITES === 'true';
  const ALLOW_DIRECT_OPEN = env.ALLOW_DIRECT_OPEN === 'true';
  const SHOW_DIAGNOSTICS = env.SHOW_DIAGNOSTICS === 'true';
  const adapter = createAdapter(env);
  // How long the page may reuse what it already loaded when the agent switches back to a chat.
  // Seconds; 0 turns the saved copy off. In page memory only, never stored.
  const ttlSeconds = env.CACHE_TTL_SECONDS === undefined || env.CACHE_TTL_SECONDS === '' ? 300 : Number(env.CACHE_TTL_SECONDS);
  const CACHE_TTL_MS = Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? Math.round(ttlSeconds * 1000) : 300000;

  // "Open in C4C" links: which screen each object opens and by which ID (see lib/c4c-links.js, taken from real
  // links of the test tenant). The page builds the address; C4C_LINK_BASE replaces the sign-in part of it.
  const LINKS = defaultLinks(C4C_UI_URL, env.C4C_LINK_BASE);

  if (SECRET === 'poc-only-change-me') console.warn('[btp-view] TOKEN_SECRET not set: using POC default. Never use this outside local testing.');
  if (ALLOW_WRITES && adapter.source === 'c4c') console.warn('[btp-view] ALLOW_WRITES=true with DATA_SOURCE=c4c: agents can change real C4C contacts.');

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
    'X-Robots-Tag': 'noindex',
  };
  const pageHeaders = { ...securityHeaders, 'Cache-Control': 'no-store' };
  const apiHeaders = { ...securityHeaders, 'Cache-Control': 'no-store' };

  // Browsers tell the server what a request is for (Sec-Fetch-Dest) and page scripts cannot fake it.
  // The page and its files are only handed out when they are loaded as a frame, script, style or image,
  // never as a top-level document, so pasting the link in a browser shows nothing but a locked screen.
  const isFrameLoad = (req) => {
    const dest = req.headers['sec-fetch-dest'];
    return !!dest && !['document', 'embed', 'object'].includes(dest);
  };

  // Per-token call budget (basic rate limit)
  const tokenCalls = new Map(); // jti -> { exp, calls }
  // Who is on the line, per conversation, so section calls can be checked against it.
  const ctxCache = new Map();   // "cid|phone|ext" -> { at, result }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tokenCalls) if (v.exp < now / 1000) tokenCalls.delete(k);
    for (const [k, v] of ctxCache) if (now - v.at > CTX_TTL_MS) ctxCache.delete(k);
  }, 30_000).unref();

  const ctxKey = (c) => `${c.cid}|${c.phone}|${c.ext || ''}`;

  function auth(req) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const claims = token.verify(t, SECRET);
    const entry = tokenCalls.get(claims.jti) || { exp: claims.exp, calls: 0 };
    entry.calls += 1;
    if (entry.calls > CALL_BUDGET) throw Object.assign(new Error('rate limit'), { code: 429 });
    tokenCalls.set(claims.jti, entry);
    return claims;
  }

  async function resolveFor(claims, fresh) {
    const key = ctxKey(claims);
    const hit = ctxCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CTX_TTL_MS) return hit.result;
    const result = await adapter.resolve({ phone: claims.phone, externalId: claims.ext });
    ctxCache.set(key, { at: Date.now(), result });
    return result;
  }

  function audit(claims, what, status, ms) {
    console.log(`[audit] agent=${claims.agent || '-'} cid=${claims.cid} phone=${maskPhone(normalisePhone(claims.phone))} ${what} status=${status} ${ms}ms`);
  }

  async function handleApi(req, res, url) {
    const t0 = Date.now();
    const claims = auth(req);
    const fresh = /no-cache/i.test(req.headers['cache-control'] || '');

    if (url.pathname === '/api/customer' && req.method === 'GET') {
      const r = await resolveFor(claims, fresh);
      const out = r.status === 'not_found' ? { status: 'not_found', data: { phone: claims.phone } } : r;
      audit(claims, `customer via=${r.via || '-'}`, r.status, Date.now() - t0);
      return send(res, 200, out, apiHeaders);
    }

    const m = url.pathname.match(/^\/api\/section\/([a-z]+)$/);
    if (m && req.method === 'GET') {
      if (!SECTIONS.includes(m[1])) return send(res, 404, { error: 'not found' }, apiHeaders);
      // The customer always comes from the token, never from the browser. The only thing the
      // browser may choose is which of the token's own matches (several contacts on one number).
      const r = await resolveFor(claims, fresh);
      const wanted = url.searchParams.get('contact');
      const match = r.status === 'ok' ? r.data : r.status === 'multiple' ? (r.data.find((x) => x.contactId === wanted) || null) : null;
      if (!match) return send(res, r.status === 'multiple' ? 409 : 404, { status: r.status === 'multiple' ? 'choose' : 'not_found' }, apiHeaders);
      if (r.status === 'ok' && wanted && wanted !== match.contactId) return send(res, 403, { status: 'forbidden' }, apiHeaders);
      const out = await adapter.getSection(m[1], { accountId: match.accountId, contactId: match.contactId });
      audit(claims, `section=${m[1]}`, out.status, Date.now() - t0);
      return send(res, 200, out, apiHeaders);
    }

    if ((url.pathname === '/api/contacts/search' || url.pathname === '/api/accounts/search') && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      if (q.length < 2) return send(res, 200, { status: 'ok', data: [] }, apiHeaders);
      const rows = url.pathname.includes('contacts') ? await adapter.searchContacts(q) : await adapter.searchAccounts(q);
      audit(claims, `${url.pathname.includes('contacts') ? 'contact' : 'account'}-search results=${rows.length}`, 'ok', Date.now() - t0);
      return send(res, 200, { status: 'ok', data: rows }, apiHeaders);
    }

    if (url.pathname === '/api/contact' && req.method === 'POST') {
      if (!ALLOW_WRITES) return send(res, 403, { status: 'disabled' }, apiHeaders);
      const b = await readJson(req, 4000);
      // The number being saved is the one on the token (the live call), never a value from the browser.
      const phone = '+' + normalisePhone(claims.phone);
      let out;
      if (b.mode === 'update') {
        if (!ID_RE.test(String(b.contactId || ''))) return send(res, 400, { status: 'bad_request', field: 'contactId' }, apiHeaders);
        out = await adapter.updateContactPhone({ contactId: b.contactId, phone });
      } else if (b.mode === 'create') {
        const firstName = String(b.firstName || '').trim().slice(0, 40);
        const lastName = String(b.lastName || '').trim().slice(0, 40);
        const email = String(b.email || '').trim();
        if (!lastName) return send(res, 400, { status: 'bad_request', field: 'lastName' }, apiHeaders);
        if (!ID_RE.test(String(b.accountId || ''))) return send(res, 400, { status: 'bad_request', field: 'accountId' }, apiHeaders);
        if (email && !EMAIL_RE.test(email)) return send(res, 400, { status: 'bad_request', field: 'email' }, apiHeaders);
        out = await adapter.createContact({ firstName, lastName, accountId: b.accountId, email, phone });
      } else {
        return send(res, 400, { status: 'bad_request', field: 'mode' }, apiHeaders);
      }
      ctxCache.delete(ctxKey(claims)); // the number now belongs to a contact: look again next time
      audit(claims, `contact-${b.mode} contact=${out.contactId}`, 'ok', Date.now() - t0);
      return send(res, 200, { status: 'ok', data: out }, apiHeaders);
    }

    return send(res, 404, { error: 'not found' }, apiHeaders);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, source: adapter.source }, apiHeaders);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      // Everything else is the page and its files: only inside the agent application's frame.
      if (!ALLOW_DIRECT_OPEN && !isFrameLoad(req)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(LOCKED_PAGE);
      }
      if (url.pathname === '/config.js') {
        const cfg = {
          messageOrigins: MESSAGE_ORIGINS,
          sectionTimeoutMs: Number(env.SECTION_TIMEOUT_MS || 6000),
          cacheTtlMs: CACHE_TTL_MS,
          sections: SECTIONS,
          links: LINKS,
          writesEnabled: ALLOW_WRITES,
          showDiagnostics: SHOW_DIAGNOSTICS,
        };
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...pageHeaders });
        return res.end(`window.VIEW_CONFIG = ${JSON.stringify(cfg)};`);
      }
      return serveStatic(path.join(__dirname, 'public'), req, res, pageHeaders);
    } catch (e) {
      const code = e.code === 429 ? 429 : e.code === 'bad_request' ? 400 : /signature|expired|malformed|claims|lifetime/.test(e.message) ? 401 : 502;
      if (code === 502) console.error('[btp-view] error:', e.message);
      return send(res, code, { status: 'error', error: code === 502 ? 'upstream error' : e.message }, apiHeaders);
    }
  });

  server.listen(PORT, () => console.log(`[btp-view] http://localhost:${PORT}  data=${adapter.source}  writes=${ALLOW_WRITES}  frame-ancestors=${FRAME_ANCESTORS.join(' ')}`));
  return server;
}

if (require.main === module) start();
module.exports = { start };
