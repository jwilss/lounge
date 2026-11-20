/*
 * Talks to the lounged backend on the box.
 * When there is no backend (opening index.html straight from disk on a PC),
 * it runs in preview mode: apps open in a new browser tab and system controls
 * are simulated, so the whole interface can be tried out anywhere.
 */
(function () {
  'use strict';

  const PREVIEW_APPS = [
    { id: 'youtube', name: 'YouTube', type: 'web', url: 'https://www.youtube.com', tvLayout: true, vpn: true, color: '#d92b2b', shelf: 'youtube' },
    { id: 'jellyfin', name: 'Jellyfin', type: 'native', vpn: true, color: '#6a3fb5' },
    { id: 'firefox', name: 'Firefox', type: 'web', browser: 'firefox', url: 'https://www.google.co.uk', vpn: true, color: '#e25920' },
  ];
  const PREVIEW_SETTINGS = { keyboardLayout: 'qwerty', displaySize: 'standard', vpnOn: true, vpnKillSwitch: true, clock24: true, screensaverStyle: 'logo', screenOffMinutes: 15, screensaverMinutes: 5, youtubeChannels: [], magnifierZoom: 3, magnifierSize: 'medium', pointerSize: 'large', appNames: 'always' };
  const PREVIEW_SERVERS = ['vpn-uk-12', 'vpn-uk-27', 'vpn-ie-4', 'vpn-nl-55'];
  const PROFILE_COLOURS = ['#ff9f0a', '#30d158', '#0a84ff', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem('lounge.' + key));
      localStorage.setItem('lounge.' + key, JSON.stringify(value));
    } catch (e) { /* storage can be unavailable; preview just forgets */ }
    return null;
  }

  async function http(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  const previewState = {
    apps: null,
    settings: null,
    vpn: { connected: true, server: 'vpn-uk-12' },
    volume: { level: 40, muted: false },
  };

  const listeners = [];

  const API = {
    preview: true,
    info: { mode: 'preview', version: '0.6.1', remoteUrl: null },

    async init() {
      if (location.protocol.startsWith('http')) {
        try {
          this.info = await http('GET', '/api/info');
          this.preview = false;
          this._events();
          return;
        } catch (e) { /* fall through to preview */ }
      }
      this.preview = true;
      previewState.apps = store('apps') || PREVIEW_APPS.map((a) => ({ ...a }));
      previewState.settings = { ...PREVIEW_SETTINGS, ...(store('settings') || {}) };
      previewState.profiles = store('profiles') || { current: 'alex', users: [{ id: 'alex', name: 'Alex', colour: '#ff9f0a' }, { id: 'sam', name: 'Sam', colour: '#30d158' }] };
    },

    on(fn) { listeners.push(fn); },
    _emit(evt) { listeners.forEach((fn) => fn(evt)); },

    _events() {
      const es = new EventSource('/api/events');
      let opened = false;
      // after the box service restarts (e.g. an update), reload if Lounge's version changed
      es.onopen = async () => {
        if (opened) {
          try {
            const info = await http('GET', '/api/info');
            if (info.version !== this.info.version) location.reload();
          } catch (e) { /* not back yet */ }
        }
        opened = true;
      };
      es.onmessage = (m) => {
        try { this._emit(JSON.parse(m.data)); } catch (e) { /* ignore bad event */ }
      };
      es.onerror = () => { /* EventSource reconnects by itself */ };
    },

    // ---- apps ----
    async getApps() {
      if (this.preview) return previewState.apps;
      return (await http('GET', '/api/apps')).apps;
    },
    async saveApps(apps) {
      if (this.preview) { previewState.apps = apps; store('apps', apps); return apps; }
      return (await http('PUT', '/api/apps', { apps })).apps;
    },
    async addApp(app) {
      if (this.preview) {
        const id = slug(app.name || hostOf(app.url)) + '-' + Math.random().toString(36).slice(2, 6);
        const full = { id, type: 'web', vpn: true, color: colourFor(app.url), ...app };
        previewState.apps.push(full);
        store('apps', previewState.apps);
        return full;
      }
      return http('POST', '/api/apps', app);
    },
    iconUrl(app) {
      if (this.preview || app.type !== 'web') return null;
      return '/api/icon/' + encodeURIComponent(app.id) + (app.iconVersion ? '?v=' + app.iconVersion : '');
    },

    async launch(app, url) {
      if (this.preview || this.info.mode === 'dev') {
        if (!this.preview) http('POST', '/api/launch', { id: app.id, url: url || null }).catch(() => {});
        const target = url || app.url;
        if (window.LOUNGE_DEMO) return { ok: true, demo: true }; // hosted demo: nothing to open
        if (target) window.open(target, '_blank', 'noopener');
        return { ok: true, preview: true };
      }
      return http('POST', '/api/launch', { id: app.id, url: url || null });
    },
    async closeApp(id) {
      if (this.preview) return { ok: true };
      return http('POST', '/api/close', { id });
    },
    async closeAll() {
      if (this.preview) return { ok: true };
      return http('POST', '/api/close', { all: true });
    },
    async running() {
      if (this.preview) return ['youtube', 'jellyfin', 'firefox']; // sample open apps for the app switcher
      return (await http('GET', '/api/running')).running;
    },

    async snapshotUrl(id) {
      if (this.preview) return null;
      return '/api/snapshot/' + encodeURIComponent(id) + '?t=' + Date.now();
    },

    // ---- people ----
    async profiles() {
      if (this.preview) return previewState.profiles;
      return http('GET', '/api/profiles');
    },
    async profileAction(action, data = {}) {
      if (this.preview) {
        const p = previewState.profiles;
        if (action === 'switch') p.current = data.id;
        if (action === 'add') {
          const id = slug(data.name);
          p.users.push({ id, name: data.name, colour: PROFILE_COLOURS[p.users.length % PROFILE_COLOURS.length] });
        }
        if (action === 'update') p.users.forEach((u) => { if (u.id === data.id) { if (data.name) u.name = data.name; if (data.colour) u.colour = data.colour; } });
        if (action === 'remove') p.users = p.users.filter((u) => u.id !== data.id);
        store('profiles', p);
        return p;
      }
      return http('POST', '/api/profiles', { action, ...data });
    },

    async setPointer(on) {
      if (this.preview) { previewState.settings.airPointer = on; this._emit({ type: 'pointer', on }); return { on }; }
      return http('POST', '/api/pointer', { on });
    },

    // ---- software update ----
    async updateInfo() {
      if (this.preview) return { installed: this.info.version, version: this.info.version, available: false, status: { stage: 'idle' }, preview: true };
      return http('GET', '/api/update');
    },
    async updateCheck() {
      if (this.preview) return this.updateInfo();
      return http('POST', '/api/update', { action: 'check' });
    },
    async updateApply() {
      if (this.preview) return { started: false };
      return http('POST', '/api/update', { action: 'apply' });
    },

    // ---- magnifier ----
    async magnifierState() {
      if (this.preview) return !!this._mag;
      return (await http('GET', '/api/magnifier')).open;
    },
    async magnifier() {
      if (this.preview) { this._emit({ type: 'magnifier', open: !this._mag }); this._mag = !this._mag; return { ok: true }; }
      return http('POST', '/api/magnifier', { action: 'toggle' });
    },

    // ---- top shelf ----
    async shelf(app) {
      if (this.preview) return { sections: sampleShelf(app), sample: true };
      try { return await http('GET', '/api/shelf/' + encodeURIComponent(app.id)); }
      catch (e) { return { sections: [] }; }
    },
    async removeRecent(appId, key) {
      if (this.preview) return { ok: true };
      return http('POST', '/api/recent/remove', { app: appId, key });
    },
    async openItem(app, item) {
      if (item.jellyfinItem && !this.preview) {
        return http('POST', '/api/launch', { id: app.id, jellyfinItem: item.jellyfinItem, position: item.position || 0 });
      }
      return this.launch(app, item.url);
    },

    // ---- Jellyfin sign-in ----
    async jellyfinLogin(server, username, password) {
      if (this.preview) {
        previewState.settings.jellyfin = { server, user: username, connected: true };
        return previewState.settings.jellyfin;
      }
      return http('POST', '/api/jellyfin/login', { server, username, password });
    },
    async jellyfinLogout() {
      if (this.preview) { previewState.settings.jellyfin = {}; return { connected: false }; }
      return http('POST', '/api/jellyfin/logout', {});
    },

    // ---- settings ----
    async getSettings() {
      if (this.preview) return previewState.settings;
      return http('GET', '/api/settings');
    },
    async saveSettings(s) {
      if (this.preview) { previewState.settings = s; store('settings', s); return s; }
      return http('PUT', '/api/settings', s);
    },
    async resolveChannel(text) {
      if (this.preview) return { id: text, title: text };
      return http('POST', '/api/youtube/resolve', { query: text });
    },

    // ---- VPN ----
    async vpn() {
      if (this.preview) {
        const s = previewState.settings;
        return { ...previewState.vpn, servers: PREVIEW_SERVERS, lastServer: 'vpn-uk-12', wanted: s.vpnOn !== false, killSwitch: s.vpnKillSwitch !== false, preview: true };
      }
      return http('GET', '/api/vpn');
    },
    async vpnConnect(server) {
      if (this.preview) { previewState.vpn = { connected: true, server }; previewState.settings.vpnOn = true; return this.vpn(); }
      return http('POST', '/api/vpn', { action: 'connect', server });
    },
    async vpnDisconnect() {
      if (this.preview) { previewState.vpn = { connected: false, server: null }; previewState.settings.vpnOn = false; return this.vpn(); }
      return http('POST', '/api/vpn', { action: 'disconnect' });
    },
    async vpnKillSwitch(on) {
      if (this.preview) { previewState.settings.vpnKillSwitch = on; return this.vpn(); }
      return http('POST', '/api/vpn', { action: 'killswitch', on });
    },
    async vpnRemove(server) {
      if (this.preview) { return this.vpn(); }
      return http('POST', '/api/vpn', { action: 'remove', server });
    },

    // ---- volume / power ----
    async volume() {
      if (this.preview) return previewState.volume;
      return http('GET', '/api/volume');
    },
    async setVolume(level, muted) {
      if (this.preview) {
        previewState.volume = { level: clamp(level, 0, 100), muted: !!muted };
        return previewState.volume;
      }
      return http('POST', '/api/volume', { level, muted });
    },
    async power(action) {
      if (this.preview) return { ok: true, preview: true };
      return http('POST', '/api/power', { action });
    },
    async youtubePage() {
      if (this.preview) {
        const g = (a, b) => `linear-gradient(135deg, ${a}, ${b})`;
        const vids = (n, a, b) => Array.from({ length: 8 }, (_, i) => ({ title: `${n}: sample video ${i + 1}`, gradient: g(a, b), url: '', sample: true }));
        return { channels: [
          { id: 'a', title: 'Sample channel one', videos: vids('Channel one', '#1f4d3a', '#6cc49a') },
          { id: 'b', title: 'Sample channel two', videos: vids('Channel two', '#4a3a1a', '#e0b84c') },
        ] };
      }
      return http('GET', '/api/youtube/page');
    },
    // sleep timer: { at (epoch seconds) or null, remaining, minutes }
    async sleepTimer() {
      if (this.preview) return previewState.sleep || { at: null, remaining: null, minutes: 0 };
      return http('GET', '/api/sleeptimer');
    },
    async setSleepTimer(minutes) {
      if (this.preview) {
        previewState.sleep = minutes ? { at: Date.now() / 1000 + minutes * 60, remaining: minutes * 60, minutes } : { at: null, remaining: null, minutes: 0 };
        return previewState.sleep;
      }
      return http('POST', '/api/sleeptimer', { minutes });
    },
  };

  // Made-up cards so the shelf can be seen without a box (preview and demo only)
  function sampleShelf(app) {
    const g = (a, b) => `linear-gradient(135deg, ${a}, ${b})`;
    const card = (title, subtitle, a, b, progress) => ({ title, subtitle, gradient: g(a, b), progress: progress || 0, url: app.url, sample: true });
    switch (app.id) {
      case 'youtube': return [
        { title: 'Continue watching', kind: 'recent', items: [
          card('Building a workshop from scratch', 'Sample channel', '#7a2d1e', '#d9822b', 0.62),
          card('How jet engines actually work', 'Sample channel', '#1e3a5f', '#4fa3d1', 0.25),
        ] },
        { title: 'New from your channels', items: [
          card('Rebuilding a 1970s amplifier', 'Sample channel', '#3b2a4f', '#a46bd6'),
          card('A coastal ride by bike', 'Sample channel', '#1f4d3a', '#6cc49a'),
          card('Ten tips for 3D printing PETG', 'Sample channel', '#4a3a1a', '#e0b84c'),
        ] },
      ];
      case 'jellyfin': return [
        { title: 'Continue watching', items: [
          card('Your film', '2019', '#2b1f4f', '#7a5cff', 0.55),
          card('Your series', 'S1, E4: Episode title', '#1f3350', '#5b8def', 0.3),
        ] },
        { title: 'Next up', items: [card('Your series', 'S1, E5: Episode title', '#1f3350', '#5b8def', 0)] },
      ];
      default: return [];
    }
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function slug(s) { return String(s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app'; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } }
  function colourFor(seed) {
    let h = 0;
    for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 45% 32%)`;
  }

  API.hostOf = hostOf;
  window.LoungeAPI = API;
})();
