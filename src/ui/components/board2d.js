/**
 * The 5 x 11 board (§3.2 placement behaviour, §5 responsive controls).
 *
 * One component owns rendering, hit-testing and every input path:
 *   - drag from the tray or from a placed piece, with a snapped ghost
 *   - tap-select then tap-place, which is the reliable small-screen path
 *   - full keyboard operation with a roving cursor
 *
 * Hit-testing is done in logical cells, never pixel collision, so the same code
 * works at 360 px and 1440 px.
 */

import { PIECE_BY_ID } from '../../core/pieces.js';
import { BOARD_ROWS, BOARD_COLS, boardIndex, boardRow, boardCol } from '../../core/target.js';
import { h, clear, announce } from '../dom.js';
import { store } from '../store.js';
import { colorOf } from './pieceArt.js';

export class Board2D {
  /**
   * @param {{session:import('../../core/session.js').Session,
   *          onPlace:Function, onLift:Function, onInvalid:Function,
   *          getSelection:Function, onSelect:Function}} config
   */
  constructor(config) {
    this.config = config;
    this.session = config.session;
    this.cursor = 0;
    this.ghostCells = null;
    this.ghostConflict = false;
    this.ghostPiece = null;
    this.hintCells = null;
    this.drag = null;
    this.beads = [];

    this.grid = h('div', {
      class: 'board',
      role: 'grid',
      'aria-label': `Board, ${BOARD_ROWS} rows by ${BOARD_COLS} columns`,
      'aria-rowcount': BOARD_ROWS,
      'aria-colcount': BOARD_COLS
    });

    for (let r = 0; r < BOARD_ROWS; r++) {
      const row = h('div', { class: 'boardrow', role: 'row', 'aria-rowindex': r + 1 });
      for (let c = 0; c < BOARD_COLS; c++) {
        const index = boardIndex(r, c);
        const bead = h('div', {
          class: 'bead',
          role: 'gridcell',
          tabindex: '-1',
          'aria-colindex': c + 1,
          dataset: { index: String(index) }
        });
        this.beads[index] = bead;
        row.appendChild(bead);
      }
      this.grid.appendChild(row);
    }

    this.element = h('div', { class: 'boardwell' }, this.grid);

    this.grid.addEventListener('pointerdown', this.#onPointerDown);
    this.grid.addEventListener('keydown', this.#onKeyDown);
    this.grid.addEventListener('focusin', (event) => {
      const index = Number(event.target.dataset.index);
      if (Number.isInteger(index)) this.#setCursor(index, { focus: false });
    });
  }

  destroy() {
    this.#endDrag();
  }

  /* ------------------------------------------------------------- painting - */

  refresh() {
    const owner = this.session.occupancy();
    const glyphs = store.settings.glyphs;
    const ghost = new Set(this.ghostCells || []);
    const hint = new Set(this.hintCells || []);

    for (let index = 0; index < this.beads.length; index++) {
      const bead = this.beads[index];
      const at = owner[index];
      const isGhost = ghost.has(index);

      bead.className = 'bead' +
        (isGhost ? (this.ghostConflict ? ' is-conflict' : ' is-ghost') : '') +
        (hint.has(index) && !isGhost ? ' is-hint' : '') +
        (index === this.cursor ? ' is-cursor' : '');
      bead.tabIndex = index === this.cursor ? 0 : -1;

      if (at) {
        bead.dataset.piece = at.piece;
        bead.dataset.locked = String(at.locked);
        bead.style.setProperty('--c', colorOf(at.piece));
        if (glyphs) bead.dataset.glyph = PIECE_BY_ID[at.piece].glyph;
        else delete bead.dataset.glyph;
      } else {
        delete bead.dataset.piece;
        delete bead.dataset.locked;
        delete bead.dataset.glyph;
        bead.style.removeProperty('--c');
      }

      if (isGhost && this.ghostPiece) {
        bead.style.setProperty('--c', this.ghostConflict ? '#FF6B85' : colorOf(this.ghostPiece));
      }

      bead.setAttribute('aria-label', this.#describe(index, at));
    }
  }

  #describe(index, at) {
    const where = `Row ${boardRow(index) + 1}, column ${boardCol(index) + 1}`;
    if (!at) return `${where}, empty`;
    return `${where}, piece ${at.piece}${at.locked ? ', locked setup piece' : ', placed by you'}`;
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

  markPlaced(cells) {
    if (store.settings.reduceMotion) return;
    for (const index of cells) {
      const bead = this.beads[index];
      bead.classList.remove('is-placing');
      void bead.offsetWidth;
      bead.classList.add('is-placing');
    }
  }

  /* ------------------------------------------------------- placement math - */

  /**
   * Where does `piece` land if the shape cell at `grabIndex` sits on `target`?
   * Returns a placement when every socket is free and in bounds, else null.
   */
  candidateAt(pieceId, orientationIndex, grabIndex, target) {
    const piece = PIECE_BY_ID[pieceId];
    const orientation = piece.orientations2d[orientationIndex];
    if (!orientation) return null;
    const grab = orientation.cells[Math.min(grabIndex, orientation.cells.length - 1)];
    const originRow = boardRow(target) - grab[0];
    const originCol = boardCol(target) - grab[1];
    if (originRow < 0 || originCol < 0) return null;
    if (originRow + orientation.rows > BOARD_ROWS) return null;
    if (originCol + orientation.cols > BOARD_COLS) return null;

    const cells = orientation.cells.map(([r, c]) => boardIndex(originRow + r, originCol + c));
    const placement = { piece: pieceId, orientation: orientationIndex, cells };
    return this.session.canPlace(placement) ? placement : null;
  }

  /**
   * §3.2 — snap to the nearest legal anchor, and only when the whole piece
   * fits. Ties are resolved by distance so the ghost does not flicker between
   * two equally close anchors.
   */
  findPlacement(pieceId, orientationIndex, grabIndex, target, { snap = store.settings.snap } = {}) {
    const direct = this.candidateAt(pieceId, orientationIndex, grabIndex, target);
    if (direct || !snap) return direct;

    const row = boardRow(target);
    const col = boardCol(target);
    const offsets = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        offsets.push([dr, dc, Math.hypot(dr, dc)]);
      }
    }
    offsets.sort((a, b) => a[2] - b[2]);

    for (const [dr, dc] of offsets) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) continue;
      const hit = this.candidateAt(pieceId, orientationIndex, grabIndex, boardIndex(r, c));
      if (hit) return hit;
    }
    return null;
  }

  /** The blocked footprint, used to draw red conflict feedback. */
  footprintAt(pieceId, orientationIndex, grabIndex, target) {
    const orientation = PIECE_BY_ID[pieceId].orientations2d[orientationIndex];
    if (!orientation) return [];
    const grab = orientation.cells[Math.min(grabIndex, orientation.cells.length - 1)];
    const originRow = boardRow(target) - grab[0];
    const originCol = boardCol(target) - grab[1];
    return orientation.cells
      .map(([r, c]) => [originRow + r, originCol + c])
      .filter(([r, c]) => r >= 0 && r < BOARD_ROWS && c >= 0 && c < BOARD_COLS)
      .map(([r, c]) => boardIndex(r, c));
  }

  cellFromPoint(clientX, clientY) {
    const node = document.elementFromPoint(clientX, clientY);
    const bead = node?.closest?.('.bead');
    if (!bead || !this.grid.contains(bead)) return null;
    return Number(bead.dataset.index);
  }

  /* ------------------------------------------------------------ dragging -- */

  /**
   * Begin a drag. Called from the board (lifting a placed piece) and from the
   * tray (dragging a fresh piece in).
   */
  beginDrag({ pieceId, orientationIndex, grabIndex, pointerId, clientX, clientY, origin }) {
    this.#endDrag();
    const piece = PIECE_BY_ID[pieceId];
    const orientation = piece.orientations2d[orientationIndex] || piece.orientations2d[0];

    // §5.2 — offset the floating piece above the finger so it never hides the
    // sockets it is about to fill, and magnify it slightly.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const bead = this.#beadSize();
    const floater = h('div', {
      class: 'floater',
      style: {
        gridTemplateColumns: `repeat(${orientation.cols}, ${bead}px)`,
        gridTemplateRows: `repeat(${orientation.rows}, ${bead}px)`,
        gap: `${this.#gapSize()}px`,
        '--c': colorOf(pieceId)
      }
    });
    const filled = new Set(orientation.cells.map(([r, c]) => `${r},${c}`));
    for (let r = 0; r < orientation.rows; r++) {
      for (let c = 0; c < orientation.cols; c++) {
        floater.appendChild(filled.has(`${r},${c}`)
          ? h('i')
          : h('span', { style: { display: 'block' } }));
      }
    }
    document.body.appendChild(floater);

    this.drag = {
      pieceId,
      orientationIndex,
      grabIndex,
      pointerId,
      floater,
      origin,
      placement: null,
      offsetY: coarse ? -Math.round(bead * 1.6) : 0,
      scale: coarse ? 1.12 : 1,
      bead,
      orientation
    };

    window.addEventListener('pointermove', this.#onDragMove, { passive: false });
    window.addEventListener('pointerup', this.#onDragEnd);
    window.addEventListener('pointercancel', this.#onDragEnd);
    this.#moveFloater(clientX, clientY);
    this.#updateDragGhost(clientX, clientY);
  }

  #beadSize() {
    return parseFloat(getComputedStyle(this.grid).getPropertyValue('--bead')) || 26;
  }

  #gapSize() {
    return parseFloat(getComputedStyle(this.grid).getPropertyValue('--gap')) || 3;
  }

  #moveFloater(clientX, clientY) {
    const drag = this.drag;
    if (!drag) return;
    const grab = drag.orientation.cells[Math.min(drag.grabIndex, drag.orientation.cells.length - 1)];
    const step = drag.bead + this.#gapSize();
    // Anchor the floater so the grabbed bead sits under the pointer.
    const left = clientX - (grab[1] + 0.5) * step;
    const top = clientY + drag.offsetY - (grab[0] + 0.5) * step;
    drag.floater.style.transform = `translate(${left}px, ${top}px) scale(${drag.scale})`;
    drag.floater.style.transformOrigin = `${(grab[1] + 0.5) * step}px ${(grab[0] + 0.5) * step}px`;
  }

  #onDragMove = (event) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    this.#moveFloater(event.clientX, event.clientY);
    this.#updateDragGhost(event.clientX, event.clientY);
  };

  #updateDragGhost(clientX, clientY) {
    const drag = this.drag;
    if (!drag) return;
    const target = this.cellFromPoint(clientX, clientY + drag.offsetY);
    if (target === null) {
      drag.placement = null;
      this.clearGhost();
      return;
    }
    const placement = this.findPlacement(drag.pieceId, drag.orientationIndex, drag.grabIndex, target);
    drag.placement = placement;
    if (placement) {
      this.setGhost(placement.cells, { piece: drag.pieceId });
    } else {
      // §3.2 — overlapping or out of bounds shows conflict feedback, no snap.
      this.setGhost(this.footprintAt(drag.pieceId, drag.orientationIndex, drag.grabIndex, target),
        { conflict: true, piece: drag.pieceId });
    }
  }

  #onDragEnd = (event) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const placement = drag.placement;
    this.#endDrag();
    if (placement) {
      this.config.onPlace?.(placement, { moved: drag.origin === 'board' });
    } else if (drag.origin === 'board') {
      // §3.2 — an invalid release returns the piece to its last legal position.
      this.config.onCancelPickUp?.();
      this.config.onInvalid?.('Not a legal position — the piece went back.');
    } else {
      this.config.onInvalid?.('No legal spot there.');
    }
  };

  #endDrag() {
    if (!this.drag) return;
    this.drag.floater.remove();
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragEnd);
    window.removeEventListener('pointercancel', this.#onDragEnd);
    this.drag = null;
    this.clearGhost();
  }

  /* -------------------------------------------------------------- pointer - */

  #onPointerDown = (event) => {
    const bead = event.target.closest('.bead');
    if (!bead) return;
    const index = Number(bead.dataset.index);
    this.#setCursor(index);

    const owner = this.session.occupancy()[index];

    // Lift a piece the player placed: it becomes a drag in progress. The piece
    // comes off the board unrecorded, so a cancelled drag leaves no trace.
    if (owner && !owner.locked) {
      const entry = this.session.placed.find((p) => p.piece === owner.piece);
      const grabIndex = Math.max(0, entry.cells.indexOf(index));
      const orientation = entry.orientation;
      this.config.onPickUp?.(owner.piece);
      event.preventDefault();
      this.beginDrag({
        pieceId: owner.piece,
        orientationIndex: orientation,
        grabIndex,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        origin: 'board'
      });
      return;
    }

    if (owner?.locked) {
      // §3.2 — locked setup pieces ignore drag input entirely.
      this.config.onInvalid?.(`Piece ${owner.piece} is part of the setup and cannot move.`);
      return;
    }

    // Empty socket: tap-place the current selection.
    const selection = this.config.getSelection?.();
    if (!selection) return;
    event.preventDefault();
    this.#tapPlace(selection, index);
  };

  /**
   * Tap-place keeps the chosen orientation: it only tries the other anchor
   * cells of that same shape, so Rotate stays an explicit action.
   */
  #tapPlace(selection, index) {
    const piece = PIECE_BY_ID[selection.pieceId];
    const orientation = piece.orientations2d[selection.orientationIndex];
    for (let grab = 0; grab < orientation.cells.length; grab++) {
      const placement = this.candidateAt(selection.pieceId, selection.orientationIndex, grab, index);
      if (placement) { this.config.onPlace?.(placement); return; }
    }
    const snapped = this.findPlacement(selection.pieceId, selection.orientationIndex, 0, index);
    if (snapped) { this.config.onPlace?.(snapped); return; }
    this.config.onInvalid?.(`Piece ${selection.pieceId} does not fit there in this orientation.`);
  }

  /* ------------------------------------------------------------- keyboard - */

  #setCursor(index, { focus = true } = {}) {
    if (index === this.cursor) {
      if (focus) this.beads[index].focus();
      return;
    }
    this.cursor = index;
    this.refresh();
    if (focus) this.beads[index].focus();
    this.#previewAtCursor();
  }

  /** §5.1 — arrow keys move a ghost, Enter/Space drops. */
  #previewAtCursor() {
    const selection = this.config.getSelection?.();
    if (!selection) { this.clearGhost(); return; }
    const placement = this.findPlacement(selection.pieceId, selection.orientationIndex, 0, this.cursor, { snap: false });
    if (placement) this.setGhost(placement.cells, { piece: selection.pieceId });
    else this.setGhost(this.footprintAt(selection.pieceId, selection.orientationIndex, 0, this.cursor),
      { conflict: true, piece: selection.pieceId });
  }

  refreshCursorPreview() {
    if (document.activeElement && this.grid.contains(document.activeElement)) this.#previewAtCursor();
  }

  #onKeyDown = (event) => {
    const row = boardRow(this.cursor);
    const col = boardCol(this.cursor);
    let next = null;

    switch (event.key) {
      case 'ArrowUp': next = boardIndex(Math.max(0, row - 1), col); break;
      case 'ArrowDown': next = boardIndex(Math.min(BOARD_ROWS - 1, row + 1), col); break;
      case 'ArrowLeft': next = boardIndex(row, Math.max(0, col - 1)); break;
      case 'ArrowRight': next = boardIndex(row, Math.min(BOARD_COLS - 1, col + 1)); break;
      case 'Home': next = boardIndex(row, 0); break;
      case 'End': next = boardIndex(row, BOARD_COLS - 1); break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const owner = this.session.occupancy()[this.cursor];
        if (owner && !owner.locked) {
          this.config.onLift?.(owner.piece, { restore: false });
          announce(`Piece ${owner.piece} lifted back to the tray.`);
        } else if (owner?.locked) {
          this.config.onInvalid?.(`Piece ${owner.piece} is part of the setup and cannot move.`);
        } else {
          const selection = this.config.getSelection?.();
          if (selection) this.#tapPlace(selection, this.cursor);
          else this.config.onInvalid?.('Select a piece from the tray first.');
        }
        return;
      }
      default: return;
    }

    event.preventDefault();
    this.#setCursor(next);
  };
}
