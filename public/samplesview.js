// Samples view: a virtualized flat list of all samples in the selected
// timeline range. Selecting a sample renders its full call stack in the
// right-hand sidebar.

import { fmtMs, fmtTimeShort, fmtBytesShort, fmtNodeWeight } from "./profile.js";

const ROW_H = 22;

export class SamplesView {
  constructor({ profile, scopes, scrollEl, treeEl, statsEl, sidebarEl, getFilter, getFocusPath, getHideScoped }) {
    this.profile = profile;
    this.scopes = scopes || null;
    this.scrollEl = scrollEl;
    this.treeEl = treeEl;
    this.statsEl = statsEl;
    this.sidebarEl = sidebarEl;
    this.getFilter = getFilter;
    this.getFocusPath = getFocusPath || (() => []);
    this.getHideScoped = getHideScoped || (() => false);
    this.samples = [];       // sample indices, ordered by current sort key
    this._selectedIdx = -1;
    // Default sort: time ascending — matches the natural order in
    // profile.samples (time-sorted at parse) and is the cheapest
    // sort to compute.
    this.sortKey = "time";
    this.sortDesc = false;
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
    const { startNs, endNs, tids } = this.getFilter();
    const { times, tids: stids, stackOffsets, stackFrames, weights } = this.profile.samples;
    const focusPath = this.getFocusPath();
    const K = focusPath.length;
    const hideScoped = this.getHideScoped();
    const sampleColor = (hideScoped && this.scopes) ? this.scopes.sampleColorIdx() : null;
    const rows = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < startNs || t > endNs) continue;
      if (tids && !tids.has(stids[i])) continue;
      if (sampleColor && sampleColor[i] !== 0) continue;
      // Hide allocations that don't contribute to the active metric. With
      // bytes-leaked active and "Include freed" off, that means freed
      // allocations drop out of the list — listing them would directly
      // contradict the column header.
      if (weights && weights[i] === 0) continue;
      if (K > 0) {
        // Drop samples whose stack doesn't contain the focus chain. Same
        // matching rule as the tree views: contiguous run in inner→outer
        // order, comparing against focusPath reversed (since focusPath is
        // stored outer→inner).
        const off = stackOffsets[i];
        const end = stackOffsets[i + 1];
        let matched = false;
        outer: for (let j = off; j + K <= end; j++) {
          for (let k = 0; k < K; k++) {
            if (stackFrames[j + k] !== focusPath[K - 1 - k]) continue outer;
          }
          matched = true;
          break;
        }
        if (!matched) continue;
      }
      rows.push(i);
    }
    this._applySort(rows);
    this.samples = rows;
    this._selectedIdx = rows.length > 0 ? 0 : -1;
    this.treeEl.style.height = (rows.length * ROW_H) + "px";
    this.scrollEl.scrollTop = 0;
    this._renderVisible();
    this._renderSidebar();
    this._renderStats();
  }

  // Sort the index array `rows` in place by the current sortKey/sortDesc.
  // Each comparator works on profile-relative data so the sort stays
  // consistent across refreshes (filter changes, scope changes, etc.).
  _applySort(rows) {
    const { times, tids, weights, stackOffsets, stackFrames } = this.profile.samples;
    const dir = this.sortDesc ? -1 : 1;
    let cmp;
    switch (this.sortKey) {
      case "size": {
        // No size column on perf profiles; falls back to time.
        if (!weights) { cmp = (a, b) => (times[a] - times[b]) * dir; break; }
        cmp = (a, b) => {
          const d = weights[a] - weights[b];
          return (d !== 0 ? d : times[a] - times[b]) * dir;
        };
        break;
      }
      case "thread": {
        cmp = (a, b) => {
          const d = tids[a] - tids[b];
          return (d !== 0 ? d : times[a] - times[b]) * dir;
        };
        break;
      }
      case "symbol": {
        // Compare by leaf-frame label. Cache labels per fid the first
        // time we hit them so the sort doesn't blow up on big lists.
        const leafFid = (i) => {
          const off = stackOffsets[i], end = stackOffsets[i + 1];
          return end > off ? stackFrames[off] : -1;
        };
        const labelCache = new Map();
        const labelOf = (fid) => {
          if (fid < 0) return "";
          let s = labelCache.get(fid);
          if (s === undefined) { s = this.profile.funcLabel(fid); labelCache.set(fid, s); }
          return s;
        };
        cmp = (a, b) => {
          const la = labelOf(leafFid(a)), lb = labelOf(leafFid(b));
          if (la !== lb) return (la < lb ? -1 : 1) * dir;
          return (times[a] - times[b]) * dir;
        };
        break;
      }
      case "dso": {
        const leafFid = (i) => {
          const off = stackOffsets[i], end = stackOffsets[i + 1];
          return end > off ? stackFrames[off] : -1;
        };
        const cache = new Map();
        const dsoOf = (fid) => {
          if (fid < 0) return "";
          let s = cache.get(fid);
          if (s === undefined) {
            // Prefer file when known (heaptrack), fall back to .so basename.
            s = (this.profile.funcFileShort?.(fid)) || this.profile.funcDsoShort(fid);
            cache.set(fid, s);
          }
          return s;
        };
        cmp = (a, b) => {
          const da = dsoOf(leafFid(a)), db = dsoOf(leafFid(b));
          if (da !== db) return (da < db ? -1 : 1) * dir;
          return (times[a] - times[b]) * dir;
        };
        break;
      }
      case "time":
      default:
        cmp = (a, b) => (times[a] - times[b]) * dir;
        break;
    }
    rows.sort(cmp);
  }

  // Public API: cycle direction on same key, jump to descending on a new
  // key (matches TreeView.setSort and keeps the click feel uniform). For
  // "time" the natural sort feels ascending-first so we flip the default
  // there to mean "earliest first" → "latest first" on second click.
  setSort(key) {
    if (key === this.sortKey) {
      this.sortDesc = !this.sortDesc;
    } else {
      this.sortKey = key;
      // Defaults: time ascends (chronological), everything else descends
      // (biggest-first) so a sort-by-Size click gives the largest
      // allocations at the top.
      this.sortDesc = (key !== "time");
    }
    if (this.samples.length === 0) return;
    this._applySort(this.samples);
    this._selectedIdx = 0;
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
    this._renderVisible();
    this._renderSidebar();
  }

  _renderStats() {
    const { startNs, endNs, tids } = this.getFilter();
    const dur = endNs - startNs;
    const tidStr = tids ? `${tids.size} thread${tids.size === 1 ? "" : "s"}` : "all threads";
    let suffix = "";
    if (this.profile.weighted) {
      // For heap captures, the headline is bytes across the visible
      // allocations. weights are stride-scaled; sum gives the
      // capture-correct byte total.
      const w = this.profile.samples.weights;
      let total = 0;
      if (w) for (const i of this.samples) total += w[i];
      suffix = ` · ${fmtNodeWeight(this.profile, total)}`;
    } else if (this.profile.timeKnown) {
      suffix = ` · ≈${fmtTimeShort(this.samples.length * this.profile.nsPerSample)} on-CPU`;
    }
    const noun = this.profile.weighted ? "allocations" : "samples";
    this.statsEl.textContent = `${this.samples.length.toLocaleString()} ${noun}${suffix} · ${tidStr} · ${fmtMs(dur)} window`;
  }

  _renderVisible() {
    const sc = this.scrollEl;
    const top = sc.scrollTop;
    const h = sc.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.samples.length, Math.ceil((top + h) / ROW_H) + 5);
    const profile = this.profile;
    const { times, tids, stackOffsets, stackFrames, weights } = profile.samples;
    // For heap captures: stride-scaled weight ÷ stride = the actual
    // allocation size in bytes. Showing the per-allocation size lets the
    // user spot a 500 MB single-shot vs. the same total spread across
    // thousands of small allocs.
    const stride = profile.meta.downsampleStride || 1;
    const showSize = profile.weighted && weights;

    let html = "";
    for (let i = first; i < last; i++) {
      const sIdx = this.samples[i];
      const t = times[sIdx] - profile.startNs;
      const tid = tids[sIdx];
      const off = stackOffsets[sIdx];
      const end = stackOffsets[sIdx + 1];
      const leafFid = end > off ? stackFrames[off] : -1;
      const leafLabel = leafFid >= 0 ? profile.funcLabel(leafFid) : "(no stack)";
      const fileShort = leafFid >= 0 ? profile.funcFileShort?.(leafFid) : null;
      const dsoShort = leafFid >= 0 ? profile.funcDsoShort(leafFid) : "";
      const dso = fileShort || dsoShort;
      const dsoFull = leafFid >= 0
        ? (profile.funcFile?.(leafFid) || profile.funcDso(leafFid))
        : "";
      const isUnknown = leafFid >= 0 && profile.isUnknown(leafFid);
      const tlabel = (profile.threadByTid.get(tid)?.primaryComm) || `tid ${tid}`;
      const isSelected = i === this._selectedIdx;
      const cls = `tree-row${isSelected ? " selected" : ""}`;
      const sizeCol = showSize
        ? `<div class="col-size" title="${Math.round(weights[sIdx] / stride).toLocaleString()} B per allocation">${fmtBytesShort(weights[sIdx] / stride)}</div>`
        : "";
      html += `
        <div class="${cls}" data-i="${i}" style="position:absolute; top:${i * ROW_H}px; left:0; right:0;">
          <div class="col-time" title="${(times[sIdx] - profile.startNs).toLocaleString()} ns">${fmtTimeShort(t)}</div>
          ${sizeCol}
          <div class="col-thread" title="${escapeHtml(tlabel)} (tid ${tid})"><span class="t">${escapeHtml(tlabel)}</span><span class="tid">tid ${tid}</span></div>
          <div class="col-symbol"><span class="sym ${isUnknown ? "unknown" : ""}" title="${escapeHtml(leafLabel)}">${escapeHtml(leafLabel)}</span></div>
          <div class="col-dso" title="${escapeHtml(dsoFull)}">${escapeHtml(dso)}</div>
        </div>
      `;
    }
    this.treeEl.innerHTML = html;

    for (const row of this.treeEl.children) {
      const i = +row.dataset.i;
      row.addEventListener("click", () => this.selectAt(i));
    }
  }

  _renderSidebar() {
    const profile = this.profile;
    if (this._selectedIdx < 0 || this._selectedIdx >= this.samples.length) {
      this.sidebarEl.innerHTML = `<div class="sidebar-empty">No samples in selected range.</div>`;
      return;
    }
    const sIdx = this.samples[this._selectedIdx];
    const { times, tids, stackOffsets, stackFrames, weights } = profile.samples;
    const t = times[sIdx] - profile.startNs;
    const tid = tids[sIdx];
    const off = stackOffsets[sIdx];
    const end = stackOffsets[sIdx + 1];
    const tlabel = (profile.threadByTid.get(tid)?.primaryComm) || `tid ${tid}`;
    const depth = end - off;
    const stride = profile.meta.downsampleStride || 1;
    const sizeRow = (profile.weighted && weights)
      ? `<b>Size</b><span class="v">${fmtBytesShort(weights[sIdx] / stride)}</span>`
      : "";

    const title = profile.weighted ? "Allocation stack" : "Sample stack";
    let html = `
      <div class="sidebar-header">
        <div class="sidebar-title">${title}</div>
        <div class="sidebar-meta">
          <b>Time</b><span class="v">${fmtTimeShort(t)}</span>
          ${sizeRow}
          <b>Thread</b><span class="v">${escapeHtml(tlabel)} (tid ${tid})</span>
          <b>Frames</b><span class="v">${depth}</span>
        </div>
      </div>
      <div class="sidebar-stack">
    `;
    // Walk innermost..outermost (off..end-1) — same direction as call tree
    // displays leaf-at-bottom; here we list leaf first to mirror Instruments' "heaviest at top".
    for (let j = off; j < end; j++) {
      const fid = stackFrames[j];
      const label = profile.funcLabel(fid);
      const dso = profile.funcDsoShort(fid);
      const isUnknown = profile.isUnknown(fid);
      const isLeaf = j === off;
      html += `
        <div class="stack-frame${isUnknown ? " unknown" : ""}${isLeaf ? " leaf" : ""}">
          <span class="frame-idx">${j - off}</span>
          <span class="frame-sym" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <span class="frame-dso" title="${escapeHtml(profile.funcDso(fid))}">${escapeHtml(dso)}</span>
        </div>
      `;
    }
    html += `</div>`;
    this.sidebarEl.innerHTML = html;
  }

  // ----- Keyboard navigation (mirror TreeView's API) -----
  selectAt(idx) {
    if (this.samples.length === 0) return;
    this._selectedIdx = Math.max(0, Math.min(this.samples.length - 1, idx));
    this._scrollToSelected();
    this._renderVisible();
    this._renderSidebar();
  }
  moveSelection(delta) { this.selectAt(this._selectedIdx + delta); }
  movePage(dir) {
    const visible = Math.max(1, Math.floor(this.scrollEl.clientHeight / ROW_H) - 1);
    this.moveSelection(dir * visible);
  }
  _scrollToSelected() {
    const top = this._selectedIdx * ROW_H;
    const sc = this.scrollEl;
    const visTop = sc.scrollTop;
    const visBot = visTop + sc.clientHeight;
    if (top < visTop) sc.scrollTop = top;
    else if (top + ROW_H > visBot) sc.scrollTop = top + ROW_H - sc.clientHeight;
  }

  // No-op stubs so the keyboard handler in app.js can be view-agnostic.
  collapseOrParent() {}
  expandOrChild() {}
  toggleSelected() {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
