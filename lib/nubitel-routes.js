'use strict';
/**
 * The mock Nubitel's "backend": sign-in, session, the agent's conversations and the
 * view token. One implementation shared by the local Node server and the Vercel function,
 * so both behave the same.
 *
 *   POST login          { username, password }     -> session cookie
 *   POST logout                                    -> cookie cleared
 *   GET  session                                   -> who is signed in (does not extend the session)
 *   GET  conversations                             -> the agent's conversations (needs a session)
 *   POST token          { cid }                    -> signed token for the BTP view (needs a session)
 *   GET  cookie-set / cookie-check                 -> third-party cookie probe, no sign-in needed
 *
 * Session = a signed, HttpOnly cookie (no server memory, so it works on serverless):
 *   nb_session=<payload>.<signature>; HttpOnly; Secure; SameSite=None; Partitioned
 * SameSite=None and Partitioned are what let it work when Nubitel runs in an iframe inside C4C.
 * Idle timeout (sliding) and an absolute lifetime are both enforced on the server.
 * POST routes also need the header X-NB: 1, which a cross-site page cannot send (CSRF defence).
 *
 * Env:
 *   MOCK_USERS             JSON: [{"id":"james.theng","name":"James Theng","password":"..."}]
 *                          (or that JSON as base64). None configured = nobody can sign in
 *   SESSION_SECRET         signs the session cookie (falls back to TOKEN_SECRET)
 *   TOKEN_SECRET           signs the view token (shared with the BTP view)
 *   SESSION_IDLE_SECONDS   default 1800 (30 minutes without activity)
 *   SESSION_MAX_HOURS      default 8
 *   ALLOW_TEST_HOOKS       "true" lets a test shorten a session (idleSeconds on login)
 */
const crypto = require('crypto');
const token = require('./token');

const COOKIE = 'nb_session';
const PROBE = 'nb_probe';
const MAX_ATTEMPTS = 5;           // wrong passwords per user and address ...
const WINDOW_S = 300;             // ... within this many seconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

// The conversations a mock agent is assigned. The browser only ever sees the public fields;
// the phone number and the External ID that go into the view token stay on the server.
// externalId = the ID of the C4C phone call activity that Nubitel keeps as the conversation's External ID.
const CONVERSATIONS = [
  { id: 'conv-2294', externalId: '4100234', name: 'Jenna Hopkins', phone: '+60 8347 2856', channel: 'whatsapp', note: 'Happy path (found by activity)', msgs: [['c', 'Hi, can I reorder Vitamin C 1000mg? Same as last month.']] },
  { id: 'conv-3492', externalId: '4100235', name: 'Kumar Singh', phone: '012-345 6789', channel: 'voice', note: 'Slow sections', msgs: [['c', '(voice call in progress)']] },
  { id: 'conv-3243', externalId: '4100237', name: 'June Wong', phone: '+60 16-222 3333', channel: 'whatsapp', note: 'Two matching contacts', msgs: [['c', 'Hello, checking on my order.']] },
  { id: 'conv-5120', externalId: '4100236', name: 'Ali Hassan', phone: '019-876 5432', channel: 'whatsapp', note: 'Order fails to load', msgs: [['c', 'Is my delivery coming today?']] },
  { id: 'conv-5333', externalId: '4100238', name: 'Mei Ling Tan', phone: '017-777 8888', channel: 'whatsapp', note: 'No order, no tasks', msgs: [['c', 'Do you have Zinc 25mg in stock?']] },
  { id: 'conv-6001', externalId: '4100239', name: '+60 11-5555 0000', phone: '011-5555 0000', channel: 'whatsapp', note: 'Unknown caller', msgs: [['c', 'Hi, I would like to order.']] },
  { id: 'conv-6002', externalId: '4100240', name: '+60 18-222 9999', phone: '018-222 9999', channel: 'voice', note: 'Unknown caller (2)', msgs: [['c', '(voice call in progress)']] },
];
const publicConv = (c) => ({ id: c.id, name: c.name, phone: c.phone, channel: c.channel, note: c.note, msgs: c.msgs });

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}

function createRoutes(env = process.env) {
  const SESSION_SECRET = env.SESSION_SECRET || env.TOKEN_SECRET || 'poc-only-change-me';
  const TOKEN_SECRET = env.TOKEN_SECRET || 'poc-only-change-me';
  const IDLE_S = Math.max(Number(env.SESSION_IDLE_SECONDS) || 1800, 1);
  const ABS_S = Math.max(Number(env.SESSION_MAX_HOURS) || 8, 0.01) * 3600;
  const HOOKS = env.ALLOW_TEST_HOOKS === 'true';

  // Passwords are never kept: each is turned into a salted scrypt hash when the server starts.
  const users = [];
  // MOCK_USERS is the JSON itself, or the JSON as base64 (easier to paste into CLIs and dashboards: no quotes to escape)
  const rawUsers = String(env.MOCK_USERS || '').trim();
  const usersJson = !rawUsers ? '[]' : rawUsers.startsWith('[') ? rawUsers : Buffer.from(rawUsers, 'base64').toString('utf8');
  try {
    (JSON.parse(usersJson) || []).forEach((u) => {
      if (!u || !u.id || !u.password) return;
      const salt = crypto.randomBytes(16);
      users.push({ id: String(u.id), name: String(u.name || u.id), salt, hash: crypto.scryptSync(String(u.password), salt, 32) });
    });
  } catch (_) { /* invalid MOCK_USERS: nobody can sign in */ }
  const dummySalt = crypto.randomBytes(16);
  const failures = new Map(); // "ip|user" -> { n, first }

  const sign = (obj) => {
    const p = b64u(JSON.stringify(obj));
    return `${p}.${b64u(crypto.createHmac('sha256', SESSION_SECRET).update('session:' + p).digest())}`;
  };
  function verify(value) {
    if (typeof value !== 'string' || !value.includes('.')) return null;
    const [p, sig] = value.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update('session:' + p).digest();
    const given = Buffer.from(sig || '', 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (_) { return null; }
  }

  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
  const now = () => Math.floor(Date.now() / 1000);

  // Returns { s, state }: state is "ok", "none" (no cookie) or "expired" (cookie present but no longer valid)
  function readSession(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return { s: null, state: 'none' };
    const s = verify(raw);
    if (!s || !s.sub || s.exp < now() || s.abs < now()) return { s: null, state: 'expired' };
    return { s, state: 'ok' };
  }

  function issue(user, idle) {
    const t = now();
    const s = { sub: user.id, name: user.name, iat: t, exp: t + idle, abs: t + ABS_S, idle };
    return { s, cookie: cookie(COOKIE, sign(s), idle) };
  }

  // Sliding idle timeout: activity renews the cookie (at most about once a minute), never past the absolute limit.
  function renew(s) {
    const t = now();
    if (s.exp - t > s.idle - 30) return { s, cookie: null };
    const next = { ...s, exp: Math.min(t + s.idle, s.abs) };
    return { s: next, cookie: cookie(COOKIE, sign(next), Math.max(next.exp - t, 1)) };
  }

  const sessionInfo = (s) => ({ idleExpiresAt: s.exp, absExpiresAt: s.abs });
  const out = (status, json, cookies) => ({ status, json, cookies: cookies || [] });
  const denied = (state) => out(401, { authenticated: false, reason: state === 'expired' ? 'expired' : 'none' });

  return async function route(name, req) {
    const method = req.method || 'GET';
    const h = (k) => String(req.headers[k] || '');
    const needPost = () => (method !== 'POST' ? out(405, { error: 'POST only' }) : h('x-nb') !== '1' ? out(403, { error: 'missing header' }) : null);

    switch (name) {
      case 'login': {
        const bad = needPost(); if (bad) return bad;
        if (!users.length) return out(503, { error: 'Sign-in is not configured in this environment.' });
        const b = req.body || {};
        const username = String(b.username || '').slice(0, 100);
        const password = String(b.password || '').slice(0, 200);
        const key = `${req.ip || ''}|${username.toLowerCase()}`;
        const f = failures.get(key);
        if (f && now() - f.first > WINDOW_S) failures.delete(key);
        const cur = failures.get(key);
        if (cur && cur.n >= MAX_ATTEMPTS) return out(429, { error: 'Too many attempts. Try again in a few minutes.', retryAfter: WINDOW_S - (now() - cur.first) });

        const user = users.find((u) => u.id.toLowerCase() === username.toLowerCase());
        const hash = crypto.scryptSync(password, user ? user.salt : dummySalt, 32); // same work for unknown users
        const ok = user && crypto.timingSafeEqual(hash, user.hash);
        if (!ok) {
          const rec = failures.get(key) || { n: 0, first: now() };
          rec.n += 1; failures.set(key, rec);
          await sleep(400); // slows guessing a little
          return out(401, { error: 'Wrong username or password.' });
        }
        failures.delete(key);
        const idle = HOOKS && Number(b.idleSeconds) >= 1 && Number(b.idleSeconds) < IDLE_S ? Math.floor(Number(b.idleSeconds)) : IDLE_S;
        const { s, cookie: c } = issue(user, idle);
        return out(200, { authenticated: true, agent: { id: s.sub, name: s.name }, session: sessionInfo(s) }, [c]);
      }

      case 'logout': {
        const bad = needPost(); if (bad) return bad;
        return out(200, { authenticated: false }, [cookie(COOKIE, '', 0)]);
      }

      case 'session': {
        const { s, state } = readSession(req); // read only: asking does not keep the session alive
        if (!s) return denied(state);
        return out(200, { authenticated: true, agent: { id: s.sub, name: s.name }, session: sessionInfo(s) });
      }

      case 'conversations': {
        const { s, state } = readSession(req);
        if (!s) return denied(state);
        const r = renew(s);
        return out(200, { agent: { id: s.sub, name: s.name }, conversations: CONVERSATIONS.map(publicConv), session: sessionInfo(r.s) }, r.cookie ? [r.cookie] : []);
      }

      case 'token': {
        const bad = needPost(); if (bad) return bad;
        const { s, state } = readSession(req);
        if (!s) return denied(state);
        const b = req.body || {};
        const conv = CONVERSATIONS.find((c) => c.id === b.cid);
        if (!conv) return out(404, { error: 'unknown conversation' });
        // Who the agent is comes from the session; the number and activity ID come from the server's own record.
        const claims = { cid: conv.id, phone: conv.phone, ext: conv.externalId, agent: s.sub };
        const ttl = Math.min(Math.max(Number(b.ttl) || 60, 1), 60); // below 60 only for the expiry test
        const r = renew(s);
        return out(200, { token: token.sign(claims, TOKEN_SECRET, ttl), session: sessionInfo(r.s) }, r.cookie ? [r.cookie] : []);
      }

      // Third-party cookie probe: independent of the sign-in
      case 'cookie-set':
        return out(200, { set: true }, [cookie(PROBE, crypto.randomUUID(), 600)]);
      case 'cookie-check':
        return out(200, { cookieReceived: !!parseCookies(req.headers.cookie)[PROBE] });

      default:
        return out(404, { error: 'not found' });
    }
  };
}

module.exports = { createRoutes, CONVERSATIONS, COOKIE };
