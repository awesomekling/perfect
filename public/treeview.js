// Tree views: Call Tree (top-down), Inverted (bottom-up), Top Functions.
// Each view builds a tree of {fid, total, self, children: Map<fid, node>}.
//
// Top Functions: each unique function is a top-level row; expanding aggregates
// the *callees* below that function across all stacks where it appears.
// Recursion: only the innermost-most occurrence of fid in a sample contributes
// to its callees (so we don't double-count recursive frames).

import { fmtMs, fmtCount, fmtPct, fmtTimeShort } from "./profile.js";

const ROW_H = 22;

// Synthetic fid used in the inverted tree to represent samples whose stack
// was truncated at a given node (i.e. perf couldn't unwind any further). The
// renderer special-cases this value to show "[truncated]" instead of looking
// up a real function.
const TRUNCATED_FID = -2;
// Only attach a [truncated] child when the gap is at least this fraction of
// the node's total — below that, it's just noise.
const TRUNCATION_THRESHOLD = 0.05;

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
    // Focus-on-subtree: fid-chain from this.tree down to the focused node.
    // Stored as fids (not node ids) so it survives tree rebuilds; if the new
    // tree doesn't contain the same path (e.g. filter excluded those samples),
    // refresh() silently clears it.
    this._focusPath = [];
    this.onFocusChange = null; // (crumbs) => void, where crumb = {fid,label,total,pct,depth}

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
        // Skip the synthetic [truncated] child — it's a dead end for the hot
        // path, and following it would block descent through real callers.
        const kids = sortChildren(cur).filter((k) => k.fid !== TRUNCATED_FID);
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
    if (this.onFocusChange) this.onFocusChange(this._focusBreadcrumbs());
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
    const hasFocus = this._focusPath.length > 0;
    for (const i of sampleIdxs) {
      const sampleOff = stackOffsets[i];
      const sampleEnd = stackOffsets[i + 1];
      let off = sampleOff, end = sampleEnd;
      if (hasFocus) {
        // Require the focus chain to appear in the stack, then reshape the
        // sample universe: treat the focused frame as the new outermost root
        // of every matching sample, dropping everything above it. The walk
        // direction still differs per mode (calltree=outer→inner,
        // inverted=inner→outer), but both operate on the same trimmed range.
        const focusedJ = this._findFocusJ(stackFrames, sampleOff, sampleEnd);
        if (focusedJ < 0) continue;
        off = sampleOff;
        end = focusedJ + 1;
      }
      let cur = root;
      root.total++;
      // walk frames in display order:
      //   inverted=false (top-down): outermost..innermost  =>  end-1 .. off
      //   inverted=true  (bottom-up): innermost..outermost =>  off   .. end-1
      const walk = inverted
        ? (cb) => { for (let j = off; j < end; j++) cb(j); }
        : (cb) => { for (let j = end - 1; j >= off; j--) cb(j); };
      let firstChild = null, lastChild = null;
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
        if (!firstChild) firstChild = child;
        lastChild = child;
      });
      // Self time belongs on the sample's leaf frame. In the tree, the leaf is
      // the last child for calltree (walked outer→inner) and the first child
      // for inverted (walked inner→outer, so the innermost/leaf is reached
      // first).
      const leafNode = inverted ? firstChild : lastChild;
      if (leafNode) leafNode.self++;
    }
    if (inverted) this._attachTruncation(root, TRUNCATION_THRESHOLD);
    return root;
  }

  // Find the innermost position `j` in `stack[off..end)` such that, starting
  // from `j`, the stack (inner→outer) matches `_focusPath` reversed. Returns
  // `j` (the focused frame's index) or -1 if the chain isn't present.
  // `_focusPath` is stored in outer→inner order (same as call-stack notation),
  // while the stack array is inner→outer, hence the reversed comparison.
  _findFocusJ(stackFrames, off, end) {
    const path = this._focusPath;
    const K = path.length;
    outer: for (let j = off; j + K <= end; j++) {
      for (let k = 0; k < K; k++) {
        if (stackFrames[j + k] !== path[K - 1 - k]) continue outer;
      }
      return j;
    }
    return -1;
  }

  // Walk the tree and, for any node whose children's totals don't add up to
  // its own, add a synthetic [truncated] child representing the gap. In the
  // inverted view, the gap = samples where perf couldn't unwind past this
  // frame, which otherwise shows up as "memcpy has 200ms self but its
  // callers only sum to 10ms" — surfacing it makes the missing time obvious.
  _attachTruncation(node, threshold) {
    // The focused frame is the new "root" of every trimmed stack, so its
    // missing callers are intentional — not perf's fault. Skip it.
    const focusedFid = this._focusPath.length > 0
      ? this._focusPath[this._focusPath.length - 1]
      : -1;
    if (node.fid !== -1 && node.fid !== focusedFid) {
      let sum = 0;
      for (const c of node.children.values()) sum += c.total;
      const gap = node.total - sum;
      if (gap > 0 && gap >= node.total * threshold) {
        const t = this._newNode(TRUNCATED_FID);
        t.total = gap;
        node.children.set(TRUNCATED_FID, t);
      }
    }
    // Snapshot before recursing, since we may have just mutated the map.
    const kids = [...node.children.values()];
    for (const c of kids) {
      if (c.fid !== TRUNCATED_FID) this._attachTruncation(c, threshold);
    }
  }

  _labelFor(fid) {
    if (fid === TRUNCATED_FID) return "[truncated]";
    return this.profile.funcLabel(fid);
  }

  // ----- Focus on subtree -----
  // The focus is a path of fids in stack order (outer→inner). Every frame in
  // the path must be present consecutively in a sample's stack for it to be
  // counted; the focused frame is the last entry. Focus is a sample filter
  // that persists across view-mode changes — `_buildCallTree` /
  // `_buildTopFunctions` / `_expandLazy` each apply it in the way that makes
  // sense for their mode (callees for calltree/top, callers for inverted).
  //
  // Focusing on the currently-selected row extends the existing path by
  // whatever extra fids sit between the focused frame (depth 0 in the
  // rendered tree) and the row. With no prior focus, the row's full chain
  // becomes the new path.
  focusSelected() {
    const r = this.flatRows[this._selectedIdx];
    if (!r || !r.node) return;
    const node = r.node;
    if (node.fid === TRUNCATED_FID) return;
    const chain = [node.fid];
    let needed = r.depth - 1;
    for (let i = this._selectedIdx - 1; i >= 0 && needed >= 0; i--) {
      if (this.flatRows[i].depth === needed) {
        const n = this.flatRows[i].node;
        if (n.fid === TRUNCATED_FID) return;
        chain.unshift(n.fid);
        needed--;
      }
    }
    if (this._focusPath.length > 0) {
      // chain[0] is the already-focused frame (depth 0 in the focused tree);
      // only the frames deeper than it extend the filter. If the user pressed
      // F on depth 0 itself, chain.slice(1) is empty → silent no-op.
      if (chain.length <= 1) return;
      this._focusPath = [...this._focusPath, ...chain.slice(1)];
    } else {
      this._focusPath = chain;
    }
    this._selectedNodeId = null;
    this._selectedIdx = 0;
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
    this.refresh();
  }

  focusToDepth(n) {
    if (n === this._focusPath.length) return;
    this._focusPath = this._focusPath.slice(0, n);
    this._selectedNodeId = null;
    this._selectedIdx = 0;
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
    this.refresh();
  }

  _focusBreadcrumbs() {
    const out = [];
    for (let i = 0; i < this._focusPath.length; i++) {
      out.push({
        fid: this._focusPath[i],
        label: this._labelFor(this._focusPath[i]),
        depth: i + 1,
      });
    }
    return out;
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
    const hasFocus = this._focusPath.length > 0;
    // When focused: only count frames at/below the focused frame in each
    // matching sample. Samples that don't contain the focus chain drop out
    // entirely, and lazy expansion below is re-scoped the same way.
    const matching = hasFocus ? [] : sampleIdxs;
    for (const i of sampleIdxs) {
      stamp++;
      const off = stackOffsets[i];
      const sampleEnd = stackOffsets[i + 1];
      let end = sampleEnd;
      if (hasFocus) {
        const focusedJ = this._findFocusJ(stackFrames, off, sampleEnd);
        if (focusedJ < 0) continue;
        end = focusedJ + 1;
        matching.push(i);
      }
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
    root.total = matching.length;
    for (let fid = 0; fid < F; fid++) {
      if (totals[fid] === 0) continue;
      const node = this._newNode(fid);
      node.total = totals[fid];
      node.self = selfs[fid];
      // Mark as lazy: children built on demand.
      node._lazy = true;
      node._lazySamples = matching;
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
    const hasFocus = this._focusPath.length > 0;
    for (const i of node._lazySamples) {
      const off = stackOffsets[i];
      const sampleEnd = stackOffsets[i + 1];
      // When focused, the lazy expansion must stay inside the same trimmed
      // window that _buildTopFunctions counted against — otherwise an expanded
      // child could end up with more samples than its parent top-row.
      let end = sampleEnd;
      if (hasFocus) {
        const focusedJ = this._findFocusJ(stackFrames, off, sampleEnd);
        if (focusedJ < 0) continue;
        end = focusedJ + 1;
      }
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

    const matches = search ? (fid) => this._labelFor(fid).toLowerCase().includes(search) : null;

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
      const isTruncated = fid === TRUNCATED_FID;
      const label = isTruncated ? "[truncated]" : profile.funcLabel(fid);
      const dso = isTruncated ? "" : profile.funcDsoShort(fid);
      const dsoFull = isTruncated ? "perf could not unwind past this frame" : profile.funcDso(fid);
      const isUnknown = !isTruncated && profile.isUnknown(fid);
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
          <div class="col-total" title="${totalTip}">
            <span class="bar" style="width:${pct.toFixed(2)}%"></span>
            <span class="num">${totalTxt} <span class="pct">${pct.toFixed(1)}%</span></span>
          </div>
          <div class="col-self" title="${selfTip}">
            <span class="bar" style="width:${selfPct.toFixed(2)}%"></span>
            <span class="num">${selfTxt}${node.self > 0 ? ` <span class="pct">${selfPct.toFixed(1)}%</span>` : ""}</span>
          </div>
          <div class="col-symbol" style="padding-left:${8 + depth * 14}px">
            <span class="twisty ${expandable ? "expandable" : ""}" data-twisty="1">${twisty}</span>
            <span class="sym ${isUnknown ? "unknown" : ""} ${isTruncated ? "truncated" : ""}" title="${escapeHtml(label)}">${labelHtml}</span>
          </div>
          <div class="col-dso" title="${escapeHtml(dsoFull)}">${escapeHtml(dso)}</div>
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
