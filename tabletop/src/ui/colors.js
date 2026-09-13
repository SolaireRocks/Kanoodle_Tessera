/**
 * Piece colour, resolved through whichever palette is selected.
 *
 * Colour is always a second channel on this site and never the only one — the
 * sheet letters every bead — so a palette swap changes the look without
 * changing what can be read off the page.
 */

import { pieceColor } from '../core/pieces.js';
import { store } from './store.js';

export const colorOf = (pieceId) => pieceColor(pieceId, store.settings.palette);
