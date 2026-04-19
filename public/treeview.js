// Tree views: Call Tree (top-down), Inverted (bottom-up), Top Functions.
// Each view builds a tree of {fid, total, self, children: Map<fid, node>}.
//
// Top Functions: each unique function is a top-level row; expanding aggregates
// the *callees* below that function across all stacks where it appears.
// Recursion: only the innermost-most occurrence of fid in a sample contributes
// to its callees (so we don't double-count recursive frames).

import { fmtMs, fmtCount, fmtPct, fmtTimeShort } from "./profile.js";

const ROW_H = 22;

export class TreeView {
  constructor({ profile, scrollEl, treeEl, statsEl, getMode, getFilter, getSearch, getHideUnknown, getAutoExpand }) {
    this.profile = profile;
    this.scrollEl = scrollEl;
    this.treeEl = treeEl;
    this.statsEl = statsEl;
    this.getMode = getMode;
    this.getFilter = getFilter;
    this.getSearch = getSearch;
    this.getHideUnknown = getHideUnknown;
    this.getAutoExpand = getAutoExpand || (() => false);

    this.expanded = new Set();         // user-driven expansion (persists)
    this._searchExpanded = new Set();  // ephemeral, recomputed each refresh
    this.nodeId = 0;
    this.flatRows = []; // [{node, depth, isMatch}] currently visible
    this.tree = null;
    this.totalSamples = 0;
    this._matchRowIndices = []; // indices into flatRows for matched rows
    this._currentMatch = -1;
    this.onMatchesChange = null; // (cur, total) => void
    this._selectedIdx = 0;     // keyboard selection (index in flatRows)
    this._selectedNodeId = null; // try to preserve selection across refreshes

    this._onScroll = () => this._renderVisible();
    this._onResize = () => this._renderVisible();
    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    this.scrollEl.addEventListener("scroll", this._onScroll);
    window.addEventListener("resize", this._onResize);
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    this.scrollEl.removeEventListener("scroll", this._onScroll);
    window.removeEventListener("resize", this._onResize);
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
    const onCpu = this.profile.timeKnown
      ? ` · ≈${fmtTimeShort(this.totalSamples * this.profile.nsPerSample)} on-CPU`
      : "";
    this.statsEl.textContent = `${this.totalSamples.toLocaleString()} samples${onCpu} · ${tidStr} · ${fmtMs(dur)} window · built in ${buildMs.toFixed(0)}ms`;
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
    // Build the whole subtree rooted at `fid` eagerly — this is the only
    // correct way to scope counts to "as called within this top function".
    //
    // For each sample containing fid, find the innermost occurrence
    // (smallest j where stackFrames[j] === fid) and walk frames below it
    // (towards the leaf), accumulating the call path. That guarantees
    // every descendant's count is bounded by the ancestor's count, because
    // each descendant entry also passes through the same fid occurrence.
    //
    // Descendants are NOT marked lazy: their children were populated on
    // this same walk. That avoids the old bug where re-expanding a child
    // re-walked *all* samples containing that child (including paths that
    // never passed through the parent top function), producing descendant
    // costs that exceeded their ancestors.
    for (const i of node._lazySamples) {
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      let k = -1;
      for (let j = off; j < end; j++) {
        if (stackFrames[j] === fid) { k = j; break; }
      }
      if (k < 0) continue;
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
      // If fid was the innermost frame (k === off), node.self was already
      // counted in _buildTopFunctions — don't double-count.
    }
    node._lazySamples = null;
  }

  _newNode(fid) {
    return { id: ++this.nodeId, fid, total: 0, self: 0, children: new Map() };
  }

  _buildFlatRows() {
    const rows = [];
    const search = (this._search || "").toLowerCase();
    const autoExpand = this.getAutoExpand();
    const profile = this.profile;
    this._searchExpanded = new Set();

    const matches = search ? (fid) => profile.funcLabel(fid).toLowerCase().includes(search) : null;

    // If auto-expand is on with a search, walk the tree once and flag every
    // ancestor of any matching node so its descendant becomes reachable.
    // We don't force-expand lazy Top Functions children — too expensive.
    if (search && autoExpand && this.tree) {
      const visit = (node, ancestors) => {
        if (matches(node.fid)) {
          for (const a of ancestors) {
            if (!this.expanded.has(a.id)) this._searchExpanded.add(a.id);
          }
        }
        if (node._lazy) return;
        ancestors.push(node);
        for (const c of node.children.values()) visit(c, ancestors);
        ancestors.pop();
      };
      for (const c of this.tree.children.values()) visit(c, []);
    }

    // Flatten the tree using effective expansion. No filtering — the full
    // (effectively-expanded) tree is shown. Matches are flagged inline.
    const isExp = (id) => this.expanded.has(id) || this._searchExpanded.has(id);
    const flatten = (node, depth) => {
      const sorted = sortChildren(node);
      for (const child of sorted) {
        const isMatch = matches ? matches(child.fid) : false;
        rows.push({ node: child, depth, isMatch });
        if (isExp(child.id)) {
          if (child._lazy) this._expandLazy(child);
          flatten(child, depth + 1);
        }
      }
    };
    if (this.tree) flatten(this.tree, 0);

    this.flatRows = rows;
    // Re-index matches.
    this._matchRowIndices = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].isMatch) this._matchRowIndices.push(i);
    if (this._matchRowIndices.length === 0) {
      this._currentMatch = -1;
    } else if (this._currentMatch < 0 || this._currentMatch >= this._matchRowIndices.length) {
      this._currentMatch = 0;
    }
    if (this.onMatchesChange) this.onMatchesChange(this._currentMatch, this._matchRowIndices.length);
    // Preserve keyboard selection across refresh by node id when possible.
    if (this._selectedNodeId != null) {
      const idx = rows.findIndex((r) => r.node.id === this._selectedNodeId);
      if (idx >= 0) this._selectedIdx = idx;
      else this._selectedIdx = Math.min(this._selectedIdx, Math.max(0, rows.length - 1));
    } else if (this._selectedIdx >= rows.length) {
      this._selectedIdx = Math.max(0, rows.length - 1);
    }
    if (rows.length > 0) this._selectedNodeId = rows[this._selectedIdx].node.id;
    else this._selectedNodeId = null;
    this.treeEl.style.height = (rows.length * ROW_H) + "px";
  }

  // ----- Keyboard navigation -----
  selectAt(idx) {
    if (this.flatRows.length === 0) return;
    this._selectedIdx = Math.max(0, Math.min(this.flatRows.length - 1, idx));
    this._selectedNodeId = this.flatRows[this._selectedIdx].node.id;
    this._scrollToSelected();
    this._renderVisible();
  }
  moveSelection(delta) {
    this.selectAt(this._selectedIdx + delta);
  }
  movePage(dir) {
    const visible = Math.max(1, Math.floor(this.scrollEl.clientHeight / ROW_H) - 1);
    this.moveSelection(dir * visible);
  }
  toggleSelected() {
    const r = this.flatRows[this._selectedIdx];
    if (!r) return;
    const node = r.node;
    if (!(node.children.size > 0 || node._lazy)) return;
    const expanded = this.expanded.has(node.id) || this._searchExpanded.has(node.id);
    if (expanded) {
      this.expanded.delete(node.id);
      this._searchExpanded.delete(node.id);
    } else {
      this.expanded.add(node.id);
    }
    this._buildFlatRows();
    this._renderVisible();
  }
  collapseOrParent() {
    const r = this.flatRows[this._selectedIdx];
    if (!r) return;
    const node = r.node;
    const expanded = this.expanded.has(node.id) || this._searchExpanded.has(node.id);
    if (expanded) {
      this.expanded.delete(node.id);
      this._searchExpanded.delete(node.id);
      this._buildFlatRows();
      this._renderVisible();
    } else {
      // jump to nearest ancestor row
      const targetDepth = r.depth - 1;
      if (targetDepth < 0) return;
      for (let i = this._selectedIdx - 1; i >= 0; i--) {
        if (this.flatRows[i].depth === targetDepth) {
          this.selectAt(i);
          return;
        }
      }
    }
  }
  expandOrChild() {
    const r = this.flatRows[this._selectedIdx];
    if (!r) return;
    const node = r.node;
    const expandable = node.children.size > 0 || node._lazy;
    if (!expandable) return;
    const expanded = this.expanded.has(node.id) || this._searchExpanded.has(node.id);
    if (!expanded) {
      this.expanded.add(node.id);
      this._buildFlatRows();
      this._renderVisible();
    } else {
      // step into first child if present
      const next = this.flatRows[this._selectedIdx + 1];
      if (next && next.depth > r.depth) this.selectAt(this._selectedIdx + 1);
    }
  }
  _scrollToSelected() {
    const top = this._selectedIdx * ROW_H;
    const sc = this.scrollEl;
    const visTop = sc.scrollTop;
    const visBot = visTop + sc.clientHeight;
    if (top < visTop) sc.scrollTop = top;
    else if (top + ROW_H > visBot) sc.scrollTop = top + ROW_H - sc.clientHeight;
  }

  resetMatchCursor() {
    this._currentMatch = this._matchRowIndices.length > 0 ? 0 : -1;
    this._scrollToCurrentMatch();
    this._renderVisible();
    if (this.onMatchesChange) this.onMatchesChange(this._currentMatch, this._matchRowIndices.length);
  }

  nextMatch(delta = 1) {
    const n = this._matchRowIndices.length;
    if (n === 0) return;
    this._currentMatch = ((this._currentMatch + delta) % n + n) % n;
    this._scrollToCurrentMatch();
    this._renderVisible();
    if (this.onMatchesChange) this.onMatchesChange(this._currentMatch, n);
  }

  _scrollToCurrentMatch() {
    if (this._currentMatch < 0) return;
    const rowIdx = this._matchRowIndices[this._currentMatch];
    if (rowIdx == null) return;
    const top = rowIdx * ROW_H;
    const sc = this.scrollEl;
    const visTop = sc.scrollTop;
    const visBot = visTop + sc.clientHeight;
    if (top < visTop || top + ROW_H > visBot) {
      sc.scrollTop = Math.max(0, top - sc.clientHeight / 2 + ROW_H / 2);
    }
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

    const currentMatchRowIdx = this._currentMatch >= 0 ? this._matchRowIndices[this._currentMatch] : -1;

    let html = "";
    for (let i = first; i < last; i++) {
      const { node, depth, isMatch } = this.flatRows[i];
      const top = i * ROW_H;
      const fid = node.fid;
      const label = profile.funcLabel(fid);
      const dso = profile.funcDsoShort(fid);
      const isUnknown = profile.isUnknown(fid);
      const expandable = node.children.size > 0 || node._lazy;
      const expanded = this.expanded.has(node.id) || this._searchExpanded.has(node.id);
      const twisty = expandable ? (expanded ? "▾" : "▸") : "·";
      const pct = total ? (100 * node.total / total) : 0;
      const selfPct = total ? (100 * node.self / total) : 0;
      const labelHtml = isMatch ? highlightMatch(label, search) : escapeHtml(label);
      const isCurrent = i === currentMatchRowIdx;
      const isSelected = i === this._selectedIdx;
      const cls = `tree-row${isMatch ? " matched" : ""}${isCurrent ? " current-match" : ""}${isSelected ? " selected" : ""}`;
      const totalTxt = profile.timeKnown
        ? fmtTimeShort(node.total * profile.nsPerSample)
        : node.total.toLocaleString();
      const selfTxt = profile.timeKnown
        ? fmtTimeShort(node.self * profile.nsPerSample)
        : node.self.toLocaleString();
      const totalTip = profile.timeKnown
        ? `${node.total.toLocaleString()} samples · ${fmtTimeShort(node.total * profile.nsPerSample)} (${pct.toFixed(2)}%)`
        : `${node.total.toLocaleString()} samples (${pct.toFixed(2)}%)`;
      const selfTip = profile.timeKnown
        ? `${node.self.toLocaleString()} samples · ${fmtTimeShort(node.self * profile.nsPerSample)} (${selfPct.toFixed(2)}%)`
        : `${node.self.toLocaleString()} samples (${selfPct.toFixed(2)}%)`;
      html += `
        <div class="${cls}" data-i="${i}" style="position:absolute; top:${top}px; left:0; right:0;">
          <div class="col-symbol" style="padding-left:${8 + depth * 14}px">
            <span class="twisty ${expandable ? "expandable" : ""}" data-twisty="1">${twisty}</span>
            <span class="sym ${isUnknown ? "unknown" : ""}" title="${escapeHtml(label)}">${labelHtml}</span>
          </div>
          <div class="col-total" title="${totalTip}">
            <span class="bar" style="width:${pct.toFixed(2)}%"></span>
            <span class="num">${totalTxt} <span class="pct">${pct.toFixed(1)}%</span></span>
          </div>
          <div class="col-self" title="${selfTip}">
            <span class="bar" style="width:${selfPct.toFixed(2)}%"></span>
            <span class="num">${selfTxt}${node.self > 0 ? ` <span class="pct">${selfPct.toFixed(1)}%</span>` : ""}</span>
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
        // always select clicked row
        this._selectedIdx = i;
        this._selectedNodeId = r.node.id;
        const node = r.node;
        const expandable = node.children.size > 0 || node._lazy;
        if (expandable) {
          const isExpanded = this.expanded.has(node.id) || this._searchExpanded.has(node.id);
          if (isExpanded) {
            this.expanded.delete(node.id);
            this._searchExpanded.delete(node.id);
          } else {
            this.expanded.add(node.id);
          }
          this._buildFlatRows();
        }
        this._renderVisible();
      });
    }
  }
}

function highlightMatch(label, query) {
  if (!query) return escapeHtml(label);
  const lower = label.toLowerCase();
  const i = lower.indexOf(query);
  if (i < 0) return escapeHtml(label);
  return (
    escapeHtml(label.slice(0, i)) +
    "<mark>" + escapeHtml(label.slice(i, i + query.length)) + "</mark>" +
    escapeHtml(label.slice(i + query.length))
  );
}

function sortChildren(node) {
  const arr = [...node.children.values()];
  arr.sort((a, b) => b.total - a.total || b.self - a.self);
  return arr;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
