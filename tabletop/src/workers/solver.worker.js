/**
 * Solver worker (§12) — keeps exact-cover search off the main thread so a long
 * Solve never stalls a drag. Replies are plain structured-cloneable data; the
 * internal target/placement graph never crosses the boundary.
 */

import {
  validate,
  findOneSolution,
  randomSolution,
  countSolutions,
  countAllSolutions,
  recommendMove,
  findConflictingMoves,
  encodeChallenge,
  decodeChallenge
} from '../core/solver.js';

const slim = (placement) => placement && ({
  piece: placement.piece,
  orientation: placement.orientation ?? 0,
  cells: placement.cells.slice()
});

const ops = {
  validate(state) {
    const { legal, complete, conflicts } = validate(state);
    return { legal, complete, conflicts };
  },
  findOneSolution(state) {
    const solution = findOneSolution(state);
    return solution ? solution.map(slim) : null;
  },
  randomSolution(state, seed) {
    const solution = randomSolution(state, seed);
    return solution ? solution.map(slim) : null;
  },
  countSolutions(state, limit) {
    return countSolutions(state, limit);
  },
  countAllSolutions(state, options) {
    return countAllSolutions(state, options);
  },
  recommendMove(state) {
    return slim(recommendMove(state));
  },
  findConflictingMoves(state) {
    const result = findConflictingMoves(state);
    if (!result) return null;
    return {
      undoCount: result.undoCount,
      offending: result.offending.map(slim),
      setupUnsolvable: Boolean(result.setupUnsolvable)
    };
  },
  encodeChallenge,
  decodeChallenge
};

self.onmessage = (event) => {
  const { id, op, args = [] } = event.data || {};
  try {
    const handler = ops[op];
    if (!handler) throw new Error(`Unknown solver op "${op}".`);
    self.postMessage({ id, ok: true, result: handler(...args) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
