/** Your record — progress across both campaigns, in the same visual language. */

import { h, formatTime } from '../dom.js';
import { navigate } from '../router.js';
import { topbar, tabbar } from '../chrome.js';
import { store, rankFor } from '../store.js';
import { allTracks, trackProgress, tierProgress, lookup, totalChallenges } from '../content.js';

function statCard(label, value, { accent = false, unit = null } = {}) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'stat__label', text: label }),
    h('div', { class: `stat__value${accent ? ' accent' : ''}` },
      value,
      unit ? h('span', { class: 'stat__unit', text: ` ${unit}` }) : null));
}

function trackPanel(track) {
  const { solved, total } = trackProgress(track);
  return h('div', null,
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '14px' } },
      h('div', { class: 'eyebrow', text: track.label }),
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--accent)' }, text: `${solved} / ${total}` })),
    h('div', { class: 'stack', style: { gap: '9px' } },
      ...track.tiers.map((tier) => {
        const progress = tierProgress(tier);
        const stars = tier.puzzles.reduce((n, p) => n + (store.progressFor(p.id)?.stars || 0), 0);
        return h('button', {
          class: 'listrow',
          type: 'button',
          style: { minHeight: '64px', background: 'transparent' },
          onClick: () => navigate(`/levels/${track.id}/${tier.id}`)
        },
        h('div', { class: 'mono', style: { fontSize: '15px', fontWeight: '700', color: 'var(--dim)' }, text: tier.n }),
        h('div', { style: { flex: '1' } },
          h('div', { style: { fontSize: '15px', fontWeight: '600' }, text: tier.name }),
          h('div', { style: { fontSize: '13px', color: 'var(--dim)' }, text: `par ${formatTime(tier.parMs)} · ${stars}/${tier.puzzles.length * 3} stars` })),
        h('div', { style: { width: '92px' } },
          h('div', { class: 'bar' }, h('i', { style: { width: `${(progress.solved / progress.total) * 100}%` } }))),
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--faint)', width: '44px', textAlign: 'right' }, text: `${progress.solved}/${progress.total}` }));
      })));
}

/**
 * Times typed in after solving on a physical set. They are kept apart from the
 * campaign numbers above because nothing verified them — the engine never saw
 * those runs, so they move no rating and no streak.
 */
function tabletopPanel() {
  const summary = store.tabletopSummary();
  return h('div', null,
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '14px' } },
      h('div', { class: 'eyebrow', text: 'TABLETOP' }),
      h('button', {
        class: 'mono',
        type: 'button',
        style: { fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.12em' },
        text: summary.setups ? 'OPEN LOGBOOK ›' : 'GENERATE AN OPENING ›',
        onClick: () => navigate('/tabletop')
      })),
    h('div', { class: 'grid2' },
      statCard('OPENINGS', String(summary.setups)),
      statCard('SOLVED OFFLINE', `${summary.solved} / ${summary.setups}`),
      statCard('ATTEMPTS LOGGED', String(summary.attempts)),
      statCard('BEST', summary.bestMs === null ? '—' : formatTime(summary.bestMs), { accent: true })),
    h('div', { class: 'notice', style: { marginTop: '10px' },
      text: 'HAND-ENTERED TIMES FROM THE PHYSICAL SET. THEY DO NOT MOVE THE RATING OR THE STREAK.' }));
}

export function render() {
  const week = store.weekStats();
  const rank = rankFor(store.profile.elo);
  const history = store.profile.history.slice(0, 10);
  const solvedTotal = Object.values(store.profile.progress).filter((p) => p.solved).length;
  const threeStars = Object.values(store.profile.progress).filter((p) => p.stars === 3).length;

  const element = h('section', { class: 'screen' },
    topbar('stats'),
    h('div', { class: 'mob-only', style: { padding: '26px 22px 18px', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'eyebrow tight', style: { marginBottom: '8px' }, text: 'YOUR RECORD' }),
      h('h1', { class: 'h1', text: 'Stats' })),

    h('div', { class: 'scroll' },
      h('div', { style: { padding: '18px 22px 32px', display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '900px' } },
        h('h1', { class: 'h1 desk-only', text: 'Your record' }),

        h('div', { class: 'grid2' },
          statCard('SOLVED', `${solvedTotal} / ${totalChallenges()}`),
          statCard('THREE STARS', String(threeStars), { accent: true }),
          statCard('RATING', `${store.profile.elo}`, { accent: true }),
          statCard('RANK', rank.name)),

        h('div', null,
          h('div', { class: 'eyebrow', style: { marginBottom: '14px' }, text: 'THIS WEEK' }),
          h('div', { class: 'grid2' },
            statCard('RUNS', String(week.solved)),
            statCard('CLEAN RATE', `${week.cleanRate}%`, { accent: true }),
            statCard('AVG TIME', week.avgMs ? formatTime(week.avgMs) : '—'),
            statCard('STREAK', `${store.profile.streak.count}`, { unit: store.profile.streak.count === 1 ? 'day' : 'days' }))),

        ...allTracks().map(trackPanel),

        tabletopPanel(),

        h('div', null,
          h('div', { class: 'eyebrow', style: { marginBottom: '14px' }, text: 'RECENT RUNS' }),
          h('div', { class: 'movelog' },
            history.length
              ? history.map((run) => {
                const found = lookup(run.puzzleId);
                return h('div', { class: 'movelog__row' },
                  h('div', { class: `movelog__dot${run.assisted ? ' is-warn' : ''}` }),
                  h('div', { class: 'movelog__text', text: (found ? `${found.tier.name.toUpperCase()} ${String(found.puzzle.order).padStart(2, '0')}`
                    : run.puzzleId.startsWith('free-') ? 'FREE MODE'
                      : run.puzzleId.startsWith('setup-') ? 'TABLETOP OPENING'
                        : run.puzzleId.toUpperCase()) + (run.assisted ? ' · ASSISTED' : '') }),
                  h('div', { class: 'movelog__t', text: formatTime(run.ms) }));
              })
              : h('div', { class: 'movelog__row' },
                h('div', { class: 'movelog__text', style: { color: 'var(--faint)' }, text: 'NOTHING YET — SOLVE SOMETHING' })))))),

    tabbar('stats'));

  return { element };
}
