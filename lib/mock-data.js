'use strict';
/**
 * Illustrative test data. Phone keys are normalised (see phone.js).
 * Each customer exercises a different case in the test checklist.
 */
const customers = {
  // Happy path
  '6083472856': {
    accountId: '1000123', contactId: '2000456', name: 'Jenna Hopkins',
    account: 'Hopkins Pharmacy', owner: 'James Theng',
  },
  // Slow sections (latency test)
  '60123456789': {
    accountId: '1000124', contactId: '2000457', name: 'Kumar Singh',
    account: 'Singh Klinik Sdn Bhd', owner: 'James Theng', slow: true,
  },
  // Orders section fails (per-section error test)
  '60198765432': {
    accountId: '1000125', contactId: '2000458', name: 'Ali Hassan',
    account: 'Farmasi Hassan', owner: 'Nur Aina', failSection: 'order',
  },
  // No quote, no tickets (empty-state test)
  '60177778888': {
    accountId: '1000126', contactId: '2000459', name: 'Mei Ling Tan',
    account: 'Klinik Tan', owner: 'Nur Aina', emptySections: ['quote', 'tickets'],
  },
};

// Same number on two contacts (multiple-match test)
const multiple = {
  '60162223333': [
    { accountId: '1000127', contactId: '2000460', name: 'June Wong Yee Chun', account: 'Wong Pharmacy (KL)' },
    { accountId: '1000128', contactId: '2000461', name: 'June Wong Yee Chun', account: 'Wong Pharmacy (PJ)' },
  ],
};

const sections = {
  quote: (c) => ({ id: 'Q-' + c.accountId.slice(-3), status: 'In review', items: 3, value: 'RM 4,820.00' }),
  order: (c) => ({ id: 'SO-' + (1000 + Number(c.accountId.slice(-2))), date: '2026-10-02', status: 'Delivered', value: 'RM 2,150.00' }),
  tickets: () => ({ count: 1, latest: 'Delivery enquiry' }),
  items: () => ([
    { product: 'Vitamin C 1000mg', qty: 10, uom: 'boxes' },
    { product: 'Paracetamol 500mg', qty: 5, uom: 'boxes' },
    { product: 'Zinc 25mg', qty: 12, uom: 'boxes' },
  ]),
};

// Typical latency per section (ms); "slow" customers get x3
const latency = { customer: [250, 500], quote: [400, 1200], order: [700, 2200], tickets: [300, 800], items: [600, 1800] };

module.exports = { customers, multiple, sections, latency };
