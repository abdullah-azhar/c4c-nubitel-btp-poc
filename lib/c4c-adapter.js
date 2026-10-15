'use strict';
/**
 * Data adapter: one interface, two sources.
 *   DATA_SOURCE=mock  -> lib/mock-data.js with simulated latency (default)
 *   DATA_SOURCE=c4c   -> SAP C4C OData v2 (c4codataapi) with a technical user
 *
 * Interface (every method may throw on technical failure; the caller turns that
 * into status "error"):
 *   resolve({ phone, externalId })   -> { status: 'ok'|'not_found'|'multiple', data, via }
 *        Finds the customer. The phone call activity's external ID is tried first
 *        (it points at the right contact), then the phone number.
 *   getSection(section, ctx)         -> { status: 'ok'|'empty', data }
 *        section: 'order' | 'tasks' | 'reco'; ctx: { accountId, contactId }
 *   searchContacts(q), searchAccounts(q)   -> array (max 10)
 *   createContact({ firstName, lastName, accountId, email, phone })   -> contact
 *   updateContactPhone({ contactId, phone })                          -> contact
 *
 * The real C4C mapping (entity sets, field names, the recommendation snapshot
 * object, the external-ID field on phone call activities) is filled in from the
 * tenant's $metadata (/sap/c4c/odata/v1/c4codataapi/$metadata). Until then
 * DATA_SOURCE=c4c fails loudly instead of returning guessed data.
 */
const { normalisePhone } = require('./phone');
const { currentPeriod } = require('./period');
const mock = require('./mock-data');

const SECTIONS = ['order', 'tasks', 'reco'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const MAX_RESULTS = 10;

function createMockAdapter({ latencyScale = 1 } = {}) {
  // A private copy, so creating/updating a contact in a test does not leak between runs.
  const state = { contacts: mock.contacts.map((c) => ({ ...c, phones: [...c.phones] })), nextId: 2000500 };
  const wait = (kind, slow) => sleep(rand(mock.latency[kind]) * latencyScale * (slow ? 3 : 1));
  const pub = (c) => ({ accountId: c.accountId, contactId: c.contactId, name: c.name, account: c.account, owner: c.owner });
  const byContact = (id) => state.contacts.find((c) => c.contactId === id);
  const needle = (q) => String(q || '').trim().toLowerCase();

  return {
    source: 'mock',

    async resolve({ phone, externalId }) {
      await wait('customer');
      const act = externalId && mock.activities[externalId];
      if (act && byContact(act.contactId)) return { status: 'ok', data: pub(byContact(act.contactId)), via: 'activity' };
      const p = normalisePhone(phone);
      const matches = state.contacts.filter((c) => p && c.phones.includes(p));
      if (matches.length === 0) return { status: 'not_found', data: null };
      if (matches.length > 1) return { status: 'multiple', data: matches.map(pub) };
      return { status: 'ok', data: pub(matches[0]), via: 'phone' };
    },

    async getSection(section, ctx) {
      if (!SECTIONS.includes(section)) throw new Error('unknown section');
      const c = byContact(ctx.contactId);
      if (!c) return { status: 'empty', data: null };
      await wait(section, c.slow);
      if (c.failSection === section) throw new Error('simulated C4C error');
      if ((c.emptySections || []).includes(section)) return { status: 'empty', data: null };
      return { status: 'ok', data: mock.sections[section](c, currentPeriod()) };
    },

    async searchContacts(q) {
      const n = needle(q);
      await wait('search');
      if (n.length < 2) return [];
      return state.contacts
        .filter((c) => c.name.toLowerCase().includes(n) || c.account.toLowerCase().includes(n))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_RESULTS)
        .map((c) => ({ ...pub(c), phoneHint: c.phones.length ? '…' + c.phones[0].slice(-3) : '' }));
    },

    async searchAccounts(q) {
      const n = needle(q);
      await wait('search');
      if (n.length < 2) return [];
      const seen = new Map();
      state.contacts.forEach((c) => { if (!seen.has(c.accountId)) seen.set(c.accountId, { accountId: c.accountId, account: c.account, owner: c.owner }); });
      return [...seen.values()].filter((a) => a.account.toLowerCase().includes(n)).slice(0, MAX_RESULTS);
    },

    async createContact({ firstName, lastName, accountId, email, phone }) {
      await wait('write');
      const peer = state.contacts.find((c) => c.accountId === accountId);
      if (!peer) throw Object.assign(new Error('unknown account'), { code: 'bad_request' });
      const c = { contactId: String(state.nextId++), name: `${firstName} ${lastName}`.trim(), accountId, account: peer.account, owner: peer.owner, phones: [normalisePhone(phone)], email: email || '' };
      state.contacts.push(c);
      return pub(c);
    },

    async updateContactPhone({ contactId, phone }) {
      await wait('write');
      const c = byContact(contactId);
      if (!c) throw Object.assign(new Error('unknown contact'), { code: 'bad_request' });
      const p = normalisePhone(phone);
      if (!c.phones.includes(p)) c.phones.push(p);
      return pub(c);
    },
  };
}

function createC4CAdapter(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/$/, '') + '/sap/c4c/odata/v1/c4codataapi';
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  const timeoutMs = cfg.timeoutMs || 8000;

  // Reads: a plain GET. Writes: C4C needs a CSRF token fetched together with its session cookie first.
  // eslint-disable-next-line no-unused-vars
  async function request(method, path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Authorization: auth, Accept: 'application/json' };
      if (method !== 'GET') {
        const pre = await fetch(`${base}/`, { headers: { ...headers, 'x-csrf-token': 'fetch' }, signal: ctrl.signal });
        headers['x-csrf-token'] = pre.headers.get('x-csrf-token') || '';
        headers.Cookie = (pre.headers.getSetCookie ? pre.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
        headers['Content-Type'] = 'application/json';
      }
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${base}/${path}${method === 'GET' ? sep + '$format=json' : ''}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`C4C HTTP ${res.status}`);
      if (res.status === 204) return null;
      const json = await res.json();
      return (json.d && (json.d.results || json.d)) || [];
    } finally { clearTimeout(t); }
  }

  const notConfigured = () => { throw new Error('C4C OData mapping is not configured yet: it is filled in from the tenant $metadata'); };

  return {
    source: 'c4c',
    request, // used by the mapping once it is filled in
    resolve: notConfigured,
    getSection: notConfigured,
    searchContacts: notConfigured,
    searchAccounts: notConfigured,
    createContact: notConfigured,
    updateContactPhone: notConfigured,
  };
}

function createAdapter(env = process.env) {
  if ((env.DATA_SOURCE || 'mock') === 'c4c') {
    return createC4CAdapter({
      baseUrl: env.C4C_BASE_URL, user: env.C4C_USER, password: env.C4C_PASSWORD, timeoutMs: Number(env.C4C_TIMEOUT_MS) || 8000,
    });
  }
  return createMockAdapter({ latencyScale: Number(env.MOCK_LATENCY_SCALE || 1) });
}

module.exports = { createAdapter, SECTIONS };
