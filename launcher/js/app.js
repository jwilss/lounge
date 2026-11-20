/*
 * Home screen: top shelf, app tiles, clock, background, screensaver,
 * and messages from the box (Home button, admin page, VPN and volume changes).
 */
(function () {
  'use strict';

  const API = window.LoungeAPI;
  const SIZES = {
    standard: { label: 'Standard', scale: 1, cols: 5 },
    large: { label: 'Large', scale: 1.25, cols: 4 },
    xlarge: { label: 'Extra large', scale: 1.5, cols: 3 },
  };
  const SIZE_ORDER = ['standard', 'large', 'xlarge'];
  let COLS = 5;

  const App = {
    apps: [],
    settings: {},
    shelfCache: new Map(),
    shelfFor: null,
    moving: null, // id of the tile being moved
    vpnState: null,
    profiles: { current: null, users: [] },
    magnifierOpen: false,

    async boot() {
      await API.init();
      this.bootMark();
      document.getElementById('preview-badge').hidden = !API.preview;
      this.settings = await API.getSettings();
      this.apps = await API.getApps();
      try { this.profiles = await API.profiles(); } catch (e) { /* older box */ }
      this.applySize(this.settings.displaySize, true);
      this.applyNames();
      this.renderAvatar();

      Focus.init();
      Focus.keyboard = new LoungeKeyboard(document.getElementById('kb-host'), { layout: this.settings.keyboardLayout });

      document.addEventListener('focuschanged', (e) => this.onFocus(e.detail.el));
      Focus.onHome = () => this.onEvent({ type: 'home', already: true });
      this.renderGrid();
      Focus.push(document.getElementById('home'), {
        onBack: () => this.scrollHome(),
        onMenu: () => ControlCentre.toggle(),
        initial: document.querySelector('#grid .tile'),
      });

      this.startClock();
      this.refreshVpn();
      Screensaver.init();
      API.on((evt) => this.onEvent(evt));
      Pointer.init();
      document.getElementById('avatar').addEventListener('click', () => ControlCentre.open('profiles'));
      API.magnifierState().then((o) => { this.magnifierOpen = o; }).catch(() => {});
      this.hideBoot();
      // tell the box the home screen drew properly (lounge-launcher restarts it in safe mode otherwise)
      if (!API.preview) requestAnimationFrame(() => fetch('/api/launcher-ready', { method: 'POST' }).catch(() => {}));
    },

    // maker's mark and version in the corner of the boot screen. The installer draws it as
    // brand/maker.svg (the same picture as the splash); without that (preview mode) build it here.
    bootMark() {
      const img = document.querySelector('#boot .boot-mark');
      if (!img) return;
      const build = () => {
        const ver = (API.info && API.info.version) || '';
        img.replaceWith(h('div', { class: 'boot-mark-html' }, ver ? h('span', {}, ver) : null,
          h('img', { src: '../brand/jw-mark.svg', alt: '' })));
      };
      if (img.complete && !img.naturalWidth) build();
      else img.addEventListener('error', build, { once: true });
    },

    // the logo on black (same as the boot splash) fades into the home screen
    hideBoot() {
      const boot = document.getElementById('boot');
      const go = () => setTimeout(() => {
        boot.classList.add('gone');
        document.body.classList.add('booted');
        setTimeout(() => boot.remove(), 900);
      }, API.preview ? 250 : 700);
      (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(go, go);
    },

    // ---------- people ----------
    me() {
      return (this.profiles.users || []).find((u) => u.id === this.profiles.current) || null;
    },

    renderAvatar() {
      const btn = document.getElementById('avatar');
      const me = this.me();
      btn.hidden = !me;
      if (!me) return;
      btn.textContent = initials(me.name);
      btn.style.setProperty('--av', me.colour);
      btn.title = me.name;
    },

    async switchProfile(id) {
      const who = (this.profiles.users || []).find((u) => u.id === id);
      if (!who || id === this.profiles.current) return;
      Toast.show(`Switching to ${who.name}…`);
      try {
        this.profiles = await API.profileAction('switch', { id });
        await this.afterProfileChange();
      } catch (e) { Toast.show(`Couldn't switch: ${e.message}`, 4000); }
    },

    async afterProfileChange() {
      const before = this.settings.displaySize;
      this.settings = await API.getSettings();
      this.renderAvatar();
      Focus.keyboard.setLayout(this.settings.keyboardLayout);
      Pointer.setSize(this.settings.pointerSize);
      this.applyNames();
      if (this.settings.displaySize !== before) this.applySize(this.settings.displaySize, true);
      this.shelfCache.clear();
      this.renderGrid();
      const me = this.me();
      if (me) Toast.show(`Hello, ${me.name}`);
      const cur = Focus.current;
      if (cur && cur.classList.contains('tile')) this.showShelf(this.apps.find((a) => a.id === cur.dataset.id) || null, cur, true);
      ControlCentre.update();
    },

    applyNames() {
      document.body.classList.toggle('names-always', (this.settings.appNames || 'always') === 'always');
    },

    // ---------- display size ----------
    applySize(size, quiet) {
      const s = SIZES[size] || SIZES.standard;
      const root = document.documentElement;
      root.style.setProperty('--ui-scale', s.scale);
      root.style.setProperty('--cols', s.cols);
      Object.keys(SIZES).forEach((k) => root.classList.toggle('size-' + k, k === (SIZES[size] ? size : 'standard')));
      COLS = s.cols;
      this.settings.displaySize = SIZES[size] ? size : 'standard';
      if (!quiet) {
        this.renderGrid();
        if (Focus.current) this.scrollFor(Focus.current);
        Toast.show('Display size: ' + s.label);
      }
    },

    async setSize(size) {
      this.applySize(size);
      try { this.settings = await API.saveSettings({ ...this.settings, displaySize: size }); } catch (e) { /* keep local */ }
    },

    cycleSize(dir = 1) {
      const i = SIZE_ORDER.indexOf(this.settings.displaySize || 'standard');
      const next = SIZE_ORDER[Math.min(SIZE_ORDER.length - 1, Math.max(0, i + dir))];
      if (next !== this.settings.displaySize) this.setSize(next);
    },

    sizeLabel() { return (SIZES[this.settings.displaySize] || SIZES.standard).label; },

    // ---------- tiles ----------
    renderGrid() {
      const grid = document.getElementById('grid');
      const keep = Focus.current && Focus.current.dataset.key;
      grid.textContent = '';
      const items = [...this.apps.map((a) => ({ kind: 'app', app: a })), { kind: 'add' }, { kind: 'settings' }];
      items.forEach((item, idx) => grid.appendChild(this.tile(item, idx)));
      if (keep) {
        const again = grid.querySelector(`[data-key="${CSS.escape(keep)}"]`);
        if (again) Focus.set(again);
      }
      Focus.refresh();
    },

    tile(item, idx) {
      const row = Math.floor(idx / COLS);
      let key, label, face;
      if (item.kind === 'app') {
        const a = item.app;
        key = 'tile:' + a.id;
        label = a.name;
        // Apple TV style: the app's brand colour with its logo in white, or its name in white
        // when it has no logo (family can add their own apps without needing one)
        face = h('div', { class: 'tile-face', style: { background: a.color || '#3a3a40' } });
        face.appendChild(h('span', { class: 'tile-name' }, a.name));
        if (a.logo) {
          const img = h('img', { class: 'tile-logo', alt: '', src: a.logo, draggable: 'false' });
          img.onerror = () => { img.remove(); face.classList.remove('has-logo'); };
          face.classList.add('has-logo');
          face.prepend(img);
        }
      } else if (item.kind === 'add') {
        key = 'tile:__add';
        label = 'Add App';
        face = h('div', { class: 'tile-face tile-ghost' }, h('span', { class: 'tile-glyph' }, '+'));
      } else {
        key = 'tile:__settings';
        label = 'Settings';
        face = h('div', { class: 'tile-face tile-settings' }, h('span', { class: 'tile-glyph tile-gear' }, '⚙'));
      }
      face.appendChild(h('div', { class: 'tile-sheen' }));

      const el = h('div', {
        class: 'tile focusable' + (this.moving && item.app && this.moving === item.app.id ? ' is-moving' : ''),
        dataset: { key, row: String(row), id: item.app ? item.app.id : '' },
        role: 'button',
      }, face, h('div', { class: 'tile-label' }, label));

      el.addEventListener('click', () => {
        if (this.moving) { this.stopMoving(); return; }
        if (item.kind === 'app') this.open(item.app);
        else if (item.kind === 'add') AppSheets.add();
        else AppSheets.settings();
      });
      if (item.kind === 'app') {
        el._onMenu = () => AppSheets.tileMenu(item.app);
        el._onMove = (dir) => this.moving === item.app.id ? (this.moveTile(item.app.id, dir), true) : false;
        el._onBack = () => { if (this.moving) { this.stopMoving(); return true; } return false; };
      }
      // tilt towards the pointer, like Apple TV's parallax icons
      el.addEventListener('mousemove', (e) => {
        if (!el.classList.contains('is-focused')) return;
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        tilt(el, px, py);
      });
      el.addEventListener('focused', (e) => {
        const d = e.detail && e.detail.dir;
        const t = { left: [-0.35, 0], right: [0.35, 0], up: [0, -0.35], down: [0, 0.35] }[d] || [0, 0];
        tilt(el, t[0], t[1]);
        clearTimeout(el._tiltT);
        el._tiltT = setTimeout(() => tilt(el, 0, 0), 420);
      });
      el.addEventListener('blurred', () => tilt(el, 0, 0));
      return el;
    },

    async open(app, url, direct) {
      // the YouTube tile opens Lounge's own channels page; its "Open YouTube" button opens the app
      if (app.shelf === 'youtube' && !url && !direct) { AppSheets.youtube(app); return; }
      Toast.show(window.LOUNGE_DEMO ? `On the box, ${app.name} opens full screen` : API.preview ? `Opening ${app.name} in a new tab` : `Opening ${app.name}`);
      try {
        await API.launch(app, url);
      } catch (e) {
        Toast.show(`Couldn't open ${app.name}: ${e.message}`, 4000);
      }
    },

    startMoving(id) {
      this.moving = id;
      document.body.classList.add('is-moving');
      this.renderGrid();
      Toast.show('Use the arrows to move it, then press OK');
    },

    async stopMoving() {
      this.moving = null;
      document.body.classList.remove('is-moving');
      this.renderGrid();
      await API.saveApps(this.apps);
    },

    moveTile(id, dir) {
      const i = this.apps.findIndex((a) => a.id === id);
      const j = { left: i - 1, right: i + 1, up: i - COLS, down: i + COLS }[dir];
      if (j < 0 || j >= this.apps.length) return;
      const [a] = this.apps.splice(i, 1);
      this.apps.splice(j, 0, a);
      this.renderGrid();
      const el = document.querySelector(`#grid [data-key="tile:${CSS.escape(id)}"]`);
      if (el) { Focus.set(el); this.scrollFor(el); }
    },

    async reloadApps() {
      this.apps = await API.getApps();
      this.renderGrid();
    },

    // ---------- focus & shelf ----------
    onFocus(el) {
      if (!el || !document.getElementById('home').contains(el)) return;
      this.scrollFor(el);
      if (el.classList.contains('tile')) {
        const app = this.apps.find((a) => a.id === el.dataset.id);
        clearTimeout(this._shelfT);
        this._shelfT = setTimeout(() => this.showShelf(app || null, el), 120);
      }
      if (el.classList.contains('card') && el.dataset.thumb) setBackground(el.dataset.thumb, null);
    },

    scrollFor(el) {
      const scroller = document.getElementById('scroller');
      const row = el.classList.contains('tile') ? Number(el.dataset.row) : -1;
      document.body.classList.toggle('scrolled', row > 0);
      if (row <= 0) { scroller.style.transform = ''; return; }
      // lift the grid so the selected row sits in the middle-upper part of the screen
      const grid = document.getElementById('grid');
      const offset = el.offsetTop + grid.offsetTop - window.innerHeight * 0.4;
      scroller.style.transform = `translateY(${-Math.max(0, offset)}px)`;
    },

    scrollHome() {
      const first = document.querySelector('#grid .tile');
      if (Focus.current && Focus.current.dataset.row !== '0' && first) Focus.set(first);
    },

    async showShelf(app, tileEl, force) {
      const title = document.getElementById('shelf-title');
      const sub = document.getElementById('shelf-sub');
      const label = document.getElementById('shelf-label');
      const row = document.getElementById('shelf-row');
      const shelf = document.getElementById('shelf');
      this.shelfFor = app ? app.id : null;

      if (!app) {
        const isAdd = tileEl && tileEl.dataset.key === 'tile:__add';
        title.textContent = isAdd ? 'Add an app' : 'Settings';
        sub.textContent = isAdd ? 'Turn any website into an app on your home screen.' : 'Display size, keyboard, Jellyfin, screensaver and YouTube channels.';
        row.textContent = '';
        label.textContent = '';
        shelf.classList.remove('has-cards');
        setBackground(null);
        return;
      }

      title.textContent = app.name;
      sub.textContent = '';
      let data = this.shelfCache.get(app.id);
      setBackground(firstThumbnail(data)); // straight away from the cache; pure black if nothing yet

      if (force || !data || Date.now() - data.at > 5 * 60 * 1000) {
        data = { at: Date.now(), ...(await API.shelf(app)) };
        this.shelfCache.set(app.id, data);
      }
      if (this.shelfFor !== app.id) return; // focus moved on while loading

      const keep = Focus.current && Focus.current.classList.contains('card') ? Focus.current.dataset.key : null;
      row.textContent = '';
      const sections = (data.sections || []).filter((s) => s.items && s.items.length);
      shelf.classList.toggle('has-cards', sections.length > 0);
      label.textContent = sections.length ? sections[0].title + (data.sample ? ' (sample)' : '') : '';
      if (!sections.length) {
        if (app.shelf === 'youtube' && !(this.settings.youtubeChannels || []).length) {
          sub.textContent = 'Add your favourite channels in Settings to see their new videos here.';
        } else if (app.id === 'jellyfin' && !(this.settings.jellyfin || {}).connected) {
          sub.textContent = 'Sign in to Jellyfin in Settings to see Continue watching here.';
        }
        return;
      }

      let firstImage = null;
      sections.forEach((sec, si) => {
        sec.items.slice(0, 12).forEach((it, i) => {
          const img = h('div', { class: 'card-img' });
          if (it.thumbnail) { img.style.backgroundImage = `url("${it.thumbnail}")`; firstImage = firstImage || it.thumbnail; }
          else if (it.gradient) img.style.backgroundImage = it.gradient;
          if (it.progress > 0.01) img.appendChild(h('div', { class: 'card-progress' }, h('span', { style: { width: Math.round(it.progress * 100) + '%' } })));
          const card = h('div', {
            class: 'card focusable' + (si > 0 && i === 0 ? ' card-section-start' : ''),
            dataset: { key: `card:${app.id}:${si}:${it.key || it.jellyfinItem || it.url || i}`, thumb: it.thumbnail || '', section: sec.title },
            role: 'button',
          }, img, h('div', { class: 'card-label' }, h('span', { class: 'card-title' }, it.title), it.subtitle ? h('span', { class: 'card-sub' }, it.subtitle) : null));
          card.addEventListener('click', () => this.openItem(app, it));
          if (sec.kind === 'recent') card._onMenu = () => AppSheets.cardMenu(app, it);
          card.addEventListener('focused', () => { label.textContent = sec.title + (data.sample ? ' (sample)' : ''); });
          row.appendChild(card);
        });
      });
      setBackground(firstImage);
      if (keep) {
        const again = row.querySelector(`[data-key="${CSS.escape(keep)}"]`);
        Focus.set(again || row.querySelector('.card'));
      }
    },

    async openItem(app, it) {
      if (it.sample && API.preview) {
        Toast.show(`On the box this reopens "${it.title}" in ${app.name}`);
        return;
      }
      Toast.show(`Opening ${it.title}`);
      try { await API.openItem(app, it); } catch (e) { Toast.show(`Couldn't open it: ${e.message}`, 4000); }
    },

    refreshShelf(appId) {
      this.shelfCache.delete(appId);
      const cur = Focus.current;
      const tile = cur && cur.classList.contains('tile') ? cur : null;
      if (this.shelfFor === appId) {
        const app = this.apps.find((a) => a.id === appId);
        if (app) this.showShelf(app, tile, true);
      }
    },

    // ---------- clock & VPN pill ----------
    startClock() {
      const el = document.getElementById('clock');
      el.addEventListener('click', () => ControlCentre.toggle()); // pointer users: the clock opens Control Centre
      const tick = () => {
        const d = new Date();
        el.textContent = d.toLocaleTimeString('en-GB', { hour: this.settings.clock24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !this.settings.clock24 });
      };
      tick();
      setInterval(tick, 5000);
    },

    async refreshVpn() {
      try {
        const v = await API.vpn();
        this.setVpn(v);
        if ((v.expired || []).length) Toast.show('VPN servers have expired: renew them in Settings > VPN', 6000);
        else if ((v.expiringSoon || []).length) Toast.show('VPN servers expire soon: renew them in Settings > VPN', 6000);
      } catch (e) { /* leave as is */ }
    },

    setVpn(v) {
      this.vpnState = v;
      const pill = document.getElementById('vpn-pill');
      if (v && v.connected) {
        pill.hidden = false;
        pill.textContent = '';
        pill.append(h('span', { class: 'shield' }), 'VPN · ' + serverName(v.server));
      } else {
        pill.hidden = true;
      }
      ControlCentre.update();
    },

    // ---------- messages from the box ----------
    onEvent(evt) {
      Screensaver.wake();
      switch (evt.type) {
        case 'home':
          // pressed Home while already on the home screen: open Control Centre (or close what's open).
          // Wait a moment first, in case it's the first half of a double press (app switcher).
          clearTimeout(this._homeT);
          if (Switcher.open) { Switcher.hide(); break; }
          if (evt.already) {
            this._homeT = setTimeout(() => {
              if (Focus.keyboard.isOpen) Focus.keyboard.close();
              else if (Sheets.anyOpen()) Sheets.closeAll();
              else ControlCentre.toggle();
            }, 450);
          } else {
            Sheets.closeAll();
            this.scrollHome();
          }
          break;
        case 'switcher':
          clearTimeout(this._homeT);
          if (Focus.keyboard.isOpen) Focus.keyboard.close();
          Switcher.show(evt.running);
          break;
        case 'profile': {
          const was = this.profiles.current;
          this.profiles = evt.profiles;
          if (evt.profiles.current !== was) this.afterProfileChange();
          else { this.renderAvatar(); ControlCentre.update(); }
          break;
        }
        case 'update':
          Toast.show(`Update available: Lounge ${evt.info.version}. Settings > Software update`, 7000);
          this.updateInfo = evt.info;
          break;
        case 'update-progress': {
          const st = evt.status || {};
          if (st.message) Toast.show(st.message, st.stage === 'failed' ? 7000 : 4000);
          break;
        }
        case 'pointer':
          this.settings.airPointer = !!evt.on;
          if (!evt.on) Pointer.hide();
          Toast.show(evt.on ? 'Pointer on: move the remote to point' : 'Pointer off: use the arrows and OK', 3000);
          ControlCentre.update();
          break;
        case 'magnifier':
          this.magnifierOpen = !!evt.open;
          ControlCentre.update();
          break;
        case 'apps':
          this.reloadApps();
          if (evt.added) Toast.show(`${evt.added} added to your home screen`);
          break;
        case 'vpn':
          this.setVpn(evt.state);
          break;
        case 'sleeptimer':
          this.sleepTimer = evt.state;
          if (ControlCentre.paintSleep) ControlCentre.paintSleep();
          break;
        case 'volume':
          if (ControlCentre.showVolume) ControlCentre.showVolume(evt.volume);
          break;
        case 'text':
          if (Focus.keyboard.isOpen) Focus.keyboard.setValue((Focus.keyboard.value || '') + evt.text), Focus.keyboard._emit();
          break;
        case 'size':
          if (evt.size !== this.settings.displaySize) this.applySize(evt.size);
          ControlCentre.update();
          break;
        case 'shelf':
          this.refreshShelf(evt.app);
          break;
        case 'toast':
          Toast.show(evt.text);
          break;
      }
    },
  };

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 1)).toUpperCase();
  }

  function tilt(el, x, y) {
    el.style.setProperty('--ry', (x * 14).toFixed(2) + 'deg');
    el.style.setProperty('--rx', (-y * 14).toFixed(2) + 'deg');
    el.style.setProperty('--sx', (50 + x * 80).toFixed(1) + '%');
  }

  function firstThumbnail(data) {
    for (const sec of (data && data.sections) || []) {
      const it = (sec.items || []).find((i) => i.thumbnail);
      if (it) return it.thumbnail;
    }
    return null;
  }

  // cross-fading blurred background: the selected app's first shelf picture, or pure black
  let bgFlip = false, bgLast = '';
  function setBackground(image) {
    const sig = image || '';
    if (sig === bgLast) return;
    bgLast = sig;
    const a = document.getElementById('bg-a');
    const b = document.getElementById('bg-b');
    const next = bgFlip ? a : b;
    const prev = bgFlip ? b : a;
    bgFlip = !bgFlip;
    next.style.backgroundImage = image ? `url("${image}")` : '';
    next.style.backgroundColor = '#000';
    next.classList.toggle('has-image', !!image);
    next.classList.add('show');
    prev.classList.remove('show');
  }

  function serverName(s) {
    if (!s) return '';
    return s.replace(/^[a-z0-9]+[-_]/i, '').replace(/[-_]/g, ' ').toUpperCase(); // 'vpn-uk-london-1' -> 'UK LONDON 1'
  }

  // ---------- screensaver ----------
  const Screensaver = {
    timer: null,
    active: false,
    init() {
      ['mousemove', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, () => this.wake(), { passive: true }));
      Focus.onAnyKey = () => {
        if (this.active) { this.stop(); return true; }
        this.wake();
        return false;
      };
      this.wake();
    },
    wake() {
      if (this.active) this.stop();
      clearTimeout(this.timer);
      const mins = Number(App.settings.screensaverMinutes) || 0;
      if (mins > 0) this.timer = setTimeout(() => this.start(), mins * 60 * 1000);
    },
    async start() {
      if (document.hidden) return; // an app is in front
      this.active = true;
      const box = document.getElementById('screensaver');
      box.hidden = false;
      requestAnimationFrame(() => box.classList.add('show'));
      let images = [];
      if (!API.preview) {
        try { images = (await fetch('/api/screensaver').then((r) => r.json())).images || []; } catch (e) { /* none */ }
      }
      const layers = box.querySelectorAll('.ss-image');
      const clock = box.querySelector('.ss-clock');
      // OLED-safe styles: 'logo' (default: the logo alone bouncing over black), 'black', 'photos'
      const style = ['logo', 'black', 'photos'].includes(App.settings.screensaverStyle) ? App.settings.screensaverStyle : 'logo';
      box.classList.remove('ss-style-logo', 'ss-style-black', 'ss-style-photos');
      box.classList.add('ss-style-' + style);
      const float = box.querySelector('.ss-float');
      const colours = ['#ffb340', '#ff375f', '#bf5af2', '#0a84ff', '#64d2ff', '#30d158', '#ffd60a'];
      let ci = 0;
      float.style.setProperty('--ss-colour', colours[0]);
      // old-school mode: a new colour every time the logo hits an edge
      this.onBounce = style === 'logo' && App.settings.screensaverBounceColours
        ? () => { ci = (ci + 1) % colours.length; float.style.setProperty('--ss-colour', colours[ci]); }
        : null;
      this.drift(float);
      const tick = () => { clock.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
      tick();
      this.clockTimer = setInterval(tick, 10000);
      if (style !== 'photos') { layers.forEach((l) => l.classList.remove('ss-on')); return; }
      let i = 0, flip = 0;
      const step = () => {
        const layer = layers[flip];
        layer.style.backgroundImage = images.length ? `url("${images[i % images.length]}")` : '';
        layer.classList.toggle('ss-gradient', !images.length);
        layer.classList.remove('ss-on');
        void layer.offsetWidth; // restart the slow pan
        layer.classList.add('ss-on');
        layers[1 - flip].classList.remove('ss-on');
        flip = 1 - flip;
        i++;
      };
      step();
      this.cycle = setInterval(step, 12000);
    },
    // moves the logo and clock slowly around the screen, bouncing off the edges, so no
    // pixel of an OLED shows the same thing for long
    drift(el) {
      cancelAnimationFrame(this.raf);
      const speed = 45; // px per second
      let x = Math.random() * 0.5 * innerWidth, y = Math.random() * 0.5 * innerHeight;
      let dx = Math.random() < 0.5 ? -1 : 1, dy = Math.random() < 0.5 ? -1 : 1, last = performance.now();
      const frame = (now) => {
        const dt = Math.min(0.2, (now - last) / 1000); last = now;
        const maxX = Math.max(0, innerWidth - el.offsetWidth), maxY = Math.max(0, innerHeight - el.offsetHeight);
        x += dx * speed * dt; y += dy * speed * 0.6 * dt;
        let hit = false;
        if (x <= 0 || x >= maxX) { dx = -dx; x = Math.max(0, Math.min(maxX, x)); hit = true; }
        if (y <= 0 || y >= maxY) { dy = -dy; y = Math.max(0, Math.min(maxY, y)); hit = true; }
        if (hit && this.onBounce) this.onBounce();
        el.style.transform = `translate(${x}px, ${y}px)`;
        if (this.active) this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    },
    stop() {
      this.active = false;
      cancelAnimationFrame(this.raf);
      clearInterval(this.clockTimer);
      clearInterval(this.cycle);
      const box = document.getElementById('screensaver');
      box.classList.remove('show');
      setTimeout(() => { if (!this.active) box.hidden = true; }, 600);
      this.wake();
    },
  };

  window.App = App;
  window.Screensaver = Screensaver;
  window.serverName = serverName;
  window.initials = initials;
  document.addEventListener('DOMContentLoaded', () => App.boot());
})();
