/**
 * Piece previews — the little silhouettes in the tray and the orientation strip.
 *
 * Two flavours: a flat dot grid for the 2-D board, and a true isometric
 * projection for the pyramid, drawn with the same camera angles as the live
 * 3-D stage so a thumbnail reads as the orientation it will actually place in.
 */

import { PIECE_BY_ID, pieceColor, fccToPyramid } from '../../core/pieces.js';
import { h } from '../dom.js';
import { store } from '../store.js';

export const colorOf = (pieceId) => pieceColor(pieceId, store.settings.palette);

/** Flat dot grid for a 2-D orientation. */
export function miniGrid(pieceId, orientation, { size = 11 } = {}) {
  const cells = new Set(orientation.cells.map(([r, c]) => `${r},${c}`));
  const node = h('div', {
    class: 'mini',
    style: {
      gridTemplateColumns: `repeat(${orientation.cols}, ${size}px)`,
      gridTemplateRows: `repeat(${orientation.rows}, ${size}px)`,
      '--mini': `${size}px`,
      '--c': colorOf(pieceId)
    }
  });
  for (let r = 0; r < orientation.rows; r++) {
    for (let c = 0; c < orientation.cols; c++) {
      node.appendChild(h('i', cells.has(`${r},${c}`) ? { 'data-on': '' } : null));
    }
  }
  return node;
}

/* --------------------------------------------------- isometric projection - */

const DEG = Math.PI / 180;
const TILT = 58 * DEG;   // rotateX in the design canvas
const SPIN = -38 * DEG;  // rotateZ in the design canvas
const RISE = 1 / Math.SQRT2;

/** FCC lattice cell -> the world point where its bead centre sits. */
export function fccToWorld([a, b, hh]) {
  const [layer, row, col] = fccToPyramid(a, b, hh);
  return { x: col + layer / 2, y: row + layer / 2, z: layer * RISE };
}

/** Project a world point with the stage camera. Returns screen x/y plus depth. */
export function project({ x, y, z }, { tilt = TILT, spin = SPIN } = {}) {
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  const x1 = x * cs - y * ss;
  const y1 = x * ss + y * cs;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return { x: x1, y: y1 * ct - z * st, depth: y1 * st + z * ct };
}

/**
 * Isometric SVG thumbnail of a 3-D orientation. `cells` are FCC offsets
 * relative to the shape's first cell, exactly as stored on the piece.
 */
export function isoPreview(pieceId, cells, { size = 48, radius = 0.46 } = {}) {
  const color = colorOf(pieceId);
  const points = cells
    .map((cell) => ({ cell, p: project(fccToWorld(cell)) }))
    .sort((m, n) => m.p.depth - n.p.depth);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { p } of points) {
    minX = Math.min(minX, p.x - radius);
    maxX = Math.max(maxX, p.x + radius);
    minY = Math.min(minY, p.y - radius);
    maxY = Math.max(maxY, p.y + radius);
  }
  const w = Math.max(maxX - minX, 0.001);
  const hgt = Math.max(maxY - minY, 0.001);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${hgt}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.overflow = 'visible';

  points.forEach(({ p }, i) => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', radius);
    circle.setAttribute('fill', color);
    // Beads further from the camera sit slightly back in tone.
    circle.setAttribute('opacity', String(0.62 + (0.38 * i) / Math.max(1, points.length - 1)));
    circle.setAttribute('stroke', 'rgba(0,0,0,0.45)');
    circle.setAttribute('stroke-width', '0.06');
    svg.appendChild(circle);
  });

  return svg;
}

/** Tray thumbnail that picks the right style for the dimension. */
export function pieceThumb(pieceId, { dimension, orientationIndex = 0, size = 11 } = {}) {
  const piece = PIECE_BY_ID[pieceId];
  if (dimension === '3D') {
    const orientation = piece.orientations3d[orientationIndex] || piece.orientations3d[0];
    return isoPreview(pieceId, orientation.cells, { size: size * 3.6 });
  }
  const orientation = piece.orientations2d[orientationIndex] || piece.orientations2d[0];
  return miniGrid(pieceId, orientation, { size });
}
