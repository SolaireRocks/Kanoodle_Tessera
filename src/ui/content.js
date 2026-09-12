/**
 * The puzzle library (§9.1) — loaded once from content/puzzles.json, which is
 * generated and solver-validated by tools/generate-content.mjs.
 *
 * Content is versioned separately from the engine, so a puzzle pack can be
 * replaced without touching the rules core.
 */

import { makeRng, dailyKey, hashSeed } from '../core/rng.js';
import { store } from './store.js';

let library = null;
const byId = new Map();

export async function loadContent() {
  if (library) return library;
  const response = await fetch(new URL('../../content/puzzles.json', import.meta.url));
  if (!response.ok) throw new Error(`Could not load the puzzle library (${response.status}).`);
  library = await response.json();
  for (const track of library.tracks) {
    for (const tier of track.tiers) {
      for (const puzzle of tier.puzzles) {
        byId.set(puzzle.id, { puzzle, tier, track });
      }
    }
  }
  return library;
}

export const getLibrary = () => library;
export const lookup = (puzzleId) => byId.get(puzzleId) || null;
export const allTracks = () => library.tracks;
export const getTrack = (trackId) => library.tracks.find((t) => t.id === trackId) || null;
export const getTier = (trackId, tierId) =>
  getTrack(trackId)?.tiers.find((t) => t.id === tierId) || null;

/**
 * §9.2 — a tier opens once the previous tier has one solve (or locks are off).
 * A tier you have already played stays open regardless, so progress and lock
 * state can never contradict each other.
 */
export function isTierUnlocked(track, tier) {
  if (store.settings.noLocks) return true;
  const index = track.tiers.indexOf(tier);
  if (index <= 0) return true;
  if (tier.puzzles.some((p) => store.isSolved(p.id))) return true;
  return track.tiers[index - 1].puzzles.some((p) => store.isSolved(p.id));
}

export function tierProgress(tier) {
  const solved = tier.puzzles.filter((p) => store.isSolved(p.id)).length;
  return { solved, total: tier.puzzles.length };
}

export function trackProgress(track) {
  let solved = 0;
  let total = 0;
  for (const tier of track.tiers) {
    total += tier.puzzles.length;
    solved += tier.puzzles.filter((p) => store.isSolved(p.id)).length;
  }
  return { solved, total };
}

export function totalChallenges() {
  return library.total;
}

/** First unsolved puzzle in a tier, or the first one if the tier is complete. */
export function nextUnsolved(tier) {
  return tier.puzzles.find((p) => !store.isSolved(p.id)) || tier.puzzles[0];
}

/** The furthest unlocked tier that still has work in it. */
export function currentTier(track) {
  for (const tier of track.tiers) {
    if (!isTierUnlocked(track, tier)) break;
    if (tier.puzzles.some((p) => !store.isSolved(p.id))) return tier;
  }
  return track.tiers.find((t) => isTierUnlocked(track, t)) || track.tiers[0];
}

/**
 * §4 Daily Lattice — one deterministic challenge a day, the same for everyone,
 * rotating between the board and the pyramid. Reset is 06:00 UTC.
 */
export function dailyPuzzle(date = new Date()) {
  const key = dailyKey(date);
  const rng = makeRng(`tessera/daily/${key}`);
  const track = hashSeed(key) % 3 === 0 ? getTrack('pyramid') : getTrack('classic2d');
  const pool = track.tiers.flatMap((tier) =>
    tier.puzzles.filter(() => tier.remaining >= 3).map((puzzle) => ({ puzzle, tier, track })));
  const picked = pool[rng.int(pool.length)];
  return { ...picked, key, id: `daily-${key}` };
}

/** §4 Time Attack — a fixed-seed queue, ranked, no solver. */
export function timeAttackQueue(seedKey = dailyKey()) {
  const rng = makeRng(`tessera/timeattack/${seedKey}`);
  const track = getTrack('classic2d');
  const tiers = track.tiers.filter((t) => t.remaining >= 2 && t.remaining <= 5);
  const queue = [];
  for (const tier of tiers) {
    const puzzle = tier.puzzles[rng.int(tier.puzzles.length)];
    queue.push({ puzzle, tier, track });
  }
  // Par is a comfortable pace; the queue clock is deliberately tighter.
  const budgetMs = Math.round(queue.reduce((n, q) => n + q.tier.parMs, 0) * 0.7);
  return { key: seedKey, queue, budgetMs };
}

/**
 * Pace targets for the results and home panels.
 *
 * These are locally generated benchmarks derived from the puzzle's own par —
 * not other players, and labelled PACE in the UI so they are never mistaken
 * for a real leaderboard. Tessera ships without a server.
 */
export function paceTargets(puzzleId, parMs, yourMs = null) {
  const rng = makeRng(`tessera/pace/${puzzleId}`);
  const bots = [
    { name: 'pace · sprint', factor: 0.62 },
    { name: 'pace · steady', factor: 0.83 },
    { name: 'pace · par', factor: 1 }
  ].map((bot) => ({
    name: bot.name,
    ms: Math.round(parMs * bot.factor * (0.94 + rng() * 0.12)),
    bot: true
  }));

  const rows = [...bots];
  if (yourMs !== null) rows.push({ name: store.profile.handle, ms: yourMs, me: true });
  rows.sort((a, b) => a.ms - b.ms);
  return rows.map((row, i) => ({ ...row, rank: String(i + 1).padStart(2, '0') }));
}
