'use strict';
/**
 * Short-lived signed token (security Option B).
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 * Payload: { cid, phone, agent, iat, exp, jti }
 * Nubitel's backend signs it with a secret shared with the BTP view.
 * Production: prefer an asymmetric key pair (Nubitel signs with a private key,
 * BTP verifies with the public key) so BTP cannot mint tokens, and rotate keys.
 */
const crypto = require('crypto');

const MAX_LIFETIME_S = 120;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret, ttlSeconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + Math.min(ttlSeconds, MAX_LIFETIME_S),
    jti: crypto.randomUUID(),
  };
  const p = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', secret).update(p).digest());
  return `${p}.${sig}`;
}

function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) throw new Error('malformed');
  const [p, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(p).digest();
  const given = Buffer.from(sig || '', 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error('bad signature');
  }
  const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!body.exp || body.exp < now) throw new Error('expired');
  if (body.exp - body.iat > MAX_LIFETIME_S) throw new Error('lifetime too long');
  if (!body.phone || !body.cid) throw new Error('missing claims');
  return body;
}

module.exports = { sign, verify };
