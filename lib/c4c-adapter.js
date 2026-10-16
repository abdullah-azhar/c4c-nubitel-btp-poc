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
 *   recommendations  custom service /sap/c4c/odata/cust/v1/duopharma_snapshotproductrecommendation
 *                    SnapshotProdRecCollection: C4CCustomerID = AccountID, SnapshotMonthYear ("2026-10"),
 *                    ProductID, Quantity + QuantityUnitCode, RecType/RecTypeID, ShowInReport ('Yes')
 *                    product names: ProductCollection (ProductID -> Description); unit names: the
 *                    service's own SnapshotProdRecQuantityUnitCodeCollection (XBX = Box ...)
 */
const { normalisePhone } = require('./phone');
const { currentPeriod, monthLabel, TZ } = require('./period');
const mock = require('./mock-data');

const SECTIONS = ['order', 'tasks', 'reco'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const MAX_RESULTS = 10;
const MAX_TASKS = 10;
const MAX_RECO = 50;             // rows shown in the recommendations table
const NAME_CHUNK = 40;           // product IDs asked for per call
const UNIT_TTL_MS = 6 * 3600_000; // how long the unit-of-measure names are remembered

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
  const origin = (cfg.baseUrl || '').replace(/\/$/, '');
  // Two OData services: the standard one, and the custom one that holds the monthly recommendation snapshot
  const roots = { std: origin + '/sap/c4c/odata/v1/c4codataapi', reco: origin + cfg.recoService };
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  const timeoutMs = cfg.timeoutMs || 8000;
  return async function request(method, path, params, body, service = 'std') {
    const base = roots[service];
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
  const get = (path, params, service) => call('GET', path, params, null, service);

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

  // ---- recommendations: the custom monthly snapshot (SnapshotProdRec), one row per account, month and product ----
  // The snapshot only has product IDs and unit codes, so names come from two small lookups (best effort:
  // if either fails the table still shows, with the ID or the code).
  async function productNames(ids) {
    const names = {};
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += NAME_CHUNK) {
      const chunk = unique.slice(i, i + NAME_CHUNK);
      try {
        const d = await get('ProductCollection', { $filter: chunk.map((id) => `ProductID eq ${lit(id)}`).join(' or '), $top: NAME_CHUNK * 3, $select: 'ProductID,Description,Language' });
        rows(d).forEach((p) => { if (p.Description && (!names[p.ProductID] || p.Language === 'EN')) names[p.ProductID] = p.Description; });
      } catch (_) { /* fall back to the product ID */ }
    }
    return names;
  }

  let unitCache = { at: 0, map: {} };
  async function unitNames() {
    if (Date.now() - unitCache.at < UNIT_TTL_MS && unitCache.at) return unitCache.map;
    try {
      const d = await get('SnapshotProdRecQuantityUnitCodeCollection', { $top: 500 }, 'reco');
      unitCache = { at: Date.now(), map: Object.fromEntries(rows(d).map((u) => [u.Code, u.Description])) };
    } catch (_) { /* show the unit code */ }
    return unitCache.map;
  }

  const recoRows = async (acc, monthKey) => rows(await get('SnapshotProdRecCollection', {
    $filter: `C4CCustomerID eq ${acc} and SnapshotMonthYear eq ${lit(monthKey)} and ShowInReport eq 'Yes'`,
    $orderby: 'RecTypeID asc,Quantity desc', $top: MAX_RECO,                       // recommendation type first (RT02 Up-Sell, RT03 Special Price ... RT07 Repeat), biggest quantity first
    $select: 'ProductID,RecType,Quantity,QuantityUnitCode',
  }, 'reco'));

  const qty = (v) => { const n = Number(v); return Number.isFinite(n) ? (Number.isInteger(n) ? n : Math.round(n * 100) / 100) : v; };

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
      if (!ctx.accountId) return { status: 'empty', data: null };               // a contact without an account has no orders, tasks or recommendations
      const acc = lit(ctx.accountId);

      if (section === 'reco') {
        // This month's snapshot, in the sales team's time zone. If it has not been generated yet and the
        // fallback is on, show the newest earlier snapshot and say so on the screen.
        const period = currentPeriod();
        let key = period.key; let note = '';
        let list = await recoRows(acc, key);
        if (!list.length && cfg.recoFallbackLatest) {
          const d = await get('SnapshotProdRecCollection', {
            $filter: `C4CCustomerID eq ${acc} and ShowInReport eq 'Yes' and SnapshotMonthYear le ${lit(period.key)}`,
            $orderby: 'SnapshotMonthYear desc', $top: 1, $select: 'SnapshotMonthYear',
          }, 'reco');
          const latest = (rows(d)[0] || {}).SnapshotMonthYear;
          if (latest && latest !== key) { key = latest; note = 'latest available'; list = await recoRows(acc, key); }
        }
        if (!list.length) return { status: 'empty', data: null };
        const [names, units] = await Promise.all([productNames(list.map((r) => r.ProductID)), unitNames()]);
        return {
          status: 'ok',
          data: {
            period: key, label: monthLabel(key), note,
            rows: list.map((r) => ({ product: names[r.ProductID] || `Product ${r.ProductID}`, qty: qty(r.Quantity), uom: units[r.QuantityUnitCode] || r.QuantityUnitCode || '', reason: r.RecType || '' })),
          },
        };
      }

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
      // The custom OData service that holds the monthly recommendation snapshot
      recoService: /^\/sap\/c4c\/odata\/cust\/v1\/[A-Za-z0-9_]+$/.test(env.C4C_RECO_SERVICE || '') ? env.C4C_RECO_SERVICE : '/sap/c4c/odata/cust/v1/duopharma_snapshotproductrecommendation',
      // true: when this month's snapshot does not exist yet, show the newest earlier one (labelled)
      recoFallbackLatest: env.C4C_RECO_FALLBACK_LATEST === 'true',
    });
  }
  return createMockAdapter({ latencyScale: Number(env.MOCK_LATENCY_SCALE || 1) });
}

module.exports = { createAdapter, createC4CAdapter, SECTIONS };
