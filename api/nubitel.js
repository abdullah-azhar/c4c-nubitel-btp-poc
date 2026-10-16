'use strict';
// All /nubitel-api/* calls (rewritten here by vercel.json as /api/nubitel?route=<name>):
// sign-in, session, conversations, view token, cookie probe. See lib/nubitel-routes.js.
const { createRoutes } = require('../lib/nubitel-routes');

const route = createRoutes(process.env);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const name = String((req.query && req.query.route) || '').replace(/[^a-z-]/g, '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { return res.status(400).json({ error: 'bad request' }); } }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const r = await route(name, { method: req.method, headers: req.headers, body: body || {}, ip });
  if (r.cookies.length) res.setHeader('Set-Cookie', r.cookies);
  res.status(r.status).json(r.json);
};
