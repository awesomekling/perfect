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
    this.samples = {
      times: new Float64Array(s.times),
      tids: new Int32Array(s.tids),
      stackOffsets: new Uint32Array(s.stackOffsets),
      stackFrames: new Uint32Array(s.stackFrames),
    };
    this.startNs = this.meta.startNs;
    this.endNs = this.meta.endNs;
    this.durationNs = this.endNs - this.startNs;
    this.sampleCount = this.samples.times.length;
    // For frequency-based sampling (`perf record -F N`), each sample roughly
    // represents 1/N seconds of on-CPU time.
    this.nsPerSample = this.meta.sampleFreq > 0 ? 1e9 / this.meta.sampleFreq : 0;
    this.timeKnown = this.nsPerSample > 0;

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

  isUnknown(fid) {
    return this.funcLabel(fid) === "[unknown]";
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

export function fmtPct(part, total) {
  if (!total) return "0.0%";
  return `${(100 * part / total).toFixed(1)}%`;
}
