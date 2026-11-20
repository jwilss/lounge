/*
 * Lounge on-screen keyboard (shared core)
 *
 * Used by the launcher and by the browser extension that runs inside web apps,
 * so typing looks and works the same everywhere. No dependencies.
 *
 *   const kb = new LoungeKeyboard(container, { layout: 'qwerty' });
 *   kb.open({ title, value, placeholder, type, suggestions, onInput, onDone, onCancel });
 *   kb.handleKey(event)  -> true if the keyboard used the key
 *   kb.close()
 */
(function (global) {
  'use strict';

  const ROWS = {
    qwerty: {
      lower: [
        '1234567890'.split(''),
        'qwertyuiop'.split(''),
        "asdfghjkl'".split(''),
        ['{shift}', ...'zxcvbnm'.split(''), '-', '{bksp}'],
        ['{sym}', ',', '{space}', '.', '@', '{dotcom}', '{done}'],
      ],
    },
    abc: {
      lower: [
        '1234567890'.split(''),
        'abcdefghi'.split(''),
        'jklmnopqr'.split(''),
        ['{shift}', ...'stuvwxyz'.split(''), '{bksp}'],
        ['{sym}', ',', '{space}', '.', '@', '{dotcom}', '{done}'],
      ],
    },
    symbols: [
      '1234567890'.split(''),
      ['!', '@', '#', '£', '$', '%', '&', '*', '(', ')'],
      ['-', '_', '=', '+', '/', '\\', ':', ';', '"', "'"],
      ['~', '`', '|', '^', '[', ']', '<', '>', '?', '{bksp}'],
      ['{abc}', ',', '{space}', '.', '/', '{dotcom}', '{done}'],
    ],
  };

  const LABELS = {
    '{shift}': '⇧',
    '{bksp}': '⌫',
    '{space}': 'space',
    '{sym}': '123',
    '{abc}': 'ABC',
    '{dotcom}': '.com',
    '{done}': 'Done',
  };

  const WIDE = { '{space}': 4, '{done}': 1.6, '{dotcom}': 1.3, '{sym}': 1.3, '{abc}': 1.3, '{shift}': 1.3, '{bksp}': 1.3 };

  const CSS = `
  .lkb-wrap{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;
    padding:1.6em 0 2em;background:rgba(18,18,22,.9);-webkit-backdrop-filter:blur(30px) saturate(1.3);backdrop-filter:blur(30px) saturate(1.3);
    box-shadow:0 -1.5em 4em rgba(0,0,0,.55);border-radius:1.6em 1.6em 0 0;
    transform:translateY(105%);transition:transform .28s cubic-bezier(.2,.8,.2,1);font-family:"Inter","InterVariable",system-ui,"Segoe UI",sans-serif;
    font-size:var(--lkb-font, 16px)}
  .lkb-wrap.lkb-open{transform:none}
  .lkb-panel{width:min(62em,96vw);display:flex;flex-direction:column;gap:.6em}
  .lkb-head{display:flex;align-items:baseline;gap:1em;color:#f5f5f7}
  .lkb-title{font-size:1em;font-weight:600;opacity:.6;white-space:nowrap}
  .lkb-field{flex:1;min-height:2.6em;display:flex;align-items:center;padding:0 1em;border-radius:.7em;
    background:rgba(255,255,255,.1);font-size:1.5em;font-weight:500;overflow:hidden;white-space:nowrap}
  .lkb-field .lkb-ph{opacity:.35}
  .lkb-caret{display:inline-block;width:2px;height:1.1em;margin-left:1px;background:#f5f5f7;animation:lkb-blink 1s steps(1) infinite;vertical-align:-0.15em}
  @keyframes lkb-blink{50%{opacity:0}}
  .lkb-sugg{display:flex;gap:.5em;min-height:2.2em;flex-wrap:nowrap;overflow:hidden}
  .lkb-sugg:empty{display:none}
  .lkb-rows{display:flex;flex-direction:column;gap:.45em}
  .lkb-row{display:flex;gap:.45em;justify-content:center}
  .lkb-key{flex:1 1 0;min-width:0;height:2.9em;border-radius:.6em;border:0;cursor:pointer;
    background:rgba(255,255,255,.09);color:#f5f5f7;font:inherit;font-size:1.25em;font-weight:500;
    display:flex;align-items:center;justify-content:center;transition:transform .12s,background .12s,color .12s,box-shadow .12s}
  .lkb-key.lkb-special{font-size:1em;font-weight:600;background:rgba(255,255,255,.14)}
  .lkb-key.lkb-done{background:rgba(255,255,255,.22)}
  .lkb-key.lkb-on{background:rgba(255,255,255,.35)}
  .lkb-chip{flex:0 0 auto;height:2.2em;padding:0 1em;font-size:1em;border-radius:1.1em}
  .lkb-key.lkb-focus{background:#f5f5f7;color:#111;transform:scale(1.1);box-shadow:0 .4em 1.2em rgba(0,0,0,.5);position:relative;z-index:1}
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class LoungeKeyboard {
    constructor(container, opts = {}) {
      this.container = container || document.body;
      this.layout = opts.layout === 'abc' ? 'abc' : 'qwerty';
      this.shift = false;
      this.caps = false;
      this.mode = 'letters'; // or 'symbols'
      this.isOpen = false;
      this.value = '';
      this.params = {};
      this.focus = { r: 1, c: 0 };
      this._lastShiftTap = 0;
      this._build();
    }

    setLayout(layout) {
      this.layout = layout === 'abc' ? 'abc' : 'qwerty';
      if (this.isOpen) this._renderKeys();
    }

    _build() {
      const root = this.container.getRootNode ? this.container.getRootNode() : document;
      const styleHost = root === document ? document.head : root;
      if (!styleHost.querySelector || !styleHost.querySelector('style[data-lkb]')) {
        const st = el('style');
        st.setAttribute('data-lkb', '');
        st.textContent = CSS;
        styleHost.appendChild(st);
      }
      this.wrap = el('div', 'lkb-wrap');
      this.wrap.setAttribute('aria-hidden', 'true');
      const panel = el('div', 'lkb-panel');
      const head = el('div', 'lkb-head');
      this.titleEl = el('div', 'lkb-title');
      this.fieldEl = el('div', 'lkb-field');
      head.append(this.titleEl, this.fieldEl);
      this.suggEl = el('div', 'lkb-sugg');
      this.rowsEl = el('div', 'lkb-rows');
      panel.append(head, this.suggEl, this.rowsEl);
      this.wrap.appendChild(panel);
      this.container.appendChild(this.wrap);
      // Clicks never steal focus from the page's text box
      this.wrap.addEventListener('mousedown', (e) => e.preventDefault());
    }

    open(params = {}) {
      this.params = params;
      this.value = params.value || '';
      this.shift = false;
      this.caps = false;
      this.mode = 'letters';
      this.titleEl.textContent = params.title || '';
      this.isOpen = true;
      this._renderKeys();
      this.focus = { r: 1, c: 0 };
      this._renderFocus();
      this._renderField();
      this._renderSuggestions();
      this.wrap.classList.add('lkb-open');
      this.wrap.setAttribute('aria-hidden', 'false');
    }

    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.wrap.classList.remove('lkb-open');
      this.wrap.setAttribute('aria-hidden', 'true');
    }

    setValue(v) {
      this.value = v || '';
      this._renderField();
      this._renderSuggestions();
    }

    _rows() {
      if (this.mode === 'symbols') return ROWS.symbols;
      return ROWS[this.layout].lower;
    }

    _renderKeys() {
      this.rowsEl.textContent = '';
      this.keyEls = [];
      const upper = this.shift || this.caps;
      this._rows().forEach((row, r) => {
        const rowEl = el('div', 'lkb-row');
        const rowKeys = [];
        row.forEach((k, c) => {
          const special = k.length > 1 && k.startsWith('{');
          let label = special ? LABELS[k] : k;
          if (!special && upper && this.mode === 'letters') label = k.toUpperCase();
          const b = el('button', 'lkb-key' + (special ? ' lkb-special' : '') + (k === '{done}' ? ' lkb-done' : ''), label);
          b.type = 'button';
          b.tabIndex = -1;
          if (k === '{shift}' && (this.shift || this.caps)) b.classList.add('lkb-on');
          if (WIDE[k]) b.style.flexGrow = WIDE[k];
          b.addEventListener('click', () => { this.focus = { r, c }; this._renderFocus(); this._press(k); });
          b.addEventListener('mouseenter', () => { this.focus = { r, c }; this._renderFocus(); });
          rowEl.appendChild(b);
          rowKeys.push(b);
        });
        this.rowsEl.appendChild(rowEl);
        this.keyEls.push(rowKeys);
      });
    }

    _renderSuggestions() {
      this.suggEl.textContent = '';
      this.suggEls = [];
      const list = (this.params.suggestions || [])
        .filter((s) => s && s.toLowerCase().startsWith(this.value.toLowerCase()) && s !== this.value)
        .slice(0, 6);
      list.forEach((s, i) => {
        const b = el('button', 'lkb-key lkb-chip', s);
        b.type = 'button';
        b.tabIndex = -1;
        b.addEventListener('click', () => this._pickSuggestion(s));
        b.addEventListener('mouseenter', () => { this.focus = { r: -1, c: i }; this._renderFocus(); });
        this.suggEl.appendChild(b);
        this.suggEls.push(b);
      });
      if (this.focus.r === -1 && !this.suggEls.length) this.focus = { r: 0, c: 0 };
      this._renderFocus();
    }

    _renderField() {
      this.fieldEl.textContent = '';
      const shown = this.params.type === 'password' ? '•'.repeat(this.value.length) : this.value;
      if (shown) {
        this.fieldEl.appendChild(document.createTextNode(shown));
      } else if (this.params.placeholder) {
        this.fieldEl.appendChild(el('span', 'lkb-ph', this.params.placeholder));
      }
      this.fieldEl.appendChild(el('span', 'lkb-caret'));
      // keep the end of long text visible
      this.fieldEl.scrollLeft = this.fieldEl.scrollWidth;
    }

    _keyAt(r, c) {
      if (r === -1) return this.suggEls[c];
      return this.keyEls[r] && this.keyEls[r][c];
    }

    _renderFocus() {
      const all = [...(this.suggEls || []), ...(this.keyEls || []).flat()];
      all.forEach((b) => b.classList.remove('lkb-focus'));
      const k = this._keyAt(this.focus.r, this.focus.c);
      if (k) k.classList.add('lkb-focus');
    }

    _move(dir) {
      const cur = this._keyAt(this.focus.r, this.focus.c);
      if (!cur) { this.focus = { r: 1, c: 0 }; this._renderFocus(); return; }
      if (dir === 'left' || dir === 'right') {
        const row = this.focus.r === -1 ? this.suggEls : this.keyEls[this.focus.r];
        const n = row.length;
        this.focus.c = (this.focus.c + (dir === 'right' ? 1 : -1) + n) % n; // wraps like tvOS
        this._renderFocus();
        return;
      }
      const minRow = this.suggEls && this.suggEls.length ? -1 : 0;
      const nr = this.focus.r + (dir === 'down' ? 1 : -1);
      if (nr < minRow || nr >= this.keyEls.length) return;
      // pick the key in the next row whose centre is nearest to this key's centre
      const rect = cur.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const row = nr === -1 ? this.suggEls : this.keyEls[nr];
      let best = 0, bestD = Infinity;
      row.forEach((b, i) => {
        const br = b.getBoundingClientRect();
        const d = Math.abs(br.left + br.width / 2 - cx);
        if (d < bestD) { bestD = d; best = i; }
      });
      this.focus = { r: nr, c: best };
      this._renderFocus();
    }

    _emit() {
      this._renderField();
      this._renderSuggestions();
      if (this.params.onInput) this.params.onInput(this.value);
    }

    _insert(text) {
      this.value += text;
      if (this.shift && !this.caps) { this.shift = false; this._renderKeys(); this._renderFocus(); }
      this._emit();
    }

    _pickSuggestion(s) {
      this.value = s;
      this._emit();
    }

    _press(k) {
      switch (k) {
        case '{shift}': {
          const now = Date.now();
          if (this.caps) { this.caps = false; this.shift = false; }
          else if (this.shift && now - this._lastShiftTap < 450) { this.caps = true; }
          else { this.shift = !this.shift; }
          this._lastShiftTap = now;
          this._renderKeys(); this._renderFocus();
          return;
        }
        case '{bksp}':
          if (this.value) { this.value = this.value.slice(0, -1); this._emit(); }
          return;
        case '{space}': this._insert(' '); return;
        case '{dotcom}': this._insert('.com'); return;
        case '{sym}': this.mode = 'symbols'; this._renderKeys(); this._renderFocus(); return;
        case '{abc}': this.mode = 'letters'; this._renderKeys(); this._renderFocus(); return;
        case '{done}': this._done(); return;
        default: {
          const upper = (this.shift || this.caps) && this.mode === 'letters';
          this._insert(upper ? k.toUpperCase() : k);
        }
      }
    }

    _done() {
      const v = this.value;
      const cb = this.params.onDone;
      this.close();
      if (cb) cb(v);
    }

    _cancel() {
      const cb = this.params.onCancel;
      this.close();
      if (cb) cb(this.value);
    }

    /** Returns true when the keyboard handled the key (caller should stop it). */
    handleKey(e) {
      if (!this.isOpen) return false;
      const key = e.key;
      switch (key) {
        case 'ArrowLeft': this._move('left'); return true;
        case 'ArrowRight': this._move('right'); return true;
        case 'ArrowUp': this._move('up'); return true;
        case 'ArrowDown': this._move('down'); return true;
        case 'Enter': {
          const b = this._keyAt(this.focus.r, this.focus.c);
          if (b) b.click();
          return true;
        }
        case 'Escape':
        case 'BrowserBack':
        case 'GoBack':
          this._cancel();
          return true;
        case 'Backspace':
          if (this.value) { this.value = this.value.slice(0, -1); this._emit(); }
          return true;
        default:
          // typing on a real keyboard (e.g. the back of the air mouse) still works
          if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            this.value += key;
            this._emit();
            return true;
          }
      }
      return false;
    }
  }

  global.LoungeKeyboard = LoungeKeyboard;
})(typeof window !== 'undefined' ? window : this);
