/**
 * Puzzle generation (§8.3 generatePuzzle, §9.3 authoring).
 *
 * A puzzle is built the same way the physical game sets one up: take a complete
 * valid fill, then lift `remaining` pieces back off the board. Everything left
 * behind is the locked setup. That guarantees solvability by construction — the
 * solver then re-derives the difficulty metadata independently, so a rules
 * change can never leave a puzzle silently broken.
 */

import { PIECE_IDS } from './pieces.js';
import { makeRng } from './rng.js';
import {
  findOneSolution,
  countSolutions,
  candidatePlacements,
  occupancyOf,
  encodeChallenge
} from './solver.js';

/**
 * @param {'2D'|'3D'} dimension
 * @param {number} remaining  how many pieces the player must place (1–7)
 * @param {string|number} seed
 */
export function generatePuzzle(dimension, remaining, seed) {
  const rng = makeRng(seed);
  const full = findOneSolution({ dimension, locked: [], placed: [] }, { shuffle: rng.shuffle });
  if (!full) throw new Error(`No complete fill exists for ${dimension}.`);

  const byPiece = new Map(full.map((p) => [p.piece, p]));
  const lifted = rng.shuffle(PIECE_IDS.slice()).slice(0, remaining);
  const locked = PIECE_IDS
    .filter((id) => !lifted.includes(id))
    .map((id) => {
      const placement = byPiece.get(id);
      return { piece: id, cells: placement.cells.slice().sort((a, b) => a - b) };
    });

  const state = { dimension, locked, placed: [] };
  return { ...state, metrics: measure(state) };
}

/** Difficulty signals the level list and the Daily use to order puzzles. */
export function measure(state) {
  const view = occupancyOf(state);
  const candidates = candidatePlacements(state, view);
  const solutions = countSolutions(state, 6);
  const branching = view.remaining.length ? candidates.length / view.remaining.length : 0;
  // Fewer solutions and more candidate placements both mean more search.
  const score = Math.log2(1 + branching) * (view.remaining.length || 1) / Math.log2(1 + solutions * 2);
  return {
    remaining: view.remaining.length,
    candidates: candidates.length,
    solutions,           // capped at 6; 6 means "six or more"
    branching: Number(branching.toFixed(2)),
    score: Number(score.toFixed(3))
  };
}

/**
 * Build a tier's worth of puzzles, ordered easiest to hardest, rejecting the
 * degenerate ones (a setup with only a single legal placement per piece is not
 * a puzzle, it is a formality).
 */
export function generateTier({ dimension, remaining, count, seed, minCandidates = 0 }) {
  const puzzles = [];
  const seen = new Set();
  for (let attempt = 0; puzzles.length < count && attempt < count * 40; attempt++) {
    const puzzle = generatePuzzle(dimension, remaining, `${seed}:${attempt}`);
    if (puzzle.metrics.candidates < minCandidates) continue;
    const code = encodeChallenge(puzzle);
    if (seen.has(code)) continue;
    seen.add(code);
    puzzles.push({ ...puzzle, code });
  }
  if (puzzles.length < count) {
    throw new Error(`Only produced ${puzzles.length}/${count} puzzles for ${dimension} r${remaining}.`);
  }
  return puzzles.sort((a, b) => a.metrics.score - b.metrics.score);
}
