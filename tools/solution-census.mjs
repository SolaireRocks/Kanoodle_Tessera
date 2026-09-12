/**
 * Single-piece solution census.
 *
 *   node tools/solution-census.mjs                  # both targets
 *   node tools/solution-census.mjs --dim=2D         # just the 5x11 board
 *   node tools/solution-census.mjs --dim=3D         # just the pyramid
 *   node tools/solution-census.mjs --out=census     # where the reports go
 *
 * For one piece sitting alone on an otherwise empty target, how many ways can
 * the other eleven finish it? This asks that of every orientation of every
 * piece at every position it fits, and writes the answers grouped by piece,
 * highest first.
 *
 * It does not run the solver once per position. Every complete fill names
 * exactly one placement per piece, so a single enumeration of all complete
 * fills — tallying the placements each one uses — answers all ~1,800 positions
 * at once. `solutionCountsByPlacement` in the core does that walk; this file
 * is notation, sorting and paper.
 *
 * Two identities fall out of the method and are asserted before anything is
 * written: each piece's placement counts must sum to the target's total number
 * of complete fills, and a placement's count must match what the game's own
 * `countAllSolutions` says about that position. Both are checked below.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PIECES, PIECE_BY_ID, PIECE_IDS } from '../src/core/pieces.js';
import {
  getTarget, BOARD_ROWS, BOARD_COLS,
  boardRow, boardCol, pyramidCoords, pyramidIndex, layerSize
} from '../src/core/target.js';
import { solutionCountsByPlacement, countAllSolutions } from '../src/core/solver.js';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ args -- */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const dims = (() => {
  const want = (args.dim || 'both').toUpperCase();
  if (want === 'BOTH' || want === 'ALL') return ['3D', '2D'];   // cheap one first
  if (want === '2D' || want === '2') return ['2D'];
  if (want === '3D' || want === '3') return ['3D'];
  throw new Error(`--dim must be 2D, 3D or both (got ${args.dim})`);
})();

const outDir = resolve(here, '..', args.out || 'census');
const verifySamples = Number(args.verify ?? 6);

/* -------------------------------------------------------------- notation -- */

const ROW_LETTERS = 'ABCDEFGHIJ';

/**
 * Socket names.
 *
 *   2-D   <row letter><column>          B7   = row 2, column 7
 *   3-D   L<layer><row letter><column>  L1C4 = layer 1, row 3, column 4
 *
 * Rows are lettered from the top (2-D) or from the back of the layer (3-D),
 * columns numbered from 1 on the left, layers numbered from 1 at the base.
 */
function cellName(dimension, index) {
  if (dimension === '2D') return `${ROW_LETTERS[boardRow(index)]}${boardCol(index) + 1}`;
  const { layer, row, col } = pyramidCoords(index);
  return `L${layer + 1}${ROW_LETTERS[row]}${col + 1}`;
}

/** `A-o2@B3` — piece, orientation, and the first socket it covers. */
function placementCode(dimension, placement) {
  const anchor = Math.min(...placement.cells);
  return `${placement.piece}-o${placement.orientation}@${cellName(dimension, anchor)}`;
}

/** The whole 5x11 board on one line: rows separated by "|", "#" for the piece. */
function map2d(cells) {
  const filled = new Set(cells);
  const rows = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    let line = '';
    for (let c = 0; c < BOARD_COLS; c++) line += filled.has(r * BOARD_COLS + c) ? '#' : '.';
    rows.push(line);
  }
  return rows.join('|');
}

/** Only the layers the piece touches, each drawn as rows separated by "/". */
function map3d(cells) {
  const filled = new Set(cells);
  const touched = [...new Set(cells.map((i) => pyramidCoords(i).layer))].sort((a, b) => a - b);
  return touched.map((l) => {
    const n = layerSize(l);
    const rows = [];
    for (let r = 0; r < n; r++) {
      let line = '';
      for (let c = 0; c < n; c++) {
        line += filled.has(pyramidIndex(l, r, c)) ? '#' : '.';
      }
      rows.push(line);
    }
    return `L${l + 1}:${rows.join('/')}`;
  }).join('  ');
}

const mapOf = (dimension, cells) => (dimension === '2D' ? map2d(cells) : map3d(cells));

const num = (n) => n.toLocaleString('en-US');
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(3)}%` : '—');

/* ------------------------------------------------ 2-D orientation gallery -- */

/** Draw every 2-D orientation of every piece, so `o2` means something. */
function orientationKey2d() {
  const out = [];
  for (const piece of PIECES) {
    const blocks = piece.orientations2d.map((o) => {
      const filled = new Set(o.cells.map(([r, c]) => `${r},${c}`));
      const lines = [];
      for (let r = 0; r < o.rows; r++) {
        let line = '';
        for (let c = 0; c < o.cols; c++) line += filled.has(`${r},${c}`) ? '#' : '.';
        lines.push(line);
      }
      return { label: `o${o.index}`, lines };
    });

    out.push(`  ${piece.id}  (${piece.beads} beads, ${blocks.length} orientation${blocks.length === 1 ? '' : 's'})`);
    // Lay the orientations out side by side, six to a strip.
    for (let start = 0; start < blocks.length; start += 6) {
      const strip = blocks.slice(start, start + 6);
      const width = Math.max(...strip.map((b) => Math.max(b.label.length, ...b.lines.map((l) => l.length)))) + 3;
      const height = Math.max(...strip.map((b) => b.lines.length));
      out.push('    ' + strip.map((b) => b.label.padEnd(width)).join('').trimEnd());
      for (let r = 0; r < height; r++) {
        out.push('    ' + strip.map((b) => (b.lines[r] || '').padEnd(width)).join('').trimEnd());
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/* ----------------------------------------------------------------- census -- */

function census(dimension) {
  const target = getTarget(dimension);
  const started = Date.now();

  process.stderr.write(`\n[${dimension}] enumerating every complete fill of the empty target…\n`);
  const { counts, total, exhausted } = solutionCountsByPlacement(
    { dimension, locked: [], placed: [] },
    {
      onProgress: (seen) => {
        const secs = (Date.now() - started) / 1000;
        process.stderr.write(`\r[${dimension}]   ${num(seen)} fills · ${secs.toFixed(0)}s · ${num(Math.round(seen / secs))}/s   `);
      }
    }
  );
  const elapsed = (Date.now() - started) / 1000;
  process.stderr.write(`\r[${dimension}] ${num(total)} complete fills in ${elapsed.toFixed(1)}s (exhausted: ${exhausted})            \n`);

  if (!exhausted) throw new Error(`[${dimension}] search stopped early — every count would be a lower bound.`);

  const rows = target.placements.map((placement) => ({
    placement,
    piece: placement.piece,
    code: placementCode(dimension, placement),
    cells: placement.cells.slice().sort((a, b) => a - b),
    solutions: counts[placement.id]
  }));

  // Identity check: every complete fill uses exactly one placement of each
  // piece, so each piece's counts must sum to the target's total.
  for (const id of PIECE_IDS) {
    const sum = rows.filter((r) => r.piece === id).reduce((n, r) => n + r.solutions, 0);
    if (sum !== total) throw new Error(`[${dimension}] piece ${id} tallies ${sum}, expected ${total}`);
  }
  process.stderr.write(`[${dimension}] check: all twelve pieces tally to ${num(total)}\n`);

  // Spot check against the game's own countAllSolutions, on the cheapest
  // positions to re-derive (the ones with the fewest completions).
  const sample = [];
  const nonZero = rows.filter((r) => r.solutions > 0).sort((a, b) => a.solutions - b.solutions);
  const zero = rows.filter((r) => r.solutions === 0);
  sample.push(...nonZero.slice(0, Math.max(0, verifySamples - 2)));
  sample.push(...zero.slice(0, 2));
  for (const row of sample) {
    const direct = countAllSolutions(
      { dimension, locked: [row.placement], placed: [] },
      { budget: Infinity, timeLimitMs: Infinity }
    );
    if (!direct.exhausted || direct.count !== row.solutions) {
      throw new Error(`[${dimension}] ${row.code}: census says ${row.solutions}, solver says ${direct.count}`);
    }
  }
  if (sample.length) {
    process.stderr.write(`[${dimension}] check: ${sample.length} positions re-solved directly, all agree\n`);
  }

  return { dimension, target, rows, total, elapsed };
}

/* ----------------------------------------------------------------- report -- */

function report({ dimension, rows, total, elapsed }) {
  const is2d = dimension === '2D';
  const cellsWidth = is2d ? 20 : 26;
  const codeWidth = is2d ? 12 : 15;

  const line = (r, rank) => [
    String(rank).padStart(5),
    num(r.solutions).padStart(12),
    pct(r.solutions, total).padStart(9),
    '  ',
    r.code.padEnd(codeWidth),
    r.cells.map((c) => cellName(dimension, c)).join(' ').padEnd(cellsWidth),
    mapOf(dimension, r.cells)
  ].join(' ').trimEnd();

  const header = [
    ' rank', '   solutions', '    share', ' ', 'code'.padEnd(codeWidth),
    'sockets covered'.padEnd(cellsWidth), is2d ? 'board (rows A-E)' : 'layer maps'
  ].join(' ');

  const out = [];
  const push = (...s) => out.push(...s);

  const title = is2d ? '2-D BOARD — 5 rows x 11 columns' : '3-D PYRAMID — 5 layers, 5x5 base';
  push('='.repeat(78));
  push(`TESSERA — SINGLE-PIECE SOLUTION CENSUS`);
  push(title);
  push('='.repeat(78));
  push('');
  push('One piece is placed on an otherwise empty target and the remaining eleven');
  push('are asked to finish it. Every orientation of every piece, at every position');
  push('it fits, is listed below — grouped by piece, most solutions first.');
  push('');
  push(`Complete fills of the empty target : ${num(total)}`);
  push(`Positions examined                 : ${num(rows.length)}`);
  push(`Positions with no solution         : ${num(rows.filter((r) => r.solutions === 0).length)}`);
  push(`Enumeration time                   : ${elapsed.toFixed(1)}s`);
  push(`Generated                          : ${new Date().toISOString()}`);
  push('');
  push('Each piece\'s numbers sum to the total above: a complete fill uses every');
  push('piece exactly once, so the fills are partitioned by where that piece went.');
  push('Reflections and rotations of the whole target are counted separately, the');
  push('same way the game\'s own solver counts them.');
  push('');
  push('-'.repeat(78));
  push('HOW TO READ A POSITION');
  push('-'.repeat(78));
  push('');
  if (is2d) {
    push('Sockets are named <row letter><column number>. Rows A-E run top to bottom,');
    push('columns 1-11 run left to right, so B7 is row 2, column 7.');
    push('');
    push('  A-o2@B3   B3 B4 C3 D3   ...........|..##.......|..#........|..#........|...........');
    push('  |  |  |   |             |');
    push('  |  |  |   |             `- the board on one line: 5 rows of 11, "|" between');
    push('  |  |  |   |                rows, "#" a socket the piece covers, "." an empty one');
    push('  |  |  |   `- every socket the piece covers, in reading order');
    push('  |  |  `- the first of those sockets, which anchors the code');
    push('  |  `- which orientation of the piece (drawn in the key at the end)');
    push('  `- the piece');
  } else {
    push('Sockets are named L<layer><row letter><column number>. Layer 1 is the 5x5');
    push('base and layer 5 the single top bead; within a layer, rows are lettered from');
    push('A and columns numbered from 1. L1C4 is layer 1, row 3, column 4.');
    push('');
    push('  F-o7@L1A1   L1A1 L1A2 L1B1   L1:##.../#..../...../...../.....');
    push('  |  |  |     |                |');
    push('  |  |  |     |                `- only the layers the piece touches, each drawn');
    push('  |  |  |     |                   as its rows separated by "/", "#" for the piece');
    push('  |  |  |     `- every socket the piece covers, lowest layer first');
    push('  |  |  `- the first of those sockets, which anchors the code');
    push('  |  `- which of the piece\'s 3-D orientations (a signed permutation of the');
    push('  |     lattice axes; the socket list above is the authoritative description)');
    push('  `- the piece');
  }
  push('');
  push('A code is unique: no two positions of the same piece cover the same sockets.');
  push('');

  /* ------------------------------------------------------------- overall -- */

  const overall = rows.slice().sort((a, b) => b.solutions - a.solutions || a.code.localeCompare(b.code));
  push('='.repeat(78));
  push('TOP 40 POSITIONS OVERALL');
  push('='.repeat(78));
  push(header);
  overall.slice(0, 40).forEach((r, i) => push(line(r, i + 1)));
  push('');
  push('BOTTOM 20 POSITIONS OVERALL (excluding dead ones)');
  push('-'.repeat(78));
  push(header);
  const alive = overall.filter((r) => r.solutions > 0);
  alive.slice(-20).forEach((r) => push(line(r, alive.indexOf(r) + 1)));
  push('');

  /* --------------------------------------------------------- per-piece -- */

  for (const id of PIECE_IDS) {
    const piece = PIECE_BY_ID[id];
    const mine = rows
      .filter((r) => r.piece === id)
      .sort((a, b) => b.solutions - a.solutions || a.code.localeCompare(b.code));
    const live = mine.filter((r) => r.solutions > 0);
    const dead = mine.length - live.length;
    const best = live.length ? live[0].solutions : 0;
    const worst = live.length ? live[live.length - 1].solutions : 0;
    const mean = live.length ? total / live.length : 0;

    push('');
    push('='.repeat(78));
    const oriCount = (is2d ? piece.orientations2d : piece.orientations3d).length;
    push(`PIECE ${id}  ·  ${piece.beads} beads  ·  ${oriCount} orientation${oriCount === 1 ? '' : 's'}  ·  ${num(mine.length)} positions`);
    push('='.repeat(78));
    push(`  solvable positions ${num(live.length)}   ·   dead positions ${num(dead)}`);
    push(`  best ${num(best)}   ·   worst ${num(worst)}   ·   mean over solvable ${num(Math.round(mean))}   ·   sum ${num(total)}`);
    push('');
    push(header);
    mine.forEach((r, i) => push(line(r, i + 1)));
  }

  if (is2d) {
    push('');
    push('='.repeat(78));
    push('ORIENTATION KEY (2-D)');
    push('='.repeat(78));
    push('');
    push('Each orientation drawn in its own bounding box, "#" for a bead. These are');
    push('the o-numbers used in the codes above; duplicates under rotation and');
    push('reflection are collapsed, which is why some pieces have fewer than eight.');
    push('');
    push(orientationKey2d());
  }

  push('');
  return out.join('\n') + '\n';
}

function csv({ dimension, rows, total }) {
  const lines = ['dimension,piece,rank_within_piece,code,orientation,anchor,sockets,solutions,share_percent,dead'];
  for (const id of PIECE_IDS) {
    rows
      .filter((r) => r.piece === id)
      .sort((a, b) => b.solutions - a.solutions || a.code.localeCompare(b.code))
      .forEach((r, i) => {
        const sockets = r.cells.map((c) => cellName(dimension, c)).join(' ');
        const anchor = cellName(dimension, Math.min(...r.cells));
        const share = total ? ((r.solutions / total) * 100).toFixed(6) : '0';
        lines.push([
          dimension, id, i + 1, r.code, r.placement.orientation, anchor,
          `"${sockets}"`, r.solutions, share, r.solutions === 0 ? 'yes' : 'no'
        ].join(','));
      });
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ main -- */

mkdirSync(outDir, { recursive: true });

for (const dimension of dims) {
  const data = census(dimension);
  const stem = `solution-census-${dimension.toLowerCase()}`;
  const txt = join(outDir, `${stem}.txt`);
  const csvPath = join(outDir, `${stem}.csv`);
  writeFileSync(txt, report(data));
  writeFileSync(csvPath, csv(data));
  process.stderr.write(`[${dimension}] wrote ${txt}\n[${dimension}] wrote ${csvPath}\n`);
}
