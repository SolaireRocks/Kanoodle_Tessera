# Tessera

Fifty-five sockets. Twelve pieces. One clock.

A digital polysphere puzzle built from `kanoodle_digital_game_design.docx`, wearing
the UI from `GameUI/Tessera.dc.html` instead of the layouts sketched in the
document. Both campaigns are here: the 5 × 11 board and the five-level pyramid,
with one shared rules engine and an exact-cover solver behind Hint and Solve.

No build step, no framework, no network. Everything runs in the browser.

## Run it

```sh
npm start          # http://localhost:5173
```

On Windows, `play.bat` does the same and opens the browser for you
(`play.bat 8080` for another port).

Opening `index.html` from disk will not work — ES modules and the solver Web
Worker both need a real http origin. The server is a dependency-free Node script.

### On your phone

The server listens on every interface, so any phone or tablet on the same Wi-Fi
can play. Both `npm start` and `play.bat` print the address to type:

```
  On this PC:    http://localhost:5173/
  On your phone: http://192.168.1.126:5173/   (same Wi-Fi)
```

Windows Firewall blocks incoming connections until the port is allowed, so
`play.bat` offers to add that rule once per port (one administrator prompt).
Once the page loads, "Add to Home Screen" installs it as a standalone app —
`manifest.webmanifest` is already wired up.

Set `HOST=127.0.0.1` to go back to serving this machine only.

```sh
npm test           # rules-core tests (35)
npm run content    # regenerate and re-validate content/puzzles.json
npm run census     # count the solutions behind every one-piece opening -> census/
npm run test:browser   # headless UI checks; needs `npm i -D puppeteer-core` and a running server
```

## What is here

| Screen | Design artboard |
| --- | --- |
| Splash | M-01 / D-01 |
| Home, resume, modes | M-02 / D-02 |
| Mode select | M-03 |
| Level select | M-04 / D-03 |
| 2-D gameplay | M-05 / D-04 |
| 3-D pyramid | M-06 / D-05 |
| Completion | M-07 / D-06 |
| Settings and accessibility | M-08 |
| Tabletop | — (no artboard) |

Plus three screens the design implies but does not draw: **Stats** (the nav's
fourth tab), **Solver Lab** and **Tabletop**, each with its own mode card. Free
mode reuses the 2-D gameplay screen, with an opening chooser above the board
until a first piece is down.

**Modes** — Classic 2-D, Pyramid, Free mode, Time Attack, Daily Lattice, Head to
head, Zen, Solver Lab, Tabletop.

**Content** — 101 challenges, matching §9.1: seven 2-D tiers (76 puzzles, one
through seven pieces remaining) and four pyramid levels (25 puzzles). They are
generated, not transcribed from any published booklet (§15), and every one is
verified solvable by the solver before it ships.

## How it works

```
src/core/      pure rules engine — no DOM, no rendering
  pieces.js      the twelve pieces, their orientations, the FCC lattice map
  target.js      the two target spaces and every legal placement in each
  solver.js      Algorithm X / dancing links: validate, solve, count, recommend
  session.js     one run: moves, undo/redo, clock, assistance flags
  generate.js    puzzle generation and difficulty measurement
  tabletop.js    openings for the physical set: coordinates, text, durations
  rng.js         seeded randomness for the Daily and for generation
src/workers/   the solver, off the main thread
src/ui/        screens, components, router, local-first store
content/       generated, solver-validated puzzle pack
tools/         dev server, content generator, tests
```

### The pieces

Transcribed from Figure 1 of the design document. Bead counts
(4,5,5,5,5,3,5,5,5,4,4,5) sum to 55, which is both the board and the pyramid.
The solver confirms the set tiles each target exactly.

### The pyramid

Beads nest into the dimples of the layer below — half a step across, and a step
divided by √2 upward. That is face-centred cubic packing, and under

```
a = row + col + layer      b = col − row      h = layer
```

it becomes a plain integer lattice whose twelve nearest neighbours are exactly
the vectors with two ±1s and one 0. Every rigid rotation and reflection of a
piece is then a signed permutation of `(a, b, h)`, so 3-D orientations are
generated the same way 2-D ones are, and the same exact-cover solver handles
both. This resolves the "implementation assumption to validate" in §2.

### The solution census

`npm run census` answers, for every orientation of every piece at every
position it fits: with that one piece down and the board otherwise empty, how
many ways can the other eleven finish? It writes `census/solution-census-2d`
and `-3d` as both a report and a CSV, grouped by piece and ordered from most
solutions to fewest.

It does not run the solver 1,789 times. Every complete fill uses exactly one
placement of each piece, so one enumeration of all complete fills — tallying
the placements each one uses as it goes — settles every position at once. That
is `solutionCountsByPlacement` in the core, built on the same dancing-links
search as Hint and Solve. Two identities are asserted before anything is
written: each piece's counts must sum to the target's total number of fills,
and a sample of positions is re-solved directly with `countAllSolutions` and
has to agree.

Positions are named in a shorthand the report explains: `A-o2@B3` is piece A,
orientation 2, anchored at row B column 3, and every line also spells out the
sockets covered and draws the footprint.

### Free mode

The campaigns hand you an authored setup. Free mode hands you an empty board and
all twelve pieces, and asks for the opening yourself: drop any piece anywhere and
it locks in as the setup, leaving the other eleven to fit around it. **Random
opening** rolls one instead.

Not every first placement leaves a puzzle — about one in twenty strands the board
— so the engine checks before committing. A hand-picked opening is accepted only
when the solver can still find a complete fill from it, and a rolled one is taken
out of a whole random fill, so it is solvable by construction. Runs are keyed by
their opening, which gives each one its own best time and a replay link
(`#/play/free?code=…`) that reopens the same board.

### Tabletop

The mode for the set on your table rather than the one on screen. You say which
surface, how many pieces to start with, and whether the engine chooses them or
you pin the ones you want; it rolls an opening and draws it as a lettered sheet
— rows `A`–`E`, columns numbered, every occupied socket carrying its piece
letter — so it can be copied bead for bead onto the real board. `Copy setup`
puts the same thing on the clipboard as plain text with an ASCII diagram, and
`Print sheet` prints it with blank lines for times.

Openings come out of a complete fill, the same guarantee the campaigns get, so
the pieces left in the bag always finish the board. Pinning as many pieces as
the count means the opening is exactly those pieces; pinning fewer fills the
rest at random; pinning none is a straight roll. A seed is recorded with every
opening and re-entering it rebuilds the same one.

Then you solve it away from the screen and type the time in. Times are kept
against that exact opening — best, average, last, and the whole run of attempts
— so a second go at the same board is comparable. Because nothing verified them,
they live in their own logbook and never move the rating or the streak; the
Stats screen shows them under their own heading, labelled as hand-entered. Each
opening can also be played on screen (`#/play/setup?code=…`), on either surface.

### Assistance

Hint is a three-step ladder — which piece, then its orientation, then a pulsing
ghost — computed from the current legal position, so it keeps working after any
valid path the player takes. Solve asks for confirmation, then animates the
remaining pieces with a transport you can pause and step through. If the board
is legal but dead, the engine identifies the smallest number of your own moves
to undo rather than leaving you stuck. Assisted runs are labelled and do not
move your rating.

### Accessibility

Every action has a visible control and a keyboard route. The board is a grid
with a roving cursor: arrows move a ghost, Enter drops it. Piece IDs and
optional per-piece glyphs mean colour is never the only channel; there is a
high-contrast mode, a deuteranopia palette, and a reduce-motion setting that
also skips the solve animation. Board position, selection, orientation,
legality, remaining count, hints and solve results all speak through a live
region.

Keys: `R` rotate · `Q`/`E` rotate either way · `F` flip · `T` tilt (3-D) ·
`Z`/`Ctrl+Z` undo · `Shift+R` reset · `H` hint · `S` solve · `1`–`9` pick a
piece · arrows and `Enter` to place · `Esc` pause.

## Deliberate departures from the document

- **Brand.** The UI is the "Tessera" rebrand, so the game ships under an
  original name with an original palette and a generated puzzle library — the
  path §15 describes for distribution without licensing the original.
- **No server.** There is no sign-in, no online head-to-head and no shared
  leaderboard. Rating, streak and progress are computed and stored on the
  device. Where the design shows a leaderboard, Tessera shows locally generated
  **pace targets**, tagged `BOT` and captioned as such, rather than presenting
  invented times as other players. Head to head races one of those pace ghosts
  on a split clock and is labelled `OFFLINE`.
- **Splash secondary action.** "Sign in" became "How to play". The desktop
  "Watch a 30-second solve" is real — it opens a Genius puzzle and runs the
  solver.
- **3-D beads face the camera.** The design canvas draws pyramid beads as flat
  divs inside the rotated scene, which foreshortens them into ellipses. Each
  bead counter-rotates so the lattice supplies the isometric position and the
  bead stays round.
- **Three extra modes.** Zen (§4 lists it in the MVP set), Solver Lab and Free
  mode each got a card; the design's grid had six.

## Not built

- Cloud sync, accounts, real multiplayer and shared leaderboards — all need a
  backend.
- Puzzle Rush and the player-facing Puzzle Creator (§4 phase 4). The pieces are
  in place: the Solver Lab already validates an arbitrary setup and exports a
  challenge code, Tabletop generates constrained openings on demand, and
  `generate.js` can build and grade puzzles.
- Audio. The setting exists for haptics, which do work where the browser
  supports them; there are no sounds yet.
