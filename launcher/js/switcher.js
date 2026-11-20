/*
 * App switcher: press Home twice. A row of big cards, one per open app, each showing
 * what the app looked like when you left it. OK (or click) jumps back in; Up flicks
 * the card away and closes that app; Back or Home returns to the home screen.
 */
(function () {
  'use strict';

  const API = window.LoungeAPI;

  const Switcher = {
    root: null,
    open: false,

    async show(running) {
      this.root = document.getElementById('switcher');
      if (this.open) { this.hide(); return; }
      Sheets.closeAll();
      if (ControlCentre.sheet) ControlCentre.close();
      const ids = running || (await API.running().catch(() => []));
      const apps = ids.map((id) => App.apps.find((a) => a.id === id)).filter(Boolean);
      const track = this.root.querySelector('.sw-track');
      track.textContent = '';
      this.root.querySelector('.sw-empty').hidden = apps.length > 0;
      for (const app of apps) track.appendChild(await this.card(app));

      this.open = true;
      this.root.hidden = false;
      requestAnimationFrame(() => this.root.classList.add('open'));
      Focus.push(this.root, {
        onBack: () => this.hide(),
        onMenu: () => this.hide(),
        initial: track.firstElementChild,
      });
      if (!apps.length) setTimeout(() => { if (this.open && !track.children.length) this.hide(); }, 1800);
      this.center();
    },

    async card(app) {
      const shot = h('div', { class: 'sw-shot', style: { background: app.color || '#333' } });
      const url = await API.snapshotUrl(app.id);
      if (url) {
        const img = new Image();
        img.onload = () => { shot.style.backgroundImage = `url("${url}")`; shot.classList.add('has-shot'); };
        img.src = url;
      }
      if (!url) shot.appendChild(h('span', { class: 'sw-shot-name' }, app.name));
      const head = h('div', { class: 'sw-head' },
        h('span', { class: 'sw-icon', style: { background: app.color || '#3a3a40' } },
          app.logo ? h('img', { src: app.logo, alt: '', onerror: (e) => e.target.remove() }) : null),
        h('span', { class: 'sw-name' }, app.name));
      const card = h('div', { class: 'sw-card focusable', dataset: { key: 'sw:' + app.id }, role: 'button' }, head, shot);
      card.addEventListener('click', () => this.launch(app));
      card.addEventListener('focused', () => this.center());
      card._onMove = (dir) => {
        if (dir === 'up') { this.closeApp(app, card); return true; }
        return false;
      };
      card._onMenu = () => this.closeApp(app, card);
      return card;
    },

    center() {
      const track = this.root.querySelector('.sw-track');
      const cur = Focus.current && track.contains(Focus.current) ? Focus.current : track.firstElementChild;
      if (!cur) return;
      const mid = cur.offsetLeft + cur.offsetWidth / 2;
      track.style.transform = `translateX(${window.innerWidth / 2 - mid}px)`;
    },

    async launch(app) {
      this.hide(true);
      try { await API.launch(app); } catch (e) { Toast.show(`Couldn't open ${app.name}: ${e.message}`, 4000); }
    },

    async closeApp(app, card) {
      card.classList.add('flick');
      try { await API.closeApp(app.id); } catch (e) { /* it may already be closed */ }
      setTimeout(() => {
        const next = card.nextElementSibling || card.previousElementSibling;
        card.remove();
        if (next) Focus.set(next);
        else this.hide();
        this.center();
        if (next) Toast.show(`${app.name} closed`);
      }, 320);
    },

    hide(quick) {
      if (!this.open) return;
      this.open = false;
      this.root.classList.remove('open');
      Focus.pop(this.root);
      setTimeout(() => { if (!this.open) this.root.hidden = true; }, quick ? 150 : 350);
    },
  };

  window.Switcher = Switcher;
})();
