/**
 * Offline cache.
 *
 * The whole site is a dozen static files, so the shell is precached on install
 * and served cache-first — which is also what makes the page usable in a
 * kitchen with no signal. Every path is relative, so the same worker works at
 * `/`, at `/repo/` on GitHub Pages, and in a subfolder of any other host.
 *
 * Bump CACHE when the files change: the old cache is dropped on activate, and
 * `skipWaiting` + `clients.claim` mean the new copy takes over on the next
 * load rather than the load after that.
 */

const CACHE = 'tessera-tabletop-v2';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles/tokens.css',
  './src/styles/app.css',
  './src/ui/app.js',
  './src/ui/dom.js',
  './src/ui/store.js',
  './src/ui/dialog.js',
  './src/ui/colors.js',
  './src/ui/setupSheet.js',
  './src/ui/exporters.js',
  './src/ui/solverClient.js',
  './src/workers/solver.worker.js',
  './src/core/pieces.js',
  './src/core/target.js',
  './src/core/solver.js',
  './src/core/rng.js',
  './src/core/tabletop.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One miss must not fail the whole install, so each file is added on its
      // own and a failure is simply not cached.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Google Fonts: let the network have it.

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so a deploy is picked up on the next visit
        // without ever making this one wait for the network.
        event.waitUntil(
          fetch(request)
            .then((response) => response.ok && caches.open(CACHE).then((cache) => cache.put(request, response)))
            .catch(() => {})
        );
        return hit;
      }
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
