/* BTP lean view: shows the C4C customer for the conversation Nubitel has open.
 *
 * Security option B only: Nubitel sends a short-lived signed token; this page
 * calls its own /api with it and BTP calls C4C.
 *
 * Rules this page enforces (see docs/MESSAGE-CONTRACT.md):
 *   - accept messages only from window.parent AND an allowed origin
 *   - every section renders on its own, with loading / empty / error states
 *   - anything for an older conversation is dropped
 *   - customer data is written with textContent only (never innerHTML)
 *   - nothing is stored in localStorage, sessionStorage or cookies
 *
 * Saved copy: what was loaded per conversation is kept in this page's memory only
 * (expires after cacheTtlMs, max CACHE_MAX chats, dropped on close, never saved on
 * errors) so switching back to a chat is instant. Refresh throws it away.
 */
(function () {
  'use strict';
  const CFG = Object.assign({
    messageOrigins: [], sections: ['order', 'tasks', 'reco'], sectionTimeoutMs: 6000, cacheTtlMs: 300000,
    links: {}, writesEnabled: false, showDiagnostics: false,
  }, window.VIEW_CONFIG || {});
  const SECTIONS = CFG.sections;
  const ALL = ['customer'].concat(SECTIONS);
  const TTL = Number.isFinite(CFG.cacheTtlMs) ? CFG.cacheTtlMs : 300000; // 0 turns the saved copy off
  const CACHE_MAX = 20;
  const NS = 'http://www.w3.org/2000/svg';

  let parentOrigin = null;
  let current = null;            // { cid, token, gen, started, timers, pending, at, fresh, contactId, cacheState, unknown }
  let gen = 0;
  let dropped = 0;
  let renewal = null;            // a token renewal waiting for Nubitel's answer
  let dlg = null;                // the open popup, if any
  const times = {};
  const cache = new Map();       // conversationId -> { sections: { name: { status, data, at } }, used }
  const picks = new Map();       // conversationId -> contactId chosen when several contacts share the number

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const slot = (s) => $(`[data-section="${s}"] .slot`);
  function ic(name, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', cls || 'ic'); s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name);
    s.append(u); return s;
  }
  const button = (text, cls) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; return b; };

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
      cache.delete(m.conversationId); picks.delete(m.conversationId);
      if (current && m.conversationId === current.cid) showIdle(); else updateDiag();
      return;
    }
    if (m.type === 'session.end') {
      // The agent signed out or the session ended: forget every customer held in this page.
      cache.clear(); picks.clear();
      if (renewal) renewal.done(false);
      showIdle();
      return;
    }
    if (m.type === 'token.update') {
      if (current && renewal && m.conversationId === current.cid && typeof m.token === 'string') { current.token = m.token; renewal.done(true); }
      else dropped++;
      return;
    }
  });

  // The token lives 60 seconds. If a call finds it expired (retry later in a long call,
  // or a popup that stayed open), ask Nubitel for a new one instead of failing.
  function renewToken() {
    if (!current) return Promise.resolve(false);
    if (renewal) return renewal.promise;
    let resolve; const promise = new Promise((r) => { resolve = r; });
    const t = setTimeout(() => { renewal = null; resolve(false); }, 4000);
    renewal = { promise, done: (ok) => { clearTimeout(t); renewal = null; resolve(ok); } };
    post({ type: 'view.needToken', conversationId: current.cid });
    return promise;
  }

  async function api(path, g, opts = {}) {
    const attempt = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeout || CFG.sectionTimeoutMs);
      try {
        const headers = { Authorization: 'Bearer ' + current.token };
        if (current.fresh) headers['Cache-Control'] = 'no-cache';   // after Refresh: do not reuse the server's short memory either
        if (opts.body) headers['Content-Type'] = 'application/json';
        return await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal, credentials: 'omit' });
      } finally { clearTimeout(t); }
    };
    // The agent moved on while this call was in flight: the answer is for an older conversation, so drop it.
    const stale = () => { if (!current || current.gen !== g) { dropped++; updateDiag(); return true; } return false; };
    try {
      let res = await attempt();
      if (stale()) return null;
      if (res.status === 401 && await renewToken()) { if (stale()) return null; res = await attempt(); }
      if (stale()) return null;
      if (res.status === 401) return { status: 'error', error: 'expired' };
      if (res.status === 404) return { status: 'not_found' };
      if (res.status === 409) return { status: 'choose' };
      if (res.status === 400 || res.status === 403) { try { return await res.json(); } catch (_) { return { status: 'error' }; } }
      if (!res.ok) return { status: 'error' };
      return await res.json();
    } catch (e) {
      return stale() ? null : { status: 'error' };
    }
  }

  // ---------- saved copy ----------
  function cacheGet(cid) {
    const e = cache.get(cid);
    if (!e) return null;
    const now = Date.now();
    Object.keys(e.sections).forEach((s) => { if (now - e.sections[s].at > TTL) delete e.sections[s]; });
    if (!e.sections.customer) { cache.delete(cid); return null; } // only usable together with its customer
    e.used = now;
    return e;
  }

  function cachePut(cid, s, status, data) {
    if (TTL <= 0) return;
    if (!(s === 'customer' ? ['ok'] : ['ok', 'empty']).includes(status)) return; // never save errors
    let e = cache.get(cid);
    if (s === 'customer') { e = { sections: {}, used: 0 }; cache.set(cid, e); }   // a new customer starts a fresh copy
    else if (!e || !e.sections.customer) return;
    e.sections[s] = { status, data, at: Date.now() };
    e.used = Date.now();
    while (cache.size > CACHE_MAX) {
      let oldest = null;
      for (const [k, v] of cache) if (oldest === null || v.used < cache.get(oldest).used) oldest = k;
      cache.delete(oldest);
    }
  }

  // ---------- screens ----------
  function show(which) {
    $('#idle').hidden = which !== 'idle';
    $('#view').hidden = which !== 'view';
    $('#unknown').hidden = which !== 'unknown';
  }

  function resetTimes() { for (const k in times) delete times[k]; }

  function openConversation(m) {
    if (!m.conversationId || typeof m.token !== 'string') return;
    const cid = m.conversationId;
    clearTimers(); closeDialog(true);
    if (m.refresh === true) { cache.delete(cid); picks.delete(cid); }
    const entry = cacheGet(cid);
    const missing = entry ? SECTIONS.filter((s) => !entry.sections[s]) : ALL.slice();
    current = {
      cid, token: m.token, gen: ++gen, started: performance.now(), timers: {}, pending: new Set(), at: {},
      fresh: m.refresh === true, contactId: null, unknown: null,
      cacheState: TTL <= 0 ? 'off' : entry ? (missing.length ? 'partial' : 'hit') : 'miss',
    };
    resetTimes();
    if (!entry) { begin(current.gen); return; }
    // Saved copy: show it at once, only the missing sections are asked for
    show('view');
    current.contactId = entry.sections.customer.data.contactId;
    ALL.forEach((s) => { const c = entry.sections[s]; if (c) applySection(s, c.status, c.data, { cached: true, at: c.at }); });
    loadSections(missing);
    updateAll();
  }

  function showIdle() {
    clearTimers(); closeDialog(true);
    current = null;
    show('idle');
    updateAll();
  }

  function clearTimers() { if (current) Object.values(current.timers).forEach(clearTimeout); }

  function armTimeout(s) {
    const g = current.gen;
    clearTimeout(current.timers[s]);
    current.timers[s] = setTimeout(() => {
      if (!current || current.gen !== g) return;
      setError(s, 'Taking too long');
    }, CFG.sectionTimeoutMs);
  }

  // A section has finished (loaded, empty or failed); Refresh lights up when all have.
  function settle(s) { if (current) { current.pending.delete(s); updateRefresh(); renderAge(); } }

  // Start from scratch for the current conversation: customer first, then the sections.
  async function begin(g) {
    show('view');
    current.pending = new Set(ALL);
    ALL.forEach((s) => { setLoading(s); armTimeout(s); });
    updateAll();
    const r = await api('/api/customer', g);
    if (!r) return;
    onCustomer(r);
  }

  function onCustomer(r) {
    if (r.status === 'ok') { choose(r.data, false); return; }
    if (r.status === 'multiple') {
      const chosen = r.data.find((x) => x.contactId === picks.get(current.cid));
      if (chosen) { choose(chosen, false); return; }
      renderChooser(r.data); return;
    }
    if (r.status === 'not_found') { showUnknown(r.data && r.data.phone); return; }
    applySection('customer', 'error');
  }

  function choose(match, remember) {
    if (remember) picks.set(current.cid, match.contactId);
    current.contactId = match.contactId;
    applySection('customer', 'ok', match);
    loadSections(SECTIONS.slice());
  }

  function loadSections(list) {
    list.forEach((s) => { current.pending.add(s); setLoading(s); armTimeout(s); pullSection(s, current.gen); });
    updateRefresh(); renderAge();
  }

  async function pullSection(s, g) {
    const r = await api(`/api/section/${s}?contact=${encodeURIComponent(current.contactId)}`, g);
    if (r) applySection(s, r.status, r.data);
  }

  function retry(s) {
    if (!current) return;
    if (s === 'customer') { current.gen = ++gen; begin(current.gen); return; }
    current.pending.add(s); setLoading(s); armTimeout(s); updateRefresh(); renderAge();
    pullSection(s, current.gen);
  }

  // ---------- Refresh (top right) ----------
  $('#refresh').addEventListener('click', () => {
    if (!current || current.pending.size) return;
    const cid = current.cid;
    cache.delete(cid); picks.delete(cid);
    clearTimers(); closeDialog(true);
    current.gen = ++gen; current.started = performance.now(); current.at = {}; current.fresh = true; current.unknown = null;
    current.cacheState = 'refresh';
    resetTimes();
    show('view');
    current.pending = new Set(ALL);
    ALL.forEach((s) => { setLoading(s); armTimeout(s); });
    updateAll();
    // Nubitel answers with conversation.open { refresh: true } and a new token.
    post({ type: 'view.refresh', conversationId: cid });
  });

  function updateRefresh() {
    const b = $('#refresh');
    b.disabled = !current || current.pending.size > 0;
    b.classList.toggle('is-busy', !!current && current.pending.size > 0);
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

  const updateAll = () => { updateRefresh(); renderAge(); updateDiag(); };

  // ---------- rendering ----------
  function applySection(s, status, data, opts = {}) {
    if (!ALL.includes(s) || !current) return;
    clearTimeout(current.timers[s]);
    times[s] = opts.cached ? 'saved' : Math.round(performance.now() - current.started) + 'ms';
    current.at[s] = opts.at || Date.now();
    if (!opts.cached) cachePut(current.cid, s, status, data);
    settle(s);
    updateDiag();

    if (s === 'customer') return renderCustomer(status, data);
    if (status === 'empty' || (status === 'ok' && !data)) return setState(s, 'empty', emptyText(s));
    if (status !== 'ok') return setError(s, 'Could not load');
    RENDER[s](slot(s), data);
  }

  function openLink(kind, id, label) {
    const a = el('a', 'icon-link');
    const tpl = CFG.links[kind];
    if (tpl) { a.href = tpl.replace('{id}', encodeURIComponent(id)); a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.title = label; a.setAttribute('aria-label', label);
    a.append(ic('open'));
    a.addEventListener('click', () => post({ type: 'view.action', action: 'openInC4C', object: kind, id, conversationId: current && current.cid }));
    return a;
  }

  function renderCustomer(status, data) {
    const box = slot('customer');
    box.replaceChildren();
    if (status === 'ok' && data) {
      const line = el('div', 'cust-line');
      line.append(el('p', 'cust-name', data.name), openLink('contact', data.contactId, 'Open contact in C4C'));
      const sub = el('div', 'cust-sub');
      sub.append(el('span', null, data.account), openLink('account', data.accountId, 'Open account in C4C'));
      if (data.owner) sub.append(el('span', 'sep', '·'), el('span', null, 'Owner: ' + data.owner));
      box.append(line, sub);
      return;
    }
    // Customer not usable: the other sections cannot load, so stop them.
    SECTIONS.forEach((s) => { clearTimeout(current.timers[s]); settle(s); setState(s, 'empty', '-'); });
    box.append(el('p', 'cust-name', 'Could not load customer'));
    const st = el('p', 'state error', 'C4C did not respond.');
    const b = el('button', null, 'Retry'); b.type = 'button'; b.addEventListener('click', () => retry('customer'));
    st.append(b); box.append(st);
  }

  // Several contacts share this number: the agent says which one is on the line.
  function renderChooser(list) {
    clearTimeout(current.timers.customer);
    const box = slot('customer');
    box.replaceChildren(el('p', 'chooser-title', `${list.length} contacts share this number`), el('p', 'cust-sub', 'Which one is calling?'));
    list.forEach((c) => {
      const row = el('div', 'match');
      row.append(el('span', null, `${c.name} · ${c.account}`));
      const b = button('Select', 'secondary'); b.addEventListener('click', () => choose(c, true));
      row.append(b); box.append(row);
    });
    SECTIONS.forEach((s) => { clearTimeout(current.timers[s]); settle(s); setState(s, 'empty', 'Choose a contact first'); });
    settle('customer'); updateAll();
  }

  const fmtDate = (iso) => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
  const dayDiff = (iso) => { const d = new Date(iso + 'T00:00:00'); const t = new Date(); t.setHours(0, 0, 0, 0); return isNaN(d) ? 0 : Math.round((d - t) / 86400000); };
  function dueText(iso) {
    const n = dayDiff(iso);
    if (n < 0) return { text: `Overdue ${-n}d`, overdue: true };
    if (n === 0) return { text: 'Due today', overdue: false };
    if (n === 1) return { text: 'Due tomorrow', overdue: false };
    return { text: 'Due ' + new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), overdue: false };
  }
  function chip(text) {
    const t = String(text || '');
    const kind = /deliver|complet|closed|done|released/i.test(t) ? 'ok' : /block|reject|cancel|fail/i.test(t) ? 'err' : /hold|delay|partial/i.test(t) ? 'warn' : '';
    return el('span', 'chip' + (kind ? ' ' + kind : ''), t);
  }

  const MAX_TASKS = 5;
  const RENDER = {
    order: (box, d) => {
      const top = el('div', 'so-top');
      top.append(el('span', 'so-id', d.id), openLink('order', d.id, 'Open sales order in C4C'), el('span', 'so-value', d.value || ''));
      const sub = el('div', 'so-sub');
      sub.append(el('span', null, fmtDate(d.date)), chip(d.status));
      const wrap = el('div', 'so'); wrap.append(top, sub);
      box.replaceChildren(wrap);
    },
    tasks: (box, d) => {
      const items = d.items || [];
      $('#taskCount').textContent = `(${d.count != null ? d.count : items.length})`;
      const ul = el('ul', 'tasks');
      items.slice(0, MAX_TASKS).forEach((t) => {
        const li = el('li', 'task');
        const due = dueText(t.due);
        const subj = el('span', 't-subj', t.subject); subj.title = t.subject;
        li.append(el('span', 'dot ' + String(t.priority || '').toLowerCase()), subj, el('span', 't-due' + (due.overdue ? ' overdue' : ''), due.text), openLink('task', t.id, 'Open task in C4C'));
        ul.append(li);
      });
      box.replaceChildren(ul);
      const more = (d.count != null ? d.count : items.length) - Math.min(items.length, MAX_TASKS);
      if (more > 0) box.append(el('p', 'more', `+${more} more in C4C`));
    },
    reco: (box, d) => {
      const rows = d.rows || [];
      $('#recoPeriod').textContent = `· ${d.label || d.period} · ${rows.length} items`;
      const wrap = el('div', 'scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Recommended products, scrollable');
      const table = el('table', 'tbl');
      const head = el('tr');
      [['Product', ''], ['Qty', 'num'], ['Unit', ''], ['Why', 'why']].forEach(([t, c]) => { const th = el('th', c, t); th.scope = 'col'; head.append(th); });
      const thead = el('thead'); thead.append(head);
      const tbody = el('tbody');
      rows.forEach((r) => {
        const tr = el('tr');
        tr.append(el('td', null, r.product), el('td', 'num', r.qty != null ? String(r.qty) : ''), el('td', null, r.uom || ''), el('td', 'why', r.reason || ''));
        tbody.append(tr);
      });
      table.append(thead, tbody); wrap.append(table);
      box.replaceChildren(wrap);
    },
  };

  const emptyText = (s) => ({ order: 'No sales orders yet', tasks: 'No open tasks', reco: 'No recommendations for this month' }[s] || 'Nothing to show');

  function setLoading(s) {
    const box = slot(s);
    if (!box) return;
    if (s === 'tasks') $('#taskCount').textContent = '';
    if (s === 'reco') $('#recoPeriod').textContent = '';
    box.replaceChildren(el('div', 'skel w60'), el('div', 'skel w80'), ...(s === 'reco' ? [el('div', 'skel w40'), el('div', 'skel w80')] : []));
  }

  function setState(s, kind, text) { const box = slot(s); if (box) box.replaceChildren(el('p', 'state ' + kind, text)); }

  function setError(s, text) {
    settle(s);
    if (s === 'customer') return renderCustomer('error');
    const p = el('p', 'state error', text);
    const b = el('button', null, 'Retry'); b.type = 'button';
    b.addEventListener('click', () => retry(s));
    p.append(b);
    slot(s).replaceChildren(p);
  }

  // ---------- unknown caller ----------
  function showUnknown(phone) {
    clearTimers();
    current.pending = new Set();
    current.unknown = { phone: phone || '' };
    $('#unkPhone').textContent = phone || 'This number';
    show('unknown');
    updateAll();
  }

  $('#chooseExisting').addEventListener('click', (e) => dialogExisting(e.currentTarget));
  $('#chooseNew').addEventListener('click', (e) => dialogNew(e.currentTarget));

  const phoneEl = () => el('b', 'phone', current && current.unknown ? current.unknown.phone : '');
  const saveError = (r) => (r && r.status === 'disabled' ? 'Saving contacts is turned off in this environment.'
    : r && r.status === 'bad_request' ? 'Please check the details and try again.'
      : r && r.error === 'expired' ? 'The session expired. Refresh and try again.'
        : 'C4C did not respond. Try again.');

  function dialogExisting(opener) {
    openDialog({ title: 'Add number to an existing contact', opener, build: ({ body, foot, close }) => {
      const hint = el('p', 'hint'); hint.append('Number to save: ', phoneEl());
      const label = el('label', 'field'); label.append(el('span', null, 'Search by contact or account name'));
      const input = el('input'); input.type = 'search'; input.placeholder = 'Type at least 2 letters'; input.autocomplete = 'off';
      label.append(input);
      const results = el('ul', 'results'); results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', 'Matching contacts');
      const msg = el('p', 'msg'); msg.setAttribute('role', 'status');
      body.append(hint, label, results, msg);
      const cancel = button('Cancel', 'secondary'); const save = button('Save number'); save.disabled = true;
      foot.append(cancel, save);

      let selected = null; let seq = 0; let timer = null;
      const options = () => [...results.querySelectorAll('[role="option"]')];
      function select(li, item) {
        options().forEach((o) => o.setAttribute('aria-selected', 'false'));
        li.setAttribute('aria-selected', 'true'); selected = item; save.disabled = false;
        msg.className = 'msg'; msg.textContent = `Save ${current.unknown.phone} on ${item.name}?`;
      }
      function render(rows) {
        results.replaceChildren();
        rows.forEach((item) => {
          const li = el('li'); li.setAttribute('role', 'option'); li.tabIndex = 0; li.setAttribute('aria-selected', 'false');
          li.append(el('div', 'r-main', item.name), el('div', 'r-sub', [item.account, item.phoneHint ? 'has a number ' + item.phoneHint : 'no number saved'].join(' · ')));
          li.addEventListener('click', () => select(li, item));
          li.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(li, item); }
            const all = options(); const i = all.indexOf(li);
            if (ev.key === 'ArrowDown' && all[i + 1]) { ev.preventDefault(); all[i + 1].focus(); }
            if (ev.key === 'ArrowUp') { ev.preventDefault(); (all[i - 1] || input).focus(); }
          });
          results.append(li);
        });
      }
      async function search(q) {
        const my = ++seq; msg.className = 'msg'; msg.textContent = 'Searching…';
        const r = await api('/api/contacts/search?q=' + encodeURIComponent(q), current.gen);
        if (my !== seq || !dlg) return;
        if (!r || r.status !== 'ok') { results.replaceChildren(); msg.className = 'msg error'; msg.textContent = 'Could not search C4C. Try again.'; return; }
        render(r.data);
        msg.textContent = r.data.length ? `${r.data.length} found. Pick the right person.` : 'No contact found. Try another name, or create a new contact.';
      }
      input.addEventListener('input', () => {
        clearTimeout(timer); selected = null; save.disabled = true; seq++;
        const q = input.value.trim();
        if (q.length < 2) { results.replaceChildren(); msg.className = 'msg'; msg.textContent = ''; return; }
        timer = setTimeout(() => search(q), 300);
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowDown' && options()[0]) { ev.preventDefault(); options()[0].focus(); } });
      cancel.addEventListener('click', close);
      save.addEventListener('click', async () => {
        if (!selected) return;
        save.disabled = true; cancel.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
        const r = await api('/api/contact', current.gen, { method: 'POST', body: { mode: 'update', contactId: selected.contactId }, timeout: 10000 });
        if (!dlg) return;
        if (r && r.status === 'ok') { close(); contactSaved(r.data, 'update'); return; }
        cancel.disabled = false; save.disabled = false; msg.className = 'msg error'; msg.textContent = saveError(r);
      });
    } });
  }

  function dialogNew(opener) {
    openDialog({ title: 'Create a new contact', opener, build: ({ body, foot, close }) => {
      const field = (labelText, input, optional) => {
        const l = el('label', 'field'); const s = el('span', null, labelText);
        if (optional) s.append(' ', el('span', 'opt', '(optional)'));
        const err = el('span', 'err'); err.setAttribute('role', 'alert');
        l.append(s, input, err); return { l, err };
      };
      const mk = (type, extra) => { const i = el('input'); i.type = type; i.autocomplete = 'off'; Object.assign(i, extra || {}); return i; };
      const first = mk('text', { maxLength: 40 }); const last = mk('text', { maxLength: 40 });
      const email = mk('email', { maxLength: 120 });
      const mobile = mk('text', { readOnly: true }); mobile.value = current.unknown.phone;
      const acct = mk('search'); acct.placeholder = 'Type at least 2 letters';
      const fFirst = field('First name', first, true); const fLast = field('Last name', last);
      const fAcct = field('Account', acct); const fEmail = field('Email', email, true); const fMob = field('Mobile (from this call)', mobile);
      const row = el('div', 'row2'); row.append(fFirst.l, fLast.l);
      const results = el('ul', 'results'); results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', 'Matching accounts');
      const picked = el('span', 'picked'); picked.hidden = true;
      const msg = el('p', 'msg'); msg.setAttribute('role', 'status');
      body.append(row, fAcct.l, results, picked, fEmail.l, fMob.l, msg);
      const cancel = button('Cancel', 'secondary'); const save = button('Create contact');
      foot.append(cancel, save);

      let account = null; let seq = 0; let timer = null;
      function pick(item) { account = item; results.replaceChildren(); picked.hidden = false; picked.textContent = item.account; acct.value = item.account; fAcct.err.textContent = ''; }
      async function search(q) {
        const my = ++seq;
        const r = await api('/api/accounts/search?q=' + encodeURIComponent(q), current.gen);
        if (my !== seq || !dlg) return;
        results.replaceChildren();
        if (!r || r.status !== 'ok') { fAcct.err.textContent = 'Could not search C4C. Try again.'; return; }
        if (!r.data.length) { fAcct.err.textContent = 'No account found.'; return; }
        fAcct.err.textContent = '';
        r.data.forEach((item) => {
          const li = el('li'); li.setAttribute('role', 'option'); li.tabIndex = 0; li.setAttribute('aria-selected', 'false');
          li.append(el('div', 'r-main', item.account), el('div', 'r-sub', item.owner ? 'Owner: ' + item.owner : ''));
          li.addEventListener('click', () => pick(item));
          li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(item); } });
          results.append(li);
        });
      }
      acct.addEventListener('input', () => {
        clearTimeout(timer); account = null; picked.hidden = true; seq++; results.replaceChildren();
        const q = acct.value.trim();
        if (q.length >= 2) timer = setTimeout(() => search(q), 300);
      });
      cancel.addEventListener('click', close);
      last.addEventListener('input', () => { fLast.err.textContent = ''; });   // errors go away as the agent fixes them
      email.addEventListener('input', () => { fEmail.err.textContent = ''; });
      save.addEventListener('click', async () => {
        fLast.err.textContent = last.value.trim() ? '' : 'Last name is required.';
        fAcct.err.textContent = account ? '' : 'Pick an account from the list.';
        const em = email.value.trim();
        fEmail.err.textContent = !em || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em) ? '' : 'Enter a valid email.';
        if (fLast.err.textContent || fAcct.err.textContent || fEmail.err.textContent) return;
        save.disabled = true; cancel.disabled = true; msg.className = 'msg'; msg.textContent = 'Creating…';
        const r = await api('/api/contact', current.gen, { method: 'POST', body: { mode: 'create', firstName: first.value.trim(), lastName: last.value.trim(), accountId: account.accountId, email: em }, timeout: 10000 });
        if (!dlg) return;
        if (r && r.status === 'ok') { close(); contactSaved(r.data, 'create'); return; }
        cancel.disabled = false; save.disabled = false; msg.className = 'msg error'; msg.textContent = saveError(r);
      });
    } });
  }

  // The number now belongs to a contact: tell Nubitel and load the customer for real.
  function contactSaved(c, mode) {
    post({ type: 'view.contactSaved', conversationId: current.cid, mode, contactId: c.contactId, accountId: c.accountId });
    cache.delete(current.cid); picks.delete(current.cid);
    current.gen = ++gen; current.fresh = true; current.unknown = null; current.at = {}; current.started = performance.now();
    resetTimes();
    begin(current.gen);
  }

  // ---------- popup ----------
  function openDialog({ title, opener, build }) {
    closeDialog(true);
    $('#dlgTitle').textContent = title;
    const body = $('#dlgBody'); const foot = $('#dlgFoot');
    body.replaceChildren(); foot.replaceChildren();
    dlg = { opener };
    $('#overlay').hidden = false;
    build({ body, foot, close: () => closeDialog() });
    const f = body.querySelector('input:not([readonly]), button'); if (f) f.focus();
  }

  function closeDialog(silent) {
    if (!dlg) return;
    const o = dlg.opener; dlg = null;
    $('#overlay').hidden = true;
    $('#dlgBody').replaceChildren(); $('#dlgFoot').replaceChildren();
    if (!silent && o && o.isConnected) o.focus();
  }
  $('#dlgClose').addEventListener('click', () => closeDialog());

  document.addEventListener('keydown', (e) => {
    if (!dlg) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if (e.key !== 'Tab') return;
    const f = [...$('#dialog').querySelectorAll('button:not(:disabled), input:not([readonly]), [tabindex="0"]')].filter((n) => !n.closest('[hidden]'));
    if (!f.length) return;
    const first = f[0]; const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---------- testing footer ----------
  function updateDiag() {
    $('#diagMode').textContent = 'view: ' + (current ? (current.unknown ? 'unknown caller' : 'customer') : 'idle');
    $('#diagTimes').textContent = Object.keys(times).map((k) => `${k} ${times[k]}`).join(' · ');
    $('#diagCache').textContent = TTL <= 0 ? 'cache: off' : `cache: ${current ? current.cacheState : '-'} · ${cache.size} saved`;
    $('#diagDropped').textContent = 'stale dropped: ' + dropped;
  }
  if (CFG.showDiagnostics) $('#diag').hidden = false;

  updateAll();
  post({ type: 'view.ready' });
})();
