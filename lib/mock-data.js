'use strict';
/**
 * Illustrative test data, shaped like what the real C4C objects will return.
 * Phone numbers are stored normalised (see phone.js). Each contact exercises a
 * different case in the test checklist. Dates are relative to "now" so the
 * screens always look current.
 */
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const contacts = [
  // Happy path. Also reachable through the phone call activity's external ID.
  { contactId: '2000456', name: 'Jenna Hopkins', accountId: '1000123', account: 'Hopkins Pharmacy', owner: 'James Theng', phones: ['6083472856'] },
  // Slow sections (latency test)
  { contactId: '2000457', name: 'Kumar Singh', accountId: '1000124', account: 'Singh Klinik Sdn Bhd', owner: 'James Theng', phones: ['60123456789'], slow: true },
  // Last sales order fails to load (per-section error test)
  { contactId: '2000458', name: 'Ali Hassan', accountId: '1000125', account: 'Farmasi Hassan', owner: 'Nur Aina', phones: ['60198765432'], failSection: 'order' },
  // No order, no tasks (empty-state test)
  { contactId: '2000459', name: 'Mei Ling Tan', accountId: '1000126', account: 'Klinik Tan', owner: 'Nur Aina', phones: ['60177778888'], emptySections: ['order', 'tasks'] },
  // Same number on two contacts (multiple-match test)
  { contactId: '2000460', name: 'June Wong Yee Chun', accountId: '1000127', account: 'Wong Pharmacy (KL)', owner: 'James Theng', phones: ['60162223333'] },
  { contactId: '2000461', name: 'June Wong Yee Chun', accountId: '1000128', account: 'Wong Pharmacy (PJ)', owner: 'Nur Aina', phones: ['60162223333'] },
  // Contacts with no phone number saved yet: targets for the unknown-caller flow
  { contactId: '2000470', name: 'Siti Nurhaliza', accountId: '1000129', account: 'Farmasi Siti', owner: 'Nur Aina', phones: [] },
  { contactId: '2000471', name: 'Siti Aminah', accountId: '1000129', account: 'Farmasi Siti', owner: 'Nur Aina', phones: [] },
  { contactId: '2000472', name: 'Raj Kumar', accountId: '1000130', account: 'Raj Healthcare', owner: 'James Theng', phones: [] },
  { contactId: '2000473', name: 'Lim Wei Jie', accountId: '1000131', account: 'Klinik Lim', owner: 'James Theng', phones: [] },
];

// C4C keeps an account's UUID next to its ID; the "open account" link needs the UUID.
// (Made-up UUIDs for the mock, in the same shape C4C returns.)
contacts.forEach((c) => { c.accountUuid = '00163E4D-6601-1EE8-9C8A-' + String(c.accountId).padStart(12, '0'); });

// Phone call activities, by the activity ID that Nubitel keeps as the conversation's "External ID"
// (the reliable way to find the customer: the activity already points at the right contact)
const activities = {
  '4100234': { contactId: '2000456' },
  '4100236': { contactId: '2000458' },
};

const PRODUCTS = [
  ['Vitamin C 1000mg', 'boxes', 'Repeat from last month'],
  ['Paracetamol 500mg', 'boxes', 'Fast mover at this account'],
  ['Zinc 25mg', 'boxes', 'Seasonal demand'],
  ['Omega-3 1000mg', 'bottles', 'Promo bundle'],
  ['Calcium + D3', 'bottles', 'Repeat from last month'],
  ['Multivitamin Adult', 'bottles', 'Low stock at customer'],
  ['Ibuprofen 400mg', 'boxes', 'Fast mover at this account'],
  ['Cetirizine 10mg', 'boxes', 'Seasonal demand'],
  ['ORS Sachet', 'cartons', 'Seasonal demand'],
  ['Blood Glucose Strips', 'boxes', 'Repeat from last month'],
  ['Hand Sanitizer 500ml', 'cartons', 'Promo bundle'],
  ['Loratadine 10mg', 'boxes', 'Low stock at customer'],
];

const sections = {
  order: (c) => ({ id: 'SO-' + (4000 + Number(c.accountId.slice(-3))), date: iso(-12), status: 'Delivered', value: 'RM 2,150.00' }),
  tasks: (c) => {
    const base = Number(c.accountId.slice(-2));
    const uuid = (n) => 'E1C764EB-8BBD-1EEF-9DAD-' + String(n).padStart(12, '0');   // made-up task UUIDs
    const items = [
      { id: 'T-' + (7000 + base), uuid: uuid(7000 + base), subject: 'Call back about delivery delay', due: iso(-2), status: 'In process', priority: 'High' },
      { id: 'T-' + (7100 + base), uuid: uuid(7100 + base), subject: 'Send updated price list', due: iso(1), status: 'Open', priority: 'Normal' },
      { id: 'T-' + (7200 + base), uuid: uuid(7200 + base), subject: 'Follow up on promo bundle quote', due: iso(3), status: 'Open', priority: 'Normal' },
      { id: 'T-' + (7300 + base), uuid: uuid(7300 + base), subject: 'Confirm standing order quantities', due: iso(7), status: 'Open', priority: 'Low' },
    ];
    return { count: items.length, items };
  },
  // rows are for the period passed in (current month/year); the number of rows varies per account
  reco: (c, period) => {
    const seed = Number(c.accountId.slice(-2));
    const n = 8 + (seed % 5);
    const rows = Array.from({ length: n }, (_, i) => {
      const [product, uom, reason] = PRODUCTS[(i + seed) % PRODUCTS.length];
      return { product, qty: 4 + ((i * 3 + seed) % 17), uom, reason };
    });
    return { period: period.key, label: period.label, rows };
  },
};

// Typical latency per call (ms); "slow" contacts get x3
const latency = { customer: [250, 500], order: [500, 1500], tasks: [300, 900], reco: [600, 1800], search: [150, 300], write: [300, 600] };

module.exports = { contacts, activities, sections, latency };
