/**
 * The five-level pyramid (§2 3-D source structure, §5.1 3-D controls).
 *
 * Beads are real DOM elements inside a CSS 3-D scene — the same construction
 * the UI design canvas uses — which means hit-testing, focus and screen-reader
 * labelling all come for free, and there is no WebGL dependency to ship.
 *
 * Camera and piece controls never share a gesture (§13): dragging a bead does
 * nothing, dragging empty space orbits, and placement is always a tap on a
 * socket with an explicitly chosen orientation.
 */

import { PIECE_BY_ID } from '../../core/pieces.js';
import { getTarget, pyramidCoords, layerSize, PYRAMID_LAYERS } from '../../core/target.js';
import { h, announce } from '../dom.js';
import { store } from '../store.js';
import { colorOf } from './pieceArt.js';

const DEFAULT_CAMERA = { tilt: 58, spin: -38, zoom: 1 };

/** Phones give the pyramid less room, so it starts a little closer. */
const startingZoom = () => (window.matchMedia('(min-width: 1080px)').matches ? 1 : 1.35);

export class Pyramid3D {
  constructor(config) {
    this.config = config;
    this.session = config.session;
    this.target = getTarget('3D');
    this.camera = { ...DEFAULT_CAMERA, zoom: startingZoom() };
    this.activeLayer = null;
    this.ghostCells = null;
    this.ghostConflict = false;
    this.ghostPiece = null;
    this.hintCells = null;
    this.cursor = 0;

    this.byFcc = new Map(this.target.cells.map((cell) => [cell.fcc.join(','), cell.index]));
    this.beads = [];
    this.layerNodes = [];

    this.pivot = h('div', { class: 'pyrpivot' });
    this.scene = h('div', { class: 'pyrscene' }, this.pivot);
    this.stage = h('div', {
      class: 'pyrstage',
      role: 'grid',
      'aria-label': 'Pyramid, five layers'
    },
    h('div', {
      class: 'pyrstage__hint mob-only',
      html: 'DRAG TO ORBIT · PINCH TO ZOOM'
    }),
    h('div', {
      class: 'pyrstage__hint desk-only',
      html: 'DRAG EMPTY SPACE TO ORBIT<br>SCROLL TO ZOOM · Q/E YAW · W/S PITCH'
    }),
    this.scene,
    h('div', { class: 'camcontrols' },
      this.#camButton('＋', 'Zoom in', () => this.zoom(1.15)),
      this.#camButton('－', 'Zoom out', () => this.zoom(1 / 1.15)),
      this.#camButton('⌂', 'Recentre the camera', () => this.recenter()),
      this.#camButton('⛶', 'Show every layer', () => this.setActiveLayer(null))));

    this.element = this.stage;

    this.#buildBeads();
    this.#applyCamera();

    this.stage.addEventListener('pointerdown', this.#onPointerDown);
    this.stage.addEventListener('pointerover', this.#onPointerOver);
    this.stage.addEventListener('pointerleave', () => this.clearGhost());
    this.stage.addEventListener('wheel', this.#onWheel, { passive: false });
    this.stage.addEventListener('keydown', this.#onKeyDown);
  }

  #camButton(icon, label, onClick) {
    return h('button', { type: 'button', 'aria-label': label, title: label, text: icon, onClick });
  }

  /* -------------------------------------------------------------- geometry */

  #metrics() {
    const wide = window.matchMedia('(min-width: 1080px)').matches;
    const cell = wide ? 52 : 26;
    const gap = wide ? 7 : 4;
    // Each layer nests into the dimples below: half a step across, and a step
    // divided by root two upward. That is the real sphere-packing height.
    return { cell, gap, lift: (cell + gap) / Math.SQRT2 };
  }

  #buildBeads() {
    const { cell, gap, lift } = this.#metrics();
    this.pivot.replaceChildren();
    this.layerNodes = [];

    for (let layer = 0; layer < PYRAMID_LAYERS; layer++) {
      const n = layerSize(layer);
      const width = n * cell + (n - 1) * gap;
      const node = h('div', {
        class: 'pyrlayer',
        role: 'row',
        'aria-label': `Layer ${layer + 1}`,
        style: {
          gridTemplateColumns: `repeat(${n}, ${cell}px)`,
          gap: `${gap}px`,
          transform: `translate(${-width / 2}px, ${-width / 2}px) translateZ(${layer * lift}px)`
        }
      });

      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const index = this.target.cells.find(
            (c) => c.layer === layer && c.row === row && c.col === col
          ).index;
          const bead = h('div', {
            class: 'pyrbead',
            role: 'gridcell',
            tabindex: '-1',
            style: {
              width: `${cell}px`,
              height: `${cell}px`,
              fontSize: `${cell * 0.44}px`,
              // Counter-rotate each bead so it always faces the camera: the
              // lattice supplies the isometric position, the bead stays round.
              transform: 'var(--billboard)'
            },
            dataset: { index: String(index), layer: String(layer) }
          });
          this.beads[index] = bead;
          node.appendChild(bead);
        }
      }
      this.layerNodes.push(node);
      this.pivot.appendChild(node);
    }
  }

  /** Rebuild at the new bead size when the viewport crosses the desktop break. */
  relayout() {
    this.#buildBeads();
    this.refresh();
  }

  #applyCamera() {
    const { tilt, spin, zoom } = this.camera;
    // The stack grows upward from the base layer, so the shape's centre of mass
    // sits above the pivot. Nudge it back down by half the projected rise, or
    // the pyramid hangs off the top of the stage.
    const rise = (PYRAMID_LAYERS - 1) * this.#metrics().lift;
    const drop = (rise / 2) * Math.sin((tilt * Math.PI) / 180) * zoom;
    this.pivot.style.transform =
      `translateY(${drop}px) scale3d(${zoom}, ${zoom}, ${zoom}) rotateX(${tilt}deg) rotateZ(${spin}deg)`;
    // The exact inverse rotation, handed down to every bead.
    this.pivot.style.setProperty('--billboard', `rotateZ(${-spin}deg) rotateX(${-tilt}deg)`);
  }

  zoom(factor) {
    this.camera.zoom = Math.max(0.5, Math.min(2, this.camera.zoom * factor));
    this.#applyCamera();
  }

  recenter() {
    this.camera = { ...DEFAULT_CAMERA, zoom: startingZoom() };
    this.#applyCamera();
    announce('Camera recentred.');
  }

  orbit(dSpin, dTilt) {
    this.camera.spin += dSpin;
    this.camera.tilt = Math.max(12, Math.min(86, this.camera.tilt + dTilt));
    this.#applyCamera();
  }

  setActiveLayer(layer) {
    this.activeLayer = layer;
    for (let i = 0; i < this.layerNodes.length; i++) {
      // Dim everything stacked above the layer in focus so you can see in.
      const hidden = layer !== null && i > layer;
      this.layerNodes[i].classList.toggle('is-dimmed', hidden);
      this.layerNodes[i].style.pointerEvents = hidden ? 'none' : '';
    }
    this.config.onLayerChange?.(layer);
  }

  /* -------------------------------------------------------------- painting */

  refresh() {
    const owner = this.session.occupancy();
    const glyphs = store.settings.glyphs;
    const ghost = new Set(this.ghostCells || []);
    const hint = new Set(this.hintCells || []);

    for (let index = 0; index < this.beads.length; index++) {
      const bead = this.beads[index];
      if (!bead) continue;
      const at = owner[index];
      const isGhost = ghost.has(index);

      bead.className = 'pyrbead' +
        (isGhost ? (this.ghostConflict ? ' is-conflict' : ' is-ghost') : '') +
        (hint.has(index) && !isGhost ? ' is-hint' : '');
      bead.tabIndex = index === this.cursor ? 0 : -1;

      if (at) {
        bead.dataset.piece = at.piece;
        bead.dataset.locked = String(at.locked);
        bead.style.setProperty('--c', colorOf(at.piece));
        bead.textContent = glyphs ? PIECE_BY_ID[at.piece].glyph : '';
      } else {
        delete bead.dataset.piece;
        delete bead.dataset.locked;
        bead.style.removeProperty('--c');
        bead.textContent = '';
      }
      if (isGhost && this.ghostPiece) {
        bead.style.setProperty('--c', this.ghostConflict ? '#FF6B85' : colorOf(this.ghostPiece));
      }

      const { layer, row, col } = pyramidCoords(index);
      bead.setAttribute('aria-label',
        `Layer ${layer + 1}, row ${row + 1}, column ${col + 1}, ` +
        (at ? `piece ${at.piece}${at.locked ? ', locked setup piece' : ', placed by you'}` : 'empty'));
    }
  }

  setGhost(cells, { conflict = false, piece = null } = {}) {
    this.ghostCells = cells;
    this.ghostConflict = conflict;
    this.ghostPiece = piece;
    this.refresh();
  }

  clearGhost() {
    if (!this.ghostCells) return;
    this.ghostCells = null;
    this.ghostPiece = null;
    this.ghostConflict = false;
    this.refresh();
  }

  setHint(cells) {
    this.hintCells = cells;
    this.refresh();
  }

  /** Per-layer fill counts for the layer tabs and the desktop layer list. */
  layerStats() {
    const owner = this.session.occupancy();
    return Array.from({ length: PYRAMID_LAYERS }, (_, layer) => {
      const total = layerSize(layer) ** 2;
      let filled = 0;
      for (const cell of this.target.cells) {
        if (cell.layer === layer && owner[cell.index]) filled++;
      }
      return { layer, filled, total, done: filled === total };
    });
  }

  /* ----------------------------------------------------- placement math -- */

  /** Place `pieceId` so that shape-cell `grabIndex` lands on socket `target`. */
  candidateAt(pieceId, orientationIndex, grabIndex, target) {
    const piece = PIECE_BY_ID[pieceId];
    const orientation = piece.orientations3d[orientationIndex];
    if (!orientation) return null;
    const grab = orientation.cells[Math.min(grabIndex, orientation.cells.length - 1)];
    const anchorFcc = this.target.cells[target].fcc;
    const base = [anchorFcc[0] - grab[0], anchorFcc[1] - grab[1], anchorFcc[2] - grab[2]];

    const cells = [];
    for (const [da, db, dh] of orientation.cells) {
      const hit = this.byFcc.get(`${base[0] + da},${base[1] + db},${base[2] + dh}`);
      if (hit === undefined) return null;
      cells.push(hit);
    }
    const placement = { piece: pieceId, orientation: orientationIndex, cells: cells.sort((a, b) => a - b) };
    return this.session.canPlace(placement) ? placement : null;
  }

  /** Try every anchor cell of the chosen orientation that covers `target`. */
  findPlacement(pieceId, orientationIndex, target) {
    const orientation = PIECE_BY_ID[pieceId].orientations3d[orientationIndex];
    if (!orientation) return null;
    for (let grab = 0; grab < orientation.cells.length; grab++) {
      const placement = this.candidateAt(pieceId, orientationIndex, grab, target);
      if (placement) return placement;
    }
    return null;
  }

  /* -------------------------------------------------------------- pointer - */

  #onPointerOver = (event) => {
    const bead = event.target.closest('.pyrbead');
    if (!bead || this.orbiting) return;
    const index = Number(bead.dataset.index);
    const selection = this.config.getSelection?.();
    if (!selection) return;
    if (this.session.occupancy()[index]) { this.clearGhost(); return; }
    const placement = this.findPlacement(selection.pieceId, selection.orientationIndex, index);
    if (placement) this.setGhost(placement.cells, { piece: selection.pieceId });
    else this.setGhost([index], { conflict: true, piece: selection.pieceId });
  };

  #onPointerDown = (event) => {
    const bead = event.target.closest('.pyrbead');
    if (bead) {
      event.preventDefault();
      this.#activate(Number(bead.dataset.index));
      return;
    }
    if (event.target.closest('.camcontrols')) return;
    this.#beginOrbit(event);
  };

  #activate(index) {
    this.cursor = index;
    const owner = this.session.occupancy()[index];
    if (owner?.locked) {
      this.config.onInvalid?.(`Piece ${owner.piece} is part of the setup and cannot move.`);
      return;
    }
    if (owner) {
      this.config.onLift?.(owner.piece);
      const entry = this.session.placed.find((p) => p.piece === owner.piece);
      this.config.onSelect?.(owner.piece, entry?.orientation ?? 0);
      return;
    }
    const selection = this.config.getSelection?.();
    if (!selection) {
      this.config.onInvalid?.('Choose a piece first, then tap a socket.');
      return;
    }
    const placement = this.findPlacement(selection.pieceId, selection.orientationIndex, index);
    if (placement) this.config.onPlace?.(placement);
    else this.config.onInvalid?.(`Piece ${selection.pieceId} does not fit there in this orientation.`);
  }

  #beginOrbit(event) {
    this.orbiting = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.clearGhost();
    const move = (e) => {
      if (!this.orbiting || e.pointerId !== this.orbiting.id) return;
      e.preventDefault();
      this.orbit((e.clientX - this.orbiting.x) * 0.45, -(e.clientY - this.orbiting.y) * 0.35);
      this.orbiting.x = e.clientX;
      this.orbiting.y = e.clientY;
    };
    const end = () => {
      this.orbiting = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  #onWheel = (event) => {
    event.preventDefault();
    this.zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08);
  };

  /* ------------------------------------------------------------- keyboard - */

  #onKeyDown = (event) => {
    const step = event.shiftKey ? 12 : 5;
    switch (event.key.toLowerCase()) {
      case 'q': this.orbit(-step, 0); break;
      case 'e': this.orbit(step, 0); break;
      case 'w': this.orbit(0, step); break;
      case 's': if (event.ctrlKey || event.metaKey) return; this.orbit(0, -step); break;
      case 'pageup': this.zoom(1.12); break;
      case 'pagedown': this.zoom(1 / 1.12); break;
      case 'enter':
      case ' ': {
        const focused = document.activeElement?.closest?.('.pyrbead');
        if (!focused) return;
        event.preventDefault();
        this.#activate(Number(focused.dataset.index));
        return;
      }
      default: return;
    }
    event.preventDefault();
  };

  /** Move keyboard focus onto a socket so the pyramid is operable without a mouse. */
  focusSocket(index) {
    this.cursor = index;
    this.refresh();
    this.beads[index]?.focus();
  }
}
