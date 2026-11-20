/*
 * Sheets for managing apps: the tile menu, Add App (on the TV or from your
 * phone), Edit App, and Settings.
 */
(function () {
  'use strict';

  const API = window.LoungeAPI;

  const URL_SUGGESTIONS = [
    'https://', 'https://www.', 'www.youtube.com', 'www.twitch.tv', 'open.spotify.com', 'www.dailymotion.com',
  ];

  function normaliseUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    try { return new URL(u).href; } catch (e) { return ''; }
  }

  function nameFromUrl(u) {
    const host = API.hostOf(u).split('.');
    let core = host.length > 2 && ['co', 'com', 'org', 'gov', 'ac'].includes(host[host.length - 2]) ? host[host.length - 3] : host[host.length - 2] || host[0];
    if (!core) return 'App';
    core = core.length <= 3 ? core.toUpperCase() : core.charAt(0).toUpperCase() + core.slice(1);
    let first = '';
    try { first = new URL(u).pathname.split('/').find(Boolean) || ''; } catch (e) { /* ignore */ }
    if (/^[A-Za-z][A-Za-z-]{2,20}$/.test(first)) core += ' ' + first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, ' ');
    return core; // example.co.uk/radio -> Example Radio
  }

  const AppSheets = {
    tileMenu(app) {
      Sheets.open({
        title: app.name,
        build: (body, sheet) => {
          body.append(
            Sheets.button('Open', () => { sheet.close(); App.open(app, null, true); }),
            Sheets.button('Move', () => { sheet.close(); App.startMoving(app.id); }),
            Sheets.button('Edit', () => { sheet.close(); AppSheets.edit(app); }),
            app.type === 'web' || !API.preview ? Sheets.button('Close app', async () => { sheet.close(); await API.closeApp(app.id); Toast.show(`${app.name} closed`); }) : null,
            Sheets.button('Remove from home screen', () => { sheet.close(); AppSheets.confirmRemove(app); }, { style: 'danger' }),
          );
        },
      });
    },

    cardMenu(app, item) {
      Sheets.open({
        title: item.title,
        subtitle: item.subtitle || app.name,
        build: (body, sheet) => {
          body.append(
            Sheets.button('Play', () => { sheet.close(); App.openItem(app, item); }),
            Sheets.button('Remove from Continue watching', async () => {
              sheet.close();
              await API.removeRecent(app.id, item.key);
              App.refreshShelf(app.id);
              Toast.show('Removed');
            }, { style: 'danger' }),
          );
        },
      });
    },

    async vpn() {
      let st = App.vpnState || {};
      try { st = await API.vpn(); App.setVpn(st); } catch (e) { /* show what we have */ }
      const remoteUrl = API.info && API.info.remoteUrl;
      Sheets.open({
        title: 'VPN',
        subtitle: 'Every app uses the VPN unless you turn Use VPN off for it (in Edit, or when adding it). It connects at start-up and reconnects if it drops.',
        wide: true,
        build: (body, sheet) => {
          const s = App.vpnState || st;
          const servers = s.servers || [];
          const exp = s.expires || {};
          const day = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          const warn = (s.expired || []).length ? 'Some servers have expired. Download new ones from your VPN provider and add them on the admin page.'
            : (s.expiringSoon || []).length ? 'Some servers expire soon. Download new ones from your VPN provider and add them on the admin page.' : null;
          const left = h('div', { class: 'form' },
            warn ? h('p', { class: 'vpn-warn' }, warn) : null,
            Sheets.button(s.connected ? 'Connected' : (s.wanted === false ? 'Turned off' : 'Not connected'),
              async () => {
                try {
                  App.setVpn(s.connected ? await API.vpnDisconnect() : await API.vpnConnect(s.lastServer && servers.includes(s.lastServer) ? s.lastServer : servers[0]));
                } catch (e) { Toast.show('VPN: ' + e.message, 4000); }
                sheet.rebuild();
              }, { value: s.connected ? serverName(s.server) + ' · turn off' : (servers.length ? 'Turn on' : 'Add a server first'), key: 'vpn:state' }),
            Sheets.toggle('Kill switch', s.killSwitch !== false, async (v) => {
              try { App.setVpn(await API.vpnKillSwitch(v)); } catch (e) { Toast.show(e.message); }
            }, { note: 'VPN apps go offline if the VPN drops' }),
            servers.length ? h('p', { class: 'sheet-sub' }, 'Servers (hold OK to remove one):') : null,
            ...servers.map((srv) => {
              const row = Sheets.button(serverName(srv), async () => {
                try { App.setVpn(await API.vpnConnect(srv)); Toast.show('Connected to ' + serverName(srv)); } catch (e) { Toast.show('VPN: ' + e.message, 4000); }
                sheet.rebuild();
              }, {
                value: s.connected && s.server === srv ? 'Connected'
                  : (s.expired || []).includes(srv) ? 'Expired'
                  : exp[srv] ? 'Renew by ' + day(exp[srv]) : '',
                key: 'vpnsrv:' + srv,
              });
              row._onMenu = async () => {
                try { App.setVpn(await API.vpnRemove(srv)); Toast.show('Removed ' + serverName(srv)); } catch (e) { Toast.show(e.message); }
                sheet.rebuild();
              };
              return row;
            }),
            Sheets.actions({ label: 'Done', onClick: () => sheet.close() }));
          const qrBox = h('div', { class: 'qr' });
          const info = API.info || {};
          drawQr(qrBox, (info.adminIpUrl || 'https://example.invalid/lounge-preview') + '#vpn');
          const side = h('div', { class: 'phone-add' },
            h('h3', null, 'Add servers from your computer'),
            h('p', null, 'Download WireGuard config files for a server or two from your VPN provider. Then open the admin page and pick the files.'),
            info.adminUrl ? h('p', { class: 'mono' }, info.adminUrl.replace(/^https?:\/\//, '') + '#vpn') : null,
            qrBox, h('p', { class: 'muted' }, 'Or scan it with a phone.'));
          body.append(h('div', { class: 'add-layout' }, left, side));
        },
      });
    },

    jellyfin() {
      const jf = App.settings.jellyfin || {};
      let server = jf.server || 'http://', username = jf.user || '', password = '';
      Sheets.open({
        title: 'Jellyfin',
        subtitle: jf.connected
          ? `Signed in as ${jf.user} on ${jf.server.replace(/^https?:\/\//, '')}. Continue watching and Next up show on the top shelf.`
          : 'Sign in once and your Continue watching and Next up show on the top shelf. Tip: type the password on the admin page (Type tab).',
        build: (body, sheet) => {
          if (jf.connected) {
            body.append(Sheets.actions(
              { label: 'Sign out', style: 'danger', onClick: async () => {
                await API.jellyfinLogout();
                App.settings = await API.getSettings();
                App.refreshShelf('jellyfin');
                sheet.close();
                Toast.show('Signed out of Jellyfin');
              } },
              { label: 'Done', onClick: () => sheet.close() },
            ));
            return;
          }
          body.append(
            Sheets.field('Server address', { value: server, placeholder: 'e.g. 192.168.1.20:8096', type: 'url', onChange: (v) => { server = v.trim(); } }),
            Sheets.field('Username', { value: username, onChange: (v) => { username = v.trim(); } }),
            Sheets.field('Password', { type: 'password', onChange: (v) => { password = v; } }),
            Sheets.actions(
              { label: 'Sign in', style: 'primary', onClick: async () => {
                if (!server || server === 'http://' || !username) { Toast.show('Fill in the server and username first'); return; }
                Toast.show('Signing in…');
                try {
                  await API.jellyfinLogin(server, username, password);
                  App.settings = await API.getSettings();
                  App.refreshShelf('jellyfin');
                  sheet.close();
                  Toast.show('Signed in to Jellyfin');
                } catch (e) { Toast.show(`Couldn't sign in: ${e.message}`, 4000); }
              } },
              { label: 'Cancel', onClick: () => sheet.close() },
            ),
          );
        },
      });
    },

    confirmRemove(app) {
      Sheets.open({
        title: `Remove ${app.name}?`,
        subtitle: app.type === 'native' ? 'The app stays installed. You can add it back by editing apps.json.' : 'You can add it back at any time.',
        build: (body, sheet) => {
          body.append(Sheets.actions(
            { label: 'Remove', style: 'danger', onClick: async () => {
              App.apps = App.apps.filter((a) => a.id !== app.id);
              await API.saveApps(App.apps);
              sheet.close();
              App.renderGrid();
              Toast.show(`${app.name} removed`);
            } },
            { label: 'Cancel', onClick: () => sheet.close() },
          ));
        },
      });
    },

    add() {
      let url = '', name = '', vpn = true, tvLayout = false;
      Sheets.open({
        title: 'Add App',
        subtitle: 'Any website can be an app. It opens full screen, just like the others.',
        wide: true,
        build: (body, sheet) => {
          const nameField = Sheets.field('Name', {
            placeholder: 'Uses the site name if left blank',
            onChange: (v) => { name = v.trim(); },
          });
          const urlField = Sheets.field('Web address', {
            placeholder: 'e.g. www.twitch.tv',
            type: 'url',
            suggestions: URL_SUGGESTIONS,
            onChange: (v) => {
              url = v.trim();
              if (!name && url) nameField.setValue(nameFromUrl(normaliseUrl(url)));
            },
          });
          const form = h('div', { class: 'form' },
            urlField,
            nameField,
            Sheets.toggle('Use VPN', vpn, (v) => { vpn = v; }, { note: 'On by default. Turn off for sites that block VPNs' }),
            Sheets.toggle('TV layout', tvLayout, (v) => { tvLayout = v; }, { note: 'Asks the site for its TV version, if it has one' }),
            Sheets.actions(
              { label: 'Add', style: 'primary', onClick: async () => {
                const full = normaliseUrl(url);
                if (!full) { Toast.show('Type a web address first'); return; }
                const finalName = (nameField.getValue() || '').trim() || nameFromUrl(full);
                try {
                  await API.addApp({ name: finalName, url: full, vpn, tvLayout });
                  sheet.close();
                  await App.reloadApps();
                  Toast.show(`${finalName} added`);
                } catch (e) { Toast.show(`Couldn't add it: ${e.message}`); }
              } },
              { label: 'Cancel', onClick: () => sheet.close() },
            ));

          const remoteUrl = API.info && API.info.remoteUrl;
          const qrBox = h('div', { class: 'qr' });
          const info = API.info || {};
          drawQr(qrBox, info.adminIpUrl ? info.adminIpUrl + '#add' : 'https://example.invalid/lounge-preview');
          const side = h('div', { class: 'phone-add' },
            h('h3', null, 'Or add it from your computer'),
            h('p', null, info.adminUrl
              ? 'Open the admin page, paste the address, and the app appears here.'
              : 'On the box, this opens the admin page. (Preview mode has no box to connect to.)'),
            info.adminUrl ? h('p', { class: 'mono' }, info.adminUrl.replace(/^https?:\/\//, '') + '#add') : null,
            qrBox, info.adminUrl ? h('p', { class: 'muted' }, 'Or scan it with a phone.') : null);
          body.append(h('div', { class: 'add-layout' }, form, side));
        },
      });
    },

    edit(app) {
      const draft = { ...app };
      Sheets.open({
        title: `Edit ${app.name}`,
        wide: false,
        build: (body, sheet) => {
          body.append(
            Sheets.field('Name', { value: draft.name, onChange: (v) => { draft.name = v.trim() || app.name; } }),
            app.type === 'web' ? Sheets.field('Web address', { value: draft.url, type: 'url', suggestions: URL_SUGGESTIONS, onChange: (v) => { draft.url = normaliseUrl(v) || app.url; } }) : null,
            Sheets.toggle('Use VPN', !!draft.vpn, (v) => { draft.vpn = v; }),
            app.type === 'web' ? Sheets.toggle('TV layout', !!draft.tvLayout, (v) => { draft.tvLayout = v; }) : null,
            Sheets.choice('Tile colour', COLOURS, draft.color, (v) => { draft.color = v; }),
            Sheets.actions(
              { label: 'Save', style: 'primary', onClick: async () => {
                const i = App.apps.findIndex((a) => a.id === app.id);
                if (i >= 0) App.apps[i] = draft;
                await API.saveApps(App.apps);
                sheet.close();
                App.renderGrid();
                Toast.show('Saved');
              } },
              { label: 'Cancel', onClick: () => sheet.close() },
            ),
          );
        },
      });
    },

    async softwareUpdate() {
      let info = {};
      try { info = await API.updateInfo(); } catch (e) { info = { error: e.message }; }
      Sheets.open({
        title: 'Software update',
        subtitle: 'Lounge checks for a new version once a day. Updates only replace Lounge itself: everyone\'s profiles, sign-ins, Continue watching, settings and VPN servers stay on the box.',
        build: (body, sheet) => {
          const busy = info.status && ['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(info.status.stage);
          body.append(Sheets.button('Installed', null, { value: info.installed || API.info.version }));
          if (info.error) body.append(h('p', { class: 'sheet-sub' }, "Couldn't check: " + info.error));
          if (busy) body.append(h('p', { class: 'vpn-warn' }, info.status.message));
          else if (info.status && info.status.stage === 'failed') body.append(h('p', { class: 'vpn-warn' }, info.status.message));
          if (info.available && !busy) {
            body.append(h('p', { class: 'sheet-sub' }, `Lounge ${info.version} is ready to install.`));
            if (info.notes) body.append(h('pre', { class: 'notes' }, info.notes.slice(0, 900)));
            body.append(Sheets.button(`Update to ${info.version}`, async () => {
              try { await API.updateApply(); Toast.show('Updating: the home screen restarts by itself when it\'s done', 6000); sheet.close(); }
              catch (e) { Toast.show(`Couldn't start the update: ${e.message}`, 5000); }
            }, { key: 'upd:go' }));
          } else if (!busy && !info.error) {
            body.append(h('p', { class: 'sheet-sub' }, 'Lounge is up to date.'));
          }
          body.append(Sheets.button('Check now', async () => {
            Toast.show('Checking…');
            try { info = { ...info, ...(await API.updateCheck()) }; sheet.rebuild(); } catch (e) { Toast.show(e.message, 4000); }
          }, { key: 'upd:check' }));
        },
      });
    },

    magnifier() {
      const s = { ...App.settings };
      const save = async () => { App.settings = await API.saveSettings(s); };
      Sheets.open({
        title: 'Magnifier',
        subtitle: 'A zoom window shaped like the TV that floats above the pointer, over any app. Turn it on and off with the zoom button on the remote, the admin page, or Control Centre. Scroll to zoom in and out; clicks go through to whatever is underneath.',
        build: (body) => body.append(
          Sheets.choice('Zoom', [1.5, 2, 2.5, 3, 4, 5].map((z) => ({ label: z + '×', value: z })), Number(s.magnifierZoom) || 3,
            (v) => { s.magnifierZoom = v; save(); }),
          Sheets.choice('Window size', [{ label: 'Medium', value: 'medium' }, { label: 'Large', value: 'large' }], s.magnifierSize || 'medium',
            (v) => { s.magnifierSize = v; save(); }),
          Sheets.button(App.magnifierOpen ? 'Turn magnifier off' : 'Try it now', async () => {
            Sheets.closeAll();
            try { await API.magnifier(); } catch (e) { Toast.show(`Couldn't start the magnifier: ${e.message}`, 4000); }
          }),
        ),
      });
    },

    profiles() {
      Sheets.open({
        title: 'Profiles',
        subtitle: 'Each person has their own sign-ins in every app, their own Continue watching, display size, pointer and magnifier. Switch person from Control Centre or the picture at the top right.',
        build: (body, sheet) => {
          const p = App.profiles || { users: [] };
          (p.users || []).forEach((u) => body.append(Sheets.button(u.name, () => this.editProfile(u, sheet), {
            value: u.id === p.current ? 'In use' : '', chevron: true, key: 'prof:' + u.id,
          })));
          if ((p.users || []).length < 8) body.append(Sheets.button('Add a person', () => this.addProfile(sheet), { key: 'prof:+' }));
        },
      });
    },

    addProfile(parent) {
      Focus.keyboard.open({
        title: 'Name',
        placeholder: 'e.g. Sam',
        onDone: async (name) => {
          if (!name || !name.trim()) return;
          try {
            App.profiles = await API.profileAction('add', { name: name.trim() });
            App.renderAvatar();
            const made = App.profiles.users[App.profiles.users.length - 1];
            if (parent && parent.rebuild) parent.rebuild();
            ControlCentre.update();
            Sheets.open({
              title: `Switch to ${made.name} now?`,
              subtitle: `${made.name} starts with a fresh Continue watching and signs in to each app the first time it's opened.`,
              build: (body, sheet) => body.append(Sheets.actions(
                { label: 'Switch', style: 'primary', onClick: () => { Sheets.closeAll(); ControlCentre.close(); App.switchProfile(made.id); } },
                { label: 'Not now', onClick: () => sheet.close() },
              )),
            });
          } catch (e) { Toast.show(`Couldn't add: ${e.message}`, 4000); }
        },
      });
    },

    editProfile(u, parent) {
      const COLOURS = [['Orange', '#ff9f0a'], ['Green', '#30d158'], ['Blue', '#0a84ff'], ['Purple', '#bf5af2'],
        ['Pink', '#ff375f'], ['Sky', '#64d2ff'], ['Yellow', '#ffd60a'], ['Brown', '#ac8e68']];
      const refresh = (p) => { App.profiles = p; App.renderAvatar(); ControlCentre.update(); if (parent) parent.rebuild(); };
      Sheets.open({
        title: u.name,
        build: (body, sheet) => {
          body.append(
            Sheets.field('Name', { value: u.name, onChange: async (v) => {
              if (!v.trim()) return;
              try { refresh(await API.profileAction('update', { id: u.id, name: v.trim() })); u.name = v.trim(); } catch (e) { Toast.show(e.message, 4000); }
            } }),
            Sheets.choice('Colour', COLOURS.map(([label, value]) => ({ label, value })), u.colour, async (v) => {
              try { refresh(await API.profileAction('update', { id: u.id, colour: v })); u.colour = v; } catch (e) { Toast.show(e.message, 4000); }
            }),
          );
          if (u.id !== App.profiles.current) {
            body.append(Sheets.button(`Switch to ${u.name}`, () => { Sheets.closeAll(); App.switchProfile(u.id); }));
            body.append(Sheets.button(`Remove ${u.name}`, () => Sheets.open({
              title: `Remove ${u.name}?`,
              subtitle: `This deletes ${u.name}'s sign-ins, Continue watching and settings on this box.`,
              build: (b2, s2) => b2.append(Sheets.actions(
                { label: 'Remove', style: 'danger', onClick: async () => {
                  try { refresh(await API.profileAction('remove', { id: u.id })); s2.close(); sheet.close(); Toast.show(`${u.name} removed`); } catch (e) { Toast.show(e.message, 4000); }
                } },
                { label: 'Cancel', onClick: () => s2.close() },
              )),
            }), { style: 'danger' }));
          }
        },
      });
    },

    settings() {
      const s = { ...App.settings };
      const save = async () => {
        App.settings = await API.saveSettings(s);
        Focus.keyboard.setLayout(App.settings.keyboardLayout);
        Screensaver.wake();
      };
      Sheets.open({
        title: 'Settings',
        build: (body) => {
          body.append(
            Sheets.choice('Display size', [{ label: 'Standard', value: 'standard' }, { label: 'Large', value: 'large' }, { label: 'Extra large', value: 'xlarge' }],
              s.displaySize || 'standard', (v) => { s.displaySize = v; App.setSize(v); }),
            Sheets.toggle('Air mouse pointer', s.airPointer !== false, async (v) => { s.airPointer = v; try { await API.setPointer(v); } catch (e) { /* box will say */ } }),
            Sheets.choice('Pointer size', [{ label: 'Standard', value: 'standard' }, { label: 'Large', value: 'large' }, { label: 'Extra large', value: 'xlarge' }],
              s.pointerSize || 'large', (v) => { s.pointerSize = v; Pointer.setSize(v); save(); }),
            Sheets.choice('App names', [{ label: 'Always shown', value: 'always' }, { label: 'When selected', value: 'focus' }],
              s.appNames || 'always', (v) => { s.appNames = v; App.settings.appNames = v; App.applyNames(); save(); }),
            Sheets.button('Magnifier', () => AppSheets.magnifier(), { value: (s.magnifierZoom || 3) + '×', chevron: true }),
            Sheets.button('Profiles', () => AppSheets.profiles(), { value: ((App.me() || {}).name) || '', chevron: true }),
            Sheets.choice('Keyboard', [{ label: 'QWERTY', value: 'qwerty' }, { label: 'Alphabetical', value: 'abc' }], s.keyboardLayout, (v) => { s.keyboardLayout = v; save(); }),
            Sheets.toggle('24-hour clock', !!s.clock24, (v) => { s.clock24 = v; save(); }),
            Sheets.choice('Screensaver', [
              { label: 'Off', value: 0 }, { label: 'After 2 minutes', value: 2 }, { label: 'After 5 minutes', value: 5 },
              { label: 'After 10 minutes', value: 10 }, { label: 'After 15 minutes', value: 15 },
            ], Number(s.screensaverMinutes), (v) => { s.screensaverMinutes = v; save(); }),
            Sheets.choice('Screensaver style', [
              { label: 'Bouncing logo', value: 'logo' }, { label: 'Black', value: 'black' }, { label: 'Your photos', value: 'photos' },
            ], s.screensaverStyle || 'logo', (v) => { s.screensaverStyle = v; App.settings.screensaverStyle = v; save(); }),
            Sheets.toggle('Change colour on each bounce', !!s.screensaverBounceColours,
              (v) => { s.screensaverBounceColours = v; App.settings.screensaverBounceColours = v; save(); }),
            Sheets.choice('Screen off when idle', [
              { label: 'After 5 minutes', value: 5 }, { label: 'After 10 minutes', value: 10 }, { label: 'After 15 minutes', value: 15 },
              { label: 'After 30 minutes', value: 30 }, { label: 'After 1 hour', value: 60 }, { label: 'Never', value: 0 },
            ], s.screenOffMinutes == null ? 15 : Number(s.screenOffMinutes), (v) => { s.screenOffMinutes = v; save(); }),
            Sheets.button('YouTube channels', () => AppSheets.channels(), { value: String((s.youtubeChannels || []).length), chevron: true }),
            Sheets.button('VPN', () => AppSheets.vpn(), { value: App.vpnState && App.vpnState.connected ? 'On' : 'Off', chevron: true }),
            Sheets.button('Jellyfin', () => AppSheets.jellyfin(), { value: (s.jellyfin || {}).connected ? 'Signed in' : 'Not set up', chevron: true }),
            Sheets.button('Admin page', () => AppSheets.phoneRemote(), { chevron: true }),
            Sheets.button('Software update', () => AppSheets.softwareUpdate(), { value: App.updateInfo && App.updateInfo.available ? 'Update ready' : '', chevron: true }),
            Sheets.button('About', () => AppSheets.about(), { chevron: true }),
            h('div', { class: 'sheet-foot' }, h('img', { src: '../brand/jw-mark-small.svg', alt: 'jwilss' }),
              h('span', {}, (API.info && API.info.version) || '')),
          );
        },
      });
    },

    channels() {
      Sheets.open({
        title: 'YouTube channels',
        subtitle: 'New videos from these channels show on the top shelf when YouTube is selected.',
        build: (body, sheet) => {
          const list = App.settings.youtubeChannels || [];
          body.append(Sheets.field('Add a channel', {
            placeholder: '@handle or channel ID',
            onChange: async (v) => {
              v = v.trim();
              if (!v) return;
              try {
                const ch = await API.resolveChannel(v);
                const s = { ...App.settings, youtubeChannels: [...list.filter((c) => c.id !== ch.id), ch] };
                App.settings = await API.saveSettings(s);
                App.shelfCache.delete('youtube');
                sheet.rebuild();
                Toast.show(`Added ${ch.title}`);
              } catch (e) { Toast.show(`Couldn't find that channel`); }
            },
          }));
          list.forEach((ch) => body.append(Sheets.button(ch.title || ch.id, async () => {
            const s = { ...App.settings, youtubeChannels: list.filter((c) => c.id !== ch.id) };
            App.settings = await API.saveSettings(s);
            App.shelfCache.delete('youtube');
            sheet.rebuild();
            Toast.show(`Removed ${ch.title || ch.id}`);
          }, { value: 'Remove', key: 'ch:' + ch.id })));
        },
      });
    },

    // Lounge's own YouTube page: "Open YouTube", then a row of newest videos per favourite channel
    youtube(app) {
      Sheets.open({
        page: true,
        title: app.name,
        build: (body, sheet) => {
          const openBtn = h('button', { class: 'row focusable yt-open', type: 'button', dataset: { key: 'yt:open' } },
            h('span', { class: 'row-label' }, 'Open YouTube'), h('span', { class: 'row-note' }, 'Search and everything else'));
          openBtn.addEventListener('click', () => { sheet.close(); App.open(app, null, true); });
          const rows = h('div', { class: 'yt-rows' }, h('p', { class: 'sheet-sub' }, 'Loading your channels…'));
          body.append(openBtn, rows);
          API.youtubePage().then((page) => {
            if (sheet.closed) return;
            rows.textContent = '';
            const channels = (page && page.channels) || [];
            if (!channels.length) {
              rows.append(h('p', { class: 'sheet-sub' }, 'Add your favourite channels in Settings > YouTube channels, and their newest videos show here, one row each.'));
            }
            channels.forEach((ch, ci) => {
              const cards = (ch.videos || []).map((v, vi) => {
                const card = h('div', { class: 'card focusable', role: 'button', dataset: { key: `yt:${ch.id}:${vi}` } },
                  h('div', { class: 'card-img', style: v.thumbnail ? { backgroundImage: `url("${v.thumbnail}")` } : { backgroundImage: v.gradient || '' } }),
                  h('div', { class: 'card-label' }, h('span', { class: 'card-title' }, v.title)));
                card.addEventListener('click', () => { sheet.close(); App.openItem(app, { title: v.title, url: v.url, sample: v.sample }); });
                return card;
              });
              rows.append(h('section', { class: 'yt-row', dataset: { group: 'yt-row-' + ci } },
                h('h3', { class: 'yt-channel' }, ch.title),
                cards.length ? h('div', { class: 'yt-cards' }, ...cards)
                  : h('p', { class: 'sheet-sub' }, ch.error ? "Couldn't load this channel just now." : 'No videos yet.')));
            });
            Focus.refresh();
          });
        },
      });
    },

    phoneRemote() {
      // the admin page (VPN servers, adding apps, typing, a touch remote), opened from a computer
      const i = API.info || {};
      const url = i.adminUrl;
      Sheets.open({
        title: 'Admin page',
        subtitle: url ? 'On your computer, open this address (bookmark it). It adds VPN servers and apps, and types into the TV.'
          : 'Available on the box. Preview mode has nothing to connect to.',
        build: (body, sheet) => {
          const bare = (u) => u.replace(/^https?:\/\//, '');
          const qrBox = h('div', { class: 'qr' });
          drawQr(qrBox, url || 'https://example.invalid/lounge-preview');
          body.append(h('div', { class: 'center' },
            url ? h('p', { class: 'mono admin-url' }, bare(url)) : null,
            i.adminIpUrl && i.adminIpUrl !== url && !i.vm ? h('p', { class: 'muted' }, 'If that name doesn’t open: ' + bare(i.adminIpUrl)) : null,
            qrBox, url ? h('p', { class: 'muted' }, 'Or scan it with a phone.') : null),
          Sheets.actions({ label: 'Done', onClick: () => sheet.close() }));
        },
      });
    },

    about() {
      const i = API.info || {};
      Sheets.open({
        title: 'About Lounge',
        build: (body, sheet) => {
          body.append(
            Sheets.button('Version', null, { value: i.version || '0.1.0' }),
            Sheets.button('Mode', null, { value: API.preview ? 'Preview (no box)' : 'Box' }),
            i.hostname ? Sheets.button('Name', null, { value: i.hostname }) : null,
            i.address ? Sheets.button('Address', null, { value: i.address }) : null,
            Sheets.actions({ label: 'Done', onClick: () => sheet.close() }),
          );
        },
      });
    },
  };

  const COLOURS = [
    { label: 'Red', value: '#d92b2b' }, { label: 'Pink', value: '#e6007e' }, { label: 'Purple', value: '#6a3fb5' },
    { label: 'Blue', value: '#2d5fd3' }, { label: 'Teal', value: '#11807a' }, { label: 'Green', value: '#2f8f3a' },
    { label: 'Orange', value: '#d9731a' }, { label: 'Graphite', value: '#3a3a40' }, { label: 'Black', value: '#1a1a1a' },
  ];

  function drawQr(box, text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) {
      box.textContent = 'QR unavailable';
    }
  }

  window.AppSheets = AppSheets;
})();
