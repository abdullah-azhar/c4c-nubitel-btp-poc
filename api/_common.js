'use strict';
// Shared helpers for the Vercel functions (files starting with _ are not exposed as routes).
const { list } = require('../lib/http-util');

const env = () => ({
  viewUrl: process.env.VIEW_URL || 'https://<c4c-lean-view-route>/',
  hostOrigin: process.env.HOST_ORIGIN || list(process.env.FRAME_ANCESTORS)[0] || '',
  secret: process.env.TOKEN_SECRET || 'poc-only-change-me',
});

const noStore = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); };

module.exports = { env, noStore };
