'use strict';
/**
 * Automated check of the POC in a real (headless) Chromium.
 * Needs Playwright: `npm i -D playwright` then `npx playwright install chromium`.
 * Start the servers first (`npm start`), then run `npm test`.
 * Screenshots are written to ./local/screens/.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const HOST = 'http://localhost:8081/';
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 820 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(HOST);
  const nb = page.frameLocator('.mashup-slot iframe');
  const view = nb.frameLocator('#view');

  // 1. Nesting renders: C4C -> Nubitel -> BTP view
  await view.locator('#idle').waitFor({ timeout: 8000 });
  check('Three-layer nesting renders (C4C > Nubitel > BTP view)', true);

  // 2. Option A happy path, sections arrive independently
  await nb.locator('#convList li', { hasText: 'Jenna Hopkins' }).click();
  await view.locator('.cust-name', { hasText: 'Jenna Hopkins' }).waitFor({ timeout: 5000 });
  const headerFirst = await view.locator('[data-section="order"] .skel').count();
  check('Option A: customer header shows before slower sections', headerFirst > 0, `order still loading: ${headerFirst > 0}`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, '1-loading-sections.png') });
  await view.locator('[data-section="items"] li').first().waitFor({ timeout: 8000 });
  await view.locator('[data-section="order"] .big').waitFor({ timeout: 8000 });
  check('Option A: all sections load', true);
  await page.screenshot({ path: path.join(OUT, '2-option-a-loaded.png') });

  // 3. Per-section error does not block others
  await nb.locator('#convList li', { hasText: 'Ali Hassan' }).click();
  await view.locator('[data-section="order"] .state.error').waitFor({ timeout: 8000 });
  await view.locator('[data-section="quote"] .big').waitFor({ timeout: 8000 });
  check('Failed section shows its own error + Retry; others still load', true);
  await page.screenshot({ path: path.join(OUT, '3-section-error.png') });

  // 4. Empty states
  await nb.locator('#convList li', { hasText: 'Mei Ling Tan' }).click();
  await view.locator('[data-section="quote"] .state.empty', { hasText: 'No open quote' }).waitFor({ timeout: 8000 });
  check('Empty sections show "No open quote" / "No open tickets", not errors', true);

  // 5. Not found and multiple matches
  await nb.locator('#convList li', { hasText: '+60 11-5555 0000' }).click();
  await view.locator('.cust-name', { hasText: 'Customer not found' }).waitFor({ timeout: 5000 });
  check('Unknown number shows "Customer not found"', true);
  await nb.locator('#convList li', { hasText: 'June Wong' }).click();
  await view.locator('.cust-name', { hasText: '2 matching contacts' }).waitFor({ timeout: 5000 });
  check('Shared number lists both matching contacts', true);
  await page.screenshot({ path: path.join(OUT, '4-multiple-matches.png') });

  // 6. Rapid switching: late data for earlier chats is dropped
  await nb.locator('#rapid').click();
  await page.waitForTimeout(9000);
  const name = await view.locator('.cust-name').first().textContent();
  const dropped = await view.locator('#diagDropped').textContent();
  const items = await view.locator('[data-section="items"] li').count();
  check('Rapid switch ends on the right customer', name.trim() === 'Jenna Hopkins', name.trim());
  check('Late responses from earlier chats were dropped', /stale dropped: [1-9]/.test(dropped), dropped);
  check('No mixed data after rapid switch', items === 3, `items=${items}`);

  // 7. Option B: signed token, BTP calls the data source
  await nb.locator('#mode').selectOption('pull');
  await nb.locator('#convList li', { hasText: 'Jenna Hopkins' }).click();
  await view.locator('#diagMode', { hasText: 'B (token)' }).waitFor({ timeout: 5000 });
  await view.locator('[data-section="order"] .big').waitFor({ timeout: 8000 });
  check('Option B: token flow loads all sections', true);
  await page.screenshot({ path: path.join(OUT, '5-option-b.png') });

  // 8. Option B: forged / missing token is rejected by BTP
  const forged = (await fetch('http://localhost:8083/api/customer', { headers: { Authorization: 'Bearer abc.def' } })).status;
  const noToken = (await fetch('http://localhost:8083/api/section/order')).status;
  check('BTP API rejects a forged or missing token', forged === 401 && noToken === 401, `forged=${forged} missing=${noToken}`);

  // 9. Messages from the wrong origin are ignored by the view
  await page.evaluate(() => {
    // The C4C host (wrong origin, not the view's parent) tries to inject data
    const nbFrame = document.querySelector('.mashup-slot iframe');
    try { nbFrame.contentWindow.frames[0].postMessage({ v: 1, type: 'conversation.open', conversationId: 'evil', mode: 'push' }, '*'); } catch (e) {}
  });
  await page.waitForTimeout(500);
  const stillJenna = await view.locator('.cust-name').first().textContent();
  check('View ignores messages from origins other than Nubitel', stillJenna.trim() === 'Jenna Hopkins');

  // 10. Framing outside the allowed chain is refused (CSP frame-ancestors)
  const evil = await browser.newPage();
  await evil.goto('http://127.0.0.1:8081/'); // same app, different origin, not in frame-ancestors
  await evil.waitForTimeout(2500);
  const nbFrame = evil.frames().find((f) => f.url().startsWith('http://localhost:8082'));
  let nbRendered = false;
  if (nbFrame) { try { nbRendered = (await nbFrame.locator('#convList li').count()) > 0; } catch (e) { nbRendered = false; } }
  check('Nubitel refuses to load inside a non-approved host', !nbRendered, `rendered=${nbRendered}`);
  await evil.close();

  // 11. Mashup rebuilt on navigation drops Nubitel (reload counter)
  await page.locator('input[name="persist"][value="rerender"]').check();
  await page.locator('.nav button', { hasText: 'Accounts' }).click();
  await page.locator('#log li.fail', { hasText: 'reloaded' }).waitFor({ timeout: 5000 });
  check('Harness flags a Nubitel reload when the mashup is rebuilt', true);
  await page.screenshot({ path: path.join(OUT, '6-reload-warning.png') });

  const relevantErrors = consoleErrors.filter((t) => !/frame-ancestors|Refused to frame|ERR_BLOCKED|favicon/i.test(t));
  check('No unexpected console errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
