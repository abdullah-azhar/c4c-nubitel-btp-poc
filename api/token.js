'use strict';
// POST /nubitel-api/token  (Option B: "Nubitel backend" signs a 60-second token)
const token = require('../lib/token');
const { env, noStore } = require('./_common');

module.exports = (req, res) => {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
  if (!b.cid || !b.phone) return res.status(400).json({ error: 'cid and phone required' });
  res.status(200).json({ token: token.sign({ cid: b.cid, phone: b.phone, agent: b.agent || 'agent.poc' }, env().secret, 60) });
};
