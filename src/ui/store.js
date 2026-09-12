/**
 * Local-first persistence (§10, §12).
 *
 * One profile object holds settings, per-puzzle progress, the rating, the
 * streak and any run in progress. It is written to localStorage after every
 * legal move so a refresh resumes exactly where the player was.
 *
 * Nothing here talks to a network. Rating and pace targets are computed on the
 * device, and the leaderboards in the UI are local pace bots, clearly labelled
 * as such rather than dressed up as other players.
 */

import { dailyKey } from '../core/rng.js';

const KEY = 'tessera.profile.v1';
export const PROFILE_VERSION = 1;
export const PALETTE_KEYS = ['ARENA', 'MUTED', 'DEUTER'];

const DEFAULT_SETTINGS = {
  palette: 'ARENA',
  highContrast: false,
  glyphs: false,
  reduceMotion: false,
  snap: true,
  showTimer: true,
  haptics: false,
  sound: false,
  noLocks: false
};

function blankProfile() {
  return {
    version: PROFILE_VERSION,
    createdAt: Date.now(),
    handle: 'you',
    settings: { ...DEFAULT_SETTINGS },
    progress: {},
    history: [],
    elo: 1200,
    streak: { count: 0, lastDay: null },
    session: null,
    tabletop: []
  };
}

/** Tabletop keeps a long tail — it is a logbook, not a recent-runs list. */
const MAX_TABLETOP_SETUPS = 120;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blankProfile();
    const parsed = JSON.parse(raw);
    if (parsed.version !== PROFILE_VERSION) return blankProfile();
    return {
      ...blankProfile(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      // Added after v1 shipped; a profile written before it simply has none.
      tabletop: Array.isArray(parsed.tabletop) ? parsed.tabletop : []
    };
  } catch {
    return blankProfile();
  }
}

export const RANKS = [
  { name: 'Bronze', floor: 0, ceiling: 1100 },
  { name: 'Silver', floor: 1100, ceiling: 1200 },
  { name: 'Gold', floor: 1200, ceiling: 1300 },
  { name: 'Platinum', floor: 1300, ceiling: 1400 },
  { name: 'Diamond II', floor: 1400, ceiling: 1450 },
  { name: 'Diamond I', floor: 1450, ceiling: 1500 },
  { name: 'Circuit', floor: 1500, ceiling: 1600 }
];

export function rankFor(elo) {
  return RANKS.find((r) => elo < r.ceiling) || RANKS[RANKS.length - 1];
}

class Store extends EventTarget {
  constructor() {
    super();
    this.profile = read();
    this.applyDocumentSettings();
  }

  get settings() { return this.profile.settings; }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.profile));
    } catch {
      /* Private-mode quota. The run stays playable, it just will not resume. */
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** Settings that the stylesheet reads off <html>. */
  applyDocumentSettings() {
    const { palette, highContrast, glyphs, reduceMotion } = this.settings;
    const root = document.documentElement;
    root.dataset.palette = palette;
    root.dataset.highContrast = highContrast ? 'on' : 'off';
    root.dataset.glyphs = glyphs ? 'on' : 'off';
    root.dataset.reduceMotion = reduceMotion ? 'on' : 'off';
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.applyDocumentSettings();
    this.save();
  }

  /* ------------------------------------------------------------ progress -- */

  progressFor(puzzleId) {
    return this.profile.progress[puzzleId] || null;
  }

  isSolved(puzzleId) {
    return Boolean(this.profile.progress[puzzleId]?.solved);
  }

  /**
   * Fold a finished run into the profile. Returns the deltas the completion
   * screen needs: rating change, whether it beat a previous best, and so on.
   */
  recordResult(result) {
    const previous = this.progressFor(result.puzzleId);
    const previousBest = previous?.bestMs ?? null;
    const isBest = result.stars > 0 && !result.assisted &&
      (previousBest === null || result.timeMs < previousBest);

    const entry = previous ? { ...previous } : { plays: 0, bestMs: null, stars: 0, solved: false };
    entry.plays += 1;
    entry.solved = true;
    entry.lastMs = result.timeMs;
    entry.stars = Math.max(entry.stars, result.stars);
    entry.assisted = Boolean(previous?.assisted) || result.assisted;
    entry.hints = result.hints;
    entry.solvedAt = result.at;
    if (!result.assisted && (entry.bestMs === null || result.timeMs < entry.bestMs)) {
      entry.bestMs = result.timeMs;
    }
    this.profile.progress[result.puzzleId] = entry;

    const eloDelta = ratingDelta(result);
    this.profile.elo = Math.max(600, Math.min(1600, this.profile.elo + eloDelta));

    const today = dailyKey(new Date(result.at));
    const streak = this.profile.streak;
    if (streak.lastDay !== today) {
      const yesterday = dailyKey(new Date(result.at - 24 * 3600 * 1000));
      streak.count = streak.lastDay === yesterday ? streak.count + 1 : 1;
      streak.lastDay = today;
    }

    this.profile.history.unshift({
      puzzleId: result.puzzleId,
      ms: result.timeMs,
      assisted: result.assisted,
      stars: result.stars,
      at: result.at
    });
    if (this.profile.history.length > 200) this.profile.history.length = 200;

    this.profile.session = null;
    this.save();

    return { eloDelta, isBest, previousBest, entry };
  }

  /* --------------------------------------------------------- saved run --- */

  saveSession(session) {
    this.profile.session = session ? session.toJSON() : null;
    this.save();
  }

  clearSession() {
    this.profile.session = null;
    this.save();
  }

  get savedSession() { return this.profile.session; }

  /* -------------------------------------------------------- tabletop log -- */

  /**
   * Openings generated for a physical set, newest first, each with the times
   * the player typed in after solving it away from the screen.
   *
   * These times are hand-entered and unverifiable, so they stay in their own
   * logbook: they never touch `progress`, the rating or the streak, which are
   * only ever moved by a run the engine actually watched.
   */
  get tabletopSetups() { return this.profile.tabletop; }

  tabletopSetup(id) {
    return this.profile.tabletop.find((entry) => entry.id === id) || null;
  }

  /** An existing setup with the same code is reused, so a re-roll of the same
   *  opening lands in one logbook entry rather than splitting its times. */
  saveTabletopSetup(setup) {
    const existing = this.profile.tabletop.find((entry) => entry.code === setup.code);
    if (existing) {
      this.profile.tabletop = [existing, ...this.profile.tabletop.filter((e) => e !== existing)];
      this.save();
      return existing;
    }
    const entry = {
      id: `tt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`,
      createdAt: Date.now(),
      dimension: setup.dimension,
      locked: setup.locked.map((p) => ({ piece: p.piece, cells: p.cells.slice() })),
      code: setup.code,
      seed: setup.seed || null,
      pinned: setup.pinned ? setup.pinned.slice() : [],
      label: setup.label || null,
      note: '',
      times: []
    };
    this.profile.tabletop.unshift(entry);
    if (this.profile.tabletop.length > MAX_TABLETOP_SETUPS) {
      this.profile.tabletop.length = MAX_TABLETOP_SETUPS;
    }
    this.save();
    return entry;
  }

  removeTabletopSetup(id) {
    const before = this.profile.tabletop.length;
    this.profile.tabletop = this.profile.tabletop.filter((entry) => entry.id !== id);
    if (this.profile.tabletop.length !== before) this.save();
  }

  setTabletopNote(id, note) {
    const entry = this.tabletopSetup(id);
    if (!entry) return null;
    entry.note = String(note || '').slice(0, 240);
    this.save();
    return entry;
  }

  /** @returns {{id:string, ms:number, at:number}|null} the recorded attempt */
  addTabletopTime(id, ms, { assisted = false } = {}) {
    const entry = this.tabletopSetup(id);
    if (!entry || !Number.isFinite(ms) || ms <= 0) return null;
    const time = {
      id: `t-${Date.now().toString(36)}-${entry.times.length}`,
      ms: Math.round(ms),
      at: Date.now(),
      assisted: Boolean(assisted)
    };
    entry.times.push(time);
    this.save();
    return time;
  }

  removeTabletopTime(id, timeId) {
    const entry = this.tabletopSetup(id);
    if (!entry) return;
    const before = entry.times.length;
    entry.times = entry.times.filter((time) => time.id !== timeId);
    if (entry.times.length !== before) this.save();
  }

  /** Headline numbers for the Stats screen. */
  tabletopSummary() {
    const setups = this.profile.tabletop;
    let solved = 0;
    let attempts = 0;
    let bestMs = null;
    for (const entry of setups) {
      if (entry.times.length) solved += 1;
      attempts += entry.times.length;
      for (const time of entry.times) {
        if (bestMs === null || time.ms < bestMs) bestMs = time.ms;
      }
    }
    return { setups: setups.length, solved, attempts, bestMs };
  }

  /* ------------------------------------------------------------- digests -- */

  weekStats() {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const runs = this.profile.history.filter((r) => r.at >= since);
    const clean = runs.filter((r) => !r.assisted);
    const avg = clean.length ? clean.reduce((n, r) => n + r.ms, 0) / clean.length : 0;
    const eloWeek = runs.reduce((n, r) => n + ratingDelta({ ...r, timeMs: r.ms, parMs: 0 }), 0);
    return {
      solved: runs.length,
      cleanRate: runs.length ? Math.round((clean.length / runs.length) * 100) : 0,
      avgMs: avg,
      eloDelta: eloWeek
    };
  }

  bestTime(dimension = null) {
    let best = null;
    for (const [, entry] of Object.entries(this.profile.progress)) {
      if (entry.bestMs === null || entry.bestMs === undefined) continue;
      if (best === null || entry.bestMs < best) best = entry.bestMs;
    }
    return best;
  }

  reset() {
    this.profile = blankProfile();
    this.applyDocumentSettings();
    this.save();
  }
}

/**
 * Rating movement: pace against par, muted for assisted runs. Deliberately
 * gentle — it is a personal progress signal, not a competitive ladder, because
 * there is no server to compare against.
 */
function ratingDelta(result) {
  if (result.assisted) return 0;
  if (!result.parMs) return 6;
  const ratio = (result.parMs - result.timeMs) / result.parMs;
  return Math.max(-18, Math.min(30, Math.round(20 * ratio + 8)));
}

export const store = new Store();
export { ratingDelta };
