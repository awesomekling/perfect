// User-curated marks: a set of "interesting" functions each painted with a
// color from a fixed palette. Drives the marks sidebar, the per-sample color
// used to paint the timeline lanes, and the colored dot in tree rows.
//
// Marks are persisted to localStorage and keyed on (symbol, dso-basename) —
// not fid, which is profile-local. So a mark on Heap::collect_garbage
// survives reloads and re-recordings of the same program.
//
// The "innermost wins" rule is encoded in `sampleColorIdx()` — for each
// sample we walk the stack inner→outer (its native order) and stop at the
// first marked frame.

// Mark palette. Hue-spread to be visually distinct on the dark background,
// and deliberately omits two reserved colors:
//   - #4ea1ff (the accent blue) — every timeline lane is painted with this,
//     so a mark in that color would be invisible against its own lane.
//   - #ffd24e (warning yellow) — used by the hover highlight on the timeline.
// Pure blue/cyan and pure yellow are skipped wholesale to avoid look-alikes.
export const PALETTE = [
  "#ef4444", // red
  "#f97316", // orange
  "#22c55e", // green
  "#14b8a6", // teal
  "#a855f7", // violet
  "#ec4899", // pink
  "#84cc16", // lime
  "#d946ef", // magenta
  "#a16207", // brown
  "#f1f5f9", // off-white
];

const STORAGE_KEY = "perfect.marks.v1";

// Specs that don't resolve to any fid in the current profile are kept around
// (so switching to a different profile doesn't drop them) — joined back into
// `byFid` next time a profile that *does* contain that symbol gets loaded.

export class Marks {
  constructor(profile) {
    this.profile = profile;
    this.byFid = new Map();          // fid -> { color, paletteIdx, specIdx }
    this.specs = [];                 // [{ sym, dso, paletteIdx }] — source of truth
    this._sampleColorIdx = null;     // Uint8Array, 0 = unmarked, else paletteIdx+1
    this.onChange = null;
    this._loadFromStorage();
  }

  size() { return this.byFid.size; }
  has(fid) { return this.byFid.has(fid); }
  get(fid) { return this.byFid.get(fid) || null; }
  color(fid) { const m = this.byFid.get(fid); return m ? m.color : null; }

  // Iteration order = insertion order on `specs`; the sidebar relies on
  // this so newly-marked rows append at the bottom across reloads too.
  list() {
    const out = [];
    for (const s of this.specs) {
      const fid = this._symKeyToFid().get(makeKey(s.sym, s.dso));
      if (fid === undefined) continue;
      out.push({ fid, sym: s.sym, dso: s.dso, color: PALETTE[s.paletteIdx], paletteIdx: s.paletteIdx });
    }
    return out;
  }

  toggle(fid) {
    if (this.byFid.has(fid)) this.remove(fid);
    else this.add(fid);
  }

  add(fid) {
    if (this.byFid.has(fid)) return;
    const sym = this.profile.funcLabel(fid);
    const dso = this.profile.funcDsoShort(fid);
    // If a spec for this sym+dso already exists from a previous session,
    // adopt its color rather than picking a fresh palette slot.
    const existingIdx = this.specs.findIndex((s) => s.sym === sym && s.dso === dso);
    let paletteIdx;
    if (existingIdx >= 0) {
      paletteIdx = this.specs[existingIdx].paletteIdx;
    } else {
      paletteIdx = this._nextPaletteIdx();
      this.specs.push({ sym, dso, paletteIdx });
    }
    this.byFid.set(fid, { color: PALETTE[paletteIdx], paletteIdx });
    this._invalidate();
  }

  remove(fid) {
    const m = this.byFid.get(fid);
    if (!m) return;
    const sym = this.profile.funcLabel(fid);
    const dso = this.profile.funcDsoShort(fid);
    const idx = this.specs.findIndex((s) => s.sym === sym && s.dso === dso);
    if (idx >= 0) this.specs.splice(idx, 1);
    this.byFid.delete(fid);
    this._invalidate();
  }

  setColor(fid, paletteIdx) {
    const m = this.byFid.get(fid);
    if (!m) return;
    if (m.paletteIdx === paletteIdx) return;
    m.paletteIdx = paletteIdx;
    m.color = PALETTE[paletteIdx];
    const sym = this.profile.funcLabel(fid);
    const dso = this.profile.funcDsoShort(fid);
    const spec = this.specs.find((s) => s.sym === sym && s.dso === dso);
    if (spec) spec.paletteIdx = paletteIdx;
    this._invalidate();
  }

  // Pick a palette slot not in use yet; once all 10 are used, cycle.
  _nextPaletteIdx() {
    const used = new Set();
    for (const s of this.specs) used.add(s.paletteIdx);
    for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) return i;
    return this.specs.length % PALETTE.length;
  }

  // Per-sample mark color, derived from the current mark set. 0 means the
  // sample has no marked frame; otherwise paletteIdx+1 of the *innermost*
  // marked frame in its stack. Computed lazily and cached until marks change.
  sampleColorIdx() {
    if (this._sampleColorIdx) return this._sampleColorIdx;
    const { stackOffsets, stackFrames, times } = this.profile.samples;
    const arr = new Uint8Array(times.length);
    if (this.byFid.size > 0) {
      // Tight inner loop; resolving Map lookups against a flat dense array
      // keyed on fid is much faster than Map.get per frame.
      const F = this.profile.functions.length;
      const fidToColor = new Uint8Array(F); // 0 = unmarked
      for (const [fid, m] of this.byFid) {
        if (fid >= 0 && fid < F) fidToColor[fid] = m.paletteIdx + 1;
      }
      for (let i = 0; i < times.length; i++) {
        const off = stackOffsets[i];
        const end = stackOffsets[i + 1];
        // stackFrames is innermost→outermost — first hit is the innermost.
        for (let j = off; j < end; j++) {
          const c = fidToColor[stackFrames[j]];
          if (c !== 0) { arr[i] = c; break; }
        }
      }
    }
    this._sampleColorIdx = arr;
    return arr;
  }

  _symKeyToFid() {
    if (this._symKeyCache) return this._symKeyCache;
    const out = new Map();
    const { functions } = this.profile;
    for (let fid = 0; fid < functions.length; fid++) {
      const key = makeKey(this.profile.funcLabel(fid), this.profile.funcDsoShort(fid));
      // First wins: in the rare case of duplicate (sym, dso) pairs we mark
      // the first matching fid. Either is fine for the user's narrative.
      if (!out.has(key)) out.set(key, fid);
    }
    this._symKeyCache = out;
    return out;
  }

  _loadFromStorage() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return; }
    if (!raw) return;
    let arr;
    try { arr = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(arr)) return;
    const N = PALETTE.length;
    this.specs = arr
      .filter((x) => x && typeof x.sym === "string" && typeof x.dso === "string" && Number.isInteger(x.paletteIdx))
      .map((x) => ({ sym: x.sym, dso: x.dso, paletteIdx: ((x.paletteIdx % N) + N) % N }));
    // Resolve specs that exist in this profile to fids.
    const lookup = this._symKeyToFid();
    for (const s of this.specs) {
      const fid = lookup.get(makeKey(s.sym, s.dso));
      if (fid !== undefined) {
        this.byFid.set(fid, { color: PALETTE[s.paletteIdx], paletteIdx: s.paletteIdx });
      }
    }
  }

  _saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.specs)); } catch {}
  }

  _invalidate() {
    this._sampleColorIdx = null;
    this._saveToStorage();
    if (this.onChange) this.onChange();
  }
}

function makeKey(sym, dso) {
  // \u0001 is unlikely to appear in any symbol or dso name and gives an
  // unambiguous separator between the two halves of the key.
  return `${sym}\u0001${dso}`;
}
