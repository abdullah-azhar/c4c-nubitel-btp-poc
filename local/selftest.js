'use strict';
/**
 * Automated check of the POC in a real (headless) Chromium.
 * Needs Playwright: `npm i -D playwright` then `npx playwright install chromium`
 * (or set PW_CHROMIUM to an installed Chrome/Edge).
 * Start the servers first with a short saved-copy life so expiry can be tested:
 *   CACHE_TTL_SECONDS=12 npm start      then, in another terminal:   npm test
 * Screenshots are written to ./local/screens/.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const HOST = 'http://localhost:8081/';
const VIEW = 'http://localhost:8083';
const NUB = 'http://localhost:8082';
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  let apiCalls = 0;      // data calls the view makes to its own BTP backend
  let unauthorized = 0;  // 401 answers (an expired token)
  page.on('request', (r) => { if (r.url().startsWith(VIEW + '/api/')) apiCalls++; });
  page.on('response', (r) => { if (r.url().startsWith(VIEW + '/api/') && r.status() === 401) unauthorized++; });

  await page.goto(HOST);
  const nb = page.frameLocator('.mashup-slot iframe');
  const view = nb.frameLocator('#view');
  const open = (n) => nb.locator('#convList li', { hasText: n }).click();
  const name = (n, t = 8000) => view.locator('.cust-name', { hasText: n }).waitFor({ timeout: t });
  const settled = () => view.locator('.skel').first().waitFor({ state: 'detached', timeout: 12000 });
  const freshLoad = async () => { await view.locator('.skel').first().waitFor({ state: 'attached', timeout: 5000 }); await settled(); };
  const cacheTxt = () => view.locator('#diagCache').textContent();
  const mint = async (cid, phone, externalId) => (await (await fetch(NUB + '/nubitel-api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid, phone, externalId, agent: 'test' }),
  })).json()).token;

  // 1. Nesting renders and waits for a conversation
  await view.locator('#idle').waitFor({ timeout: 8000 });
  check('Three-layer nesting renders (C4C > Nubitel > BTP view)', true);
  check('Idle screen says it is waiting for a conversation', /Waiting for a conversation/.test(await view.locator('#idle').textContent()));

  // 2. The link is not public: opened directly it is locked
  const direct = await browser.newPage();
  const resp = await direct.goto(VIEW + '/');
  const lockedText = (await direct.locator('h1').textContent()) || '';
  const appInLocked = await direct.locator('#refresh').count();
  await direct.screenshot({ path: path.join(OUT, '0-locked.png') });
  await direct.close();
  check('Opening the view link directly shows a locked screen (403), not the app', resp.status() === 403 && /locked/i.test(lockedText) && appInLocked === 0, `status=${resp.status()}`);
  const raw = await Promise.all(['/', '/config.js', '/view.js', '/view.css'].map((p) => fetch(VIEW + p)));
  check('Page, config and scripts are refused unless loaded as a frame', raw.every((r) => r.status === 403), raw.map((r) => r.status).join(','));
  check('/health stays open for probes', (await fetch(VIEW + '/health')).status === 200);

  // 3. Known customer: the new layout and sections
  await open('Jenna Hopkins');
  await name('Jenna Hopkins');
  const recoLoading = await view.locator('[data-section="reco"] .skel').count();
  check('Customer header shows before the slower sections', recoLoading > 0, `recommendations still loading: ${recoLoading > 0}`);
  await settled();
  await page.screenshot({ path: path.join(OUT, '1-snapshot.png') });
  const orderIds = await view.locator('[data-section="order"] .so-id').count();
  const taskRows = await view.locator('[data-section="tasks"] .task').count();
  const recoRows = await view.locator('[data-section="reco"] .tbl tbody tr').count();
  check('Shows last sales order, open tasks and a recommendations table', orderIds === 1 && taskRows === 4 && recoRows >= 8, `order=${orderIds} tasks=${taskRows} reco rows=${recoRows}`);
  check('Quote section is gone', (await view.locator('[data-section="quote"]').count()) === 0);
  const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const recoPeriod = await view.locator('#recoPeriod').textContent();
  check('Recommendations are for the current month and year', recoPeriod.includes(monthLabel), `${recoPeriod} (expected ${monthLabel})`);
  const sty = await view.locator('[data-section="reco"] .scroll').evaluate((n) => ({ overflowY: getComputedStyle(n).overflowY, sticky: getComputedStyle(n.querySelector('th')).position }));
  check('Recommendations table scrolls in its own section with a sticky header', sty.overflowY === 'auto' && sty.sticky === 'sticky', JSON.stringify(sty));
  const inBar = await view.locator('.bar #refresh').count();
  const inCust = await view.locator('.cust #refresh').count();
  const btn = await view.locator('#refresh').boundingBox();
  const body = await view.locator('body').boundingBox();
  check('Refresh is an icon in the top bar, top right, not in the customer header', inBar === 1 && inCust === 0 && btn.x + btn.width > body.x + body.width - 30 && btn.y - body.y < 40, `x=${Math.round(btn.x - body.x)} of ${Math.round(body.width)}`);
  const links = await view.locator('a.icon-link').evaluateAll((as) => as.map((a) => ({ label: a.getAttribute('aria-label') || '', href: a.href })));
  const kinds = ['contact', 'account', 'order', 'task'];
  check('Contact, account, order and task each have an open-in-C4C icon link', kinds.every((k) => links.some((l) => l.label.toLowerCase().includes(k) && /InternalID=/.test(l.href))), `${links.length} links`);
  check('Open-in-C4C controls are icons (no text buttons)', (await view.locator('#openC4C').count()) === 0);

  // 4. One failing section does not block the others
  await open('Ali Hassan');
  await name('Ali Hassan');
  await view.locator('[data-section="order"] .state.error').waitFor({ timeout: 9000 });
  await view.locator('[data-section="tasks"] .task').first().waitFor({ timeout: 9000 });
  await view.locator('[data-section="reco"] .tbl tbody tr').first().waitFor({ timeout: 9000 });
  check('Failed section shows its own error + Retry; the others still load', (await view.locator('[data-section="order"] .state.error button').count()) === 1);

  // 5. Empty states
  await open('Mei Ling Tan');
  await view.locator('[data-section="order"] .state.empty', { hasText: 'No sales orders yet' }).waitFor({ timeout: 9000 });
  await view.locator('[data-section="tasks"] .state.empty', { hasText: 'No open tasks' }).waitFor({ timeout: 9000 });
  check('Empty sections say "No sales orders yet" / "No open tasks", not errors', true);

  // 6. Several contacts on one number: the agent picks
  await open('June Wong');
  await view.locator('.chooser-title', { hasText: '2 contacts share this number' }).waitFor({ timeout: 6000 });
  check('Shared number asks which contact is calling', (await view.locator('.match button').count()) === 2);
  await view.locator('.match button').first().click();
  await name('June Wong Yee Chun');
  await view.locator('.cust-sub', { hasText: 'Wong Pharmacy (KL)' }).waitFor({ timeout: 3000 });
  await settled();
  check('Picking a contact loads that account', true);
  await page.screenshot({ path: path.join(OUT, '2-multiple-picked.png') });

  // 7. Unknown caller: choose, then a popup opens on top
  await open('+60 11-5555 0000');
  await view.locator('#unknown').waitFor({ state: 'visible', timeout: 6000 });
  const unkText = await view.locator('#unknown').textContent();
  check('Unknown number shows its own screen with two options', /Unknown caller/.test(unkText) && (await view.locator('#chooseExisting').isVisible()) && (await view.locator('#chooseNew').isVisible()));
  check('No popup is open until an option is chosen', (await view.locator('#overlay').isHidden()));
  await page.screenshot({ path: path.join(OUT, '3-unknown-caller.png') });
  await view.locator('#chooseExisting').click();
  await view.locator('#overlay').waitFor({ state: 'visible', timeout: 3000 });
  check('Choosing an existing contact opens a popup on top', (await view.locator('#dlgTitle').textContent()) === 'Add number to an existing contact' && (await view.locator('#dialog[role="dialog"]').count()) === 1);
  check('Save is disabled until a contact is selected', await view.locator('#dlgFoot .btn', { hasText: 'Save number' }).isDisabled());
  await view.locator('#dlgBody input[type="search"]').fill('siti');
  await view.locator('#dlgBody [role="option"]').first().waitFor({ timeout: 5000 });
  check('Search lists the matching contacts', (await view.locator('#dlgBody [role="option"]').count()) === 2);
  await view.locator('#dlgBody [role="option"]').first().click();
  await page.screenshot({ path: path.join(OUT, '4-popup-existing.png') });
  await view.locator('#dlgFoot .btn', { hasText: 'Save number' }).click();
  await view.locator('#overlay').waitFor({ state: 'hidden', timeout: 6000 });
  await name('Siti Aminah', 9000);
  await settled();
  check('Saving the number on an existing contact loads that customer', true);
  check('Nubitel is told the contact was updated', /Contact updated/.test(await nb.locator('#testResults').textContent()));

  await open('+60 18-222 9999');
  await view.locator('#unknown').waitFor({ state: 'visible', timeout: 6000 });
  await view.locator('#chooseNew').click();
  await view.locator('#overlay').waitFor({ state: 'visible', timeout: 3000 });
  check('Choosing a new contact opens the create popup', (await view.locator('#dlgTitle').textContent()) === 'Create a new contact');
  await page.keyboard.press('Escape');
  await view.locator('#overlay').waitFor({ state: 'hidden', timeout: 3000 });
  check('Escape closes the popup without saving', await view.locator('#unknown').isVisible());
  await view.locator('#chooseNew').click();
  await view.locator('#dlgFoot .btn', { hasText: 'Create contact' }).click();
  check('Create popup asks for the missing required fields', /Last name is required/.test(await view.locator('#dlgBody').textContent()) && /Pick an account/.test(await view.locator('#dlgBody').textContent()));
  const inputs = view.locator('#dlgBody input');
  await inputs.nth(0).fill('Ivy');
  await inputs.nth(1).fill('Tester');
  await inputs.nth(2).fill('klinik lim');
  await view.locator('#dlgBody [role="option"]').first().click();
  await inputs.nth(3).fill('not-an-email');
  await view.locator('#dlgFoot .btn', { hasText: 'Create contact' }).click();
  check('Create popup rejects a bad email', /valid email/.test(await view.locator('#dlgBody').textContent()));
  check('The call number is filled in and cannot be edited', (await inputs.nth(4).inputValue()) === '018-222 9999' && await inputs.nth(4).evaluate((n) => n.readOnly));
  await inputs.nth(3).fill('ivy@example.com');
  await page.screenshot({ path: path.join(OUT, '5-popup-create.png') });
  await view.locator('#dlgFoot .btn', { hasText: 'Create contact' }).click();
  await view.locator('#overlay').waitFor({ state: 'hidden', timeout: 6000 });
  await name('Ivy Tester', 9000);
  await view.locator('.cust-sub', { hasText: 'Klinik Lim' }).waitFor({ timeout: 3000 });
  await settled();
  check('Creating a contact loads the new customer', true);

  // 8. Rapid switching: late data for earlier chats is dropped
  await nb.locator('#rapid').click();
  await page.waitForTimeout(9000);
  const dropped = await view.locator('#diagDropped').textContent();
  const nm = await view.locator('.cust-name').first().textContent();
  check('Rapid switch ends on the right customer', nm.trim() === 'Jenna Hopkins', nm.trim());
  check('Late responses from earlier chats were dropped', /stale dropped: [1-9]/.test(dropped), dropped);
  check('No mixed data after rapid switch', (await view.locator('[data-section="tasks"] .task').count()) === 4);

  // 9. Security checks on the data API
  const tok = await mint('conv-2294', '+60 8347 2856', 'NUB-CALL-100234');
  const auth = { headers: { Authorization: 'Bearer ' + tok } };
  const none = await Promise.all(['/api/customer', '/api/section/order', '/api/contacts/search?q=siti', '/api/accounts/search?q=klinik'].map((p) => fetch(VIEW + p)));
  const forged = await fetch(VIEW + '/api/customer', { headers: { Authorization: 'Bearer abc.def' } });
  const postNone = await fetch(VIEW + '/api/contact', { method: 'POST', body: '{}' });
  check('Data API rejects missing or forged tokens (reads, search and writes)', none.every((r) => r.status === 401) && forged.status === 401 && postNone.status === 401, `${none.map((r) => r.status)} forged=${forged.status} write=${postNone.status}`);
  const other = await fetch(VIEW + '/api/section/order?contact=2000457', auth);
  const own = await fetch(VIEW + '/api/section/order?contact=2000456', auth);
  check('A token can only read its own customer (another contact is refused)', other.status === 403 && own.status === 200, `other=${other.status} own=${own.status}`);
  const badWrite = await fetch(VIEW + '/api/contact', { method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'update', contactId: 'x y' }) });
  check('Contact write rejects invalid input', badWrite.status === 400, `status=${badWrite.status}`);

  // 10. Messages from the wrong origin are ignored by the view
  await open('Jenna Hopkins');
  await name('Jenna Hopkins');
  await settled();
  await page.evaluate(() => {
    const nbFrame = document.querySelector('.mashup-slot iframe');
    try { nbFrame.contentWindow.frames[0].postMessage({ v: 1, type: 'conversation.open', conversationId: 'evil', token: 'x.y' }, '*'); } catch (e) {}
  });
  await page.waitForTimeout(500);
  check('View ignores messages from origins other than Nubitel', (await view.locator('.cust-name').first().textContent()).trim() === 'Jenna Hopkins');

  // 11. Framing outside the allowed chain is refused (CSP frame-ancestors)
  const evil = await browser.newPage();
  await evil.goto('http://127.0.0.1:8081/'); // same app, different origin, not in frame-ancestors
  await evil.waitForTimeout(2500);
  const nbFrame = evil.frames().find((f) => f.url().startsWith('http://localhost:8082'));
  let nbRendered = false;
  if (nbFrame) { try { nbRendered = (await nbFrame.locator('#convList li').count()) > 0; } catch (e) { nbRendered = false; } }
  check('Nubitel refuses to load inside a non-approved host', !nbRendered, `rendered=${nbRendered}`);
  await evil.close();

  // 12. Saved copy, Refresh and token renewal. Needs CACHE_TTL_SECONDS=12.
  await page.waitForTimeout(13000);                       // Jenna's saved copy expires
  let a0 = apiCalls;
  await open('Jenna Hopkins');
  await freshLoad();
  check('Saved copy expires after the configured time (chat is loaded again)', apiCalls - a0 === 4, `data calls +${apiCalls - a0}`);

  await open('Mei Ling Tan');
  await name('Mei Ling Tan');
  await settled();
  a0 = apiCalls;
  await open('Jenna Hopkins');
  await name('Jenna Hopkins', 3000);
  const placeholders = await view.locator('.skel').count();
  await page.waitForTimeout(700);
  check('Switching back to a saved chat shows it at once, no placeholders, no data calls', placeholders === 0 && apiCalls === a0, `placeholders=${placeholders}, data calls +${apiCalls - a0}`);
  check('View reports a saved-copy hit', /cache: hit/.test(await cacheTxt()), await cacheTxt());
  await page.screenshot({ path: path.join(OUT, '6-saved-copy.png') });

  const refreshBtn = view.locator('#refresh');
  check('Refresh icon is enabled once the chat has loaded', await refreshBtn.isEnabled());
  a0 = apiCalls;
  await refreshBtn.click();
  await view.locator('#age', { hasText: 'Updating' }).waitFor({ timeout: 3000 });
  check('Refresh icon is disabled while updating', await refreshBtn.isDisabled());
  await view.locator('#age', { hasText: 'Updated just now' }).waitFor({ timeout: 12000 });
  await settled();
  check('Refresh loads the customer and every section again', apiCalls - a0 === 4, `data calls +${apiCalls - a0}`);
  check('Refresh icon comes back after the update', await refreshBtn.isEnabled());
  await page.screenshot({ path: path.join(OUT, '7-refreshed.png') });

  await open('Ali Hassan');
  await name('Ali Hassan');
  await settled();
  await open('Mei Ling Tan');
  await name('Mei Ling Tan', 3000);
  a0 = apiCalls;
  await open('Ali Hassan');
  await name('Ali Hassan', 3000);
  await view.locator('[data-section="order"] .skel').first().waitFor({ state: 'attached', timeout: 3000 });
  await settled();
  check('A failed section is never saved: only that one is asked again', apiCalls - a0 === 1 && /cache: partial/.test(await cacheTxt()), `data calls +${apiCalls - a0}, ${await cacheTxt()}`);

  await open('Jenna Hopkins');
  await name('Jenna Hopkins');
  await settled();
  const u0 = unauthorized;
  await nb.locator('#expiry').click();
  await freshLoad();
  const errorsShown = await view.locator('.state.error').count();
  check('An expired token is renewed on the spot and the view still loads', unauthorized > u0 && errorsShown === 0, `401s=${unauthorized - u0}, error states=${errorsShown}`);

  // 13. Mashup rebuilt on navigation drops Nubitel (reload counter)
  await page.locator('input[name="persist"][value="rerender"]').check();
  await page.locator('.nav button', { hasText: 'Accounts' }).click();
  await page.locator('#log li.fail', { hasText: 'reloaded' }).waitFor({ timeout: 5000 });
  check('Harness flags a Nubitel reload when the mashup is rebuilt', true);

  const relevantErrors = consoleErrors.filter((t) => !/frame-ancestors|Refused to frame|ERR_BLOCKED|favicon|status of (401|403|404|409|502)/i.test(t)); // 502 = the simulated failing order section
  check('No unexpected console errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
