/** The How-to-play sheet — every essential action has a visible control (§5.1). */

import { h } from '../dom.js';
import { sheet } from '../components/dialog.js';

const ROWS = [
  ['Select a piece', 'Tap it in the tray. Tap again to deselect.'],
  ['Place it', 'Drag it onto the board, or tap a socket after selecting.'],
  ['Rotate / flip', 'Rotate and Flip buttons, or R and F.'],
  ['Take it back', 'Drag a piece you placed, or tap it and press Enter.'],
  ['Undo / reset', 'Undo button or Ctrl+Z. Reset returns to the starting setup.'],
  ['Hint', 'Three steps: which piece, then its orientation, then where. H.'],
  ['Solve', 'Fills the board from the current position. Marks the run assisted.'],
  ['Pyramid camera', 'Drag empty space to orbit, scroll to zoom, Q/E and W/S by key.'],
  ['Keyboard play', 'Arrow keys move the ghost, Enter or Space drops it.'],
  ['Free mode', 'Choose your own opening piece — or roll one — then fill the rest.']
];

export function helpSheet() {
  const body = h('div', { class: 'stack', style: { gap: '2px' } },
    h('div', { class: 'sheet__body', style: { marginBottom: '8px' } },
      'Every puzzle starts with some pieces locked in place. Fill all 55 sockets with the pieces you have left.'),
    ...ROWS.map(([label, hint]) => h('div', {
      style: { display: 'flex', gap: '14px', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }
    },
    h('div', { style: { width: '130px', fontSize: '14px', fontWeight: '500' }, text: label }),
    h('div', { style: { flex: '1', fontSize: '13px', color: 'var(--dim)', lineHeight: '1.45' }, text: hint }))));

  return sheet({
    title: 'How to play',
    body,
    actions: [{ label: 'Got it', value: true, variant: 'primary' }]
  });
}
