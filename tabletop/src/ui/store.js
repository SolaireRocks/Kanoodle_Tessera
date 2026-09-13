/**
 * Local-first storage for the tabletop logbook.
 *
 * One object in localStorage holds the display settings and every opening ever
 * rolled, each with the times typed in against it. Nothing here talks to a
 * network — the whole site is static files, so this device is the only place
 * the log exists. That is exactly why `toBackup` / `fromBackup` are first-class
 * rather than an afterthought: export is the only backup there is.
 */

const KEY = 'tessera.tabletop.v1';
export const LOG_VERSION = 1;

export const PALETTE_KEYS = ['ARENA', 'MUTED', 'DEUTER'];

/** A logbook is a long tail by nature; it is not a recent-runs list. */
const MAX_SETUPS = 250;

const DEFAULT_SETTINGS = {
  palette: 'ARENA',
  highContrast: false,
  reduceMotion: false
};

function blank() {
  return {
    version: LOG_VERSION,
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    setups: []
  };
}

/** Accept only what we wrote; anything else is treated as a fresh install. */
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    if (parsed.version !== LOG_VERSION) return blank();
    return {
      ...blank(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      setups: Array.isArray(parsed.setups) ? parsed.setups.map(normalizeSetup).filter(Boolean) : []
    };
  } catch {
    return blank();
  }
}

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

/**
 * Coerce one entry into the shape the UI expects. Imported files come through
 * here too, so a hand-edited or half-truncated export cannot wedge the app.
 */
function normalizeSetup(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const locked = Array.isArray(entry.locked)
    ? entry.locked
      .filter((p) => p && typeof p.piece === 'string' && Array.isArray(p.cells))
      .map((p) => ({ piece: p.piece, cells: p.cells.map(Number).filter(Number.isInteger) }))
    : [];
  if (!locked.length) return null;
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : newId('tt'),
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    dimension: entry.dimension === '3D' ? '3D' : '2D',
    locked,
    code: typeof entry.code === 'string' ? entry.code : '',
    seed: entry.seed || null,
    pinned: Array.isArray(entry.pinned) ? entry.pinned.filter((id) => typeof id === 'string') : [],
    label: entry.label || null,
    note: typeof entry.note === 'string' ? entry.note.slice(0, 240) : '',
    times: Array.isArray(entry.times)
      ? entry.times
        .filter((t) => t && Number.isFinite(t.ms) && t.ms > 0)
        .map((t, i) => ({
          id: typeof t.id === 'string' && t.id ? t.id : `t-${Date.now().toString(36)}-${i}`,
          ms: Math.round(t.ms),
          at: Number.isFinite(t.at) ? t.at : Date.now(),
          assisted: Boolean(t.assisted)
        }))
      : []
  };
}

class Store extends EventTarget {
  constructor() {
    super();
    this.data = read();
    this.writeFailed = false;
    this.applyDocumentSettings();
  }

  get settings() { return this.data.settings; }
  get setups() { return this.data.setups; }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
      this.writeFailed = false;
    } catch {
      // Private mode, or a full quota. The session keeps working in memory; the
      // banner in the header is what tells the player to export before leaving.
      this.writeFailed = true;
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** The settings the stylesheet reads off <html>. */
  applyDocumentSettings() {
    const root = document.documentElement;
    root.dataset.palette = this.settings.palette;
    root.dataset.highContrast = this.settings.highContrast ? 'on' : 'off';
    root.dataset.reduceMotion = this.settings.reduceMotion ? 'on' : 'off';
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.applyDocumentSettings();
    this.save();
  }

  /* ------------------------------------------------------------- openings - */

  setup(id) {
    return this.data.setups.find((entry) => entry.id === id) || null;
  }

  /**
   * Save a rolled opening. An existing entry with the same challenge code is
   * reused and floated to the top, so re-rolling the same seed adds to one run
   * of times rather than splitting them across two entries.
   */
  saveSetup(setup) {
    const existing = setup.code && this.data.setups.find((entry) => entry.code === setup.code);
    if (existing) {
      this.data.setups = [existing, ...this.data.setups.filter((e) => e !== existing)];
      this.save();
      return existing;
    }
    const entry = normalizeSetup({
      ...setup,
      id: newId('tt'),
      createdAt: Date.now(),
      note: '',
      times: []
    });
    this.data.setups.unshift(entry);
    if (this.data.setups.length > MAX_SETUPS) this.data.setups.length = MAX_SETUPS;
    this.save();
    return entry;
  }

  removeSetup(id) {
    const before = this.data.setups.length;
    this.data.setups = this.data.setups.filter((entry) => entry.id !== id);
    if (this.data.setups.length !== before) this.save();
  }

  setNote(id, note) {
    const entry = this.setup(id);
    if (!entry) return null;
    entry.note = String(note || '').slice(0, 240);
    this.save();
    return entry;
  }

  setLabel(id, label) {
    const entry = this.setup(id);
    if (!entry) return null;
    const trimmed = String(label || '').trim().slice(0, 60);
    entry.label = trimmed || null;
    this.save();
    return entry;
  }

  /* ---------------------------------------------------------------- times - */

  addTime(id, ms, { assisted = false, at = Date.now() } = {}) {
    const entry = this.setup(id);
    if (!entry || !Number.isFinite(ms) || ms <= 0) return null;
    const time = {
      id: `t-${Date.now().toString(36)}-${entry.times.length}`,
      ms: Math.round(ms),
      at,
      assisted: Boolean(assisted)
    };
    entry.times.push(time);
    this.save();
    return time;
  }

  removeTime(id, timeId) {
    const entry = this.setup(id);
    if (!entry) return;
    const before = entry.times.length;
    entry.times = entry.times.filter((time) => time.id !== timeId);
    if (entry.times.length !== before) this.save();
  }

  /* -------------------------------------------------------------- digests - */

  /** Headline numbers across the whole logbook. */
  summary() {
    let attempts = 0;
    let solvedOpenings = 0;
    let bestMs = null;
    let totalMs = 0;
    for (const entry of this.data.setups) {
      if (entry.times.length) solvedOpenings += 1;
      for (const time of entry.times) {
        attempts += 1;
        totalMs += time.ms;
        if (!time.assisted && (bestMs === null || time.ms < bestMs)) bestMs = time.ms;
      }
    }
    return { openings: this.data.setups.length, solvedOpenings, attempts, bestMs, totalMs };
  }

  /* --------------------------------------------------------------- backup - */

  /** Everything, in the shape `fromBackup` reads. */
  toBackup() {
    return {
      format: 'tessera-tabletop-log',
      version: LOG_VERSION,
      exportedAt: new Date().toISOString(),
      settings: { ...this.settings },
      setups: this.data.setups
    };
  }

  /**
   * Read an exported file back in.
   *
   * `merge` keeps what is already here and adds anything whose challenge code
   * is new, folding times into an opening that is already logged; `replace`
   * swaps the whole logbook for the file. Returns a small report, so the UI can
   * say what actually happened rather than just "done".
   */
  fromBackup(payload, { mode = 'merge' } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('That file is not a logbook export.');
    if (payload.format && payload.format !== 'tessera-tabletop-log') {
      throw new Error('That file is not a Tessera tabletop export.');
    }
    const incoming = (Array.isArray(payload.setups) ? payload.setups : [])
      .map(normalizeSetup)
      .filter(Boolean);
    if (!incoming.length) throw new Error('No openings were found in that file.');

    if (mode === 'replace') {
      this.data.setups = incoming.slice(0, MAX_SETUPS);
      if (payload.settings) this.data.settings = { ...DEFAULT_SETTINGS, ...payload.settings };
      this.applyDocumentSettings();
      this.save();
      return {
        mode,
        addedSetups: this.data.setups.length,
        addedTimes: this.data.setups.reduce((n, e) => n + e.times.length, 0)
      };
    }

    let addedSetups = 0;
    let addedTimes = 0;
    for (const entry of incoming) {
      const match = entry.code
        ? this.data.setups.find((e) => e.code === entry.code)
        : this.data.setups.find((e) => e.id === entry.id);
      if (!match) {
        this.data.setups.push(entry);
        addedSetups += 1;
        addedTimes += entry.times.length;
        continue;
      }
      // The same opening solved on two devices: keep every attempt exactly
      // once. A time is the same attempt when it was recorded at the same
      // instant with the same reading — two genuine solves never collide on
      // both.
      const seen = new Set(match.times.map((t) => `${t.ms}@${t.at}`));
      for (const time of entry.times) {
        const fingerprint = `${time.ms}@${time.at}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        match.times.push({ ...time, id: `t-${time.at.toString(36)}-${match.times.length}` });
        addedTimes += 1;
      }
      match.times.sort((a, b) => a.at - b.at);
      if (!match.note && entry.note) match.note = entry.note;
    }
    this.data.setups.sort((a, b) => b.createdAt - a.createdAt);
    if (this.data.setups.length > MAX_SETUPS) this.data.setups.length = MAX_SETUPS;
    this.save();
    return { mode, addedSetups, addedTimes };
  }

  /** Wipe the logbook, keeping the display settings. */
  clear() {
    const settings = { ...this.settings };
    this.data = blank();
    this.data.settings = settings;
    this.applyDocumentSettings();
    this.save();
  }
}

export const store = new Store();
