/**
 * The setup sheet — a lettered, transcribable picture of a tabletop opening.
 *
 * The mini boards elsewhere are thumbnails: they say "this much is filled".
 * This one has a different job. Someone is holding real beads and needs to know
 * which socket each one goes in, so every row and column is labelled and every
 * occupied socket carries its piece letter. Colour is a second channel here,
 * never the only one — the sheet reads correctly in greyscale and on paper.
 */

import { PIECE_BY_ID } from '../../core/pieces.js';
import { BOARD_ROWS, BOARD_COLS, boardIndex, PYRAMID_LAYERS, layerSize, pyramidIndex }
  from '../../core/target.js';
import { socketName, remainingPieces } from '../../core/tabletop.js';
import { h } from '../dom.js';
import { colorOf } from './pieceArt.js';

const ROW_LETTERS = 'ABCDE';

function ownerMap(locked) {
  const owner = new Map();
  for (const placement of locked) {
    for (const cell of placement.cells) owner.set(cell, placement.piece);
  }
  return owner;
}

/**
 * One labelled grid. `cellIndex(row, col)` maps a position to a socket index,
 * which is all that differs between the board and a pyramid layer.
 */
function labelledGrid({ rows, cols, cellIndex, owner, caption = null, beadSize = null }) {
  const grid = h('div', {
    class: 'tsheet__grid',
    style: {
      gridTemplateColumns: `var(--tsheet-label) repeat(${cols}, var(--tsheet-bead))`,
      ...(beadSize ? { '--tsheet-bead': `${beadSize}px` } : null)
    },
    role: 'presentation'
  });

  grid.appendChild(h('span', { class: 'tsheet__corner', 'aria-hidden': 'true' }));
  for (let c = 0; c < cols; c++) {
    grid.appendChild(h('span', { class: 'tsheet__axis', 'aria-hidden': 'true', text: String(c + 1) }));
  }

  for (let r = 0; r < rows; r++) {
    grid.appendChild(h('span', { class: 'tsheet__axis', 'aria-hidden': 'true', text: ROW_LETTERS[r] }));
    for (let c = 0; c < cols; c++) {
      const piece = owner.get(cellIndex(r, c));
      const bead = h('div', { class: 'bead tsheet__bead', text: piece || '' });
      if (piece) {
        bead.dataset.piece = piece;
        bead.dataset.locked = 'true';
        bead.style.setProperty('--c', colorOf(piece));
      }
      grid.appendChild(bead);
    }
  }

  return h('div', { class: 'tsheet__panel' },
    caption ? h('div', { class: 'tsheet__caption', text: caption }) : null,
    grid);
}

/**
 * The whole opening, drawn to be copied onto a physical set.
 *
 * @param {{dimension:string, locked:Array<{piece:string,cells:number[]}>}} setup
 * @param {{beadSize?:number}} options
 */
export function setupSheet(setup, { beadSize = null } = {}) {
  const owner = ownerMap(setup.locked);
  const label = `${setup.dimension === '3D' ? 'Pyramid' : 'Board'} opening: ` +
    setup.locked.map((p) => `piece ${p.piece} at ${p.cells.map((cell) => socketName(setup.dimension, cell)).join(', ')}`)
      .join('; ');

  const body = setup.dimension === '3D'
    ? Array.from({ length: PYRAMID_LAYERS }, (_, layer) => {
      const n = layerSize(layer);
      return labelledGrid({
        rows: n,
        cols: n,
        cellIndex: (r, c) => pyramidIndex(layer, r, c),
        owner,
        caption: `LAYER ${layer + 1} · ${n}×${n}`,
        beadSize
      });
    })
    : [labelledGrid({
      rows: BOARD_ROWS,
      cols: BOARD_COLS,
      cellIndex: boardIndex,
      owner,
      beadSize
    })];

  return h('div', {
    class: `tsheet${setup.dimension === '3D' ? ' tsheet--layers' : ''}`,
    role: 'img',
    'aria-label': label
  }, ...body);
}

/** The setup piece by piece: letter, bead count, and the sockets it covers. */
export function setupLegend(setup) {
  return h('div', { class: 'tlegend' },
    ...setup.locked.map((placement) => h('div', { class: 'tlegend__row' },
      h('span', {
        class: 'tlegend__tag',
        style: { background: colorOf(placement.piece) },
        text: placement.piece
      }),
      h('span', {
        class: 'tlegend__beads',
        text: `${placement.cells.length} bead${placement.cells.length === 1 ? '' : 's'}`
      }),
      h('span', {
        class: 'tlegend__cells',
        text: placement.cells.map((cell) => socketName(setup.dimension, cell)).join(' ')
      }))));
}

/** The pieces that stay in the bag — what the solver, or you, still has to fit. */
export function remainingStrip(setup) {
  const left = remainingPieces(setup);
  return h('div', { class: 'tbag' },
    ...left.map((id) => h('span', {
      class: 'tbag__tag',
      style: { '--c': colorOf(id) },
      title: `${PIECE_BY_ID[id].beads} beads`,
      text: id
    })));
}
