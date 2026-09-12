/**
 * Browser checks (§13) — drives the real UI in headless Chrome.
 *
 * Needs a running server and a Chrome build:
 *   npm start                       (in one terminal)
 *   npm i -D puppeteer-core         (once)
 *   npm run test:browser            (optionally CHROME=/path/to/chrome)
 *
 * Screenshots land in tools/shots/ for eyeballing.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:5173';
const shotDir = resolve(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => resolve(shotDir, name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const problems = [];
const ok = [];

async function newPage(w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, isMobile: w < 900, hasTouch: w < 900 });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  return page;
}

// 1. tap-place on the 2-D board
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/classic2d-01-01', { waitUntil: 'networkidle2' });
  await wait(900);
  const before = await page.$$eval('.bead[data-piece]', (n) => n.length);
  await page.click('.traypiece');
  await wait(200);
  await page.evaluate(async () => {
    const bead = document.querySelector('.bead:not([data-piece])');
    bead.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  });
  await wait(600);
  const after = await page.$$eval('.bead[data-piece]', (n) => n.length);
  ok.push('rookie tap-place: ' + before + ' -> ' + after + ' hash=' + page.url().split('#')[1]);
  await page.close();
}

// 2. Solve -> confirm -> animation -> completion
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/classic2d-04-02', { waitUntil: 'networkidle2' });
  await wait(900);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Solve puzzle').click());
  await wait(500);
  await page.evaluate(() => [...document.querySelectorAll('.sheet__panel button')].find((b) => b.textContent.trim() === 'Solve').click());
  await wait(7000);
  const hash = page.url().split('#')[1];
  const heading = await page.evaluate(() => document.querySelector('.eyebrow.accent')?.textContent);
  if (hash !== '/complete') problems.push('solve did not reach completion, at ' + hash);
  ok.push('solve flow: ' + hash + ' "' + heading + '"');
  await page.screenshot({ path: shot('d-complete.png') });
  await page.close();
}

// 3. hint ladder
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/classic2d-05-01', { waitUntil: 'networkidle2' });
  await wait(900);
  await page.keyboard.press('h'); await wait(600);
  const hinted = await page.$$eval('.play3__left .traypiece.is-hinted', (n) => n.length);
  await page.keyboard.press('h'); await wait(400);
  await page.keyboard.press('h'); await wait(500);
  const ghosts = await page.$$eval('.bead.is-hint', (n) => n.length);
  if (hinted !== 1) problems.push('hint 1 highlighted ' + hinted + ' tray pieces');
  if (ghosts < 3) problems.push('hint 3 showed ' + ghosts + ' ghost beads');
  ok.push('hint ladder: tray=' + hinted + ' ghost=' + ghosts);
  await page.screenshot({ path: shot('d-play2d-hint.png') });
  await page.close();
}

// 4. 3-D placement via the hint target
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/pyramid-01-01', { waitUntil: 'networkidle2' });
  await wait(1200);
  await page.evaluate(() => document.querySelector('.traypiece').click());
  await wait(300);
  await page.keyboard.press('h'); await wait(700);
  await page.keyboard.press('h'); await wait(400);
  await page.keyboard.press('h'); await wait(600);
  const placed = await page.evaluate(async () => {
    const bead = document.querySelector('.pyrbead.is-hint');
    if (!bead) return 'no hint bead';
    bead.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelectorAll('.pyrbead[data-piece]').length;
  });
  await wait(800);
  const hash3d = page.url().split('#')[1];
  ok.push('3-D hint tap: filled=' + placed + ' hash=' + hash3d);
  if (hash3d !== '/complete') problems.push('3-D hint placement did not finish the pyramid (at ' + hash3d + ')');
  await page.close();
}

// 5. save and resume
{
  const page = await newPage(390, 844);
  await page.goto(BASE + '/#/play/classic2d-06-01', { waitUntil: 'networkidle2' });
  await wait(900);
  await page.keyboard.press('h'); await wait(700);
  await page.keyboard.press('h'); await wait(400);
  await page.keyboard.press('h'); await wait(600);
  const dropped = await page.evaluate(async () => {
    const bead = document.querySelector('.bead.is-hint');
    if (!bead) return 'no hint';
    bead.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelectorAll('.bead[data-piece]').length;
  });
  await wait(600);
  await page.goto(BASE + '/#/home', { waitUntil: 'networkidle2' });
  await wait(800);
  const hasResume = await page.evaluate(() => Boolean(document.querySelector('.card--accent')));
  await page.screenshot({ path: shot('m-home-resume.png') });
  if (hasResume) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resume').click());
    await wait(1100);
  }
  const restored = await page.$$eval('.bead[data-piece]', (n) => n.length);
  ok.push('resume: dropped=' + dropped + ' card=' + hasResume + ' restored=' + restored);
  if (!hasResume) problems.push('no resume card after leaving a run in progress');
  if (restored !== dropped) problems.push('resume restored ' + restored + ' beads, expected ' + dropped);
  await page.close();
}

// 6. every screen renders
for (const [name, hash, w, h] of [
  ['d-home', '#/home', 1440, 900],
  ['d-levels', '#/levels/classic2d/expert', 1440, 900],
  ['d-play2d', '#/play/classic2d-04-01', 1440, 900],
  ['d-play3d', '#/play/pyramid-03-01', 1440, 900],
  ['m-settings', '#/settings', 390, 844],
  ['m-stats', '#/stats', 390, 844],
  ['d-lab', '#/lab', 1440, 900],
  ['m-lab', '#/lab', 390, 844],
  ['m-modes', '#/modes', 390, 844],
  ['m-play2d', '#/play/classic2d-04-01', 390, 844],
  ['m-play3d', '#/play/pyramid-03-01', 390, 844]
]) {
  const page = await newPage(w, h);
  await page.goto(BASE + '/' + hash, { waitUntil: 'networkidle2' });
  await wait(1000);
  await page.screenshot({ path: shot(name + '.png') });
  await page.close();
}


// 7. real pointer drag: tray -> board, then board -> illegal release
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/classic2d-03-01', { waitUntil: 'networkidle2' });
  await wait(1000);

  const beforeCount = await page.$$eval('.bead[data-piece]', (n) => n.length);

  // Ask the engine where the first piece goes, then drag it there for real.
  await page.keyboard.press('h'); await wait(700);
  await page.keyboard.press('h'); await wait(300);
  await page.keyboard.press('h'); await wait(500);

  const spot = await page.evaluate(() => {
    const target = document.querySelector('.bead.is-hint');
    if (!target) return null;
    const t = target.getBoundingClientRect();
    const source = document.querySelector('.play3__left .traypiece.is-hinted') || document.querySelector('.play3__left .traypiece');
    const s = source.getBoundingClientRect();
    return {
      from: { x: s.x + s.width / 2, y: s.y + s.height / 2 },
      to: { x: t.x + t.width / 2, y: t.y + t.height / 2 }
    };
  });
  if (!spot) { problems.push('no hint target for the drag test'); }
  else {
    await page.mouse.move(spot.from.x, spot.from.y);
    await page.mouse.down();
    await page.mouse.move(spot.to.x - 40, spot.to.y - 40, { steps: 6 });
    await page.mouse.move(spot.to.x, spot.to.y, { steps: 6 });
    const ghost = await page.$$eval('.bead.is-ghost', (n) => n.length);
    await page.mouse.up();
    await wait(500);
    const afterDrag = await page.$$eval('.bead[data-piece]', (n) => n.length);
    ok.push('drag from tray: ghost=' + ghost + ' beads ' + beforeCount + ' -> ' + afterDrag);
    if (ghost === 0) problems.push('no snapped ghost appeared while dragging');
    if (afterDrag <= beforeCount) problems.push('drag from tray did not place the piece');

    // Now drag that same piece somewhere illegal and check it goes home.
    const home = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.bead[data-piece]')].find((n) => n.dataset.locked === 'false');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, cells: [...document.querySelectorAll('.bead[data-piece]')].length };
    });
    if (home) {
      await page.mouse.move(home.x, home.y);
      await page.mouse.down();
      await page.mouse.move(120, 830, { steps: 10 });   // way off the board
      await page.mouse.up();
      await wait(500);
      const afterCancel = await page.$$eval('.bead[data-piece]', (n) => n.length);
      ok.push('cancelled drag: ' + home.cells + ' -> ' + afterCancel + ' beads');
      if (afterCancel !== home.cells) problems.push('a cancelled drag lost the piece (' + home.cells + ' -> ' + afterCancel + ')');
    }
  }
  await page.close();
}

// 8. free mode: the opening chooser, a hand-picked opening, and a rolled one
{
  const page = await newPage(1440, 900);
  await page.goto(BASE + '/#/play/free', { waitUntil: 'networkidle2' });
  await wait(1000);

  const setup = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('[aria-label="Choose an opening piece"]')),
    filled: document.querySelectorAll('.bead[data-piece]').length,
    tray: document.querySelectorAll('.play3__left .traypiece').length,
    hintOff: document.querySelector('.desk-dock .btn--soft')?.disabled,
    title: document.querySelector('.topbar .eyebrow')?.textContent
  }));
  ok.push('free setup: panel=' + setup.panel + ' filled=' + setup.filled +
    ' tray=' + setup.tray + ' hintDisabled=' + setup.hintOff + ' "' + setup.title + '"');
  if (!setup.panel) problems.push('free mode did not show the opening panel');
  if (setup.filled !== 0) problems.push('free mode started with ' + setup.filled + ' beads on the board');
  if (setup.tray !== 12) problems.push('free mode offered ' + setup.tray + ' pieces, expected 12');
  if (setup.hintOff !== true) problems.push('Hint was live before an opening was chosen');
  await page.screenshot({ path: shot('d-play-free-setup.png') });

  // Piece A face-up at bead 1 strands the board; at bead 3 it does not.
  await page.evaluate(() =>
    [...document.querySelectorAll('.play3__left .traypiece')]
      .find((b) => b.getAttribute('aria-label').startsWith('Piece A,')).click());
  await wait(200);
  await page.evaluate(() =>
    document.querySelector('.bead[data-index="1"]')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })));
  await wait(900);
  const refused = await page.evaluate(() => ({
    filled: document.querySelectorAll('.bead[data-piece]').length,
    toast: document.querySelector('.toast.is-warn')?.textContent || '',
    stillChoosing: Boolean(document.querySelector('[aria-label="Choose an opening piece"]'))
  }));
  ok.push('dead opening refused: filled=' + refused.filled + ' "' + refused.toast + '"');
  if (refused.filled !== 0) problems.push('a dead opening was committed to the board');
  if (!refused.stillChoosing) problems.push('a dead opening dismissed the opening panel');

  // A good one locks in: four beads down, panel gone, clock running, Hint live.
  await page.evaluate(() =>
    document.querySelector('.bead[data-index="3"]')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0 })));
  await wait(900);
  const locked = await page.evaluate(() => ({
    filled: document.querySelectorAll('.bead[data-piece]').length,
    lockedBeads: document.querySelectorAll('.bead[data-locked="true"]').length,
    where: [...document.querySelectorAll('.bead[data-piece]')].map((n) => n.dataset.index).join(','),
    panel: Boolean(document.querySelector('[aria-label="Choose an opening piece"]')),
    tray: document.querySelectorAll('.play3__left .traypiece').length,
    title: document.querySelector('.topbar .eyebrow')?.textContent,
    hintOff: document.querySelector('.desk-dock .btn--soft')?.disabled
  }));
  ok.push('opening locked: filled=' + locked.filled + ' at [' + locked.where + ']' +
    ' tray=' + locked.tray + ' "' + locked.title + '"');
  if (locked.where !== '3,14,24,25') problems.push('the opening landed at [' + locked.where + '], expected [3,14,24,25]');
  if (locked.filled !== 4) problems.push('locking piece A put ' + locked.filled + ' beads down, expected 4');
  if (locked.lockedBeads !== 4) problems.push('the opening is not marked as locked setup');
  if (locked.panel) problems.push('the opening panel survived the lock-in');
  if (locked.tray !== 11) problems.push('after the opening the tray holds ' + locked.tray + ', expected 11');
  if (locked.hintOff !== false) problems.push('Hint stayed disabled after the opening was chosen');

  // The solver still works from the seeded board.
  await page.keyboard.press('h'); await wait(800);
  const hinted = await page.$$eval('.play3__left .traypiece.is-hinted', (n) => n.length);
  if (hinted !== 1) problems.push('hint after a free opening highlighted ' + hinted + ' pieces');
  await page.screenshot({ path: shot('d-play-free.png') });
  await page.close();
}

{
  const page = await newPage(390, 844);
  await page.goto(BASE + '/#/play/free', { waitUntil: 'networkidle2' });
  await wait(1000);
  await page.screenshot({ path: shot('m-play-free-setup.png') });
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Random opening').click());
  await wait(1500);
  const rolled = await page.evaluate(() => ({
    filled: document.querySelectorAll('.bead[data-piece]').length,
    locked: document.querySelectorAll('.bead[data-locked="true"]').length,
    panel: Boolean(document.querySelector('[aria-label="Choose an opening piece"]')),
    clock: document.querySelector('.mhead__clock')?.textContent
  }));
  ok.push('random opening: filled=' + rolled.filled + ' locked=' + rolled.locked + ' clock=' + rolled.clock);
  if (rolled.filled < 3 || rolled.filled > 5) problems.push('a rolled opening put ' + rolled.filled + ' beads down');
  if (rolled.locked !== rolled.filled) problems.push('a rolled opening is not locked setup');
  if (rolled.panel) problems.push('the opening panel survived a random roll');
  await page.screenshot({ path: shot('m-play-free.png') });
  await page.close();
}

console.log('--- OK ---');
console.log(ok.join(String.fromCharCode(10)));
console.log('--- PROBLEMS ---');
console.log(problems.length ? [...new Set(problems)].join(String.fromCharCode(10)) : 'none');
await browser.close();
