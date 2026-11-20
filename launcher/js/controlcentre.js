/*
 * Control Centre: slides in from the right when you press Home on the home
 * screen (or the Menu button). VPN, volume, closing apps, sleep and power.
 */
(function () {
  'use strict';

  const API = window.LoungeAPI;

  const ControlCentre = {
    sheet: null,

    toggle() { this.sheet ? this.close() : this.open(); },

    people(sheet) {
      const p = App.profiles || { users: [] };
      const row = h('div', { class: 'cc-people', 'data-group': 'people' });
      (p.users || []).forEach((u) => {
        const btn = h('button', { class: 'person focusable' + (u.id === p.current ? ' is-me' : ''), type: 'button', dataset: { key: 'cc:p:' + u.id } },
          h('span', { class: 'person-face', style: { '--av': u.colour } }, initials(u.name)),
          h('span', { class: 'person-name' }, u.name));
        btn.addEventListener('click', async () => {
          if (u.id === p.current) { Toast.show(`You're ${u.name}`); return; }
          sheet.close();
          await App.switchProfile(u.id);
        });
        row.append(btn);
      });
      if ((p.users || []).length < 8) {
        const add = h('button', { class: 'person person-add focusable', type: 'button', dataset: { key: 'cc:p:+' } },
          h('span', { class: 'person-face' }, '+'), h('span', { class: 'person-name' }, 'Add'));
        add.addEventListener('click', () => AppSheets.addProfile());
        row.append(add);
      }
      return row;
    },

    close() { if (this.sheet) this.sheet.close(); },

    async open(focusOn) {
      if (this.sheet) return;
      let vpn = App.vpnState || { connected: false, servers: [] };
      let vol = { level: 40, muted: false };
      try { [vpn, vol, App.sleepTimer] = await Promise.all([API.vpn(), API.volume(), API.sleepTimer()]); } catch (e) { /* show what we have */ }
      App.vpnState = vpn;

      this.sheet = Sheets.open({
        side: true,
        onClose: () => { this.sheet = null; this.showVolume = null; this.paintSleep = null; },
        initial: focusOn === 'profiles'
          ? (root) => root.querySelector('.person.is-me') || root.querySelector('.person')
          : (root) => root.querySelector('[data-key="cc:size"]'),
        build: (body, sheet) => {
          const now = new Date();
          body.append(h('div', { class: 'cc-head' },
            h('div', { class: 'cc-time' }, now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: !App.settings.clock24 })),
            h('div', { class: 'cc-date' }, now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))));
          body.append(this.people(sheet));

          // display size, first so it's always easy to reach
          const sizeVal = h('span', { class: 'row-value' }, App.sizeLabel());
          const sizeRow = h('button', { class: 'row focusable', type: 'button', dataset: { key: 'cc:size' } },
            h('span', { class: 'row-icon size-icon' }, 'Aa'), h('span', { class: 'row-label' }, 'Display size'),
            h('span', { class: 'row-arrows' }, '‹'), sizeVal, h('span', { class: 'row-arrows' }, '›'));
          sizeRow._onMove = (dir) => {
            if (dir === 'left') { App.cycleSize(-1); sizeVal.textContent = App.sizeLabel(); return true; }
            if (dir === 'right') { App.cycleSize(1); sizeVal.textContent = App.sizeLabel(); return true; }
            return false;
          };
          sizeRow.addEventListener('click', () => {
            const order = ['standard', 'large', 'xlarge'];
            App.setSize(order[(order.indexOf(App.settings.displaySize || 'standard') + 1) % 3]);
            sizeVal.textContent = App.sizeLabel();
          });
          body.append(sizeRow);

          // magnifier: a TV-shaped zoom window that follows the pointer, over any app
          const mag = h('button', { class: 'row focusable', type: 'button', dataset: { key: 'cc:mag' } },
            h('span', { class: 'row-icon mag-icon' }), h('span', { class: 'row-label' }, 'Magnifier'),
            h('span', { class: 'row-note' }, App.magnifierOpen ? 'On' : 'Zoom button'),
            h('span', { class: 'switch' + (App.magnifierOpen ? ' on' : '') }));
          mag.addEventListener('click', async () => {
            const turningOn = !App.magnifierOpen;
            try { await API.magnifier(); } catch (e) { Toast.show(`Couldn't start the magnifier: ${e.message}`, 4000); return; }
            if (turningOn) { sheet.close(); Toast.show('Magnifier on: point at what you want to read', 3500); }
          });
          body.append(mag);

          // air mouse pointer on/off (off: arrows and OK only, nothing drifts about)
          const ptrOn = App.settings.airPointer !== false;
          body.append(Sheets.toggle('Air mouse pointer', ptrOn, async (v) => {
            try { await API.setPointer(v); } catch (e) { Toast.show(e.message, 4000); }
          }, { key: 'cc:pointer', note: 'Pointer button' }));

          // VPN card
          const v = App.vpnState || vpn;
          const vpnCard = h('button', { class: 'cc-card focusable' + (v.connected ? ' on' : ''), type: 'button', dataset: { key: 'cc:vpn' } },
            h('span', { class: 'cc-card-icon shield' + (v.connected ? ' on' : '') }),
            h('span', { class: 'cc-card-text' },
              h('span', { class: 'cc-card-title' }, 'VPN'),
              (v.expired || []).length || (v.expiringSoon || []).length
                ? h('span', { class: 'cc-card-sub warn' }, (v.expired || []).length ? 'Servers expired: renew in Settings > VPN' : 'Servers expire soon: renew in Settings > VPN')
                : null,
              h('span', { class: 'cc-card-sub' }, v.connected ? 'Connected · ' + serverName(v.server)
                : !(v.servers && v.servers.length) ? 'No servers yet (Settings > VPN)'
                : v.wanted === false ? 'Off' : 'Connecting…')),
            h('span', { class: 'row-chev' }, '›'));
          vpnCard.addEventListener('click', async () => {
            if (!v.servers || !v.servers.length) { sheet.close(); AppSheets.vpn(); return; }
            if (v.connected) {
              Toast.show('VPN off until you turn it back on');
              App.setVpn(await API.vpnDisconnect());
            } else {
              const server = v.lastServer && v.servers.includes(v.lastServer) ? v.lastServer : v.servers[0];
              Toast.show('Connecting to ' + serverName(server));
              try { App.setVpn(await API.vpnConnect(server)); } catch (e) { Toast.show('VPN failed: ' + e.message, 4000); }
            }
            sheet.rebuild();
          });
          vpnCard._onMove = (dir) => { if (dir === 'right') { this.servers(); return true; } return false; };
          body.append(vpnCard);
          if (v.servers && v.servers.length) body.append(Sheets.button('Choose server', () => this.servers(), { value: v.connected ? serverName(v.server) : '', chevron: true, key: 'cc:servers' }));

          // volume slider
          const fill = h('span', { class: 'slider-fill' });
          const label = h('span', { class: 'row-value' });
          const slider = h('button', { class: 'row slider-row focusable', type: 'button', dataset: { key: 'cc:volume' } },
            h('span', { class: 'row-label' }, 'Volume'), h('span', { class: 'slider' }, fill), label);
          const paint = () => {
            fill.style.width = (vol.muted ? 0 : vol.level) + '%';
            label.textContent = vol.muted ? 'Muted' : vol.level + '%';
          };
          const set = async (level, muted) => {
            vol = { level: Math.max(0, Math.min(100, level)), muted };
            paint();
            clearTimeout(slider._t);
            slider._pending = true;
            slider._t = setTimeout(async () => {
              try { vol = await API.setVolume(vol.level, vol.muted); paint(); } catch (e) { /* keep local */ }
              slider._pending = false;
            }, 120);
          };
          slider._onMove = (dir) => {
            if (dir === 'left') { set(vol.level - 5, false); return true; }
            if (dir === 'right') { set(vol.level + 5, false); return true; }
            return false;
          };
          slider.addEventListener('click', () => set(vol.level, !vol.muted));
          // the remote's volume buttons change it behind our back; lounged tells us (App.onEvent)
          this.showVolume = (v) => { if (!slider._pending) { vol = v; paint(); } };
          paint();
          body.append(slider);

          // sleep timer: Off, 30, 60, 90 minutes; a minute's warning comes up over any app first
          const STEPS = [0, 30, 60, 90];
          const sleepVal = h('span', { class: 'row-value' });
          const paintSleep = () => {
            const t = App.sleepTimer || {};
            sleepVal.textContent = t.at ? 'Sleeps at ' + new Date(t.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: !App.settings.clock24 }) : 'Off';
          };
          const setSleep = async (step) => {
            const cur = STEPS.indexOf((App.sleepTimer || {}).minutes || 0);
            const next = STEPS[Math.max(0, Math.min(STEPS.length - 1, (cur < 0 ? 0 : cur) + step))];
            try { App.sleepTimer = await API.setSleepTimer(next); } catch (e) { Toast.show(e.message, 4000); }
            paintSleep();
            Toast.show(next ? `Going to sleep in ${next} minutes` : 'Sleep timer off');
          };
          const sleepRow = h('button', { class: 'row focusable', type: 'button', dataset: { key: 'cc:sleeptimer' } },
            h('span', { class: 'row-label' }, 'Sleep timer'),
            h('span', { class: 'row-arrows' }, '‹'), sleepVal, h('span', { class: 'row-arrows' }, '›'));
          sleepRow._onMove = (dir) => {
            if (dir === 'left') { setSleep(-1); return true; }
            if (dir === 'right') { setSleep(1); return true; }
            return false;
          };
          sleepRow.addEventListener('click', () => {
            const cur = STEPS.indexOf((App.sleepTimer || {}).minutes || 0);
            setSleep(cur >= STEPS.length - 1 ? -(STEPS.length - 1) : 1); // OK steps on, then back to Off
          });
          paintSleep();
          this.paintSleep = paintSleep;
          body.append(sleepRow);

          body.append(
            Sheets.button('Close all apps', async () => { await API.closeAll(); Toast.show('All apps closed'); }, { key: 'cc:closeall' }),
            Sheets.button('Settings', () => { sheet.close(); AppSheets.settings(); }, { chevron: true, key: 'cc:settings' }),
            h('div', { class: 'cc-sep' }),
            Sheets.button('Sleep', () => this.power('sleep'), { key: 'cc:sleep' }),
            Sheets.button('Restart', () => this.confirmPower('restart'), { key: 'cc:restart' }),
            Sheets.button('Turn off', () => this.confirmPower('poweroff'), { key: 'cc:off' }),
          );
          if (API.preview) body.append(h('p', { class: 'cc-note' }, 'Preview mode: these controls are simulated.'));
        },
      });
    },

    update() {
      if (this.sheet) this.sheet.rebuild();
    },

    servers() {
      const v = App.vpnState || { servers: [] };
      Sheets.open({
        title: 'Choose server',
        side: true,
        build: (body, sheet) => {
          (v.servers || []).forEach((s) => body.append(Sheets.button(serverName(s), async () => {
            Toast.show('Connecting to ' + serverName(s));
            try { App.setVpn(await API.vpnConnect(s)); } catch (e) { Toast.show('VPN failed: ' + e.message, 4000); }
            sheet.close();
          }, { value: v.connected && v.server === s ? 'Connected' : '', key: 'srv:' + s })));
          if (!(v.servers || []).length) body.append(h('p', { class: 'cc-note' }, 'No WireGuard configs found on the box yet.'));
        },
      });
    },

    confirmPower(action) {
      const word = action === 'restart' ? 'Restart' : 'Turn off';
      Sheets.open({
        title: `${word} the box?`,
        build: (body, sheet) => body.append(Sheets.actions(
          { label: word, style: 'danger', onClick: () => { sheet.close(); this.power(action); } },
          { label: 'Cancel', onClick: () => sheet.close() },
        )),
      });
    },

    async power(action) {
      this.close();
      Toast.show(API.preview ? `Preview: would ${action === 'poweroff' ? 'turn off' : action}` : { sleep: 'Going to sleep', restart: 'Restarting', poweroff: 'Turning off' }[action]);
      try { await API.power(action); } catch (e) { Toast.show(`Couldn't ${action}: ${e.message}`); }
    },
  };

  window.ControlCentre = ControlCentre;
})();
