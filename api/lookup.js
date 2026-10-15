'use strict';
// GET /nubitel-api/lookup  (Option A: "Nubitel backend" reads C4C, here mock data)
const { createAdapter } = require('../lib/c4c-adapter');
const { noStore } = require('./_common');

const adapter = createAdapter(process.env);

module.exports = async (req, res) => {
  noStore(res);
  const { section, phone, accountId } = req.query || {};
  try {
    const r = section === 'customer' ? await adapter.lookupCustomer(phone) : await adapter.getSection(section, accountId);
    res.status(200).json(r);
  } catch (e) {
    res.status(200).json({ status: 'error' });
  }
};
