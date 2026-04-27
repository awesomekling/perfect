// User-curated marks: a set of "interesting" function ids each painted with a
// color from a fixed palette. Drives the marks sidebar, the per-sample color
// used to paint the timeline lanes, and the colored dot in tree rows.
//
// The "innermost wins" rule is encoded in `sampleColorIdx()` — for each
// sample we walk the stack inner→outer (its native order) and stop at the
// first marked frame.

export const PALETTE = [
  "#ff6b9d", // magenta
  "#ff7a59", // orange
  "#ffd24e", // yellow
  "#a4ce5a", // lime
  "#7ad991", // green
  "#5ce0d4", // teal
  "#4ea1ff", // blue
  "#9aa5ff", // periwinkle
  "#c08fff", // purple
  "#e8e8ea", // off-white
];

export class Marks {
  constructor(profile) {
    this.profile = profile;
    this.byFid = new Map(); // fid -> { color, paletteIdx }
    this._sampleColorIdx = null; // Uint8Array, 0 = unmarked, else paletteIdx+1
    this.onChange = null;
  }

  size() { return this.byFid.size; }
  has(fid) { return this.byFid.has(fid); }
  get(fid) { return this.byFid.get(fid) || null; }
  color(fid) { const m = this.byFid.get(fid); return m ? m.color : null; }

  // Iteration order = insertion order (Map semantics); the sidebar relies on
  // this so newly-marked rows append at the bottom.
  list() {
    const out = [];
    for (const [fid, m] of this.byFid) out.push({ fid, color: m.color, paletteIdx: m.paletteIdx });
    return out;
  }

  toggle(fid) {
    if (this.byFid.has(fid)) this.remove(fid);
    else this.add(fid);
  }

  add(fid) {
    if (this.byFid.has(fid)) return;
    const idx = this._nextPaletteIdx();
    this.byFid.set(fid, { color: PALETTE[idx], paletteIdx: idx });
    this._invalidate();
  }

  remove(fid) {
    if (!this.byFid.delete(fid)) return;
    this._invalidate();
  }

  setColor(fid, paletteIdx) {
    const m = this.byFid.get(fid);
    if (!m) return;
    if (m.paletteIdx === paletteIdx) return;
    m.paletteIdx = paletteIdx;
    m.color = PALETTE[paletteIdx];
    this._invalidate();
  }

  // Pick a palette slot not in use yet; once all 10 are used, cycle.
  _nextPaletteIdx() {
    const used = new Set();
    for (const m of this.byFid.values()) used.add(m.paletteIdx);
    for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) return i;
    return this.byFid.size % PALETTE.length;
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

  _invalidate() {
    this._sampleColorIdx = null;
    if (this.onChange) this.onChange();
  }
}
