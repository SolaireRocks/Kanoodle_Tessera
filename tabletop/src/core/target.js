/**
 * Target spaces — the two shapes the twelve pieces have to fill.
 *
 * Both expose the same interface so the solver, the hint ladder and the save
 * format never need to know which dimension they are working in:
 *
 *   size            number of sockets (55 for both)
 *   cells           socket descriptors, indexed 0..size-1
 *   placements      every legal (piece, orientation, position) triple
 *   placementsByPiece  the same list bucketed by piece id
 *
 * A placement is stored as plain socket indices, so collision checking is a
 * bitset intersection and nothing depends on screen geometry.
 */

import { PIECES, pyramidToFcc, fccToPyramid } from './pieces.js';

/* ------------------------------------------------------------- 2-D board -- */

export const BOARD_ROWS = 5;
export const BOARD_COLS = 11;

export const boardIndex = (row, col) => row * BOARD_COLS + col;
export const boardRow = (index) => Math.floor(index / BOARD_COLS);
export const boardCol = (index) => index % BOARD_COLS;

function build2dTarget() {
  const cells = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c < BOARD_COLS; c++) cells.push({ index: boardIndex(r, c), row: r, col: c });
  }

  const placements = [];
  const placementsByPiece = {};

  for (const piece of PIECES) {
    placementsByPiece[piece.id] = [];
    for (const orientation of piece.orientations2d) {
      for (let r0 = 0; r0 + orientation.rows <= BOARD_ROWS; r0++) {
        for (let c0 = 0; c0 + orientation.cols <= BOARD_COLS; c0++) {
          const indices = orientation.cells.map(([r, c]) => boardIndex(r0 + r, c0 + c));
          const placement = {
            id: placements.length,
            piece: piece.id,
            orientation: orientation.index,
            origin: { row: r0, col: c0 },
            cells: indices
          };
          placements.push(placement);
          placementsByPiece[piece.id].push(placement);
        }
      }
    }
  }

  return {
    dimension: '2D',
    size: BOARD_ROWS * BOARD_COLS,
    cells,
    placements,
    placementsByPiece,
    describeCell: (index) => `row ${boardRow(index) + 1}, column ${boardCol(index) + 1}`
  };
}

/* --------------------------------------------------------------- pyramid -- */

export const PYRAMID_LAYERS = 5;
/** Layer n is a (5 - n) x (5 - n) grid; 25 + 16 + 9 + 4 + 1 = 55. */
export const layerSize = (layer) => PYRAMID_LAYERS - layer;

export const LAYER_OFFSETS = (() => {
  const offsets = [];
  let running = 0;
  for (let l = 0; l < PYRAMID_LAYERS; l++) {
    offsets.push(running);
    running += layerSize(l) ** 2;
  }
  return offsets;
})();

export const pyramidIndex = (layer, row, col) => LAYER_OFFSETS[layer] + row * layerSize(layer) + col;

export function pyramidCoords(index) {
  for (let l = PYRAMID_LAYERS - 1; l >= 0; l--) {
    if (index >= LAYER_OFFSETS[l]) {
      const n = layerSize(l);
      const local = index - LAYER_OFFSETS[l];
      return { layer: l, row: Math.floor(local / n), col: local % n };
    }
  }
  return null;
}

function build3dTarget() {
  const cells = [];
  /** Reverse lookup from FCC lattice coordinates back to a socket index. */
  const byFcc = new Map();

  for (let l = 0; l < PYRAMID_LAYERS; l++) {
    const n = layerSize(l);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const index = pyramidIndex(l, r, c);
        const fcc = pyramidToFcc(l, r, c);
        cells.push({ index, layer: l, row: r, col: c, fcc });
        byFcc.set(fcc.join(','), index);
      }
    }
  }

  const placements = [];
  const placementsByPiece = {};

  for (const piece of PIECES) {
    placementsByPiece[piece.id] = [];
    for (const orientation of piece.orientations3d) {
      // Anchor the orientation's first cell on every socket in turn. Because
      // all offsets inside a shape have even coordinate sum, any socket is a
      // valid anchor and the whole shape stays on the lattice.
      for (const anchor of cells) {
        const [a0, b0, h0] = anchor.fcc;
        const indices = [];
        let fits = true;
        for (const [da, db, dh] of orientation.cells) {
          const hit = byFcc.get(`${a0 + da},${b0 + db},${h0 + dh}`);
          if (hit === undefined) { fits = false; break; }
          indices.push(hit);
        }
        if (!fits) continue;
        const placement = {
          id: placements.length,
          piece: piece.id,
          orientation: orientation.index,
          anchor: anchor.index,
          cells: indices.slice().sort((x, y) => x - y)
        };
        placements.push(placement);
        placementsByPiece[piece.id].push(placement);
      }
    }
  }

  // Anchoring on every socket produces the same footprint more than once when a
  // shape can be slid onto itself; drop the duplicates so hint/solve output and
  // the orientation strip stay stable.
  const unique = new Map();
  for (const placement of placements) {
    const key = `${placement.piece}|${placement.cells.join(',')}`;
    if (!unique.has(key)) unique.set(key, placement);
  }
  const deduped = [...unique.values()].map((p, i) => ({ ...p, id: i }));
  const bucketed = {};
  for (const piece of PIECES) bucketed[piece.id] = [];
  for (const p of deduped) bucketed[p.piece].push(p);

  return {
    dimension: '3D',
    size: 55,
    cells,
    placements: deduped,
    placementsByPiece: bucketed,
    describeCell: (index) => {
      const { layer, row, col } = pyramidCoords(index);
      return `layer ${layer + 1}, row ${row + 1}, column ${col + 1}`;
    }
  };
}

/* ----------------------------------------------------------------- cache -- */

let cached2d = null;
let cached3d = null;

export function getTarget(dimension) {
  if (dimension === '3D') {
    if (!cached3d) cached3d = build3dTarget();
    return cached3d;
  }
  if (!cached2d) cached2d = build2dTarget();
  return cached2d;
}

export { fccToPyramid };
