/*
 * The home screen's own pointer, made for an air mouse and for eyes that need help.
 *
 *  - A big soft disc with a dark ring, so it shows up on any background.
 *  - Over something you can select, the disc shrinks to a dot and the item lifts
 *    (like Apple TV / iPad), so you can still see where you're pointing.
 *  - Magnetic: if the pointer is near an item but not on it, that item is selected
 *    anyway, so a shaky hand doesn't keep losing the selection.
 *  - It hides while you use the arrows, and when it comes back it pulses once so you
 *    can find it.
 */
(function () {
  'use strict';

  const SIZES = { standard: 1, large: 1.35, xlarge: 1.8 };
  const MAGNET_REM = 3.2;   // how far the magnet reaches
  const IDLE_MS = 3500;

  const Pointer = {
    el: null,
    x: -100,
    y: -100,
    hidden: true,
    over: null,

    init() {
      this.el = document.getElementById('pointer');
      document.body.classList.add('own-pointer');
      document.addEventListener('mousemove', (e) => this.move(e.clientX, e.clientY), { passive: true });
      document.addEventListener('mouseleave', () => this.hide());
      document.addEventListener('keydown', () => this.hide(), true);
      document.addEventListener('mousedown', () => this.el.classList.add('down'));
      document.addEventListener('mouseup', () => this.el.classList.remove('down'));
      // a click near (not on) the selected item still counts: that's the magnet
      document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.focusable, #avatar, #clock, input')) return;
        if (this.magnet && this.magnet === Focus.current && document.contains(this.magnet)) {
          e.preventDefault();
          e.stopPropagation();
          this.magnet.click();
        }
      }, true);
      this.setSize(App.settings.pointerSize);
    },

    setSize(size) {
      document.documentElement.style.setProperty('--pointer-scale', SIZES[size] || SIZES.large);
    },

    move(x, y) {
      this.x = x;
      this.y = y;
      this.el.style.transform = `translate(${x}px, ${y}px)`;
      if (this.hidden) {
        this.hidden = false;
        this.el.classList.add('show');
        // pulse once so it's easy to spot after it's been hidden
        this.el.classList.remove('locate');
        void this.el.offsetWidth;
        this.el.classList.add('locate');
      }
      clearTimeout(this._idle);
      this._idle = setTimeout(() => this.hide(), IDLE_MS);

      const under = document.elementFromPoint(x, y);
      let target = under && under.closest && under.closest('.focusable');
      if (target && !inTop(target)) target = null;
      this.magnet = null;
      if (!target) target = this.magnet = this.nearest(x, y);
      this.el.classList.toggle('on-target', !!(target && under && under.closest && under.closest('.focusable') === target));
      if (target && target !== Focus.current) Focus.set(target, { fromPointer: true });
    },

    // the closest selectable thing within reach of the magnet
    nearest(x, y) {
      const top = Focus.top();
      if (!top) return null;
      const reach = MAGNET_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
      let best = null, bestD = reach;
      for (const el of top.root.querySelectorAll('.focusable')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = el; }
      }
      return best;
    },

    hide() {
      if (this.hidden) return;
      this.hidden = true;
      this.el.classList.remove('show', 'on-target', 'locate');
    },
  };

  function inTop(el) {
    const t = Focus.top();
    return t && t.root.contains(el);
  }

  window.Pointer = Pointer;
})();
