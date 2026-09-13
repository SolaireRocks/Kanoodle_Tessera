/**
 * Getting the logbook off this device.
 *
 * The site is static and the log lives in one browser's localStorage, so export
 * is not a convenience here — it is the only backup, and the only way a time
 * recorded on the kitchen tablet ever reaches the laptop. Three shapes, because
 * they answer different questions:
 *
 *   JSON  the whole logbook, and the only format `Import` reads back
 *   CSV   one row per attempt, for a spreadsheet
 *   CSV   one row per opening, for a season-at-a-glance table
 *
 * Every field a spreadsheet might sort on is written twice — once human
 * (`2:05`) and once machine (`125.4` seconds) — so nothing has to be re-parsed
 * out of a clock string.
 */

import { formatDuration, remainingPieces, socketName, timeStats } from '../core/tabletop.js';
import { store } from './store.js';

/* ------------------------------------------------------------------- files */

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked on the next frame rather than immediately: Safari
 * has not started reading it when the click returns, and revoking too early
 * gives a silently empty file.
 */
export function downloadFile(filename, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return filename;
}

/** Read a picked file as text. */
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}

/** `2026-09-12-1431` — sorts chronologically in a downloads folder. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/* --------------------------------------------------------------------- csv */

/**
 * One CSV field. Anything with a comma, a quote or a newline is quoted, and
 * quotes are doubled — RFC 4180, which is what every spreadsheet reads.
 */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRows = (rows) => rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';

const surfaceOf = (entry) => (entry.dimension === '3D' ? 'pyramid' : 'board');

const titleOf = (entry) => {
  const n = entry.locked.length;
  return entry.label || `${entry.dimension === '3D' ? 'Pyramid' : 'Board'} · ${n} piece${n === 1 ? '' : 's'}`;
};

/** Where each setup piece sits, as `A:B3 B4 C4` — enough to rebuild by hand. */
const placementsOf = (entry) => entry.locked
  .map((p) => `${p.piece}:${p.cells.map((cell) => socketName(entry.dimension, cell)).join(' ')}`)
  .join('; ');

/**
 * Every attempt, newest opening first, oldest attempt first within an opening.
 * `attempt` counts within the opening so a personal-best streak is visible by
 * sorting on two columns.
 */
export function timesCsv(setups = store.setups) {
  const rows = [[
    'opening_id', 'opening', 'surface', 'setup_pieces', 'pieces_to_place',
    'seed', 'attempt', 'recorded_at', 'time', 'time_seconds', 'assisted',
    'is_personal_best', 'note', 'code'
  ]];

  for (const entry of setups) {
    const best = timeStats(entry.times).bestMs;
    entry.times.forEach((time, i) => {
      rows.push([
        entry.id,
        titleOf(entry),
        surfaceOf(entry),
        entry.locked.map((p) => p.piece).join(' '),
        12 - entry.locked.length,
        entry.seed || '',
        i + 1,
        new Date(time.at).toISOString(),
        formatDuration(time.ms),
        (time.ms / 1000).toFixed(2),
        time.assisted ? 'yes' : 'no',
        time.ms === best && !time.assisted ? 'yes' : 'no',
        entry.note || '',
        entry.code || ''
      ]);
    });
  }
  return csvRows(rows);
}

/** One row per opening: how it is made up, and how it has gone so far. */
export function openingsCsv(setups = store.setups) {
  const rows = [[
    'opening_id', 'opening', 'surface', 'created_at', 'seed',
    'setup_pieces', 'setup_beads', 'pieces_to_place', 'placements',
    'attempts', 'best', 'best_seconds', 'average', 'average_seconds',
    'last', 'last_seconds', 'note', 'code'
  ]];

  for (const entry of setups) {
    const stats = timeStats(entry.times);
    const setup = { dimension: entry.dimension, locked: entry.locked };
    rows.push([
      entry.id,
      titleOf(entry),
      surfaceOf(entry),
      new Date(entry.createdAt).toISOString(),
      entry.seed || '',
      entry.locked.map((p) => p.piece).join(' '),
      entry.locked.reduce((n, p) => n + p.cells.length, 0),
      remainingPieces(setup).join(' '),
      placementsOf(entry),
      stats.count,
      stats.bestMs === null ? '' : formatDuration(stats.bestMs),
      stats.bestMs === null ? '' : (stats.bestMs / 1000).toFixed(2),
      stats.meanMs === null ? '' : formatDuration(stats.meanMs),
      stats.meanMs === null ? '' : (stats.meanMs / 1000).toFixed(2),
      stats.lastMs === null ? '' : formatDuration(stats.lastMs),
      stats.lastMs === null ? '' : (stats.lastMs / 1000).toFixed(2),
      entry.note || '',
      entry.code || ''
    ]);
  }
  return csvRows(rows);
}

/* -------------------------------------------------------------------- text */

/** A plain-text digest of the whole logbook — readable pasted anywhere. */
export function logbookText(setups = store.setups) {
  const summary = store.summary();
  const lines = [
    'TESSERA · TABLETOP LOGBOOK',
    new Date().toLocaleString(),
    '',
    `${summary.openings} opening${summary.openings === 1 ? '' : 's'} · ` +
    `${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'} · ` +
    `best ${summary.bestMs === null ? '—' : formatDuration(summary.bestMs)}`,
    ''
  ];

  for (const entry of setups) {
    const stats = timeStats(entry.times);
    lines.push(`${titleOf(entry)}  [${entry.locked.map((p) => p.piece).join(' ')}]`);
    lines.push(`  seed ${entry.seed || '—'} · ${surfaceOf(entry)} · ${12 - entry.locked.length} to place`);
    lines.push(`  attempts ${stats.count}` +
      (stats.bestMs === null ? '' :
        ` · best ${formatDuration(stats.bestMs)}` +
        ` · avg ${formatDuration(stats.meanMs)}` +
        ` · last ${formatDuration(stats.lastMs)}`));
    for (const [i, time] of entry.times.entries()) {
      lines.push(`    #${i + 1}  ${new Date(time.at).toLocaleDateString()}  ${formatDuration(time.ms)}` +
        (time.assisted ? '  (assisted)' : ''));
    }
    if (entry.note) lines.push(`  note: ${entry.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ actions */

export const exportJson = () =>
  downloadFile(`tessera-tabletop-${stamp()}.json`,
    JSON.stringify(store.toBackup(), null, 2),
    'application/json;charset=utf-8');

export const exportTimesCsv = () =>
  downloadFile(`tessera-times-${stamp()}.csv`, timesCsv(), 'text/csv;charset=utf-8');

export const exportOpeningsCsv = () =>
  downloadFile(`tessera-openings-${stamp()}.csv`, openingsCsv(), 'text/csv;charset=utf-8');

export const exportText = () =>
  downloadFile(`tessera-logbook-${stamp()}.txt`, logbookText(), 'text/plain;charset=utf-8');

/** Sanity check used by the export buttons, so an empty file is never offered. */
export const hasTimes = () => store.setups.some((entry) => entry.times.length > 0);
