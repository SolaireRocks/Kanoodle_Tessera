/**
 * Bakes content/puzzles.json — the 101-challenge library described in §9.1.
 *
 * Puzzles are generated (not transcribed from any published booklet, see §15),
 * validated by the solver, and shipped as versioned data so the engine and the
 * content can be released independently.
 *
 *   node tools/generate-content.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateTier } from '../src/core/generate.js';
import { validate, findOneSolution, decodeChallenge } from '../src/core/solver.js';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../content/puzzles.json');

const TRACKS = [
  {
    id: 'classic2d',
    dimension: '2D',
    name: 'Classic 2-D',
    label: 'CLASSIC 2-D',
    tiers: [
      { n: '01', id: 'rookie', name: 'Rookie', remaining: 1, count: 12, parMs: 80_000 },
      { n: '02', id: 'pro', name: 'Pro', remaining: 2, count: 12, parMs: 120_000 },
      { n: '03', id: 'ace', name: 'Ace', remaining: 3, count: 12, parMs: 220_000 },
      { n: '04', id: 'expert', name: 'Expert', remaining: 4, count: 12, parMs: 330_000 },
      { n: '05', id: 'master', name: 'Master', remaining: 5, count: 12, parMs: 450_000 },
      { n: '06', id: 'genius', name: 'Genius', remaining: 6, count: 12, parMs: 570_000 },
      { n: '07', id: 'circuit', name: 'Circuit', remaining: 7, count: 4, parMs: 720_000, quiz: true }
    ]
  },
  {
    id: 'pyramid',
    dimension: '3D',
    name: 'Pyramid',
    label: 'PYRAMID',
    tiers: [
      { n: '01', id: 'base', name: 'Base', remaining: 1, count: 6, parMs: 180_000 },
      { n: '02', id: 'rise', name: 'Rise', remaining: 2, count: 6, parMs: 360_000 },
      { n: '03', id: 'crown', name: 'Crown', remaining: 3, count: 6, parMs: 540_000 },
      { n: '04', id: 'apex', name: 'Apex', remaining: 4, count: 7, parMs: 720_000, quiz: true }
    ]
  }
];

const started = Date.now();
let total = 0;

const tracks = TRACKS.map((track) => ({
  id: track.id,
  dimension: track.dimension,
  name: track.name,
  label: track.label,
  tiers: track.tiers.map((tier) => {
    const t0 = Date.now();
    const puzzles = generateTier({
      dimension: track.dimension,
      remaining: tier.remaining,
      count: tier.count,
      seed: `tessera/${track.id}/${tier.id}`,
      minCandidates: tier.remaining >= 2 ? tier.remaining * 2 : 0
    }).map((puzzle, i) => {
      const id = `${track.id}-${tier.n}-${String(i + 1).padStart(2, '0')}`;
      return { id, order: i + 1, code: puzzle.code, locked: puzzle.locked, metrics: puzzle.metrics };
    });
    total += puzzles.length;
    process.stdout.write(
      `  ${track.id}/${tier.id}: ${puzzles.length} puzzles, ${tier.remaining} remaining, ` +
      `${Date.now() - t0}ms\n`
    );
    return {
      id: tier.id,
      n: tier.n,
      name: tier.name,
      remaining: tier.remaining,
      parMs: tier.parMs,
      quiz: Boolean(tier.quiz),
      puzzles
    };
  })
}));

/* --------------------------------------------------- validate everything -- */

let checked = 0;
for (const track of tracks) {
  for (const tier of track.tiers) {
    for (const puzzle of tier.puzzles) {
      const state = { dimension: track.dimension, locked: puzzle.locked, placed: [] };
      const result = validate(state);
      if (!result.legal) throw new Error(`${puzzle.id} is illegal: ${JSON.stringify(result.conflicts)}`);
      if (result.view.remaining.length !== tier.remaining) {
        throw new Error(`${puzzle.id} has ${result.view.remaining.length} remaining, expected ${tier.remaining}`);
      }
      if (!findOneSolution(state)) throw new Error(`${puzzle.id} is unsolvable`);
      const roundTrip = decodeChallenge(puzzle.code);
      if (roundTrip.locked.length !== puzzle.locked.length) {
        throw new Error(`${puzzle.id} challenge code does not round-trip`);
      }
      checked++;
    }
  }
}

const payload = {
  contentVersion: 1,
  rulesVersion: 1,
  generatedAt: new Date().toISOString(),
  total,
  tracks
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(payload, null, 1)}\n`);

console.log(`\nvalidated ${checked} puzzles · ${total} total · ${Date.now() - started}ms`);
console.log(`wrote ${outFile}`);
