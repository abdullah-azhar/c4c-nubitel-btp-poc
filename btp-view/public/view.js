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
 *
 * Saved copy ("cache"): what was loaded for a conversation is kept in this page's
 * memory only, so switching back to a chat shows it at once without asking C4C again.
 * It expires after cacheTtlMs, holds at most CACHE_MAX chats, is dropped when the
 * conversation closes, and disappears when the page is closed or reloaded. Failed
 * sections are never saved. The Refresh button throws the saved copy away and re-queries.
 */
(function () {
  'use strict';
  const CFG = window.VIEW_CONFIG || { messageOrigins: [], sections: ['quote', 'order', 'tickets', 'items'], sectionTimeoutMs: 6000, deepLinkTemplate: '' };
  const ALL = ['customer'].concat(CFG.sections);
  const TTL = Number.isFinite(CFG.cacheTtlMs) ? CFG.cacheTtlMs : 300000; // 0 turns the saved copy off
  const CACHE_MAX = 20;

  let parentOrigin = null;
  let current = null;            // { cid, mode, token, gen, started, timers, pending, at, cacheState }
  let gen = 0;
  let dropped = 0;
  const times = {};
  const cache = new Map();       // conversationId -> { sections: { name: { status, data, at } }, used }

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
    if (m.type === 'conversation.close') {
      cache.delete(m.conversationId);
      if (current && m.conversationId === current.cid) showIdle();
      else updateDiag();
      return;
    }
    if (m.type === 'section.update') {
      if (!current || m.conversationId !== current.cid || current.mode !== 'push') { dropped++; updateDiag(); return; }
      return applySection(m.section, m.status, m.data);
    }
  });

  // ---------- saved copy ----------
  const SAVEABLE = { customer: ['ok', 'not_found', 'multiple'], other: ['ok', 'empty'] };

  function cacheGet(cid) {
    const e = cache.get(cid);
    if (!e) return null;
    const now = Date.now();
    Object.keys(e.sections).forEach((s) => { if (now - e.sections[s].at > TTL) delete e.sections[s]; });
    // A saved chat is only usable together with its customer; if that expired, start over.
    if (!e.sections.customer) { cache.delete(cid); return null; }
    e.used = now;
    return e;
  }

  function cachePut(cid, s, status, data) {
    if (TTL <= 0) return;
    if (!(s === 'customer' ? SAVEABLE.customer : SAVEABLE.other).includes(status)) return; // never save errors
    let e = cache.get(cid);
    if (s === 'customer') {
      // A new customer answer starts a fresh copy, so sections from different fetches never mix.
      e = { sections: {}, used: 0 };
      cache.set(cid, e);
    } else if (!e || !e.sections.customer) return;
    e.sections[s] = { status, data, at: Date.now() };
    e.used = Date.now();
    while (cache.size > CACHE_MAX) {
      let oldest = null;
      for (const [k, v] of cache) if (oldest === null || v.used < cache.get(oldest).used) oldest = k;
      cache.delete(oldest);
    }
  }

  // What the saved copy covers, and what still has to be fetched.
  function plan(entry) {
    if (!entry) return { have: [], missing: ALL.slice() };
    const have = ['customer'];
    const missing = [];
    if (entry.sections.customer.status !== 'ok') {         // not found / several matches: nothing more to load
      CFG.sections.forEach((s) => have.push(s));
      return { have, missing };
    }
    CFG.sections.forEach((s) => (entry.sections[s] ? have : missing).push(s));
    return { have, missing };
  }

  // ---------- conversation lifecycle ----------
  function openConversation(m) {
    if (!m.conversationId) return;
    clearTimers();
    const cid = m.conversationId;
    if (m.refresh === true) cache.delete(cid);              // Refresh: ignore the saved copy
    const entry = cacheGet(cid);
    const { have, missing } = plan(entry);
    current = {
      cid, mode: m.mode === 'pull' ? 'pull' : 'push', token: m.token || null, gen: ++gen,
      started: performance.now(), timers: {}, pending: new Set(missing), at: {},
      cacheState: TTL <= 0 ? 'off' : entry ? (missing.length ? 'partial' : 'hit') : 'miss',
    };
    for (const k in times) delete times[k];
    $('#idle').hidden = true;
    $('#view').hidden = false;
    $('#openC4C').hidden = true;

    // Saved parts appear immediately; only the missing ones show a loading placeholder.
    if (entry) ALL.forEach((s) => { const c = entry.sections[s]; if (c) applySection(s, c.status, c.data, { cached: true, at: c.at }); });
    missing.forEach((s) => { setLoading(s); armTimeout(s); });
    updateDiag(); renderAge(); updateRefresh();

    // Tell Nubitel what is already held, so (Option A) it only asks C4C for the rest.
    const cust = entry && entry.sections.customer;
    post({
      type: 'view.cache', conversationId: cid, have, missing,
      accountId: cust && cust.status === 'ok' && cust.data ? cust.data.accountId : null,
      ageMs: entry ? Date.now() - Math.min(...Object.values(entry.sections).map((c) => c.at)) : null,
    });
    if (current.mode === 'pull') pullMissing(missing, current.gen);
  }

  function showIdle() {
    clearTimers();
    current = null;
    $('#view').hidden = true;
    $('#idle').hidden = false;
    updateDiag(); renderAge(); updateRefresh();
  }

  function clearTimers() { if (current) Object.values(current.timers).forEach(clearTimeout); }

  function armTimeout(s) {
    const g = current.gen;
    current.timers[s] = setTimeout(() => {
      if (!current || current.gen !== g) return;
      setError(s, 'Taking too long');
    }, CFG.sectionTimeoutMs);
  }

  // A section has finished (loaded, empty or failed): Refresh may light up when all have.
  function settle(s) { if (current) { current.pending.delete(s); updateRefresh(); renderAge(); } }

  function retry(s) {
    if (!current) return;
    current.pending.add(s);
    setLoading(s);
    armTimeout(s);
    updateRefresh(); renderAge();
    if (current.mode === 'pull') {
      if (s === 'customer') pullAll(current.gen); else pullSection(s, current.gen);
    } else {
      post({ type: 'view.retry', conversationId: current.cid, section: s });
    }
  }

  // ---------- Refresh button ----------
  $('#refresh').addEventListener('click', () => {
    if (!current || current.pending.size) return;
    const cid = current.cid;
    cache.delete(cid);                                      // forget the saved copy
    clearTimers();
    current.gen = ++gen;                                    // anything still in flight is stale now
    current.started = performance.now();
    current.pending = new Set(ALL);
    current.at = {};
    current.cacheState = 'refresh';
    for (const k in times) delete times[k];
    $('#openC4C').hidden = true;
    ALL.forEach((s) => { setLoading(s); armTimeout(s); });
    updateDiag(); renderAge(); updateRefresh();
    // Nubitel answers with conversation.open { refresh: true } (and a new token in Option B).
    post({ type: 'view.refresh', conversationId: cid });
  });

  function updateRefresh() {
    const b = $('#refresh');
    b.disabled = !current || current.pending.size > 0;
  }

  // "Updated 3 min ago": age of the oldest part on screen, so it is never overstated.
  function renderAge() {
    const a = $('#age');
    if (!current) { a.textContent = ''; return; }
    if (current.pending.size) { a.textContent = 'Updating…'; return; }
    const ats = Object.values(current.at);
    if (!ats.length) { a.textContent = ''; return; }
    const mins = Math.floor((Date.now() - Math.min(...ats)) / 60000);
    a.textContent = mins < 1 ? 'Updated just now' : mins < 60 ? `Updated ${mins} min ago` : 'Updated over 1 h ago';
  }
  setInterval(renderAge, 15000);

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

  function pullMissing(missing, g) {
    if (!missing.length) return;
    if (missing.includes('customer')) return pullAll(g);
    missing.forEach((s) => pullSection(s, g));
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
  function applySection(s, status, data, opts = {}) {
    if (!ALL.includes(s) || !current) return;
    if (status === 'loading') return setLoading(s);
    clearTimeout(current.timers[s]);
    times[s] = opts.cached ? 'saved' : Math.round(performance.now() - current.started) + 'ms';
    current.at[s] = opts.at || Date.now();
    if (!opts.cached) cachePut(current.cid, s, status, data);
    settle(s);
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
    CFG.sections.forEach((s) => { clearTimeout(current.timers[s]); settle(s); setState(s, 'empty', '-'); });
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
    settle(s);
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
    $('#diagTimes').textContent = Object.keys(times).map((k) => `${k} ${times[k]}`).join(' · ');
    $('#diagCache').textContent = TTL <= 0 ? 'cache: off' : `cache: ${current ? current.cacheState : '-'} · ${cache.size} saved`;
    $('#diagDropped').textContent = 'stale dropped: ' + dropped;
  }

  updateRefresh();
  post({ type: 'view.ready' });
})();
