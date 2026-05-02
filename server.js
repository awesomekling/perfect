// Tiny HTTP server: serves /public, exposes /api/profiles and /api/profile.
// Caches parsed profiles on disk in .cache/ keyed by absolute path + mtime.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";

import { parsePerfData } from "./parse-perf.js";
import { parseHeaptrackData } from "./parse-heaptrack.js";
import { Profile } from "./public/profile.js";
import {
  filterSampleIndices,
  buildCallTree,
  buildTopFunctions,
  expandTopFunction,
  sortChildren,
  TRUNCATED_FID,
} from "./public/analysis.js";

const PORT = +(process.env.PORT || 5173);
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CACHE = path.join(ROOT, ".cache");
await fsp.mkdir(CACHE, { recursive: true });

// Additional directories from which the server will serve profiles, beyond
// cwd and .cache/uploads/. Colon-separated, resolved to absolute prefixes
// at startup. Any file under one of these (or a subdir) is accepted as a
// `path` param on the analysis endpoints.
const EXTRA_PROFILE_DIRS = (process.env.PERFECT_PROFILE_DIRS || "")
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(s));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

async function sendStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden");
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) return send(res, 404, "not found");
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, "not found");
  }
}

// Decide which parser owns a given file based on its name. Heaptrack files
// follow the convention `heaptrack.<comm>.<pid>.zst` (or .gz, or unsuffixed
// for older versions); anything else with a `.data` suffix is assumed to be
// perf script output. Files we don't recognize don't show up in the picker.
function profileKindForName(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("heaptrack.") || lower.endsWith(".heaptrack") ||
      lower.endsWith(".heaptrack.zst") || lower.endsWith(".heaptrack.gz")) {
    return "heaptrack";
  }
  if (lower.endsWith(".data")) return "perf";
  return null;
}

async function listProfiles() {
  const entries = await fsp.readdir(process.cwd(), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const kind = profileKindForName(e.name);
    if (!kind) continue;
    const full = path.resolve(process.cwd(), e.name);
    const st = await fsp.stat(full);
    out.push({ name: e.name, path: full, size: st.size, mtimeMs: st.mtimeMs, kind });
  }
  return out;
}

// Bump SCHEMA whenever the parsed-profile shape changes, so old caches are
// ignored on the next request.
const PARSED_SCHEMA = 11;
function cacheKey(absPath, mtimeMs) {
  const h = crypto.createHash("sha256").update(absPath + ":" + mtimeMs + ":v" + PARSED_SCHEMA).digest("hex").slice(0, 16);
  return path.join(CACHE, `profile-${h}.json.gz`);
}

// In-flight parse jobs, keyed by cache path, so concurrent requests for the
// same profile share one parse instead of stampeding the parser.
const inFlight = new Map();

// Stream-serialize a profile into a gzip stream. Big numeric columns
// (samples.{times,tids,stackOffsets,stackFrames,weights,...} and the rss
// series) travel as chunked base64 arrays — chunks of ~8MB raw, ~11MB
// base64. Two reasons we can't just JSON.stringify the whole thing:
//
//   1) Plain-Array JSON for ~80M Uint32 entries (stackFrames on a
//      WebContent capture) blows past V8's single-string ceiling.
//   2) Even base64 as a single string would: 80M*4 bytes = 320MB raw →
//      ~430MB base64, also over V8's ceiling. Chunking keeps every
//      individual JS string well under that limit.
//
// On disk: `"<field>": ["@b64:<TypeName>:<base64>", "@b64:<TypeName>:<base64>", ...]`.
// The Profile constructor detects the array shape and merges chunks back
// into one typed array.
const TYPED_CTORS = {
  Float64Array, Float32Array, Int32Array, Uint32Array, Uint8Array,
};

// 8MB raw → ~11MB base64. Multiple of 3 to avoid base64 padding mid-chunk.
const ENC_CHUNK_BYTES = (1 << 23) - ((1 << 23) % 3);

function asTyped(arr, kind) {
  const ctor = TYPED_CTORS[kind];
  if (arr instanceof ctor) return arr;
  return new ctor(arr);
}

// Map of which sample-level columns to encode as which typed-array kind.
// Anything not in here passes through JSON.stringify unchanged.
const BIG_SAMPLE_KINDS = {
  times:        "Float64Array",
  tids:         "Int32Array",
  stackOffsets: "Uint32Array",
  stackFrames:  "Uint32Array",
  weights:      "Float64Array",
};
const BIG_RSS_KINDS = { times: "Float64Array", bytes: "Float64Array" };

async function streamSerializeProfile(profile, gz) {
  // Fire-and-wait helper so backpressure on the gzip stream gets honored
  // (otherwise we could buffer hundreds of MB internally).
  const writeAndDrain = (s) => {
    if (gz.write(s)) return undefined;
    return new Promise((res) => gz.once("drain", res));
  };
  const encodeBigChunked = async (typedArr, kind) => {
    await writeAndDrain("[");
    const buf = Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
    let first = true;
    for (let off = 0; off < buf.length; off += ENC_CHUNK_BYTES) {
      const end = Math.min(off + ENC_CHUNK_BYTES, buf.length);
      if (!first) await writeAndDrain(",");
      first = false;
      const chunk = buf.subarray(off, end).toString("base64");
      await writeAndDrain('"@b64:' + kind + ":" + chunk + '"');
    }
    if (first) {
      // Empty buffer: still emit a single empty chunk so the decoder has
      // a uniform shape to match against.
      await writeAndDrain('"@b64:' + kind + ':"');
    }
    await writeAndDrain("]");
  };

  await writeAndDrain("{");
  await writeAndDrain('"meta":' + JSON.stringify(profile.meta));
  await writeAndDrain(',"threads":' + JSON.stringify(profile.threads));
  await writeAndDrain(',"strings":' + JSON.stringify(profile.strings));
  await writeAndDrain(',"dsos":' + JSON.stringify(profile.dsos));
  await writeAndDrain(',"functions":' + JSON.stringify(profile.functions));

  if (profile.samples) {
    await writeAndDrain(',"samples":{');
    let first = true;
    const writeKey = async (k) => { await writeAndDrain((first ? "" : ",") + JSON.stringify(k) + ":"); first = false; };
    for (const [k, kind] of Object.entries(BIG_SAMPLE_KINDS)) {
      const v = profile.samples[k];
      if (v == null) continue;
      await writeKey(k);
      await encodeBigChunked(asTyped(v, kind), kind);
    }
    if (profile.samples.weightsByKind) {
      await writeKey("weightsByKind");
      await writeAndDrain("{");
      let firstK = true;
      for (const [wk, wv] of Object.entries(profile.samples.weightsByKind)) {
        if (!firstK) await writeAndDrain(",");
        firstK = false;
        await writeAndDrain(JSON.stringify(wk) + ":");
        await encodeBigChunked(asTyped(wv, "Float64Array"), "Float64Array");
      }
      await writeAndDrain("}");
    }
    await writeAndDrain("}");
  }

  for (const seriesField of ["rssSeries", "liveSeries"]) {
    const series = profile[seriesField];
    if (!series) continue;
    await writeAndDrain(`,"${seriesField}":{`);
    let first = true;
    for (const [k, kind] of Object.entries(BIG_RSS_KINDS)) {
      const v = series[k];
      if (v == null) continue;
      if (!first) await writeAndDrain(",");
      first = false;
      await writeAndDrain(JSON.stringify(k) + ":");
      await encodeBigChunked(asTyped(v, kind), kind);
    }
    await writeAndDrain("}");
  }

  await writeAndDrain("}");
}

async function loadProfile(absPath) {
  const st = await fsp.stat(absPath);
  const cache = cacheKey(absPath, st.mtimeMs);
  try {
    await fsp.access(cache);
    return cache;
  } catch {}
  if (inFlight.has(cache)) return inFlight.get(cache);
  const kind = profileKindForName(path.basename(absPath)) || "perf";
  const job = (async () => {
    const t0 = Date.now();
    process.stderr.write(`parsing ${absPath} (${kind}) ...\n`);
    const profile = kind === "heaptrack"
      ? await parseHeaptrackData(absPath, {
          onProgress: ({ phase, lines, kept, allocs }) => {
            // Heaptrack parser logs its own phase headers; the per-line ticks
            // are too noisy for the CR-overwrite style used for perf.
          },
        })
      : await parsePerfData(absPath, {
          onProgress: ({ lines, samples }) => process.stderr.write(`\r  ${lines} lines, ${samples} samples`),
        });
    process.stderr.write(`\n  done in ${Date.now() - t0}ms\n`);
    const tmp = cache + ".tmp";
    const out = fs.createWriteStream(tmp);
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(out);
    await streamSerializeProfile(profile, gz);
    await new Promise((res, rej) => { gz.end(); out.on("finish", res); out.on("error", rej); });
    await fsp.rename(tmp, cache);
    const sz = (await fsp.stat(cache)).size;
    process.stderr.write(`  cached ${cache} (${sz} bytes)\n`);
    return cache;
  })();
  inFlight.set(cache, job);
  try { return await job; }
  finally { inFlight.delete(cache); }
}

async function handleUpload(req, res) {
  const u = new URL(req.url, "http://x");
  const name = (u.searchParams.get("name") || "uploaded.data").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const upDir = path.join(CACHE, "uploads");
  await fsp.mkdir(upDir, { recursive: true });
  // Stream body to a tmp file, hash as we go.
  const hash = crypto.createHash("sha256");
  const tmp = path.join(upDir, `incoming-${Date.now()}-${Math.random().toString(36).slice(2)}.data`);
  const stream = fs.createWriteStream(tmp);
  let bytes = 0;
  await new Promise((resolve, reject) => {
    req.on("data", (b) => { hash.update(b); bytes += b.length; });
    req.on("end", resolve);
    req.on("error", reject);
    req.pipe(stream);
  });
  await new Promise((r) => stream.on("close", r));
  const sha = hash.digest("hex").slice(0, 16);
  const ext = name.match(/\.[a-zA-Z0-9]+$/)?.[0] || ".data";
  const finalPath = path.join(upDir, `${sha}${ext}`);
  try {
    await fsp.access(finalPath);
    await fsp.unlink(tmp); // already have it
  } catch {
    await fsp.rename(tmp, finalPath);
  }
  process.stderr.write(`upload: ${name} -> ${finalPath} (${bytes} bytes)\n`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: finalPath, name, size: bytes }));
}

// -----------------------------------------------------------------------------
// Agent-facing analysis API.
//
// The browser UI consumes the full parsed profile via /api/profile and does its
// own analysis client-side. These endpoints run the same analysis functions
// (imported from public/analysis.js) server-side and return small, pruned JSON
// aggregates suitable for an LLM — labels resolved, percentages computed,
// top-N / maxDepth / minPct applied so the response doesn't balloon.

// In-memory cache of parsed Profile objects, keyed by the on-disk cache path
// (which already encodes absolute path + mtime + schema). Lets repeated agent
// calls against the same file skip JSON.parse + typed-array conversion.
const profileCache = new Map();

async function getProfile(absPath) {
  const cache = await loadProfile(absPath);
  let p = profileCache.get(cache);
  if (!p) {
    const gz = await fsp.readFile(cache);
    const json = JSON.parse(zlib.gunzipSync(gz));
    p = new Profile(json);
    profileCache.set(cache, p);
  }
  return p;
}

function isUnder(absPath, dir) {
  return absPath === dir || absPath.startsWith(dir + path.sep);
}

function resolveRequestedPath(p) {
  const absPath = path.resolve(process.cwd(), p);
  const allowedDirs = [
    path.resolve(process.cwd()),
    path.join(CACHE, "uploads"),
    ...EXTRA_PROFILE_DIRS,
  ];
  if (!allowedDirs.some((d) => isUnder(absPath, d))) return null;
  return absPath;
}

function parseFilter(u, profile) {
  const getNum = (k) => {
    const v = u.searchParams.get(k);
    if (v == null || v === "") return null;
    const n = +v;
    return Number.isFinite(n) ? n : null;
  };
  const startNs = getNum("startNs") ?? profile.startNs;
  const endNs = getNum("endNs") ?? profile.endNs;
  let tids = null;
  const tidStr = u.searchParams.get("tids");
  if (tidStr) {
    const nums = tidStr.split(",").map((s) => +s).filter((n) => Number.isFinite(n));
    if (nums.length > 0) tids = new Set(nums);
  }
  return { startNs, endNs, tids };
}

function parseBool(u, key, dflt = false) {
  const v = u.searchParams.get(key);
  if (v == null) return dflt;
  return v === "1" || v === "true" || v === "yes";
}

function parseIntParam(u, key, dflt) {
  const v = u.searchParams.get(key);
  if (v == null || v === "") return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function parseFloatParam(u, key, dflt) {
  const v = u.searchParams.get(key);
  if (v == null || v === "") return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function parseFocus(u) {
  const v = u.searchParams.get("focus");
  if (!v) return [];
  return v.split(",").map((s) => +s).filter((n) => Number.isFinite(n));
}

function labelOf(profile, fid) {
  if (fid === TRUNCATED_FID) return "[truncated]";
  return profile.funcLabel(fid);
}

function nodeFields(profile, node, totalRef) {
  const pct = totalRef ? (100 * node.total / totalRef) : 0;
  const selfPct = totalRef ? (100 * node.self / totalRef) : 0;
  const out = {
    fid: node.fid,
    label: labelOf(profile, node.fid),
    dso: node.fid === TRUNCATED_FID ? "" : profile.funcDsoShort(node.fid),
    total: node.total,
    totalPct: +pct.toFixed(2),
    self: node.self,
    selfPct: +selfPct.toFixed(2),
  };
  if (profile.timeKnown) {
    out.totalNs = Math.round(node.total * profile.nsPerSample);
    out.selfNs = Math.round(node.self * profile.nsPerSample);
  }
  if (profile.weighted) {
    // node.total/.self are already in profile units (e.g. bytes for
    // heaptrack); expose them under a clearer alias so agents don't have to
    // remember which kind of profile they're looking at.
    out.totalBytes = Math.round(node.total);
    out.selfBytes = Math.round(node.self);
  }
  return out;
}

function serializeSubtree(profile, node, totalRef, { maxDepth, minPct, limit, depth = 0 }) {
  const out = nodeFields(profile, node, totalRef);
  if (node._lazy) out.lazy = true;
  if (depth < maxDepth && node.children.size > 0) {
    const kids = sortChildren(node);
    const children = [];
    let hidden = 0;
    for (const c of kids) {
      const cpct = totalRef ? (100 * c.total / totalRef) : 0;
      if (cpct < minPct) { hidden++; continue; }
      if (children.length >= limit) { hidden++; continue; }
      children.push(serializeSubtree(profile, c, totalRef, { maxDepth, minPct, limit, depth: depth + 1 }));
    }
    out.children = children;
    if (hidden > 0) out.hiddenChildren = hidden;
  } else if (node.children.size > 0) {
    out.truncatedAtDepth = true;
  }
  return out;
}

async function apiSummary(req, res, u) {
  const p = u.searchParams.get("path");
  if (!p) return send(res, 400, "missing path");
  const abs = resolveRequestedPath(p);
  if (!abs) return send(res, 403, "path not allowed");
  try { await fsp.access(abs); } catch { return send(res, 404, "no such file"); }
  const profile = await getProfile(abs);
  const threads = profile.threads.map((t) => ({
    tid: t.tid,
    comm: t.primaryComm,
    comms: t.comms.map((c) => ({ name: c.name, fromNs: c.fromNs, toNs: c.toNs })),
  }));
  const out = {
    path: abs,
    meta: profile.meta,
    durationNs: profile.durationNs,
    sampleCount: profile.sampleCount,
    timeKnown: profile.timeKnown,
    nsPerSample: profile.nsPerSample,
    startNs: profile.startNs,
    endNs: profile.endNs,
    threads,
    functionCount: profile.functions.length,
    dsoCount: profile.dsos.length,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

async function apiTop(req, res, u) {
  const p = u.searchParams.get("path");
  if (!p) return send(res, 400, "missing path");
  const abs = resolveRequestedPath(p);
  if (!abs) return send(res, 403, "path not allowed");
  try { await fsp.access(abs); } catch { return send(res, 404, "no such file"); }
  const profile = await getProfile(abs);
  const filter = parseFilter(u, profile);
  const hideUnknown = parseBool(u, "hideUnknown", false);
  const limit = Math.max(1, Math.min(500, parseIntParam(u, "limit", 30)));
  const focusPath = parseFocus(u);
  const sampleIdxs = filterSampleIndices(profile, filter);
  const root = buildTopFunctions(profile, { sampleIdxs, hideUnknown, focusPath });
  const kids = sortChildren(root).slice(0, limit);
  const out = {
    totalSamples: root.total,
    durationNs: filter.endNs - filter.startNs,
    filter: {
      startNs: filter.startNs,
      endNs: filter.endNs,
      tids: filter.tids ? [...filter.tids] : null,
      hideUnknown,
      focus: focusPath.map((fid) => ({ fid, label: labelOf(profile, fid) })),
    },
    functions: kids.map((n) => nodeFields(profile, n, root.total)),
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

async function apiTree(req, res, u) {
  const p = u.searchParams.get("path");
  if (!p) return send(res, 400, "missing path");
  const abs = resolveRequestedPath(p);
  if (!abs) return send(res, 403, "path not allowed");
  try { await fsp.access(abs); } catch { return send(res, 404, "no such file"); }
  const profile = await getProfile(abs);
  const filter = parseFilter(u, profile);
  const hideUnknown = parseBool(u, "hideUnknown", false);
  const inverted = parseBool(u, "inverted", false);
  const maxDepth = Math.max(1, Math.min(20, parseIntParam(u, "maxDepth", 6)));
  const minPct = Math.max(0, parseFloatParam(u, "minPct", 1));
  const limit = Math.max(1, Math.min(100, parseIntParam(u, "limit", 10)));
  const focusPath = parseFocus(u);
  const sampleIdxs = filterSampleIndices(profile, filter);
  const root = buildCallTree(profile, { sampleIdxs, inverted, hideUnknown, focusPath });
  const kids = sortChildren(root);
  const children = [];
  let hidden = 0;
  for (const c of kids) {
    const cpct = root.total ? (100 * c.total / root.total) : 0;
    if (cpct < minPct) { hidden++; continue; }
    if (children.length >= limit) { hidden++; continue; }
    children.push(serializeSubtree(profile, c, root.total, { maxDepth: maxDepth - 1, minPct, limit, depth: 0 }));
  }
  const out = {
    mode: inverted ? "inverted" : "calltree",
    totalSamples: root.total,
    durationNs: filter.endNs - filter.startNs,
    filter: {
      startNs: filter.startNs,
      endNs: filter.endNs,
      tids: filter.tids ? [...filter.tids] : null,
      hideUnknown,
      focus: focusPath.map((fid) => ({ fid, label: labelOf(profile, fid) })),
    },
    params: { maxDepth, minPct, limit },
    children,
    hiddenChildren: hidden,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

async function apiFind(req, res, u) {
  const p = u.searchParams.get("path");
  if (!p) return send(res, 400, "missing path");
  const q = (u.searchParams.get("q") || "").toLowerCase();
  if (!q) return send(res, 400, "missing q");
  const abs = resolveRequestedPath(p);
  if (!abs) return send(res, 403, "path not allowed");
  try { await fsp.access(abs); } catch { return send(res, 404, "no such file"); }
  const profile = await getProfile(abs);
  const limit = Math.max(1, Math.min(500, parseIntParam(u, "limit", 50)));
  const hideUnknown = parseBool(u, "hideUnknown", true);
  // Per-function totals across all samples (unfiltered), so "find" is just a
  // symbol lookup with sample counts attached — not a window-scoped query.
  // Float64 totals so weighted (heaptrack) byte sums stay exact.
  const F = profile.functions.length;
  const totals = new Float64Array(F);
  const selfs = new Float64Array(F);
  const seen = new Int32Array(F);
  let stamp = 0;
  const { stackOffsets, stackFrames, times, weights } = profile.samples;
  for (let i = 0; i < times.length; i++) {
    stamp++;
    const off = stackOffsets[i];
    const end = stackOffsets[i + 1];
    const w = weights ? weights[i] : 1;
    if (end > off) selfs[stackFrames[off]] += w;
    for (let j = off; j < end; j++) {
      const fid = stackFrames[j];
      if (seen[fid] === stamp) continue;
      seen[fid] = stamp;
      totals[fid] += w;
    }
  }
  const matches = [];
  for (let fid = 0; fid < F; fid++) {
    if (totals[fid] === 0) continue;
    if (hideUnknown && profile.isUnknown(fid)) continue;
    const label = profile.funcLabel(fid);
    if (!label.toLowerCase().includes(q)) continue;
    matches.push({ fid, label, dso: profile.funcDsoShort(fid), total: totals[fid], self: selfs[fid] });
  }
  matches.sort((a, b) => b.total - a.total);
  const truncated = matches.length > limit;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    query: q,
    totalSamples: times.length,
    matches: matches.slice(0, limit),
    truncated,
    matchCount: matches.length,
  }));
}

async function handleApi(req, res) {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/api/upload") {
    return await handleUpload(req, res);
  }
  if (u.pathname === "/api/profiles") {
    const list = await listProfiles();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }
  if (u.pathname === "/api/summary") return await apiSummary(req, res, u);
  if (u.pathname === "/api/top")     return await apiTop(req, res, u);
  if (u.pathname === "/api/tree")    return await apiTree(req, res, u);
  if (u.pathname === "/api/find")    return await apiFind(req, res, u);
  if (u.pathname === "/api/profile") {
    const p = u.searchParams.get("path");
    if (!p) return send(res, 400, "missing path");
    const absPath = resolveRequestedPath(p);
    if (!absPath) return send(res, 403, "path not allowed");
    try {
      await fsp.access(absPath);
    } catch {
      return send(res, 404, "no such file");
    }
    try {
      const cache = await loadProfile(absPath);
      const accept = req.headers["accept-encoding"] || "";
      if (/\bgzip\b/.test(accept)) {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "cache-control": "no-cache",
        });
        await pipeline(createReadStream(cache), res);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        const gz = await fsp.readFile(cache);
        res.end(zlib.gunzipSync(gz));
      }
    } catch (e) {
      console.error(e);
      send(res, 500, String(e?.stack || e));
    }
    return;
  }
  send(res, 404, "not found");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    await sendStatic(req, res);
  } catch (e) {
    // ERR_STREAM_PREMATURE_CLOSE just means the client hung up mid-stream.
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE") return;
    console.error(e);
    if (!res.headersSent) send(res, 500, String(e?.stack || e));
  }
});

server.listen(PORT, () => {
  console.log(`perfect: http://localhost:${PORT}/  (cwd=${process.cwd()})`);
  if (EXTRA_PROFILE_DIRS.length > 0) {
    console.log(`  extra profile dirs: ${EXTRA_PROFILE_DIRS.join(", ")}`);
  }
});
