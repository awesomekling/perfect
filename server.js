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

const PORT = +(process.env.PORT || 5173);
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CACHE = path.join(ROOT, ".cache");
await fsp.mkdir(CACHE, { recursive: true });

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

async function listProfiles() {
  const entries = await fsp.readdir(process.cwd(), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^perf\.data(\..+)?$/.test(e.name) && !e.name.endsWith(".perf.data")) continue;
    const full = path.resolve(process.cwd(), e.name);
    const st = await fsp.stat(full);
    out.push({ name: e.name, path: full, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

function cacheKey(absPath, mtimeMs) {
  const h = crypto.createHash("sha256").update(absPath + ":" + mtimeMs).digest("hex").slice(0, 16);
  return path.join(CACHE, `profile-${h}.json.gz`);
}

async function loadProfile(absPath) {
  const st = await fsp.stat(absPath);
  const cache = cacheKey(absPath, st.mtimeMs);
  try {
    await fsp.access(cache);
    return cache; // serve cached path
  } catch {}
  const t0 = Date.now();
  process.stderr.write(`parsing ${absPath} ...\n`);
  const profile = await parsePerfData(absPath, {
    onProgress: ({ lines, samples }) => process.stderr.write(`\r  ${lines} lines, ${samples} samples`),
  });
  process.stderr.write(`\n  done in ${Date.now() - t0}ms\n`);
  // Write gzipped JSON
  const tmp = cache + ".tmp";
  const json = JSON.stringify(profile);
  const gz = zlib.gzipSync(json, { level: 6 });
  await fsp.writeFile(tmp, gz);
  await fsp.rename(tmp, cache);
  process.stderr.write(`  cached ${cache} (${gz.length} bytes)\n`);
  return cache;
}

async function handleApi(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/profiles") {
    const list = await listProfiles();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }
  if (u.pathname === "/api/profile") {
    const p = u.searchParams.get("path");
    if (!p) return send(res, 400, "missing path");
    let absPath = path.resolve(process.cwd(), p);
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
    console.error(e);
    send(res, 500, String(e?.stack || e));
  }
});

server.listen(PORT, () => {
  console.log(`perfect: http://localhost:${PORT}/  (cwd=${process.cwd()})`);
});
