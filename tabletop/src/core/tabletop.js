/**
 * Tabletop setups — openings meant to be copied onto a physical set.
 *
 * The digital game hands you an authored board; a physical polysphere set
 * hands you a bag of pieces and nothing else. This module bridges the two: it
 * picks which pieces make up an opening, lifts them out of a complete fill so
 * the rest is guaranteed to finish, and renders the result as coordinates and
 * ASCII you can read off a screen while your hands are on real beads.
 *
 * Pure and DOM-free, like the rest of `src/core`. The UI runs the fill through
 * the solver worker and then calls `setupFromSolution` here, so nothing on this
 * path blocks a frame.
 */

import { PIECE_IDS, PIECE_BY_ID } from './pieces.js';
import { makeRng } from './rng.js';
import { randomSolution } from './solver.js';
import {
  BOARD_ROWS, BOARD_COLS, boardRow, boardCol,
  PYRAMID_LAYERS, layerSize, pyramidCoords, pyramidIndex, boardIndex
} from './target.js';

/** One piece is the thinnest opening worth setting up; twelve leaves no puzzle. */
export const MIN_SETUP_PIECES = 1;
export const MAX_SETUP_PIECES = 11;

const ROW_LETTERS = 'ABCDE';

export const clampCount = (n) =>
  Math.max(MIN_SETUP_PIECES, Math.min(MAX_SETUP_PIECES, Math.round(Number(n) || 0)));

/* ------------------------------------------------------------ coordinates - */

/**
 * The shorthand the census report uses: `B3` on the board, `L1B3` in the
 * pyramid. Rows are lettered so a row and a column can never be confused when
 * they are read aloud across a table.
 */
export function socketName(dimension, index) {
  if (dimension === '3D') {
    const { layer, row, col } = pyramidCoords(index);
    return `L${layer + 1}${ROW_LETTERS[row]}${col + 1}`;
  }
  return `${ROW_LETTERS[boardRow(index)]}${boardCol(index) + 1}`;
}

/** Parse `B3` / `L1B3` back to a socket index, or null. */
export function socketIndex(dimension, name) {
  const text = String(name || '').trim().toUpperCase();
  if (dimension === '3D') {
    const match = /^L([1-5])([A-E])(\d{1,2})$/.exec(text);
    if (!match) return null;
    const layer = Number(match[1]) - 1;
    const row = ROW_LETTERS.indexOf(match[2]);
    const col = Number(match[3]) - 1;
    const n = layerSize(layer);
    if (row < 0 || row >= n || col < 0 || col >= n) return null;
    return pyramidIndex(layer, row, col);
  }
  const match = /^([A-E])(\d{1,2})$/.exec(text);
  if (!match) return null;
  const row = ROW_LETTERS.indexOf(match[1]);
  const col = Number(match[2]) - 1;
  if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) return null;
  return boardIndex(row, col);
}

/* --------------------------------------------------------- piece selection - */

/**
 * Which pieces the opening is made of.
 *
 * `pinned` pieces always appear — that is the "choose your pieces" half of the
 * feature — and the rest of the count is rolled from what is left, which is the
 * "random" half. Pinning exactly `count` pieces means the setup is exactly
 * those; pinning none means it is entirely rolled.
 *
 * @returns {string[]} piece ids in A–L order
 */
export function chooseSetupPieces({ count = 1, pinned = [], seed = 0 } = {}) {
  const wanted = clampCount(count);
  const keep = PIECE_IDS.filter((id) => pinned.includes(id)).slice(0, wanted);
  const pool = makeRng(`${seed}/pieces`).shuffle(PIECE_IDS.filter((id) => !keep.includes(id)));
  const chosen = new Set([...keep, ...pool.slice(0, wanted - keep.length)]);
  return PIECE_IDS.filter((id) => chosen.has(id));
}

/**
 * Keep the named pieces where a complete fill put them and throw the rest back
 * in the bag. Every piece appears exactly once in a fill, so any subset of one
 * is an opening the other pieces can still finish — solvable by construction,
 * the same guarantee `generate.js` gives the campaigns.
 */
export function setupFromSolution(solution, pieceIds) {
  const wanted = new Set(pieceIds);
  const locked = solution
    .filter((placement) => wanted.has(placement.piece))
    .map((placement) => ({
      piece: placement.piece,
      cells: placement.cells.slice().sort((a, b) => a - b)
    }))
    .sort((a, b) => a.piece.localeCompare(b.piece));
  if (locked.length !== wanted.size) {
    throw new Error('The fill did not contain every chosen piece.');
  }
  return locked;
}

/** A fresh seed, short enough to read out and type back in. */
export function newSeed() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

/**
 * Build a setup end to end. The UI uses the worker for the fill and calls the
 * two helpers above directly; this is the synchronous path, for tests and for
 * `tools/`.
 *
 * @param {{dimension?:'2D'|'3D', count?:number, pinned?:string[], seed?:string}} options
 */
export function buildSetup({ dimension = '2D', count = 1, pinned = [], seed = newSeed() } = {}) {
  const solution = randomSolution({ dimension, locked: [], placed: [] }, `tabletop/${seed}/fill`);
  if (!solution) throw new Error(`No complete fill exists for ${dimension}.`);
  const pieces = chooseSetupPieces({ count, pinned, seed });
  return {
    dimension,
    seed,
    pinned: PIECE_IDS.filter((id) => pinned.includes(id)),
    locked: setupFromSolution(solution, pieces)
  };
}

/* ------------------------------------------------------------- readable ---- */

/** Sockets a setup covers, as a piece id -> socket-name list. */
export function setupLines(setup) {
  return setup.locked.map((placement) => ({
    piece: placement.piece,
    beads: placement.cells.length,
    sockets: placement.cells.map((cell) => socketName(setup.dimension, cell))
  }));
}

const ownerMap = (setup) => {
  const owner = new Map();
  for (const placement of setup.locked) {
    for (const cell of placement.cells) owner.set(cell, placement.piece);
  }
  return owner;
};

/**
 * The opening as text: a lettered grid per surface, then a socket list.
 * Occupied sockets carry their piece letter, empty ones a dot — the same
 * shorthand the census report draws footprints in.
 */
export function setupDiagram(setup) {
  const owner = ownerMap(setup);
  const out = [];

  const grid = (label, rows, cols, cellIndex) => {
    if (label) out.push(label);
    // Three columns per socket, so a two-digit header still sits over its own
    // column instead of running into its neighbour.
    out.push(`   ${Array.from({ length: cols }, (_, c) => String(c + 1).padStart(3, ' ')).join('')}`);
    for (let r = 0; r < rows; r++) {
      const line = Array.from({ length: cols }, (_, c) => owner.get(cellIndex(r, c)) || '.');
      out.push(`  ${ROW_LETTERS[r]}${line.map((ch) => `  ${ch}`).join('')}`);
    }
  };

  if (setup.dimension === '3D') {
    for (let layer = 0; layer < PYRAMID_LAYERS; layer++) {
      const n = layerSize(layer);
      if (layer) out.push('');
      grid(`  LAYER ${layer + 1} (${n}x${n})`, n, n, (r, c) => pyramidIndex(layer, r, c));
    }
  } else {
    grid(null, BOARD_ROWS, BOARD_COLS, (r, c) => boardIndex(r, c));
  }
  return out.join('\n');
}

/**
 * The whole opening as one block of plain text — what "Copy setup" puts on the
 * clipboard and what prints. Everything needed to lay the pieces out is here,
 * so it survives being pasted into a notes app next to the physical set.
 */
export function setupText(setup, { label = 'Tabletop setup', code = null } = {}) {
  const remaining = 12 - setup.locked.length;
  const lines = [
    `TESSERA · ${label.toUpperCase()}`,
    `${setup.dimension === '3D' ? 'PYRAMID · 55 SOCKETS · 5 LAYERS' : 'BOARD · 5 x 11'}`,
    `Place these ${setup.locked.length} piece${setup.locked.length === 1 ? '' : 's'}, then fit the other ${remaining}.`,
    '',
    setupDiagram(setup),
    '',
    'SETUP PIECES'
  ];
  for (const line of setupLines(setup)) {
    lines.push(`  ${line.piece} (${line.beads})  ${line.sockets.join(' ')}`);
  }
  lines.push('', `TO PLACE  ${remainingPieces(setup).join(' ')}`);
  if (setup.seed) lines.push(`SEED  ${setup.seed}`);
  if (code) lines.push(`CODE  ${code}`);
  return lines.join('\n');
}

/** The pieces left in the bag, in A–L order. */
export function remainingPieces(setup) {
  const used = new Set(setup.locked.map((p) => p.piece));
  return PIECE_IDS.filter((id) => !used.has(id));
}

/** Beads still to be placed — the size of the hole the player is filling. */
export function remainingBeads(setup) {
  return remainingPieces(setup).reduce((n, id) => n + PIECE_BY_ID[id].beads, 0);
}

/* -------------------------------------------------------------- durations -- */

const CLOCK = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/;
const PLAIN = /^\d{1,6}(?:\.\d+)?$/;
// The trailing [a-z]* soaks up "hr" / "min" / "sec". It must not be \w*, which
// would swallow the digits of the next unit and silently drop them.
const WORDS = /^(?:(\d+(?:\.\d+)?)\s*h[a-z]*)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s)[a-z]*)?\s*(?:(\d+(?:\.\d+)?)\s*s[a-z]*)?$/;

/** Nothing above a day is a puzzle time; it is a typo. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Read a hand-typed time into milliseconds.
 *
 * Accepts `2:05`, `2:05.4`, `1:02:03`, bare seconds (`125`), and worded forms
 * (`2m 5s`, `1h30m`). Returns null for anything else, including zero and
 * negatives — a stopwatch reading of nothing is a mistyped entry, not a record.
 */
export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;

  const clock = CLOCK.exec(text);
  if (clock) {
    const [, h, m, s] = clock;
    const seconds = Number(s);
    if (seconds >= 60) return null;
    const ms = Math.round(((Number(h || 0) * 60 + Number(m)) * 60 + seconds) * 1000);
    return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
  }

  if (PLAIN.test(text)) {
    const ms = Math.round(Number(text) * 1000);
    return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
  }

  const words = WORDS.exec(text);
  if (words && words.slice(1).some((part) => part !== undefined)) {
    const [, h, m, s] = words;
    const ms = Math.round((Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0)) * 1000);
    return ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
  }

  return null;
}

/** m:ss, or h:mm:ss past the hour — the same shape `formatTime` renders. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours
    ? `${hours}:${pad(minutes)}:${pad(total % 60)}`
    : `${minutes}:${pad(total % 60)}`;
}

/** Best, worst, mean and spread over a run of attempts. */
export function timeStats(times = []) {
  const list = times.map((t) => t.ms).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!list.length) return { count: 0, bestMs: null, worstMs: null, meanMs: null, lastMs: null };
  const sorted = list.slice().sort((a, b) => a - b);
  return {
    count: list.length,
    bestMs: sorted[0],
    worstMs: sorted[sorted.length - 1],
    meanMs: Math.round(list.reduce((n, ms) => n + ms, 0) / list.length),
    lastMs: list[list.length - 1]
  };
}
