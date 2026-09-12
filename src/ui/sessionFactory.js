/**
 * Turns a route into a playable Session (§4 modes).
 *
 * The play screen only ever sees a Session plus a small `rules` object, so all
 * the mode-specific decisions — clock direction, whether Solve is offered,
 * what happens after a win — are made once, here.
 */

import { Session } from '../core/session.js';
import { makeRng, dailyKey } from '../core/rng.js';
import { encodeChallenge, decodeChallenge } from '../core/solver.js';
import { store } from './store.js';
import { lookup, dailyPuzzle, timeAttackQueue, getTrack, currentTier, nextUnsolved } from './content.js';

/** Time Attack keeps its queue alive across puzzles for one run. */
let timeAttackRun = null;

export const DEFAULT_RULES = {
  timer: 'up',
  allowHint: true,
  allowSolve: true,
  hintPenaltyMs: 15_000,
  budgetMs: 0,
  ghostMs: 0,
  ranked: false,
  demo: false,
  queue: null,
  backHref: '/home'
};

function classicSession(entry, overrides = {}) {
  const { puzzle, tier, track } = entry;
  return new Session({
    puzzleId: puzzle.id,
    dimension: track.dimension,
    locked: puzzle.locked,
    parMs: tier.parMs,
    mode: 'classic',
    title: `${tier.name} ${String(puzzle.order).padStart(2, '0')}`,
    subtitle: `${track.label} · ${tier.name.toUpperCase()} · PUZZLE ${String(puzzle.order).padStart(2, '0')}`,
    shortSubtitle: `${tier.name.toUpperCase()} · PUZZLE ${String(puzzle.order).padStart(2, '0')}`,
    ...overrides
  });
}

/** The puzzle id a free run carries until the player has chosen an opening. */
export const FREE_SETUP_ID = 'free-setup';

/**
 * Free runs are keyed by their opening, so two runs off the same first piece
 * share a best time and a replay link, and different openings do not.
 */
export function freePuzzleId(dimension, locked) {
  return `free-${encodeChallenge({ dimension, locked, placed: [] })}`;
}

/** A challenge code from the URL, or an empty setup when it is missing or bad. */
function openingFromCode(code) {
  if (!code) return [];
  try {
    const decoded = decodeChallenge(decodeURIComponent(code));
    return decoded.dimension === '2D' ? decoded.locked : [];
  } catch {
    return [];
  }
}

/**
 * @param {string[]} segments route tail after /play
 * @param {Record<string,string>} query
 * @returns {{session:Session, rules:object, entry:object|null}}
 */
export function buildPlay(segments, query = {}) {
  const key = segments[0];

  if (key === 'resume') {
    const saved = store.savedSession;
    const session = saved && Session.fromJSON(saved);
    if (!session) return null;
    return {
      session,
      entry: lookup(session.puzzleId),
      rules: { ...DEFAULT_RULES, ...(rulesForMode(session.mode) || {}) }
    };
  }

  if (key === 'daily') {
    const entry = dailyPuzzle();
    const session = classicSession(entry, {
      puzzleId: entry.id,
      mode: 'daily',
      title: 'Daily Lattice',
      subtitle: `DAILY LATTICE · ${entry.key}`,
      shortSubtitle: `DAILY · ${entry.tier.remaining} REMAINING`
    });
    return { session, entry, rules: { ...DEFAULT_RULES, allowSolve: false, ranked: true, backHref: '/home' } };
  }

  if (key === 'timeattack') {
    if (!timeAttackRun || query.restart === '1') {
      const built = timeAttackQueue();
      timeAttackRun = { ...built, index: 0, results: [], startedAt: null, remainingMs: built.budgetMs };
    }
    const entry = timeAttackRun.queue[timeAttackRun.index];
    if (!entry) { timeAttackRun = null; return buildPlay(['timeattack'], { restart: '1' }); }
    const session = classicSession(entry, {
      puzzleId: `ta-${timeAttackRun.key}-${timeAttackRun.index}`,
      mode: 'timeattack',
      title: `Time Attack ${timeAttackRun.index + 1}/${timeAttackRun.queue.length}`,
      subtitle: `TIME ATTACK · ${timeAttackRun.index + 1} OF ${timeAttackRun.queue.length}`,
      shortSubtitle: `TIME ATTACK ${timeAttackRun.index + 1}/${timeAttackRun.queue.length}`,
      allowAssist: false
    });
    return {
      session,
      entry,
      rules: {
        ...DEFAULT_RULES,
        timer: 'down',
        allowHint: false,
        allowSolve: false,
        ranked: true,
        budgetMs: timeAttackRun.remainingMs,
        queue: timeAttackRun,
        backHref: '/modes'
      }
    };
  }

  if (key === 'versus') {
    const day = dailyKey();
    const rng = makeRng(`tessera/versus/${day}`);
    const track = getTrack('classic2d');
    const tier = track.tiers[3 + rng.int(2)];
    const puzzle = tier.puzzles[rng.int(tier.puzzles.length)];
    const session = classicSession({ puzzle, tier, track }, {
      puzzleId: `vs-${day}`,
      mode: 'versus',
      title: 'Head to head',
      subtitle: `HEAD TO HEAD · ${tier.name.toUpperCase()}`,
      shortSubtitle: `VS PACE · ${tier.name.toUpperCase()}`,
      allowAssist: false
    });
    return {
      session,
      entry: { puzzle, tier, track },
      rules: {
        ...DEFAULT_RULES,
        allowSolve: false,
        allowHint: false,
        ranked: true,
        ghostMs: Math.round(tier.parMs * 0.78),
        backHref: '/modes'
      }
    };
  }

  if (key === 'zen') {
    const track = getTrack('classic2d');
    const rng = makeRng(`tessera/zen/${query.seed || Date.now()}`);
    const tier = track.tiers[2 + rng.int(4)];
    const puzzle = tier.puzzles[rng.int(tier.puzzles.length)];
    const session = classicSession({ puzzle, tier, track }, {
      puzzleId: `zen-${puzzle.id}`,
      mode: 'zen',
      parMs: 0,
      title: 'Zen',
      subtitle: `ZEN · ${tier.name.toUpperCase()}`,
      shortSubtitle: `ZEN · ${tier.name.toUpperCase()}`
    });
    return {
      session,
      entry: { puzzle, tier, track },
      rules: { ...DEFAULT_RULES, timer: 'none', hintPenaltyMs: 0, backHref: '/modes' }
    };
  }

  if (key === 'free') {
    // The opening is chosen on the play screen, so a fresh run starts with an
    // empty setup; a code in the URL replays a specific opening.
    const locked = openingFromCode(query.code);
    const session = new Session({
      puzzleId: locked.length ? freePuzzleId('2D', locked) : FREE_SETUP_ID,
      dimension: '2D',
      locked,
      parMs: 0,
      mode: 'free',
      title: 'Free mode',
      subtitle: locked.length ? `FREE MODE · OPENING ${locked[0].piece}` : 'FREE MODE · CHOOSE AN OPENING',
      shortSubtitle: locked.length ? `FREE · OPENING ${locked[0].piece}` : 'FREE · CHOOSE AN OPENING'
    });
    return {
      session,
      entry: null,
      rules: { ...DEFAULT_RULES, hintPenaltyMs: 0, backHref: '/modes' }
    };
  }

  if (key === 'setup') {
    // A tabletop opening, played on screen. The code carries the whole setup,
    // so this route works for both surfaces and needs no library entry.
    let decoded;
    try {
      decoded = decodeChallenge(decodeURIComponent(query.code || ''));
    } catch {
      return null;
    }
    const pieces = decoded.locked.length;
    const session = new Session({
      puzzleId: `setup-${encodeChallenge(decoded)}`,
      dimension: decoded.dimension,
      locked: decoded.locked,
      parMs: 0,
      mode: 'setup',
      title: 'Tabletop opening',
      subtitle: `TABLETOP · ${pieces} SET OUT · ${12 - pieces} TO PLACE`,
      shortSubtitle: `TABLETOP · ${12 - pieces} TO PLACE`
    });
    return {
      session,
      entry: null,
      rules: { ...DEFAULT_RULES, hintPenaltyMs: 0, backHref: '/tabletop' }
    };
  }

  if (key === 'lab') {
    const dimension = query.dim === '3D' ? '3D' : '2D';
    const session = new Session({
      puzzleId: `lab-${dimension}`,
      dimension,
      locked: [],
      parMs: 0,
      mode: 'lab',
      title: 'Solver Lab',
      subtitle: `SOLVER LAB · ${dimension === '3D' ? 'PYRAMID' : 'BOARD'}`,
      shortSubtitle: `SOLVER LAB · ${dimension === '3D' ? 'PYRAMID' : 'BOARD'}`
    });
    return {
      session,
      entry: null,
      rules: { ...DEFAULT_RULES, timer: 'none', hintPenaltyMs: 0, backHref: '/modes' }
    };
  }

  const entry = lookup(key);
  if (!entry) return null;
  const session = classicSession(entry);
  return {
    session,
    entry,
    rules: {
      ...DEFAULT_RULES,
      demo: query.demo === '1',
      backHref: `/levels/${entry.track.id}/${entry.tier.id}`
    }
  };
}

function rulesForMode(mode) {
  switch (mode) {
    case 'daily': return { allowSolve: false, ranked: true };
    case 'timeattack': return { timer: 'down', allowHint: false, allowSolve: false, ranked: true };
    case 'versus': return { allowHint: false, allowSolve: false, ranked: true };
    case 'zen': return { timer: 'none', hintPenaltyMs: 0 };
    case 'free': return { hintPenaltyMs: 0 };
    case 'setup': return { hintPenaltyMs: 0 };
    case 'lab': return { timer: 'none', hintPenaltyMs: 0 };
    default: return {};
  }
}

/** Where "Next puzzle" goes after a win. */
export function nextAfter(session, entry) {
  if (session.mode === 'timeattack' && timeAttackRun) {
    return timeAttackRun.index < timeAttackRun.queue.length ? '/play/timeattack' : '/modes';
  }
  if (session.mode === 'zen') return `/play/zen?seed=${Date.now()}`;
  if (session.mode === 'free') return '/play/free';
  if (session.mode === 'setup') return '/tabletop';
  if (session.mode === 'daily' || session.mode === 'versus') return '/home';
  if (!entry) return '/home';
  const following = entry.tier.puzzles.find((p) => p.order > entry.puzzle.order && !store.isSolved(p.id))
    || nextUnsolved(entry.tier);
  if (following && following.id !== entry.puzzle.id) return `/play/${following.id}`;
  const track = entry.track;
  const tier = currentTier(track);
  return `/levels/${track.id}/${tier.id}`;
}

/**
 * Where "Restart" and "Replay" go: back to the same puzzle for the campaigns,
 * and back to the generator for the modes whose puzzle id is not a library id.
 * Free mode carries its opening along so a replay starts from the same piece.
 */
export function restartHref(session) {
  switch (session.mode) {
    case 'daily': return '/play/daily';
    case 'timeattack': return '/play/timeattack?restart=1';
    case 'versus': return '/play/versus';
    case 'zen': return `/play/zen?seed=${Date.now()}`;
    case 'setup': return `/play/setup?code=${encodeURIComponent(encodeChallenge({
      dimension: session.dimension, locked: session.locked, placed: []
    }))}`;
    case 'free': return session.locked.length
      ? `/play/free?code=${encodeURIComponent(encodeChallenge({
        dimension: session.dimension, locked: session.locked, placed: []
      }))}`
      : '/play/free';
    default: return `/play/${session.puzzleId}`;
  }
}

export function advanceTimeAttack(result) {
  if (!timeAttackRun) return null;
  timeAttackRun.results.push(result);
  timeAttackRun.remainingMs = Math.max(0, timeAttackRun.remainingMs - result.timeMs);
  timeAttackRun.index += 1;
  return timeAttackRun;
}

export function clearTimeAttack() {
  timeAttackRun = null;
}

export const getTimeAttackRun = () => timeAttackRun;
