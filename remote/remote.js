(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const conn = $('#conn');

  function toast(text, ms = 2200) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms);
  }

  function buzz() { if (navigator.vibrate) navigator.vibrate(8); }

  async function post(path, body) {
    // give up after 30 s, so a lost reply shows an error instead of leaving the page waiting forever
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'the box took too long to answer' : "can't reach the box");
    } finally { clearTimeout(timer); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  async function key(name) {
    buzz();
    try { await post('/api/input', { key: name }); setConn(true); }
    catch (e) { setConn(false); toast("Can't reach the TV"); }
  }

  function setConn(ok) {
    conn.textContent = ok ? 'Connected' : 'Not connected';
    conn.classList.toggle('ok', ok);
    conn.classList.toggle('bad', !ok);
  }

  fetch('/api/info').then((r) => r.json()).then((i) => { setConn(true); conn.textContent = 'Connected to ' + (i.hostname || 'TV'); })
    .catch(() => setConn(false));

  // ---- tabs
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }
  // the tab is kept in the address (#vpn, #add, #type, #remote), so a bookmark or a refresh stays put
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    showTab(t.dataset.tab);
    history.replaceState(null, '', '#' + t.dataset.tab);
  }));
  const startTab = location.hash.slice(1);
  if (document.getElementById('tab-' + startTab)) showTab(startTab);

  // ---- buttons
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => key(b.dataset.key)));

  // ---- touchpad: swipe to move (long swipes move several steps), tap for OK
  const pad = $('#pad');
  const STEP = 56;
  let start = null, last = null, moved = false;
  pad.addEventListener('pointerdown', (e) => {
    start = last = { x: e.clientX, y: e.clientY };
    moved = false;
    pad.setPointerCapture(e.pointerId);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) >= STEP || Math.abs(dy) >= STEP) {
      if (Math.abs(dx) > Math.abs(dy)) key(dx > 0 ? 'right' : 'left');
      else key(dy > 0 ? 'down' : 'up');
      last = { x: e.clientX, y: e.clientY };
      moved = true;
    }
  });
  pad.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved) {
      if (Math.abs(dx) > 24 || Math.abs(dy) > 24) {
        if (Math.abs(dx) > Math.abs(dy)) key(dx > 0 ? 'right' : 'left');
        else key(dy > 0 ? 'down' : 'up');
      } else {
        pad.classList.add('flash');
        setTimeout(() => pad.classList.remove('flash'), 120);
        key('ok');
      }
    }
    start = null;
  });
  pad.addEventListener('pointercancel', () => { start = null; });

  // ---- typing
  $('#send').addEventListener('click', async () => {
    const text = $('#text').value;
    if (!text) return;
    try { await post('/api/input', { text }); $('#text').value = ''; toast('Sent'); }
    catch (e) { toast("Can't reach the TV"); }
  });

  // ---- add an app
  $('#add-go').addEventListener('click', async () => {
    const url = $('#add-url').value.trim();
    if (!url) { toast('Paste a web address first'); return; }
    try {
      const app = await post('/api/apps', {
        url,
        name: $('#add-name').value.trim(),
        vpn: $('#add-vpn').checked,
        tvLayout: $('#add-tv').checked,
      });
      $('#add-url').value = '';
      $('#add-name').value = '';
      toast(app.name + ' added to the TV');
    } catch (e) { toast("Couldn't add it: " + e.message); }
  });

  // ---- VPN servers
  const nice = (n) => n.replace(/^[a-z0-9]+[-_]/i, '').replace(/[-_]/g, ' ').toUpperCase(); // drop the 'vpn-' prefix
  function renderVpn(st) {
    const list = $('#vpn-list');
    list.textContent = '';
    $('#vpn-status').textContent = st.connected ? 'Connected to ' + nice(st.server)
      : (st.servers || []).length ? (st.wanted === false ? 'VPN is turned off (Control Centre on the TV)' : 'Connecting…') : 'No servers added yet';
    (st.servers || []).forEach((name) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = nice(name) + ' ';
      if (st.connected && st.server === name) { const s = document.createElement('small'); s.textContent = 'connected'; label.appendChild(s); }
      const exp = (st.expires || {})[name];
      if (exp) {
        const d = document.createElement('div');
        d.className = 'renew';
        const expired = (st.expired || []).includes(name);
        d.textContent = expired ? 'Expired: download a new one' : 'Renew by ' + new Date(exp * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        if (expired || (st.expiringSoon || []).includes(name)) d.classList.add('soon');
        label.appendChild(d);
      }
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        try { renderVpn(await post('/api/vpn', { action: 'remove', server: name })); toast('Removed'); }
        catch (e) { toast("Couldn't remove it: " + e.message); }
      });
      li.append(label, rm);
      list.appendChild(li);
    });
  }
  function loadVpn() { fetch('/api/vpn').then((r) => r.json()).then(renderVpn).catch(() => {}); }
  loadVpn();
  document.querySelector('.tab[data-tab=vpn]').addEventListener('click', loadVpn);
  $('#vpn-files').addEventListener('change', async (e) => {
    let added = 0, n = 0;
    const failed = [];
    const files = [...e.target.files];
    for (const f of files) {
      n++;
      if (files.length > 1) toast(`Adding ${n} of ${files.length}…`);
      try {
        const content = await f.text();
        renderVpn(await post('/api/vpn', { action: 'import', filename: f.name, content }));
        added++;
      } catch (err) { failed.push(f.name + ': ' + err.message); }
    }
    const done = added ? (added === 1 ? 'Server added' : added + ' servers added') : '';
    if (failed.length) {
      toast([done, 'Not added: ' + failed.join('; ')].filter(Boolean).join('. '), 8000);
    } else if (done) toast(done);
    e.target.value = '';
  });
})();
