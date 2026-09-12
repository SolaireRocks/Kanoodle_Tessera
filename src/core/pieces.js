/**
 * Piece registry — the twelve immutable polysphere pieces (A–L).
 *
 * Canonical cells are transcribed from the design document's Figure 1
 * ("Digital Piece Registry (A-L)") as [row, col] pairs. Bead counts sum to 55,
 * which is both the 5x11 board and the 5-level pyramid.
 *
 * Colours and glyphs come from the Tessera UI palette (GameUI/Tessera.dc.html).
 *
 * Nothing in this module touches the DOM. It feeds rendering, validation,
 * hints and the solver alike.
 */

export const PIECE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

/** Arena palette — the default, taken verbatim from the UI design canvas. */
export const PALETTES = {
  ARENA: {
    A: '#FF4D6D', B: '#FF8A3D', C: '#FFD23F', D: '#8FD94B',
    E: '#29C7A6', F: '#35A7FF', G: '#7B6CFF', H: '#C86BFF',
    I: '#FF6FB5', J: '#B7E85A', K: '#E6E1D6', L: '#8A97A8'
  },
  MUTED: {
    A: '#C2606F', B: '#C58551', C: '#C4B060', D: '#8FA765',
    E: '#5C9E92', F: '#5D89AE', G: '#7C7BA8', H: '#9E7CAE',
    I: '#C08298', J: '#9DAE72', K: '#CFCABF', L: '#8A97A8'
  },
  // Deuteranopia-friendly: separated on the blue–yellow axis and by lightness.
  DEUTER: {
    A: '#8C2E00', B: '#D55E00', C: '#F0E442', D: '#B5A100',
    E: '#009E73', F: '#0072B2', G: '#3A3A98', H: '#7C4DA8',
    I: '#CC79A7', J: '#95D6C4', K: '#F2F2EA', L: '#7A8794'
  }
};

/**
 * Glyphs used when "Colour-blind symbols" is on. Each of the twelve pieces gets
 * a unique mark so colour is never the only channel.
 */
export const PIECE_GLYPHS = {
  A: '●', B: '▲', C: '■', D: '◆', E: '★', F: '✦',
  G: '▼', H: '⬢', I: '✚', J: '◗', K: '◐', L: '⬟'
};

const CANONICAL = {
  A: [[0, 1], [1, 1], [2, 0], [2, 1]],                 // 4 · J-tetromino
  B: [[0, 1], [1, 0], [1, 1], [2, 0], [2, 1]],         // 5 · P-pentomino
  C: [[0, 1], [1, 1], [2, 1], [3, 0], [3, 1]],         // 5 · L-pentomino
  D: [[0, 1], [1, 1], [2, 0], [2, 1], [3, 1]],         // 5 · Y-pentomino
  E: [[0, 1], [1, 1], [2, 0], [2, 1], [3, 0]],         // 5 · N-pentomino
  F: [[0, 1], [1, 0], [1, 1]],                         // 3 · L-tromino
  G: [[0, 2], [1, 2], [2, 0], [2, 1], [2, 2]],         // 5 · V-pentomino
  H: [[0, 2], [1, 1], [1, 2], [2, 0], [2, 1]],         // 5 · W-pentomino
  I: [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]],         // 5 · U-pentomino
  J: [[0, 0], [1, 0], [2, 0], [3, 0]],                 // 4 · I-tetromino
  K: [[0, 0], [0, 1], [1, 0], [1, 1]],                 // 4 · O-tetromino
  L: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]]          // 5 · X-pentomino
};

/* ------------------------------------------------------------------ 2-D --- */

/** The eight dihedral transforms of the square, as [r, c] -> [r', c']. */
const D4 = [
  ([r, c]) => [r, c],
  ([r, c]) => [c, -r],
  ([r, c]) => [-r, -c],
  ([r, c]) => [-c, r],
  ([r, c]) => [r, -c],
  ([r, c]) => [c, r],
  ([r, c]) => [-r, c],
  ([r, c]) => [-c, -r]
];

/** Shift a cell list so its minimum row and column are both zero, then sort. */
function normalize2d(cells) {
  let minR = Infinity;
  let minC = Infinity;
  for (const [r, c] of cells) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  return cells
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const key2d = (cells) => cells.map(([r, c]) => `${r},${c}`).join(' ');

function orientations2d(cells) {
  const seen = new Map();
  for (let t = 0; t < D4.length; t++) {
    const shape = normalize2d(cells.map(D4[t]));
    const k = key2d(shape);
    if (seen.has(k)) continue;
    let rows = 0;
    let cols = 0;
    for (const [r, c] of shape) {
      if (r + 1 > rows) rows = r + 1;
      if (c + 1 > cols) cols = c + 1;
    }
    seen.set(k, { cells: shape, rows, cols, flipped: t >= 4, index: seen.size });
  }

  const list = [...seen.values()];
  const indexOf = (shape) => seen.get(key2d(normalize2d(shape)))?.index ?? 0;
  // Precompute where Rotate and Flip land, so the buttons move between real
  // orientations rather than stepping blindly through a deduplicated list.
  for (const orientation of list) {
    orientation.cw = indexOf(orientation.cells.map(([r, c]) => [c, -r]));
    orientation.ccw = indexOf(orientation.cells.map(([r, c]) => [-c, r]));
    orientation.mirror = indexOf(orientation.cells.map(([r, c]) => [r, -c]));
  }
  return list;
}

/* ------------------------------------------------------------------ 3-D --- */

/**
 * Pyramid lattice coordinates.
 *
 * A bead at pyramid position (layer L, row r, col c) sits at world
 * (x, y, z) = (c + L/2, r + L/2, L / sqrt2) with unit bead spacing — each layer
 * nests half a bead into the dimples of the one below. That is face-centred
 * cubic packing, and it becomes a plain integer lattice under
 *
 *     a = r + c + L,   b = c - r,   h = L        (a + b + h is always even)
 *
 * in which the twelve nearest neighbours are exactly the vectors with two ±1s
 * and one 0. Every rotation and reflection of the piece set is therefore a
 * signed permutation of (a, b, h), which is what makes the 3-D solver possible.
 */
export function pyramidToFcc(layer, row, col) {
  return [row + col + layer, col - row, layer];
}

export function fccToPyramid(a, b, h) {
  const layer = h;
  const col = (a + b - h) / 2;
  const row = (a - b - h) / 2;
  return [layer, row, col];
}

/** The 48 signed permutations of three axes (24 rotations + 24 reflections). */
function signedPermutations() {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out = [];
  for (const p of perms) {
    for (let s = 0; s < 8; s++) {
      const sign = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
      out.push((v) => [sign[0] * v[p[0]], sign[1] * v[p[1]], sign[2] * v[p[2]]]);
    }
  }
  return out;
}

const SIGNED_PERMS = signedPermutations();

const sort3 = (cells) => cells.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

/**
 * Translation-independent key: express every cell relative to the sorted-first
 * cell. Two shapes share a key exactly when one is a translate of the other,
 * which is what we need because lattice translations are the placement axis.
 */
function key3d(cells) {
  const s = sort3(cells);
  const [a0, b0, h0] = s[0];
  return s.map(([a, b, h]) => `${a - a0},${b - b0},${h - h0}`).join(' ');
}

function orientations3d(cells2d) {
  const base = cells2d.map(([r, c]) => pyramidToFcc(0, r, c));
  const seen = new Map();
  for (const t of SIGNED_PERMS) {
    const shape = sort3(base.map(t));
    const [a0, b0, h0] = shape[0];
    const rel = shape.map(([a, b, h]) => [a - a0, b - b0, h - h0]);
    const k = rel.map((v) => v.join(',')).join(' ');
    if (seen.has(k)) continue;
    seen.set(k, { cells: rel, index: seen.size });
  }

  const list = [...seen.values()];
  const indexOf = (shape) => seen.get(key3d(shape))?.index ?? 0;
  for (const orientation of list) {
    // Yaw is a quarter turn about the vertical axis; tilt is a quarter turn
    // about a horizontal one; mirror flips the piece over. All three are signed
    // permutations, so all three stay on the lattice.
    orientation.yaw = indexOf(orientation.cells.map(([a, b, hh]) => [b, -a, hh]));
    orientation.tilt = indexOf(orientation.cells.map(([a, b, hh]) => [a, hh, -b]));
    orientation.mirror = indexOf(orientation.cells.map(([a, b, hh]) => [a, -b, hh]));
  }
  return list;
}

/* --------------------------------------------------------------- registry - */

/**
 * @typedef {Object} PieceDefinition
 * @property {string} id            A–L
 * @property {number[][]} canonicalCells
 * @property {number} beads
 * @property {string} glyph
 * @property {Array} orientations2d  unique 2-D orientations (rotations + flips)
 * @property {Array} orientations3d  unique 3-D orientations in FCC coordinates
 */
export const PIECES = PIECE_IDS.map((id) => {
  const canonicalCells = normalize2d(CANONICAL[id]);
  return {
    id,
    canonicalCells,
    beads: canonicalCells.length,
    glyph: PIECE_GLYPHS[id],
    orientations2d: orientations2d(canonicalCells),
    orientations3d: orientations3d(canonicalCells)
  };
});

export const PIECE_BY_ID = Object.fromEntries(PIECES.map((p) => [p.id, p]));

export const TOTAL_BEADS = PIECES.reduce((n, p) => n + p.beads, 0); // 55

export function pieceColor(id, paletteName = 'ARENA') {
  const palette = PALETTES[paletteName] || PALETTES.ARENA;
  return palette[id];
}

export { key3d, normalize2d };
