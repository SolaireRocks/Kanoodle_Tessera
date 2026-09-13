# Tessera Tabletop

The mode for the polysphere set on your table, as a site of its own.

It rolls an opening you can still finish, draws it as a lettered sheet you copy
bead for bead onto the real board, times you while you solve it, and keeps every
attempt against that exact opening — best, average, last, and the whole run.
Then it hands the lot back as JSON, CSV or text.

No build step, no framework, no server, no account. It is plain ES modules and
one Web Worker, so it runs on GitHub Pages — or any static host — exactly as it
sits here.

## Run it

Any static server will do, because ES modules and the solver worker both need a
real `http` origin. Opening `index.html` off the disk will not work.

```sh
# from this folder
npx serve .                  # or: python -m http.server 5173

# or from the parent project, which serves the whole repo
npm start                    # then http://localhost:5173/tabletop/
```

## Put it on GitHub Pages

Two ways, depending on whether this folder lives inside a bigger repo or is the
whole repo.

**As a folder of an existing repo** — nothing to configure. In
*Settings → Pages*, set the source to *Deploy from a branch*, pick your branch
and `/ (root)`, and the site is at

```
https://<user>.github.io/<repo>/tabletop/
```

**As its own repo** — copy this folder's contents to the repository root, push,
and point *Settings → Pages* at the branch root. The site is then at
`https://<user>.github.io/<repo>/`.

Every path in the page is relative, so both work with no edits: the service
worker's scope, the manifest, the module imports and the worker URL all resolve
against wherever the page happens to be served from. `.nojekyll` is here so
GitHub publishes the files as they are rather than running them through Jekyll.

**Deploying only this folder from a monorepo.** `github-pages.yml` in this
folder is a ready-made workflow for that — copy it to
`.github/workflows/` in the repository root and set *Settings → Pages* to
*GitHub Actions*. It publishes `tabletop/` as the whole site, so the repo's Pages
URL becomes this app; leave it alone if you would rather serve the parent
project at the root and this at `/tabletop/`.

### Offline

`sw.js` precaches the whole shell on first visit, so once the page has loaded
once it works with no connection at all — which is the point, given the set is
usually on a table somewhere away from the desk. "Add to Home Screen" installs
it as a standalone app.

The one network request the page makes is the webfont from Google Fonts, and it
falls back to system faces when that is blocked or offline.

Bump `CACHE` in `sw.js` when you change the files, or visitors keep the old copy
until their browser revalidates.

## Using it

**Roll an opening.** Choose the surface — the 5 × 11 board or the five-level
pyramid — how many pieces to start with, and whether the engine picks them or
you pin the ones you want. A seed is recorded with every opening, and typing it
back in rebuilds exactly the same one.

Openings are lifted out of a complete fill, so the pieces left in the bag always
finish the board. The generator cannot hand you an impossible setup.

**Copy it onto the real set.** Rows are lettered `A`–`E`, columns numbered from
`1`, and a pyramid socket reads `L2B3` — layer 2, row B, column 3. Every
occupied socket carries its piece letter, so the sheet reads correctly in
greyscale and on paper. `Copy setup` puts the whole thing on the clipboard as
text with an ASCII diagram; `Print sheet` prints it with blank lines for times.

**Time it.** On a phone the stopwatch is docked at the bottom of the screen:
Start, Stop, Save. On a wide screen press `Space`, or Start. Stop and the
reading is offered as a save against the opening on screen. The clock survives
a screen lock or a reload, and asks the phone to keep the screen on while it
runs. Times typed by hand are just as welcome — separate minutes and seconds
fields, since a phone's number pad has no colon.

**On a phone** the page is three tabs: *Play* (roll, the sheet, your times),
*Log* (every opening and its best) and *Data* (backups and settings). The
surface and piece count you last used are remembered.

**Get them out.** The logbook lives in this browser's localStorage and nowhere
else. Every time is written the moment it is recorded, the browser is asked to
keep the storage from automatic cleanup, and two open tabs stay in sync rather
than overwriting each other. Export is still the only backup there is — on a
phone it opens the share sheet, so you can save to Files or send it anywhere:

| | |
| --- | --- |
| **JSON** | the whole logbook, and the only format `Import` reads back |
| **Times CSV** | one row per attempt, with a personal-best column |
| **Openings CSV** | one row per opening, with best, average and last |
| **Text** | a plain digest to paste anywhere |

Every duration in a CSV is written twice — `2:05` to read and `125.00` seconds
to sort on — so nothing has to be parsed back out of a clock string.

`Import` merges a JSON export into what is already here, folding times into an
opening you have already logged and skipping attempts it has seen before, so
moving a log between two devices is safe to do in both directions. Or replace
the logbook outright.

## What is here

```
index.html            the page
sw.js                 offline cache
manifest.webmanifest  installable app metadata
src/core/             the rules engine, copied from the parent project
  pieces.js             the twelve pieces, their orientations, the FCC lattice map
  target.js             the two target spaces and every legal placement in each
  solver.js             Algorithm X / dancing links
  rng.js                seeded randomness
  tabletop.js           openings, socket names, ASCII sheets, duration parsing
src/workers/          the solver, off the main thread
src/ui/
  app.js                the screen — generator, sheet, stopwatch, logbook
  store.js              localStorage, and the import/export model
  exporters.js          JSON, CSV and text
  setupSheet.js         the lettered grid
  solverClient.js       promise-shaped access to the worker
  dialog.js, dom.js, colors.js
src/styles/           tokens, then the page
```

`src/core/` and `src/workers/` are copies of the parent project's engine, not
links, which is what makes this folder stand alone. If you change a rule
upstream, copy those five files across again.

## Times are hand-entered

Nothing here watched you solve anything. The times are what you typed in, so
they are a logbook rather than a leaderboard: useful for racing yourself on an
opening you have done before, and meaningless as a claim against anyone else.
The "needed a peek" checkbox is there so an assisted run stays out of your best.
