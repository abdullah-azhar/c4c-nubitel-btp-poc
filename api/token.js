'use strict';
// POST /nubitel-api/token  ("Nubitel backend" signs a short-lived token for one conversation)
const token = require('../lib/token');
const { env, noStore } = require('./_common');

module.exports = (req, res) => {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
  if (!b.cid || !b.phone) return res.status(400).json({ error: 'cid and phone required' });
  const claims = { cid: String(b.cid), phone: String(b.phone), agent: b.agent || 'agent.poc' };
  if (typeof b.externalId === 'string' && b.externalId.length <= 64) claims.ext = b.externalId; // phone call activity's external ID
  const ttl = Math.min(Math.max(Number(b.ttl) || 60, 1), 60); // ttl below 60 is only for the expiry test
  res.status(200).json({ token: token.sign(claims, env().secret, ttl) });
};
