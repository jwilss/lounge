/*
 * Lounge Keyboard inside web apps.
 * When a text box on a website is selected, the same on-screen keyboard as
 * the home screen slides up. Typing on a real keyboard (the back of the air
 * mouse, or the phone remote) still works as normal.
 */
(function () {
  'use strict';
  if (window.top !== window || window.__loungeOsk) return;
  window.__loungeOsk = true;

  // Sites that already have their own TV keyboard
  const SKIP = [/^https:\/\/www\.youtube\.com\/tv/];
  if (SKIP.some((re) => re.test(location.href))) return;

  const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  shadow.appendChild(box);
  (document.body || document.documentElement).appendChild(host);

  const kb = new window.LoungeKeyboard(box, { layout: 'qwerty' });
  let target = null;
  let suppressUntil = 0;

  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
    return el.isContentEditable;
  }

  function labelFor(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    return el.placeholder || el.name || 'Type';
  }

  function getValue(el) {
    return el.isContentEditable ? el.textContent : el.value;
  }

  // set the value the way a real keypress would, so sites built with React etc. notice
  function setValue(el, v) {
    if (el.isContentEditable) {
      el.textContent = v;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function submit(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (el.form && typeof el.form.requestSubmit === 'function') {
      try { el.form.requestSubmit(); } catch (e) { /* the site handles it */ }
    }
  }

  document.addEventListener('focusin', (e) => {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!isTextField(el) || Date.now() < suppressUntil) return;
    target = el;
    kb.open({
      title: labelFor(el),
      value: getValue(el) || '',
      placeholder: el.placeholder || '',
      type: el.type === 'password' ? 'password' : 'text',
      onInput: (v) => { if (target) setValue(target, v); },
      onDone: (v) => { if (target) { setValue(target, v); submit(target); } target = null; },
      onCancel: () => { target = null; suppressUntil = Date.now() + 400; },
    });
  }, true);

  document.addEventListener('focusout', () => {
    // close if focus has really left the text box (not just a click on the keyboard)
    setTimeout(() => {
      if (target && document.activeElement !== target && !host.contains(document.activeElement)) {
        kb.close();
        target = null;
      }
    }, 150);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (!kb.isOpen) return;
    if (kb.handleKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
})();
