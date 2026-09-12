/**
 * Tessera bootstrap.
 *
 * Loads the puzzle library, registers the screens from §6.3, and starts the
 * router. Everything after this point runs offline: the rules core, the solver
 * worker and the save file all live in the browser.
 */

import { h } from './dom.js';
import { defineRoute, setNotFound, startRouter, navigate, render } from './router.js';
import { loadContent } from './content.js';
import { store } from './store.js';
import { solverClient } from './solverClient.js';

const app = document.getElementById('app');

function splashScreen(message, detail) {
  return {
    element: h('section', { class: 'screen', style: { alignItems: 'center', justifyContent: 'center', padding: '40px' } },
      h('div', { style: { textAlign: 'center', maxWidth: '420px' } },
        h('div', { class: 'eyebrow accent', style: { marginBottom: '14px' }, text: 'TESSERA' }),
        h('div', { style: { fontSize: '20px', fontWeight: '600', marginBottom: '10px' }, text: message }),
        detail ? h('div', { class: 'sub', style: { lineHeight: '1.6' }, text: detail }) : null))
  };
}

async function boot() {
  app.replaceChildren(splashScreen('Loading the puzzle library…').element);

  try {
    await loadContent();
  } catch (error) {
    app.replaceChildren(splashScreen(
      'Could not load the puzzle library.',
      `${error.message} Tessera needs to be served over http — run "npm start" in the project folder and open the address it prints.`
    ).element);
    return;
  }

  defineRoute('splash', () => import('./screens/splash.js').then((m) => m.render()));
  defineRoute('home', () => import('./screens/home.js').then((m) => m.render()));
  defineRoute('modes', () => import('./screens/modes.js').then((m) => m.render()));
  defineRoute('levels', (ctx) => import('./screens/levels.js').then((m) => m.render(ctx)));
  defineRoute('play', (ctx) => import('./screens/play.js').then((m) => m.render(ctx)));
  defineRoute('lab', (ctx) => import('./screens/play.js')
    .then((m) => m.render({ segments: ['lab'], query: ctx.query })));
  defineRoute('tabletop', (ctx) => import('./screens/tabletop.js').then((m) => m.render(ctx)));
  defineRoute('complete', () => import('./screens/complete.js').then((m) => m.render()));
  defineRoute('settings', () => import('./screens/settings.js').then((m) => m.render()));
  defineRoute('stats', () => import('./screens/stats.js').then((m) => m.render()));

  setNotFound(({ error }) => {
    if (error) console.error(error);
    return {
      element: h('section', { class: 'screen', style: { alignItems: 'center', justifyContent: 'center', padding: '40px' } },
        h('div', { style: { textAlign: 'center' } },
          h('div', { class: 'eyebrow accent', style: { marginBottom: '14px' }, text: 'NOT FOUND' }),
          h('div', { style: { fontSize: '20px', fontWeight: '600', marginBottom: '18px' },
            text: error ? 'That screen hit an error.' : 'That screen does not exist.' }),
          h('button', { class: 'btn btn--primary', text: 'Back to home', onClick: () => navigate('/home') })))
    };
  });

  // Returning players skip the title card.
  if (!location.hash || location.hash === '#/') {
    const seen = store.profile.history.length > 0 || store.savedSession;
    if (seen) history.replaceState(null, '', '#/home');
  }

  await startRouter(app);
  solverClient.warm();

  // A palette or contrast change needs a repaint of whatever is on screen.
  store.addEventListener('change', () => { store.applyDocumentSettings(); });

  window.addEventListener('pagehide', () => {
    // The play screen already persists after every move; this is the belt.
    store.save();
  });
}

boot();

// Expose the engine for the Solver Lab console and for debugging.
if (typeof window !== 'undefined') {
  window.tessera = { store, solverClient, render };
}
