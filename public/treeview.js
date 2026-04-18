// Tree views: Call Tree (top-down), Inverted (bottom-up), Top Functions.
// Each view builds a tree of {fid, total, self, children: Map<fid, node>}.
//
// Top Functions: each unique function is a top-level row; expanding aggregates
// the *callees* below that function across all stacks where it appears.
// Recursion: only the innermost-most occurrence of fid in a sample contributes
// to its callees (so we don't double-count recursive frames).

import { fmtMs, fmtCount, fmtPct } from "./profile.js";

const ROW_H = 22;

export class TreeView {
  constructor({ profile, scrollEl, treeEl, statsEl, getMode, getFilter, getSearch, getHideUnknown }) {
    this.profile = profile;
    this.scrollEl = scrollEl;
    this.treeEl = treeEl;
    this.statsEl = statsEl;
    this.getMode = getMode;
    this.getFilter = getFilter;
    this.getSearch = getSearch;
    this.getHideUnknown = getHideUnknown;

    this.expanded = new Set(); // node ids
    this.nodeId = 0;
    this.flatRows = []; // [{node, depth}] currently visible
    this.tree = null;
    this.totalSamples = 0;

    this.scrollEl.addEventListener("scroll", () => this._renderVisible());
    window.addEventListener("resize", () => this._renderVisible());
  }

  refresh() {
    const t0 = performance.now();
    const mode = this.getMode();
    const { startNs, endNs, tids } = this.getFilter();
    const hideUnknown = this.getHideUnknown();
    const search = (this.getSearch() || "").toLowerCase();

    // Collect filtered sample indices once.
    const inRange = [];
    const { times, tids: stids } = this.profile.samples;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < startNs || t > endNs) continue;
      if (tids && !tids.has(stids[i])) continue;
      inRange.push(i);
    }
    this.totalSamples = inRange.length;

    let root, rootHasChildren = true;
    if (mode === "calltree") {
      root = this._buildCallTree(inRange, false, hideUnknown);
    } else if (mode === "inverted") {
      root = this._buildCallTree(inRange, true, hideUnknown);
    } else if (mode === "top") {
      root = this._buildTopFunctions(inRange, hideUnknown);
    }
    this.tree = root;

    // expand top-level nodes by default for call tree / inverted
    this.expanded = new Set();
    if (mode === "calltree" || mode === "inverted") {
      // Auto-expand the hot path: walk dominant child while it captures
      // a clear majority of its parent's samples.
      let cur = root;
      for (let depth = 0; depth < 64; depth++) {
        const kids = sortChildren(cur);
        if (kids.length === 0) break;
        const top = kids[0];
        // Expand if top child dominates its siblings (>=2x next child) OR is >40% of parent total.
        const next = kids[1];
        const dominant = !next || top.total >= next.total * 2 || top.total > cur.total * 0.4;
        if (!dominant) break;
        this.expanded.add(top.id);
        cur = top;
      }
    }

    // pre-rank children of root for top mode by total desc
    this._search = search;

    this._buildFlatRows();
    this._renderVisible();
    this._renderStats(performance.now() - t0);
  }

  _renderStats(buildMs) {
    const { startNs, endNs, tids } = this.getFilter();
    const dur = endNs - startNs;
    const tidStr = tids ? `${tids.size} thread${tids.size === 1 ? "" : "s"}` : "all threads";
    this.statsEl.textContent = `${this.totalSamples.toLocaleString()} samples · ${tidStr} · ${fmtMs(dur)} · built in ${buildMs.toFixed(0)}ms`;
  }

  _buildCallTree(sampleIdxs, inverted, hideUnknown) {
    const root = this._newNode(-1);
    const { stackOffsets, stackFrames } = this.profile.samples;
    const profile = this.profile;
    for (const i of sampleIdxs) {
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      let cur = root;
      root.total++;
      // walk frames in display order:
      //   inverted=false (top-down): outermost..innermost  =>  end-1 .. off
      //   inverted=true  (bottom-up): innermost..outermost =>  off   .. end-1
      const walk = inverted
        ? (cb) => { for (let j = off; j < end; j++) cb(j); }
        : (cb) => { for (let j = end - 1; j >= off; j--) cb(j); };
      let lastChild = null;
      walk((j) => {
        const fid = stackFrames[j];
        if (hideUnknown && profile.isUnknown(fid)) return;
        let child = cur.children.get(fid);
        if (!child) {
          child = this._newNode(fid);
          cur.children.set(fid, child);
        }
        child.total++;
        cur = child;
        lastChild = child;
      });
      if (lastChild) lastChild.self++;
    }
    return root;
  }

  _buildTopFunctions(sampleIdxs, hideUnknown) {
    // First pass: per-function total/self counts (dedupe per sample).
    const profile = this.profile;
    const F = profile.functions.length;
    const totals = new Int32Array(F);
    const selfs = new Int32Array(F);
    const seenStamp = new Int32Array(F);
    let stamp = 0;
    const { stackOffsets, stackFrames } = profile.samples;
    for (const i of sampleIdxs) {
      stamp++;
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      // self
      if (end > off) {
        const leaf = stackFrames[off];
        if (!(hideUnknown && profile.isUnknown(leaf))) selfs[leaf]++;
      }
      for (let j = off; j < end; j++) {
        const fid = stackFrames[j];
        if (hideUnknown && profile.isUnknown(fid)) continue;
        if (seenStamp[fid] === stamp) continue;
        seenStamp[fid] = stamp;
        totals[fid]++;
      }
    }
    // Build root with one child per function with total > 0.
    const root = this._newNode(-1);
    root.total = sampleIdxs.length;
    for (let fid = 0; fid < F; fid++) {
      if (totals[fid] === 0) continue;
      const node = this._newNode(fid);
      node.total = totals[fid];
      node.self = selfs[fid];
      // Mark as lazy: children built on demand.
      node._lazy = true;
      node._lazySamples = sampleIdxs;
      node._lazyFid = fid;
      root.children.set(fid, node);
    }
    return root;
  }

  _expandLazy(node) {
    if (!node._lazy) return;
    node._lazy = false;
    const { stackOffsets, stackFrames } = this.profile.samples;
    const profile = this.profile;
    const fid = node._lazyFid;
    const hideUnknown = this.getHideUnknown();
    // For each sample containing fid, find the innermost-most occurrence
    // (smallest j where stackFrames[j] === fid). Children = frames at j-1..off (innermost..fid-1) walked as a top-down call tree rooted at fid.
    // But Instruments-like callees view shows: what fid called. Innermost direction = "calls".
    // Top-down here means: from fid, descend towards innermost. So children at depth 1 = frame just innermost of fid.
    for (const i of node._lazySamples) {
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      // find smallest j (innermost) where frame == fid
      let k = -1;
      for (let j = off; j < end; j++) {
        if (stackFrames[j] === fid) { k = j; break; }
      }
      if (k < 0) continue;
      // descend: at depth 1, fid's callee = stackFrames[k-1], then [k-2] ...
      let cur = node;
      let lastChild = null;
      for (let j = k - 1; j >= off; j--) {
        const cfid = stackFrames[j];
        if (hideUnknown && profile.isUnknown(cfid)) continue;
        let child = cur.children.get(cfid);
        if (!child) {
          child = this._newNode(cfid);
          cur.children.set(cfid, child);
        }
        child.total++;
        cur = child;
        lastChild = child;
      }
      if (lastChild) lastChild.self++;
      else if (k === off) node.self++; // fid itself was the leaf
    }
    // mark all newly created children as lazy too — they should expand to their own callees
    for (const c of node.children.values()) {
      if (c._lazy === undefined) {
        c._lazy = true;
        c._lazySamples = this._sampleIdxsContaining(node._lazySamples, c.fid);
        c._lazyFid = c.fid;
      }
    }
  }

  _sampleIdxsContaining(sampleIdxs, fid) {
    const { stackOffsets, stackFrames } = this.profile.samples;
    const out = [];
    for (const i of sampleIdxs) {
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      for (let j = off; j < end; j++) {
        if (stackFrames[j] === fid) { out.push(i); break; }
      }
    }
    return out;
  }

  _newNode(fid) {
    return { id: ++this.nodeId, fid, total: 0, self: 0, children: new Map() };
  }

  _buildFlatRows() {
    const rows = [];
    const search = this._search;
    const walk = (node, depth) => {
      const sorted = sortChildren(node);
      for (const child of sorted) {
        const matches = !search || this._matches(child.fid, search);
        rows.push({ node: child, depth });
        if (this.expanded.has(child.id)) {
          if (child._lazy) this._expandLazy(child);
          walk(child, depth + 1);
        }
        // search match boost: if search is on and node doesn't match, dim later
        // (not implemented in first cut)
      }
    };
    if (this.tree) walk(this.tree, 0);
    this.flatRows = rows;
    // size the tree element to enable virtual scroll
    this.treeEl.style.height = (rows.length * ROW_H) + "px";
  }

  _matches(fid, q) {
    const label = this.profile.funcLabel(fid).toLowerCase();
    return label.includes(q);
  }

  _renderVisible() {
    const sc = this.scrollEl;
    const top = sc.scrollTop;
    const h = sc.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.flatRows.length, Math.ceil((top + h) / ROW_H) + 5);

    // Render only visible rows; absolutely position them.
    const profile = this.profile;
    const total = this.tree ? this.tree.total : 0;
    const search = this._search;

    let html = "";
    for (let i = first; i < last; i++) {
      const { node, depth } = this.flatRows[i];
      const top = i * ROW_H;
      const fid = node.fid;
      const label = profile.funcLabel(fid);
      const dso = profile.funcDsoShort(fid);
      const isUnknown = profile.isUnknown(fid);
      const expandable = node.children.size > 0 || node._lazy;
      const expanded = this.expanded.has(node.id);
      const twisty = expandable ? (expanded ? "▾" : "▸") : "·";
      const pct = total ? (100 * node.total / total) : 0;
      const selfPct = total ? (100 * node.self / total) : 0;
      const matched = search ? this._matches(fid, search) : false;
      html += `
        <div class="tree-row ${matched ? "matched" : ""}" data-i="${i}" style="position:absolute; top:${top}px; left:0; right:0;">
          <div class="col-symbol" style="padding-left:${8 + depth * 14}px">
            <span class="twisty ${expandable ? "expandable" : ""}" data-twisty="1">${twisty}</span>
            <span class="sym ${isUnknown ? "unknown" : ""}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          </div>
          <div class="col-total">
            <span class="bar" style="width:${pct.toFixed(2)}%"></span>
            <span class="num">${node.total.toLocaleString()} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="col-self">
            <span class="bar" style="width:${selfPct.toFixed(2)}%"></span>
            <span class="num">${node.self.toLocaleString()}</span>
          </div>
          <div class="col-dso" title="${escapeHtml(profile.funcDso(fid))}">${escapeHtml(dso)}</div>
        </div>
      `;
    }
    this.treeEl.innerHTML = html;

    // attach click handlers
    for (const row of this.treeEl.children) {
      const i = +row.dataset.i;
      row.addEventListener("click", (e) => {
        const r = this.flatRows[i];
        if (!r) return;
        const node = r.node;
        const expandable = node.children.size > 0 || node._lazy;
        if (!expandable) return;
        if (this.expanded.has(node.id)) this.expanded.delete(node.id);
        else this.expanded.add(node.id);
        this._buildFlatRows();
        this._renderVisible();
      });
    }
  }
}

function sortChildren(node) {
  const arr = [...node.children.values()];
  arr.sort((a, b) => b.total - a.total || b.self - a.self);
  return arr;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
