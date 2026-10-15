/* Simulated C4C shell: hosts Nubitel in a "mashup" iframe and lets you change
 * the iframe attributes and reload behaviour, to see which settings break what. */
(function () {
  'use strict';
  const CFG = window.HOST_CONFIG; // { nubitelUrl, nubitelOrigin }
  const slot = document.getElementById('mashupSlot');
  const logEl = document.getElementById('log');
  let loads = 0;
  let frame = null;

  function log(text, kind = 'info') {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    logEl.prepend(li);
  }

  function buildFrame() {
    const allow = [];
    if (document.getElementById('allowMic').checked) allow.push('microphone');
    if (document.getElementById('allowClip').checked) allow.push('clipboard-write');
    const f = document.createElement('iframe');
    f.title = 'Nubitel';
    if (allow.length) f.setAttribute('allow', allow.join('; '));
    if (document.getElementById('useSandbox').checked) {
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    }
    f.src = CFG.nubitelUrl;
    slot.replaceChildren(f);
    frame = f;
    log(`Mashup iframe built: allow="${allow.join('; ') || 'none'}"${f.hasAttribute('sandbox') ? ', sandboxed' : ''}`);
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== CFG.nubitelOrigin) return;
    const m = e.data || {};
    if (m.type === 'nubitel.loaded') {
      loads += 1;
      document.getElementById('loads').textContent = `Nubitel loads: ${loads}`;
      log(loads > 1 ? `Nubitel reloaded (load #${loads}): active calls and chats would drop` : 'Nubitel loaded inside C4C', loads > 1 ? 'fail' : 'ok');
    }
    if (m.type === 'nubitel.diag') log(`${m.test}: ${m.text}`, m.ok ? 'ok' : 'fail');
  });

  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.getElementById('page').textContent = b.dataset.page;
    const rerender = document.querySelector('input[name="persist"]:checked').value === 'rerender';
    log(`Navigated to ${b.dataset.page}`);
    if (rerender) buildFrame();
  }));

  document.getElementById('apply').addEventListener('click', buildFrame);
  buildFrame();
})();
