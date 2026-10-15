'use strict';
/**
 * Data adapter: one interface, two sources.
 *   DATA_SOURCE=mock  -> lib/mock-data.js with simulated latency (default)
 *   DATA_SOURCE=c4c   -> SAP C4C OData v2 (c4codataapi) with a read-only technical user
 *
 * Interface:
 *   lookupCustomer(phone)          -> { status: 'ok'|'not_found'|'multiple', data }
 *   getSection(section, accountId) -> { status: 'ok'|'empty', data }
 * Throws on technical failure (caller turns it into status 'error').
 *
 * IMPORTANT (real C4C): entity sets and field names below are a starting point.
 * Confirm every one against your tenant's $metadata
 * (/sap/c4c/odata/v1/c4codataapi/$metadata) before testing. Recommended items
 * have no standard OData entity; point RECOMMENDED_ITEMS_PATH at your custom
 * object or report.
 */
const { normalisePhone } = require('./phone');
const mock = require('./mock-data');

const SECTIONS = ['quote', 'order', 'tickets', 'items'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);

function createMockAdapter({ latencyScale = 1 } = {}) {
  const wait = (section, slow) => sleep(rand(mock.latency[section]) * latencyScale * (slow ? 3 : 1));
  const byAccount = (id) => Object.values(mock.customers).find((c) => c.accountId === id)
    || Object.values(mock.multiple).flat().find((c) => c.accountId === id);

  return {
    source: 'mock',
    async lookupCustomer(phone) {
      const p = normalisePhone(phone);
      await wait('customer');
      if (mock.multiple[p]) return { status: 'multiple', data: mock.multiple[p] };
      const c = mock.customers[p];
      if (!c) return { status: 'not_found', data: null };
      const { slow, failSection, emptySections, ...pub } = c;
      return { status: 'ok', data: pub };
    },
    async getSection(section, accountId) {
      if (!SECTIONS.includes(section)) throw new Error('unknown section');
      const c = byAccount(accountId);
      if (!c) return { status: 'empty', data: null };
      await wait(section, c.slow);
      if (c.failSection === section) throw new Error('simulated C4C error');
      if ((c.emptySections || []).includes(section)) return { status: 'empty', data: null };
      return { status: 'ok', data: mock.sections[section](c) };
    },
  };
}

function createC4CAdapter(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/$/, '') + '/sap/c4c/odata/v1/c4codataapi';
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  const timeoutMs = cfg.timeoutMs || 8000;
  const q = (s) => String(s).replace(/'/g, "''");

  async function get(path) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${base}/${path}${sep}$format=json`, {
        headers: { Authorization: auth, Accept: 'application/json' }, signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`C4C HTTP ${res.status}`);
      const json = await res.json();
      return (json.d && (json.d.results || json.d)) || [];
    } finally { clearTimeout(t); }
  }

  // TODO confirm: contact phone fields. C4C usually stores formatted numbers,
  // so prefer a normalised field if your tenant has one, or add an extension field.
  const CONTACT_PHONE_FILTER = (p) =>
    `ContactCollection?$filter=NormalisedPhone eq '${q(p)}' or NormalisedMobile eq '${q(p)}'` +
    `&$select=ContactID,Name,AccountID,AccountFormattedName,OwnerName&$top=5`;

  const SECTION_QUERIES = {
    // TODO confirm entity sets / field names in $metadata
    quote: (id) => `SalesQuoteCollection?$filter=BuyerPartyID eq '${q(id)}'&$orderby=LastChangeDateTime desc&$top=1&$select=ID,LifeCycleStatusCodeText,NetAmount,NetAmountcurrencyCode`,
    order: (id) => `SalesOrderCollection?$filter=AccountID eq '${q(id)}'&$orderby=DateTime desc&$top=1&$select=ID,DateTime,LifecycleStatusCodeText,NetAmount,NetAmountcurrencyCode`,
    tickets: (id) => `ServiceRequestCollection?$filter=CustomerID eq '${q(id)}' and ServiceRequestUserLifeCycleStatusCode ne '6'&$select=ID,Name&$top=20`,
    items: (id) => cfg.recommendedItemsPath ? cfg.recommendedItemsPath.replace('{accountId}', q(id)) : null,
  };

  return {
    source: 'c4c',
    async lookupCustomer(phone) {
      const rows = await get(CONTACT_PHONE_FILTER(normalisePhone(phone)));
      if (rows.length === 0) return { status: 'not_found', data: null };
      const map = (r) => ({ accountId: r.AccountID, contactId: r.ContactID, name: r.Name, account: r.AccountFormattedName, owner: r.OwnerName });
      if (rows.length > 1) return { status: 'multiple', data: rows.map(map) };
      return { status: 'ok', data: map(rows[0]) };
    },
    async getSection(section, accountId) {
      if (!SECTIONS.includes(section)) throw new Error('unknown section');
      const path = SECTION_QUERIES[section](accountId);
      if (!path) return { status: 'empty', data: null };
      const rows = await get(path);
      if (!rows.length) return { status: 'empty', data: null };
      const r = rows[0];
      switch (section) {
        case 'quote': return { status: 'ok', data: { id: r.ID, status: r.LifeCycleStatusCodeText, value: `${r.NetAmountcurrencyCode || ''} ${r.NetAmount || ''}`.trim() } };
        case 'order': return { status: 'ok', data: { id: r.ID, date: (r.DateTime || '').slice(0, 10), status: r.LifecycleStatusCodeText, value: `${r.NetAmountcurrencyCode || ''} ${r.NetAmount || ''}`.trim() } };
        case 'tickets': return { status: 'ok', data: { count: rows.length, latest: rows[0].Name } };
        case 'items': return { status: 'ok', data: rows.slice(0, 5).map((x) => ({ product: x.ProductDescription || x.ProductID, qty: x.Quantity, uom: x.UnitOfMeasure })) };
        default: return { status: 'empty', data: null };
      }
    },
  };
}

function createAdapter(env = process.env) {
  if ((env.DATA_SOURCE || 'mock') === 'c4c') {
    return createC4CAdapter({
      baseUrl: env.C4C_BASE_URL, user: env.C4C_USER, password: env.C4C_PASSWORD,
      recommendedItemsPath: env.RECOMMENDED_ITEMS_PATH, timeoutMs: Number(env.C4C_TIMEOUT_MS) || 8000,
    });
  }
  return createMockAdapter({ latencyScale: Number(env.MOCK_LATENCY_SCALE || 1) });
}

module.exports = { createAdapter, SECTIONS };
