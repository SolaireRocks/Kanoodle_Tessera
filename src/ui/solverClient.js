/**
 * Promise-shaped access to the solver.
 *
 * Uses a module Worker so hints and full solves never block a drag (§12). If
 * the browser refuses to build one — opening index.html straight off disk is
 * the usual reason — it transparently falls back to running the same pure
 * module on the main thread, so the game still works, just less smoothly.
 */

let worker = null;
let fallback = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker !== null || fallback !== null) return;
  try {
    worker = new Worker(new URL('../workers/solver.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
}

async function ensureFallback() {
  if (!fallback) fallback = await import('../core/solver.js');
  return fallback;
}

const slim = (placement) => placement && ({
  piece: placement.piece,
  orientation: placement.orientation ?? 0,
  cells: placement.cells.slice()
});

async function runLocally(op, args) {
  const solver = await ensureFallback();
  switch (op) {
    case 'validate': {
      const { legal, complete, conflicts } = solver.validate(...args);
      return { legal, complete, conflicts };
    }
    case 'findOneSolution':
    case 'randomSolution': {
      const solution = solver[op](...args);
      return solution ? solution.map(slim) : null;
    }
    case 'recommendMove':
      return slim(solver.recommendMove(...args));
    case 'findConflictingMoves': {
      const result = solver.findConflictingMoves(...args);
      return result && {
        undoCount: result.undoCount,
        offending: result.offending.map(slim),
        setupUnsolvable: Boolean(result.setupUnsolvable)
      };
    }
    default:
      return solver[op](...args);
  }
}

function call(op, ...args) {
  ensureWorker();
  if (!worker) return runLocally(op, args);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

export const solverClient = {
  validate: (state) => call('validate', state),
  findOneSolution: (state) => call('findOneSolution', state),
  randomSolution: (state, seed) => call('randomSolution', state, seed),
  countSolutions: (state, limit = 2) => call('countSolutions', state, limit),
  /** Exact total: `{ count, exhausted }`. `exhausted: false` makes count a floor. */
  countAllSolutions: (state, options) => call('countAllSolutions', state, options),
  recommendMove: (state) => call('recommendMove', state),
  findConflictingMoves: (state) => call('findConflictingMoves', state),
  encodeChallenge: (state) => call('encodeChallenge', state),
  decodeChallenge: (code) => call('decodeChallenge', code),
  /** Warm the worker up so the first Hint is not paying for module startup. */
  warm() { ensureWorker(); }
};
