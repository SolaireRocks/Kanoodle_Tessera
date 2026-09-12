/**
 * Hash router (§6.3 screen flow).
 *
 *   Home -> Mode select -> Level select -> Gameplay -> Completion
 *
 * Screens are modules exporting `render(params)` and returning
 * `{ element, destroy? }`. Only one is mounted at a time.
 */

const routes = new Map();
let mounted = null;
let root = null;
let notFound = null;

export function defineRoute(name, loader) {
  routes.set(name, loader);
}

export function setNotFound(loader) {
  notFound = loader;
}

export function navigate(path, { replace = false } = {}) {
  const hash = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === hash) { render(); return; }
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}

export function currentPath() {
  return location.hash.slice(1) || '/';
}

function parse() {
  const [pathPart, queryPart] = currentPath().split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { name: segments[0] || 'splash', segments: segments.slice(1), query };
}

let renderToken = 0;

export async function render() {
  const token = ++renderToken;
  const { name, segments, query } = parse();
  const loader = routes.get(name) || notFound;
  if (!loader) return;

  let view;
  try {
    view = await loader({ segments, query });
  } catch (error) {
    console.error(error);
    view = notFound ? await notFound({ segments, query, error }) : null;
  }
  if (!view || token !== renderToken) return;

  mounted?.destroy?.();
  mounted = view;
  root.replaceChildren(view.element);
  // Keep the browser's own focus/scroll behaviour sane between screens.
  root.scrollTop = 0;
  view.focus?.();
}

export function startRouter(mountNode) {
  root = mountNode;
  window.addEventListener('hashchange', render);
  return render();
}
