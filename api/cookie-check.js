'use strict';
// GET /nubitel-api/cookie-check  (did the cookie come back while framed inside C4C?)
const { noStore } = require('./_common');

module.exports = (req, res) => {
  noStore(res);
  res.status(200).json({ cookieReceived: /(?:^|;\s*)nb_session=/.test(req.headers.cookie || '') });
};
