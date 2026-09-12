/** M-01 / D-01 — title screen. */

import { h } from '../dom.js';
import { navigate } from '../router.js';
import { makeRng } from '../../core/rng.js';
import { PIECE_IDS } from '../../core/pieces.js';
import { colorOf } from '../components/pieceArt.js';
import { totalChallenges } from '../content.js';
import { helpSheet } from './help.js';

function dotField(count, density, seed) {
  const rng = makeRng(seed);
  const field = h('div', { class: 'splash__field', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i++) {
    const on = rng() < density;
    field.appendChild(h('i', {
      style: { background: on ? colorOf(PIECE_IDS[rng.int(PIECE_IDS.length)]) : 'rgba(255,255,255,0.045)' }
    }));
  }
  return field;
}

export function render() {
  const wide = window.matchMedia('(min-width: 1080px)').matches;

  const element = h('section', { class: 'screen splash' },
    dotField(wide ? 416 : 264, wide ? 0.26 : 0.3, 'tessera/splash'),
    h('div', { class: 'splash__veil' }),

    h('div', { class: 'splash__body' },
      h('div', { class: 'row', style: { gap: '12px' } },
        h('span', { class: 'brand__dot' }),
        h('span', { class: 'eyebrow', style: { letterSpacing: '0.3em' }, text: 'POLYSPHERE CIRCUIT' })),
      h('h1', { class: 'splash__wordmark', html: wide ? 'TESSERA' : 'TES<br>SERA' }),
      h('p', {
        class: 'splash__tag',
        style: { margin: 0 },
        text: wide
          ? 'Fifty-five sockets. Twelve pieces. One clock. The polysphere puzzle, rebuilt for players who race it.'
          : 'Fifty-five sockets. Twelve pieces. One clock.'
      })),

    h('div', { class: 'splash__actions' },
      h('button', { class: 'btn btn--primary', text: 'Start solving', onClick: () => navigate('/home') }),
      h('button', {
        class: 'btn btn--ghost',
        text: wide ? 'Watch a 30-second solve' : 'How to play',
        onClick: () => (wide ? navigate('/play/classic2d-06-01?demo=1') : helpSheet())
      }),
      h('div', { class: 'splash__version mono', text: `V 1.0 · ${totalChallenges()} CHALLENGES · PLAYS OFFLINE` })),

    h('div', { class: 'splash__facts' },
      h('div', { text: `${totalChallenges()} CHALLENGES` }),
      h('div', { text: '2-D + 3-D' }),
      h('div', { text: 'DAILY LATTICE 06:00 UTC' }),
      h('div', { text: 'V 1.0' })));

  return { element };
}
