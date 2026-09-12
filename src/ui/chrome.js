/** Shared navigation chrome: the desktop top bar and the mobile tab bar. */

import { h } from './dom.js';
import { store, rankFor } from './store.js';
import { navigate } from './router.js';

const NAV = [
  { id: 'home', label: 'Play', tab: 'PLAY', href: '/home' },
  { id: 'modes', label: 'Modes', tab: 'MODES', href: '/modes' },
  { id: 'stats', label: 'Stats', tab: 'STATS', href: '/stats' },
  { id: 'settings', label: 'Settings', tab: 'YOU', href: '/settings' }
];

export function topbar(active, { back = null, title = null, right = null } = {}) {
  const rank = rankFor(store.profile.elo);
  return h('header', { class: 'topbar' },
    h('div', { class: 'row', style: { gap: '38px' } },
      back
        ? h('button', { class: 'iconbtn', 'aria-label': 'Back', text: '‹', onClick: () => navigate(back) })
        : h('button', {
          class: 'brand',
          'aria-label': 'Tessera home',
          onClick: () => navigate('/home')
        }, h('span', { class: 'brand__dot' }), h('span', { class: 'brand__name', text: 'TESSERA' })),
      title
        // A node lets a screen keep a handle on the label and rewrite it later.
        ? (title instanceof Node ? title : h('div', { class: 'eyebrow', text: title }))
        : h('nav', { class: 'topbar__nav' }, ...NAV.map((item) => h('button', {
          type: 'button',
          text: item.label,
          'aria-current': item.id === active ? 'page' : null,
          onClick: () => navigate(item.href)
        })))),
    right || h('div', { class: 'row', style: { gap: '18px' } },
      h('div', {
        class: 'mono',
        style: { fontSize: '12px', color: 'var(--accent)', letterSpacing: '0.12em' },
        text: `${store.profile.elo} ELO · ${rank.name.toUpperCase()}`
      }),
      h('div', { class: 'avatar', text: 'YOU', style: { fontSize: '9px', letterSpacing: '0.06em' } })));
}

export function tabbar(active) {
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    ...NAV.map((item) => h('button', {
      type: 'button',
      'aria-current': item.id === active ? 'page' : null,
      onClick: () => navigate(item.href)
    },
    h('span', { class: 'tab__mark' }),
    h('span', { class: 'tab__label', text: item.tab }))));
}

/** Mobile screen header with a back chevron and an optional eyebrow. */
export function mobileHeader({ back, eyebrow, title, action = null }) {
  return h('div', { class: 'mhead mob-only' },
    back
      ? h('button', { class: 'iconbtn', 'aria-label': 'Back', text: '‹', onClick: () => navigate(back) })
      : h('span', { style: { width: '36px' } }),
    h('div', { class: 'mhead__title' },
      eyebrow ? h('div', { class: 'eyebrow tight', text: eyebrow }) : null,
      h('div', { style: { fontSize: '17px', fontWeight: '600' }, text: title })),
    action || h('span', { style: { width: '36px' } }));
}
