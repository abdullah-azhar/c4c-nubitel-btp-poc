'use strict';
/**
 * Checks what a C4C technical user can read through OData: exactly the objects the customer view needs.
 * Only reads (one row each). It prints the result of each check and nothing else: no customer data,
 * no credentials. Meant for the C4C administrator after creating the user, and for you before switching
 * the view to real data.
 *
 *   npm run check:c4c
 *
 * It uses C4C_BASE_URL, C4C_USER and C4C_PASSWORD from the environment; anything missing is asked for
 * (the password is not shown as you type). In PowerShell, without leaving the password in your history:
 *   $env:C4C_BASE_URL = 'https://my335945.crm.ondemand.com'
 *   $env:C4C_USER = Read-Host 'C4C technical user'
 *   $p = Read-Host 'C4C password' -AsSecureString
 *   $env:C4C_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))
 *   npm run check:c4c
 */
const readline = require('readline');

const SERVICES = {
  std: '/sap/c4c/odata/v1/c4codataapi',
  reco: '/sap/c4c/odata/cust/v1/duopharma_snapshotproductrecommendation',
};

// What the view reads, and why. "select" keeps each answer to one small field.
const CHECKS = [
  { name: 'Contacts', service: 'std', path: 'ContactCollection', select: 'ContactID', why: 'who is calling; search; saving a number' },
  { name: 'Accounts', service: 'std', path: 'CorporateAccountCollection', select: 'AccountID', why: 'account search; account of a contact' },
  { name: 'Sales orders', service: 'std', path: 'CustomerOrderCollection', select: 'ID', why: 'last sales order' },
  { name: 'Tasks', service: 'std', path: 'TasksCollection', select: 'ID', why: 'open tasks' },
  { name: 'Phone calls', service: 'std', path: 'PhoneCallCollection', select: 'ID', why: 'find the customer from the phone call activity' },
  { name: 'Employees', service: 'std', path: 'EmployeeBasicDataCollection', select: 'EmployeeID', why: 'owner name' },
  { name: 'Products', service: 'std', path: 'ProductCollection', select: 'ProductID', why: 'product names in the recommendations' },
  { name: 'Recommendation snapshot', service: 'reco', path: 'SnapshotProdRecCollection', select: 'ObjectID', why: 'recommended products of the month' },
  { name: 'Recommendation unit names', service: 'reco', path: 'SnapshotProdRecQuantityUnitCodeCollection', select: '', why: 'Box, Bottle, ... in the recommendations' },
];

// What a status means and what to ask the C4C administrator for
function explain(status, contentType) {
  if (status === 200 && /json/i.test(contentType || '')) return { ok: true, note: 'readable' };
  if (status === 200) return { ok: false, note: 'got a web page, not data: the logon was not accepted for API use (check that this user may sign in with a password)' };
  if (status === 401) return { ok: false, note: 'user or password not accepted (or the user is locked or expired)' };
  if (status === 403) return { ok: false, note: 'signed in, but not allowed to read this: add the access right for it to the user\'s business role' };
  if (status === 404) return { ok: false, note: 'not found: the service is not released for this user or tenant (check the service name)' };
  if (status === 429 || status === 503) return { ok: false, note: 'C4C is busy or limiting calls: try again in a minute' };
  return { ok: false, note: `unexpected answer (HTTP ${status})` };
}

// When every object fails the same way, the access rights are not the problem: the logon is. Say so once.
function diagnose(results) {
  const reads = results.filter((r) => !r.info);
  if (reads.length < 2 || reads.some((r) => r.ok)) return '';
  const first = reads[0];
  if (!reads.every((r) => r.status === first.status && r.note === first.note)) return '';
  return `Every object fails the same way (${first.status || 'no connection'}), so this is about signing in, not about access rights: ${first.note}.`;
}

async function runChecks({ baseUrl, user, password, fetchImpl = fetch, timeoutMs = 20000 }) {
  const origin = String(baseUrl || '').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const results = [];
  for (const c of CHECKS) {
    const url = `${origin}${SERVICES[c.service]}/${c.path}?$top=1&$format=json${c.select ? '&$select=' + c.select : ''}`;
    try {
      const res = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      const type = res.headers && res.headers.get ? res.headers.get('content-type') : '';
      results.push({ ...c, status: res.status, ...explain(res.status, type) });
    } catch (e) {
      const why = e && e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code) || e.cause.message);
      results.push({ ...c, status: 0, ok: false, note: e && e.name === 'TimeoutError' ? 'timed out' : `could not connect (${why || (e && e.message) || 'network error'})` });
    }
  }
  // Writes need a CSRF token first. This only shows that C4C hands one out; it does not prove write rights.
  try {
    const res = await fetchImpl(`${origin}${SERVICES.std}/`, { headers: { Authorization: auth, Accept: 'application/json', 'x-csrf-token': 'fetch' }, signal: AbortSignal.timeout(timeoutMs) });
    const token = (res.headers && res.headers.get ? res.headers.get('x-csrf-token') : '') || '';
    const issued = !!token && token.toLowerCase() !== 'required';
    results.push({
      name: 'Write token (only needed to create or change contacts)', service: 'std', status: res.status, ok: issued, info: true,
      note: issued ? 'C4C issues a token. Whether the user may change contacts can only be tested by a real change.'
        : res.status === 200 ? 'no token was returned, so writes would be refused' : explain(res.status, '').note,
    });
  } catch (e) {
    results.push({ name: 'Write token (only needed to create or change contacts)', service: 'std', status: 0, ok: false, note: 'could not connect', info: true });
  }
  return results;
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = rl._writeToOutput;
      rl._writeToOutput = function (s) { if (s.startsWith(question) || /^\r?\n$/.test(s)) write.call(rl, s); };   // do not echo what is typed
    }
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

async function main() {
  const baseUrl = process.env.C4C_BASE_URL || await ask('C4C address (https://myXXXXXX.crm.ondemand.com): ');
  const user = process.env.C4C_USER || await ask('Technical user: ');
  const password = process.env.C4C_PASSWORD || await ask('Password (not shown): ', true);
  console.log(`\nChecking ${baseUrl} as ${user}\n`);
  const results = await runChecks({ baseUrl, user, password });
  results.forEach((r) => console.log(`${r.info ? 'INFO' : r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(54)} ${String(r.status || '-').padEnd(4)} ${r.note}${r.ok || r.info ? '' : `   [needed for: ${r.why}]`}`));
  const failed = results.filter((r) => !r.ok && !r.info);
  console.log(`\n${results.filter((r) => r.ok && !r.info).length}/${results.filter((r) => !r.info).length} objects readable`);
  const why = diagnose(results);
  if (why) console.log(why);
  if (failed.length) console.log('Send the FAIL lines above to the C4C administrator. Nothing here shows customer data or the password.');
  process.exitCode = failed.length ? 1 : 0;   // not process.exit(): on Windows that can crash while network handles are closing
}

if (require.main === module) main().catch((e) => { console.error('check failed:', e.message); process.exitCode = 2; });
module.exports = { runChecks, CHECKS, explain, diagnose };
