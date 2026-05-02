// Parse heaptrack data files into a Profile shape compatible with parse-perf.js.
//
// Heaptrack records every malloc/free, which yields tens of millions of events
// for non-trivial captures. We can't ship that many rows to the browser, so
// we downsample uniformly by event index: keep one alloc out of every `stride`,
// and scale the kept event's weight by `stride` to preserve byte totals.
//
// Output shape mirrors parsePerfData(), with two additions:
//   - samples.weights: Float64Array (bytes per kept allocation × stride)
//   - meta.weightKind = "bytes-allocated", weightLabel = "bytes"
//
// The browser-side analysis path treats absent `weights` as all-1, so the
// perf path is unchanged. With weights present, tree/top/scopes sum bytes
// instead of counting samples.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import path from "node:path";

// Cap kept-sample count regardless of file size. The ceiling is currently
// driven by the wire/parse format: a single JSON-string response above
// ~256MB exceeds V8's string limit on the browser side. Per-sample bytes
// in the encoded JSON are dominated by stackFrames (avg ~40 inline-expanded
// frames × 4 bytes × 4/3 base64 ≈ 220B/sample), and the four weight
// columns add ~50B more, so 500K samples lands around 130MB encoded —
// comfortably parseable. A binary transport would unblock 2-5M; that's
// next.
const TARGET_SAMPLES = 500_000;

// Stream lines from a possibly-compressed heaptrack file. Returns a promise
// that resolves once the input is exhausted.
async function streamLines(absPath, onLine, onTick) {
  const proc = spawnDecoder(absPath);
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    onLine(line);
    if (++lines % 1_000_000 === 0 && onTick) onTick(lines);
  }
  await new Promise((res, rej) => {
    proc.on("close", (code) => code === 0 ? res() : rej(new Error(`decoder exited ${code}`)));
    proc.on("error", rej);
  });
}

function spawnDecoder(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".zst") return spawn("zstd", ["-dc", absPath], { stdio: ["ignore", "pipe", "ignore"] });
  if (ext === ".gz")  return spawn("gzip", ["-dc", absPath], { stdio: ["ignore", "pipe", "ignore"] });
  // Uncompressed (rare for heaptrack but keeps the API uniform).
  return spawn("cat", [absPath], { stdio: ["ignore", "pipe", "ignore"] });
}

// Pass 1: count `+` lines so we know the right downsample stride.
async function countAllocations(absPath, onProgress) {
  let count = 0;
  await streamLines(absPath, (line) => {
    // Cheaper than line[0]==='+': avoid the substring allocation.
    if (line.charCodeAt(0) === 0x2b) count++;
  }, (lines) => onProgress?.({ phase: "count", lines, allocs: count }));
  return count;
}

class HeaptrackParser {
  constructor(meta, stride) {
    this.meta = meta;
    this.stride = stride;

    // Heaptrack interns everything 1-indexed; we mirror that by pre-pushing
    // a null at slot 0 so reader indices line up directly.
    this.htStrings = [""];
    this.htInstructionPointers = [null]; // [{ ip, modIdx, frames: [{funcIdx,fileIdx,line}] }]
    this.htTraces = [null];              // [{ ipId, parentId }]
    this.htAllocInfos = [null];          // [{ size, traceId }]
    this.htDebuggee = "";

    // Output (perfect) tables, 0-indexed.
    this.strings = [];
    this.stringIdx = new Map();
    this.dsos = [];
    this.dsoIdx = new Map();
    this.functions = [];
    // Function identity is (sym, dso, file). Heaptrack's symbolicator can
    // emit the same unqualified name in different source files (e.g.
    // `call::operator()` is 23 different lambdas across LibWeb files for
    // the WebContent capture); without `file` in the key those collapse
    // into one tree row with inflated totals. perf calls this with
    // file=0 (no file info) and the perf path stays unchanged.
    this.functionIdx = new Map(); // string key "sym:dso:file" -> fid

    // For each (allocInfoId), cache the flattened innermost→outermost stack
    // of fids. Many `+` events reference the same alloc info; computing the
    // stack once per info saves a lot of repeated tree walks.
    this._stackCache = new Map();

    // Per-allocation-site running counters, sparse arrays keyed by
    // allocInfoId. Used both to drive per-event metric weights (leaked /
    // temporary) and to compute capture-wide totals at finalize time.
    this.htAllocCounts = [];     // # of `+` events for this site
    this.htFreeCounts = [];      // # of `-` events for this site
    this.htTemporaryCounts = []; // # of `-` events that fired immediately
                                 // after a `+` for the same site (matches
                                 // heaptrack's "temporary allocation" rule)

    // Kept-event records (parallel arrays). We defer materialising the
    // sample arrays until finalize() so we can mark a kept `+` as
    // `temporary` retroactively when its matching `-` arrives.
    this.keptTimeMs = [];
    this.keptAllocInfoId = [];
    this.keptSiteIdx = [];   // 0-indexed position of this `+` within its site
    this.keptTemporary = []; // 0/1, set on the `-` that immediately follows

    // Heaptrack-style temporary detection: a `-` event is temporary iff the
    // event immediately preceding it was a `+` for the same allocInfoId,
    // with no other `+`/`-` in between (other line types don't reset this).
    // _lastAllocInfoSeen tracks the allocInfoId of the most recent `+`;
    // _lastKeptIdx tracks the index in our kept arrays of the most recent
    // kept `+`, or -1 if the most recent `+` was downsampled away (so the
    // following `-` can't mark any kept event as temporary).
    this._lastAllocInfoSeen = 0;
    this._lastKeptIdx = -1;

    // RSS time series for the timeline overlay.
    this.rssTimesNs = [];
    this.rssBytes = [];
    this.pageSize = 4096;

    // Live-heap time series. Counts running (allocated - freed) bytes
    // across ALL events (not just kept), sampled at every `c` clock
    // advance. Bounded by the count of `c` lines (~20K for a 4-minute
    // capture) so it stays small in memory.
    this._currentLiveBytes = 0;
    this.liveTimesNs = [];
    this.liveBytes = [];

    this._allocSeen = 0;
    this._kept = 0;

    this.currentTimeMs = 0;
    this.firstTimeMs = null;
    this.lastTimeMs = 0;
  }

  // ---- internment for the output tables ----
  internString(s) {
    let i = this.stringIdx.get(s);
    if (i === undefined) { i = this.strings.length; this.strings.push(s); this.stringIdx.set(s, i); }
    return i;
  }
  internDso(s) {
    let i = this.dsoIdx.get(s);
    if (i === undefined) { i = this.dsos.length; this.dsos.push(s); this.dsoIdx.set(s, i); }
    return i;
  }
  internFunction(symId, dsoId, fileId = 0) {
    const k = symId + ":" + dsoId + ":" + fileId;
    let i = this.functionIdx.get(k);
    if (i === undefined) {
      i = this.functions.length;
      const rec = { sym: symId, dso: dsoId };
      if (fileId) rec.file = fileId;
      this.functions.push(rec);
      this.functionIdx.set(k, i);
    }
    return i;
  }

  // Tokenize the part of `line` after the "X " type prefix as space-separated
  // hex integers. Heaptrack uses hex everywhere except `c` and `R` payloads
  // (which are also hex per the file format). Decimal token parsing isn't
  // needed for the records we consume.
  static hexTokens(line) {
    const out = [];
    const n = line.length;
    let i = 2; // skip type + space
    let v = 0;
    let inTok = false;
    for (; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c === 0x20) {
        if (inTok) { out.push(v); v = 0; inTok = false; }
        continue;
      }
      let d;
      if      (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      else continue;
      v = v * 16 + d;
      inTok = true;
    }
    if (inTok) out.push(v);
    return out;
  }

  feedLine(line) {
    if (line.length < 2) return;
    const type = line.charCodeAt(0);

    // ---- alloc event (high-frequency, fast path) ----
    if (type === 0x2b /* '+' */) {
      this._allocSeen++;
      const allocInfoId = parseHexFrom(line, 2);
      const info = this.htAllocInfos[allocInfoId];
      // Live-heap counter ticks on EVERY alloc (not just kept ones), so
      // the live-bytes time series reflects the program's true heap shape.
      if (info) this._currentLiveBytes += info.size;
      // Per-site running count, for FIFO leak pairing later.
      const siteIdx = (this.htAllocCounts[allocInfoId] || 0);
      this.htAllocCounts[allocInfoId] = siteIdx + 1;
      // Stride sampling: keep every Nth event. The kept event's weight is
      // scaled by stride at finalize time so capture-wide byte totals are
      // preserved on average.
      const isKept = (this._allocSeen % this.stride === 0)
                     && info != null;
      if (isKept) {
        this.keptTimeMs.push(this.currentTimeMs);
        this.keptAllocInfoId.push(allocInfoId);
        this.keptSiteIdx.push(siteIdx);
        this.keptTemporary.push(0);
        this._lastKeptIdx = this.keptTimeMs.length - 1;
        this._kept++;
      } else {
        // Most-recent + wasn't kept: a subsequent matching - cannot mark
        // any kept event as temporary.
        this._lastKeptIdx = -1;
      }
      this._lastAllocInfoSeen = allocInfoId;
      if (this.firstTimeMs === null) this.firstTimeMs = this.currentTimeMs;
      this.lastTimeMs = this.currentTimeMs;
      return;
    }

    // ---- free event ----
    // Per-site free counter; if the immediately-preceding event was a `+`
    // for the same allocInfoId, this is a "temporary" allocation in
    // heaptrack's sense (alloc never outlived another alloc). When the
    // matching `+` was kept, mark that kept event so finalize emits a
    // nonzero bytes-temporary weight for it.
    if (type === 0x2d /* '-' */) {
      const allocInfoId = parseHexFrom(line, 2);
      const info = this.htAllocInfos[allocInfoId];
      if (info) this._currentLiveBytes -= info.size;
      this.htFreeCounts[allocInfoId] = (this.htFreeCounts[allocInfoId] || 0) + 1;
      if (allocInfoId !== 0 && allocInfoId === this._lastAllocInfoSeen) {
        this.htTemporaryCounts[allocInfoId] = (this.htTemporaryCounts[allocInfoId] || 0) + 1;
        if (this._lastKeptIdx >= 0 && this.keptAllocInfoId[this._lastKeptIdx] === allocInfoId) {
          this.keptTemporary[this._lastKeptIdx] = 1;
        }
      }
      this._lastAllocInfoSeen = 0;
      this._lastKeptIdx = -1;
      return;
    }

    // ---- clock advance ----
    if (type === 0x63 /* 'c' */) {
      this.currentTimeMs = parseHexFrom(line, 2);
      if (this.firstTimeMs === null) this.firstTimeMs = this.currentTimeMs;
      this.lastTimeMs = this.currentTimeMs;
      // Sample the live-heap series at this clock tick. Heaptrack emits
      // `c` lines roughly every 10ms (~85/sec) so this stays a reasonable
      // resolution for a timeline overlay without exploding in size.
      this.liveTimesNs.push(this.currentTimeMs * 1_000_000);
      this.liveBytes.push(this._currentLiveBytes);
      return;
    }

    // ---- RSS sample ----
    if (type === 0x52 /* 'R' */) {
      const pages = parseHexFrom(line, 2);
      this.rssTimesNs.push(this.currentTimeMs * 1_000_000);
      this.rssBytes.push(pages * this.pageSize);
      return;
    }

    // ---- string interning (auto-numbered) ----
    if (type === 0x73 /* 's' */) {
      // "s <hex_len> <string>"; we don't actually need the length since we're
      // line-oriented and strings can't contain newlines.
      const sp = line.indexOf(' ', 2);
      this.htStrings.push(sp >= 0 ? line.slice(sp + 1) : "");
      return;
    }

    // ---- instruction pointer (auto-numbered) ----
    if (type === 0x69 /* 'i' */) {
      const toks = HeaptrackParser.hexTokens(line);
      const ip = toks[0];
      const modIdx = toks[1];
      const frames = [];
      // Triplets after (ip, modIdx) are (funcIdx, fileIdx, line). The first
      // triplet is the IP's primary frame; subsequent triplets are the inline
      // chain in OUTER→INNER order (the heaptrack source pushes them into
      // ip.inlined sequentially while reading). We keep them in file order
      // and reverse when flattening into the per-event stack below.
      for (let j = 2; j + 2 < toks.length; j += 3) {
        frames.push({ funcIdx: toks[j], fileIdx: toks[j + 1], line: toks[j + 2] });
      }
      this.htInstructionPointers.push({ ip, modIdx, frames });
      return;
    }

    // ---- trace tree node (auto-numbered) ----
    if (type === 0x74 /* 't' */) {
      const toks = HeaptrackParser.hexTokens(line);
      this.htTraces.push({ ipId: toks[0] || 0, parentId: toks[1] || 0 });
      return;
    }

    // ---- alloc info template (auto-numbered) ----
    if (type === 0x61 /* 'a' */) {
      const toks = HeaptrackParser.hexTokens(line);
      this.htAllocInfos.push({ size: toks[0] || 0, traceId: toks[1] || 0 });
      return;
    }

    // ---- debuggee command line ----
    if (type === 0x58 /* 'X' */) {
      this.htDebuggee = line.slice(2);
      return;
    }

    // ---- system info: page size + total pages ----
    if (type === 0x49 /* 'I' */) {
      const toks = HeaptrackParser.hexTokens(line);
      if (toks[0]) this.pageSize = toks[0];
      return;
    }

    // Ignore: 'v' (version), 'A' (attach), 'S' (suppressions), '#' (comments).
  }

  // Flatten an alloc info's call stack into a Uint32Array of fids, ordered
  // innermost→outermost (matching the perf parser's convention).
  //
  // Walk: trace tree from leaf upward (parent pointers — heaptrack's tree
  // has parent = "the calling frame", so walking parent pointers goes from
  // the actual leaf trace toward the entry-point trace, which is already
  // the innermost→outermost direction we want).
  //
  // Within one IP, frames in the file are innermost-first: the heaptrack
  // symbolicator sets `ip.frame = scopes.back()` (the deepest inlined
  // subroutine) and pushes `ip.inlined[]` from next-to-innermost outward,
  // ending at the actual subprogram. Iterate in file order so the deepest
  // inlined function lands at the lowest stack index — otherwise self
  // attribution lands on the outer subprogram instead of the real leaf
  // (e.g., `kmalloc` self-bytes get credited to its outer-most caller).
  _stackForAllocInfo(allocInfoId) {
    const cached = this._stackCache.get(allocInfoId);
    if (cached) return cached;
    const info = this.htAllocInfos[allocInfoId];
    const out = [];
    let traceId = info ? info.traceId : 0;
    let depth = 0;
    while (traceId > 0 && depth < 1024) {
      const trace = this.htTraces[traceId];
      if (!trace || trace.ipId === 0) break;
      const ip = this.htInstructionPointers[trace.ipId];
      if (ip) {
        const dsoStr = this.htStrings[ip.modIdx] || "[unknown]";
        const dsoId = this.internDso(dsoStr);
        for (let j = 0; j < ip.frames.length; j++) {
          const f = ip.frames[j];
          const symStr = (f.funcIdx > 0 && this.htStrings[f.funcIdx]) || "[unknown]";
          const symId = this.internString(symStr);
          // File path goes into the function key so two functions with the
          // same unqualified name in different .cpp files don't collapse
          // into one tree row. The string itself is interned in the same
          // table as symbols / dsos — small overhead since most file paths
          // are reused across many frames.
          let fileId = 0;
          if (f.fileIdx > 0 && this.htStrings[f.fileIdx]) {
            fileId = this.internString(this.htStrings[f.fileIdx]);
          }
          out.push(this.internFunction(symId, dsoId, fileId));
        }
      }
      traceId = trace.parentId;
      depth++;
    }
    const arr = Uint32Array.from(out);
    this._stackCache.set(allocInfoId, arr);
    return arr;
  }

  finalize() {
    const startNs = (this.firstTimeMs ?? 0) * 1_000_000;
    const endNs = (this.lastTimeMs ?? 0) * 1_000_000;
    // The debuggee line carries the full command; pull a short comm name for
    // the lane label from the executable's basename.
    const debuggee = this.htDebuggee || "(unknown)";
    const exe = debuggee.split(/\s+/)[0] || "";
    const comm = (exe.split("/").pop() || debuggee).slice(0, 32);

    // Materialise the kept events into the perf-shaped sample arrays. We
    // deferred this so the temporary bit could be marked retroactively by
    // following `-` events.
    const N = this.keptTimeMs.length;
    const sampleTimes = new Float64Array(N);
    const sampleTids = new Int32Array(N);
    const sampleStackOffsets = new Uint32Array(N + 1);
    const sampleStackFramesArr = []; // accumulate, then convert to typed
    const wAllocated = new Float64Array(N);
    const wLeaked = new Float64Array(N);
    const wTemporary = new Float64Array(N);
    const wCount = new Float64Array(N);

    sampleStackOffsets[0] = 0;
    let stackPos = 0;
    for (let i = 0; i < N; i++) {
      const allocInfoId = this.keptAllocInfoId[i];
      const info = this.htAllocInfos[allocInfoId];
      const size = info ? info.size : 0;
      const stack = this._stackForAllocInfo(allocInfoId);
      sampleTimes[i] = this.keptTimeMs[i] * 1_000_000;
      sampleTids[i] = 1;
      for (let j = 0; j < stack.length; j++) sampleStackFramesArr.push(stack[j]);
      stackPos += stack.length;
      sampleStackOffsets[i + 1] = stackPos;

      // FIFO leak pairing: of `allocCount` allocations through this site,
      // the first `freeCount` are paired/freed; the rest leak. We know
      // this kept event was the (siteIdx)-th allocation through its site,
      // so it's leaked iff siteIdx >= freeCount.
      const allocCount = this.htAllocCounts[allocInfoId] || 0;
      const freeCount = this.htFreeCounts[allocInfoId] || 0;
      const siteIdx = this.keptSiteIdx[i];
      const leaked = (siteIdx >= freeCount);
      const sized = size * this.stride;

      wAllocated[i] = sized;
      wLeaked[i] = leaked ? sized : 0;
      wTemporary[i] = this.keptTemporary[i] ? sized : 0;
      wCount[i] = this.stride;
    }

    // Capture-wide totals computed across ALL events (not just kept), for
    // the file-info banner. Less affected by stride sampling than
    // sample-level sums would be.
    let totalAllocatedBytes = 0;
    let totalLeakedBytes = 0;
    let totalTemporaryBytes = 0;
    let totalAllocations = 0;
    const maxSiteId = Math.max(this.htAllocInfos.length, this.htAllocCounts.length);
    for (let id = 1; id < maxSiteId; id++) {
      const info = this.htAllocInfos[id];
      if (!info) continue;
      const ac = this.htAllocCounts[id] || 0;
      const fc = this.htFreeCounts[id] || 0;
      const tc = this.htTemporaryCounts[id] || 0;
      totalAllocatedBytes += ac * info.size;
      totalLeakedBytes += Math.max(0, ac - fc) * info.size;
      totalTemporaryBytes += tc * info.size;
      totalAllocations += ac;
    }

    return {
      meta: {
        ...this.meta,
        // The active default. Profile lets the UI flip among
        // weightsByKind without a reload.
        weightKind: "bytes-allocated",
        weightLabel: "bytes",
        // What kinds the profile carries, in display order. Drives the UI's
        // metric-switcher dropdown.
        weightKinds: [
          { kind: "bytes-allocated", label: "Allocated bytes",  unit: "bytes" },
          { kind: "bytes-leaked",    label: "Leaked bytes",     unit: "bytes" },
          { kind: "bytes-temporary", label: "Temporary bytes",  unit: "bytes" },
          { kind: "alloc-count",     label: "Allocation count", unit: "count" },
        ],
        debuggee,
        startNs,
        endNs,
        sampleCount: N,
        downsampleStride: this.stride,
        totalAllocations,
        totalAllocated: totalAllocatedBytes,
        totalLeaked: totalLeakedBytes,
        totalTemporary: totalTemporaryBytes,
        // Heaptrack doesn't have a meaningful "Hz" — leave sampleFreq 0 so
        // Profile.timeKnown stays false and the UI doesn't render bogus
        // "X ms on-CPU" stats. We still ship per-event timestamps so the
        // timeline can show density.
        sampleFreq: 0,
        eventName: "malloc",
      },
      // Heaptrack 1.5 doesn't attribute allocations per thread, so we expose
      // a single synthetic lane covering the whole capture.
      threads: [{
        tid: 1,
        pid: 1,
        primaryComm: comm,
        comms: [{ name: comm, fromNs: startNs, toNs: endNs }],
      }],
      strings: this.strings,
      dsos: this.dsos,
      functions: this.functions,
      samples: {
        times: sampleTimes,
        tids: sampleTids,
        stackOffsets: sampleStackOffsets,
        stackFrames: sampleStackFramesArr,
        // Default weights = the active kind. Profile constructor reads
        // weightsByKind and selects one as `weights` based on
        // meta.weightKind, so analysis.js doesn't need to know about
        // multiple kinds.
        weights: wAllocated,
        weightsByKind: {
          "bytes-allocated": wAllocated,
          "bytes-leaked":    wLeaked,
          "bytes-temporary": wTemporary,
          "alloc-count":     wCount,
        },
      },
      // Process-RSS-over-time series, sampled by heaptrack every ~10ms.
      // Drives the RSS line overlaid on the timeline lanes.
      rssSeries: {
        times: this.rssTimesNs,
        bytes: this.rssBytes,
      },
      // Live-heap-bytes-over-time series: running (allocated - freed)
      // across every event, sampled at every `c` tick. Drives the live-
      // heap timeline lane.
      liveSeries: {
        times: this.liveTimesNs,
        bytes: this.liveBytes,
      },
    };
  }
}

// Parse a hex integer starting at `from` in `line` (until next space or EOL).
// Faster than `parseInt(line.slice(from), 16)` for hot paths because it avoids
// the substring allocation.
function parseHexFrom(line, from) {
  let v = 0;
  const n = line.length;
  for (let i = from; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x20) break;
    let d;
    if      (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    else continue;
    v = v * 16 + d;
  }
  return v;
}

export async function parseHeaptrackData(absPath, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const st = await stat(absPath);
  const meta = {
    file: path.resolve(absPath),
    fileSize: st.size,
    fileMtimeMs: st.mtimeMs,
  };

  // Pass 1: count `+` events to compute downsample stride.
  process.stderr.write("  counting events...\n");
  const t0 = Date.now();
  const totalAllocs = await countAllocations(absPath, onProgress);
  const stride = Math.max(1, Math.ceil(totalAllocs / TARGET_SAMPLES));
  process.stderr.write(`  ${totalAllocs.toLocaleString()} allocations in ${Date.now() - t0}ms; stride=${stride}\n`);

  // Pass 2: full parse with stride sampling.
  const parser = new HeaptrackParser(meta, stride);
  const t1 = Date.now();
  await streamLines(absPath, (line) => parser.feedLine(line), (lines) => {
    onProgress({ phase: "parse", lines, kept: parser._kept });
    if (lines % 5_000_000 === 0) {
      process.stderr.write(`  ${(lines / 1e6).toFixed(0)}M lines, ${parser._kept.toLocaleString()} samples kept\n`);
    }
  });
  process.stderr.write(`  parsed in ${Date.now() - t1}ms; ${parser._kept.toLocaleString()} samples\n`);
  return parser.finalize();
}
