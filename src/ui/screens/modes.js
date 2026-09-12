/** M-03 — mode select. */

import { h } from '../dom.js';
import { topbar, tabbar } from '../chrome.js';
import { MODES } from '../modes.js';
import { modeButton } from './home.js';

export function render() {
  const element = h('section', { class: 'screen' },
    topbar('modes'),
    h('div', { class: 'mob-only', style: { padding: '26px 22px 18px', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'eyebrow tight', style: { marginBottom: '8px' }, text: 'CHOOSE A MODE' }),
      h('h1', { class: 'h1', text: 'Modes' })),
    h('div', { class: 'scroll' },
      h('div', { class: 'desk-only', style: { padding: '36px 32px 0' } },
        h('h1', { class: 'h1', style: { marginBottom: '8px' }, text: 'Modes' }),
        h('div', { class: 'sub', text: 'Two campaigns, three timed formats, and a companion solver.' })),
      h('div', { style: { padding: '18px 22px 32px' } },
        h('div', { class: 'modegrid desk-only', style: { padding: '18px 10px 0' } },
          ...MODES.map((mode) => modeButton(mode, { card: true }))),
        h('div', { class: 'stack mob-only', style: { gap: '11px' } },
          ...MODES.map((mode) => modeButton(mode))))),
    tabbar('modes'));

  return { element };
}
