/** M-02 / D-02 — home, with Resume, today's challenges and the mode grid. */

import { h, formatTime, formatClock } from '../dom.js';
import { navigate } from '../router.js';
import { topbar, tabbar } from '../chrome.js';
import { store, rankFor } from '../store.js';
import { MODES } from '../modes.js';
import { beadStrip, staticBoard } from '../components/miniBoard.js';
import { confirmSheet } from '../components/dialog.js';
import { dailyPuzzle, timeAttackQueue, getTrack, trackProgress } from '../content.js';
import { restartHref } from '../sessionFactory.js';
import { Session } from '../../core/session.js';

function statCard(label, value, { accent = false, unit = null } = {}) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'stat__label', text: label }),
    h('div', { class: `stat__value${accent ? ' accent' : ''}` },
      value,
      unit ? h('span', { class: 'stat__unit', text: ` ${unit}` }) : null));
}

function modeMeta(mode) {
  if (mode.id === 'classic2d' || mode.id === 'pyramid') {
    const { solved, total } = trackProgress(getTrack(mode.id));
    return `${solved} / ${total}`;
  }
  return mode.meta || '';
}

export function modeButton(mode, { card = false } = {}) {
  const meta = modeMeta(mode);
  const chip = h('div', {
    class: 'chip',
    style: { background: mode.chipBg, color: mode.chipFg },
    text: mode.tag
  });
  const metaNode = h('div', {
    class: 'mono',
    style: { fontSize: '10px', letterSpacing: '0.12em', color: mode.metaFg || 'var(--dim)' },
    text: meta
  });

  if (card) {
    return h('button', { class: 'modecard', type: 'button', onClick: () => navigate(mode.href) },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, chip, metaNode),
      h('div', null,
        h('div', { style: { fontSize: '19px', fontWeight: '600', marginBottom: '6px' }, text: mode.name }),
        h('div', { style: { fontSize: '14px', color: 'var(--dim)', lineHeight: '1.45' }, text: mode.desc })));
  }

  return h('button', { class: 'listrow', type: 'button', onClick: () => navigate(mode.href) },
    chip,
    h('div', { style: { flex: '1' } },
      h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '3px' }, text: mode.name }),
      h('div', { style: { fontSize: '13px', color: 'var(--dim)', lineHeight: '1.35' }, text: mode.desc })),
    metaNode);
}

function resumeCard() {
  const saved = store.savedSession;
  if (!saved) return null;
  const session = Session.fromJSON(saved);
  if (!session) return null;

  const placements = [...session.locked, ...session.placed];

  const restart = async () => {
    const ok = await confirmSheet({
      title: 'Restart this puzzle?',
      body: 'Your current position and clock will be discarded.',
      confirmLabel: 'Restart',
      variant: 'primary'
    });
    if (!ok) return;
    const target = restartHref(session);
    store.clearSession();
    navigate(target);
  };

  const summary = `${session.filledCount()} of ${session.target.size} sockets · elapsed ` +
    `${formatClock(session.timeMs)}${session.parMs ? ` · par ${formatTime(session.parMs)}` : ''}`;

  const resumeBtn = () => h('button', {
    class: 'btn btn--primary btn--sm',
    text: 'Resume',
    onClick: () => navigate('/play/resume')
  });

  return h('div', { class: 'card card--accent resume' },
    // Wide: headline, a live thumbnail of the position, and the action.
    h('div', { class: 'resume__wide desk-only' },
      h('div', { style: { flex: '1' } },
        h('div', { class: 'eyebrow accent', style: { marginBottom: '12px' }, text: `RESUME · ${session.title.toUpperCase()}` }),
        h('div', { style: { fontSize: '34px', fontWeight: '700', letterSpacing: '-0.03em', marginBottom: '8px' },
          text: 'Pick up where you stopped' }),
        h('div', { style: { fontSize: '16px', color: 'var(--muted)' }, text: summary })),
      session.dimension === '2D'
        ? staticBoard(placements, { mini: true, label: 'Position so far', beadSize: 17 })
        : null,
      h('div', { class: 'row', style: { gap: '10px' } },
        resumeBtn(),
        h('button', { class: 'btn btn--ghost btn--sm', text: 'Restart', onClick: restart }))),

    // Narrow: the eleven-segment strip from M-02.
    h('div', { class: 'mob-only' },
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '14px' } },
        h('div', { class: 'eyebrow accent tight', text: `RESUME · ${session.title.toUpperCase()}` }),
        h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: '700' }, text: formatClock(session.timeMs) })),
      h('div', { style: { marginBottom: '16px' } }, beadStrip(placements)),
      h('div', { class: 'row', style: { gap: '10px' } },
        h('div', { style: { flex: '1', display: 'flex' } }, resumeBtn()),
        h('button', { class: 'btn btn--ghost btn--sm', style: { width: '112px' }, text: 'Restart', onClick: restart }))));
}

function todayRows() {
  const daily = dailyPuzzle();
  const attack = timeAttackQueue();
  const rows = [
    {
      tag: String(daily.tier.remaining).padStart(2, '0'),
      name: 'Daily Lattice',
      sub: `${daily.track.dimension === '3D' ? '3-D pyramid' : '2-D board'} · ${daily.tier.remaining} remaining`,
      cta: store.isSolved(daily.id) ? 'DONE' : 'PLAY',
      chipBg: 'rgba(0,229,160,0.14)',
      chipFg: 'var(--accent)',
      href: '/play/daily'
    },
    {
      tag: `×${attack.queue.length}`,
      name: 'Time Attack',
      sub: `${attack.queue.length} puzzles · ${formatTime(attack.budgetMs)} on one clock`,
      cta: 'ENTER',
      chipBg: 'rgba(255,77,109,0.14)',
      chipFg: '#FF6B85',
      href: '/play/timeattack?restart=1'
    }
  ];

  return rows.map((row) => h('button', { class: 'listrow', type: 'button', onClick: () => navigate(row.href) },
    h('div', {
      class: 'chip',
      style: { width: '46px', height: '46px', borderRadius: '12px', background: row.chipBg, color: row.chipFg, fontSize: '15px' },
      text: row.tag
    }),
    h('div', { style: { flex: '1' } },
      h('div', { style: { fontSize: '17px', fontWeight: '600' }, text: row.name }),
      h('div', { style: { fontSize: '14px', color: 'var(--dim)' }, text: row.sub })),
    h('div', { class: 'mono', style: { fontSize: '12px', letterSpacing: '0.14em', color: 'var(--accent)' }, text: row.cta })));
}

export function render() {
  const week = store.weekStats();
  const best = store.bestTime();
  const rank = rankFor(store.profile.elo);

  const mobileHead = h('div', {
    class: 'mob-only',
    style: { padding: '22px 22px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
  },
  h('div', { class: 'brand' }, h('span', { class: 'brand__dot' }), h('span', { class: 'brand__name', text: 'TESSERA' })),
  h('div', { class: 'row', style: { gap: '10px' } },
    h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.12em' }, text: `${store.profile.elo} ELO` }),
    h('div', { class: 'avatar', style: { fontSize: '9px' }, text: 'YOU' })));

  const main = h('div', { class: 'home2__main' },
    resumeCard(),

    h('div', { class: 'mob-only grid2' },
      statCard('STREAK', `${store.profile.streak.count}`, { unit: store.profile.streak.count === 1 ? 'day' : 'days' }),
      statCard('BEST', best === null ? '—' : formatTime(best))),

    h('div', { class: 'mob-only stack', style: { gap: '11px' } },
      h('div', { class: 'eyebrow tight', text: 'TODAY' }),
      ...todayRows()),

    h('div', { class: 'stack', style: { gap: '14px' } },
      h('div', { class: 'eyebrow', text: 'MODES' }),
      h('div', { class: 'modegrid desk-only' }, ...MODES.map((mode) => modeButton(mode, { card: true }))),
      h('div', { class: 'stack mob-only', style: { gap: '11px' } }, ...MODES.map((mode) => modeButton(mode)))));

  const side = h('div', { class: 'home2__side desk-only' },
    h('div', null,
      h('div', { class: 'eyebrow', style: { marginBottom: '14px' }, text: 'THIS WEEK' }),
      h('div', { class: 'grid2' },
        statCard('SOLVED', String(week.solved)),
        statCard('CLEAN RATE', `${week.cleanRate}%`, { accent: true }),
        statCard('AVG TIME', week.avgMs ? formatTime(week.avgMs) : '—'),
        statCard('ELO Δ', `${week.eloDelta >= 0 ? '+' : ''}${week.eloDelta}`, { accent: week.eloDelta >= 0 }))),

    h('div', null,
      h('div', { class: 'eyebrow', style: { marginBottom: '14px' }, text: 'TODAY' }),
      h('div', { class: 'stack', style: { gap: '11px' } }, ...todayRows())),

    h('div', { class: 'card', style: { marginTop: 'auto' } },
      h('div', { style: { fontSize: '17px', fontWeight: '600', marginBottom: '8px' }, text: `Rank · ${rank.name}` }),
      h('div', {
        style: { fontSize: '14px', color: 'var(--dim)', lineHeight: '1.5', marginBottom: '14px' },
        text: `${store.profile.elo} of ${rank.ceiling} to the next rank. Rating moves on clean solves only.`
      }),
      h('div', { class: 'bar' }, h('i', {
        style: { width: `${Math.round(((store.profile.elo - rank.floor) / (rank.ceiling - rank.floor)) * 100)}%` }
      }))));

  const element = h('section', { class: 'screen' },
    topbar('home'),
    mobileHead,
    h('div', { class: 'home2 scroll' }, main, side),
    tabbar('home'));

  return { element };
}
