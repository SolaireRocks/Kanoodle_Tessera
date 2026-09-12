/**
 * Rules-core tests (§13 QA).
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PIECES, PIECE_BY_ID, TOTAL_BEADS, pyramidToFcc, fccToPyramid } from '../src/core/pieces.js';
import { getTarget, BOARD_ROWS, BOARD_COLS, PYRAMID_LAYERS, layerSize } from '../src/core/target.js';
import {
  validate, findOneSolution, randomSolution, countSolutions, countAllSolutions,
  solutionCountsByPlacement,
  recommendMove, findConflictingMoves, encodeChallenge, decodeChallenge,
  occupancyOf, candidatePlacements
} from '../src/core/solver.js';
import { Session } from '../src/core/session.js';
import { makeRng, dailyKey } from '../src/core/rng.js';

const here = dirname(fileURLToPath(import.meta.url));
const library = JSON.parse(readFileSync(resolve(here, '../content/puzzles.json'), 'utf8'));

/* ------------------------------------------------------------- registry -- */

test('the twelve pieces hold exactly 55 beads', () => {
  assert.equal(PIECES.length, 12);
  assert.equal(TOTAL_BEADS, 55);
  assert.equal(TOTAL_BEADS, BOARD_ROWS * BOARD_COLS);
});

test('bead counts match the design document figure', () => {
  const expected = { A: 4, B: 5, C: 5, D: 5, E: 5, F: 3, G: 5, H: 5, I: 5, J: 4, K: 4, L: 5 };
  for (const [id, beads] of Object.entries(expected)) {
    assert.equal(PIECE_BY_ID[id].beads, beads, `piece ${id}`);
  }
});

test('every piece is connected through orthogonal neighbours', () => {
  for (const piece of PIECES) {
    const cells = new Set(piece.canonicalCells.map(([r, c]) => `${r},${c}`));
    const queue = [piece.canonicalCells[0]];
    const seen = new Set([queue[0].join(',')]);
    while (queue.length) {
      const [r, c] = queue.pop();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${r + dr},${c + dc}`;
        if (cells.has(key) && !seen.has(key)) {
          seen.add(key);
          queue.push([r + dr, c + dc]);
        }
      }
    }
    assert.equal(seen.size, piece.beads, `piece ${piece.id} is disconnected`);
  }
});

test('orientation generation is closed under rotate, flip and tilt', () => {
  for (const piece of PIECES) {
    for (const orientation of piece.orientations2d) {
      assert.equal(piece.orientations2d[orientation.cw].ccw, orientation.index, `${piece.id} cw/ccw`);
      assert.equal(piece.orientations2d[orientation.mirror].mirror, orientation.index, `${piece.id} mirror`);
      assert.equal(orientation.cells.length, piece.beads);
    }
    for (const orientation of piece.orientations3d) {
      assert.equal(piece.orientations3d[orientation.mirror].mirror, orientation.index, `${piece.id} 3-D mirror`);
      assert.equal(orientation.cells.length, piece.beads);
    }
  }
});

/* ------------------------------------------------------------- geometry -- */

test('the pyramid lattice round-trips through FCC coordinates', () => {
  for (let layer = 0; layer < PYRAMID_LAYERS; layer++) {
    for (let row = 0; row < layerSize(layer); row++) {
      for (let col = 0; col < layerSize(layer); col++) {
        const [a, b, hh] = pyramidToFcc(layer, row, col);
        assert.equal((a + b + hh) % 2, 0, 'FCC parity');
        assert.deepEqual(fccToPyramid(a, b, hh), [layer, row, col]);
      }
    }
  }
});

test('the pyramid holds 55 sockets across five square layers', () => {
  const target = getTarget('3D');
  assert.equal(target.size, 55);
  assert.equal(target.cells.length, 55);
  assert.equal([25, 16, 9, 4, 1].reduce((a, b) => a + b), 55);
});

test('every generated placement is in bounds and the right size', () => {
  for (const dimension of ['2D', '3D']) {
    const target = getTarget(dimension);
    for (const placement of target.placements) {
      assert.equal(placement.cells.length, PIECE_BY_ID[placement.piece].beads);
      assert.equal(new Set(placement.cells).size, placement.cells.length, 'no repeated socket');
      for (const cell of placement.cells) {
        assert.ok(cell >= 0 && cell < target.size, `${dimension} socket ${cell} out of range`);
      }
    }
  }
});

/* --------------------------------------------------------------- solver -- */

test('the empty board and the empty pyramid can both be filled', () => {
  for (const dimension of ['2D', '3D']) {
    const solution = findOneSolution({ dimension, locked: [], placed: [] });
    assert.ok(solution, `${dimension} has no complete fill`);
    assert.equal(solution.length, 12);
    const covered = new Set(solution.flatMap((p) => p.cells));
    assert.equal(covered.size, 55, `${dimension} does not cover every socket`);
    assert.equal(new Set(solution.map((p) => p.piece)).size, 12, `${dimension} reuses a piece`);
  }
});

test('validate rejects overlaps, duplicates and out-of-bounds placements', () => {
  const overlap = validate({
    dimension: '2D',
    locked: [{ piece: 'K', cells: [0, 1, 11, 12] }, { piece: 'J', cells: [1, 2, 3, 4] }],
    placed: []
  });
  assert.equal(overlap.legal, false);
  assert.ok(overlap.conflicts.some((c) => c.type === 'overlap'));

  const duplicate = validate({
    dimension: '2D',
    locked: [{ piece: 'K', cells: [0, 1, 11, 12] }, { piece: 'K', cells: [2, 3, 13, 14] }],
    placed: []
  });
  assert.ok(duplicate.conflicts.some((c) => c.type === 'duplicate-piece'));

  const outside = validate({ dimension: '2D', locked: [{ piece: 'K', cells: [0, 1, 11, 999] }], placed: [] });
  assert.ok(outside.conflicts.some((c) => c.type === 'out-of-bounds'));
});

test('recommendMove always returns a placement that keeps the puzzle solvable', () => {
  const tier = library.tracks[0].tiers[4];           // Master, five remaining
  for (const puzzle of tier.puzzles.slice(0, 4)) {
    let state = { dimension: '2D', locked: puzzle.locked, placed: [] };
    for (let i = 0; i < tier.remaining; i++) {
      const move = recommendMove(state);
      assert.ok(move, `${puzzle.id} ran out of advice at step ${i}`);
      state = { ...state, placed: [...state.placed, move] };
      assert.ok(validate(state).legal, `${puzzle.id} step ${i} produced an illegal board`);
      assert.ok(findOneSolution(state), `${puzzle.id} step ${i} killed the puzzle`);
    }
    assert.equal(occupancyOf(state).emptyCells.length, 0, `${puzzle.id} not filled`);
  }
});

test('a wrong-but-legal move is detected and blamed on the player, not the setup', () => {
  const puzzle = library.tracks[0].tiers[5].puzzles[0];   // Genius, six remaining
  const base = { dimension: '2D', locked: puzzle.locked, placed: [] };
  const view = occupancyOf(base);
  const target = getTarget('2D');

  // Find a legal placement that is not part of any completion.
  let poison = null;
  for (const piece of view.remaining) {
    for (const placement of target.placementsByPiece[piece]) {
      if (placement.cells.some((cell) => view.owner[cell] !== null)) continue;
      const trial = { ...base, placed: [placement] };
      if (!findOneSolution(trial)) { poison = placement; break; }
    }
    if (poison) break;
  }
  assert.ok(poison, 'expected at least one legal dead-end move');

  const dead = { ...base, placed: [poison] };
  assert.equal(validate(dead).legal, true, 'the board itself is still legal');
  const conflict = findConflictingMoves(dead);
  assert.equal(conflict.undoCount, 1);
  assert.equal(conflict.setupUnsolvable, undefined);
  assert.equal(conflict.offending[0].piece, poison.piece);
});

test('countSolutions caps out and agrees with findOneSolution', () => {
  const puzzle = library.tracks[0].tiers[0].puzzles[0];
  const state = { dimension: '2D', locked: puzzle.locked, placed: [] };
  assert.ok(countSolutions(state, 2) >= 1);
  const complete = { dimension: '2D', locked: [], placed: findOneSolution({ dimension: '2D', locked: [], placed: [] }) };
  assert.equal(countSolutions(complete, 2), 1);
  assert.deepEqual(findOneSolution(complete), []);
});

test('countAllSolutions reports the exact total', () => {
  // Independent enumeration: plain backtracking over candidate placements,
  // sharing none of the dancing-links machinery it is checking.
  const bruteForce = (state) => {
    const view = occupancyOf(state);
    if (view.emptyCells.length === 0 && view.remaining.length === 0) return 1;
    // Branch on one fixed empty socket so each solution is reached once only.
    const socket = view.emptyCells[0];
    let total = 0;
    for (const placement of candidatePlacements(state, view)) {
      if (!placement.cells.includes(socket)) continue;
      total += bruteForce({ ...state, placed: [...state.placed, placement] });
    }
    return total;
  };

  for (const track of library.tracks) {
    const puzzle = track.tiers[1].puzzles[0];
    const state = { dimension: track.dimension, locked: puzzle.locked, placed: [] };
    const { count, exhausted } = countAllSolutions(state, { timeLimitMs: Infinity });
    assert.equal(exhausted, true, `${puzzle.id} search was cut short`);
    assert.equal(count, bruteForce(state), `${puzzle.id} exact count disagrees`);
    // The capped count is that same number seen through a ceiling.
    assert.equal(countSolutions(state, 2), Math.min(count, 2));
  }
});

test('countAllSolutions flags a search it could not finish', () => {
  const empty = { dimension: '2D', locked: [], placed: [] };
  const { count, exhausted } = countAllSolutions(empty, { budget: 5000 });
  assert.equal(exhausted, false);
  assert.ok(count >= 0);
  // A finished search over a solved board is exact and needs no budget at all.
  const complete = { dimension: '2D', locked: [], placed: findOneSolution(empty) };
  assert.deepEqual(countAllSolutions(complete), { count: 1, exhausted: true });
});

test('solutionCountsByPlacement splits the total across each piece', () => {
  for (const track of library.tracks) {
    const puzzle = track.tiers[1].puzzles[0];
    const state = { dimension: track.dimension, locked: puzzle.locked, placed: [] };
    const target = getTarget(track.dimension);

    const { counts, total, exhausted } = solutionCountsByPlacement(state);
    assert.equal(exhausted, true, `${puzzle.id} census was cut short`);
    assert.equal(total, countAllSolutions(state, { timeLimitMs: Infinity }).count);

    // Each solution uses every remaining piece exactly once, so that piece's
    // placements partition the solutions between them.
    const view = occupancyOf(state);
    for (const piece of view.remaining) {
      const sum = target.placementsByPiece[piece].reduce((n, pl) => n + counts[pl.id], 0);
      assert.equal(sum, total, `${puzzle.id} piece ${piece} does not partition the total`);
    }

    // And an individual entry is what the solver says about that one position.
    const live = candidatePlacements(state, view).filter((pl) => counts[pl.id] > 0);
    for (const placement of [live[0], live[live.length - 1]]) {
      const direct = countAllSolutions(
        { ...state, placed: [placement] },
        { timeLimitMs: Infinity }
      );
      assert.equal(direct.count, counts[placement.id], `${puzzle.id} ${placement.piece} entry disagrees`);
    }
  }
});

/* ----------------------------------------------------- challenge codes --- */

test('challenge codes round-trip and reject nonsense', () => {
  for (const track of library.tracks) {
    const puzzle = track.tiers[1].puzzles[0];
    const state = { dimension: track.dimension, locked: puzzle.locked, placed: [] };
    const code = encodeChallenge(state);
    const back = decodeChallenge(code);
    assert.equal(back.dimension, track.dimension);
    assert.equal(back.locked.length, puzzle.locked.length);
    assert.equal(encodeChallenge(back), code);
  }
  assert.throws(() => decodeChallenge('nope'));
  assert.throws(() => decodeChallenge('T9:2:A0.1.2.3'));
});

/* -------------------------------------------------------------- content -- */

test('the shipped library is 101 solvable, legal challenges', () => {
  let count = 0;
  for (const track of library.tracks) {
    for (const tier of track.tiers) {
      for (const puzzle of tier.puzzles) {
        const state = { dimension: track.dimension, locked: puzzle.locked, placed: [] };
        const result = validate(state);
        assert.equal(result.legal, true, `${puzzle.id} illegal`);
        assert.equal(result.view.remaining.length, tier.remaining, `${puzzle.id} wrong remaining count`);
        assert.ok(findOneSolution(state), `${puzzle.id} unsolvable`);
        count++;
      }
    }
  }
  assert.equal(count, 101);
  assert.equal(library.total, 101);
});

test('tiers are ordered easiest to hardest', () => {
  for (const track of library.tracks) {
    for (const tier of track.tiers) {
      const scores = tier.puzzles.map((p) => p.metrics.score);
      const sorted = [...scores].sort((a, b) => a - b);
      assert.deepEqual(scores, sorted, `${track.id}/${tier.id} out of order`);
    }
  }
});

/* -------------------------------------------------------------- session -- */

test('a session records, undoes, redoes and resets moves', () => {
  const puzzle = library.tracks[0].tiers[3].puzzles[0];
  const session = new Session({ puzzleId: puzzle.id, dimension: '2D', locked: puzzle.locked, parMs: 1000 });
  const solution = findOneSolution(session.toSolverState());

  assert.equal(session.remainingPieces().length, 4);
  assert.equal(session.place(solution[0]), true);
  assert.equal(session.place(solution[0]), false, 'a piece cannot be placed twice');
  assert.equal(session.moveCount, 1);

  session.undo();
  assert.equal(session.placed.length, 0);
  session.redo();
  assert.equal(session.placed.length, 1);

  session.reset();
  assert.equal(session.placed.length, 0);
  assert.equal(session.canUndo(), false);

  for (const placement of solution) session.place(placement);
  assert.equal(session.isComplete(), true);
  assert.equal(session.filledCount(), 55);
});

test('stars follow the assistance rules', () => {
  const puzzle = library.tracks[0].tiers[0].puzzles[0];
  const build = () => {
    const session = new Session({ puzzleId: puzzle.id, dimension: '2D', locked: puzzle.locked, parMs: 10 * 60_000 });
    for (const placement of findOneSolution(session.toSolverState())) session.place(placement);
    return session;
  };

  assert.equal(build().stars(), 3);

  const hinted = build();
  hinted.noteHint(0);
  assert.equal(hinted.stars(), 2);

  const solved = build();
  solved.noteSolve();
  assert.equal(solved.stars(), 1);
  assert.equal(solved.assisted, true);
});

test('a session survives a save and reload', () => {
  const puzzle = library.tracks[1].tiers[2].puzzles[0];
  const session = new Session({ puzzleId: puzzle.id, dimension: '3D', locked: puzzle.locked, parMs: 540_000 });
  const solution = findOneSolution(session.toSolverState());
  session.place(solution[0]);
  session.noteHint(15_000);

  const restored = Session.fromJSON(JSON.parse(JSON.stringify(session.toJSON())));
  assert.equal(restored.dimension, '3D');
  assert.equal(restored.placed.length, 1);
  assert.equal(restored.hintCount, 1);
  assert.equal(restored.filledCount(), session.filledCount());
  assert.equal(Session.fromJSON({ rulesVersion: 99 }), null);
});

/* ------------------------------------------------------------------ rng -- */

test('seeded randomness is stable and the daily key follows the 06:00 UTC reset', () => {
  const a = makeRng('seed');
  const b = makeRng('seed');
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);

  assert.equal(dailyKey(new Date('2026-09-04T05:59:00Z')), '2026-09-03');
  assert.equal(dailyKey(new Date('2026-09-04T06:01:00Z')), '2026-09-04');
});

test('a cancelled drag leaves the board and the history untouched', () => {
  const puzzle = library.tracks[0].tiers[3].puzzles[0];
  const session = new Session({ puzzleId: puzzle.id, dimension: '2D', locked: puzzle.locked });
  const solution = findOneSolution(session.toSolverState());
  session.place(solution[0]);

  const snapshot = JSON.stringify(session.placed);
  const historyLength = session.history.length;

  const held = session.pickUp(solution[0].piece);
  assert.ok(held, 'pickUp returned nothing');
  assert.equal(session.placed.length, 0);
  assert.equal(session.history.length, historyLength, 'pickUp must not record a move');

  session.putBack(held);
  assert.equal(JSON.stringify(session.placed), snapshot, 'the piece did not return intact');
  assert.equal(session.history.length, historyLength);
});

test('relocating a piece is one move, and undo returns it to where it was', () => {
  const puzzle = library.tracks[0].tiers[4].puzzles[0];   // Master, five remaining
  const session = new Session({ puzzleId: puzzle.id, dimension: '2D', locked: puzzle.locked });
  const solution = findOneSolution(session.toSolverState());
  session.place(solution[0]);
  const original = session.placed[0].cells.slice();
  const movesAfterPlace = session.moveCount;

  // Any other legal spot for the same piece.
  const target = getTarget('2D');
  const held = session.pickUp(solution[0].piece);
  const elsewhere = target.placementsByPiece[solution[0].piece]
    .find((p) => session.canPlace(p) && p.cells.join() !== original.join());
  assert.ok(elsewhere, 'no alternative position to move to');

  assert.equal(session.place(elsewhere, { from: held }), true);
  assert.equal(session.placed.length, 1);
  assert.equal(session.moveCount, movesAfterPlace + 1, 'a relocation is one move, not two');
  assert.notDeepEqual(session.placed[0].cells, original);

  session.undo();
  assert.equal(session.placed.length, 1, 'undo dropped the piece instead of moving it back');
  assert.deepEqual(session.placed[0].cells, original);

  session.redo();
  assert.deepEqual(session.placed[0].cells, elsewhere.cells.slice().sort((a, b) => a - b));
});

/* ------------------------------------------------------------ free mode -- */

test('a random fill varies with the seed and stays a legal complete fill', () => {
  const empty = { dimension: '2D', locked: [], placed: [] };
  const codes = new Set();

  for (let i = 0; i < 6; i++) {
    const solution = randomSolution(empty, `free/${i}`);
    assert.equal(solution.length, 12);
    const state = { dimension: '2D', locked: solution.map((p) => ({ piece: p.piece, cells: p.cells })), placed: [] };
    const check = validate(state);
    assert.ok(check.legal && check.complete, 'a rolled fill is a legal complete board');
    codes.add(encodeChallenge(state));
  }

  assert.ok(codes.size > 1, 'different seeds give different fills');
  assert.equal(encodeChallenge({
    dimension: '2D',
    locked: randomSolution(empty, 'free/0').map((p) => ({ piece: p.piece, cells: p.cells })),
    placed: []
  }), [...codes][0], 'the same seed gives the same fill');
});

test('every opening lifted out of a rolled fill is solvable on its own', () => {
  const solution = randomSolution({ dimension: '2D', locked: [], placed: [] }, 'free/opening');
  for (const placement of solution) {
    const opening = { piece: placement.piece, cells: placement.cells };
    assert.ok(
      findOneSolution({ dimension: '2D', locked: [opening], placed: [] }),
      `piece ${placement.piece} is a dead opening`
    );
  }
});

test('not every legal first placement is a legal opening', () => {
  // Free mode has to check, not assume: some single pieces strand the board.
  const board = getTarget('2D');
  const dead = board.placements.filter((placement, i) =>
    i % 11 === 0 && !findOneSolution({
      dimension: '2D',
      locked: [{ piece: placement.piece, cells: placement.cells }],
      placed: []
    }));
  assert.ok(dead.length > 0, 'the solvability check on an opening is not vacuous');
});

test('locking a free opening restarts the run around that piece', () => {
  const session = new Session({ puzzleId: 'free-setup', dimension: '2D', locked: [], mode: 'free' });
  const opening = randomSolution({ dimension: '2D', locked: [], placed: [] }, 'free/lock')[0];

  // Whatever the player did while choosing is discarded by the lock.
  session.place({ piece: opening.piece, cells: opening.cells, orientation: opening.orientation });
  session.noteHint(9000);
  assert.equal(session.moveCount, 1);

  session.lockSetup(opening);

  assert.deepEqual(session.locked, [{ piece: opening.piece, cells: [...opening.cells].sort((a, b) => a - b) }]);
  assert.equal(session.placed.length, 0);
  assert.equal(session.moveCount, 0);
  assert.equal(session.hintCount, 0);
  assert.equal(session.timeMs, 0);
  assert.equal(session.canUndo(), false);
  assert.equal(session.remainingPieces().length, 11);
  assert.ok(findOneSolution(session.toSolverState()), 'the locked opening is still solvable');

  // The opening is setup, not a player move: reset keeps it and undo cannot lift it.
  session.reset();
  assert.equal(session.filledCount(), opening.cells.length);
  assert.equal(session.remove(opening.piece), false);
});
