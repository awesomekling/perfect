// Parse `perf script` output into a compact profile.
//
// Input lines look like:
//   COMM  PID/TID  SECONDS.MICROSECONDS:
//   \t    HEX_IP SYMBOL+0xOFFSET (DSO_PATH)
//   \t    HEX_IP SYMBOL (inlined)
//   ...
//   <blank>
// (Header lines starting with '#' are ignored.)
//
// Output is a single object with:
//   meta, threads, strings, dsos, functions, samples (typed-arrayish).
// To keep transport simple we serialize numeric arrays as plain JS arrays;
// the client converts them to typed arrays.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import path from "node:path";

const PERF_BIN = process.env.PERF_BIN || "perf";

// header line: "COMM  PID/TID  SECS.MICROS: "
// COMM may have leading spaces and contain spaces ("IPC IO", "Pool/0").
// Use a regex anchored at the end for the timestamp + colon.
const HEADER_RE = /^(.*?)\s+(\d+)\/(\d+)\s+(\d+\.\d+):\s*$/;
// frame line: "\t  HEX SYMBOL (DSO)" — symbol can contain spaces; dso is in last balanced parens.
const FRAME_RE = /^\s+([0-9a-f]+)\s+(.*?)\s+\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/;

export class PerfParser {
  constructor() {
    this.strings = []; // unique symbol names
    this.stringIdx = new Map();
    this.dsos = []; // unique dso paths
    this.dsoIdx = new Map();
    this.functions = []; // {sym, dso}
    this.functionIdx = new Map(); // key "symId:dsoId" -> functionId

    this.threads = new Map(); // tid -> { tid, comms: [{name, fromNs, toNs}] }

    this.sampleTimes = []; // ns
    this.sampleTids = [];
    this.sampleStacks = []; // flat: each sample appends frames innermost..outermost
    this.sampleStackOffsets = [0]; // length = nSamples + 1
    this.firstTimeNs = null;
    this.lastTimeNs = null;

    // current sample under construction
    this._curHeader = null;
    this._curFrames = [];
  }

  internString(s) {
    let i = this.stringIdx.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(s);
      this.stringIdx.set(s, i);
    }
    return i;
  }

  internDso(s) {
    let i = this.dsoIdx.get(s);
    if (i === undefined) {
      i = this.dsos.length;
      this.dsos.push(s);
      this.dsoIdx.set(s, i);
    }
    return i;
  }

  internFunction(symId, dsoId) {
    const k = symId * 65536 + dsoId; // dso ids unlikely to exceed 65535; fall back below
    let i = this.functionIdx.get(k);
    if (i === undefined) {
      i = this.functions.length;
      this.functions.push({ sym: symId, dso: dsoId });
      this.functionIdx.set(k, i);
    }
    return i;
  }

  recordThread(tid, comm, timeNs) {
    let t = this.threads.get(tid);
    if (!t) {
      t = { tid, comms: [] };
      this.threads.set(tid, t);
    }
    const last = t.comms[t.comms.length - 1];
    if (!last || last.name !== comm) {
      if (last) last.toNs = timeNs;
      t.comms.push({ name: comm, fromNs: timeNs, toNs: timeNs });
    } else {
      last.toNs = timeNs;
    }
  }

  flushSample() {
    if (!this._curHeader) return;
    const { tid, timeNs, comm } = this._curHeader;
    this.recordThread(tid, comm, timeNs);
    if (this._curFrames.length > 0) {
      this.sampleTimes.push(timeNs);
      this.sampleTids.push(tid);
      for (const fid of this._curFrames) this.sampleStacks.push(fid);
      this.sampleStackOffsets.push(this.sampleStacks.length);
      if (this.firstTimeNs === null) this.firstTimeNs = timeNs;
      this.lastTimeNs = timeNs;
    }
    this._curHeader = null;
    this._curFrames.length = 0;
  }

  feedLine(line) {
    if (line.length === 0) {
      this.flushSample();
      return;
    }
    if (line[0] === "#") return;
    // frame lines start with whitespace (tab/space), header lines do not.
    if (line[0] === "\t" || line[0] === " ") {
      const m = FRAME_RE.exec(line);
      if (!m) return;
      const symRaw = m[2];
      const dso = m[3];
      // Strip "+0x123" offset suffixes from symbol, but leave "(inlined)" paths alone.
      const plus = symRaw.lastIndexOf("+0x");
      const sym = plus > 0 ? symRaw.slice(0, plus) : symRaw;
      const fid = this.internFunction(this.internString(sym), this.internDso(dso));
      this._curFrames.push(fid);
      return;
    }
    // header
    const m = HEADER_RE.exec(line);
    if (!m) return;
    this.flushSample();
    const comm = m[1].trim();
    const pid = +m[2];
    const tid = +m[3];
    const sec = m[4];
    // Convert "147507.138819" => ns
    const dot = sec.indexOf(".");
    const whole = +sec.slice(0, dot);
    const fracStr = sec.slice(dot + 1).padEnd(9, "0").slice(0, 9);
    const timeNs = whole * 1_000_000_000 + +fracStr;
    this._curHeader = { comm, pid, tid, timeNs };
  }

  finalize(meta) {
    this.flushSample();
    // close open comm intervals at lastTimeNs
    for (const t of this.threads.values()) {
      const last = t.comms[t.comms.length - 1];
      if (last) last.toNs = this.lastTimeNs ?? last.toNs;
    }
    return {
      meta: {
        ...meta,
        startNs: this.firstTimeNs ?? 0,
        endNs: this.lastTimeNs ?? 0,
        sampleCount: this.sampleTimes.length,
      },
      threads: [...this.threads.values()].sort((a, b) => a.tid - b.tid),
      strings: this.strings,
      dsos: this.dsos,
      functions: this.functions,
      samples: {
        times: this.sampleTimes,
        tids: this.sampleTids,
        stackOffsets: this.sampleStackOffsets,
        stackFrames: this.sampleStacks,
      },
    };
  }
}

// Best-effort: pull sample_freq + event name from the perf.data header.
// Returns { sampleFreq, sampleFreqMode, eventName } or {} if unavailable.
async function readPerfHeader(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(PERF_BIN, ["report", "--header-only", "-i", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.on("close", () => {
      const out = {};
      const eventLine = stdout.split("\n").find((l) => l.startsWith("# event :"));
      if (eventLine) {
        const nameM = /name\s*=\s*([^,]+)/.exec(eventLine);
        if (nameM) out.eventName = nameM[1].trim();
        const freqValM = /sample_freq\s*\}\s*=\s*(\d+)/.exec(eventLine);
        const freqModeM = /\bfreq\s*=\s*(\d+)/.exec(eventLine);
        if (freqValM && freqModeM && +freqModeM[1] === 1) {
          out.sampleFreq = +freqValM[1];
        }
      }
      const cmdM = /^# cmdline\s*:\s*(.+)$/m.exec(stdout);
      if (cmdM) out.cmdline = cmdM[1].trim();
      const hostM = /^# hostname\s*:\s*(.+)$/m.exec(stdout);
      if (hostM) out.hostname = hostM[1].trim();
      const cpuM = /^# cpudesc\s*:\s*(.+)$/m.exec(stdout);
      if (cpuM) out.cpudesc = cpuM[1].trim();
      resolve(out);
    });
    proc.on("error", () => resolve({}));
  });
}

export async function parsePerfData(filePath, { onProgress } = {}) {
  const st = await stat(filePath);
  const header = await readPerfHeader(filePath);
  const meta = {
    file: path.resolve(filePath),
    fileSize: st.size,
    fileMtimeMs: st.mtimeMs,
    ...header,
  };

  const proc = spawn(
    PERF_BIN,
    ["script", "-i", filePath, "-F", "comm,pid,tid,time,ip,sym,dso", "--ns"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const parser = new PerfParser();
  let stderr = "";
  proc.stderr.on("data", (b) => { stderr += b.toString(); });

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    parser.feedLine(line);
    if (++lines % 100000 === 0 && onProgress) onProgress({ lines, samples: parser.sampleTimes.length });
  }
  const code = await new Promise((r) => proc.on("close", r));
  if (code !== 0 && parser.sampleTimes.length === 0) {
    throw new Error(`perf script exited ${code}: ${stderr}`);
  }
  return parser.finalize(meta);
}
