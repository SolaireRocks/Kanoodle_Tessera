/** §4 game modes, in the order the design canvas lists them. */

export const MODES = [
  {
    id: 'classic2d', tag: '2D', name: 'Classic 2-D',
    desc: 'The 55-socket board. Seven tiers of locked-setup challenges.',
    href: '/levels/classic2d', chipBg: 'rgba(0,229,160,0.14)', chipFg: 'var(--accent)'
  },
  {
    id: 'pyramid', tag: '3D', name: 'Pyramid',
    desc: 'Stack the same twelve pieces into five nested layers.',
    href: '/levels/pyramid', chipBg: 'rgba(53,167,255,0.16)', chipFg: '#5CB8FF'
  },
  {
    id: 'free', tag: 'FR', name: 'Free mode',
    desc: 'The 2-D board, no authored setup. Place any opening piece — or roll one — then fill the rest.',
    href: '/play/free', meta: 'OPEN',
    chipBg: 'rgba(0,229,160,0.14)', chipFg: 'var(--accent)'
  },
  {
    id: 'timeattack', tag: 'TA', name: 'Time Attack',
    desc: 'A four-puzzle queue on one clock. No hints, no solver.',
    href: '/play/timeattack', meta: 'RANKED', metaFg: 'var(--danger)',
    chipBg: 'rgba(255,77,109,0.16)', chipFg: '#FF6B85'
  },
  {
    id: 'daily', tag: 'DL', name: 'Daily Lattice',
    desc: 'One deterministic challenge a day. Resets 06:00 UTC.',
    href: '/play/daily', meta: 'LIVE', metaFg: 'var(--accent)',
    chipBg: 'rgba(255,210,63,0.16)', chipFg: '#FFD23F'
  },
  {
    id: 'versus', tag: 'VS', name: 'Head to head',
    desc: 'Same board, split clock, first to fill wins. Races a local pace ghost.',
    href: '/play/versus', meta: 'OFFLINE',
    chipBg: 'rgba(200,107,255,0.16)', chipFg: '#C86BFF'
  },
  {
    id: 'zen', tag: 'ZN', name: 'Zen',
    desc: 'No timer, no score pressure. Unlimited undo, hint and solve.',
    href: '/play/zen', meta: 'RELAXED',
    chipBg: 'rgba(143,217,75,0.16)', chipFg: '#8FD94B'
  },
  {
    id: 'tabletop', tag: 'TT', name: 'Tabletop',
    desc: 'Roll an opening for the physical set, then log the times you get away from the screen.',
    href: '/tabletop', meta: 'OFFLINE',
    chipBg: 'rgba(255,138,61,0.16)', chipFg: '#FF8A3D'
  },
  {
    id: 'lab', tag: 'LB', name: 'Solver Lab',
    desc: 'Recreate a physical board and ask the engine for the next legal move.',
    href: '/lab', meta: 'UNRANKED',
    chipBg: 'rgba(255,255,255,0.07)', chipFg: '#C6CCD4'
  }
];
