/*
 * Focus engine: moves a highlight between on-screen items with the arrow keys,
 * the way a TV box does. Works in layers (home, sheets, Control Centre), so
 * only the top layer receives the remote.
 *
 *  - Any element with class "focusable" can be selected.
 *  - Containers with data-group="name" remember the last item you were on,
 *    so coming back to a row lands where you left it.
 *  - Moving the air mouse pointer over an item selects it too.
 */
(function () {
  'use strict';

  const DIRS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  };
  const BACK_KEYS = new Set(['Escape', 'BrowserBack', 'GoBack', 'Backspace']);
  const MENU_KEYS = new Set(['ContextMenu', 'm', 'M']);
  const LONG_PRESS_MS = 650;

  const Focus = {
    layers: [],
    current: null,
    keyboard: null, // LoungeKeyboard instance, gets keys first while open
    onAnyKey: null, // screensaver hook

    init() {
      document.addEventListener('keydown', (e) => this._keydown(e), true);
      document.addEventListener('keyup', (e) => this._keyup(e), true);
      document.addEventListener('mouseover', (e) => {
        const f = e.target.closest && e.target.closest('.focusable');
        if (f && this._inTopLayer(f) && f !== this.current) this.set(f, { fromPointer: true });
      });
    },

    /** Add a layer. opts: { onBack, onMenu, initial } */
    push(root, opts = {}) {
      if (this.current) {
        const top = this.layers[this.layers.length - 1];
        if (top) top.last = this.current;
      }
      this.layers.push({ root, ...opts });
      const first = opts.initial || this.firstIn(root);
      if (first) this.set(first);
      return root;
    },

    pop(root) {
      const i = root ? this.layers.findIndex((l) => l.root === root) : this.layers.length - 1;
      if (i < 0) return;
      this.layers.splice(i);
      const top = this.layers[this.layers.length - 1];
      if (top) {
        const back = top.last && document.contains(top.last) && visible(top.last) ? top.last : this.firstIn(top.root);
        if (back) this.set(back);
      }
    },

    top() { return this.layers[this.layers.length - 1]; },
    _inTopLayer(el) { const t = this.top(); return t && t.root.contains(el); },

    firstIn(root) {
      return [...root.querySelectorAll('.focusable')].find(visible) || null;
    },

    set(el, opts = {}) {
      if (!el) return;
      if (this.current && this.current !== el) {
        this.current.classList.remove('is-focused');
        this.current.dispatchEvent(new CustomEvent('blurred'));
      }
      this.current = el;
      el.classList.add('is-focused');
      const group = el.closest('[data-group]');
      if (group) group._last = el;
      const sheet = el.closest('.sheet');
      if (sheet) {
        // on the last row, bring the sheet's footer (maker's mark and version) into view too
        const foot = sheet.querySelector('.sheet-foot');
        const rows = sheet.querySelectorAll('.focusable');
        (foot && el === rows[rows.length - 1] ? foot : el).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      el.dispatchEvent(new CustomEvent('focused', { detail: opts }));
      document.dispatchEvent(new CustomEvent('focuschanged', { detail: { el, ...opts } }));
    },

    refresh() {
      // after a re-render, re-attach to an equivalent element if the old one vanished
      if (this.current && document.contains(this.current) && visible(this.current)) return;
      const t = this.top();
      if (!t) return;
      const key = this.current && this.current.dataset.key;
      const same = key && t.root.querySelector(`.focusable[data-key="${CSS.escape(key)}"]`);
      this.set(same || this.firstIn(t.root));
    },

    move(dir) {
      const t = this.top();
      if (!t) return false;
      const cur = this.current && t.root.contains(this.current) ? this.current : null;
      if (!cur) { this.set(this.firstIn(t.root)); return true; }
      if (cur._onMove && cur._onMove(dir) === true) return true; // e.g. volume slider, move mode

      const a = cur.getBoundingClientRect();
      const ca = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
      let best = null, bestScore = Infinity;
      for (const el of t.root.querySelectorAll('.focusable')) {
        if (el === cur || !visible(el)) continue;
        const b = el.getBoundingClientRect();
        const cb = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        let primary, perp;
        if (dir === 'right') { if (cb.x <= ca.x + 1 || b.right <= a.right - a.width * 0.25) continue; primary = Math.max(0, b.left - a.right); perp = Math.abs(cb.y - ca.y); }
        if (dir === 'left') { if (cb.x >= ca.x - 1 || b.left >= a.left + a.width * 0.25) continue; primary = Math.max(0, a.left - b.right); perp = Math.abs(cb.y - ca.y); }
        if (dir === 'down') { if (cb.y <= ca.y + 1 || b.bottom <= a.bottom - a.height * 0.25) continue; primary = Math.max(0, b.top - a.bottom); perp = Math.abs(cb.x - ca.x); }
        if (dir === 'up') { if (cb.y >= ca.y - 1 || b.top >= a.top + a.height * 0.25) continue; primary = Math.max(0, a.top - b.bottom); perp = Math.abs(cb.x - ca.x); }
        const score = primary + perp * 2.2;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (!best) return false;
      // entering a different group: go back to where we were in that group
      const g = best.closest('[data-group]');
      const curG = cur.closest('[data-group]');
      if (g && g !== curG && g.hasAttribute('data-remember') && g._last && g.contains(g._last) && visible(g._last)) best = g._last;
      this.set(best, { dir });
      return true;
    },

    _keydown(e) {
      if (this.onAnyKey && this.onAnyKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (this.keyboard && this.keyboard.isOpen) {
        if (this.keyboard.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      const t = this.top();
      if (!t) return;
      if (DIRS[e.key]) {
        e.preventDefault();
        this.move(DIRS[e.key]);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        // long-press OK opens the item's menu (like holding the touch surface on Apple TV)
        const el = this.current;
        if (el && el._onMenu) {
          clearTimeout(this._lp);
          this._lpFired = false;
          this._lp = setTimeout(() => { this._lpFired = true; el._onMenu(); }, LONG_PRESS_MS);
        } else {
          this._activate();
        }
        return;
      }
      if (MENU_KEYS.has(e.key)) {
        if (this.current && this.current._onMenu) { e.preventDefault(); this.current._onMenu(); }
        else if (t.onMenu) { e.preventDefault(); t.onMenu(); }
        return;
      }
      if (e.key === 'Home' || e.key === 'BrowserHome') {
        // on the box Sway catches the remote's Home button; this covers a PC keyboard in preview
        e.preventDefault();
        if (this.onHome) this.onHome();
        return;
      }
      if (BACK_KEYS.has(e.key)) {
        e.preventDefault();
        if (this.current && this.current._onBack && this.current._onBack() === true) return;
        if (t.onBack) t.onBack();
      }
    },

    _keyup(e) {
      if ((e.key === 'Enter' || e.key === ' ') && this._lp) {
        clearTimeout(this._lp);
        this._lp = null;
        if (!this._lpFired) this._activate();
      }
    },

    _activate() {
      const el = this.current;
      if (!el || !this._inTopLayer(el)) return;
      el.classList.add('is-pressed');
      setTimeout(() => el.classList.remove('is-pressed'), 140);
      el.click();
    },
  };

  function visible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[inert]');
  }

  window.Focus = Focus;
})();
