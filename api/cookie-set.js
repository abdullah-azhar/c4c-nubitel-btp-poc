'use strict';
// GET /nubitel-api/cookie-set  (third-party cookie test)
const crypto = require('crypto');
const { noStore } = require('./_common');

module.exports = (req, res) => {
  noStore(res);
  res.setHeader('Set-Cookie', `nb_session=${crypto.randomUUID()}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`);
  res.status(200).json({ set: true });
};
