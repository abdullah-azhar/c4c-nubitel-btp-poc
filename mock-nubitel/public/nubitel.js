/* Mock Nubitel page logic. This is also the reference for what the real Nubitel
 * app needs to do: see docs/MESSAGE-CONTRACT.md. */
(function () {
  'use strict';
  const CFG = window.NB_CONFIG;
  const frame = document.getElementById('view');
  const modeSel = document.getElementById('mode');
  let viewReady = false;
  let currentCid = null;
  let currentConv = null;
  let accountByCid = {};

  const CONVS = [
    { id: 'conv-2294', name: 'Jenna Hopkins', phone: '+60 8347 2856', channel: 'whatsapp', note: 'Happy path', msgs: [['c', 'Hi, can I reorder Vitamin C 1000mg? Same as last month.']] },
    { id: 'conv-3492', name: 'Kumar Singh', phone: '012-345 6789', channel: 'voice', note: 'Slow sections', msgs: [['c', '(voice call in progress)']] },
    { id: 'conv-3243', name: 'June Wong', phone: '+60 16-222 3333', channel: 'whatsapp', note: 'Two matching contacts', msgs: [['c', 'Hello, checking on my order.']] },
    { id: 'conv-5120', name: 'Ali Hassan', phone: '019-876 5432', channel: 'whatsapp', note: 'Orders fail to load', msgs: [['c', 'Is my delivery coming today?']] },
    { id: 'conv-5333', name: 'Mei Ling Tan', phone: '017-777 8888', channel: 'whatsapp', note: 'No quote, no tickets', msgs: [['c', 'Do you have Zinc 25mg in stock?']] },
    { id: 'conv-6001', name: '+60 11-5555 0000', phone: '011-5555 0000', channel: 'whatsapp', note: 'Number not in C4C', msgs: [['c', 'Hi, I would like to order.']] },
  ];

  // ---------- messaging with the BTP view ----------
  frame.src = CFG.viewUrl;
  const send = (msg) => frame.contentWindow.postMessage(Object.assign({ v: 1 }, msg), CFG.viewOrigin);

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CFG.viewOrigin) return;
    const m = e.data || {};
    if (m.type === 'view.ready') { viewReady = true; if (currentConv) openConversation(currentConv); }
    if (m.type === 'view.retry' && m.conversationId === currentCid) loadSection(m.section, currentCid);
    if (m.type === 'view.action') report('view', `Agent clicked ${m.action} (${m.accountId})`, true);
  });

  // ---------- conversation list ----------
  const list = document.getElementById('convList');
  CONVS.forEach((c) => {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    const n = document.createElement('div'); n.className = 'n'; n.textContent = c.name;
    const s = document.createElement('div'); s.className = 's'; s.textContent = `${c.channel === 'voice' ? 'Voice' : 'WhatsApp'} · ${c.note}`;
    li.append(n, s);
    li.addEventListener('click', () => openConversation(c));
    list.append(li);
  });

  function renderChat(c) {
    document.querySelectorAll('#convList li').forEach((li) => li.classList.toggle('active', li.dataset.id === c.id));
    document.getElementById('chatHead').textContent = `${c.channel === 'voice' ? 'Voice' : 'WhatsApp'} ${c.phone}`;
    const body = document.getElementById('chatBody');
    body.replaceChildren();
    c.msgs.forEach(([who, text]) => {
      const d = document.createElement('div'); d.className = 'msg' + (who === 'a' ? ' agent' : '');
      const w = document.createElement('div'); w.className = 'who'; w.textContent = who === 'a' ? 'Agent' : c.name;
      const t = document.createElement('div'); t.textContent = text;
      d.append(w, t); body.append(d);
    });
  }

  // ---------- opening a conversation ----------
  async function openConversation(c) {
    currentConv = c;
    currentCid = c.id;
    renderChat(c);
    if (!viewReady) return; // view will announce view.ready, then we resend
    const cid = c.id;
    const mode = modeSel.value;

    if (mode === 'pull') {
      // Option B: ask our backend for a short-lived token, hand it to the view.
      const r = await fetch('/nubitel-api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid, phone: c.phone, agent: 'james.theng' }) });
      const { token } = await r.json();
      if (currentCid !== cid) return;
      send({ type: 'conversation.open', conversationId: cid, channel: c.channel, mode: 'pull', token });
      return;
    }

    // Option A: we call C4C (through our backend) and push each section as it arrives.
    send({ type: 'conversation.open', conversationId: cid, channel: c.channel, mode: 'push' });
    const cust = await getJSON(`/nubitel-api/lookup?section=customer&phone=${encodeURIComponent(c.phone)}`);
    send({ type: 'section.update', conversationId: cid, section: 'customer', status: cust.status, data: cust.data });
    if (cust.status !== 'ok') return;
    accountByCid[cid] = cust.data.accountId;
    CFG.sections.forEach((s) => loadSection(s, cid));
  }

  async function loadSection(section, cid) {
    if (section === 'customer') return openConversation(currentConv);
    const accountId = accountByCid[cid];
    if (!accountId) return;
    const r = await getJSON(`/nubitel-api/lookup?section=${section}&accountId=${encodeURIComponent(accountId)}`);
    // Always tag with the conversation it belongs to; the view drops it if the agent has moved on.
    send({ type: 'section.update', conversationId: cid, section, status: r.status, data: r.data });
  }

  async function getJSON(u) {
    try { const r = await fetch(u, { cache: 'no-store' }); return await r.json(); } catch (e) { return { status: 'error' }; }
  }

  modeSel.addEventListener('change', () => { if (currentConv) openConversation(currentConv); });

  document.getElementById('rapid').addEventListener('click', async () => {
    const order = [CONVS[1], CONVS[0], CONVS[3], CONVS[4], CONVS[0]];
    for (const c of order) { openConversation(c); await new Promise((r) => setTimeout(r, 250)); }
    report('rapid', 'Rapid switch done: view should show Jenna Hopkins only', true);
  });

  // ---------- browser checks (results also go to the C4C host page) ----------
  const results = document.getElementById('testResults');
  function report(test, text, ok) {
    const li = document.createElement('li'); li.className = ok ? 'ok' : 'fail'; li.textContent = `${ok ? 'PASS' : 'FAIL'} · ${text}`;
    results.prepend(li);
    if (window.parent !== window && CFG.hostOrigin) window.parent.postMessage({ v: 1, type: 'nubitel.diag', test, ok, text }, CFG.hostOrigin);
  }

  const TESTS = {
    async mic() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        report('mic', 'Microphone available (voice calls can work)', true);
      } catch (e) { report('mic', `Microphone blocked: ${e.name}. Host iframe needs allow="microphone"`, false); }
    },
    async clipboard() {
      try { await navigator.clipboard.writeText('POC clipboard test'); report('clipboard', 'Clipboard write allowed', true); }
      catch (e) { report('clipboard', `Clipboard blocked: ${e.name}. Host iframe needs allow="clipboard-write"`, false); }
    },
    async cookie() {
      try {
        await fetch('/nubitel-api/cookie-set', { credentials: 'include', cache: 'no-store' });
        const r = await (await fetch('/nubitel-api/cookie-check', { credentials: 'include', cache: 'no-store' })).json();
        report('cookie', r.cookieReceived ? 'Session cookie kept (login can persist)' : 'Session cookie dropped (third-party cookies blocked: Nubitel login may fail inside C4C)', r.cookieReceived);
      } catch (e) { report('cookie', 'Cookie test failed: ' + e.message, false); }
    },
  };
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => TESTS[b.dataset.test]()));

  // Tell the host we loaded (counts reloads in the C4C host harness)
  if (window.parent !== window && CFG.hostOrigin) window.parent.postMessage({ v: 1, type: 'nubitel.loaded' }, CFG.hostOrigin);
})();
