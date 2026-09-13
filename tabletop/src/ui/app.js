/**
 * Tessera Tabletop — the whole site.
 *
 * One screen, three panels, one loop: roll an opening, copy it onto the real
 * board, race it, type the time in. Everything the player has ever recorded
 * lives in this browser and leaves it only when they export.
 *
 * There is no router and no second screen, so the app is a set of paint
 * functions over live nodes rather than a framework — the same shape the parent
 * project's screens use, minus the parts a single page does not need.
 */

import { PIECE_IDS, PIECE_BY_ID, PALETTES } from '../core/pieces.js';
import {
  MIN_SETUP_PIECES, MAX_SETUP_PIECES, clampCount, newSeed,
  chooseSetupPieces, setupFromSolution, setupText,
  remainingPieces, remainingBeads, parseDuration, timeStats
} from '../core/tabletop.js';
import { h, clear, append, formatTime, announce } from './dom.js';
import { store, PALETTE_KEYS } from './store.js';
import { solverClient } from './solverClient.js';
import { toast, confirmSheet, sheet, promptSheet } from './dialog.js';
import { setupSheet, setupLegend, remainingStrip } from './setupSheet.js';
import { colorOf } from './colors.js';
import {
  exportJson, exportTimesCsv, exportOpeningsCsv, exportText,
  readTextFile, hasTimes, logbookText
} from './exporters.js';

/* ---------------------------------------------------------------- state -- */

/** Generator options, kept across rolls. */
const options = {
  dimension: '2D',
  count: 1,
  pick: 'random',
  pinned: new Set(),
  seed: ''
};

/** Which opening the detail panel is showing. */
let openId = null;

/** Logbook filter: 'all' | '2D' | '3D' | 'untimed'. */
let filter = 'all';

let busy = false;

/**
 * One stopwatch for the whole page, not one per opening — it is a wall clock,
 * so it keeps running while you flip through the logbook and saves to whichever
 * opening is on screen when you stop.
 */
const clock = {
  running: false,
  startedAt: 0,
  elapsed: 0,
  node: null,
  timer: null
};

const clockMs = () => clock.elapsed + (clock.running ? performance.now() - clock.startedAt : 0);

const COUNTS = Array.from(
  { length: MAX_SETUP_PIECES - MIN_SETUP_PIECES + 1 },
  (_, i) => i + MIN_SETUP_PIECES
);

const dimensionLabel = (dimension) => (dimension === '3D' ? 'Pyramid' : 'Board');

/** "Board · 3 pieces" — how a logged opening names itself when unlabelled. */
function entryTitle(entry) {
  const n = entry.locked.length;
  return entry.label || `${dimensionLabel(entry.dimension)} · ${n} piece${n === 1 ? '' : 's'}`;
}

const entryPieces = (entry) => entry.locked.map((p) => p.piece).join('');

const setupOf = (entry) => ({ dimension: entry.dimension, locked: entry.locked, seed: entry.seed });

/* ------------------------------------------------------------ live nodes -- */

const nodes = {
  generator: h('div', { class: 'stack', style: { gap: '18px' } }),
  detail: h('div', { class: 'stack', style: { gap: '18px' } }),
  listHead: h('div', { class: 'eyebrow', text: 'LOGBOOK' }),
  list: h('div', { class: 'stack', style: { gap: '9px' } }),
  filters: h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter the logbook' }),
  summary: h('div', { class: 'tstats tstats--wide' }),
  data: h('div', { class: 'stack', style: { gap: '10px' } })
};

/* ------------------------------------------------------------- fragments -- */

function segmented(items, current, onPick, { label, host = null } = {}) {
  const buttons = items.map((item) => h('button', {
    class: `seg__btn${item.value === current ? ' is-active' : ''}`,
    type: 'button',
    'aria-pressed': item.value === current ? 'true' : 'false',
    onClick: () => onPick(item.value)
  }, h('span', { text: item.label })));

  if (host) return append(clear(host), buttons);
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || undefined }, ...buttons);
}

const statTile = (label, value, accent = false) => h('div', { class: 'tstat' },
  h('div', { class: 'tstat__label', text: label }),
  h('div', { class: 'tstat__value', style: accent ? { color: 'var(--accent)' } : null, text: value }));

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // No clipboard permission, or an insecure origin. Showing the text is a
    // worse answer than copying it, but it is better than silence.
    toast('Clipboard is blocked here — the sheet is open instead, select and copy.', { warn: true });
    sheet({
      title: 'Copy this',
      body: h('textarea', {
        class: 'tinput tinput--area',
        rows: '12',
        readonly: 'true',
        onFocus: (event) => event.target.select()
      }, text),
      actions: [{ label: 'Done', value: null, variant: 'primary' }]
    });
  }
}

/* ------------------------------------------------------------ generating -- */

async function generate() {
  if (busy) return;
  busy = true;
  paintGenerator();

  const seed = options.seed.trim() || newSeed();
  const dimension = options.dimension;
  const pinned = options.pick === 'choose' ? [...options.pinned] : [];
  const count = clampCount(Math.max(options.count, pinned.length));

  try {
    // The fill goes through the worker: a pyramid fill is real search, and a
    // frozen button is a worse answer than a slightly later one.
    const solution = await solverClient.randomSolution(
      { dimension, locked: [], placed: [] },
      `tabletop/${seed}/fill`
    );
    if (!solution?.length) throw new Error('The solver could not produce a complete fill.');

    const locked = setupFromSolution(solution, chooseSetupPieces({ count, pinned, seed }));
    const code = await solverClient.encodeChallenge({ dimension, locked, placed: [] });
    const entry = store.saveSetup({ dimension, locked, code, seed, pinned });

    openId = entry.id;
    options.seed = '';
    toast(`${dimensionLabel(dimension)} opening: ${locked.map((p) => p.piece).join(' ')}.`);
    announce(`New ${dimensionLabel(dimension).toLowerCase()} opening with ${locked.length} ` +
      `piece${locked.length === 1 ? '' : 's'}: ${locked.map((p) => p.piece).join(', ')}. ` +
      `${12 - locked.length} pieces left to fit.`);
  } catch (error) {
    toast(error.message || 'Could not build that opening.', { warn: true });
  } finally {
    busy = false;
    paintAll();
  }
}

/** Add an opening someone else rolled, from its challenge code. */
async function addFromCode() {
  const code = await promptSheet({
    title: 'Add an opening from a code',
    body: 'Paste a Tessera challenge code — the one "Copy code" puts on the clipboard.',
    placeholder: 'T1:2:A0.1.11.12;…',
    confirmLabel: 'Add'
  });
  if (!code) return;
  try {
    const state = await solverClient.decodeChallenge(code);
    if (!state.locked.length) throw new Error('That code has no setup pieces in it.');
    if (state.locked.length > MAX_SETUP_PIECES) throw new Error('That code leaves nothing to solve.');
    const solvable = await solverClient.countSolutions(state, 1);
    if (!solvable) throw new Error('That opening cannot be finished with the remaining pieces.');
    const entry = store.saveSetup({
      dimension: state.dimension,
      locked: state.locked,
      code: await solverClient.encodeChallenge(state),
      seed: null,
      pinned: []
    });
    openId = entry.id;
    toast('Opening added to the logbook.');
    paintAll();
  } catch (error) {
    toast(error.message || 'That is not a usable challenge code.', { warn: true });
  }
}

/* ------------------------------------------------------ generator panel --- */

function countRow() {
  return h('div', { class: 'numrow' }, ...COUNTS.map((n) => h('button', {
    class: `numchip${n === options.count ? ' is-active' : ''}`,
    type: 'button',
    disabled: busy || (options.pick === 'choose' && n < options.pinned.size),
    'aria-pressed': n === options.count ? 'true' : 'false',
    'aria-label': `${n} starting piece${n === 1 ? '' : 's'}`,
    text: String(n),
    onClick: () => { options.count = n; paintGenerator(); }
  })));
}

function pieceGrid() {
  const active = options.pick === 'choose';
  return h('div', { class: `piecepick${active ? '' : ' is-off'}` },
    ...PIECE_IDS.map((id) => {
      const on = options.pinned.has(id);
      return h('button', {
        class: `piecepick__btn${on ? ' is-on' : ''}`,
        type: 'button',
        disabled: busy || !active,
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': `Piece ${id}, ${PIECE_BY_ID[id].beads} beads`,
        style: { '--c': colorOf(id) },
        onClick: () => {
          if (on) options.pinned.delete(id);
          else if (options.pinned.size >= MAX_SETUP_PIECES) {
            toast(`An opening tops out at ${MAX_SETUP_PIECES} pieces.`, { warn: true });
            return;
          } else options.pinned.add(id);
          if (options.pinned.size > options.count) options.count = options.pinned.size;
          paintGenerator();
        }
      },
      h('span', { class: 'piecepick__id', text: id }),
      h('span', { class: 'piecepick__beads', text: String(PIECE_BY_ID[id].beads) }));
    }));
}

function paintGenerator() {
  const chosen = options.pick === 'choose' ? options.pinned.size : 0;
  const count = clampCount(Math.max(options.count, chosen));
  options.count = count;

  const seedInput = h('input', {
    class: 'tinput',
    type: 'text',
    value: options.seed,
    placeholder: 'auto',
    'aria-label': 'Seed',
    spellcheck: 'false',
    disabled: busy,
    onInput: (event) => { options.seed = event.target.value; }
  });

  append(clear(nodes.generator), [
    h('div', null,
      h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px' }, text: 'SURFACE' }),
      segmented([
        { value: '2D', label: 'Board · 5 × 11' },
        { value: '3D', label: 'Pyramid · 5 layers' }
      ], options.dimension, (value) => { options.dimension = value; paintGenerator(); },
      { label: 'Surface' })),

    h('div', null,
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px' } },
        h('div', { class: 'eyebrow accent tight', text: 'STARTING PIECES' }),
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--dim)' },
          text: `${12 - count} TO PLACE` })),
      countRow(),
      h('div', { class: 'tnote', style: { marginTop: '9px' },
        text: `${count} piece${count === 1 ? '' : 's'} set out for you, ${12 - count} left in the bag.` })),

    h('div', null,
      h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px' }, text: 'WHICH PIECES' }),
      segmented([
        { value: 'random', label: 'Random' },
        { value: 'choose', label: 'Choose' }
      ], options.pick, (value) => { options.pick = value; paintGenerator(); }, { label: 'Which pieces' }),
      h('div', { class: 'tnote', style: { margin: '10px 0' },
        text: options.pick === 'choose'
          ? (chosen >= count
            ? `The opening is exactly ${[...options.pinned].sort().join(', ')}.`
            : `${chosen || 'No'} piece${chosen === 1 ? '' : 's'} pinned; the other ${count - chosen} will be rolled.`)
          : 'The engine picks the pieces and where they land.' }),
      pieceGrid()),

    h('div', null,
      h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px' }, text: 'SEED' }),
      seedInput,
      h('div', { class: 'tnote', style: { marginTop: '9px' },
        text: 'Leave it empty for a fresh roll. Re-enter a seed to rebuild the same opening.' })),

    h('button', {
      class: 'btn btn--primary',
      type: 'button',
      disabled: busy,
      onClick: generate
    },
    h('span', { text: busy ? 'Rolling…' : 'Generate opening' }),
    h('span', { class: 'kbd', text: `${count} / 12` })),

    h('button', {
      class: 'btn btn--dashed btn--xs',
      type: 'button',
      disabled: busy,
      text: 'Add one from a challenge code',
      onClick: addFromCode
    })
  ]);
}

/* ---------------------------------------------------------- the stopwatch - */

function renderClock() {
  if (!clock.node) return;
  const ms = clockMs();
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const face = `${hours ? `${hours}:` : ''}${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  clock.node.textContent = `${face}.${Math.floor((ms % 1000) / 100)}`;
}

function startClockTimer() {
  if (clock.timer) return;
  // Ten frames a second: the tenths column is the only thing moving, and a
  // rAF loop would keep a phone's screen busy for no extra information.
  clock.timer = setInterval(renderClock, 100);
}

function stopClockTimer() {
  clearInterval(clock.timer);
  clock.timer = null;
}

function toggleClock() {
  if (clock.running) {
    clock.elapsed = clockMs();
    clock.running = false;
    stopClockTimer();
    announce(`Stopped at ${formatTime(clock.elapsed)}.`);
  } else {
    clock.startedAt = performance.now();
    clock.running = true;
    startClockTimer();
    announce('Timing.');
  }
  renderClock();
  paintDetail();
}

function resetClock({ repaint = true } = {}) {
  clock.running = false;
  clock.elapsed = 0;
  stopClockTimer();
  renderClock();
  if (repaint) paintDetail();
}

function stopwatchPanel(entry) {
  const ms = clockMs();
  const face = h('div', { class: 'sw__face mono', 'aria-hidden': 'true' });
  clock.node = face;
  renderClock();
  if (clock.running) startClockTimer();

  const settled = !clock.running && ms > 0;

  return h('div', { class: `sw${clock.running ? ' is-running' : ''}` },
    h('div', { class: 'sw__head' },
      h('div', { class: 'eyebrow accent tight', text: clock.running ? 'TIMING' : 'STOPWATCH' }),
      h('div', { class: 'tnote', text: 'Space starts and stops it.' })),
    face,
    h('div', { class: 'sw__actions' },
      h('button', {
        class: `btn btn--${clock.running ? 'ghost' : 'primary'} btn--xs`,
        type: 'button',
        text: clock.running ? 'Stop' : (ms > 0 ? 'Resume' : 'Start'),
        onClick: toggleClock
      }),
      settled
        ? h('button', {
          class: 'btn btn--soft btn--xs',
          type: 'button',
          text: `Save ${formatTime(ms)}`,
          onClick: () => { saveTime(entry, ms); resetClock({ repaint: false }); paintAll(); }
        })
        : null,
      ms > 0
        ? h('button', { class: 'btn btn--ghost btn--xs', type: 'button', text: 'Reset', onClick: () => resetClock() })
        : null));
}

/* --------------------------------------------------------------- times ---- */

/** One place records an attempt, so the announcement and the toast never drift. */
function saveTime(entry, ms, { assisted = false } = {}) {
  const previousBest = timeStats(entry.times).bestMs;
  store.addTime(entry.id, ms, { assisted });
  const beatIt = !assisted && previousBest !== null && ms < previousBest;
  toast(beatIt ? `New best: ${formatTime(ms)}.` : `Saved ${formatTime(ms)}.`);
  announce(`${formatTime(ms)} saved for ${entryTitle(entry)}.` +
    (beatIt ? ' That is a new best for this opening.' : ''));
}

function timesPanel(entry) {
  const stats = timeStats(entry.times);
  const best = stats.bestMs;

  const input = h('input', {
    class: 'tinput',
    type: 'text',
    inputmode: 'numeric',
    placeholder: 'mm:ss',
    'aria-label': 'Your time for this opening',
    spellcheck: 'false'
  });

  const assisted = h('input', { type: 'checkbox', id: `tt-assist-${entry.id}` });

  const submit = () => {
    const ms = parseDuration(input.value);
    if (ms === null) {
      toast('Enter a time like 2:05, 1:02:30 or 125 (seconds).', { warn: true });
      input.focus();
      input.select();
      return;
    }
    saveTime(entry, ms, { assisted: assisted.checked });
    input.value = '';
    assisted.checked = false;
    paintAll();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  });

  return h('div', { class: 'stack', style: { gap: '14px' } },
    h('div', { class: 'eyebrow accent tight', text: 'YOUR TIMES' }),

    h('div', { class: 'trow' },
      input,
      h('button', { class: 'btn btn--primary btn--xs', type: 'button', text: 'Save time', onClick: submit })),

    h('label', { class: 'tcheck', for: assisted.id },
      assisted,
      h('span', { text: 'Needed a peek at the solution' })),

    h('div', { class: 'tstats' },
      statTile('ATTEMPTS', String(stats.count)),
      statTile('BEST', best === null ? '—' : formatTime(best), best !== null),
      statTile('AVERAGE', stats.meanMs === null ? '—' : formatTime(stats.meanMs)),
      statTile('LAST', stats.lastMs === null ? '—' : formatTime(stats.lastMs))),

    h('div', { class: 'movelog' },
      entry.times.length
        ? entry.times.slice().reverse().map((time, i) => h('div', { class: 'movelog__row' },
          h('div', { class: `movelog__dot${time.assisted ? ' is-warn' : ''}` }),
          h('div', { class: 'movelog__text', text: `#${entry.times.length - i}` +
            `  ${new Date(time.at).toLocaleDateString()}` +
            (time.ms === best && !time.assisted ? '  · BEST' : '') +
            (time.assisted ? '  · ASSISTED' : '') }),
          h('div', { class: 'movelog__t', text: formatTime(time.ms) }),
          h('button', {
            class: 'tdel',
            type: 'button',
            'aria-label': `Delete the ${formatTime(time.ms)} attempt`,
            text: '×',
            onClick: () => { store.removeTime(entry.id, time.id); paintAll(); }
          })))
        : h('div', { class: 'movelog__row' },
          h('div', { class: 'movelog__text', style: { color: 'var(--faint)' },
            text: 'NO TIMES YET — SET IT OUT AND START THE CLOCK' }))));
}

/* -------------------------------------------------------------- detail ---- */

function actionsRow(entry) {
  const setup = setupOf(entry);

  return h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
    h('button', {
      class: 'btn btn--ghost btn--xs',
      type: 'button',
      text: 'Copy setup',
      onClick: () => copyText(setupText(setup, { label: entryTitle(entry), code: entry.code }),
        'Setup copied as text.')
    }),
    h('button', {
      class: 'btn btn--ghost btn--xs',
      type: 'button',
      text: 'Copy code',
      onClick: () => copyText(entry.code, 'Challenge code copied.')
    }),
    h('button', {
      class: 'btn btn--ghost btn--xs',
      type: 'button',
      text: 'Print sheet',
      onClick: () => printSheet(entry)
    }),
    h('button', {
      class: 'btn btn--ghost btn--xs',
      type: 'button',
      text: 'Rename',
      onClick: async () => {
        const label = await promptSheet({
          title: 'Name this opening',
          body: 'A name of your own, for an opening you keep coming back to. Leave it empty to go back to the default.',
          placeholder: entryTitle(entry),
          value: entry.label || '',
          confirmLabel: 'Save'
        });
        if (label === null) return;
        store.setLabel(entry.id, label);
        paintAll();
      }
    }),
    h('button', {
      class: 'btn btn--ghost btn--xs',
      type: 'button',
      style: { color: 'var(--danger)' },
      text: 'Delete',
      onClick: async () => {
        const ok = await confirmSheet({
          title: 'Delete this opening?',
          body: entry.times.length
            ? `Its ${entry.times.length} recorded time${entry.times.length === 1 ? '' : 's'} go with it. This cannot be undone.`
            : 'It has no times recorded. This cannot be undone.',
          confirmLabel: 'Delete',
          variant: 'ghost'
        });
        if (!ok) return;
        store.removeSetup(entry.id);
        openId = store.setups[0]?.id || null;
        toast('Opening deleted.');
        paintAll();
      }
    }));
}

/** How hard the opening is, asked of the solver once the sheet is on screen. */
function solutionsNode(entry) {
  const node = h('span', { class: 'tmeta__v', text: 'counting…' });
  solverClient
    .countSolutions({ dimension: entry.dimension, locked: entry.locked, placed: [] }, 50)
    .then((count) => {
      node.textContent = count === 0 ? 'none' : count >= 50 ? '50+ ways' : `${count} way${count === 1 ? '' : 's'}`;
    })
    .catch(() => { node.textContent = '—'; });
  return node;
}

function emptyDetail() {
  return h('div', { class: 'card', style: { textAlign: 'center', padding: '40px 24px' } },
    h('div', { class: 'eyebrow accent', style: { marginBottom: '12px' }, text: 'NOTHING SET OUT YET' }),
    h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '8px' },
      text: 'Roll an opening for your physical set' }),
    h('div', { class: 'sub', style: { lineHeight: '1.55', maxWidth: '440px', margin: '0 auto' },
      text: 'Pick how many pieces to start with and whether the engine chooses them or you do. ' +
        'Every opening it hands you can still be finished with the pieces left in the bag.' }));
}

function paintDetail() {
  const entry = openId ? store.setup(openId) : null;

  if (!entry) {
    clock.node = null;
    append(clear(nodes.detail), [emptyDetail()]);
    return;
  }

  const setup = setupOf(entry);
  const note = h('textarea', {
    class: 'tinput tinput--area',
    rows: '2',
    placeholder: 'Notes — where you got stuck, which corner to leave last…',
    'aria-label': 'Notes for this opening',
    onChange: (event) => { store.setNote(entry.id, event.target.value); paintList(); }
  });
  note.value = entry.note || '';

  append(clear(nodes.detail), [
    h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' } },
      h('div', null,
        h('div', { class: 'eyebrow accent tight', style: { marginBottom: '7px' },
          text: `${dimensionLabel(entry.dimension).toUpperCase()} · ${entry.locked.length} SET OUT · ${12 - entry.locked.length} TO PLACE` }),
        h('h2', { class: 'h2', style: { fontSize: '26px' }, text: entryTitle(entry) })),
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--faint)', textAlign: 'right', whiteSpace: 'pre-line' },
        text: `SEED ${entry.seed || '—'}\n${new Date(entry.createdAt).toLocaleDateString()}` })),

    h('div', { class: 'tsheetwrap' }, setupSheet(setup)),

    h('div', { class: 'tmeta' },
      h('span', { class: 'tmeta__k', text: 'SETUP' }),
      h('span', { class: 'tmeta__v', text: entry.locked.map((p) => p.piece).join(' ') }),
      h('span', { class: 'tmeta__k', text: 'IN THE BAG' }),
      h('span', { class: 'tmeta__v', text: `${remainingPieces(setup).join(' ')} · ${remainingBeads(setup)} beads` }),
      h('span', { class: 'tmeta__k', text: 'SOLUTIONS' }),
      solutionsNode(entry)),

    h('div', null,
      h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px' }, text: 'SET THESE OUT' }),
      setupLegend(setup)),

    h('div', null,
      h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px' }, text: 'THEN FIT THESE' }),
      remainingStrip(setup)),

    actionsRow(entry),
    stopwatchPanel(entry),
    timesPanel(entry),
    note
  ]);
}

/* ---------------------------------------------------------------- list ---- */

function filtered() {
  const setups = store.setups;
  if (filter === '2D' || filter === '3D') return setups.filter((e) => e.dimension === filter);
  if (filter === 'untimed') return setups.filter((e) => !e.times.length);
  return setups;
}

function paintList() {
  const setups = filtered();
  nodes.listHead.textContent = `LOGBOOK · ${setups.length}`;

  segmented([
    { value: 'all', label: 'All' },
    { value: '2D', label: 'Board' },
    { value: '3D', label: 'Pyramid' },
    { value: 'untimed', label: 'Untimed' }
  ], filter, (value) => { filter = value; paintList(); }, { host: nodes.filters });

  append(clear(nodes.list), (setups.length
    ? setups.map((entry) => {
      const stats = timeStats(entry.times);
      const active = entry.id === openId;
      return h('button', {
        class: `listrow${active ? ' is-active' : ''}`,
        type: 'button',
        style: { minHeight: '64px', background: active ? undefined : 'transparent' },
        'aria-current': active ? 'true' : null,
        onClick: () => { openId = entry.id; paintDetail(); paintList(); }
      },
      h('div', {
        class: 'chip',
        style: {
          width: '40px',
          height: '40px',
          borderRadius: '11px',
          fontSize: '14px',
          background: entry.dimension === '3D' ? 'rgba(53,167,255,0.16)' : 'rgba(0,229,160,0.14)',
          color: entry.dimension === '3D' ? '#5CB8FF' : 'var(--accent)'
        },
        text: String(entry.locked.length)
      }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { fontSize: '15px', fontWeight: '600' }, text: entryTitle(entry) }),
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--dim)' },
          text: `${entryPieces(entry)} · ${stats.count} run${stats.count === 1 ? '' : 's'}` })),
      h('div', { class: 'mono', style: { fontSize: '12px', color: stats.bestMs ? 'var(--accent)' : 'var(--faint)' },
        text: stats.bestMs === null ? '—' : formatTime(stats.bestMs) }));
    })
    : [h('div', { class: 'tnote', style: { padding: '14px 2px' },
      text: store.setups.length
        ? 'No openings match that filter.'
        : 'Openings you generate are kept here with their times.' })]));
}

/* ------------------------------------------------------------- summary ---- */

function paintSummary() {
  const s = store.summary();
  const hours = s.totalMs / 3_600_000;
  append(clear(nodes.summary), [
    statTile('OPENINGS', String(s.openings)),
    statTile('SOLVED', String(s.solvedOpenings)),
    statTile('ATTEMPTS', String(s.attempts)),
    statTile('BEST', s.bestMs === null ? '—' : formatTime(s.bestMs), s.bestMs !== null),
    statTile('AT THE TABLE', s.totalMs ? (hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(s.totalMs / 60000)}m`) : '—')
  ]);
}

/* ---------------------------------------------------------------- data ---- */

async function importBackup(file) {
  try {
    const text = await readTextFile(file);
    const payload = JSON.parse(text);
    const incoming = Array.isArray(payload?.setups) ? payload.setups.length : 0;
    const mode = store.setups.length
      ? await sheet({
        title: 'Import this logbook?',
        body: `The file holds ${incoming} opening${incoming === 1 ? '' : 's'}. ` +
          `You have ${store.setups.length} here already.`,
        actions: [
          { label: 'Cancel', value: null, variant: 'ghost' },
          { label: 'Replace', value: 'replace', variant: 'ghost' },
          { label: 'Merge', value: 'merge', variant: 'primary' }
        ]
      })
      : 'merge';
    if (!mode) return;

    const report = store.fromBackup(payload, { mode });
    openId = store.setups[0]?.id || null;
    toast(report.mode === 'replace'
      ? `Logbook replaced: ${report.addedSetups} openings, ${report.addedTimes} times.`
      : `Merged in ${report.addedSetups} new opening${report.addedSetups === 1 ? '' : 's'} ` +
        `and ${report.addedTimes} time${report.addedTimes === 1 ? '' : 's'}.`);
    paintAll();
  } catch (error) {
    toast(error.message || 'That file could not be imported.', { warn: true });
  }
}

function paintData() {
  const empty = !store.setups.length;
  const noTimes = !hasTimes();

  const picker = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'sr-only',
    onChange: (event) => {
      const [file] = event.target.files || [];
      if (file) importBackup(file);
      event.target.value = '';
    }
  });

  const action = (label, hint, onClick, disabled = false) => h('button', {
    class: 'databtn',
    type: 'button',
    disabled,
    onClick
  },
  h('span', { class: 'databtn__label', text: label }),
  h('span', { class: 'databtn__hint', text: hint }));

  append(clear(nodes.data), [
    action('Export logbook · JSON', 'Everything, and the only file Import reads back.',
      () => { exportJson(); toast('Logbook exported as JSON.'); }, empty),
    action('Export times · CSV', 'One row per attempt, for a spreadsheet.',
      () => { exportTimesCsv(); toast('Times exported as CSV.'); }, noTimes),
    action('Export openings · CSV', 'One row per opening, with best, average and last.',
      () => { exportOpeningsCsv(); toast('Openings exported as CSV.'); }, empty),
    action('Export as text', 'A plain digest you can paste anywhere.',
      () => { exportText(); toast('Logbook exported as text.'); }, empty),
    action('Copy logbook to clipboard', 'The same digest, without a download.',
      () => copyText(logbookText(), 'Logbook copied.'), empty),
    picker,
    action('Import a logbook', 'Merge a JSON export in, or replace this one.',
      () => picker.click()),
    action('Clear the logbook', 'Deletes every opening and time on this device.',
      async () => {
        const ok = await confirmSheet({
          title: 'Clear the whole logbook?',
          body: 'Every opening and every time on this device goes. Export first if you want to keep them — this cannot be undone.',
          confirmLabel: 'Clear everything',
          variant: 'ghost'
        });
        if (!ok) return;
        store.clear();
        openId = null;
        toast('Logbook cleared.');
        paintAll();
      }, empty)
  ]);
}

/* ------------------------------------------------------------ settings ---- */

function settingsSheet() {
  const rows = [];

  const toggleRow = (key, label, hint) => {
    const row = h('button', {
      class: 'setrow',
      type: 'button',
      role: 'switch',
      'aria-checked': store.settings[key] ? 'true' : 'false',
      onClick: () => {
        store.setSetting(key, !store.settings[key]);
        row.setAttribute('aria-checked', store.settings[key] ? 'true' : 'false');
        paintAll();
      }
    },
    h('div', { style: { flex: '1', textAlign: 'left' } },
      h('div', { class: 'setrow__label', text: label }),
      h('div', { class: 'setrow__hint', text: hint })),
    h('div', { class: 'switch' }, h('i')));
    return row;
  };

  // The swatches repaint in place rather than reopening the sheet, so the
  // dialog keeps its focus trap and its Escape handler across a palette change.
  const palettes = h('div', { class: 'palettes' });
  const paintPalettes = () => append(clear(palettes), PALETTE_KEYS.map((key) => h('button', {
    class: `palettebtn${store.settings.palette === key ? ' is-active' : ''}`,
    type: 'button',
    'aria-pressed': store.settings.palette === key ? 'true' : 'false',
    'aria-label': `${key} palette`,
    onClick: () => { store.setSetting('palette', key); paintPalettes(); paintAll(); }
  },
  h('div', { class: 'palettebtn__swatches' },
    ...PIECE_IDS.slice(0, 6).map((id) => h('i', { style: { background: PALETTES[key][id] } }))),
  h('div', { class: 'palettebtn__name', text: key }))));
  paintPalettes();

  rows.push(h('div', { class: 'stack', style: { gap: '10px' } },
    h('div', { class: 'eyebrow accent tight', text: 'PIECE PALETTE' }),
    palettes,
    h('div', { class: 'tnote', text: 'Every bead carries its piece letter, so the sheet reads the same in any palette — or in greyscale on paper.' })));

  rows.push(h('div', { class: 'setgroup' },
    toggleRow('highContrast', 'High contrast', 'Stronger outlines on sockets and beads.'),
    toggleRow('reduceMotion', 'Reduce motion', 'Drops transitions and pulses.')));

  return sheet({
    title: 'Settings',
    body: h('div', { class: 'stack', style: { gap: '18px' } }, ...rows),
    actions: [{ label: 'Done', value: null, variant: 'primary' }]
  });
}

function aboutSheet() {
  return sheet({
    title: 'Tabletop',
    body: h('div', { class: 'stack', style: { gap: '12px' } },
      h('div', { class: 'sheet__body',
        text: 'This is the mode for the polysphere set on your table rather than one on screen. ' +
          'It rolls an opening, draws it as a lettered sheet you can copy onto real beads, and keeps the times you bring back.' }),
      h('div', { class: 'sheet__body',
        text: 'Every opening is lifted out of a complete fill, so the pieces left in the bag always finish it — ' +
          'the generator cannot hand you an impossible board.' }),
      h('div', { class: 'sheet__body',
        text: 'Times are hand-entered and nothing verified them, so they live in their own logbook. ' +
          'They are stored in this browser only: export them to keep them.' }),
      h('div', { class: 'notice',
        text: 'ROWS ARE LETTERED A–E · COLUMNS NUMBERED FROM 1 · A PYRAMID SOCKET READS L2B3' })),
    actions: [{ label: 'Close', value: null, variant: 'primary' }]
  });
}

/* -------------------------------------------------------------- painting -- */

function paintAll() {
  paintGenerator();
  paintDetail();
  paintList();
  paintSummary();
  paintData();
}

/* --------------------------------------------------------------- printing - */

/**
 * Print just the sheet. The page is a fixed-height app shell, so printing it
 * directly would emit one clipped screenshot; a dedicated print node next to
 * `#app` gives the printer a plain flowing document instead.
 */
function printSheet(entry) {
  const setup = setupOf(entry);
  document.getElementById('printarea')?.remove();

  const area = h('div', { id: 'printarea' },
    h('div', { class: 'tprint__head' },
      h('div', { class: 'tprint__title', text: `TESSERA · ${entryTitle(entry).toUpperCase()}` }),
      h('div', { class: 'tprint__sub',
        text: `${entry.locked.length} piece${entry.locked.length === 1 ? '' : 's'} set out · ` +
          `${12 - entry.locked.length} to place · seed ${entry.seed || '—'}` })),
    setupSheet(setup, { beadSize: 30 }),
    setupLegend(setup),
    h('div', { class: 'tprint__bag', text: `In the bag: ${remainingPieces(setup).join(' ')}` }),
    h('div', { class: 'tprint__code', text: entry.code }),
    h('div', { class: 'tprint__times' },
      h('div', { class: 'tprint__sub', text: 'TIMES' }),
      ...Array.from({ length: 6 }, () => h('div', { class: 'tprint__rule' }))));

  document.body.appendChild(area);
  document.body.dataset.printing = 'on';

  const cleanup = () => {
    delete document.body.dataset.printing;
    area.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safari never fires afterprint from a synchronous print(); this is the net.
  setTimeout(() => { if (document.body.dataset.printing) cleanup(); }, 1500);
}

/* ----------------------------------------------------------------- shell -- */

function header() {
  return h('header', { class: 'apphead' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand__dot' }),
      h('div', null,
        h('div', { class: 'brand__name', text: 'Tessera' }),
        h('div', { class: 'eyebrow tight', text: 'TABLETOP' }))),
    h('div', { class: 'row', style: { gap: '8px' } },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'About this page', text: '?', onClick: aboutSheet }),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Settings', text: '⚙', onClick: settingsSheet })));
}

function storageWarning() {
  const node = h('div', { class: 'warnbar', hidden: true,
    text: 'This browser is refusing to save — the log is in memory only. Export before you close the tab.' });
  store.addEventListener('change', () => { node.hidden = !store.writeFailed; });
  return node;
}

function mount() {
  const app = document.getElementById('app');

  app.appendChild(h('div', { class: 'screen' },
    header(),
    storageWarning(),

    h('div', { class: 'tt2 scroll' },
      h('div', { class: 'tt2__main' },
        h('div', { class: 'desk-only' },
          h('h1', { class: 'h1', style: { marginBottom: '8px' }, text: 'Tabletop' }),
          h('div', { class: 'sub',
            text: 'An opening for the set on your table, and somewhere to keep the times you get.' })),
        nodes.summary,
        nodes.detail),

      h('div', { class: 'tt2__side' },
        h('div', { class: 'tt2__gen stack', style: { gap: '16px' } },
          h('div', null,
            h('div', { class: 'eyebrow', style: { marginBottom: '6px' }, text: 'GENERATOR' }),
            h('div', { class: 'tnote',
              text: 'Roll a legal opening, copy it onto the real board, then race it.' })),
          nodes.generator),

        h('div', { class: 'tt2__log stack', style: { gap: '12px' } },
          nodes.listHead,
          nodes.filters,
          nodes.list),

        h('div', { class: 'tt2__data stack', style: { gap: '12px' } },
          h('div', null,
            h('div', { class: 'eyebrow', style: { marginBottom: '6px' }, text: 'YOUR TIMES' }),
            h('div', { class: 'tnote',
              text: 'The logbook lives in this browser and nowhere else. Export is the backup.' })),
          nodes.data)))));

  openId = store.setups[0]?.id || null;
  paintAll();
  solverClient.warm();

  // Space is the stopwatch, unless the player is typing — a time, a note, a
  // seed, or anything inside an open dialog.
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement &&
      (target.matches('input, textarea, select, button, [contenteditable]') || target.closest('.sheet'))) return;
    if (!openId) return;
    event.preventDefault();
    toggleClock();
  });

  // A running clock is the one thing a refresh would silently lose; everything
  // else on this page is already in localStorage.
  window.addEventListener('beforeunload', (event) => {
    if (!clock.running) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

mount();
