// Client-side profile model. Wraps the JSON the server returns.
// The big arrays (samples.times, .tids, .stackOffsets, .stackFrames) are
// converted to typed arrays once here.

export class Profile {
  constructor(json) {
    this.meta = json.meta;
    this.threads = json.threads; // [{tid, comms:[{name,fromNs,toNs}]}]
    this.strings = json.strings;
    this.dsos = json.dsos;
    this.functions = json.functions; // [{sym,dso}]
    const s = json.samples;
    // Per-kind weight columns (heaptrack profiles carry several: allocated,
    // leaked, temporary, alloc-count). The currently-active column gets
    // mirrored onto `samples.weights` so analysis.js stays oblivious to the
    // multi-kind machinery — switching the active kind just rewrites that
    // pointer and fires onWeightKindChange.
    const weightsByKind = {};
    if (s.weightsByKind) {
      for (const [kind, arr] of Object.entries(s.weightsByKind)) {
        weightsByKind[kind] = new Float64Array(arr);
      }
    } else if (s.weights) {
      // Single-column profile (legacy or perf): wrap into the one-kind map.
      weightsByKind[this.meta.weightKind || "samples"] = new Float64Array(s.weights);
    }
    this.samples = {
      times: new Float64Array(s.times),
      tids: new Int32Array(s.tids),
      stackOffsets: new Uint32Array(s.stackOffsets),
      stackFrames: new Uint32Array(s.stackFrames),
      // The active weight column. Replaced by setActiveWeightKind(); kept
      // null when there are no weights at all (perf path).
      weights: null,
      _byKind: weightsByKind,
    };
    this.startNs = this.meta.startNs;
    this.endNs = this.meta.endNs;
    this.durationNs = this.endNs - this.startNs;
    this.sampleCount = this.samples.times.length;
    // For frequency-based sampling (`perf record -F N`), each sample roughly
    // represents 1/N seconds of on-CPU time.
    this.nsPerSample = this.meta.sampleFreq > 0 ? 1e9 / this.meta.sampleFreq : 0;
    this.timeKnown = this.nsPerSample > 0;
    // Weighted profiles (e.g. heaptrack) sum sample weights instead of
    // counting samples. weightKind drives unit labels in the UI.
    this.weightKinds = this.meta.weightKinds || null;  // [{kind,label,unit}] or null
    this.weighted = Object.keys(weightsByKind).length > 0;
    this.onWeightKindChange = null; // (newKind) => void, set by app.js
    this.setActiveWeightKind(this.meta.weightKind || "samples");
    // Optional process-RSS-over-time series, used as a timeline overlay.
    this.rssSeries = json.rssSeries
      ? { times: new Float64Array(json.rssSeries.times), bytes: new Float64Array(json.rssSeries.bytes) }
      : null;

    // index threads by tid
    this.threadByTid = new Map();
    for (const t of this.threads) this.threadByTid.set(t.tid, t);

    // Determine a "primary" comm per thread (longest active interval).
    for (const t of this.threads) {
      let best = t.comms[0];
      let bestLen = -1;
      for (const c of t.comms) {
        const len = c.toNs - c.fromNs;
        if (len > bestLen) { bestLen = len; best = c; }
      }
      t.primaryComm = best ? best.name : `tid ${t.tid}`;
    }
  }

  funcLabel(fid) {
    const f = this.functions[fid];
    return this.strings[f.sym];
  }

  funcDso(fid) {
    const f = this.functions[fid];
    return this.dsos[f.dso];
  }

  funcDsoShort(fid) {
    const d = this.funcDso(fid);
    if (d === "[unknown]" || d === "(inlined)") return d;
    const idx = d.lastIndexOf("/");
    return idx >= 0 ? d.slice(idx + 1) : d;
  }

  // Source-file path of a function frame, or null if unknown. Heaptrack
  // includes this on every IP frame; perf doesn't, so the perf path
  // returns null.
  funcFile(fid) {
    const f = this.functions[fid];
    return f && f.file ? this.strings[f.file] : null;
  }

  // Just the basename of funcFile(), for inline display. Same null-handling.
  funcFileShort(fid) {
    const p = this.funcFile(fid);
    if (!p) return null;
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }

  isUnknown(fid) {
    return this.funcLabel(fid) === "[unknown]";
  }

  // Switch the active weight column. analysis.js reads
  // `profile.samples.weights` directly, so we just rewrite that pointer.
  // Fires onWeightKindChange so the UI can refresh its views.
  setActiveWeightKind(kind) {
    if (kind === this.weightKind) return;
    const arr = this.samples._byKind[kind];
    if (!arr) {
      // Unknown kind: don't change anything, but keep the metadata fields
      // pointing at the requested label so the UI can still display "no
      // data" sensibly.
      this.weightKind = kind;
      this.weightLabel = "samples";
      this.samples.weights = null;
      if (this.onWeightKindChange) this.onWeightKindChange(kind);
      return;
    }
    this.weightKind = kind;
    const desc = this.weightKinds && this.weightKinds.find((k) => k.kind === kind);
    this.weightLabel = desc ? desc.unit : (this.meta.weightLabel || "samples");
    this.samples.weights = arr;
    if (this.onWeightKindChange) this.onWeightKindChange(kind);
  }

  // Iterate sample indices that fall in [startNs, endNs] and whose tid is in tidSet (or null=all).
  forEachSample(startNs, endNs, tidSet, cb) {
    const { times, tids, stackOffsets, stackFrames } = this.samples;
    const lo = lowerBound(times, startNs);
    const hi = upperBound(times, endNs);
    for (let i = lo; i < hi; i++) {
      if (tidSet && !tidSet.has(tids[i])) continue;
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      cb(i, stackFrames, off, end);
    }
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function fmtMs(ns) {
  const ms = ns / 1e6;
  if (ms < 1) return `${(ns / 1e3).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
// Compact time formatter for tight columns: 12.3s, 482ms, 18.4ms, 873µs.
export function fmtTimeShort(ns) {
  if (!isFinite(ns) || ns <= 0) return "0";
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e7) return `${Math.round(ns / 1e6)} ms`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(1)} ms`;
  if (ns >= 1e4) return `${Math.round(ns / 1e3)} µs`;
  return `${(ns / 1e3).toFixed(1)} µs`;
}

export function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// Format a tree node's total/self in whichever unit the profile is currently
// presenting:
//   - weighted byte metric (heaptrack: allocated/leaked/temporary): fmtBytesShort
//   - weighted count metric (heaptrack: alloc-count):               fmtCount
//   - timeKnown (perf -F N): wall-clock time via fmtTimeShort
//   - otherwise:             raw sample count
// Centralized here so view code can keep its formatting branches shallow,
// and so a metric switcher just reformats without per-call branching.
export function fmtNodeWeight(profile, n) {
  if (profile.weighted) {
    return profile.weightLabel === "count" ? fmtCount(n) : fmtBytesShort(n);
  }
  if (profile.timeKnown) return fmtTimeShort(n * profile.nsPerSample);
  return n.toLocaleString();
}

// Long-form too, for tooltips: includes the raw underlying number alongside
// the formatted value so the user can confirm what's being shown.
export function fmtNodeWeightLong(profile, n) {
  if (profile.weighted) {
    if (profile.weightLabel === "count") return `${fmtCount(n)} allocations (${Math.round(n).toLocaleString()})`;
    return `${fmtBytesShort(n)} (${Math.round(n).toLocaleString()} B)`;
  }
  if (profile.timeKnown) return `${n.toLocaleString()} samples · ${fmtTimeShort(n * profile.nsPerSample)}`;
  return `${n.toLocaleString()} samples`;
}

// Compact byte formatter for weighted (heaptrack) profiles. Mirrors
// fmtTimeShort's "fits in a tight column" feel.
export function fmtBytesShort(b) {
  if (!isFinite(b) || b <= 0) return "0";
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e10) return `${Math.round(b / 1e9)} GB`;
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e7)  return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e4)  return `${Math.round(b / 1e3)} kB`;
  if (b >= 1e3)  return `${(b / 1e3).toFixed(1)} kB`;
  return `${Math.round(b)} B`;
}

export function fmtPct(part, total) {
  if (!total) return "0.0%";
  return `${(100 * part / total).toFixed(1)}%`;
}
