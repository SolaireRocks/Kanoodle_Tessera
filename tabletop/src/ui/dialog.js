/** Modal sheets and toasts. Focus is trapped while a sheet is open. */

import { h, clear, announce } from './dom.js';

const overlay = () => document.getElementById('overlay');

/**
 * @param {{title:string, body?:string|Node, actions:Array<{label:string, value:*, variant?:string}>}} config
 * @returns {Promise<*>} the chosen action's value, or null if dismissed
 */
export function sheet({ title, body, actions = [], dismissable = true }) {
  return new Promise((resolve) => {
    const host = overlay();
    const previousFocus = document.activeElement;

    const panel = h('div', { class: 'sheet__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { class: 'sheet__title', text: title }),
      body ? (typeof body === 'string' ? h('div', { class: 'sheet__body', text: body }) : body) : null,
      h('div', { class: 'sheet__actions' },
        ...actions.map((action) => h('button', {
          class: `btn btn--${action.variant || 'ghost'}`,
          text: action.label,
          onClick: () => close(action.value)
        })))
    );

    const scrim = h('div', {
      class: 'sheet',
      onClick: (event) => { if (dismissable && event.target === scrim) close(null); }
    }, panel);

    function onKey(event) {
      if (event.key === 'Escape' && dismissable) { event.preventDefault(); close(null); }
      if (event.key === 'Tab') {
        const focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }

    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve(value);
    }

    document.addEventListener('keydown', onKey, true);
    clear(host).appendChild(scrim);
    announce(title);
    panel.querySelector('button')?.focus();
  });
}

export function confirmSheet({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'primary' }) {
  return sheet({
    title,
    body,
    actions: [
      { label: cancelLabel, value: false, variant: 'ghost' },
      { label: confirmLabel, value: true, variant }
    ]
  }).then(Boolean);
}

/** A sheet with a single text field — used for challenge codes. */
export function promptSheet({ title, body, placeholder = '', value = '', confirmLabel = 'Load' }) {
  const input = h('input', {
    type: 'text',
    value,
    placeholder,
    'aria-label': title,
    style: {
      width: '100%',
      minHeight: '52px',
      padding: '0 14px',
      borderRadius: '12px',
      border: '1px solid var(--line-2)',
      background: 'var(--control)',
      color: 'var(--text)',
      fontFamily: 'var(--mono)',
      fontSize: '14px'
    }
  });

  const wrapper = h('div', { class: 'stack', style: { gap: '12px' } },
    body ? h('div', { class: 'sheet__body', text: body }) : null,
    input);

  const result = sheet({
    title,
    body: wrapper,
    actions: [
      { label: 'Cancel', value: null, variant: 'ghost' },
      { label: confirmLabel, value: 'ok', variant: 'primary' }
    ]
  }).then((choice) => (choice === 'ok' ? input.value.trim() : null));

  requestAnimationFrame(() => input.focus());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.closest('.sheet__panel')?.querySelectorAll('button')[1]?.click();
  });

  return result;
}

let toastTimer = null;
let toastNode = null;

export function toast(message, { warn = false, ms = 2600, speak = true } = {}) {
  if (toastNode) toastNode.remove();
  toastNode = h('div', { class: `toast${warn ? ' is-warn' : ''}`, text: message });
  document.body.appendChild(toastNode);
  if (speak) announce(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode?.remove();
    toastNode = null;
  }, ms);
}
