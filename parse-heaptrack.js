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

// Cap kept-sample count regardless of file size. ~2M samples is enough for
// any reasonable view (perf profiles in this repo run 5-10M and feel fine,
// but we already inflate stack-frame counts via inline expansion below, so
// stay a bit more conservative).
const TARGET_SAMPLES = 2_000_000;

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
    this.functionIdx = new Map(); // packed key (symId * 65536 + dsoId) -> fid

    // For each (allocInfoId), cache the flattened innermost→outermost stack
    // of fids. Many `+` events reference the same alloc info; computing the
    // stack once per info saves a lot of repeated tree walks.
    this._stackCache = new Map();

    // Output samples (parallel arrays, finalized into typed-array shape).
    this.sampleTimes = [];     // ns
    this.sampleTids = [];
    this.sampleWeights = [];   // bytes (size × stride)
    this.sampleStackFrames = [];
    this.sampleStackOffsets = [0];

    // RSS time series for the timeline overlay.
    this.rssTimesNs = [];
    this.rssBytes = [];
    this.pageSize = 4096;

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
  internFunction(symId, dsoId) {
    const k = symId * 65536 + dsoId;
    let i = this.functionIdx.get(k);
    if (i === undefined) { i = this.functions.length; this.functions.push({ sym: symId, dso: dsoId }); this.functionIdx.set(k, i); }
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
      // Stride sampling: keep every Nth event (where N=stride from pass 1).
      // Weight is scaled by stride so byte totals are preserved on average.
      if (this._allocSeen % this.stride !== 0) return;
      const allocInfoId = parseHexFrom(line, 2);
      const info = this.htAllocInfos[allocInfoId];
      if (!info) return;
      const stack = this._stackForAllocInfo(allocInfoId);
      if (stack.length === 0) return;
      const tNs = this.currentTimeMs * 1_000_000;
      this.sampleTimes.push(tNs);
      this.sampleTids.push(1);
      this.sampleWeights.push(info.size * this.stride);
      for (let j = 0; j < stack.length; j++) this.sampleStackFrames.push(stack[j]);
      this.sampleStackOffsets.push(this.sampleStackFrames.length);
      this._kept++;
      return;
    }

    // ---- free event: ignored in v1 (no leak/temporary tracking yet) ----
    if (type === 0x2d /* '-' */) return;

    // ---- clock advance ----
    if (type === 0x63 /* 'c' */) {
      this.currentTimeMs = parseHexFrom(line, 2);
      if (this.firstTimeMs === null) this.firstTimeMs = this.currentTimeMs;
      this.lastTimeMs = this.currentTimeMs;
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
  // Walk: trace tree from leaf upward (parent pointers). At each trace level,
  // the IP carries its primary frame plus inlined frames stored OUTER→INNER
  // in file order. Within one IP, the innermost-of-IP is the LAST inlined
  // frame; the outermost-of-IP is the primary `frame`. So push inlined in
  // REVERSE, then push the primary frame, before moving to the parent trace.
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
        // Inlined frames in the file are outer→inner of this IP. Reverse to
        // emit innermost first; primary `frame` (the IP's outermost) is at
        // index 0 in our `frames` array, so it goes last.
        for (let j = ip.frames.length - 1; j >= 0; j--) {
          const f = ip.frames[j];
          const symStr = (f.funcIdx > 0 && this.htStrings[f.funcIdx]) || "[unknown]";
          const symId = this.internString(symStr);
          out.push(this.internFunction(symId, dsoId));
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
    const totalBytes = this.sampleWeights.reduce((a, b) => a + b, 0);
    return {
      meta: {
        ...this.meta,
        weightKind: "bytes-allocated",
        weightLabel: "bytes",
        debuggee,
        startNs,
        endNs,
        sampleCount: this.sampleTimes.length,
        downsampleStride: this.stride,
        totalAllocated: totalBytes,
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
        times: this.sampleTimes,
        tids: this.sampleTids,
        stackOffsets: this.sampleStackOffsets,
        stackFrames: this.sampleStackFrames,
        weights: this.sampleWeights,
      },
      // Process RSS over time, sampled by heaptrack every ~10ms. Drives the
      // memory-usage line overlaid on the timeline lanes.
      rssSeries: {
        times: this.rssTimesNs,
        bytes: this.rssBytes,
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
