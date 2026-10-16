'use strict';
/**
 * Checks the real C4C adapter without a tenant: a fake transport answers like C4C does
 * (shapes taken from the my335945 test tenant), and every request the adapter makes is recorded.
 *   node local/adapter-test.js            runs the checks
 *   node local/adapter-test.js --print    also prints the GET requests (to replay against a tenant)
 */
const { createC4CAdapter } = require('../lib/c4c-adapter');
const { currentPeriod, monthLabel } = require('../lib/period');

let failed = 0; let n = 0;
const check = (name, ok, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

const MS = (iso) => `/Date(${Date.parse(iso)})/`;
const CONTACT = { ObjectID: 'OBJ1', ContactID: '1001', Name: 'Jenna Hopkins', AccountID: '900000001', AccountFormattedName: 'Hopkins Pharmacy', ContactOwnerID: '77', Mobile: '', Phone: '', NormalisedMobile: '+6083472856', NormalisedPhone: '' };

function fake(handlers) {
  const log = [];
  const t = async (method, path, params, body, service) => {
    log.push({ method, path, params: params || {}, body, service: service || 'std' });
    for (const h of handlers) { const r = h(method, path, params || {}, body, service); if (r !== undefined) return r; }
    return { results: [] };
  };
  t.log = log;
  return t;
}

(async () => {
  // --- who is on the line ---
  let t = fake([
    (m, p, q) => p === 'ContactCollection' && q.$filter === "NormalisedMobile eq '+6083472856'" ? { results: [CONTACT] } : undefined,
    (m, p, q) => p === 'EmployeeBasicDataCollection' ? { results: [{ FormattedName: 'James Theng' }] } : undefined,
  ]);
  let a = createC4CAdapter({}, t);
  let r = await a.resolve({ phone: '+60 8347 2856' });
  check('Phone lookup finds the contact using the stored format (+60…)', r.status === 'ok' && r.via === 'phone' && r.data.contactId === '1001' && r.data.accountId === '900000001', JSON.stringify(r.data));
  check('Owner name is looked up and shown', r.data.owner === 'James Theng');
  const contactQueries = t.log.filter((c) => c.path === 'ContactCollection');
  check('Phone lookup uses two single-field queries (C4C rejects "or" across fields)', contactQueries.length === 2 && contactQueries.every((c) => !/ or /.test(c.params.$filter)), contactQueries.map((c) => c.params.$filter).join(' | '));

  r = await createC4CAdapter({}, fake([
    (m, p, q) => p === 'ContactCollection' ? { results: [CONTACT] } : undefined,   // the same contact on both fields
  ])).resolve({ phone: '012-345 6789' });
  check('The same contact found on Mobile and Phone is listed once', r.status === 'ok');

  r = await createC4CAdapter({}, fake([
    (m, p, q) => p === 'ContactCollection' && /NormalisedMobile/.test(q.$filter) ? { results: [CONTACT, { ...CONTACT, ContactID: '1002', AccountID: '900000002', AccountFormattedName: 'Other Pharmacy' }] } : undefined,
  ])).resolve({ phone: '+60 8347 2856' });
  check('Two contacts on one number are reported as "multiple"', r.status === 'multiple' && r.data.length === 2);

  r = await createC4CAdapter({}, fake([])).resolve({ phone: '011-5555 0000' });
  check('A number nobody has is "not_found"', r.status === 'not_found');

  t = fake([]);
  await createC4CAdapter({}, t).resolve({ phone: '+60 8347 2856', externalId: 'NUB-1' });
  check('Without C4C_ACTIVITY_FIELD the activity is not queried', !t.log.some((c) => c.path === 'PhoneCallCollection'));

  t = fake([
    (m, p, q) => p === 'PhoneCallCollection' ? { results: [{ ID: '5', MainContactPartyID: '1001' }] } : undefined,
    (m, p, q) => p === 'ContactCollection' && q.$filter === "ContactID eq '1001'" ? { results: [CONTACT] } : undefined,
  ]);
  r = await createC4CAdapter({ activityField: 'GroupwareItemID' }, t).resolve({ phone: '+60 1', externalId: "NUB'1" });
  const act = t.log.find((c) => c.path === 'PhoneCallCollection');
  check('With the activity field set, the activity finds the contact first', r.via === 'activity' && r.data.contactId === '1001' && act.params.$filter === "GroupwareItemID eq 'NUB''1'", act.params.$filter);

  // The contact carries the account's UUID (the "open account" link needs it)
  t = fake([(m, p, q) => (p === 'ContactCollection' && /NormalisedMobile/.test(q.$filter) ? { results: [{ ...CONTACT, AccountUUID: '00163e4d-6601-1ee8-9c8a-07a41342db33' }] } : undefined)]);
  r = await createC4CAdapter({}, t).resolve({ phone: '+60 8347 2856' });
  check('The customer carries the account UUID for the open-in-C4C link', r.status === 'ok' && r.data.accountUuid === '00163e4d-6601-1ee8-9c8a-07a41342db33');
  check('The contact query asks for AccountUUID', /AccountUUID/.test(t.log.find((c) => c.path === 'ContactCollection').params.$select));

  // The real transport, with fetch replaced so nothing leaves this computer: which address and which field are used
  {
    const { createAdapter } = require('../lib/c4c-adapter');
    const urls = []; const realFetch = global.fetch;
    global.fetch = async (url, opts) => { urls.push({ url: String(url), auth: !!(opts && opts.headers && opts.headers.Authorization) }); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ d: { results: [] } }) }; };
    try {
      const base = { DATA_SOURCE: 'c4c', C4C_BASE_URL: 'https://t.example/', C4C_USER: 'u', C4C_PASSWORD: 'p' };
      await createAdapter(base).resolve({ phone: '+60 8347 2856', externalId: '4100234' });
      const first = urls[0];
      check('By default the activity is looked up by its ID (what Nubitel calls its External ID)', /PhoneCallCollection\?/.test(first.url) && decodeURIComponent(first.url).includes("$filter=ID eq '4100234'") && first.url.startsWith('https://t.example/sap/c4c/odata/v1/c4codataapi/'), decodeURIComponent(first.url).slice(0, 110));
      check('Requests carry basic-auth credentials and ask for JSON', first.auth && /%24format=json|\$format=json/.test(first.url));
      urls.length = 0;
      await createAdapter({ ...base, C4C_ACTIVITY_FIELD: '' }).resolve({ phone: '+60 8347 2856', externalId: '4100234' });
      check('C4C_ACTIVITY_FIELD="" turns the activity lookup off (phone number only)', !urls.some((u) => /PhoneCallCollection/.test(u.url)));
      urls.length = 0;
      await createAdapter(base).getSection('reco', { accountId: '900000001' });
      check('Recommendations go to the custom service, everything else to the standard one', urls.some((u) => u.url.startsWith('https://t.example/sap/c4c/odata/cust/v1/duopharma_snapshotproductrecommendation/SnapshotProdRecCollection')));
    } finally { global.fetch = realFetch; }
  }

  // --- sections ---
  t = fake([(m, p) => p === 'CustomerOrderCollection' ? { results: [{ ID: '8000001', DateTime: MS('2026-10-04T10:00:00Z'), NetAmount: '2150.5', NetAmountCurrencyCode: 'MYR', OrderExternalLifeCycleStatusCodeText: 'In Process' }] } : undefined]);
  r = await createC4CAdapter({}, t).getSection('order', { accountId: '900000001', contactId: '1001' });
  const oq = t.log[0].params;
  check('Last sales order: newest order of the account, mapped for the screen', r.status === 'ok' && r.data.id === '8000001' && r.data.date === '2026-10-04' && r.data.value === 'RM 2,150.50' && r.data.status === 'In Process', JSON.stringify(r.data));
  check('Last sales order query: buyer = account, newest first, one row', oq.$filter === "BuyerPartyID eq '900000001'" && oq.$orderby === 'DateTime desc' && oq.$top === 1);

  r = await createC4CAdapter({}, fake([])).getSection('order', { accountId: '900000001' });
  check('No order gives "empty"', r.status === 'empty');
  r = await createC4CAdapter({}, fake([])).getSection('order', { accountId: '' });
  check('A contact without an account gives "empty" without calling C4C', r.status === 'empty');

  t = fake([(m, p) => p === 'TasksCollection' ? { __count: '7', results: [
    { ID: '301', UUID: 'e1c764eb-8bbd-1eef-9dad-70e8913c9a61', Subject: 'Call back', DueDateTime: MS('2026-10-14T16:00:00Z'), StatusText: 'Open', PriorityCode: '2' },
    { ID: '302', UUID: 'e1c764eb-8bbd-1eef-9dad-70e8913c9a62', Subject: 'Send list', DueDateTime: MS('2026-10-20T16:00:00Z'), StatusText: 'In Process', PriorityCode: '3' },
    { ID: '303', UUID: '', Subject: 'Low one', DueDateTime: MS('2026-10-25T16:00:00Z'), StatusText: 'Open', PriorityCode: '7' },
  ] } : undefined]);
  r = await createC4CAdapter({}, t).getSection('tasks', { accountId: '900000001' });
  const tq = t.log[0].params;
  check('Open tasks: total comes from C4C, priorities mapped, dates in Malaysia time', r.status === 'ok' && r.data.count === 7 && r.data.items.length === 3 && r.data.items[0].priority === 'High' && r.data.items[1].priority === 'Normal' && r.data.items[2].priority === 'Low' && r.data.items[0].due === '2026-10-15', JSON.stringify(r.data.items.map((i) => i.due + '/' + i.priority)));
  check('Each task carries its UUID for the open-task link (blank if C4C gave none)', r.data.items[0].uuid === 'e1c764eb-8bbd-1eef-9dad-70e8913c9a61' && r.data.items[2].uuid === '' && /UUID/.test(tq.$select));
  check('Open tasks query: status Open or In Process only, soonest due first, counted', /MainAccountPartyID eq '900000001' and \(Status eq '1' or Status eq '2'\)/.test(tq.$filter) && tq.$orderby === 'DueDateTime asc' && tq.$inlinecount === 'allpages');

  // --- recommendations: the custom monthly snapshot ---
  const cur = currentPeriod();
  const SNAP = [
    { ProductID: 'P1', RecType: 'Special Price', Quantity: '300.00000000000000', QuantityUnitCode: 'ZBO' },
    { ProductID: 'P2', RecType: 'Repeat Order - Low Priority', Quantity: '12.50000000000000', QuantityUnitCode: 'XBX' },
    { ProductID: 'P9', RecType: 'Repeat Order - Low Priority', Quantity: '5.00000000000000', QuantityUnitCode: 'QQQ' },
  ];
  const nameAndUnitHandlers = [
    (m, p) => (p === 'ProductCollection' ? { results: [{ ProductID: 'P1', Description: 'BETAMOX 250MG GRAN 60ML BTL', Language: 'EN' }, { ProductID: 'P2', Description: "DEPOCON INJ 10'S BOX", Language: 'EN' }] } : undefined),
    (m, p) => (p === 'SnapshotProdRecQuantityUnitCodeCollection' ? { results: [{ Code: 'ZBO', Description: 'Bottle' }, { Code: 'XBX', Description: 'Box' }] } : undefined),
  ];
  const snapshotFor = (monthRows) => (m, p, q) => {
    if (p !== 'SnapshotProdRecCollection') return undefined;
    if (/ le /.test(q.$filter)) return { results: [{ SnapshotMonthYear: '2026-08' }] };           // "newest month up to now"
    const key = /SnapshotMonthYear eq '([\d-]+)'/.exec(q.$filter)[1];
    return { results: monthRows[key] || [] };
  };

  t = fake([snapshotFor({ [cur.key]: SNAP }), ...nameAndUnitHandlers]);
  a = createC4CAdapter({}, t);
  r = await a.getSection('reco', { accountId: '900000001', contactId: '1001' });
  const rq = t.log.find((c) => c.path === 'SnapshotProdRecCollection');
  check('Recommendations: the account\'s rows for this month, in the custom service, flagged for reports, by type then quantity',
    r.status === 'ok' && r.data.period === cur.key && rq.service === 'reco' && rq.params.$filter === `C4CCustomerID eq '900000001' and SnapshotMonthYear eq '${cur.key}' and ShowInReport eq 'Yes'` && rq.params.$orderby === 'RecTypeID asc,Quantity desc', rq.params.$filter);
  check('Recommendations are shown with product names, unit names, tidy quantities and the type as the reason',
    r.data.rows[0].product === 'BETAMOX 250MG GRAN 60ML BTL' && r.data.rows[0].qty === 300 && r.data.rows[0].uom === 'Bottle' && r.data.rows[0].reason === 'Special Price' && r.data.rows[1].qty === 12.5 && r.data.rows[1].uom === 'Box', JSON.stringify(r.data.rows[1]));
  check('A product without a name shows its ID, an unknown unit shows its code', r.data.rows[2].product === 'Product P9' && r.data.rows[2].uom === 'QQQ');
  check('All product names come from one call', t.log.filter((c) => c.path === 'ProductCollection').length === 1 && /ProductID eq 'P1' or ProductID eq 'P2' or ProductID eq 'P9'/.test(t.log.find((c) => c.path === 'ProductCollection').params.$filter));
  await a.getSection('reco', { accountId: '900000001' });
  check('The unit names are fetched once and remembered', t.log.filter((c) => c.path === 'SnapshotProdRecQuantityUnitCodeCollection').length === 1);

  t = fake([snapshotFor({ '2026-08': SNAP }), ...nameAndUnitHandlers]);
  r = await createC4CAdapter({}, t).getSection('reco', { accountId: '900000001' });
  check('No snapshot for this month: "empty" (and no silent switch to an older month)', r.status === 'empty' && t.log.filter((c) => c.path === 'SnapshotProdRecCollection').length === 1);

  t = fake([snapshotFor({ '2026-08': SNAP }), ...nameAndUnitHandlers]);
  r = await createC4CAdapter({ recoFallbackLatest: true }, t).getSection('reco', { accountId: '900000001' });
  const lq = t.log.find((c) => / le /.test(c.params.$filter || ''));
  check('With the fallback on, the newest earlier snapshot is shown and labelled as such', r.status === 'ok' && r.data.period === '2026-08' && r.data.label === 'Aug 2026' && r.data.note === 'latest available' && !!lq && lq.params.$orderby === 'SnapshotMonthYear desc', `${r.data && r.data.label} ${r.data && r.data.note}`);

  r = await createC4CAdapter({}, fake([snapshotFor({ [cur.key]: SNAP }), () => { throw new Error('names are down'); }])).getSection('reco', { accountId: '900000001' });
  check('If the name lookups fail the table still shows (IDs and codes instead of names)', r.status === 'ok' && r.data.rows[0].product === 'Product P1' && r.data.rows[0].uom === 'ZBO');
  check('Month labels: 2026-08 is Aug 2026', monthLabel('2026-08') === 'Aug 2026');

  // --- search ---
  t = fake([
    (m, p, q) => p === 'ContactCollection' && /substringof\('o''b',Name\)/.test(q.$filter) ? { results: [{ ...CONTACT, ContactID: '1', Name: 'Zed' }, { ...CONTACT, ContactID: '2', Name: 'Abe', NormalisedMobile: '+60111222333' }] } : undefined,
    (m, p, q) => p === 'ContactCollection' && /AccountFormattedName/.test(q.$filter) ? { results: [{ ...CONTACT, ContactID: '2', Name: 'Abe', NormalisedMobile: '+60111222333' }] } : undefined,
  ]);
  r = await createC4CAdapter({}, t).searchContacts("o'b");
  check('Contact search: name and account queries merged, de-duplicated, sorted, quotes escaped', r.length === 2 && r[0].name === 'Abe' && r[0].phoneHint === '…333' && t.log.length === 2, JSON.stringify(r.map((x) => x.name)));
  check('Search with fewer than 2 letters does nothing', (await createC4CAdapter({}, fake([])).searchContacts('a')).length === 0);

  // --- writes ---
  t = fake([
    (m, p, q) => p === 'ContactCollection' && m === 'GET' ? { results: [{ ...CONTACT, Mobile: '', Phone: '' }] } : undefined,
    (m) => (m === 'PATCH' ? {} : undefined),
  ]);
  await createC4CAdapter({}, t).updateContactPhone({ contactId: '1001', phone: '011-5555 0000' });
  let w = t.log.find((c) => c.method === 'PATCH');
  check('Saving a number goes into Mobile when it is free (as +60…)', w && w.path === "ContactCollection('OBJ1')" && w.body.Mobile === '+601155550000' && !('Phone' in w.body), JSON.stringify(w && w.body));

  t = fake([(m) => (m === 'GET' ? { results: [{ ...CONTACT, Mobile: '+60111111111', Phone: '' }] } : {})]);
  await createC4CAdapter({}, t).updateContactPhone({ contactId: '1001', phone: '011-5555 0000' });
  w = t.log.find((c) => c.method === 'PATCH');
  check('If Mobile is taken the number goes into Phone, never over an existing number', w && w.body.Phone === '+601155550000' && !('Mobile' in w.body));

  t = fake([(m) => (m === 'GET' ? { results: [{ ...CONTACT, Mobile: '+60111111111', Phone: '+60322222222' }] } : {})]);
  let refused = false;
  try { await createC4CAdapter({}, t).updateContactPhone({ contactId: '1001', phone: '011-5555 0000' }); } catch (e) { refused = e.code === 'bad_request'; }
  check('A contact with both numbers is refused, nothing is overwritten', refused && !t.log.some((c) => c.method === 'PATCH'));

  t = fake([(m) => (m === 'POST' ? { ContactID: '1500', ObjectID: 'NEW', Name: 'Ivy Tester', AccountID: '900000001' } : undefined)]);
  const created = await createC4CAdapter({}, t).createContact({ firstName: 'Ivy', lastName: 'Tester', accountId: '900000001', email: 'ivy@example.com', phone: '018-222 9999' });
  w = t.log.find((c) => c.method === 'POST');
  check('Creating a contact sends name, account, email and the call number', w && w.path === 'ContactCollection' && w.body.LastName === 'Tester' && w.body.AccountID === '900000001' && w.body.Mobile === '+60182229999' && w.body.Email === 'ivy@example.com' && created.contactId === '1500');

  // --- the access check the C4C administrator runs (npm run check:c4c) ---
  {
    const { runChecks, diagnose } = require('./check-c4c-access');
    const hdr = (map) => ({ get: (k) => map[k.toLowerCase()] || null });
    const json = { status: 200, headers: hdr({ 'content-type': 'application/json' }) };
    const seen = [];
    const fakeFetch = (rules) => async (url, opts) => {
      seen.push({ url, auth: opts.headers.Authorization });
      for (const [re, res] of rules) if (re.test(url)) { if (res instanceof Error) throw res; return res; }
      return json;
    };
    let res = await runChecks({ baseUrl: 'https://t.example/', user: 'svc', password: 'pw-secret', fetchImpl: fakeFetch([]) });
    check('Access check: every object the view reads is tested, and all pass when C4C answers with data', res.filter((x) => !x.info).length === 9 && res.filter((x) => !x.info).every((x) => x.ok), `${res.length} results`);
    res = await runChecks({
      baseUrl: 'https://t.example', user: 'svc', password: 'pw-secret',
      fetchImpl: fakeFetch([
        [/TasksCollection/, { status: 403, headers: hdr({}) }],
        [/CustomerOrderCollection/, { status: 401, headers: hdr({}) }],
        [/SnapshotProdRecCollection/, { status: 404, headers: hdr({}) }],
        [/ProductCollection/, { status: 200, headers: hdr({ 'content-type': 'text/html' }) }],
        [/EmployeeBasicDataCollection/, Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })],
      ]),
    });
    const by = (n) => res.find((x) => x.name === n);
    check('Access check explains each failure: no right (403), bad login (401), service missing (404), logon page instead of data, no connection',
      !by('Tasks').ok && /business role/.test(by('Tasks').note) && /not accepted/.test(by('Sales orders').note) && /not found/.test(by('Recommendation snapshot').note) && /web page/.test(by('Products').note) && /could not connect \(ENOTFOUND\)/.test(by('Employees').note));
    check('Access check keeps going after a failure and still passes the rest', by('Contacts').ok && by('Accounts').ok && by('Phone calls').ok);
    check('Access check sends the login only in the Authorization header, never in an address', seen.every((s) => !s.url.includes('pw-secret') && !s.url.includes('svc') && /^Basic /.test(s.auth)));
    check('Access check output has no customer data or password', !JSON.stringify(res).includes('pw-secret') && res.every((x) => !('body' in x) && !('d' in x)));

    const mixed = res;
    const tokenRow = (r) => r.find((x) => /^Write token/.test(x.name));
    res = await runChecks({ baseUrl: 'https://t.example', user: 'svc', password: 'pw-secret', fetchImpl: fakeFetch([[/c4codataapi\/$/, { status: 200, headers: hdr({ 'content-type': 'application/json', 'x-csrf-token': 'abc' }) }]]) });
    check('Access check: the write-token row is information only and says so when C4C hands out a token', tokenRow(res).info && tokenRow(res).ok && /issues a token/.test(tokenRow(res).note));
    res = await runChecks({ baseUrl: 'https://t.example', user: 'svc', password: 'pw-secret', fetchImpl: fakeFetch([[/./, { status: 200, headers: hdr({ 'content-type': 'text/html' }) }]]) });
    check('Access check: a logon page is never reported as a working write token', !tokenRow(res).ok && !/issues a token/.test(tokenRow(res).note));
    check('Access check: when every object fails the same way it says the sign-in is the problem, not the access rights', /signing in, not about access rights/.test(diagnose(res)));
    check('Access check: a mix of results gives no sign-in diagnosis', diagnose(mixed) === '');
  }

  // Replay list: the GET requests, so they can be run against a tenant
  if (process.argv.includes('--print')) {
    const all = fake([snapshotFor({ '2026-08': SNAP }), ...nameAndUnitHandlers]);
    const ad = createC4CAdapter({ activityField: 'GroupwareItemID', recoFallbackLatest: true }, all);
    await ad.resolve({ phone: '+60 111 222 333', externalId: 'X1' });
    await ad.getSection('order', { accountId: 'ACC' }); await ad.getSection('tasks', { accountId: 'ACC' });
    await ad.getSection('reco', { accountId: 'ACC' });
    await ad.searchContacts('ab'); await ad.searchAccounts('ab');
    console.log('\nGET requests:\n' + JSON.stringify(all.log.filter((c) => c.method === 'GET').map((c) => ({ service: c.service, path: c.path, params: c.params })), null, 1));
  }

  console.log(`\n${n - failed}/${n} adapter checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
