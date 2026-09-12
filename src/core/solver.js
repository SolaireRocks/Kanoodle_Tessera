/**
 * Rules core + solver.
 *
 * Pure, deterministic, DOM-free. Both the 2-D board and the 3-D pyramid reduce
 * to the same exact-cover problem:
 *
 *   columns = every empty socket, plus one "use me once" column per unplaced piece
 *   rows    = every legal placement of an unplaced piece on empty sockets
 *
 * which is solved with Algorithm X / Dancing Links. Because bead counts sum to
 * exactly 55, covering every socket and using every piece are the same
 * condition — but both column families are kept so partial states behave.
 */

import { PIECE_IDS, PIECE_BY_ID } from './pieces.js';
import { getTarget } from './target.js';
import { makeRng } from './rng.js';

/* ------------------------------------------------------- dancing links --- */

/**
 * @param {number} columnCount
 * @param {Array<{cols:number[], payload:*}>} rows
 * @param {{limit?:number, budget?:number, deadline?:number, countOnly?:boolean,
 *          onSolution?:(payloads:Array<*>)=>void}} options
 *   `countOnly` walks the whole tree without materialising any solution, which
 *   is what an exact count needs — keeping every solution would be the memory
 *   problem, not the search.
 *   `onSolution` sees each solution as it is found, which lets a caller reduce
 *   the whole solution set — a tally, a histogram — without storing any of it.
 *   The array it receives is reused between calls, so copy anything you keep.
 *   `exhausted` is false when the search stopped early (step budget or
 *   deadline), which makes the count a lower bound rather than the answer.
 * @returns {{solutions:Array<Array<*>>, count:number, exhausted:boolean}}
 */
function exactCover(columnCount, rows, { limit = 1, budget = 4e7, deadline = Infinity, countOnly = false, onSolution = null } = {}) {
  const nodeCount = rows.reduce((n, r) => n + r.cols.length, 0) + columnCount + 1;
  const L = new Int32Array(nodeCount);
  const R = new Int32Array(nodeCount);
  const U = new Int32Array(nodeCount);
  const D = new Int32Array(nodeCount);
  const COL = new Int32Array(nodeCount);
  const ROW = new Int32Array(nodeCount).fill(-1);
  const SIZE = new Int32Array(columnCount + 1);

  const head = 0;
  // Column headers occupy nodes 1..columnCount.
  for (let c = 1; c <= columnCount; c++) {
    L[c] = c - 1;
    R[c - 1] = c;
    U[c] = c;
    D[c] = c;
    COL[c] = c;
  }
  L[head] = columnCount;
  R[columnCount] = head;

  let next = columnCount + 1;
  for (let r = 0; r < rows.length; r++) {
    let first = -1;
    for (const rawCol of rows[r].cols) {
      const c = rawCol + 1;
      const node = next++;
      COL[node] = c;
      ROW[node] = r;
      // link vertically above the header
      U[node] = U[c];
      D[node] = c;
      D[U[c]] = node;
      U[c] = node;
      SIZE[c]++;
      // link horizontally
      if (first === -1) {
        first = node;
        L[node] = node;
        R[node] = node;
      } else {
        L[node] = L[first];
        R[node] = first;
        R[L[first]] = node;
        L[first] = node;
      }
    }
  }

  function cover(c) {
    R[L[c]] = R[c];
    L[R[c]] = L[c];
    for (let i = D[c]; i !== c; i = D[i]) {
      for (let j = R[i]; j !== i; j = R[j]) {
        D[U[j]] = D[j];
        U[D[j]] = U[j];
        SIZE[COL[j]]--;
      }
    }
  }

  function uncover(c) {
    for (let i = U[c]; i !== c; i = U[i]) {
      for (let j = L[i]; j !== i; j = L[j]) {
        SIZE[COL[j]]++;
        D[U[j]] = j;
        U[D[j]] = j;
      }
    }
    R[L[c]] = c;
    L[R[c]] = c;
  }

  const solutions = [];
  const stack = [];
  const found = [];   // reused buffer handed to onSolution
  let steps = 0;
  let count = 0;
  let exhausted = true;

  function search() {
    if (R[head] === head) {
      count++;
      if (onSolution) {
        found.length = 0;
        for (let k = 0; k < stack.length; k++) found.push(rows[ROW[stack[k]]].payload);
        onSolution(found);
      }
      if (!countOnly) solutions.push(stack.map((node) => rows[ROW[node]].payload));
      return count >= limit;
    }
    if (++steps > budget) { exhausted = false; return true; }
    // Date.now() is cheap but not free; a full count makes millions of steps.
    if ((steps & 0xffff) === 0 && Date.now() > deadline) { exhausted = false; return true; }

    // Knuth's S-heuristic: branch on the most constrained column.
    let best = -1;
    let bestSize = Infinity;
    for (let c = R[head]; c !== head; c = R[c]) {
      if (SIZE[c] < bestSize) { bestSize = SIZE[c]; best = c; }
      if (bestSize <= 1) break;
    }
    if (bestSize === 0) return false;

    cover(best);
    for (let i = D[best]; i !== best; i = D[i]) {
      stack.push(i);
      for (let j = R[i]; j !== i; j = R[j]) cover(COL[j]);
      if (search()) {
        for (let j = L[i]; j !== i; j = L[j]) uncover(COL[j]);
        stack.pop();
        uncover(best);
        return true;
      }
      for (let j = L[i]; j !== i; j = L[j]) uncover(COL[j]);
      stack.pop();
    }
    uncover(best);
    return false;
  }

  search();
  return { solutions, count, exhausted };
}

/* ------------------------------------------------------------- modelling -- */

/**
 * A state is the minimal description the engine needs:
 *   { dimension: '2D'|'3D', locked: Placement[], placed: Placement[] }
 * where a Placement is { piece, cells:number[], orientation? }.
 */
export function occupancyOf(state) {
  const target = getTarget(state.dimension);
  const owner = new Array(target.size).fill(null);
  const used = new Set();
  const conflicts = [];

  for (const source of ['locked', 'placed']) {
    for (const placement of state[source] || []) {
      if (used.has(placement.piece)) {
        conflicts.push({ type: 'duplicate-piece', piece: placement.piece });
      }
      used.add(placement.piece);
      const expected = PIECE_BY_ID[placement.piece]?.beads;
      if (expected !== placement.cells.length) {
        conflicts.push({ type: 'bad-bead-count', piece: placement.piece });
      }
      for (const cell of placement.cells) {
        if (cell < 0 || cell >= target.size) {
          conflicts.push({ type: 'out-of-bounds', piece: placement.piece, cell });
          continue;
        }
        if (owner[cell] !== null) {
          conflicts.push({ type: 'overlap', piece: placement.piece, cell, with: owner[cell] });
        }
        owner[cell] = placement.piece;
      }
    }
  }

  const remaining = PIECE_IDS.filter((id) => !used.has(id));
  const emptyCells = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] === null) emptyCells.push(i);

  return { target, owner, used, remaining, emptyCells, conflicts };
}

/** Candidate placements for the pieces still in hand that fit the empty sockets. */
export function candidatePlacements(state, view = occupancyOf(state)) {
  const { target, owner, remaining } = view;
  const out = [];
  for (const piece of remaining) {
    for (const placement of target.placementsByPiece[piece]) {
      let ok = true;
      for (const cell of placement.cells) {
        if (owner[cell] !== null) { ok = false; break; }
      }
      if (ok) out.push(placement);
    }
  }
  return out;
}

function buildMatrix(state, view = occupancyOf(state)) {
  const { emptyCells, remaining } = view;
  const cellColumn = new Map();
  emptyCells.forEach((cell, i) => cellColumn.set(cell, i));
  const pieceColumn = new Map();
  remaining.forEach((piece, i) => pieceColumn.set(piece, emptyCells.length + i));

  const rows = candidatePlacements(state, view).map((placement) => ({
    payload: placement,
    cols: [...placement.cells.map((cell) => cellColumn.get(cell)), pieceColumn.get(placement.piece)]
  }));

  return { columnCount: emptyCells.length + remaining.length, rows };
}

/* ----------------------------------------------------------- solver API --- */

/** §8.3 validate(state) — legality plus the reason when it is not legal. */
export function validate(state) {
  const view = occupancyOf(state);
  const conflicts = [...view.conflicts];
  const complete = view.emptyCells.length === 0 && view.remaining.length === 0;
  return { legal: conflicts.length === 0, complete, conflicts, view };
}

/**
 * §8.3 findOneSolution(state) — the placements that finish the puzzle, or null.
 * Pass `shuffle` (an in-place array shuffler, normally seeded) to vary which of
 * several valid solutions comes back; without it the result is deterministic.
 */
export function findOneSolution(state, options = {}) {
  const { shuffle, ...coverOptions } = options;
  const view = occupancyOf(state);
  if (view.conflicts.length) return null;
  if (view.emptyCells.length === 0 && view.remaining.length === 0) return [];
  const { columnCount, rows } = buildMatrix(state, view);
  if (shuffle) shuffle(rows);
  const { solutions } = exactCover(columnCount, rows, { limit: 1, ...coverOptions });
  return solutions[0] ?? null;
}

/**
 * One complete fill picked at random from all of them, by shuffling the search
 * order under a seed.
 *
 * Free mode uses it to choose an opening: any single placement lifted out of
 * the returned solution is solvable by construction, because the other eleven
 * placements finish the board from there.
 */
export function randomSolution(state, seed = Date.now()) {
  return findOneSolution(state, { shuffle: makeRng(seed).shuffle });
}

/** §8.3 countSolutions(state, limit) — capped count, for uniqueness checks. */
export function countSolutions(state, limit = 2, options = {}) {
  const view = occupancyOf(state);
  if (view.conflicts.length) return 0;
  if (view.emptyCells.length === 0 && view.remaining.length === 0) return 1;
  const { columnCount, rows } = buildMatrix(state, view);
  const { count } = exactCover(columnCount, rows, { limit, countOnly: true, ...options });
  return count;
}

/**
 * The exact number of distinct completions of a position — no cap, the whole
 * search tree. Solutions are counted, never kept, so the cost is time only.
 *
 * `exhausted` says whether the answer is final: on a wide-open board the tree
 * runs to hundreds of thousands of leaves, so the search stops at `budget`
 * steps or `timeLimitMs` milliseconds and `count` becomes a lower bound. Pass
 * `timeLimitMs: Infinity` (and a large `budget`) to insist on the true total.
 *
 * @returns {{count:number, exhausted:boolean}}
 */
export function countAllSolutions(state, { budget = 4e9, timeLimitMs = 15000 } = {}) {
  const view = occupancyOf(state);
  if (view.conflicts.length) return { count: 0, exhausted: true };
  if (view.emptyCells.length === 0 && view.remaining.length === 0) return { count: 1, exhausted: true };
  const { columnCount, rows } = buildMatrix(state, view);
  const { count, exhausted } = exactCover(columnCount, rows, {
    limit: Infinity,
    countOnly: true,
    budget,
    deadline: Number.isFinite(timeLimitMs) ? Date.now() + timeLimitMs : Infinity
  });
  return { count, exhausted };
}

/**
 * §8.3 recommendMove(state) — one placement from a real solution, chosen by a
 * stable heuristic so repeated hints on an unchanged board agree with
 * themselves: prefer the piece with the fewest legal placements left, then the
 * lowest piece id.
 */
export function recommendMove(state) {
  const solution = findOneSolution(state);
  if (!solution || solution.length === 0) return null;

  const view = occupancyOf(state);
  const freedom = new Map();
  for (const piece of view.remaining) freedom.set(piece, 0);
  for (const placement of candidatePlacements(state, view)) {
    freedom.set(placement.piece, (freedom.get(placement.piece) || 0) + 1);
  }

  return solution
    .slice()
    .sort((a, b) => (freedom.get(a.piece) - freedom.get(b.piece)) || a.piece.localeCompare(b.piece))[0];
}

/**
 * When the board is legal but dead, find the smallest suffix of the player's
 * own moves whose removal makes it solvable again. Locked setup pieces are
 * never blamed. Returns null when nothing recoverable is found.
 */
export function findConflictingMoves(state) {
  if (findOneSolution(state)) return null;
  const placed = state.placed || [];
  for (let keep = placed.length - 1; keep >= 0; keep--) {
    const trial = { ...state, placed: placed.slice(0, keep) };
    if (findOneSolution(trial)) {
      return { undoCount: placed.length - keep, offending: placed.slice(keep) };
    }
  }
  return { undoCount: placed.length, offending: placed.slice(), setupUnsolvable: placed.length === 0 };
}

/**
 * How many completions each individual placement takes part in.
 *
 * A single enumeration answers the question for every placement at once: each
 * solution names exactly one placement per piece, so tallying those names as
 * the search runs costs one walk of the tree rather than one walk per
 * placement. The tally is indexed by `placement.id`, dense over
 * `getTarget(dimension).placements`, and a placement that appears in no
 * solution simply stays at zero.
 *
 * Defaults run to completion, because a truncated walk would understate every
 * entry rather than just the total; `exhausted` reports whether it did.
 *
 * @returns {{counts:Float64Array, total:number, exhausted:boolean}}
 */
export function solutionCountsByPlacement(state, { budget = Infinity, timeLimitMs = Infinity, onProgress = null } = {}) {
  const view = occupancyOf(state);
  const target = view.target;
  const counts = new Float64Array(target.placements.length);
  if (view.conflicts.length) return { counts, total: 0, exhausted: true };
  if (view.emptyCells.length === 0 && view.remaining.length === 0) {
    for (const placement of [...(state.locked || []), ...(state.placed || [])]) {
      if (placement.id !== undefined) counts[placement.id] = 1;
    }
    return { counts, total: 1, exhausted: true };
  }

  const { columnCount, rows } = buildMatrix(state, view);
  let seen = 0;
  const { count, exhausted } = exactCover(columnCount, rows, {
    limit: Infinity,
    countOnly: true,
    budget,
    deadline: Number.isFinite(timeLimitMs) ? Date.now() + timeLimitMs : Infinity,
    onSolution: (placements) => {
      for (let i = 0; i < placements.length; i++) counts[placements[i].id]++;
      if (onProgress && (++seen & 0xffff) === 0) onProgress(seen);
    }
  });
  return { counts, total: count, exhausted };
}

/* --------------------------------------------------- challenge encoding --- */

/**
 * §10 — challenge codes carry canonical puzzle data and a rules version only.
 * Format: T1:<2|3>:<piece><cells joined by '.'>;... (base36 socket indices).
 */
export const RULES_VERSION = 1;

export function encodeChallenge(state) {
  const dim = state.dimension === '3D' ? '3' : '2';
  const body = (state.locked || [])
    .slice()
    .sort((a, b) => a.piece.localeCompare(b.piece))
    .map((p) => p.piece + p.cells.slice().sort((x, y) => x - y).map((c) => c.toString(36)).join('.'))
    .join(';');
  return `T${RULES_VERSION}:${dim}:${body}`;
}

export function decodeChallenge(code) {
  const match = /^T(\d+):([23]):(.*)$/.exec((code || '').trim());
  if (!match) throw new Error('Not a Tessera challenge code.');
  const [, version, dim, body] = match;
  if (Number(version) !== RULES_VERSION) throw new Error(`Challenge code is for rules v${version}.`);
  const locked = body
    ? body.split(';').filter(Boolean).map((chunk) => ({
      piece: chunk[0],
      cells: chunk.slice(1).split('.').filter(Boolean).map((c) => parseInt(c, 36))
    }))
    : [];
  const state = { dimension: dim === '3' ? '3D' : '2D', locked, placed: [] };
  const check = validate(state);
  if (!check.legal) throw new Error('Challenge code describes an illegal setup.');
  return state;
}
