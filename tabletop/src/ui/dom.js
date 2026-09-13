/** Small DOM helpers — no framework, no build step. */

export function h(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') applyStyle(node, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  append(node, children);
  return node;
}

/**
 * Custom properties have to go through setProperty — assigning them onto the
 * style object does nothing at all, silently.
 */
export function applyStyle(node, styles) {
  for (const [property, value] of Object.entries(styles)) {
    if (value === null || value === undefined) continue;
    if (property.startsWith('--')) node.style.setProperty(property, String(value));
    else node.style[property] = value;
  }
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Delegated listener — survives re-rendered children. */
export function delegate(root, type, selector, handler) {
  root.addEventListener(type, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

/** m:ss, or h:mm:ss past the hour. Always tabular so it does not jitter. */
export function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${mm}:${pad(seconds)}`;
}

/** Fixed-width clock for the play header: 00:00. */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatDelta(ms) {
  const sign = ms < 0 ? '−' : '+';
  return `${sign}${formatTime(Math.abs(ms))}`;
}

/** §11 — everything worth saying out loud goes through one live region. */
let liveNode = null;
export function announce(message) {
  if (!liveNode) liveNode = document.getElementById('live');
  if (!liveNode) return;
  liveNode.textContent = '';
  // A fresh text node on the next frame makes screen readers re-read repeats.
  requestAnimationFrame(() => { liveNode.textContent = message; });
}
