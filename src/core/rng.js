/**
 * Deterministic pseudo-randomness.
 *
 * Everything seeded — puzzle generation, the Daily Lattice, pace bots — runs
 * through here so the same seed produces the same puzzle on every device and
 * every release, which is what §4 requires of the Daily.
 */

/** 32-bit string hash, used to turn a human seed like "daily-2026-09-04" into a number. */
export function hashSeed(input) {
  let h = 2166136261 >>> 0;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and stable across engines. */
export function makeRng(seed) {
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (max) => Math.floor(next() * max);
  next.pick = (list) => list[next.int(list.length)];
  next.shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = next.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  return next;
}

/** The Daily Lattice seed for a given date, keyed to the 06:00 UTC reset. */
export function dailyKey(date = new Date()) {
  const shifted = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
