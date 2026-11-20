/*
 * Small UI kit: element helper, toasts, and the building blocks for sheets
 * (pop-up panels): buttons, toggles, choice rows and text fields that open
 * the on-screen keyboard.
 */
(function () {
  'use strict';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) el.style.setProperty(sk, sv);
            else el.style[sk] = sv;
          }
        }
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- toast ----------
  const Toast = {
    show(text, ms = 2600) {
      const box = document.getElementById('toast');
      box.textContent = text;
      box.classList.add('show');
      clearTimeout(this._t);
      this._t = setTimeout(() => box.classList.remove('show'), ms);
    },
  };

  // ---------- sheets ----------
  const Sheets = {
    /**
     * open({ title, subtitle, wide, side, build(body, sheet), onClose })
     * side: 'right' for a Control Centre style panel.
     */
    open(opts) {
      const host = document.getElementById('layers');
      const body = h('div', { class: 'sheet-body' });
      const panel = h('div', { class: 'sheet' + (opts.wide ? ' sheet-wide' : '') + (opts.side ? ' sheet-side' : '') + (opts.page ? ' sheet-page' : '') },
        opts.title ? h('h2', { class: 'sheet-title' }, opts.title) : null,
        opts.subtitle ? h('p', { class: 'sheet-sub' }, opts.subtitle) : null,
        body);
      const root = h('div', { class: 'layer' + (opts.side ? ' layer-side' : '') + (opts.page ? ' layer-page' : '') }, panel);
      host.appendChild(root);
      document.body.classList.add('has-layer');

      const sheet = {
        root, body, panel,
        closed: false,
        close() {
          if (sheet.closed) return;
          sheet.closed = true;
          Sheets._open = Sheets._open.filter((x) => x !== sheet);
          root.classList.remove('open');
          Focus.pop(root);
          setTimeout(() => root.remove(), 260);
          if (!Sheets._open.length) document.body.classList.remove('has-layer');
          if (opts.onClose) opts.onClose();
        },
        rebuild() {
          body.textContent = '';
          opts.build(body, sheet);
          Focus.refresh();
        },
      };
      opts.build(body, sheet);
      Sheets._open.push(sheet);
      requestAnimationFrame(() => root.classList.add('open'));
      Focus.push(root, { onBack: () => sheet.close(), initial: opts.initial ? opts.initial(root) : null });
      return sheet;
    },

    _open: [],

    closeAll() {
      [...Sheets._open].reverse().forEach((s) => s.close());
      if (Focus.keyboard) Focus.keyboard.close();
    },

    anyOpen() { return Sheets._open.length > 0; },

    button(label, onClick, opts = {}) {
      return h('button', {
        class: 'row focusable' + (opts.style ? ' row-' + opts.style : ''),
        type: 'button',
        dataset: { key: opts.key || 'btn:' + label },
        onclick: onClick,
      },
      opts.icon ? h('span', { class: 'row-icon' }, opts.icon) : null,
      h('span', { class: 'row-label' }, label),
      opts.value != null ? h('span', { class: 'row-value' }, opts.value) : null,
      opts.chevron ? h('span', { class: 'row-chev' }, '›') : null);
    },

    toggle(label, value, onChange, opts = {}) {
      const knob = h('span', { class: 'switch' + (value ? ' on' : '') });
      const row = h('button', { class: 'row focusable', type: 'button', dataset: { key: opts.key || 'tgl:' + label } },
        h('span', { class: 'row-label' }, label),
        opts.note ? h('span', { class: 'row-note' }, opts.note) : null,
        knob);
      row.addEventListener('click', () => {
        value = !value;
        knob.classList.toggle('on', value);
        onChange(value);
      });
      return row;
    },

    /** Cycles through options with OK, or left/right while selected. */
    choice(label, options, value, onChange, opts = {}) {
      let i = Math.max(0, options.findIndex((o) => o.value === value));
      const val = h('span', { class: 'row-value' });
      const row = h('button', { class: 'row focusable', type: 'button', dataset: { key: opts.key || 'chc:' + label } },
        h('span', { class: 'row-label' }, label), h('span', { class: 'row-arrows' }, '‹'), val, h('span', { class: 'row-arrows' }, '›'));
      const render = () => { val.textContent = options[i].label; };
      const step = (d) => { i = (i + d + options.length) % options.length; render(); onChange(options[i].value); };
      row.addEventListener('click', () => step(1));
      row._onMove = (dir) => {
        if (dir === 'left') { step(-1); return true; }
        if (dir === 'right') { step(1); return true; }
        return false;
      };
      render();
      return row;
    },

    /** A text field. Selecting it opens the on-screen keyboard. */
    field(label, opts = {}) {
      let value = opts.value || '';
      const shown = h('span', { class: 'field-value' });
      const render = () => {
        shown.textContent = value || opts.placeholder || '';
        shown.classList.toggle('is-placeholder', !value);
      };
      const row = h('button', { class: 'row row-field focusable', type: 'button', dataset: { key: opts.key || 'fld:' + label } },
        h('span', { class: 'row-label' }, label), shown);
      row.addEventListener('click', () => {
        Focus.keyboard.open({
          title: label,
          value,
          placeholder: opts.placeholder,
          type: opts.type,
          suggestions: opts.suggestions,
          onInput: (v) => { if (opts.live) { value = v; render(); opts.onChange && opts.onChange(v); } },
          onDone: (v) => { value = v; render(); opts.onChange && opts.onChange(v); },
        });
      });
      row.getValue = () => value;
      row.setValue = (v) => { value = v || ''; render(); };
      render();
      return row;
    },

    actions(...buttons) {
      return h('div', { class: 'sheet-actions' }, ...buttons.map((b) =>
        h('button', { class: 'pill focusable' + (b.style ? ' pill-' + b.style : ''), type: 'button', dataset: { key: 'act:' + b.label }, onclick: b.onClick }, b.label)));
    },
  };

  window.h = h;
  window.Toast = Toast;
  window.Sheets = Sheets;
})();
