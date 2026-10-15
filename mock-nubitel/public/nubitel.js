/* Mock Nubitel page logic. This is also the reference for what the real Nubitel
 * app needs to do: see docs/MESSAGE-CONTRACT.md.
 *
 * Nubitel only has to do three things:
 *   1. when the agent opens a conversation, ask its backend for a signed token
 *      (phone number + external ID of the phone call activity) and post
 *      conversation.open { conversationId, token } to the view
 *   2. answer view.refresh with conversation.open { refresh: true } and a new token
 *   3. answer view.needToken with token.update { conversationId, token }
 * The view then calls C4C through BTP itself. */
(function () {
  'use strict';
  const CFG = window.NB_CONFIG;
  const frame = document.getElementById('view');
  let viewReady = false;
  let currentCid = null;
  let currentConv = null;

  // externalId = the external ID Nubitel stored on the C4C phone call activity for this conversation
  const CONVS = [
    { id: 'conv-2294', externalId: 'NUB-CALL-100234', name: 'Jenna Hopkins', phone: '+60 8347 2856', channel: 'whatsapp', note: 'Happy path (found by activity)', msgs: [['c', 'Hi, can I reorder Vitamin C 1000mg? Same as last month.']] },
    { id: 'conv-3492', externalId: 'NUB-CALL-100235', name: 'Kumar Singh', phone: '012-345 6789', channel: 'voice', note: 'Slow sections', msgs: [['c', '(voice call in progress)']] },
    { id: 'conv-3243', externalId: 'NUB-CALL-100237', name: 'June Wong', phone: '+60 16-222 3333', channel: 'whatsapp', note: 'Two matching contacts', msgs: [['c', 'Hello, checking on my order.']] },
    { id: 'conv-5120', externalId: 'NUB-CALL-100236', name: 'Ali Hassan', phone: '019-876 5432', channel: 'whatsapp', note: 'Order fails to load', msgs: [['c', 'Is my delivery coming today?']] },
    { id: 'conv-5333', externalId: 'NUB-CALL-100238', name: 'Mei Ling Tan', phone: '017-777 8888', channel: 'whatsapp', note: 'No order, no tasks', msgs: [['c', 'Do you have Zinc 25mg in stock?']] },
    { id: 'conv-6001', externalId: 'NUB-CALL-100239', name: '+60 11-5555 0000', phone: '011-5555 0000', channel: 'whatsapp', note: 'Unknown caller', msgs: [['c', 'Hi, I would like to order.']] },
    { id: 'conv-6002', externalId: 'NUB-CALL-100240', name: '+60 18-222 9999', phone: '018-222 9999', channel: 'voice', note: 'Unknown caller (2)', msgs: [['c', '(voice call in progress)']] },
  ];

  // ---------- messaging with the BTP view ----------
  frame.src = CFG.viewUrl;
  const send = (msg) => frame.contentWindow.postMessage(Object.assign({ v: 1 }, msg), CFG.viewOrigin);

  // The backend signs; the browser never sees the secret. ttl below 60 is only for the expiry test.
  async function mintToken(c, ttl) {
    const r = await fetch('/nubitel-api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: c.id, phone: c.phone, externalId: c.externalId, agent: 'james.theng', ttl }),
    });
    return (await r.json()).token;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CFG.viewOrigin) return;
    const m = e.data || {};
    if (m.type === 'view.ready') { viewReady = true; if (currentConv) openConversation(currentConv); }
    // Agent pressed Refresh: open again, ignoring what the view saved, with a new token
    if (m.type === 'view.refresh' && m.conversationId === currentCid) openConversation(currentConv, { refresh: true });
    // The token lives 60 seconds; the view asks for a new one instead of failing
    if (m.type === 'view.needToken' && m.conversationId === currentCid) {
      const c = currentConv;
      mintToken(c).then((token) => { if (currentCid === c.id) send({ type: 'token.update', conversationId: c.id, token }); });
    }
    if (m.type === 'view.contactSaved') report('view', `Contact ${m.mode === 'create' ? 'created' : 'updated'}: ${m.contactId}`, true);
    if (m.type === 'view.action') report('view', `Agent opened ${m.object} ${m.id} in C4C`, true);
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
  // opts.refresh = true: the agent asked for fresh data, so the view ignores what it saved.
  // opts.delayMs / opts.ttl: only for the token-expiry test (send an already-expired token).
  async function openConversation(c, opts = {}) {
    currentConv = c;
    currentCid = c.id;
    renderChat(c);
    if (!viewReady) return; // view will announce view.ready, then we resend
    const token = await mintToken(c, opts.ttl);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (currentCid !== c.id) return;
    send({ type: 'conversation.open', conversationId: c.id, channel: c.channel, token, refresh: opts.refresh === true });
  }

  // The rapid-switch test checks that late answers are dropped, so it must always load fresh.
  document.getElementById('rapid').addEventListener('click', async () => {
    const order = [CONVS[1], CONVS[0], CONVS[3], CONVS[4], CONVS[0]];
    for (const c of order) { openConversation(c, { refresh: true }); await new Promise((r) => setTimeout(r, 250)); }
    report('rapid', 'Rapid switch done: view should show Jenna Hopkins only', true);
  });

  // Sends a token that has already expired, to prove the view asks for a new one and still loads.
  document.getElementById('expiry').addEventListener('click', () => {
    if (!currentConv) { report('expiry', 'Open a conversation first', false); return; }
    openConversation(currentConv, { refresh: true, ttl: 1, delayMs: 2200 });
    report('expiry', 'Sent an expired token: the view should still load after asking for a new one', true);
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
