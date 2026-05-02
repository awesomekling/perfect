// Tree views: Call Tree (top-down), Inverted (bottom-up), Top Functions.
// The tree-building itself lives in analysis.js (shared with the server API);
// this file is the view layer — flattening, virtualized rendering, keyboard
// nav, search/match cursors, focus breadcrumbs, hover bridging.

import { fmtMs, fmtCount, fmtPct, fmtTimeShort } from "./profile.js";
import {
  TRUNCATED_FID,
  buildCallTree,
  buildTopFunctions,
  expandTopFunction,
  sortChildren,
} from "./analysis.js";

const ROW_H = 22;

export class TreeView {
  constructor({ profile, scopes, scrollEl, treeEl, statsEl, getMode, getFilter, getSearch, getHideUnknown, getHideScoped, getAutoExpand, getTopInverted }) {
    this.profile = profile;
    this.scopes = scopes || null;
    this.scrollEl = scrollEl;
    this.treeEl = treeEl;
    this.statsEl = statsEl;
    this.getMode = getMode;
    this.getFilter = getFilter;
    this.getSearch = getSearch;
    this.getHideUnknown = getHideUnknown;
    this.getHideScoped = getHideScoped || (() => false);
    this.getAutoExpand = getAutoExpand || (() => false);
    this.getTopInverted = getTopInverted || (() => false);

    this.expanded = new Set();         // user-driven expansion (persists)
    this._searchExpanded = new Set();  // ephemeral, recomputed each refresh
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
    // Hover bridge to the timeline: fires `({focus, local} | null)` a short
    // time after the mouse settles on a row. Debounced so scrubbing across
    // rows doesn't burn CPU scanning samples we'll never paint. Both chains
    // are outer→inner; the timeline highlights samples whose stack contains
    // each contiguously.
    this.onHoverChange = null;
    this._hoverTimer = null;
    this._pendingHoverIdx = null;

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
    const mode = this.getMode();
    const { startNs, endNs, tids } = this.getFilter();
    const hideUnknown = this.getHideUnknown();
    const search = (this.getSearch() || "").toLowerCase();

    // Collect filtered sample indices once. With "hide scoped" on, drop any
    // sample whose stack contains an active scope — flips the analysis to
    // show what *isn't* explained by the user's scopes. Inactive scopes
    // already contribute 0 to sampleColorIdx, so they don't filter.
    const inRange = [];
    const { times, tids: stids } = this.profile.samples;
    const hideScoped = this.getHideScoped();
    const sampleColor = (hideScoped && this.scopes) ? this.scopes.sampleColorIdx() : null;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < startNs || t > endNs) continue;
      if (tids && !tids.has(stids[i])) continue;
      if (sampleColor && sampleColor[i] !== 0) continue;
      inRange.push(i);
    }
    this.totalSamples = inRange.length;

    const opts = { sampleIdxs: inRange, hideUnknown, focusPath: this._focusPath };
    let root;
    if (mode === "calltree") {
      root = buildCallTree(this.profile, { ...opts, inverted: false });
    } else if (mode === "inverted") {
      root = buildCallTree(this.profile, { ...opts, inverted: true });
    } else if (mode === "top") {
      root = buildTopFunctions(this.profile, opts);
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
    this._renderStats();
    if (this.onFocusChange) this.onFocusChange(this._focusBreadcrumbs());
  }

  _renderStats() {
    const { startNs, endNs, tids } = this.getFilter();
    const dur = endNs - startNs;
    const tidStr = tids ? `${tids.size} thread${tids.size === 1 ? "" : "s"}` : "all threads";
    const onCpu = this.profile.timeKnown
      ? ` · ≈${fmtTimeShort(this.totalSamples * this.profile.nsPerSample)} on-CPU`
      : "";
    this.statsEl.textContent = `${this.totalSamples.toLocaleString()} samples${onCpu} · ${tidStr} · ${fmtMs(dur)} window`;
  }

  _labelFor(fid) {
    if (fid === TRUNCATED_FID) return "[truncated]";
    return this.profile.funcLabel(fid);
  }

  // Build the rendered-tree path from depth-0 down to `flatRows[i]`. Returns
  // an array of fids in display order, or null if the row or any ancestor is
  // synthetic ([truncated]).
  _renderedPathForRow(i) {
    const r = this.flatRows[i];
    if (!r || !r.node) return null;
    if (r.node.fid === TRUNCATED_FID) return null;
    const path = [r.node.fid];
    let needed = r.depth - 1;
    for (let j = i - 1; j >= 0 && needed >= 0; j--) {
      if (this.flatRows[j].depth === needed) {
        const n = this.flatRows[j].node;
        if (n.fid === TRUNCATED_FID) return null;
        path.unshift(n.fid);
        needed--;
      }
    }
    return path;
  }

  // Hover context for the timeline. `focus` and `local` are outer→inner fid
  // chains; the timeline highlights samples where both appear in the stack.
  // `mode` and `hideUnknown` tell the timeline how to anchor the local
  // chain: in inverted mode it must sit at the innermost end of the stack
  // (so e.g. hovering a leaf row only highlights samples where it really is
  // the leaf), while other modes accept the chain contiguously anywhere —
  // which is fine because their depth-0 frames (outermost in calltree, top
  // function fid in top mode) typically appear once per stack.
  _hoverContextForRow(i) {
    const path = this._renderedPathForRow(i);
    if (!path) return null;
    const mode = this.getMode();
    // In inverted mode the rendered tree walks innermost→outermost, so the
    // path we just built is inner→outer. Flip it to canonical outer→inner.
    const local = mode === "inverted" ? path.slice().reverse() : path;
    return { focus: this._focusPath, local, mode, hideUnknown: this.getHideUnknown() };
  }

  // ----- Focus on subtree -----
  // The focus is a path of fids in stack order (outer→inner). Every frame in
  // the path must be present consecutively in a sample's stack for it to be
  // counted; the focused frame is the last entry. Focus is a sample filter
  // that persists across view-mode changes — the tree builders in analysis.js
  // each apply it in the way that makes sense for their mode (callees for
  // calltree/top, callers for inverted).
  //
  // Focusing on the currently-selected row extends the existing path by
  // whatever extra fids sit between the focused frame (depth 0 in the
  // rendered tree) and the row. With no prior focus, the row's full chain
  // becomes the new path.
  focusSelected() {
    const path = this._renderedPathForRow(this._selectedIdx);
    if (!path) return;
    // In calltree+focus, path[0] is the already-focused frame; only deeper
    // frames extend the chain. With no prior focus, the path is the chain.
    const chain = this._focusPath.length > 0
      ? [...this._focusPath, ...path.slice(1)]
      : path;
    // No change if the selected row *is* the already-focused frame.
    if (chain.length === this._focusPath.length) return;
    this._focusPath = chain;
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

  // Debounced hover notifier. `idx` is a row index, or null to clear.
  _setHoverRow(idx) {
    this._pendingHoverIdx = idx;
    if (this._hoverTimer) clearTimeout(this._hoverTimer);
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = null;
      if (!this.onHoverChange) return;
      const i = this._pendingHoverIdx;
      const ctx = (i == null) ? null : this._hoverContextForRow(i);
      this.onHoverChange(ctx);
    }, 75);
  }

  // Drop any pending debounced hover update without firing it. Used when
  // another source (e.g. the scopes sidebar) is taking over the timeline
  // highlight and would otherwise be clobbered by our 75ms-late clear.
  cancelPendingHover() {
    if (this._hoverTimer) {
      clearTimeout(this._hoverTimer);
      this._hoverTimer = null;
    }
    this._pendingHoverIdx = null;
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
          if (child._lazy) {
            expandTopFunction(this.profile, child, {
              hideUnknown: this.getHideUnknown(),
              focusPath: this._focusPath,
              inverted: this.getTopInverted(),
            });
          }
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

  // Lighter than refresh(): re-paint the visible rows without rebuilding the
  // tree. Used when only the visual layer needs updating (e.g. scope colors).
  rerenderRows() {
    if (this._attached) this._renderVisible();
  }

  // The fid of the currently-selected tree row, or null when nothing is
  // selected or the selection is on the synthetic [truncated] row.
  selectedFid() {
    const r = this.flatRows[this._selectedIdx];
    if (!r || !r.node) return null;
    if (r.node.fid === TRUNCATED_FID) return null;
    return r.node.fid;
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
      const scopeColor = (!isTruncated && this.scopes) ? this.scopes.color(fid) : null;
      const cls = `tree-row${isMatch ? " matched" : ""}${isCurrent ? " current-match" : ""}${isSelected ? " selected" : ""}${scopeColor ? " scoped" : ""}`;
      const scopeStyle = scopeColor ? ` --scope-color:${scopeColor};` : "";
      const scopeDotHtml = scopeColor ? `<span class="scope-dot" style="background:${scopeColor}" title="In scope"></span>` : "";
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
        <div class="${cls}" data-i="${i}" style="position:absolute; top:${top}px; left:0; right:0;${scopeStyle}">
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
            ${scopeDotHtml}<span class="sym ${isUnknown ? "unknown" : ""} ${isTruncated ? "truncated" : ""}" title="${escapeHtml(label)}">${labelHtml}</span>
          </div>
          <div class="col-dso" title="${escapeHtml(dsoFull)}">${escapeHtml(dso)}</div>
        </div>
      `;
    }
    this.treeEl.innerHTML = html;

    // attach click / hover handlers
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
      row.addEventListener("mouseenter", () => this._setHoverRow(i));
    }
    // Bind mouseleave on the container once, not per row, so fast scrubs
    // don't thrash with enter/leave pairs. Attaching it here is fine because
    // innerHTML replacement doesn't touch the parent element itself.
    if (!this.treeEl._hoverLeaveBound) {
      this.treeEl._hoverLeaveBound = true;
      this.treeEl.addEventListener("mouseleave", () => this._setHoverRow(null));
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
