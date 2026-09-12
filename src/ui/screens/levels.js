/** M-04 / D-03 — level select: tier picker plus the puzzle grid. */

import { h, formatTime } from '../dom.js';
import { navigate } from '../router.js';
import { topbar, tabbar, mobileHeader } from '../chrome.js';
import { store } from '../store.js';
import { toast } from '../components/dialog.js';
import { getTrack, currentTier, isTierUnlocked, tierProgress, nextUnsolved } from '../content.js';

function tierChip(track, tier, activeId) {
  const unlocked = isTierUnlocked(track, tier);
  const active = tier.id === activeId;
  return h('button', {
    class: `tierchip${active ? ' is-active' : ''}${unlocked ? '' : ' is-locked'}`,
    type: 'button',
    'aria-current': active ? 'true' : null,
    'aria-label': `${tier.name}${unlocked ? '' : ', locked'}`,
    onClick: () => (unlocked
      ? navigate(`/levels/${track.id}/${tier.id}`)
      : toast('Solve one puzzle in the tier before it to open this one.', { warn: true }))
  },
  h('span', { class: 'tierchip__n', text: tier.n }),
  h('span', { class: 'tierchip__name', text: tier.name.toUpperCase() }));
}

function tierRow(track, tier, activeId) {
  const unlocked = isTierUnlocked(track, tier);
  const { solved, total } = tierProgress(tier);
  const active = tier.id === activeId;
  return h('button', {
    class: `listrow${active ? ' is-active' : ''}`,
    type: 'button',
    style: { minHeight: '68px', background: active ? undefined : 'transparent' },
    disabled: !unlocked,
    'aria-current': active ? 'true' : null,
    onClick: () => navigate(`/levels/${track.id}/${tier.id}`)
  },
  h('div', {
    class: 'mono',
    style: { fontSize: '16px', fontWeight: '700', color: active ? 'var(--accent)' : 'var(--dim)' },
    text: tier.n
  }),
  h('div', { style: { flex: '1' } },
    h('div', {
      style: { fontSize: '16px', fontWeight: '600', color: unlocked ? 'var(--text)' : 'var(--faint)' },
      text: tier.name
    }),
    h('div', {
      style: { fontSize: '13px', color: 'var(--dim)' },
      text: unlocked ? `par ${formatTime(tier.parMs)} · ${tier.remaining} remaining` : 'locked'
    })),
  h('div', {
    class: 'mono',
    style: { fontSize: '11px', color: active ? 'var(--accent)' : 'var(--faint)' },
    text: unlocked ? `${solved}/${total}` : '—'
  }));
}

function puzzleTile(tier, puzzle, nextId) {
  const progress = store.progressFor(puzzle.id);
  const solved = Boolean(progress?.solved);
  const isNext = puzzle.id === nextId;
  const stars = progress?.stars || 0;
  const best = progress?.bestMs ?? progress?.lastMs ?? null;

  return h('button', {
    class: `puzzletile${solved ? ' is-solved' : ''}${isNext ? ' is-next' : ''}`,
    type: 'button',
    'aria-label': `${tier.name} puzzle ${puzzle.order}` +
      (solved ? `, best ${formatTime(best)}, ${stars} of 3 stars` : ', unsolved'),
    onClick: () => navigate(`/play/${puzzle.id}`)
  },
  h('div', { class: 'puzzletile__n', text: String(puzzle.order).padStart(2, '0') }),
  h('div', null,
    h('div', { class: 'puzzletile__time', text: solved ? formatTime(best) : (isNext ? 'NEXT' : '—') }),
    h('div', { class: 'stars' }, ...[0, 1, 2].map((i) => h('i', i < stars ? { 'data-on': '' } : null)))));
}

export function render({ segments }) {
  const track = getTrack(segments[0]) || getTrack('classic2d');
  const tier = track.tiers.find((t) => t.id === segments[1]) || currentTier(track);
  const { solved, total } = tierProgress(tier);
  const next = nextUnsolved(tier);
  const bestInTier = tier.puzzles
    .map((p) => store.progressFor(p.id)?.bestMs)
    .filter((ms) => typeof ms === 'number')
    .sort((a, b) => a - b)[0];

  const headline = () => h('div', null,
    h('h1', { class: 'h1', style: { marginBottom: '6px' }, text: tier.name }),
    h('div', {
      class: 'sub',
      text: `${solved} of ${total} solved · par ${formatTime(tier.parMs)}` +
        (bestInTier ? ` · best ${formatTime(bestInTier)}` : '')
    }));

  const playNext = () => h('button', {
    class: 'btn btn--primary',
    onClick: () => navigate(`/play/${next.id}`)
  },
  h('span', { text: `Play ${tier.name} ${String(next.order).padStart(2, '0')}` }),
  h('span', { class: 'kbd', text: store.isSolved(next.id) ? 'REPLAY' : 'NEXT UNSOLVED' }));

  const puzzleGrid = () => h('div', { class: 'puzzlegrid' },
    ...tier.puzzles.map((puzzle) => puzzleTile(tier, puzzle, next.id)));

  const element = h('section', { class: 'screen' },
    topbar(null, { back: '/modes', title: `${track.label} / ${tier.name.toUpperCase()}` }),
    mobileHeader({ back: '/modes', eyebrow: track.label, title: tier.name }),

    h('div', { class: 'levels2 scroll' },
      h('div', { class: 'levels2__side desk-only' },
        h('div', { class: 'eyebrow', style: { marginBottom: '8px' }, text: 'TIERS' }),
        ...track.tiers.map((t) => tierRow(track, t, tier.id))),

      h('div', { class: 'levels2__main' },
        h('div', {
          class: 'desk-only',
          style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' }
        }, headline(), playNext()),

        h('div', { class: 'mob-only', style: { padding: '18px 22px 16px' } }, headline()),
        h('div', { class: 'mob-only', style: { padding: '0 22px 16px' } },
          h('div', { class: 'tierstrip' }, ...track.tiers.slice(0, 6).map((t) => tierChip(track, t, tier.id)))),
        h('div', { class: 'mob-only', style: { padding: '0 22px 24px' } }, puzzleGrid()),
        h('div', { class: 'desk-only' }, puzzleGrid()))),

    h('div', {
      class: 'mob-only',
      style: {
        padding: '18px 22px calc(18px + env(safe-area-inset-bottom))',
        borderTop: '1px solid var(--line)',
        background: 'var(--panel)'
      }
    }, playNext()),
    tabbar(null));

  return { element };
}
