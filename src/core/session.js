/**
 * A single run of a single puzzle (§3.3 undo/redo/reset, §3.4 save & resume,
 * §10 GameState).
 *
 * The session owns the mutable truth for one attempt: which player pieces are
 * down, the move history, the clock, and the assistance flags that decide
 * whether the result counts as a clean solve. It never renders anything and it
 * never calls the solver — the UI does both.
 */

import { PIECE_IDS, PIECE_BY_ID } from './pieces.js';
import { getTarget } from './target.js';

export const RULES_VERSION = 1;

let uid = 0;

export class Session {
  constructor(config) {
    this.puzzleId = config.puzzleId;
    this.dimension = config.dimension;
    this.mode = config.mode || 'classic';
    this.parMs = config.parMs || 0;
    this.title = config.title || '';
    this.subtitle = config.subtitle || '';
    this.shortSubtitle = config.shortSubtitle || config.subtitle || '';
    this.allowAssist = config.allowAssist !== false;
    this.locked = (config.locked || []).map((p) => ({
      piece: p.piece,
      cells: p.cells.slice().sort((a, b) => a - b)
    }));

    this.placed = [];
    this.history = [];
    this.future = [];

    this.elapsedMs = 0;
    this.startedAt = null;
    this.hintCount = 0;
    this.hintPenaltyMs = 0;
    this.solveUsed = false;
    this.undoCount = 0;
    this.moveCount = 0;
    this.log = [];
    this.completedAt = null;
    this.rulesVersion = RULES_VERSION;
  }

  /* --------------------------------------------------------------- clock -- */

  start() {
    if (this.startedAt === null && !this.completedAt) this.startedAt = Date.now();
    return this;
  }

  pause() {
    if (this.startedAt !== null) {
      this.elapsedMs += Date.now() - this.startedAt;
      this.startedAt = null;
    }
    return this;
  }

  get running() { return this.startedAt !== null; }

  /** Wall-clock elapsed, including any hint time penalties. */
  get timeMs() {
    const live = this.startedAt === null ? 0 : Date.now() - this.startedAt;
    return this.elapsedMs + live + this.hintPenaltyMs;
  }

  /* ---------------------------------------------------------------- board -- */

  get target() { return getTarget(this.dimension); }

  /** socket index -> { piece, locked } for everything currently on the board. */
  occupancy() {
    const owner = new Array(this.target.size).fill(null);
    for (const p of this.locked) for (const c of p.cells) owner[c] = { piece: p.piece, locked: true };
    for (const p of this.placed) for (const c of p.cells) owner[c] = { piece: p.piece, locked: false };
    return owner;
  }

  usedPieces() {
    return new Set([...this.locked, ...this.placed].map((p) => p.piece));
  }

  remainingPieces() {
    const used = this.usedPieces();
    return PIECE_IDS.filter((id) => !used.has(id));
  }

  filledCount() {
    let n = 0;
    for (const p of this.locked) n += p.cells.length;
    for (const p of this.placed) n += p.cells.length;
    return n;
  }

  isComplete() {
    return this.filledCount() === this.target.size && this.remainingPieces().length === 0;
  }

  /** The plain state object the solver understands. */
  toSolverState() {
    return { dimension: this.dimension, locked: this.locked, placed: this.placed };
  }

  /** True when every socket of `placement` is free and the piece is in hand. */
  canPlace(placement) {
    if (!placement) return false;
    if (PIECE_BY_ID[placement.piece]?.beads !== placement.cells.length) return false;
    if (this.usedPieces().has(placement.piece)) return false;
    const owner = this.occupancy();
    for (const cell of placement.cells) {
      if (cell < 0 || cell >= this.target.size) return false;
      if (owner[cell] !== null) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- moves -- */

  /**
   * @param {{piece:string, cells:number[], orientation?:number}} placement
   * @param {{record?:boolean, source?:string, from?:{entry:object,index:number}}} options
   *   `from` marks this as a relocation of a piece already on the board, so
   *   undo returns it to where it was rather than to the tray.
   */
  place(placement, { record = true, source = 'player', from = null } = {}) {
    if (!this.canPlace(placement)) return false;
    const entry = {
      uid: ++uid,
      piece: placement.piece,
      orientation: placement.orientation ?? 0,
      cells: placement.cells.slice().sort((a, b) => a - b),
      source
    };
    this.placed.push(entry);
    if (record) {
      const where = this.target.describeCell(entry.cells[0]).toUpperCase();
      if (from) {
        this.history.push({ type: 'move', entry, from: from.entry, fromIndex: from.index });
        this.#log(`MOVE ${entry.piece} → ${where}`);
      } else {
        this.history.push({ type: 'place', entry });
        this.#log(`PIECE ${entry.piece} → ${where}`);
      }
      this.future.length = 0;
      this.moveCount++;
    }
    return true;
  }

  /**
   * §3.2 — lift a piece off the board without recording a move, for the
   * duration of a drag. Pair every pickUp with either a putBack (the release
   * was not legal) or a place({ from }) (it was).
   */
  pickUp(pieceId) {
    const index = this.placed.findIndex((p) => p.piece === pieceId);
    if (index === -1) return null;
    const [entry] = this.placed.splice(index, 1);
    return { entry, index };
  }

  /** Return a picked-up piece to exactly where it came from. */
  putBack(held) {
    if (!held) return false;
    this.placed.splice(Math.min(held.index, this.placed.length), 0, held.entry);
    return true;
  }

  /** Lift a player-placed piece back into the tray. Locked pieces never move. */
  remove(pieceId, { record = true } = {}) {
    const index = this.placed.findIndex((p) => p.piece === pieceId);
    if (index === -1) return false;
    const [entry] = this.placed.splice(index, 1);
    if (record) {
      this.history.push({ type: 'remove', entry, index });
      this.future.length = 0;
      this.moveCount++;
      this.#log(`LIFT ${entry.piece}`);
    }
    return true;
  }

  canUndo() { return this.history.length > 0; }
  canRedo() { return this.future.length > 0; }

  #drop(uid) {
    const i = this.placed.findIndex((p) => p.uid === uid);
    if (i !== -1) this.placed.splice(i, 1);
  }

  undo() {
    const action = this.history.pop();
    if (!action) return false;
    if (action.type === 'place') {
      this.#drop(action.entry.uid);
    } else if (action.type === 'move') {
      this.#drop(action.entry.uid);
      this.placed.splice(Math.min(action.fromIndex, this.placed.length), 0, action.from);
    } else {
      this.placed.splice(Math.min(action.index, this.placed.length), 0, action.entry);
    }
    this.future.push(action);
    this.undoCount++;
    this.#log('UNDO', true);
    return true;
  }

  redo() {
    const action = this.future.pop();
    if (!action) return false;
    if (action.type === 'place') {
      this.placed.push(action.entry);
    } else if (action.type === 'move') {
      this.#drop(action.from.uid);
      this.placed.push(action.entry);
    } else {
      this.#drop(action.entry.uid);
    }
    this.history.push(action);
    this.#log('REDO');
    return true;
  }

  /**
   * Free mode — promote one placement to the starting setup and begin the run
   * proper. Everything the player did while choosing an opening is discarded,
   * so the clock, the move log and the star rules all start from zero with the
   * chosen piece treated exactly like an authored locked piece.
   */
  lockSetup(placement) {
    this.locked = [{
      piece: placement.piece,
      cells: placement.cells.slice().sort((a, b) => a - b)
    }];
    this.placed = [];
    this.history = [];
    this.future = [];
    this.log = [];
    this.moveCount = 0;
    this.undoCount = 0;
    this.hintCount = 0;
    this.hintPenaltyMs = 0;
    this.elapsedMs = 0;
    this.startedAt = null;
    this.#log(`SETUP ${placement.piece}`);
    return this;
  }

  /** §3.3 — back to the authored starting setup. The clock keeps running. */
  reset() {
    this.placed = [];
    this.history = [];
    this.future = [];
    this.log = [];
    this.#log('RESET', true);
  }

  /** Drop the last `count` player moves — the "Undo conflict" recovery path. */
  undoMoves(count) {
    for (let i = 0; i < count && this.canUndo(); i++) this.undo();
  }

  #log(text, warn = false) {
    this.log.unshift({ text, ms: this.timeMs, warn });
    if (this.log.length > 40) this.log.length = 40;
  }

  noteHint(penaltyMs = 0) {
    this.hintCount++;
    this.hintPenaltyMs += penaltyMs;
    this.#log('HINT', true);
  }

  noteSolve() {
    this.solveUsed = true;
    this.#log('SOLVE', true);
  }

  /* ---------------------------------------------------------------- score -- */

  /** §9.2 — 1 star solved, 2 no Solve, 3 no Hint and inside par. */
  stars() {
    if (!this.isComplete()) return 0;
    let stars = 1;
    if (!this.solveUsed) stars = 2;
    if (!this.solveUsed && this.hintCount === 0 && (!this.parMs || this.timeMs <= this.parMs)) stars = 3;
    return stars;
  }

  get assisted() { return this.solveUsed; }

  finish() {
    this.pause();
    this.completedAt = Date.now();
    return {
      puzzleId: this.puzzleId,
      dimension: this.dimension,
      mode: this.mode,
      timeMs: this.timeMs,
      parMs: this.parMs,
      stars: this.stars(),
      assisted: this.assisted,
      hints: this.hintCount,
      undos: this.undoCount,
      moves: this.moveCount,
      at: this.completedAt
    };
  }

  /* ----------------------------------------------------- save and resume -- */

  toJSON() {
    return {
      rulesVersion: this.rulesVersion,
      puzzleId: this.puzzleId,
      dimension: this.dimension,
      mode: this.mode,
      parMs: this.parMs,
      title: this.title,
      subtitle: this.subtitle,
      shortSubtitle: this.shortSubtitle,
      allowAssist: this.allowAssist,
      locked: this.locked,
      placed: this.placed,
      history: this.history,
      future: this.future,
      elapsedMs: this.timeMs - this.hintPenaltyMs,
      hintCount: this.hintCount,
      hintPenaltyMs: this.hintPenaltyMs,
      solveUsed: this.solveUsed,
      undoCount: this.undoCount,
      moveCount: this.moveCount,
      log: this.log,
      updatedAt: Date.now()
    };
  }

  static fromJSON(data) {
    if (!data || data.rulesVersion !== RULES_VERSION) return null;
    const session = new Session(data);
    Object.assign(session, {
      placed: data.placed || [],
      history: data.history || [],
      future: data.future || [],
      elapsedMs: data.elapsedMs || 0,
      hintCount: data.hintCount || 0,
      hintPenaltyMs: data.hintPenaltyMs || 0,
      solveUsed: Boolean(data.solveUsed),
      undoCount: data.undoCount || 0,
      moveCount: data.moveCount || 0,
      log: data.log || []
    });
    for (const entry of session.placed) if (!entry.uid) entry.uid = ++uid;
    return session;
  }
}
