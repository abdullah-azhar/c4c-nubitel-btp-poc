'use strict';
/**
 * Checks the real C4C adapter without a tenant: a fake transport answers like C4C does
 * (shapes taken from the my335945 test tenant), and every request the adapter makes is recorded.
 *   node local/adapter-test.js            runs the checks
 *   node local/adapter-test.js --print    also prints the GET requests (to replay against a tenant)
 */
const { createC4CAdapter } = require('../lib/c4c-adapter');

let failed = 0; let n = 0;
const check = (name, ok, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

const MS = (iso) => `/Date(${Date.parse(iso)})/`;
const CONTACT = { ObjectID: 'OBJ1', ContactID: '1001', Name: 'Jenna Hopkins', AccountID: '900000001', AccountFormattedName: 'Hopkins Pharmacy', ContactOwnerID: '77', Mobile: '', Phone: '', NormalisedMobile: '+6083472856', NormalisedPhone: '' };

function fake(handlers) {
  const log = [];
  const t = async (method, path, params, body) => {
    log.push({ method, path, params: params || {}, body });
    for (const h of handlers) { const r = h(method, path, params || {}, body); if (r !== undefined) return r; }
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
    { ID: '301', Subject: 'Call back', DueDateTime: MS('2026-10-14T16:00:00Z'), StatusText: 'Open', PriorityCode: '2' },
    { ID: '302', Subject: 'Send list', DueDateTime: MS('2026-10-20T16:00:00Z'), StatusText: 'In Process', PriorityCode: '3' },
    { ID: '303', Subject: 'Low one', DueDateTime: MS('2026-10-25T16:00:00Z'), StatusText: 'Open', PriorityCode: '7' },
  ] } : undefined]);
  r = await createC4CAdapter({}, t).getSection('tasks', { accountId: '900000001' });
  const tq = t.log[0].params;
  check('Open tasks: total comes from C4C, priorities mapped, dates in Malaysia time', r.status === 'ok' && r.data.count === 7 && r.data.items.length === 3 && r.data.items[0].priority === 'High' && r.data.items[1].priority === 'Normal' && r.data.items[2].priority === 'Low' && r.data.items[0].due === '2026-10-15', JSON.stringify(r.data.items.map((i) => i.due + '/' + i.priority)));
  check('Open tasks query: status Open or In Process only, soonest due first, counted', /MainAccountPartyID eq '900000001' and \(Status eq '1' or Status eq '2'\)/.test(tq.$filter) && tq.$orderby === 'DueDateTime asc' && tq.$inlinecount === 'allpages');

  r = await createC4CAdapter({}, fake([])).getSection('reco', { accountId: '900000001' });
  check('Recommendations say "not_configured" until the object is known (no guessed data)', r.status === 'not_configured');

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

  // Replay list: the GET requests, so they can be run against a tenant
  if (process.argv.includes('--print')) {
    const all = fake([]); const ad = createC4CAdapter({ activityField: 'GroupwareItemID' }, all);
    await ad.resolve({ phone: '+60 111 222 333', externalId: 'X1' });
    await ad.getSection('order', { accountId: 'ACC' }); await ad.getSection('tasks', { accountId: 'ACC' });
    await ad.searchContacts('ab'); await ad.searchAccounts('ab');
    console.log('\nGET requests:\n' + JSON.stringify(all.log.filter((c) => c.method === 'GET').map((c) => ({ path: c.path, params: c.params })), null, 1));
  }

  console.log(`\n${n - failed}/${n} adapter checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
