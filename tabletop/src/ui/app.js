/**
 * Tessera Tabletop — the whole site.
 *
 * One screen, one loop: roll an opening, copy it onto the real board, race it,
 * save the time. Everything the player has ever recorded lives in this browser
 * and leaves it only when they export.
 *
 * On a phone the page is three tabs — Play, Log, Data — with the stopwatch
 * docked at the bottom where a thumb can reach it without looking. On a wide
 * screen the same panels sit side by side and the stopwatch is inline. There is
 * no router and no framework: paint functions over live nodes, and CSS decides
 * which of them are showing.
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
  seed: '',
  more: false
};

/** Surface and piece count are remembered between visits: one tap to roll the usual. */
const ROLLER_KEY = 'tessera.tabletop.roller';

try {
  const saved = JSON.parse(localStorage.getItem(ROLLER_KEY) || 'null');
  if (saved?.dimension === '3D' || saved?.dimension === '2D') options.dimension = saved.dimension;
  if (Number.isInteger(saved?.count)) options.count = clampCount(saved.count);
} catch { /* defaults */ }

function rememberRoller() {
  try {
    localStorage.setItem(ROLLER_KEY, JSON.stringify({ dimension: options.dimension, count: options.count }));
  } catch { /* not worth a warning */ }
}

/** Which opening the detail panel is showing. */
let openId = null;

/** Logbook filter: 'all' | '2D' | '3D' | 'untimed'. */
let filter = 'all';

/** Phone tab: 'play' | 'log' | 'data'. A wide screen shows all three. */
let tab = 'play';

let busy = false;

const phone = matchMedia('(max-width: 1079px)');

/**
 * One stopwatch for the whole page, not one per opening — it is a wall clock,
 * so it keeps running while you flip through the logbook and saves to whichever
 * opening is on screen when you stop.
 *
 * It runs on wall-clock time and is written to localStorage on every start and
 * stop, so a phone that locks, backgrounds the tab, or reloads it mid-solve
 * picks the reading back up instead of losing it.
 */
const clock = {
  running: false,
  startedAt: 0,
  elapsed: 0,
  timer: null,
  wakeLock: null
};

const CLOCK_KEY = 'tessera.tabletop.clock';

const clockMs = () => clock.elapsed + (clock.running ? Date.now() - clock.startedAt : 0);

function persistClock() {
  try {
    if (!clock.running && !clock.elapsed) localStorage.removeItem(CLOCK_KEY);
    else {
      localStorage.setItem(CLOCK_KEY, JSON.stringify({
        running: clock.running, startedAt: clock.startedAt, elapsed: clock.elapsed, openId
      }));
    }
  } catch { /* the reading just will not survive a reload */ }
}

function restoreClock() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOCK_KEY) || 'null');
    if (!saved || !Number.isFinite(saved.startedAt) || !Number.isFinite(saved.elapsed)) return;
    clock.running = Boolean(saved.running);
    clock.startedAt = saved.startedAt;
    clock.elapsed = Math.max(0, saved.elapsed);
    if (saved.openId && store.setup(saved.openId)) openId = saved.openId;
  } catch { /* start from zero */ }
}

const dimensionLabel = (dimension) => (dimension === '3D' ? 'Pyramid' : 'Board');

/** "Board · 3 pieces" — how a logged opening names itself when unlabelled. */
function entryTitle(entry) {
  const n = entry.locked.length;
  return entry.label || `${dimensionLabel(entry.dimension)} · ${n} piece${n === 1 ? '' : 's'}`;
}

const entryPieces = (entry) => entry.locked.map((p) => p.piece).join('');

const setupOf = (entry) => ({ dimension: entry.dimension, locked: entry.locked, seed: entry.seed });

/** A peeked-at run is kept, but it never counts as a best. */
const bestOf = (times) => timeStats(times.filter((t) => !t.assisted)).bestMs;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------ live nodes -- */

const nodes = {
  layout: null,
  tabs: h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' }),
  generator: h('div', { class: 'stack', style: { gap: '14px' } }),
  detail: h('div', { class: 'stack', style: { gap: '18px' } }),
  stopwatch: h('div'),
  dock: h('div', { class: 'dock', hidden: true }),
  listHead: h('div', { class: 'eyebrow', text: 'LOGBOOK' }),
  list: h('div', { class: 'stack', style: { gap: '8px' } }),
  filters: h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter the logbook' }),
  summary: h('div', { class: 'tstats tstats--wide' }),
  storage: h('div'),
  data: h('div', { class: 'stack', style: { gap: '10px' } })
};

/* ------------------------------------------------------------- fragments -- */

function segmented(items, current, onPick, { label, host = null, disabled = false } = {}) {
  const buttons = items.map((item) => h('button', {
    class: `seg__btn${item.value === current ? ' is-active' : ''}`,
    type: 'button',
    disabled,
    'aria-pressed': item.value === current ? 'true' : 'false',
    onClick: () => onPick(item.value)
  }, h('span', { text: item.label })));

  if (host) return append(clear(host), buttons);
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || undefined }, ...buttons);
}

const statTile = (label, value, accent = false) => h('div', { class: 'tstat' },
  h('div', { class: 'tstat__label', text: label }),
  h('div', { class: 'tstat__value', style: accent ? { color: 'var(--accent)' } : null, text: value }));

const eyebrow = (text, extra = {}) =>
  h('div', { class: 'eyebrow accent tight', style: { marginBottom: '10px', ...extra }, text });

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

/* ------------------------------------------------------------------ tabs -- */

function setTab(next, { scroll = true } = {}) {
  tab = next;
  nodes.layout.dataset.tab = tab;
  paintTabs();
  if (scroll && phone.matches) window.scrollTo({ top: 0 });
}

function paintTabs() {
  const count = store.setups.length;
  append(clear(nodes.tabs), [
    ['play', 'Play'],
    ['log', count ? `Log · ${count}` : 'Log'],
    ['data', 'Data']
  ].map(([value, label]) => h('button', {
    class: `tabs__btn${tab === value ? ' is-active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': tab === value ? 'true' : 'false',
    text: label,
    onClick: () => setTab(value)
  })));
}

/* ------------------------------------------------------------ generating -- */

/** On a phone, bring the fresh sheet into view: that is the next thing you need. */
function revealDetail() {
  if (!phone.matches) return;
  requestAnimationFrame(() => nodes.detail.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

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
    announce(`New ${dimensionLabel(dimension).toLowerCase()} opening with ${plural(locked.length, 'piece')}: ` +
      `${locked.map((p) => p.piece).join(', ')}. ${12 - locked.length} pieces left to fit.`);
    busy = false;
    paintAll();
    revealDetail();
  } catch (error) {
    toast(error.message || 'Could not build that opening.', { warn: true });
  } finally {
    if (busy) {
      busy = false;
      paintAll();
    }
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
    setTab('play', { scroll: false });
    paintAll();
    revealDetail();
  } catch (error) {
    toast(error.message || 'That is not a usable challenge code.', { warn: true });
  }
}

/* ------------------------------------------------------ generator panel --- */

function stepper() {
  const chosen = options.pick === 'choose' ? options.pinned.size : 0;
  const floor = Math.max(MIN_SETUP_PIECES, chosen);
  const set = (n) => { options.count = clampCount(Math.max(n, floor)); paintGenerator(); };

  return h('div', { class: 'stepper', role: 'group', 'aria-label': 'Starting pieces' },
    h('button', {
      class: 'stepper__btn',
      type: 'button',
      disabled: busy || options.count <= floor,
      'aria-label': 'One fewer starting piece',
      text: '−',
      onClick: () => set(options.count - 1)
    }),
    h('div', { class: 'stepper__value', 'aria-live': 'polite' },
      h('span', { class: 'stepper__num', text: String(options.count) }),
      h('span', { class: 'stepper__unit', text: options.count === 1 ? 'piece set out' : 'pieces set out' })),
    h('button', {
      class: 'stepper__btn',
      type: 'button',
      disabled: busy || options.count >= MAX_SETUP_PIECES,
      'aria-label': 'One more starting piece',
      text: '+',
      onClick: () => set(options.count + 1)
    }));
}

function pieceGrid() {
  return h('div', { class: 'piecepick' },
    ...PIECE_IDS.map((id) => {
      const on = options.pinned.has(id);
      return h('button', {
        class: `piecepick__btn${on ? ' is-on' : ''}`,
        type: 'button',
        disabled: busy,
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
  rememberRoller();

  const seedInput = h('input', {
    class: 'tinput',
    type: 'text',
    value: options.seed,
    placeholder: 'Seed — leave empty for a fresh roll',
    'aria-label': 'Seed',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    disabled: busy,
    onInput: (event) => { options.seed = event.target.value; }
  });

  const more = h('details', { class: 'more', open: options.more },
    h('summary', { class: 'more__summary' },
      h('span', { text: 'More options' }),
      h('span', { class: 'more__hint',
        text: options.pick === 'choose' && chosen ? `${chosen} pinned` : options.seed.trim() ? 'seed set' : 'pick pieces, seed, code' })),
    h('div', { class: 'stack', style: { gap: '14px', paddingTop: '14px' } },
      segmented([
        { value: 'random', label: 'Random pieces' },
        { value: 'choose', label: 'Choose pieces' }
      ], options.pick, (value) => { options.pick = value; paintGenerator(); }, { label: 'Which pieces', disabled: busy }),
      options.pick === 'choose'
        ? h('div', { class: 'stack', style: { gap: '10px' } },
          h('div', { class: 'tnote',
            text: chosen >= count
              ? `The opening is exactly ${[...options.pinned].sort().join(', ')}.`
              : `${chosen || 'No'} piece${chosen === 1 ? '' : 's'} pinned; the other ${count - chosen} will be rolled.` }),
          pieceGrid())
        : null,
      seedInput,
      h('button', {
        class: 'btn btn--dashed btn--xs',
        type: 'button',
        disabled: busy,
        text: 'Add an opening from a challenge code',
        onClick: addFromCode
      })));
  more.addEventListener('toggle', () => { options.more = more.open; });

  append(clear(nodes.generator), [
    segmented([
      { value: '2D', label: 'Board 5×11' },
      { value: '3D', label: 'Pyramid' }
    ], options.dimension, (value) => { options.dimension = value; paintGenerator(); },
    { label: 'Surface', disabled: busy }),

    stepper(),

    h('button', {
      class: 'btn btn--primary btn--block',
      type: 'button',
      disabled: busy,
      onClick: generate
    },
    h('span', { text: busy ? 'Rolling…' : (store.setups.length ? 'Roll new opening' : 'Roll an opening') }),
    h('span', { class: 'kbd', text: `${12 - count} to place` })),

    more
  ]);
}

/* ---------------------------------------------------------- the stopwatch - */

function renderClock() {
  const ms = clockMs();
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const face = `${hours ? `${hours}:` : ''}${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}` +
    `.${Math.floor((ms % 1000) / 100)}`;
  for (const node of document.querySelectorAll('[data-clock]')) node.textContent = face;
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

/** Keep the screen on while a solve is being timed. Best-effort everywhere. */
async function holdScreen(on) {
  try {
    if (on && !clock.wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      clock.wakeLock = await navigator.wakeLock.request('screen');
      clock.wakeLock.addEventListener('release', () => { clock.wakeLock = null; });
    } else if (!on && clock.wakeLock) {
      await clock.wakeLock.release();
      clock.wakeLock = null;
    }
  } catch { /* battery saver, or not supported */ }
}

function toggleClock() {
  if (clock.running) {
    clock.elapsed = clockMs();
    clock.running = false;
    stopClockTimer();
    holdScreen(false);
    navigator.vibrate?.(30);
    announce(`Stopped at ${formatTime(clock.elapsed)}.`);
  } else {
    clock.startedAt = Date.now();
    clock.running = true;
    startClockTimer();
    holdScreen(true);
    navigator.vibrate?.(15);
    announce('Timing.');
  }
  persistClock();
  paintClock();
}

function resetClock() {
  clock.running = false;
  clock.elapsed = 0;
  stopClockTimer();
  holdScreen(false);
  persistClock();
  paintClock();
}

function saveClock(entry) {
  const ms = clockMs();
  if (ms <= 0) return;
  saveTime(entry, ms);
  resetClock();
  paintAll();
}

/** The buttons for whichever state the clock is in, shared by dock and panel. */
function clockButtons(entry, { size = '' } = {}) {
  const ms = clockMs();
  const sized = (cls) => `btn ${cls}${size ? ` ${size}` : ''}`;

  if (clock.running) {
    return [h('button', {
      class: sized('btn--stop btn--grow'),
      type: 'button',
      onClick: toggleClock
    }, h('span', { class: 'glyph glyph--stop', 'aria-hidden': 'true' }), h('span', { text: 'Stop' }))];
  }
  if (ms <= 0) {
    return [h('button', {
      class: sized('btn--primary btn--grow'),
      type: 'button',
      onClick: toggleClock
    }, h('span', { class: 'glyph glyph--play', 'aria-hidden': 'true' }), h('span', { text: 'Start' }))];
  }
  return [
    h('button', {
      class: sized('btn--ghost btn--square'),
      type: 'button',
      'aria-label': 'Reset the stopwatch',
      title: 'Reset',
      onClick: resetClock
    }, h('span', { text: '↺', 'aria-hidden': 'true' })),
    h('button', {
      class: sized('btn--ghost btn--square'),
      type: 'button',
      'aria-label': 'Resume timing',
      title: 'Resume',
      onClick: toggleClock
    }, h('span', { class: 'glyph glyph--play', 'aria-hidden': 'true' })),
    h('button', {
      class: sized('btn--primary btn--grow'),
      type: 'button',
      onClick: () => saveClock(entry)
    }, h('span', { text: 'Save' }), h('span', { class: 'btn__time', text: formatTime(ms) }))
  ];
}

/** Phone: the dock pinned to the bottom of the screen. */
function paintDock(entry) {
  const dock = nodes.dock;
  dock.hidden = !entry;
  document.body.classList.toggle('has-dock', Boolean(entry));
  if (!entry) return clear(dock);

  const ms = clockMs();
  const best = bestOf(entry.times);
  dock.dataset.state = clock.running ? 'running' : ms > 0 ? 'stopped' : 'idle';

  append(clear(dock), [
    h('div', { class: 'dock__readout' },
      h('div', { class: 'dock__face mono', 'data-clock': '', 'aria-hidden': 'true' }),
      h('div', { class: 'dock__sub',
        text: clock.running ? 'Timing…' : best === null ? entryTitle(entry) : `Best ${formatTime(best)}` })),
    h('div', { class: 'dock__actions' }, ...clockButtons(entry))
  ]);
}

/** Wide screen: the stopwatch sits inline with the sheet. */
function paintStopwatch(entry) {
  if (!entry) return clear(nodes.stopwatch);
  append(clear(nodes.stopwatch), [
    h('div', { class: `sw${clock.running ? ' is-running' : ''}` },
      h('div', { class: 'sw__head' },
        h('div', { class: 'eyebrow accent tight', text: clock.running ? 'TIMING' : 'STOPWATCH' }),
        h('div', { class: 'tnote', text: 'Space starts and stops it.' })),
      h('div', { class: 'sw__face mono', 'data-clock': '', 'aria-hidden': 'true' }),
      h('div', { class: 'sw__actions' }, ...clockButtons(entry, { size: 'btn--xs' })))
  ]);
}

function paintClock() {
  const entry = openId ? store.setup(openId) : null;
  paintDock(entry);
  paintStopwatch(entry);
  renderClock();
  if (clock.running) startClockTimer();
}

/* --------------------------------------------------------------- times ---- */

/** One place records an attempt, so the announcement and the toast never drift. */
function saveTime(entry, ms, { assisted = false } = {}) {
  const previousBest = bestOf(entry.times);
  store.addTime(entry.id, ms, { assisted });
  const beatIt = !assisted && previousBest !== null && ms < previousBest;
  toast(store.writeFailed
    ? `Kept ${formatTime(ms)} for now — this browser would not save it. Export before closing.`
    : beatIt ? `New best: ${formatTime(ms)}. Saved.` : `Saved ${formatTime(ms)}.`,
  { warn: store.writeFailed });
  announce(`${formatTime(ms)} saved for ${entryTitle(entry)}.` +
    (beatIt ? ' That is a new best for this opening.' : ''));
}

/**
 * Typing a time in by hand. Minutes and seconds are separate numeric fields,
 * because a phone's number pad has no colon — `2:05` cannot be typed on one.
 */
function manualEntry(entry) {
  const field = (label, placeholder, max) => h('input', {
    class: 'tinput tinput--num',
    type: 'text',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: max,
    placeholder,
    autocomplete: 'off',
    'aria-label': label,
    enterkeyhint: 'done'
  });
  const minutes = field('Minutes', 'min', '3');
  const seconds = field('Seconds', 'sec', '2');
  const assisted = h('input', { type: 'checkbox', id: `tt-assist-${entry.id}` });

  const submit = () => {
    const m = minutes.value.trim();
    const s = seconds.value.trim();
    // A colon typed on a full keyboard still goes through the forgiving parser.
    const ms = /[^0-9]/.test(m + s)
      ? parseDuration(`${m}${s ? `:${s.padStart(2, '0')}` : ''}`)
      : (m || s) && Number(s || 0) < 60
        ? parseDuration(`${Number(m || 0)}:${String(Number(s || 0)).padStart(2, '0')}`)
        : null;
    if (ms === null) {
      toast('Enter minutes and seconds — seconds under 60.', { warn: true });
      (m ? seconds : minutes).focus();
      return;
    }
    saveTime(entry, ms, { assisted: assisted.checked });
    paintAll();
  };

  seconds.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
  });
  minutes.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); seconds.focus(); }
  });

  return h('div', { class: 'stack', style: { gap: '10px' } },
    h('div', { class: 'eyebrow tight', text: 'OR TYPE A TIME IN' }),
    h('div', { class: 'trow' },
      minutes,
      h('span', { class: 'trow__colon', text: ':', 'aria-hidden': 'true' }),
      seconds,
      h('button', { class: 'btn btn--soft btn--xs', type: 'button', text: 'Save', onClick: submit })),
    h('label', { class: 'tcheck', for: assisted.id },
      assisted,
      h('span', { text: 'I needed a peek (not counted as a best)' })));
}

function timesPanel(entry) {
  const stats = timeStats(entry.times);
  const best = bestOf(entry.times);

  return h('div', { class: 'stack', style: { gap: '12px' } },
    eyebrow('YOUR TIMES', { marginBottom: '0' }),

    h('div', { class: 'tstats' },
      statTile('BEST', best === null ? '—' : formatTime(best), best !== null),
      statTile('AVERAGE', stats.meanMs === null ? '—' : formatTime(stats.meanMs)),
      statTile('LAST', stats.lastMs === null ? '—' : formatTime(stats.lastMs)),
      statTile('RUNS', String(stats.count))),

    h('div', { class: 'movelog' },
      entry.times.length
        ? entry.times.slice().reverse().map((time, i) => h('div', { class: 'movelog__row' },
          h('div', { class: `movelog__dot${time.assisted ? ' is-warn' : ''}` }),
          h('div', { class: 'movelog__text' },
            h('span', { text: `#${entry.times.length - i} · ${new Date(time.at).toLocaleDateString()}` }),
            time.ms === best && !time.assisted ? h('span', { class: 'movelog__tag', text: 'BEST' }) : null,
            time.assisted ? h('span', { class: 'movelog__tag is-warn', text: 'PEEKED' }) : null),
          h('div', { class: 'movelog__t', text: formatTime(time.ms) }),
          h('button', {
            class: 'tdel',
            type: 'button',
            'aria-label': `Delete the ${formatTime(time.ms)} attempt`,
            text: '×',
            onClick: async () => {
              const ok = await confirmSheet({
                title: `Delete ${formatTime(time.ms)}?`,
                body: 'This attempt is removed from the logbook. This cannot be undone.',
                confirmLabel: 'Delete',
                variant: 'danger'
              });
              if (!ok) return;
              store.removeTime(entry.id, time.id);
              paintAll();
            }
          })))
        : h('div', { class: 'movelog__row' },
          h('div', { class: 'movelog__text', style: { color: 'var(--faint)' },
            text: 'No times yet — set it out and hit Start.' }))),

    manualEntry(entry));
}

/* -------------------------------------------------------------- detail ---- */

function renameEntry(entry) {
  return promptSheet({
    title: 'Name this opening',
    body: 'A name of your own, for an opening you keep coming back to. Leave it empty to go back to the default.',
    placeholder: entryTitle(entry),
    value: entry.label || '',
    confirmLabel: 'Save'
  }).then((label) => {
    if (label === null) return;
    store.setLabel(entry.id, label);
    paintAll();
  });
}

async function deleteEntry(entry) {
  const ok = await confirmSheet({
    title: 'Delete this opening?',
    body: entry.times.length
      ? `Its ${plural(entry.times.length, 'recorded time')} go with it. This cannot be undone.`
      : 'It has no times recorded. This cannot be undone.',
    confirmLabel: 'Delete',
    variant: 'danger'
  });
  if (!ok) return;
  store.removeSetup(entry.id);
  openId = store.setups[0]?.id || null;
  toast('Opening deleted.');
  paintAll();
}

async function entryMenu(entry) {
  const setup = setupOf(entry);
  const choice = await sheet({
    title: entryTitle(entry),
    stacked: true,
    actions: [
      { label: 'Copy setup as text', value: 'setup' },
      { label: 'Copy challenge code', value: 'code' },
      { label: 'Print sheet', value: 'print' },
      { label: 'Rename', value: 'rename' },
      { label: 'Delete opening', value: 'delete', variant: 'danger' },
      { label: 'Cancel', value: null, variant: 'plain' }
    ]
  });
  if (choice === 'setup') copyText(setupText(setup, { label: entryTitle(entry), code: entry.code }), 'Setup copied as text.');
  else if (choice === 'code') copyText(entry.code, 'Challenge code copied.');
  else if (choice === 'print') printSheet(entry);
  else if (choice === 'rename') renameEntry(entry);
  else if (choice === 'delete') deleteEntry(entry);
}

/** How hard the opening is, asked of the solver once and remembered. */
const solutionCounts = new Map();

function solutionsNode(entry) {
  const node = h('span', { class: 'tmeta__v', text: 'counting…' });
  const show = (count) => {
    node.textContent = count === null ? '—' : count === 0 ? 'none' : count >= 50 ? '50+ ways' : plural(count, 'way');
  };
  if (!solutionCounts.has(entry.id)) {
    solutionCounts.set(entry.id, solverClient
      .countSolutions({ dimension: entry.dimension, locked: entry.locked, placed: [] }, 50)
      .catch(() => null));
  }
  solutionCounts.get(entry.id).then(show);
  return node;
}

function emptyDetail() {
  return h('div', { class: 'card', style: { textAlign: 'center', padding: '32px 20px' } },
    h('div', { class: 'eyebrow accent', style: { marginBottom: '12px' }, text: 'NOTHING SET OUT YET' }),
    h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '8px' },
      text: 'Roll an opening for your physical set' }),
    h('div', { class: 'sub', style: { lineHeight: '1.55', maxWidth: '440px', margin: '0 auto', fontSize: '14px' },
      text: 'Pick the surface and how many pieces to start with, then roll. ' +
        'Every opening can still be finished with the pieces left in the bag.' }));
}

function paintDetail() {
  const entry = openId ? store.setup(openId) : null;

  if (!entry) {
    append(clear(nodes.detail), [emptyDetail()]);
    return;
  }

  const setup = setupOf(entry);
  const note = h('textarea', {
    class: 'tinput tinput--area',
    rows: '2',
    maxlength: '240',
    placeholder: 'Notes — where you got stuck, which corner to leave last…',
    'aria-label': 'Notes for this opening',
    // Saved as you type: a phone rarely blurs a field before the tab is closed.
    onInput: (event) => { store.setNote(entry.id, event.target.value); },
    onChange: () => paintList()
  });
  note.value = entry.note || '';

  append(clear(nodes.detail), [
    h('div', { class: 'dhead' },
      h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'eyebrow accent tight', style: { marginBottom: '6px' },
          text: `${dimensionLabel(entry.dimension).toUpperCase()} · ${entry.locked.length} SET OUT · ${12 - entry.locked.length} TO PLACE` }),
        h('h2', { class: 'h2 dhead__title', text: entryTitle(entry) })),
      h('button', {
        class: 'iconbtn iconbtn--lg',
        type: 'button',
        'aria-label': 'Opening actions: copy, print, rename, delete',
        text: '⋯',
        onClick: () => entryMenu(entry)
      })),

    h('div', { class: 'tsheetwrap' }, setupSheet(setup)),

    h('div', null,
      eyebrow('1 · SET THESE OUT'),
      setupLegend(setup)),

    h('div', null,
      eyebrow('2 · THEN FIT THESE'),
      remainingStrip(setup)),

    nodes.stopwatch,
    timesPanel(entry),
    note,

    h('div', { class: 'tmeta' },
      h('span', { class: 'tmeta__k', text: 'IN THE BAG' }),
      h('span', { class: 'tmeta__v', text: `${remainingPieces(setup).join(' ')} · ${remainingBeads(setup)} beads` }),
      h('span', { class: 'tmeta__k', text: 'SOLUTIONS' }),
      solutionsNode(entry),
      h('span', { class: 'tmeta__k', text: 'SEED' }),
      h('span', { class: 'tmeta__v', text: entry.seed || '—' }),
      h('span', { class: 'tmeta__k', text: 'ROLLED' }),
      h('span', { class: 'tmeta__v', text: new Date(entry.createdAt).toLocaleDateString() }))
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
      const count = entry.times.length;
      const best = bestOf(entry.times);
      const active = entry.id === openId;
      return h('button', {
        class: `listrow${active ? ' is-active' : ''}`,
        type: 'button',
        'aria-current': active ? 'true' : null,
        onClick: () => {
          openId = entry.id;
          setTab('play');
          paintDetail();
          paintList();
          paintClock();
        }
      },
      h('div', {
        class: 'chip',
        style: {
          background: entry.dimension === '3D' ? 'rgba(53,167,255,0.16)' : 'rgba(0,229,160,0.14)',
          color: entry.dimension === '3D' ? '#5CB8FF' : 'var(--accent)'
        },
        text: String(entry.locked.length)
      }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'listrow__title', text: entryTitle(entry) }),
        h('div', { class: 'listrow__sub mono',
          text: `${entryPieces(entry)} · ${plural(count, 'run')}${entry.note ? ' · note' : ''}` })),
      h('div', { class: 'listrow__best mono', style: { color: best !== null ? 'var(--accent)' : 'var(--faint)' },
        text: best === null ? '—' : formatTime(best) }));
    })
    : [h('div', { class: 'tnote', style: { padding: '14px 2px' },
      text: store.setups.length
        ? 'No openings match that filter.'
        : 'Openings you roll are kept here with their times.' })]));
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
        body: `The file holds ${plural(incoming, 'opening')}. You have ${store.setups.length} here already.`,
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
      : `Merged in ${plural(report.addedSetups, 'new opening')} and ${plural(report.addedTimes, 'time')}.`);
    paintAll();
  } catch (error) {
    toast(error.message || 'That file could not be imported.', { warn: true });
  }
}

/** Where the times actually are, said plainly. */
function paintStorage() {
  const failed = store.writeFailed;
  const openings = store.setups.length;
  const times = store.timeCount;
  append(clear(nodes.storage), [
    h('div', { class: `savestate${failed ? ' is-warn' : ''}` },
      h('div', { class: 'savestate__icon', 'aria-hidden': 'true', text: failed ? '!' : '✓' }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'savestate__title',
          text: failed ? 'Not saving — memory only' : 'Saved on this device' }),
        h('div', { class: 'savestate__body',
          text: failed
            ? 'This browser is refusing to store anything (private mode, or storage is full). Export a backup before you close the tab.'
            : `${plural(openings, 'opening')} and ${plural(times, 'time')}, saved automatically in this browser the moment you record them. ` +
              'They stay after closing or going offline. Clearing site data deletes them, so export now and then.' }),
        store.persisted
          ? h('div', { class: 'savestate__note mono', text: 'PROTECTED FROM AUTOMATIC CLEANUP' })
          : null))
  ]);
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

  const action = (label, hint, onClick, disabled = false, extra = '') => h('button', {
    class: `databtn${extra}`,
    type: 'button',
    disabled,
    onClick
  },
  h('span', { class: 'databtn__label', text: label }),
  h('span', { class: 'databtn__hint', text: hint }));

  paintStorage();

  append(clear(nodes.data), [
    nodes.storage,
    action('Back up everything · JSON', 'The whole logbook, and the file Import reads back.',
      () => { exportJson(); toast('Logbook exported as JSON.'); }, empty, ' is-primary'),
    action('Import a backup', 'Merge a JSON backup in, or replace this logbook.',
      () => picker.click()),
    picker,
    h('div', { class: 'eyebrow tight', style: { margin: '10px 0 0' }, text: 'SPREADSHEETS AND TEXT' }),
    action('Times · CSV', 'One row per attempt.',
      () => { exportTimesCsv(); toast('Times exported as CSV.'); }, noTimes),
    action('Openings · CSV', 'One row per opening, with best, average and last.',
      () => { exportOpeningsCsv(); toast('Openings exported as CSV.'); }, empty),
    action('Text digest', 'A plain summary to paste anywhere.',
      () => { exportText(); toast('Logbook exported as text.'); }, empty),
    action('Copy digest to clipboard', 'The same summary, without a file.',
      () => copyText(logbookText(), 'Logbook copied.'), empty),
    h('div', { class: 'eyebrow tight', style: { margin: '10px 0 0' }, text: 'THIS PAGE' }),
    h('div', { class: 'mobile-only stack', style: { gap: '10px' } },
      action('Settings', 'Piece palette, contrast, motion.', settingsSheet),
      action('About Tabletop', 'How openings and the sheet work.', aboutSheet)),
    action('Clear the logbook', 'Deletes every opening and time on this device.',
      async () => {
        const ok = await confirmSheet({
          title: 'Clear the whole logbook?',
          body: 'Every opening and every time on this device goes. Export first if you want to keep them — this cannot be undone.',
          confirmLabel: 'Clear everything',
          variant: 'danger'
        });
        if (!ok) return;
        store.clear();
        openId = null;
        resetClock();
        toast('Logbook cleared.');
        paintAll();
      }, empty, ' is-danger')
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
        text: 'Times are saved in this browser only, the moment you record them. Export a backup to keep them safe or move them to another device.' }),
      h('div', { class: 'notice',
        text: 'ROWS ARE LETTERED A–E · COLUMNS NUMBERED FROM 1 · A PYRAMID SOCKET READS L2B3' })),
    actions: [{ label: 'Close', value: null, variant: 'primary' }]
  });
}

/* -------------------------------------------------------------- painting -- */

function paintAll() {
  paintTabs();
  paintGenerator();
  paintDetail();
  paintClock();
  paintList();
  paintSummary();
  paintData();
}

/* --------------------------------------------------------------- printing - */

/**
 * Print just the sheet. The page is an app shell, so printing it directly
 * would emit one clipped screenshot; a dedicated print node next to `#app`
 * gives the printer a plain flowing document instead.
 */
function printSheet(entry) {
  const setup = setupOf(entry);
  document.getElementById('printarea')?.remove();

  const area = h('div', { id: 'printarea' },
    h('div', { class: 'tprint__head' },
      h('div', { class: 'tprint__title', text: `TESSERA · ${entryTitle(entry).toUpperCase()}` }),
      h('div', { class: 'tprint__sub',
        text: `${plural(entry.locked.length, 'piece')} set out · ` +
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
      h('div', { class: 'desk-only' },
        h('div', { class: 'brand__name', text: 'Tessera' }),
        h('div', { class: 'eyebrow tight', text: 'TABLETOP' }))),
    nodes.tabs,
    h('div', { class: 'row', style: { gap: '8px' } },
      h('button', { class: 'iconbtn desk-only', type: 'button', 'aria-label': 'About this page', text: '?', onClick: aboutSheet }),
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

  nodes.layout = h('main', { class: 'tt2', 'data-tab': tab },
    h('div', { class: 'tt2__main' },
      h('div', { class: 'desk-only' },
        h('h1', { class: 'h1', style: { marginBottom: '8px' }, text: 'Tabletop' }),
        h('div', { class: 'sub',
          text: 'An opening for the set on your table, and somewhere to keep the times you get.' })),
      h('section', { class: 'tt2__summary', 'data-panel': 'log', 'aria-label': 'Totals' }, nodes.summary),
      h('section', { class: 'tt2__detail', 'data-panel': 'play', 'aria-label': 'Current opening' }, nodes.detail)),

    h('div', { class: 'tt2__side' },
      h('section', { class: 'tt2__gen stack', 'data-panel': 'play', 'aria-label': 'New opening', style: { gap: '12px' } },
        h('div', { class: 'eyebrow desk-only', text: 'NEW OPENING' }),
        nodes.generator),

      h('section', { class: 'tt2__log stack', 'data-panel': 'log', 'aria-label': 'Logbook', style: { gap: '12px' } },
        nodes.listHead,
        nodes.filters,
        nodes.list),

      h('section', { class: 'tt2__data stack', 'data-panel': 'data', 'aria-label': 'Your data', style: { gap: '12px' } },
        h('div', { class: 'eyebrow', text: 'YOUR DATA' }),
        nodes.data)));

  app.appendChild(h('div', { class: 'screen' },
    header(),
    storageWarning(),
    nodes.layout,
    nodes.dock));

  openId = store.setups[0]?.id || null;
  restoreClock();
  paintAll();
  if (clock.running) holdScreen(true);
  solverClient.warm();

  // Another tab changed the logbook: show its version rather than a stale one.
  store.addEventListener('change', (event) => {
    if (!event.detail?.external) return;
    if (!openId || !store.setup(openId)) openId = store.setups[0]?.id || null;
    paintAll();
  });

  // The screen lock is dropped whenever the page is hidden; take it back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && clock.running) {
      holdScreen(true);
      renderClock();
    }
  });

  // With the keyboard up, the dock would sit on top of the field being typed in.
  document.addEventListener('focusin', (event) => {
    if (event.target.matches?.('input:not([type=checkbox]):not([type=file]), textarea')) {
      document.body.classList.add('is-typing');
    }
  });
  document.addEventListener('focusout', () => document.body.classList.remove('is-typing'));

  // Space is the stopwatch, unless the player is typing — a time, a note, a
  // seed, or anything inside an open dialog.
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement &&
      (target.matches('input, textarea, select, button, summary, [contenteditable]') || target.closest('.sheet'))) return;
    if (!openId) return;
    event.preventDefault();
    toggleClock();
  });
}

mount();
