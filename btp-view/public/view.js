/* BTP lean view: renders the C4C customer for whichever conversation Nubitel has open.
 *
 * Two modes, chosen per conversation by Nubitel:
 *   Option A "push": Nubitel calls C4C and sends one section.update message per section.
 *   Option B "pull": Nubitel sends a short-lived signed token; this page calls its own
 *                    /api with that token and BTP calls C4C.
 *
 * Rules this page enforces (see docs/MESSAGE-CONTRACT.md):
 *   - accept messages only from window.parent AND an allowed origin
 *   - every section renders on its own, with loading / empty / error states
 *   - anything for an older conversation is dropped
 *   - customer data is written with textContent only (never innerHTML)
 *   - nothing is stored in localStorage, sessionStorage or cookies
 */
(function () {
  'use strict';
  const CFG = window.VIEW_CONFIG || { messageOrigins: [], sections: ['quote', 'order', 'tickets', 'items'], sectionTimeoutMs: 6000, deepLinkTemplate: '' };
  const ALL = ['customer'].concat(CFG.sections);

  let parentOrigin = null;
  let current = null;            // { cid, mode, token, gen, started, timers }
  let gen = 0;
  let dropped = 0;
  const times = {};

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const slot = (s) => $(`[data-section="${s}"] .slot`);

  // ---------- messaging ----------
  function post(msg) {
    const body = Object.assign({ v: 1 }, msg);
    if (parentOrigin) window.parent.postMessage(body, parentOrigin);
    else CFG.messageOrigins.forEach((o) => window.parent.postMessage(body, o)); // only the real parent's origin receives it
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    if (!CFG.messageOrigins.includes(e.origin)) { console.warn('[view] rejected message from', e.origin); return; }
    const m = e.data;
    if (!m || m.v !== 1 || typeof m.type !== 'string') return;
    parentOrigin = e.origin;

    if (m.type === 'conversation.open') return openConversation(m);
    if (m.type === 'conversation.close') { if (current && m.conversationId === current.cid) showIdle(); return; }
    if (m.type === 'section.update') {
      if (!current || m.conversationId !== current.cid || current.mode !== 'push') { dropped++; updateDiag(); return; }
      return applySection(m.section, m.status, m.data);
    }
  });

  // ---------- conversation lifecycle ----------
  function openConversation(m) {
    if (!m.conversationId) return;
    clearTimers();
    current = { cid: m.conversationId, mode: m.mode === 'pull' ? 'pull' : 'push', token: m.token || null, gen: ++gen, started: performance.now(), timers: {} };
    for (const k in times) delete times[k];
    $('#idle').hidden = true;
    $('#view').hidden = false;
    $('#openC4C').hidden = true;
    ALL.forEach((s) => setLoading(s));
    ALL.forEach((s) => armTimeout(s));
    updateDiag();
    if (current.mode === 'pull') pullAll(current.gen);
  }

  function showIdle() {
    clearTimers();
    current = null;
    $('#view').hidden = true;
    $('#idle').hidden = false;
    updateDiag();
  }

  function clearTimers() { if (current) Object.values(current.timers).forEach(clearTimeout); }

  function armTimeout(s) {
    const g = current.gen;
    current.timers[s] = setTimeout(() => {
      if (!current || current.gen !== g) return;
      setError(s, 'Taking too long');
    }, CFG.sectionTimeoutMs);
  }

  function retry(s) {
    if (!current) return;
    setLoading(s);
    armTimeout(s);
    if (current.mode === 'pull') {
      if (s === 'customer') pullAll(current.gen); else pullSection(s, current.gen);
    } else {
      post({ type: 'view.retry', conversationId: current.cid, section: s });
    }
  }

  // ---------- Option B: pull with token ----------
  async function api(path, g) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.sectionTimeoutMs);
    try {
      const res = await fetch(path, { headers: { Authorization: 'Bearer ' + current.token }, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
      if (!current || current.gen !== g) return null;
      if (res.status === 401) return { status: 'error', error: 'Session expired, reopen the chat' };
      if (res.status === 404) return { status: 'not_found' };
      if (!res.ok) return { status: 'error' };
      return await res.json();
    } catch (e) {
      return (!current || current.gen !== g) ? null : { status: 'error' };
    } finally { clearTimeout(t); }
  }

  async function pullAll(g) {
    const r = await api('/api/customer', g);
    if (!r) return;
    applySection('customer', r.status, r.data);
    if (r.status === 'ok') CFG.sections.forEach((s) => pullSection(s, g));
  }

  async function pullSection(s, g) {
    const r = await api('/api/section/' + s, g);
    if (r) applySection(s, r.status, r.data);
  }

  // ---------- rendering ----------
  function applySection(s, status, data) {
    if (!ALL.includes(s) || !current) return;
    if (status === 'loading') return setLoading(s);
    clearTimeout(current.timers[s]);
    times[s] = Math.round(performance.now() - current.started);
    updateDiag();

    if (s === 'customer') return renderCustomer(status, data);
    if (status === 'error') return setError(s, 'Could not load');
    if (status === 'empty' || !data) return setState(s, 'empty', emptyText(s));
    RENDER[s](slot(s), data);
  }

  function renderCustomer(status, data) {
    const box = slot('customer');
    box.replaceChildren();
    if (status === 'ok' && data) {
      box.append(el('p', 'cust-name', data.name), el('p', 'cust-sub', [data.account, data.owner && 'Owner: ' + data.owner].filter(Boolean).join('  ·  ')));
      setDeepLink(data.accountId);
      return;
    }
    // Customer not usable: other sections cannot load, so stop them.
    CFG.sections.forEach((s) => { clearTimeout(current.timers[s]); setState(s, 'empty', '-'); });
    if (status === 'not_found') {
      box.append(el('p', 'cust-name', 'Customer not found'), el('p', 'cust-sub', 'This number is not linked to a C4C contact.'));
    } else if (status === 'multiple' && Array.isArray(data)) {
      box.append(el('p', 'cust-name', `${data.length} matching contacts`), el('p', 'cust-sub', 'Check which customer this is:'));
      data.forEach((c) => {
        const row = el('div', 'match');
        row.append(el('span', null, `${c.name} · ${c.account}`), link(c.accountId, 'Open'));
        box.append(row);
      });
    } else {
      box.append(el('p', 'cust-name', 'Could not load customer'));
      const st = el('p', 'state error', 'C4C did not respond.');
      const b = el('button', null, 'Retry'); b.addEventListener('click', () => retry('customer'));
      st.append(b); box.append(st);
    }
  }

  const RENDER = {
    quote: (box, d) => box.replaceChildren(el('p', 'big', d.id), el('p', 'small', [d.items && d.items + ' items', d.status].filter(Boolean).join(' · '))),
    order: (box, d) => box.replaceChildren(el('p', 'big', d.id), el('p', 'small', [d.date, d.status].filter(Boolean).join(' · '))),
    tickets: (box, d) => box.replaceChildren(el('p', 'big', String(d.count)), el('p', 'small', d.latest || '')),
    items: (box, d) => {
      const ul = el('ul');
      (d || []).forEach((i) => ul.append(el('li', null, `${i.product} · ${i.qty} ${i.uom || ''}`.trim())));
      box.replaceChildren(ul);
    },
  };

  const emptyText = (s) => ({ quote: 'No open quote', order: 'No orders yet', tickets: 'No open tickets', items: 'No recommendations' }[s] || 'Nothing to show');

  function setLoading(s) {
    const box = slot(s);
    if (!box) return;
    box.replaceChildren(el('div', 'skel w60'), el('div', 'skel w80'), ...(s === 'items' ? [el('div', 'skel w40')] : []));
  }

  function setState(s, kind, text) { const box = slot(s); if (box) box.replaceChildren(el('p', 'state ' + kind, text)); }

  function setError(s, text) {
    if (s === 'customer') return renderCustomer('error');
    const p = el('p', 'state error', text);
    const b = el('button', null, 'Retry');
    b.addEventListener('click', () => retry(s));
    p.append(b);
    slot(s).replaceChildren(p);
  }

  function deepLink(accountId) { return CFG.deepLinkTemplate.replace('{accountId}', encodeURIComponent(accountId)); }

  function link(accountId, text) {
    const a = el('a', null, text);
    a.href = deepLink(accountId); a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.addEventListener('click', () => post({ type: 'view.action', action: 'openInC4C', conversationId: current && current.cid, accountId }));
    return a;
  }

  function setDeepLink(accountId) {
    const a = $('#openC4C');
    a.href = deepLink(accountId);
    a.hidden = false;
    a.onclick = () => post({ type: 'view.action', action: 'openInC4C', conversationId: current && current.cid, accountId });
  }

  function updateDiag() {
    $('#diagMode').textContent = 'mode: ' + (current ? (current.mode === 'pull' ? 'B (token)' : 'A (push)') : '-');
    $('#diagTimes').textContent = Object.keys(times).map((k) => `${k} ${times[k]}ms`).join(' · ');
    $('#diagDropped').textContent = 'stale dropped: ' + dropped;
  }

  post({ type: 'view.ready' });
})();
