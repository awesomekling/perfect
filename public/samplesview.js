// Samples view: a virtualized flat list of all samples in the selected
// timeline range. Selecting a sample renders its full call stack in the
// right-hand sidebar.

import { fmtMs, fmtTimeShort } from "./profile.js";

const ROW_H = 22;

export class SamplesView {
  constructor({ profile, scrollEl, treeEl, statsEl, sidebarEl, getFilter, getFocusPath }) {
    this.profile = profile;
    this.scrollEl = scrollEl;
    this.treeEl = treeEl;
    this.statsEl = statsEl;
    this.sidebarEl = sidebarEl;
    this.getFilter = getFilter;
    this.getFocusPath = getFocusPath || (() => []);
    this.samples = [];       // sample indices (sorted by time, since profile.samples.times already is)
    this._selectedIdx = -1;
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
    const { startNs, endNs, tids } = this.getFilter();
    const { times, tids: stids, stackOffsets, stackFrames } = this.profile.samples;
    const focusPath = this.getFocusPath();
    const K = focusPath.length;
    const rows = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < startNs || t > endNs) continue;
      if (tids && !tids.has(stids[i])) continue;
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
    this.samples = rows;
    this._selectedIdx = rows.length > 0 ? 0 : -1;
    this.treeEl.style.height = (rows.length * ROW_H) + "px";
    this.scrollEl.scrollTop = 0;
    this._renderVisible();
    this._renderSidebar();
    this._renderStats(performance.now() - t0);
  }

  _renderStats(buildMs) {
    const { startNs, endNs, tids } = this.getFilter();
    const dur = endNs - startNs;
    const tidStr = tids ? `${tids.size} thread${tids.size === 1 ? "" : "s"}` : "all threads";
    const onCpu = this.profile.timeKnown
      ? ` · ≈${fmtTimeShort(this.samples.length * this.profile.nsPerSample)} on-CPU`
      : "";
    this.statsEl.textContent = `${this.samples.length.toLocaleString()} samples${onCpu} · ${tidStr} · ${fmtMs(dur)} window · built in ${buildMs.toFixed(0)}ms`;
  }

  _renderVisible() {
    const sc = this.scrollEl;
    const top = sc.scrollTop;
    const h = sc.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.samples.length, Math.ceil((top + h) / ROW_H) + 5);
    const profile = this.profile;
    const { times, tids, stackOffsets, stackFrames } = profile.samples;

    let html = "";
    for (let i = first; i < last; i++) {
      const sIdx = this.samples[i];
      const t = times[sIdx] - profile.startNs;
      const tid = tids[sIdx];
      const off = stackOffsets[sIdx];
      const end = stackOffsets[sIdx + 1];
      const leafFid = end > off ? stackFrames[off] : -1;
      const leafLabel = leafFid >= 0 ? profile.funcLabel(leafFid) : "(no stack)";
      const dso = leafFid >= 0 ? profile.funcDsoShort(leafFid) : "";
      const isUnknown = leafFid >= 0 && profile.isUnknown(leafFid);
      const tlabel = (profile.threadByTid.get(tid)?.primaryComm) || `tid ${tid}`;
      const isSelected = i === this._selectedIdx;
      const cls = `tree-row${isSelected ? " selected" : ""}`;
      html += `
        <div class="${cls}" data-i="${i}" style="position:absolute; top:${i * ROW_H}px; left:0; right:0;">
          <div class="col-time" title="${(times[sIdx] - profile.startNs).toLocaleString()} ns">${fmtTimeShort(t)}</div>
          <div class="col-thread" title="${escapeHtml(tlabel)} (tid ${tid})"><span class="t">${escapeHtml(tlabel)}</span><span class="tid">tid ${tid}</span></div>
          <div class="col-symbol"><span class="sym ${isUnknown ? "unknown" : ""}" title="${escapeHtml(leafLabel)}">${escapeHtml(leafLabel)}</span></div>
          <div class="col-dso" title="${leafFid >= 0 ? escapeHtml(profile.funcDso(leafFid)) : ""}">${escapeHtml(dso)}</div>
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
    const { times, tids, stackOffsets, stackFrames } = profile.samples;
    const t = times[sIdx] - profile.startNs;
    const tid = tids[sIdx];
    const off = stackOffsets[sIdx];
    const end = stackOffsets[sIdx + 1];
    const tlabel = (profile.threadByTid.get(tid)?.primaryComm) || `tid ${tid}`;
    const depth = end - off;

    let html = `
      <div class="sidebar-header">
        <div class="sidebar-title">Sample stack</div>
        <div class="sidebar-meta">
          <b>Time</b><span class="v">${fmtTimeShort(t)}</span>
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
