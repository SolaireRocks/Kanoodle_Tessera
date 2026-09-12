/** Read-only board thumbnails for the home, resume and completion panels. */

import { PIECE_BY_ID } from '../../core/pieces.js';
import { BOARD_ROWS, BOARD_COLS, boardIndex, getTarget } from '../../core/target.js';
import { h } from '../dom.js';
import { store } from '../store.js';
import { colorOf, project, fccToWorld } from './pieceArt.js';

/**
 * @param {Array<{piece:string, cells:number[]}>} placements
 * @param {{mini?:boolean, solved?:boolean, label?:string, beadSize?:number}} options
 */
export function staticBoard(placements, { mini = true, solved = false, label = 'Board', beadSize = null } = {}) {
  const owner = new Array(BOARD_ROWS * BOARD_COLS).fill(null);
  for (const placement of placements) for (const cell of placement.cells) owner[cell] = placement.piece;

  const grid = h('div', {
    class: `board${mini ? ' board--mini' : ''}`,
    role: 'img',
    'aria-label': label,
    style: beadSize ? { '--bead': `${beadSize}px`, '--gap': '3px' } : null
  });
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c < BOARD_COLS; c++) {
      const piece = owner[boardIndex(r, c)];
      const bead = h('div', { class: 'bead' });
      if (piece) {
        bead.dataset.piece = piece;
        bead.style.setProperty('--c', colorOf(piece));
        if (store.settings.glyphs) bead.dataset.glyph = PIECE_BY_ID[piece].glyph;
      }
      grid.appendChild(bead);
    }
  }
  return h('div', { class: `boardwell${solved ? ' is-solved' : ''}` }, grid);
}

/** Isometric snapshot of a finished pyramid, drawn with the stage camera. */
export function staticPyramid(placements, { size = 260, label = 'Pyramid' } = {}) {
  const owner = new Map();
  for (const placement of placements) for (const cell of placement.cells) owner.set(cell, placement.piece);

  const target = getTarget('3D');
  const beads = target.cells
    .map((cell) => ({ cell, p: project(fccToWorld(cell.fcc)) }))
    .sort((a, b) => a.p.depth - b.p.depth);

  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const { p } of beads) {
    minX = Math.min(minX, p.x - 0.55); maxX = Math.max(maxX, p.x + 0.55);
    minY = Math.min(minY, p.y - 0.55); maxY = Math.max(maxY, p.y + 0.55);
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);

  for (const { cell, p } of beads) {
    const piece = owner.get(cell.index);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', 0.46);
    circle.setAttribute('fill', piece ? colorOf(piece) : 'rgba(255,255,255,0.06)');
    circle.setAttribute('stroke', 'rgba(0,0,0,0.4)');
    circle.setAttribute('stroke-width', '0.05');
    svg.appendChild(circle);
  }
  return h('div', { class: 'boardwell is-solved', style: { display: 'inline-block' } }, svg);
}

/** The eleven-segment progress strip on the mobile resume card. */
export function beadStrip(placements, total = 11) {
  const strip = h('div', { style: { display: 'flex', gap: '5px' }, 'aria-hidden': 'true' });
  const pieces = placements.map((p) => p.piece);
  for (let i = 0; i < total; i++) {
    const ratio = Math.round((pieces.length / 12) * total);
    strip.appendChild(h('div', {
      style: {
        height: '22px',
        flex: '1',
        borderRadius: '6px',
        background: i < ratio ? colorOf(pieces[i % Math.max(1, pieces.length)]) : 'rgba(255,255,255,0.07)'
      }
    }));
  }
  return strip;
}
