'use strict';
/**
 * Data adapter: one interface, two sources.
 *   DATA_SOURCE=mock  -> lib/mock-data.js with simulated latency (default)
 *   DATA_SOURCE=c4c   -> SAP C4C OData v2 (c4codataapi) with a technical user
 *
 * Interface (every method may throw on technical failure; the caller turns that
 * into status "error"):
 *   resolve({ phone, externalId })   -> { status: 'ok'|'not_found'|'multiple', data, via }
 *        Finds the customer. The phone call activity (by the field named in
 *        C4C_ACTIVITY_FIELD) is tried first, then the phone number.
 *   getSection(section, ctx)         -> { status: 'ok'|'empty'|'not_configured', data }
 *        section: 'order' | 'tasks' | 'reco'; ctx: { accountId, contactId }
 *   searchContacts(q), searchAccounts(q)   -> array (max 10)
 *   createContact({ firstName, lastName, accountId, email, phone })   -> contact
 *   updateContactPhone({ contactId, phone })                          -> contact
 *
 * Real C4C mapping, checked against the my335945 test tenant's $metadata and data:
 *   contact          ContactCollection        ContactID, Name, AccountID, AccountFormattedName,
 *                                             Mobile, Phone, NormalisedMobile, NormalisedPhone ("+60199999999")
 *   account          CorporateAccountCollection  AccountID, Name   (same ID as Contact.AccountID)
 *   last sales order CustomerOrderCollection  BuyerPartyID = AccountID, DateTime, NetAmount, status text
 *   open tasks       TasksCollection          MainAccountPartyID = AccountID, Status 1 Open / 2 In Process
 *   owner name       EmployeeBasicDataCollection  EmployeeID -> FormattedName
 * C4C quirks found: "A or B" across two different fields is rejected, so phone and name
 * searches run as two small queries and are merged.
 * Recommendations (monthly snapshot) are not in the standard service: reported as
 * "not_configured" until the object is known.
 */
const { normalisePhone } = require('./phone');
const { currentPeriod, TZ } = require('./period');
const mock = require('./mock-data');

const SECTIONS = ['order', 'tasks', 'reco'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const MAX_RESULTS = 10;
const MAX_TASKS = 10;

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

// ---------------------------------------------------------------------------------------------
// Real C4C
// ---------------------------------------------------------------------------------------------
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;                       // OData string literal
const e164 = (phone) => '+' + normalisePhone(phone);                              // how C4C stores normalised numbers
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
// OData v2 sends dates as "/Date(1791793281050)/" (milliseconds, UTC). Show them as a day in the sales team's time zone.
function odataDay(v) {
  const m = /\/Date\((-?\d+)/.exec(String(v || ''));
  return m ? fmtDay.format(new Date(Number(m[1]))) : '';
}
const money = (amount, cur) => {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  return `${cur === 'MYR' ? 'RM' : cur || ''} ${Number.isFinite(n) ? n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount}`.trim();
};
const PRIORITY = { 1: 'High', 2: 'High', 3: 'Normal', 7: 'Low' };               // C4C: 1 Immediate, 2 Urgent, 3 Normal, 7 Low
const OPEN_TASK = "(Status eq '1' or Status eq '2')";                             // 1 Open, 2 In Process (3 Completed, 4 Canceled)

// Transport: how a request reaches C4C. Reads are plain GETs; writes first fetch a CSRF token and session cookie.
function makeTransport(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/$/, '') + '/sap/c4c/odata/v1/c4codataapi';
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  const timeoutMs = cfg.timeoutMs || 8000;
  return async function request(method, path, params, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Authorization: auth, Accept: 'application/json' };
      if (method !== 'GET') {
        const pre = await fetch(`${base}/`, { headers: { ...headers, 'x-csrf-token': 'fetch' }, signal: ctrl.signal });
        headers['x-csrf-token'] = pre.headers.get('x-csrf-token') || '';
        headers.Cookie = (pre.headers.getSetCookie ? pre.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
        headers['Content-Type'] = 'application/json';
        if (method === 'PATCH') headers['If-Match'] = '*';
      }
      const query = Object.entries({ ...(params || {}), $format: 'json' }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const res = await fetch(`${base}/${path}?${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      if (!res.ok) throw new Error(`C4C HTTP ${res.status}`);          // never put response text in errors: it can hold customer data
      if (res.status === 204) return {};
      const json = await res.json();
      return json.d || {};
    } finally { clearTimeout(t); }
  };
}

function createC4CAdapter(cfg, transport) {
  const call = transport || makeTransport(cfg);
  const rows = (d) => (d && (d.results || (Array.isArray(d) ? d : []))) || [];
  const get = (path, params) => call('GET', path, params);

  const contactFields = 'ObjectID,ContactID,Name,AccountID,AccountFormattedName,ContactOwnerID,Mobile,Phone,NormalisedMobile,NormalisedPhone';
  const toContact = (r) => ({ accountId: r.AccountID || '', contactId: r.ContactID, name: r.Name, account: r.AccountFormattedName || '', owner: '' });

  // Best effort: the owner's name is nice to have and must never break the lookup.
  async function withOwner(contacts, ownerIds) {
    await Promise.all(contacts.map(async (c, i) => {
      const id = ownerIds[i];
      if (!id) return;
      try {
        const d = await get('EmployeeBasicDataCollection', { $filter: `EmployeeID eq ${lit(id)}`, $top: 1, $select: 'FormattedName' });
        c.owner = (rows(d)[0] || {}).FormattedName || '';
      } catch (_) { /* leave the owner blank */ }
    }));
    return contacts;
  }

  async function contactById(contactId) {
    const d = await get('ContactCollection', { $filter: `ContactID eq ${lit(contactId)}`, $top: 1, $select: contactFields });
    return rows(d)[0] || null;
  }

  return {
    source: 'c4c',

    async resolve({ phone, externalId }) {
      // 1. The phone call activity points at the right contact (only if the field that holds Nubitel's ID is configured)
      if (externalId && cfg.activityField) {
        const d = await get('PhoneCallCollection', { $filter: `${cfg.activityField} eq ${lit(externalId)}`, $top: 1, $select: 'ID,MainContactPartyID' });
        const contactId = (rows(d)[0] || {}).MainContactPartyID;
        const r = contactId && await contactById(contactId);
        if (r) return { status: 'ok', data: (await withOwner([toContact(r)], [r.ContactOwnerID]))[0], via: 'activity' };
      }
      // 2. The phone number. C4C rejects "A or B" across two fields, so two small queries.
      const n = e164(phone);
      const [byMobile, byPhone] = await Promise.all(['NormalisedMobile', 'NormalisedPhone'].map(
        (f) => get('ContactCollection', { $filter: `${f} eq ${lit(n)}`, $top: 6, $select: contactFields })));
      const seen = new Set(); const found = [];
      [...rows(byMobile), ...rows(byPhone)].forEach((r) => { if (!seen.has(r.ContactID)) { seen.add(r.ContactID); found.push(r); } });
      if (found.length === 0) return { status: 'not_found', data: null };
      const list = await withOwner(found.map(toContact), found.map((r) => r.ContactOwnerID));
      return list.length > 1 ? { status: 'multiple', data: list } : { status: 'ok', data: list[0], via: 'phone' };
    },

    async getSection(section, ctx) {
      if (!SECTIONS.includes(section)) throw new Error('unknown section');
      if (section === 'reco') return { status: 'not_configured', data: null };   // the monthly snapshot object is not known yet
      if (!ctx.accountId) return { status: 'empty', data: null };               // a contact without an account has no orders or tasks
      const acc = lit(ctx.accountId);

      if (section === 'order') {
        const d = await get('CustomerOrderCollection', {
          $filter: `BuyerPartyID eq ${acc}`, $orderby: 'DateTime desc', $top: 1,
          $select: 'ID,DateTime,NetAmount,NetAmountCurrencyCode,OrderExternalLifeCycleStatusCodeText',
        });
        const r = rows(d)[0];
        if (!r) return { status: 'empty', data: null };
        return { status: 'ok', data: { id: r.ID, date: odataDay(r.DateTime), status: r.OrderExternalLifeCycleStatusCodeText || '', value: money(r.NetAmount, r.NetAmountCurrencyCode) } };
      }

      // tasks
      const d = await get('TasksCollection', {
        $filter: `MainAccountPartyID eq ${acc} and ${OPEN_TASK}`, $orderby: 'DueDateTime asc', $top: MAX_TASKS, $inlinecount: 'allpages',
        $select: 'ID,Subject,DueDateTime,StatusText,PriorityCode',
      });
      const list = rows(d);
      if (!list.length) return { status: 'empty', data: null };
      const items = list.map((r) => ({ id: r.ID, subject: r.Subject || '(no subject)', due: odataDay(r.DueDateTime), status: r.StatusText || '', priority: PRIORITY[r.PriorityCode] || 'Normal' }));
      return { status: 'ok', data: { count: Number(d.__count) || items.length, items } };
    },

    async searchContacts(q) {
      const s = String(q || '').trim().slice(0, 60);
      if (s.length < 2) return [];
      const fields = `${contactFields}`;
      const [byName, byAccount] = await Promise.all(['Name', 'AccountFormattedName'].map(
        (f) => get('ContactCollection', { $filter: `substringof(${lit(s)},${f})`, $top: MAX_RESULTS, $select: fields })));
      const seen = new Set(); const out = [];
      [...rows(byName), ...rows(byAccount)].forEach((r) => {
        if (seen.has(r.ContactID)) return;
        seen.add(r.ContactID);
        const num = r.NormalisedMobile || r.NormalisedPhone || '';
        out.push({ ...toContact(r), phoneHint: num ? '…' + num.slice(-3) : '' });
      });
      return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_RESULTS);
    },

    async searchAccounts(q) {
      const s = String(q || '').trim().slice(0, 60);
      if (s.length < 2) return [];
      const d = await get('CorporateAccountCollection', { $filter: `substringof(${lit(s)},Name)`, $top: MAX_RESULTS, $select: 'AccountID,Name' });
      return rows(d).map((r) => ({ accountId: r.AccountID, account: r.Name, owner: '' }));
    },

    // WRITES: not yet exercised against the tenant (needs a technical user that may write). TODO confirm on first use.
    async createContact({ firstName, lastName, accountId, email, phone }) {
      const body = { LastName: lastName, AccountID: accountId, Mobile: e164(phone) };
      if (firstName) body.FirstName = firstName;
      if (email) body.Email = email;
      const r = await call('POST', 'ContactCollection', null, body);
      return toContact({ ...r, AccountID: r.AccountID || accountId, Name: r.Name || `${firstName} ${lastName}`.trim() });
    },

    async updateContactPhone({ contactId, phone }) {
      const r = await contactById(contactId);
      if (!r) throw Object.assign(new Error('unknown contact'), { code: 'bad_request' });
      // Never overwrite a number: use the Mobile field if free, else Phone, else refuse.
      const field = !r.Mobile ? 'Mobile' : !r.Phone ? 'Phone' : null;
      if (!field) throw Object.assign(new Error('contact already has both numbers'), { code: 'bad_request' });
      await call('PATCH', `ContactCollection('${r.ObjectID}')`, null, { [field]: e164(phone) });
      return toContact(r);
    },
  };
}

function createAdapter(env = process.env) {
  if ((env.DATA_SOURCE || 'mock') === 'c4c') {
    return createC4CAdapter({
      baseUrl: env.C4C_BASE_URL, user: env.C4C_USER, password: env.C4C_PASSWORD, timeoutMs: Number(env.C4C_TIMEOUT_MS) || 8000,
      activityField: /^[A-Za-z0-9_]+$/.test(env.C4C_ACTIVITY_FIELD || '') ? env.C4C_ACTIVITY_FIELD : '',
    });
  }
  return createMockAdapter({ latencyScale: Number(env.MOCK_LATENCY_SCALE || 1) });
}

module.exports = { createAdapter, createC4CAdapter, SECTIONS };
