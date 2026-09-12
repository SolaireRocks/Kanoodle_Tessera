/** M-07 / D-06 — completion. */

import { h, formatTime, formatClock, announce } from '../dom.js';
import { navigate } from '../router.js';
import { topbar } from '../chrome.js';
import { store, rankFor } from '../store.js';
import { staticBoard, staticPyramid } from '../components/miniBoard.js';
import { toast } from '../components/dialog.js';
import { paceTargets } from '../content.js';
import { nextAfter, restartHref } from '../sessionFactory.js';
import { encodeChallenge } from '../../core/solver.js';

let last = null;
export const setLastResult = (payload) => { last = payload; };
export const getLastResult = () => last;

function statCard(label, value, { accent = false, big = false } = {}) {
  return h('div', { class: 'card stat', style: big ? { padding: '18px' } : null },
    h('div', { class: 'stat__label', text: label }),
    h('div', { class: `stat__value${accent ? ' accent' : ''}`, style: big ? { fontSize: '26px' } : null, text: value }));
}

function paceBoard(puzzleId, parMs, yourMs) {
  const rows = paceTargets(puzzleId, parMs, yourMs);
  return h('div', { class: 'lb' },
    ...rows.map((row) => h('div', { class: `lb__row${row.me ? ' is-me' : ''}` },
      h('div', { class: 'lb__rank', text: row.rank }),
      h('div', { class: 'lb__name', text: row.name }),
      row.bot ? h('div', { class: 'lb__tag', text: 'BOT' }) : null,
      h('div', { class: 'lb__time', text: formatTime(row.ms) }))));
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Clipboard blocked — here it is: ' + text, { ms: 6000 });
  }
}

export function render() {
  if (!last) {
    navigate('/home', { replace: true });
    return { element: h('div') };
  }

  const { session, result, outcome, entry, rules, ghostLost } = last;
  const rank = rankFor(store.profile.elo);
  const parDelta = session.parMs ? result.timeMs - session.parMs : null;
  const bestDelta = outcome.previousBest ? result.timeMs - outcome.previousBest : null;

  const headline = result.assisted
    ? 'SOLVED · ASSISTED'
    : (result.hints ? `SOLVED · ${result.hints} ${result.hints === 1 ? 'HINT' : 'HINTS'}` : 'SOLVED · CLEAN RUN');

  const subline = [
    parDelta !== null ? `${parDelta <= 0 ? formatTime(-parDelta) + ' under par' : formatTime(parDelta) + ' over par'}` : null,
    outcome.isBest ? 'new personal best' : null,
    rules.ghostMs ? (ghostLost ? 'the pace ghost got there first' : 'you beat the pace ghost') : null
  ].filter(Boolean).join(' · ') || 'Board complete.';

  const snapshot = session.dimension === '3D'
    ? staticPyramid([...session.locked, ...session.placed], { size: 240, label: 'Completed pyramid' })
    : staticBoard([...session.locked, ...session.placed], { mini: true, solved: true, label: 'Completed board' });

  const nextHref = nextAfter(session, entry);
  // Free mode replays its own opening; the campaigns replay their puzzle.
  const replayHref = restartHref(session);
  const challengeCode = encodeChallenge({
    dimension: session.dimension,
    locked: session.locked,
    placed: []
  });

  const actions = () => h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
    h('button', {
      class: 'btn btn--ghost',
      style: { width: '110px' },
      text: 'Replay',
      onClick: () => navigate(replayHref)
    }),
    h('button', {
      class: 'btn btn--primary',
      style: { flex: '1', minWidth: '160px' },
      text: session.mode === 'timeattack' && outcome.queue?.queue[outcome.queue.index] ? 'Next in queue' : 'Next puzzle',
      onClick: () => navigate(nextHref)
    }));

  const stats = [
    statCard('MOVES', String(result.moves)),
    statCard('UNDOS', String(result.undos)),
    statCard('HINTS', String(result.hints), { accent: result.hints === 0 }),
    statCard('ELO', `${outcome.eloDelta >= 0 ? '+' : ''}${outcome.eloDelta}`, { accent: outcome.eloDelta > 0 })
  ];

  const rankCard = h('div', { class: 'card', style: { maxWidth: '640px', padding: '22px 24px' } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '14px' } },
      h('div', { class: 'eyebrow tight', text: `RANK PROGRESS · ${rank.name.toUpperCase()}` }),
      h('div', { class: 'mono', style: { fontSize: '13px', color: 'var(--accent)' }, text: `${store.profile.elo} / ${rank.ceiling}` })),
    h('div', { class: 'bar', style: { height: '6px', marginBottom: '12px' } },
      h('i', { style: { width: `${Math.round(((store.profile.elo - rank.floor) / (rank.ceiling - rank.floor)) * 100)}%` } })),
    h('div', { style: { fontSize: '15px', color: 'var(--dim)' },
      text: result.assisted
        ? 'Assisted runs do not move your rating. Solve one unassisted to make it count.'
        : `Keep this pace and you reach the next rank in a few more clean solves.` }));

  const element = h('section', { class: 'screen' },
    topbar(null, { back: '/home', title: session.subtitle }),

    h('div', { class: 'complete2 scroll' },
      h('div', { class: 'complete2__main' },
        h('div', { class: 'result mob-only' },
          h('div', { class: 'eyebrow accent', style: { letterSpacing: '0.3em', marginBottom: '16px' }, text: headline }),
          h('div', { class: 'result__time', text: formatTime(result.timeMs) }),
          h('div', { style: { fontSize: '16px', color: 'var(--dim)', marginTop: '10px' }, text: subline })),

        h('div', { class: 'desk-only' },
          h('div', { class: 'eyebrow accent', style: { letterSpacing: '0.3em', marginBottom: '24px' }, text: headline }),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '24px', marginBottom: '16px' } },
            h('div', { class: 'result2__time', text: formatTime(result.timeMs) }),
            h('div', { style: { paddingBottom: '18px', display: 'flex', flexDirection: 'column', gap: '6px' } },
              parDelta !== null ? h('div', {
                class: 'mono',
                style: { fontSize: '16px', letterSpacing: '0.1em', color: parDelta <= 0 ? 'var(--accent)' : 'var(--danger)' },
                text: `${parDelta <= 0 ? '−' : '+'}${formatTime(Math.abs(parDelta))} VS PAR`
              }) : null,
              bestDelta !== null ? h('div', {
                class: 'mono',
                style: { fontSize: '16px', letterSpacing: '0.1em', color: 'var(--dim)' },
                text: `${bestDelta <= 0 ? '−' : '+'}${formatTime(Math.abs(bestDelta))} VS YOUR BEST`
              }) : null)),
          h('div', { style: { fontSize: '22px', color: 'var(--muted)', marginBottom: '44px' },
            text: `${session.title} · ${subline}` })),

        h('div', { class: 'mob-only', style: { padding: '26px 20px 0', display: 'flex', justifyContent: 'center' } }, snapshot),

        h('div', { class: 'mob-only grid3', style: { padding: '26px 22px 0' } }, ...stats.slice(0, 3)),
        h('div', {
          class: 'desk-only',
          style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '28px', maxWidth: '640px' }
        }, ...stats.map((card) => card.cloneNode(true))),

        h('div', { class: 'mob-only', style: { padding: '20px 22px 0' } },
          h('div', { class: 'eyebrow tight', style: { marginBottom: '10px' }, text: `${session.title.toUpperCase()} · PACE` }),
          paceBoard(session.puzzleId, session.parMs || result.timeMs, result.timeMs)),

        h('div', { class: 'desk-only' }, rankCard),

        h('div', { class: 'mob-only', style: { padding: '18px 20px calc(24px + env(safe-area-inset-bottom))' } }, actions()),

        h('div', { class: 'desk-only', style: { marginTop: 'auto', paddingTop: '32px', display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          h('button', { class: 'btn btn--primary', text: 'Next puzzle', onClick: () => navigate(nextHref) }),
          h('button', {
            class: 'btn btn--ghost',
            text: 'Replay',
            onClick: () => navigate(replayHref)
          }),
          h('button', {
            class: 'btn btn--ghost',
            text: 'Copy challenge code',
            onClick: () => copyText(challengeCode, 'Challenge code copied.')
          }),
          h('button', {
            class: 'btn btn--ghost',
            text: 'Copy result',
            onClick: () => copyText(
              `Tessera · ${session.title} · ${formatTime(result.timeMs)}` +
              `${result.assisted ? ' (assisted)' : ''} · ${result.stars}/3 stars`,
              'Result copied.')
          }))),

      h('div', { class: 'complete2__side desk-only' },
        h('div', { style: { display: 'flex', justifyContent: 'center' } }, snapshot.cloneNode(true)),
        h('div', null,
          h('div', { class: 'eyebrow', style: { marginBottom: '14px' }, text: `${session.title.toUpperCase()} · PACE TARGETS` }),
          paceBoard(session.puzzleId, session.parMs || result.timeMs, result.timeMs),
          h('div', { class: 'notice', style: { marginTop: '12px' },
            text: 'PACE TARGETS ARE GENERATED LOCALLY FROM THIS PUZZLE’S PAR. TESSERA HAS NO SERVER.' })))));

  announce(`${headline}. ${formatTime(result.timeMs)}. ${result.stars} of 3 stars.`);
  return { element };
}
