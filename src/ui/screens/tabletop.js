/**
 * Tabletop — openings for the physical set, and a logbook for the times.
 *
 * Two halves of one loop. The generator rolls a legal opening (how many pieces,
 * which pieces, which surface) and draws it as a lettered sheet you can copy
 * onto real beads. The logbook takes the stopwatch reading you bring back and
 * keeps it against that exact opening, so "my best on this one" means something
 * even though nothing here was played on screen.
 *
 * Every opening is lifted out of a complete fill, so the pieces left in the bag
 * always finish it — the generator cannot hand you an impossible board.
 */

import { PIECE_IDS, PIECE_BY_ID } from '../../core/pieces.js';
import {
  MIN_SETUP_PIECES, MAX_SETUP_PIECES, clampCount, newSeed,
  chooseSetupPieces, setupFromSolution, setupText, remainingPieces, remainingBeads,
  parseDuration, timeStats
} from '../../core/tabletop.js';
import { h, clear, append, formatTime, announce } from '../dom.js';
import { navigate } from '../router.js';
import { topbar, tabbar } from '../chrome.js';
import { store } from '../store.js';
import { solverClient } from '../solverClient.js';
import { toast, confirmSheet } from '../components/dialog.js';
import { setupSheet, setupLegend, remainingStrip } from '../components/setupSheet.js';
import { colorOf } from '../components/pieceArt.js';

/** Generator options survive leaving and coming back to the screen. */
const options = {
  dimension: '2D',
  count: 1,
  pick: 'random',
  pinned: new Set(),
  seed: ''
};

let openId = null;

const COUNTS = Array.from({ length: MAX_SETUP_PIECES - MIN_SETUP_PIECES + 1 }, (_, i) => i + MIN_SETUP_PIECES);

const dimensionLabel = (dimension) => (dimension === '3D' ? 'Pyramid' : 'Board');

/** "Board · 3 pieces" — how a logged opening names itself. */
function entryTitle(entry) {
  const n = entry.locked.length;
  return entry.label || `${dimensionLabel(entry.dimension)} · ${n} piece${n === 1 ? '' : 's'}`;
}

const entryPieces = (entry) => entry.locked.map((p) => p.piece).join('');

function segmented(items, current, onPick, { label } = {}) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || undefined },
    ...items.map((item) => h('button', {
      class: `seg__btn${item.value === current ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': item.value === current ? 'true' : 'false',
      onClick: () => onPick(item.value)
    }, h('span', { text: item.label }))));
}

/* ------------------------------------------------------------------------- */

export function render({ query = {} } = {}) {
  if (query.id) openId = query.id;
  if (!openId || !store.tabletopSetup(openId)) openId = store.tabletopSetups[0]?.id || null;

  const nodes = {
    generator: h('div', { class: 'stack', style: { gap: '18px' } }),
    detail: h('div', { class: 'stack', style: { gap: '18px' } }),
    listHead: h('div', { class: 'eyebrow', text: 'LOGBOOK' }),
    list: h('div', { class: 'stack', style: { gap: '9px' } })
  };

  let busy = false;

  /* ---------------------------------------------------------- generating -- */

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
      const entry = store.saveTabletopSetup({ dimension, locked, code, seed, pinned });

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

  /* ------------------------------------------------------------ generator -- */

  function countRow() {
    const chips = COUNTS.map((n) => h('button', {
      class: `numchip${n === options.count ? ' is-active' : ''}`,
      type: 'button',
      disabled: busy || n < options.pinned.size && options.pick === 'choose',
      'aria-pressed': n === options.count ? 'true' : 'false',
      'aria-label': `${n} starting piece${n === 1 ? '' : 's'}`,
      text: String(n),
      onClick: () => { options.count = n; paintGenerator(); }
    }));
    return h('div', { class: 'numrow' }, ...chips);
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
      h('span', { class: 'kbd', text: `${count} / 12` }))
    ]);
  }

  /* --------------------------------------------------------------- detail -- */

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
      const previousBest = timeStats(entry.times).bestMs;
      store.addTabletopTime(entry.id, ms, { assisted: assisted.checked });
      input.value = '';
      assisted.checked = false;
      const beatIt = previousBest !== null && ms < previousBest;
      toast(beatIt ? `New best: ${formatTime(ms)}.` : `Saved ${formatTime(ms)}.`);
      announce(`${formatTime(ms)} saved for ${entryTitle(entry)}.` +
        (beatIt ? ' That is a new best for this opening.' : ''));
      paintDetail();
      paintList();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });

    const statTile = (label, value) => h('div', { class: 'tstat' },
      h('div', { class: 'tstat__label', text: label }),
      h('div', { class: 'tstat__value', text: value }));

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
        statTile('BEST', best === null ? '—' : formatTime(best)),
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
              onClick: () => {
                store.removeTabletopTime(entry.id, time.id);
                paintDetail();
                paintList();
              }
            })))
          : h('div', { class: 'movelog__row' },
            h('div', { class: 'movelog__text', style: { color: 'var(--faint)' },
              text: 'NO TIMES YET — SET IT UP AND START A STOPWATCH' }))));
  }

  function actionsRow(entry) {
    const setup = { dimension: entry.dimension, locked: entry.locked, seed: entry.seed };

    const copy = async (text, done) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(done);
      } catch {
        toast(text, { ms: 9000 });
      }
    };

    return h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn btn--ghost btn--xs',
        type: 'button',
        text: 'Copy setup',
        onClick: () => copy(setupText(setup, { label: entryTitle(entry), code: entry.code }),
          'Setup copied as text.')
      }),
      h('button', {
        class: 'btn btn--ghost btn--xs',
        type: 'button',
        text: 'Copy code',
        onClick: () => copy(entry.code, 'Challenge code copied.')
      }),
      h('button', {
        class: 'btn btn--ghost btn--xs',
        type: 'button',
        text: 'Print sheet',
        onClick: () => printSheet(entry)
      }),
      h('button', {
        class: 'btn btn--soft btn--xs',
        type: 'button',
        text: 'Play it here',
        onClick: () => navigate(`/play/setup?code=${encodeURIComponent(entry.code)}`)
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
          store.removeTabletopSetup(entry.id);
          openId = store.tabletopSetups[0]?.id || null;
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

  function paintDetail() {
    const entry = openId ? store.tabletopSetup(openId) : null;

    if (!entry) {
      append(clear(nodes.detail), [h('div', { class: 'card', style: { textAlign: 'center', padding: '40px 24px' } },
        h('div', { class: 'eyebrow accent', style: { marginBottom: '12px' }, text: 'NOTHING SET OUT YET' }),
        h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '8px' },
          text: 'Roll an opening for your physical set' }),
        h('div', { class: 'sub', style: { lineHeight: '1.55', maxWidth: '420px', margin: '0 auto' },
          text: 'Pick how many pieces to start with and whether the engine chooses them or you do. ' +
            'Every opening it hands you can still be finished with the pieces left in the bag.' }))]);
      return;
    }

    const setup = { dimension: entry.dimension, locked: entry.locked, seed: entry.seed };
    const note = h('textarea', {
      class: 'tinput tinput--area',
      rows: '2',
      placeholder: 'Notes — where you got stuck, which corner to leave last…',
      'aria-label': 'Notes for this opening',
      onChange: (event) => { store.setTabletopNote(entry.id, event.target.value); paintList(); }
    });
    note.value = entry.note || '';

    append(clear(nodes.detail), [
      h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' } },
        h('div', null,
          h('div', { class: 'eyebrow accent tight', style: { marginBottom: '7px' },
            text: `${dimensionLabel(entry.dimension).toUpperCase()} · ${entry.locked.length} SET OUT · ${12 - entry.locked.length} TO PLACE` }),
          h('h2', { class: 'h2', style: { fontSize: '26px' }, text: entryTitle(entry) })),
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--faint)', textAlign: 'right' },
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
      timesPanel(entry),
      note
    ]);
  }

  /* ----------------------------------------------------------------- list -- */

  function paintList() {
    const setups = store.tabletopSetups;
    nodes.listHead.textContent = `LOGBOOK · ${setups.length}`;
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
        text: 'Openings you generate are kept here with their times.' })]));
  }

  function paintAll() {
    paintGenerator();
    paintDetail();
    paintList();
  }

  paintAll();

  // One copy of each panel, never two: the generator and the logbook are live
  // nodes, and a node cannot be in two containers at once. Which column they
  // land in — and the order they read in on a phone — is settled in CSS.
  const element = h('section', { class: 'screen' },
    topbar(null, { back: '/modes', title: 'TABLETOP' }),
    h('div', { class: 'mob-only', style: { padding: '26px 22px 18px', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'eyebrow tight', style: { marginBottom: '8px' }, text: 'FOR THE PHYSICAL SET' }),
      h('h1', { class: 'h1', text: 'Tabletop' })),

    h('div', { class: 'tt2 scroll' },
      h('div', { class: 'tt2__main' },
        h('div', { class: 'desk-only' },
          h('h1', { class: 'h1', style: { marginBottom: '8px' }, text: 'Tabletop' }),
          h('div', { class: 'sub',
            text: 'An opening for the set on your table, and somewhere to keep the times you get.' })),
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
          nodes.list))),

    tabbar(null));

  return { element };
}

/* ---------------------------------------------------------------- printing - */

/**
 * Print just the sheet. The page is a fixed-height app shell, so printing it
 * directly would emit one clipped screenshot; a dedicated print node next to
 * `#app` gives the printer a plain flowing document instead.
 */
function printSheet(entry) {
  const setup = { dimension: entry.dimension, locked: entry.locked, seed: entry.seed };
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
