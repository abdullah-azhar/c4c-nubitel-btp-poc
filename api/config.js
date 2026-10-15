'use strict';
// GET /config.js (rewritten here by vercel.json): runtime config for the mock Nubitel page.
const { SECTIONS } = require('../lib/c4c-adapter');
const { env, noStore } = require('./_common');

module.exports = (req, res) => {
  const e = env();
  noStore(res);
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  let viewOrigin = '';
  try { viewOrigin = new URL(e.viewUrl).origin; } catch (_) { /* VIEW_URL not set yet */ }
  res.status(200).send(`window.NB_CONFIG = ${JSON.stringify({ viewUrl: e.viewUrl, viewOrigin, hostOrigin: e.hostOrigin, sections: SECTIONS })};`);
};
