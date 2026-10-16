/* Mock Nubitel page logic. This is also the reference for what the real Nubitel
 * app needs to do: see docs/MESSAGE-CONTRACT.md.
 *
 * The agent signs in first. After that Nubitel only has to do these things for the view:
 *   1. when the agent opens a conversation, ask its backend for a signed token and post
 *      conversation.open { conversationId, token } to the view
 *   2. answer view.refresh with conversation.open { refresh: true } and a new token
 *   3. answer view.needToken with token.update { conversationId, token }
 *   4. when the agent signs out or the session ends, post session.end so the view
 *      forgets every customer it holds
 * The view then calls C4C through BTP itself. */
(function () {
  'use strict';
  const CFG = window.NB_CONFIG;
  const $ = (id) => document.getElementById(id);
  const frame = $('view');
  let viewReady = false;
  let currentCid = null;
  let currentConv = null;
  let convs = [];
  let agent = null;
  let expiresAt = 0;          // when the session ends for inactivity (ms)
  let checking = false;

  // ---------- backend calls ----------
  // POST calls carry X-NB, a header a page on another site cannot send (CSRF defence).
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch('/nubitel-api/' + path, {
        method: opts.method || 'GET', cache: 'no-store',
        headers: { 'X-NB': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) { return { status: 0, json: null }; }
    let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
    if (json && json.session) setExpiry(json.session.idleExpiresAt);
    return { status: res.status, json };
  }

  // ---------- sign-in ----------
  function showLogin(message, kind) {
    agent = null; convs = []; currentConv = null; currentCid = null; expiresAt = 0;
    $('app').hidden = true;
    $('login').hidden = false;
    $('convList').replaceChildren();
    $('chatBody').replaceChildren();
    $('chatHead').textContent = 'Select a conversation';
    const m = $('loginMsg'); m.textContent = message || ''; m.className = 'login-msg' + (kind === 'info' ? ' info' : '');
    $('cookieHelp').hidden = true;
    $('password').value = '';
    $('loginBtn').disabled = false;
    ($('username').value ? $('password') : $('username')).focus();
  }

  // The agent is gone: tell the view to forget every customer it holds, then show sign-in.
  function signedOut(message, kind) {
    if (viewReady) send({ type: 'session.end' });
    showLogin(message, kind);
  }

  async function enterApp() {
    const r = await api('conversations');
    if (r.status !== 200) { showLogin(r.status === 401 && r.json && r.json.reason === 'expired' ? 'Your session expired. Sign in again.' : ''); return; }
    agent = r.json.agent; convs = r.json.conversations;
    $('login').hidden = true;
    $('app').hidden = false;
    $('agentName').textContent = agent.name;
    renderList();
    tick();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('username').value.trim(); const password = $('password').value;
    const msg = $('loginMsg');
    if (!username || !password) { msg.className = 'login-msg'; msg.textContent = 'Enter your username and password.'; return; }
    $('loginBtn').disabled = true; msg.className = 'login-msg info'; msg.textContent = 'Signing in…';
    const r = await api('login', { method: 'POST', body: { username, password } });
    $('password').value = '';
    if (r.status === 200) {
      // Make sure the browser really kept the cookie: inside C4C it may be blocked as a third-party cookie.
      const s = await api('session');
      if (s.status === 200) { msg.textContent = ''; await enterApp(); return; }
      msg.className = 'login-msg'; msg.textContent = 'Signed in, but the browser did not keep the session.';
      $('cookieHelp').hidden = false;
      $('allowCookies').hidden = typeof document.requestStorageAccess !== 'function';
    } else {
      msg.className = 'login-msg';
      msg.textContent = r.status === 0 ? 'Cannot reach Nubitel. Try again.' : (r.json && r.json.error) || 'Sign-in failed.';
    }
    $('loginBtn').disabled = false;
    $('password').focus();
  });

  $('openTab').addEventListener('click', () => window.open(location.href, '_blank', 'noopener'));
  $('allowCookies').addEventListener('click', async () => {
    try { await document.requestStorageAccess(); $('loginMsg').textContent = 'Cookies allowed for this frame. Sign in again.'; $('loginMsg').className = 'login-msg info'; $('cookieHelp').hidden = true; }
    catch (e) { $('loginMsg').textContent = 'The browser refused. Use "Open Nubitel in a new tab".'; $('loginMsg').className = 'login-msg'; }
  });

  $('logout').addEventListener('click', async () => {
    await api('logout', { method: 'POST' });
    signedOut('You signed out.', 'info');
  });

  // ---------- session clock ----------
  function setExpiry(epochSeconds) { if (epochSeconds) expiresAt = epochSeconds * 1000; }

  function tick() {
    const label = $('sessionLeft');
    if (!agent) { label.textContent = ''; return; }
    const left = Math.max(expiresAt - Date.now(), 0);
    const s = Math.ceil(left / 1000);
    label.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    label.classList.toggle('low', s <= 120);
    if (left === 0 && !checking) {            // the server decides: ask before signing the agent out
      checking = true;
      api('session').then((r) => { if (r.status === 401) signedOut('Your session expired. Sign in again.'); checking = false; });
    }
  }
  setInterval(tick, 1000);

  // ---------- messaging with the BTP view ----------
  frame.src = CFG.viewUrl;
  const send = (msg) => frame.contentWindow.postMessage(Object.assign({ v: 1 }, msg), CFG.viewOrigin);

  // The backend signs; the browser never sees the secret. ttl below 60 is only for the expiry test.
  async function mintToken(c, ttl) {
    const r = await api('token', { method: 'POST', body: { cid: c.id, ttl } });
    if (r.status === 401) { signedOut('Your session expired. Sign in again.'); return null; }
    return r.status === 200 ? r.json.token : null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CFG.viewOrigin) return;
    const m = e.data || {};
    if (m.type === 'view.ready') { viewReady = true; if (currentConv && agent) openConversation(currentConv); }
    // Agent pressed Refresh: open again, ignoring what the view saved, with a new token
    if (m.type === 'view.refresh' && m.conversationId === currentCid) openConversation(currentConv, { refresh: true });
    // The token lives 60 seconds; the view asks for a new one instead of failing
    if (m.type === 'view.needToken' && m.conversationId === currentCid) {
      const c = currentConv;
      mintToken(c).then((token) => { if (token && currentCid === c.id) send({ type: 'token.update', conversationId: c.id, token }); });
    }
    if (m.type === 'view.contactSaved') report('view', `Contact ${m.mode === 'create' ? 'created' : 'updated'}: ${m.contactId}`, true);
    if (m.type === 'view.action') report('view', `Agent opened ${m.object} ${m.id} in C4C`, true);
  });

  // ---------- conversation list ----------
  function renderList() {
    const list = $('convList');
    list.replaceChildren();
    convs.forEach((c) => {
      const li = document.createElement('li');
      li.dataset.id = c.id;
      const n = document.createElement('div'); n.className = 'n'; n.textContent = c.name;
      const s = document.createElement('div'); s.className = 's'; s.textContent = `${c.channel === 'voice' ? 'Voice' : 'WhatsApp'} · ${c.note}`;
      li.append(n, s);
      li.addEventListener('click', () => openConversation(c));
      list.append(li);
    });
  }

  function renderChat(c) {
    document.querySelectorAll('#convList li').forEach((li) => li.classList.toggle('active', li.dataset.id === c.id));
    $('chatHead').textContent = `${c.channel === 'voice' ? 'Voice' : 'WhatsApp'} ${c.phone}`;
    const body = $('chatBody');
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
    if (!token) return;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (currentCid !== c.id) return;
    send({ type: 'conversation.open', conversationId: c.id, channel: c.channel, token, refresh: opts.refresh === true });
  }

  // The rapid-switch test checks that late answers are dropped, so it must always load fresh.
  $('rapid').addEventListener('click', async () => {
    const order = [convs[1], convs[0], convs[3], convs[4], convs[0]].filter(Boolean);
    for (const c of order) { openConversation(c, { refresh: true }); await new Promise((r) => setTimeout(r, 250)); }
    report('rapid', 'Rapid switch done: view should show Jenna Hopkins only', true);
  });

  // Sends a token that has already expired, to prove the view asks for a new one and still loads.
  $('expiry').addEventListener('click', () => {
    if (!currentConv) { report('expiry', 'Open a conversation first', false); return; }
    openConversation(currentConv, { refresh: true, ttl: 1, delayMs: 2200 });
    report('expiry', 'Sent an expired token: the view should still load after asking for a new one', true);
  });

  // ---------- browser checks (results also go to the C4C host page) ----------
  const results = $('testResults');
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
        await api('cookie-set');
        const r = await api('cookie-check');
        const ok = !!(r.json && r.json.cookieReceived);
        report('cookie', ok ? 'Cookie kept (login can persist)' : 'Cookie dropped (third-party cookies blocked: Nubitel login may fail inside C4C)', ok);
      } catch (e) { report('cookie', 'Cookie test failed: ' + e.message, false); }
    },
  };
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => TESTS[b.dataset.test]()));

  // Tell the host we loaded (counts reloads in the C4C host harness)
  if (window.parent !== window && CFG.hostOrigin) window.parent.postMessage({ v: 1, type: 'nubitel.loaded' }, CFG.hostOrigin);

  // ---------- start: is there already a session? (survives reloads, mashup rebuilds) ----------
  (async () => {
    const r = await api('session');
    if (r.status === 200) await enterApp();
    else showLogin(r.json && r.json.reason === 'expired' ? 'Your session expired. Sign in again.' : '');
  })();
})();
