/** M-08 — settings and accessibility (§11). */

import { PIECE_IDS } from '../../core/pieces.js';
import { h } from '../dom.js';
import { navigate, render as rerender } from '../router.js';
import { topbar, tabbar } from '../chrome.js';
import { store, PALETTE_KEYS } from '../store.js';
import { PALETTES, pieceColor } from '../../core/pieces.js';
import { confirmSheet, toast } from '../components/dialog.js';
import { helpSheet } from './help.js';

const GROUPS = [
  {
    title: 'VISION',
    rows: [
      { key: 'highContrast', label: 'High-contrast beads', hint: 'Boost socket outlines and separate every bead' },
      { key: 'glyphs', label: 'Colour-blind symbols', hint: 'Adds a unique glyph to each of the twelve pieces' },
      { key: 'reduceMotion', label: 'Reduce motion', hint: 'No bead drops, camera easing or solve animation' }
    ]
  },
  {
    title: 'PLAY',
    rows: [
      { key: 'snap', label: 'Snap to socket', hint: 'Pieces jump to the nearest legal position while dragging' },
      { key: 'showTimer', label: 'Show timer during play', hint: 'Hide it if the clock puts you off — it still records' },
      { key: 'haptics', label: 'Haptics on placement', hint: 'A short tick when a piece locks in, where supported' },
      { key: 'noLocks', label: 'No tier locks', hint: 'Browse and play every tier without unlocking it first' }
    ]
  }
];

function toggleRow(row) {
  const node = h('button', {
    class: 'setrow',
    type: 'button',
    role: 'switch',
    'aria-checked': store.settings[row.key] ? 'true' : 'false',
    onClick: () => {
      const next = !store.settings[row.key];
      store.setSetting(row.key, next);
      node.setAttribute('aria-checked', next ? 'true' : 'false');
      if (row.key === 'glyphs' || row.key === 'highContrast') toast(next ? `${row.label} on.` : `${row.label} off.`);
    }
  },
  h('div', { style: { flex: '1' } },
    h('div', { class: 'setrow__label', text: row.label }),
    h('div', { class: 'setrow__hint', text: row.hint })),
  h('span', { class: 'switch', 'aria-hidden': 'true' }, h('i')));
  return node;
}

function paletteButton(name) {
  const active = store.settings.palette === name;
  const sample = ['A', 'C', 'E', 'G', 'I'];
  return h('button', {
    class: `palettebtn${active ? ' is-active' : ''}`,
    type: 'button',
    'aria-pressed': active ? 'true' : 'false',
    'aria-label': `${name} palette`,
    onClick: () => { store.setSetting('palette', name); rerender(); }
  },
  h('div', { class: 'palettebtn__swatches' },
    ...sample.map((id) => h('i', { style: { background: pieceColor(id, name) } }))),
  h('div', { class: 'palettebtn__name', text: name }));
}

export function render() {
  const element = h('section', { class: 'screen' },
    topbar('settings'),
    h('div', { class: 'mob-only', style: { padding: '26px 22px 18px', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'eyebrow tight', style: { marginBottom: '8px' }, text: 'SETTINGS' }),
      h('h1', { class: 'h1', text: 'Accessibility' })),

    h('div', { class: 'scroll' },
      h('div', { class: 'settings2', style: { padding: '18px 22px 32px', display: 'flex', flexDirection: 'column', gap: '20px' } },
        h('h1', { class: 'h1 desk-only', style: { marginBottom: '4px' }, text: 'Settings' }),

        ...GROUPS.map((group) => h('div', null,
          h('div', { class: 'eyebrow accent tight', style: { marginBottom: '11px' }, text: group.title }),
          h('div', { class: 'setgroup' }, ...group.rows.map(toggleRow)))),

        h('div', null,
          h('div', { class: 'eyebrow accent tight', style: { marginBottom: '11px' }, text: 'PIECE PALETTE' }),
          h('div', { class: 'palettes' }, ...PALETTE_KEYS.map(paletteButton)),
          h('div', { class: 'notice', style: { marginTop: '10px' },
            text: 'DEUTER SEPARATES THE TWELVE PIECES ON THE BLUE–YELLOW AXIS AND BY LIGHTNESS.' })),

        h('div', null,
          h('div', { class: 'eyebrow accent tight', style: { marginBottom: '11px' }, text: 'ABOUT' }),
          h('div', { class: 'setgroup' },
            h('button', { class: 'setrow', type: 'button', onClick: helpSheet },
              h('div', { style: { flex: '1' } },
                h('div', { class: 'setrow__label', text: 'How to play' }),
                h('div', { class: 'setrow__hint', text: 'Controls for touch, mouse and keyboard' })),
              h('span', { style: { color: 'var(--dim)' }, text: '›' })),
            h('button', { class: 'setrow', type: 'button', onClick: () => navigate('/stats') },
              h('div', { style: { flex: '1' } },
                h('div', { class: 'setrow__label', text: 'Your record' }),
                h('div', { class: 'setrow__hint', text: 'Solves, clean rate and rating over time' })),
              h('span', { style: { color: 'var(--dim)' }, text: '›' })),
            h('button', {
              class: 'setrow',
              type: 'button',
              onClick: async () => {
                const ok = await confirmSheet({
                  title: 'Erase all progress?',
                  body: 'Solves, best times, rating, streak and settings are stored only on this device. This cannot be undone.',
                  confirmLabel: 'Erase everything',
                  variant: 'ghost'
                });
                if (!ok) return;
                store.reset();
                toast('Progress erased.');
                navigate('/home');
              }
            },
            h('div', { style: { flex: '1' } },
              h('div', { class: 'setrow__label', style: { color: 'var(--danger)' }, text: 'Erase local progress' }),
              h('div', { class: 'setrow__hint', text: 'Everything Tessera stores lives in this browser' })),
            h('span', { style: { color: 'var(--dim)' }, text: '›' })))),

        h('div', { class: 'notice', style: { lineHeight: '1.9' },
          text: `TESSERA V1.0 · RULES V1 · PIECES ${PIECE_IDS.length} · SOCKETS 55 · NO ACCOUNT, NO NETWORK.` }))),

    tabbar('settings'));

  return { element };
}

export { PALETTES };
