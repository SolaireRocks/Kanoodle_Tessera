/**
 * M-05 / M-06 / D-04 / D-05 — gameplay.
 *
 * One screen drives both dimensions. It owns the run (a Session), the current
 * selection, the hint ladder and the solve player; the board component owns
 * input and rendering. Everything the player can do has a visible control, and
 * every visible control has a keyboard route (§5.1).
 */

import { PIECE_BY_ID } from '../../core/pieces.js';
import { h, clear, formatClock, formatTime, announce } from '../dom.js';
import { navigate } from '../router.js';
import { topbar } from '../chrome.js';
import { store } from '../store.js';
import { solverClient } from '../solverClient.js';
import { Board2D } from '../components/board2d.js';
import { Pyramid3D } from '../components/pyramid3d.js';
import { miniGrid, isoPreview } from '../components/pieceArt.js';
import { sheet, confirmSheet, toast } from '../components/dialog.js';
import { buildPlay, advanceTimeAttack, clearTimeAttack, freePuzzleId } from '../sessionFactory.js';
import { setLastResult } from './complete.js';

const HINT_STEPS = [
  'Piece %s can be placed next.',
  'Piece %s, in this orientation.',
  'Piece %s goes here.'
];

const OPENING_HELP =
  'Choose any piece and drop it anywhere on the board. It locks in as the ' +
  'setup — then the other eleven are yours to fit around it. Or roll one.';

export function render({ segments, query }) {
  const built = buildPlay(segments, query);
  if (!built) {
    navigate('/home', { replace: true });
    return { element: h('div') };
  }

  const { session, entry, rules } = built;
  const is3d = session.dimension === '3D';
  const laboratory = session.mode === 'lab';
  // §4 Free mode — the run has no authored setup, so it opens on a board the
  // player seeds themselves. Everything downstream then behaves like a normal
  // puzzle with eleven pieces remaining.
  const freeMode = session.mode === 'free';
  let awaitingOpening = freeMode && session.locked.length === 0;
  let checkingOpening = false;

  let selection = null;   // { pieceId, orientationIndex }
  let held = null;        // a piece lifted off the board, mid-drag
  let hint = null;        // { level, placement }
  let solving = false;
  let finished = false;
  let ghostLost = false;

  const nodes = { orientHosts: [], orientLabels: [], ghosts: [] };

  const view = is3d
    ? new Pyramid3D({
      session,
      getSelection: () => selection,
      onPlace: commitPlace,
      onLift: liftPiece,
      onInvalid: invalidFeedback,
      onSelect: selectPiece,
      onLayerChange: renderLayerTabs
    })
    : new Board2D({
      session,
      getSelection: () => selection,
      onPlace: commitPlace,
      onLift: liftPiece,
      onPickUp: pickUp,
      onCancelPickUp: cancelPickUp,
      onInvalid: invalidFeedback,
      onSelect: selectPiece
    });

  /* ------------------------------------------------------------- selection */

  const orientationsFor = (pieceId) =>
    (is3d ? PIECE_BY_ID[pieceId].orientations3d : PIECE_BY_ID[pieceId].orientations2d);

  function selectPiece(pieceId, orientationIndex = 0) {
    selection = pieceId
      ? { pieceId, orientationIndex: orientationIndex % orientationsFor(pieceId).length }
      : null;
    update();
    if (selection) {
      announce(`Piece ${selection.pieceId} selected, orientation ` +
        `${selection.orientationIndex + 1} of ${orientationsFor(selection.pieceId).length}. ` +
        (is3d
          ? 'Choose an orientation, then activate a socket to place it.'
          : 'Move to the board, then use the arrow keys and Enter to place it.'));
    }
  }

  /** Rotate steps to a real neighbouring orientation, not the next array slot. */
  function rotate(direction = 1) {
    if (!selection) { toast('Select a piece first.'); return; }
    const orientation = orientationsFor(selection.pieceId)[selection.orientationIndex];
    const next = is3d ? orientation.yaw : (direction > 0 ? orientation.cw : orientation.ccw);
    if (next === selection.orientationIndex) {
      toast(`Piece ${selection.pieceId} looks the same rotated.`);
      return;
    }
    selection.orientationIndex = next;
    update();
    announce(`Rotated. Orientation ${next + 1}.`);
  }

  function tilt() {
    if (!selection || !is3d) return;
    const orientation = orientationsFor(selection.pieceId)[selection.orientationIndex];
    if (orientation.tilt === selection.orientationIndex) {
      toast(`Piece ${selection.pieceId} looks the same tilted.`);
      return;
    }
    selection.orientationIndex = orientation.tilt;
    update();
    announce('Tilted.');
  }

  function flip() {
    if (!selection) { toast('Select a piece first.'); return; }
    const orientation = orientationsFor(selection.pieceId)[selection.orientationIndex];
    if (orientation.mirror === selection.orientationIndex) {
      toast(`Piece ${selection.pieceId} is symmetrical — flipping changes nothing.`);
      return;
    }
    selection.orientationIndex = orientation.mirror;
    update();
    announce('Piece flipped.');
  }

  /* ---------------------------------------------------------------- moves */

  /** Take a placed piece off the board for the duration of a drag. */
  function pickUp(pieceId) {
    held = session.pickUp(pieceId);
    if (!held) return;
    selection = { pieceId, orientationIndex: held.entry.orientation };
    hint = null;
    view.setHint(null);
    update();
  }

  function cancelPickUp() {
    if (!held) return;
    session.putBack(held);
    held = null;
    update();
  }

  /* --------------------------------------------------------- free opening */

  /**
   * A first piece is only accepted where the remaining eleven still fit, so
   * Free mode can never hand the player a board that cannot be finished.
   */
  async function chooseOpening(placement) {
    if (checkingOpening) return;
    checkingOpening = true;
    // Show the footprint while the solver decides; the piece is not committed
    // to the session until it is known to be a solvable opening.
    view.setHint(placement.cells);
    setOpeningBusy(true, `Checking piece ${placement.piece} there…`);
    const opening = { piece: placement.piece, cells: placement.cells.slice() };
    const solution = await solverClient.findOneSolution({
      dimension: session.dimension,
      locked: [opening],
      placed: []
    });
    checkingOpening = false;
    setOpeningBusy(false);
    view.setHint(null);
    if (!solution) {
      invalidFeedback(`Piece ${placement.piece} there leaves no complete fill. Try another spot.`);
      return;
    }
    lockOpening(placement);
  }

  /** Roll a piece and a position: one placement out of a whole random fill. */
  async function randomOpening() {
    if (checkingOpening || !awaitingOpening) return;
    checkingOpening = true;
    setOpeningBusy(true, 'Rolling an opening…');
    const solution = await solverClient.randomSolution(
      { dimension: session.dimension, locked: [], placed: [] },
      `free/${Date.now()}/${Math.random()}`
    );
    checkingOpening = false;
    setOpeningBusy(false);
    if (!solution?.length) { invalidFeedback('Could not roll an opening. Try again.'); return; }
    lockOpening(solution[Math.floor(Math.random() * solution.length)], { rolled: true });
  }

  /** Promote the chosen placement to the setup and start the run for real. */
  function lockOpening(placement, { rolled = false } = {}) {
    session.lockSetup(placement);
    session.puzzleId = freePuzzleId(session.dimension, session.locked);
    session.subtitle = `FREE MODE · OPENING ${placement.piece}`;
    session.shortSubtitle = `FREE · OPENING ${placement.piece}`;
    if (nodes.subtitleD) nodes.subtitleD.textContent = session.subtitle;
    if (nodes.subtitleM) nodes.subtitleM.textContent = session.shortSubtitle;

    awaitingOpening = false;
    nodes.openingPanel?.remove();
    nodes.openingPanel = null;
    hint = null;
    view.setHint(null);

    const remaining = session.remainingPieces();
    selection = remaining.length ? { pieceId: remaining[0], orientationIndex: 0 } : null;
    update();
    view.markPlaced(placement.cells);
    startClock();
    persist();
    toast(rolled ? `Rolled piece ${placement.piece}.` : `Piece ${placement.piece} locked in.`);
    announce(`Piece ${placement.piece} is the setup, at ${session.target.describeCell(placement.cells[0])}. ` +
      `${remaining.length} pieces left to place. The clock is running.`);
  }

  function setOpeningBusy(busy, message = null) {
    if (nodes.openingRandom) nodes.openingRandom.disabled = busy;
    if (nodes.openingPanel) {
      if (busy) nodes.openingPanel.setAttribute('aria-busy', 'true');
      else nodes.openingPanel.removeAttribute('aria-busy');
    }
    if (nodes.openingNote) nodes.openingNote.textContent = message || OPENING_HELP;
  }

  function commitPlace(placement) {
    if (awaitingOpening) { chooseOpening(placement); return; }
    const from = held;
    held = null;
    if (!session.place(placement, { from })) {
      if (from) session.putBack(from);
      invalidFeedback('That placement is not legal.');
      update();
      return;
    }
    hint = null;
    view.setHint(null);
    if (store.settings.haptics && navigator.vibrate) navigator.vibrate(10);
    if (!is3d) view.markPlaced(placement.cells);
    const remaining = session.remainingPieces();
    selection = remaining.length ? { pieceId: remaining[0], orientationIndex: 0 } : null;
    update();
    persist();
    announce(`Piece ${placement.piece} placed. ${session.filledCount()} of ${session.target.size} sockets filled.`);
    checkComplete();
  }

  function liftPiece(pieceId) {
    session.remove(pieceId);
    hint = null;
    view.setHint(null);
    update();
    persist();
  }

  function invalidFeedback(message) {
    toast(message, { warn: true });
    if (store.settings.haptics && navigator.vibrate) navigator.vibrate([12, 40, 12]);
  }

  function undo() {
    if (!session.undo()) return;
    hint = null;
    view.setHint(null);
    update();
    persist();
    announce('Move undone.');
  }

  function redo() {
    if (!session.redo()) return;
    update();
    persist();
  }

  async function reset() {
    if (!session.placed.length) return;
    const ok = await confirmSheet({
      title: 'Reset to the starting setup?',
      body: 'Every piece you placed comes off. The clock keeps running.',
      confirmLabel: 'Reset'
    });
    if (!ok) return;
    session.reset();
    hint = null;
    selection = null;
    view.setHint(null);
    update();
    persist();
    announce('Board reset to the starting setup.');
  }

  /* ------------------------------------------------------------ hint ladder */

  async function requestHint() {
    if (!rules.allowHint) { toast('Hints are off in this mode.', { warn: true }); return; }
    if (session.isComplete() || solving) return;

    if (hint && hint.level < 3) {
      hint.level += 1;
      applyHint();
      return;
    }

    nodes.hintBtn?.setAttribute('aria-busy', 'true');
    nodes.hintDock?.setAttribute('aria-busy', 'true');
    const placement = await solverClient.recommendMove(session.toSolverState());
    nodes.hintBtn?.removeAttribute('aria-busy');
    nodes.hintDock?.removeAttribute('aria-busy');

    if (!placement) { await offerRecovery(); return; }
    session.noteHint(rules.hintPenaltyMs);
    hint = { level: 1, placement };
    applyHint();
    persist();
  }

  function applyHint() {
    const { level, placement } = hint;
    if (level >= 2) selection = { pieceId: placement.piece, orientationIndex: placement.orientation };
    view.setHint(level >= 3 ? placement.cells : null);
    update();
    announce(HINT_STEPS[level - 1].replace('%s', placement.piece) +
      (level >= 3 ? ` At ${session.target.describeCell(placement.cells[0])}.` : ''));
  }

  /* ----------------------------------------------------------------- solve */

  async function requestSolve({ silent = false } = {}) {
    if (!rules.allowSolve && !silent) { toast('Solve is disabled in this mode.', { warn: true }); return; }
    if (solving || session.isComplete()) return;

    if (!silent && !laboratory) {
      const ok = await confirmSheet({
        title: 'Reveal a complete solution?',
        body: 'This attempt will be marked Assisted, and the time will not count towards your rating.',
        confirmLabel: 'Solve'
      });
      if (!ok) return;
    }

    solving = true;
    update();
    const slowNotice = setTimeout(() => toast('Searching for a solution…', { ms: 1400 }), 500);
    const solution = await solverClient.findOneSolution(session.toSolverState());
    clearTimeout(slowNotice);

    if (!solution) {
      solving = false;
      update();
      await offerRecovery();
      return;
    }

    if (!silent && !laboratory) session.noteSolve();
    await playSolution(solution, { instant: store.settings.reduceMotion });
    solving = false;
    update();
    persist();
    announce(`Solution shown. ${solution.length} ${solution.length === 1 ? 'piece' : 'pieces'} placed.`);
    checkComplete();
  }

  /**
   * §7.2 — animate the remaining pieces one at a time, with a transport the
   * player can pause, step through and run to the end.
   */
  function playSolution(solution, { instant = false } = {}) {
    return new Promise((resolve) => {
      if (instant) {
        for (const placement of solution) session.place(placement, { record: false, source: 'solver' });
        update();
        resolve();
        return;
      }

      let index = 0;
      let paused = false;
      let timer = null;
      let settled = false;

      const label = h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--dim)', minWidth: '48px' } });
      const fill = h('i', { style: { width: '0%' } });
      const pauseBtn = h('button', { class: 'iconbtn', 'aria-label': 'Pause or resume', text: 'II' });

      const step = (delta) => {
        if (delta > 0 && index < solution.length) {
          session.place(solution[index], { record: false, source: 'solver' });
          index++;
        } else if (delta < 0 && index > 0) {
          index--;
          session.remove(solution[index].piece, { record: false });
        }
        label.textContent = `${index} / ${solution.length}`;
        fill.style.width = `${(index / solution.length) * 100}%`;
        update();
        if (index >= solution.length) settle();
      };

      const tick = () => {
        if (paused) return;
        step(1);
        if (index < solution.length) timer = setTimeout(tick, 340);
      };

      const hold = () => { paused = true; pauseBtn.textContent = '▶'; clearTimeout(timer); };

      const transport = h('div', {
        class: 'toast',
        style: { display: 'flex', alignItems: 'center', gap: '10px', pointerEvents: 'auto' },
        role: 'group',
        'aria-label': 'Solution playback'
      },
      h('span', { class: 'eyebrow tight accent', text: 'SOLVING' }),
      h('div', { class: 'bar', style: { width: '110px' } }, fill),
      label,
      h('button', { class: 'iconbtn', 'aria-label': 'Step back', text: '◀', onClick: () => { hold(); step(-1); } }),
      pauseBtn,
      h('button', { class: 'iconbtn', 'aria-label': 'Step forward', text: '▶', onClick: () => { hold(); step(1); } }),
      h('button', { class: 'iconbtn', 'aria-label': 'Finish now', text: '⏭', onClick: () => { clearTimeout(timer); paused = true; while (index < solution.length) step(1); } }));

      pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? '▶' : 'II';
        if (!paused) tick();
      });

      function settle() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setTimeout(() => transport.remove(), 600);
        resolve();
      }

      document.body.appendChild(transport);
      label.textContent = `0 / ${solution.length}`;
      tick();
    });
  }

  /** §7.2 — a legal but dead board gets recovery options, never a dead end. */
  async function offerRecovery() {
    const conflict = await solverClient.findConflictingMoves(session.toSolverState());
    if (!conflict) { toast('No solution from here.', { warn: true }); return; }

    if (conflict.setupUnsolvable) {
      await sheet({
        title: 'This setup has no solution',
        body: 'Nothing you placed caused it. Resetting will restore the authored starting position.',
        actions: [{ label: 'Reset', value: true, variant: 'primary' }]
      });
      session.reset();
      update();
      persist();
      return;
    }

    const pieces = conflict.offending.map((p) => p.piece).join(', ');
    const choice = await sheet({
      title: 'No solution from here',
      body: `The board is legal but cannot be finished. Undoing your last ${conflict.undoCount} ` +
        `${conflict.undoCount === 1 ? 'move' : 'moves'} (piece ${pieces}) opens it up again.`,
      actions: [
        { label: 'Reset and solve', value: 'reset', variant: 'ghost' },
        { label: `Undo ${conflict.undoCount}`, value: 'undo', variant: 'primary' }
      ]
    });

    if (choice === 'undo') {
      session.undoMoves(conflict.undoCount);
      hint = null;
      update();
      persist();
      announce(`${conflict.undoCount} moves undone. The puzzle can be finished again.`);
    } else if (choice === 'reset') {
      session.reset();
      update();
      persist();
      await requestSolve({ silent: true });
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  function persist() {
    // A run with no opening yet is not worth resuming into.
    if (laboratory || rules.demo || finished || awaitingOpening) return;
    store.saveSession(session);
  }

  async function checkComplete() {
    if (finished || !session.isComplete()) return;
    // §3.2 — trust the rules engine, not visual occupancy.
    const check = await solverClient.validate(session.toSolverState());
    if (!check.legal || !check.complete) return;

    finished = true;
    stopClock();
    const result = session.finish();

    if (laboratory || rules.demo) {
      toast('Board complete — all 55 sockets filled.');
      update();
      return;
    }

    const outcome = store.recordResult(result);
    if (session.mode === 'timeattack') outcome.queue = advanceTimeAttack(result);

    setLastResult({ session, result, outcome, entry, rules, ghostLost });
    store.clearSession();
    navigate('/complete');
  }

  /* ------------------------------------------------------------------ clock */

  let ticker = null;

  function startClock() {
    if (rules.timer === 'none' || laboratory || finished || awaitingOpening) return;
    session.start();
    clearInterval(ticker);
    ticker = setInterval(onTick, 250);
  }

  function stopClock() {
    clearInterval(ticker);
    ticker = null;
    session.pause();
  }

  const remainingBudget = () => Math.max(0, rules.budgetMs - session.timeMs);

  function onTick() {
    paintClock();
    if (rules.timer === 'down' && remainingBudget() <= 0) { stopClock(); onTimeUp(); }
    if (rules.ghostMs && !ghostLost && session.timeMs > rules.ghostMs) {
      ghostLost = true;
      toast('The pace ghost finished. Keep going for the clean board.', { warn: true });
    }
  }

  async function onTimeUp() {
    if (finished) return;
    finished = true;
    clearTimeAttack();
    await sheet({
      title: 'Time',
      body: 'The Time Attack clock ran out. Ranked runs end when the clock does.',
      actions: [{ label: 'Back to modes', value: true, variant: 'primary' }]
    });
    navigate('/modes');
  }

  function paintClock() {
    if (!timed) return;
    const text = formatClock(rules.timer === 'down' ? remainingBudget() : session.timeMs);
    for (const node of [nodes.clockM, nodes.clockD]) if (node) node.textContent = text;
    for (const node of nodes.ghosts) {
      node.textContent = ghostLost ? 'GHOST HOME' : `GHOST ${formatClock(Math.max(0, rules.ghostMs - session.timeMs))}`;
      node.style.color = ghostLost ? 'var(--danger)' : 'var(--muted)';
    }
  }

  /* -------------------------------------------------------------- rendering */

  function trayPiece(pieceId) {
    const selected = selection?.pieceId === pieceId;
    const orientationIndex = selected ? selection.orientationIndex : 0;
    const piece = PIECE_BY_ID[pieceId];
    const art = is3d
      ? isoPreview(pieceId, piece.orientations3d[orientationIndex].cells, { size: 42 })
      : miniGrid(pieceId, piece.orientations2d[orientationIndex], { size: 11 });

    const node = h('button', {
      class: 'traypiece' +
        (selected ? ' is-selected' : '') +
        (hint && hint.placement.piece === pieceId ? ' is-hinted' : ''),
      type: 'button',
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': `Piece ${pieceId}, ${piece.beads} beads${selected ? ', selected' : ''}`,
      onClick: () => selectPiece(selected ? null : pieceId, orientationIndex)
    }, art, h('span', { class: 'traypiece__label', text: `PIECE ${pieceId}` }));

    if (!is3d) {
      // Drag straight out of the tray — the fastest path (§5.1).
      node.addEventListener('pointerdown', (event) => {
        if (event.button) return;
        selectPiece(pieceId, orientationIndex);
        event.preventDefault();
        view.beginDrag({
          pieceId,
          orientationIndex,
          grabIndex: 0,
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          origin: 'tray'
        });
      });
    }
    return node;
  }

  function renderTray() {
    const remaining = session.remainingPieces();
    for (const host of [nodes.trayM, nodes.trayD]) {
      if (!host) continue;
      clear(host);
      if (!remaining.length) {
        host.appendChild(h('div', { class: 'sub', text: 'Every piece is on the board.' }));
        continue;
      }
      for (const pieceId of remaining) host.appendChild(trayPiece(pieceId));
    }
    if (nodes.trayCount) nodes.trayCount.textContent = `${remaining.length} LEFT`;
    for (const label of nodes.remainLabels || []) label.textContent = `REMAINING · ${remaining.length}`;
  }

  function renderOrientations() {
    const label = selection ? `ORIENTATION · PIECE ${selection.pieceId}` : 'ORIENTATION · NO PIECE SELECTED';
    for (const node of nodes.orientLabels) node.textContent = label;

    for (const host of nodes.orientHosts) {
      clear(host);
      if (!selection) continue;
      const all = orientationsFor(selection.pieceId);
      all.forEach((orientation, i) => {
        const art = is3d
          ? isoPreview(selection.pieceId, orientation.cells, { size: 38 })
          : miniGrid(selection.pieceId, orientation, { size: 8 });
        host.appendChild(h('button', {
          class: `orientbtn${i === selection.orientationIndex ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': i === selection.orientationIndex ? 'true' : 'false',
          'aria-label': `Orientation ${i + 1} of ${all.length}`,
          onClick: () => { selection.orientationIndex = i; update(); }
        }, art));
      });
    }
  }

  function renderLayerTabs() {
    if (!is3d) return;
    const stats = view.layerStats();

    if (nodes.layers) {
      clear(nodes.layers);
      for (const stat of stats) {
        nodes.layers.appendChild(h('button', {
          class: 'layertab' + (view.activeLayer === stat.layer ? ' is-active' : '') + (stat.done ? ' is-done' : ''),
          type: 'button',
          'aria-pressed': view.activeLayer === stat.layer ? 'true' : 'false',
          'aria-label': `Layer ${stat.layer + 1}, ${stat.filled} of ${stat.total} beads`,
          onClick: () => view.setActiveLayer(view.activeLayer === stat.layer ? null : stat.layer)
        },
        h('span', { class: 'layertab__n', text: `L${stat.layer + 1}` }),
        h('span', { class: 'layertab__state', text: stat.done ? 'FULL' : `${stat.filled}/${stat.total}` })));
      }
    }

    if (nodes.layerRows) {
      clear(nodes.layerRows);
      for (const stat of stats) {
        const side = Math.round(Math.sqrt(stat.total));
        nodes.layerRows.appendChild(h('button', {
          class: `listrow${view.activeLayer === stat.layer ? ' is-active' : ''}`,
          type: 'button',
          style: { minHeight: '58px', padding: '12px 14px', background: view.activeLayer === stat.layer ? undefined : 'transparent' },
          onClick: () => view.setActiveLayer(view.activeLayer === stat.layer ? null : stat.layer)
        },
        h('span', { class: 'mono', style: { fontSize: '14px', fontWeight: '700', color: stat.done ? 'var(--text-3)' : 'var(--faint)' }, text: `L${stat.layer + 1}` }),
        h('span', { style: { flex: '1', fontSize: '14px', color: 'var(--text-2)' }, text: `${side} × ${side} · ${stat.total} beads` }),
        h('span', { class: 'mono', style: { fontSize: '11px', color: stat.done ? 'var(--accent)' : 'var(--faint)' }, text: stat.done ? 'FULL' : `${stat.filled} / ${stat.total}` })));
      }
    }
  }

  function renderStats() {
    if (nodes.runStats) {
      // Free runs are keyed by their opening, so "vs best" compares like with like.
      const best = (entry ? store.progressFor(entry.puzzle.id) : store.progressFor(session.puzzleId))?.bestMs ?? null;
      const expected = session.parMs * (session.filledCount() / session.target.size);
      const pace = session.parMs ? (session.timeMs <= expected ? 'AHEAD' : 'BEHIND') : '—';
      const rows = [
        { label: 'MOVES', value: String(session.moveCount) },
        { label: 'UNDOS', value: String(session.undoCount) },
        { label: 'VS BEST', value: best ? `${session.timeMs < best ? '−' : '+'}${formatTime(Math.abs(session.timeMs - best))}` : '—', accent: best ? session.timeMs < best : false },
        { label: 'PACE', value: pace, accent: pace === 'AHEAD' }
      ];
      clear(nodes.runStats);
      for (const row of rows) {
        nodes.runStats.appendChild(h('div', { class: 'card stat' },
          h('div', { class: 'stat__label', text: row.label }),
          h('div', { class: `stat__value${row.accent ? ' accent' : ''}`, style: { fontSize: '21px' }, text: row.value })));
      }
    }

    if (nodes.moveLog) {
      clear(nodes.moveLog);
      const entries = session.log.slice(0, 5);
      if (!entries.length) {
        nodes.moveLog.appendChild(h('div', { class: 'movelog__row' },
          h('div', { class: 'movelog__text', style: { color: 'var(--faint)' }, text: 'NO MOVES YET' })));
      }
      for (const item of entries) {
        nodes.moveLog.appendChild(h('div', { class: 'movelog__row' },
          h('div', { class: `movelog__dot${item.warn ? ' is-warn' : ''}` }),
          h('div', { class: 'movelog__text', text: item.text }),
          h('div', { class: 'movelog__t', text: formatClock(item.ms) })));
      }
    }
  }

  function renderProgress() {
    const filled = session.filledCount();
    const ratio = filled / session.target.size;
    for (const fill of [nodes.barM, nodes.barD]) if (fill) fill.style.width = `${ratio * 100}%`;
    if (nodes.countM) nodes.countM.textContent = `${filled}/${session.target.size}`;
    if (nodes.countD) nodes.countD.textContent = `${filled} / ${session.target.size} SOCKETS`;
    if (nodes.beadCount) nodes.beadCount.textContent = String(filled);
  }

  function update() {
    view.refresh();
    view.refreshCursorPreview?.();
    renderTray();
    renderOrientations();
    renderLayerTabs();
    renderStats();
    renderProgress();
    paintClock();

    const hasSelection = Boolean(selection);
    const canUndo = session.canUndo();
    const canReset = session.placed.length > 0;
    const busy = solving || finished;

    const disable = (key, enabled) => { if (nodes[key]) nodes[key].disabled = busy || !enabled; };
    disable('undoBtn', canUndo);
    disable('undoAlt', canUndo);
    disable('undoDock', canUndo);
    disable('resetBtn', canReset);
    disable('resetAlt', canReset);
    disable('resetDock', canReset);
    disable('rotateBtn', hasSelection);
    disable('rotateDock', hasSelection);
    disable('flipBtn', hasSelection);
    disable('flipDock', hasSelection);
    disable('tiltDock', hasSelection);
    // Nothing to hint at or solve until the board has an opening on it.
    disable('hintBtn', !awaitingOpening);
    disable('hintDock', !awaitingOpening);
    disable('solveBtn', !awaitingOpening);
    disable('solveDock', !awaitingOpening);

    if (nodes.selectedLabel) {
      nodes.selectedLabel.textContent = selection ? `SELECTED · PIECE ${selection.pieceId}` : 'SELECTED · NONE';
    }
  }

  /* --------------------------------------------------------------- keyboard */

  function onKey(event) {
    if (event.target.matches?.('input, textarea')) return;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (meta) return;

    switch (event.key.toLowerCase()) {
      case 'r': event.preventDefault(); if (event.shiftKey) reset(); else rotate(1); break;
      case 'q': if (!is3d) { event.preventDefault(); rotate(-1); } break;
      case 'e': if (!is3d) { event.preventDefault(); rotate(1); } break;
      case 'f': event.preventDefault(); flip(); break;
      case 't': if (is3d) { event.preventDefault(); tilt(); } break;
      case 'h': event.preventDefault(); requestHint(); break;
      case 's': if (!is3d) { event.preventDefault(); requestSolve(); } break;
      case 'escape': event.preventDefault(); openPause(); break;
      default: {
        const n = Number(event.key);
        if (Number.isInteger(n) && n >= 1) {
          const remaining = session.remainingPieces();
          if (remaining[n - 1]) { event.preventDefault(); selectPiece(remaining[n - 1], 0); }
        }
      }
    }
  }

  async function openPause() {
    if (finished) return;
    const wasRunning = session.running;
    stopClock();
    const choice = await sheet({
      title: timed ? 'Paused' : 'Menu',
      body: `${session.title} · ${session.filledCount()} of ${session.target.size} sockets filled.`,
      actions: [
        { label: 'Quit', value: 'quit', variant: 'ghost' },
        freeMode && !awaitingOpening ? { label: 'New opening', value: 'opening', variant: 'ghost' } : null,
        { label: 'How to play', value: 'help', variant: 'ghost' },
        { label: 'Resume', value: 'resume', variant: 'primary' }
      ].filter(Boolean)
    });
    if (choice === 'quit') { persist(); navigate(rules.backHref); return; }
    if (choice === 'opening') { store.clearSession(); navigate('/play/free'); return; }
    if (choice === 'help') { const { helpSheet } = await import('./help.js'); await helpSheet(); }
    if (wasRunning) startClock();
  }

  /* ----------------------------------------------------------------- layout */

  const dockButton = (icon, label, onClick, { accent = false, ref } = {}) => {
    const node = h('button', {
      class: `dockbtn${accent ? ' is-accent' : ''}`,
      type: 'button',
      'aria-label': label,
      onClick
    },
    h('span', { class: 'dockbtn__icon', text: icon }),
    h('span', { class: 'dockbtn__label', text: label }));
    if (ref) nodes[ref] = node;
    return node;
  };

  const controlButton = (icon, label, key, onClick, ref) => {
    const node = h('button', {
      class: 'dockbtn',
      type: 'button',
      style: { flexDirection: 'row', gap: '8px' },
      'aria-label': `${label} (${key})`,
      onClick
    },
    h('span', { class: 'dockbtn__icon', text: icon }),
    h('span', { style: { fontSize: '14px', color: 'var(--text-3)' }, text: label }),
    h('span', { class: 'mono', style: { fontSize: '10px', color: 'var(--faint)' }, text: key }));
    if (ref) nodes[ref] = node;
    return node;
  };

  const ghostNode = () => {
    if (!rules.ghostMs) return null;
    const node = h('div', { class: 'mono', style: { fontSize: '11px', letterSpacing: '0.14em', color: 'var(--muted)' } });
    nodes.ghosts.push(node);
    return node;
  };

  const timed = rules.timer !== 'none';
  nodes.clockM = timed ? h('div', { class: 'mhead__clock', text: '00:00' }) : null;
  nodes.clockD = timed ? h('div', { class: 'topbar__clock', text: '00:00' }) : null;
  nodes.barM = h('i', { style: { width: '0%' } });
  nodes.barD = h('i', { style: { width: '0%' } });
  nodes.countM = h('div', { class: 'mono', style: { fontSize: '10px', color: 'var(--dim)', letterSpacing: '0.1em' } });
  nodes.countD = h('div', { class: 'mono', style: { fontSize: '12px', color: 'var(--dim)', letterSpacing: '0.12em' } });
  nodes.trayM = h('div', { class: 'tray' });
  nodes.trayD = h('div', { class: 'tray--grid' });
  nodes.trayCount = h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--accent)' } });
  nodes.selectedLabel = h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'SELECTED · NONE' });
  nodes.runStats = is3d ? null : h('div', { class: 'grid2' });
  nodes.moveLog = is3d ? null : h('div', { class: 'movelog' });
  nodes.remainLabels = [];

  nodes.hintBtn = h('button', { class: 'btn btn--soft btn--sm', onClick: requestHint },
    h('span', { text: 'Hint' }),
    h('span', { class: 'kbd', text: rules.hintPenaltyMs ? `H · +${formatTime(rules.hintPenaltyMs)}` : 'H' }));
  nodes.solveBtn = h('button', {
    class: 'btn btn--dashed btn--sm',
    text: is3d ? 'Solve pyramid' : 'Solve puzzle',
    onClick: () => requestSolve()
  });
  nodes.undoBtn = h('button', { class: 'btn btn--ghost btn--sm', style: { flex: '1' }, onClick: undo },
    h('span', { text: 'Undo' }), h('span', { class: 'kbd', text: '⌘Z' }));
  nodes.resetBtn = h('button', { class: 'btn btn--ghost btn--sm', style: { flex: '1' }, text: 'Reset', onClick: reset });

  const remainLabel = (text) => {
    const node = h('div', { class: 'eyebrow tight', text });
    nodes.remainLabels.push(node);
    return node;
  };

  const orientLabel = () => {
    const node = h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'ORIENTATION' });
    nodes.orientLabels.push(node);
    return node;
  };

  const orientStrip = (wrap = false) => {
    // The wide layout wraps into a scrollable well; the narrow one scrolls
    // sideways as a single strip.
    const node = h('div', { class: `orientstrip${wrap ? ' orientstrip--wrap' : ''}` });
    nodes.orientHosts.push(node);
    return node;
  };

  /**
   * §4 Free mode — the opening chooser. It sits above the board in both
   * layouts and comes away the moment a piece is locked in.
   */
  function openingPanel() {
    if (!awaitingOpening) return null;
    nodes.openingNote = h('div', {
      style: { fontSize: '14px', color: 'var(--dim)', lineHeight: '1.5' },
      text: OPENING_HELP
    });
    nodes.openingRandom = h('button', {
      class: 'btn btn--primary btn--sm',
      style: { flex: '1', minWidth: '170px' },
      text: 'Random opening',
      onClick: randomOpening
    });
    nodes.openingPanel = h('div', {
      class: 'card',
      role: 'group',
      'aria-label': 'Choose an opening piece',
      style: { width: '100%', maxWidth: '540px', display: 'flex', flexDirection: 'column', gap: '12px' }
    },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('div', { class: 'eyebrow tight accent', text: 'FREE MODE · OPENING' }),
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--faint)', letterSpacing: '0.12em' }, text: 'ALL 12 IN HAND' })),
    nodes.openingNote,
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, nodes.openingRandom),
    h('div', { class: 'notice', text: 'ONLY OPENINGS THAT STILL LEAVE A COMPLETE FILL ARE ACCEPTED.' }));
    return nodes.openingPanel;
  }

  const stage = h('div', { class: `play3__stage${is3d ? '' : ' boardwrap'}` },
    openingPanel(),
    view.element,
    is3d ? null : h('div', { class: 'progressline desk-only' }, h('div', { class: 'bar' }, nodes.barD), nodes.countD));

  const leftPanel = h('div', { class: 'play3__left desk-only' },
    is3d
      ? h('div', null,
        h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'LAYERS' }),
        (nodes.layerRows = h('div', { class: 'stack', style: { gap: '8px' } })))
      : null,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('div', { class: 'eyebrow', text: is3d ? 'REMAINING' : 'PIECE TRAY' }),
      nodes.trayCount),
    nodes.trayD,
    is3d ? null : h('div', { style: { marginTop: '14px', borderTop: '1px solid var(--line)', paddingTop: '20px' } },
      nodes.selectedLabel,
      h('div', { class: 'grid2', style: { gap: '9px' } },
        controlButton('↺', 'Rotate', 'R', () => rotate(1), 'rotateBtn'),
        controlButton('⇋', 'Flip', 'F', flip, 'flipBtn'),
        controlButton('↶', 'Undo', 'Z', undo, 'undoAlt'),
        controlButton('⟲', 'Reset', '⇧R', reset, 'resetAlt'))));

  const rightPanel = h('div', { class: 'play3__right desk-only' },
    is3d
      ? h('div', null,
        orientLabel(),
        orientStrip(true),
        h('div', { class: 'grid3', style: { gap: '9px', marginTop: '14px' } },
          controlButton('↺', 'Rotate', 'R', () => rotate(1), 'rotateBtn'),
          controlButton('⇋', 'Flip', 'F', flip, 'flipBtn'),
          controlButton('⤢', 'Tilt', 'T', tilt, 'tiltBtn')))
      : h('div', null,
        h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'RUN' }),
        nodes.runStats),
    is3d
      ? h('div', null,
        h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'BEADS PLACED' }),
        h('div', { class: 'card' },
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '10px', marginBottom: '12px' } },
            (nodes.beadCount = h('div', { class: 'mono', style: { fontSize: '34px', fontWeight: '700' }, text: '0' })),
            h('div', { class: 'mono', style: { fontSize: '14px', color: 'var(--dim)', paddingBottom: '7px' }, text: `/ ${session.target.size}` })),
          h('div', { class: 'bar' }, nodes.barD)))
      : h('div', null,
        h('div', { class: 'eyebrow', style: { marginBottom: '12px' }, text: 'MOVES' }),
        nodes.moveLog),
    labPanel('desk-only'),
    h('div', { class: 'desk-dock' },
      h('div', { class: 'row', style: { gap: '10px' } }, nodes.undoBtn, nodes.resetBtn),
      rules.allowHint ? nodes.hintBtn : null,
      rules.allowSolve ? nodes.solveBtn : null,
      h('div', {
        class: 'notice',
        text: rules.allowSolve
          ? 'SOLVING MARKS THIS RUN ASSISTED AND VOIDS THE RANKED TIME.'
          : 'HINT AND SOLVE ARE DISABLED IN THIS MODE.'
      })));

  const mobileBody = is3d
    ? h('div', { class: 'mob-only stack', style: { gap: '16px', padding: '4px 20px 0' } },
      (nodes.layers = h('div', { class: 'layertabs' })),
      h('div', null, orientLabel(), orientStrip()),
      h('div', null,
        h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px' } },
          remainLabel('REMAINING · 0'),
          h('div', { class: 'eyebrow tight accent', text: 'TAP A SOCKET' })),
        nodes.trayM))
    : h('div', { class: 'mob-only stack', style: { gap: '12px', padding: '0 20px' } },
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '2px' } },
        remainLabel('REMAINING · 0'),
        h('div', { class: 'eyebrow tight accent', text: 'DRAG TO PLACE' })),
      nodes.trayM);

  /* §4 Solver Lab — recreate a physical board, then interrogate the engine. */
  function labPanel(variant) {
    if (!laboratory) return null;

    const asSetup = () => ({
      dimension: session.dimension,
      locked: session.placed.map((p) => ({ piece: p.piece, cells: p.cells })),
      placed: []
    });

    const countBtn = h('button', {
      class: 'btn btn--ghost btn--xs',
      text: 'Count solutions',
      onClick: async () => {
        countBtn.disabled = true;
        countBtn.textContent = 'Counting…';
        try {
          // An exact total, not a cap: an open board can run to six figures, so
          // the search is time-boxed and says so when it did not finish.
          const { count, exhausted } = await solverClient.countAllSolutions(session.toSolverState());
          const n = count.toLocaleString();
          toast(count === 0 ? 'No solution from this position.'
            : !exhausted ? `At least ${n} solutions — search hit its time limit.`
              : count === 1 ? 'Exactly one solution.'
                : `Exactly ${n} solutions.`,
          { warn: count === 0, ms: 5200 });
        } catch (error) {
          toast(error.message || 'Could not count solutions.', { warn: true });
        } finally {
          countBtn.textContent = 'Count solutions';
          countBtn.disabled = false;
        }
      }
    });

    return h('div', {
      class: `card ${variant}`,
      style: { margin: variant === 'mob-only' ? '14px 20px' : '0', display: 'flex', flexDirection: 'column', gap: '12px' }
    },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('div', { class: 'eyebrow tight', text: 'SOLVER LAB' }),
      h('div', { class: 'row', style: { gap: '6px' } },
        h('button', {
          class: `btn btn--xs ${session.dimension === '2D' ? 'btn--soft' : 'btn--ghost'}`,
          text: 'Board',
          onClick: () => navigate('/lab?dim=2D')
        }),
        h('button', {
          class: `btn btn--xs ${session.dimension === '3D' ? 'btn--soft' : 'btn--ghost'}`,
          text: 'Pyramid',
          onClick: () => navigate('/lab?dim=3D')
        }))),
    h('div', { style: { fontSize: '13px', color: 'var(--dim)', lineHeight: '1.5' },
      text: 'Place the pieces you can see on the physical set, then ask for the next legal move or a full completion.' }),
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      countBtn,
      h('button', {
        class: 'btn btn--ghost btn--xs',
        text: 'Copy code',
        onClick: async () => {
          const code = await solverClient.encodeChallenge(asSetup());
          try {
            await navigator.clipboard.writeText(code);
            toast('Challenge code copied.');
          } catch {
            toast(code, { ms: 8000 });
          }
        }
      }),
      h('button', {
        class: 'btn btn--ghost btn--xs',
        text: 'Load code',
        onClick: async () => {
          const { promptSheet } = await import('../components/dialog.js');
          const code = await promptSheet({
            title: 'Load a challenge code',
            body: 'Paste a Tessera code to rebuild that setup here.',
            placeholder: 'T1:2:A0.1.11.12;…'
          });
          if (!code) return;
          try {
            const decoded = await solverClient.decodeChallenge(code);
            if (decoded.dimension !== session.dimension) {
              navigate(`/lab?dim=${decoded.dimension}&code=${encodeURIComponent(code)}`);
              return;
            }
            session.reset();
            for (const placement of decoded.locked) session.place(placement, { record: false });
            update();
            toast(`Loaded ${decoded.locked.length} pieces.`);
          } catch (error) {
            toast(error.message, { warn: true });
          }
        }
      }),
      h('button', { class: 'btn btn--ghost btn--xs', text: 'Clear', onClick: () => { session.reset(); selection = null; update(); } })));
  }

  const dock = h('div', { class: 'dock mob-only' },
    h('div', { class: 'dock__row' },
      dockButton('↺', 'ROTATE', () => rotate(1), { ref: 'rotateDock' }),
      dockButton('⇋', 'FLIP', flip, { ref: 'flipDock' }),
      is3d ? dockButton('⤢', 'TILT', tilt, { ref: 'tiltDock' }) : null,
      dockButton('↶', 'UNDO', undo, { ref: 'undoDock' }),
      dockButton('⟲', 'RESET', reset, { ref: 'resetDock' }),
      is3d ? dockButton('⌂', 'RECENTRE', () => view.recenter()) : null),
    h('div', { class: 'dock__row' },
      rules.allowHint
        ? (nodes.hintDock = h('button', { class: 'btn btn--soft btn--sm', style: { flex: '1' }, onClick: requestHint },
          h('span', { text: 'Hint' }),
          rules.hintPenaltyMs ? h('span', { class: 'kbd', text: `+${formatTime(rules.hintPenaltyMs)}` }) : null))
        : h('div', { class: 'notice', style: { flex: '1', alignSelf: 'center' }, text: 'NO HINTS OR SOLVER IN THIS MODE' }),
      rules.allowSolve
        ? (nodes.solveDock = h('button', {
          class: 'btn btn--dashed btn--sm',
          style: { width: '136px' },
          text: is3d ? 'Solve' : 'Solve puzzle',
          onClick: () => requestSolve()
        }))
        : null));

  const element = h('section', { class: 'screen' },
    topbar(null, {
      back: rules.backHref,
      title: (nodes.subtitleD = h('div', { class: 'eyebrow', text: session.subtitle })),
      right: h('div', { class: 'row', style: { gap: '22px' } },
        ghostNode(),
        session.parMs
          ? h('div', { class: 'mono', style: { fontSize: '11px', letterSpacing: '0.16em', color: 'var(--dim)' }, text: `PAR ${formatTime(session.parMs)}` })
          : null,
        nodes.clockD,
        h('button', { class: 'btn btn--ghost btn--xs', text: 'Pause', onClick: openPause }))
    }),

    h('div', { class: 'mhead mob-only' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', text: '‹', onClick: () => { persist(); navigate(rules.backHref); } }),
      h('div', { class: 'mhead__title' },
        (nodes.subtitleM = h('div', { class: 'eyebrow tight', style: { marginBottom: '2px' }, text: session.shortSubtitle })),
        nodes.clockM,
        ghostNode()),
      h('button', { class: 'iconbtn', 'aria-label': 'Pause', text: 'II', onClick: openPause })),

    is3d ? null : h('div', {
      class: 'mob-only',
      style: { padding: '12px 20px 0', display: 'flex', alignItems: 'center', gap: '10px' }
    }, h('div', { class: 'bar' }, nodes.barM), nodes.countM),

    h('div', { class: 'playbody' },
      h('div', { class: 'play3' }, leftPanel, stage, rightPanel),
      mobileBody,
      labPanel('mob-only')),

    dock);

  /* --------------------------------------------------------------- mounting */

  document.addEventListener('keydown', onKey);
  const onResize = () => { if (is3d) view.relayout(); };
  window.addEventListener('resize', onResize);

  if (!store.settings.showTimer && timed) {
    nodes.clockM.style.visibility = 'hidden';
    nodes.clockD.style.visibility = 'hidden';
  }

  update();
  startClock();
  solverClient.warm();
  if (rules.demo) setTimeout(() => requestSolve({ silent: true }), 700);

  return {
    element,
    destroy() {
      cancelPickUp();
      stopClock();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      view.destroy?.();
      if (!finished && !laboratory && !rules.demo) persist();
    }
  };
}
