// Canvas timeline. Per-thread lane shows sample density over the visible time range.
// Click+drag on the canvas to select a time range.
// Wheel pans, Ctrl/Cmd+wheel zooms around the cursor.

import { fmtMs } from "./profile.js";

const LANE_H = 26;
const MIN_VIEW_NS = 1000; // 1 µs floor on zoom

export class Timeline {
  constructor({ profile, laneLabelsEl, lanesCanvas, rulerCanvas, overlayEl, onChange, onViewChange }) {
    this.profile = profile;
    this.laneLabelsEl = laneLabelsEl;
    this.lanesCanvas = lanesCanvas;
    this.rulerCanvas = rulerCanvas;
    this.overlayEl = overlayEl;
    this.onChange = onChange;
    this.onViewChange = onViewChange;

    // selection in absolute ns
    this.selStartNs = profile.startNs;
    this.selEndNs = profile.endNs;
    // visible window in absolute ns
    this.viewStartNs = profile.startNs;
    this.viewEndNs = profile.endNs;

    // tids selection (null = all)
    this.selectedTids = null;

    // Build lane list: one row per thread, sorted by sample count desc.
    this.lanes = profile.threads
      .map((t) => ({
        tid: t.tid,
        label: `${t.primaryComm}`,
        sublabel: `tid ${t.tid}`,
        sampleCount: 0,
      }));
    // count samples per tid
    const counts = new Map();
    for (let i = 0; i < profile.sampleCount; i++) {
      const tid = profile.samples.tids[i];
      counts.set(tid, (counts.get(tid) || 0) + 1);
    }
    for (const ln of this.lanes) ln.sampleCount = counts.get(ln.tid) || 0;
    this.lanes.sort((a, b) => b.sampleCount - a.sampleCount);

    // assign colors
    this.laneByTid = new Map();
    this.lanes.forEach((l, i) => {
      l.color = laneColor(i);
      this.laneByTid.set(l.tid, l);
    });

    this._buildLabels();
    this._installInput();
    this.resize();
  }

  _buildLabels() {
    this.laneLabelsEl.innerHTML = "";
    for (const lane of this.lanes) {
      const row = document.createElement("div");
      row.className = "lane-row";
      row.dataset.tid = lane.tid;
      row.innerHTML = `
        <span class="swatch" style="background:${lane.color}"></span>
        <span class="label" title="${lane.label} (tid ${lane.tid}, ${lane.sampleCount} samples)">${lane.label}</span>
        <span class="meta">${lane.sampleCount}</span>
      `;
      row.addEventListener("click", (e) => {
        if (e.shiftKey || e.metaKey) {
          this.selectedTids = this.selectedTids || new Set();
          if (this.selectedTids.has(lane.tid)) this.selectedTids.delete(lane.tid);
          else this.selectedTids.add(lane.tid);
          if (this.selectedTids.size === 0) this.selectedTids = null;
        } else {
          if (this.selectedTids && this.selectedTids.size === 1 && this.selectedTids.has(lane.tid)) {
            this.selectedTids = null;
          } else {
            this.selectedTids = new Set([lane.tid]);
          }
        }
        this._refreshLabelSelection();
        this.draw();
        this.fire();
      });
      this.laneLabelsEl.appendChild(row);
    }
    this._refreshLabelSelection();
  }
  _refreshLabelSelection() {
    for (const row of this.laneLabelsEl.children) {
      const tid = +row.dataset.tid;
      row.classList.toggle("selected", !!(this.selectedTids && this.selectedTids.has(tid)));
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.lanesCanvas.parentElement.clientWidth;
    const h = this.lanes.length * LANE_H;
    this.lanesCanvas.width = w * dpr;
    this.lanesCanvas.height = h * dpr;
    this.lanesCanvas.style.width = w + "px";
    this.lanesCanvas.style.height = h + "px";

    const rw = this.rulerCanvas.parentElement.clientWidth;
    this.rulerCanvas.width = rw * dpr;
    this.rulerCanvas.height = 24 * dpr;
    this.rulerCanvas.style.width = rw + "px";
    this.rulerCanvas.style.height = "24px";

    this.draw();
  }

  draw() {
    this._drawRuler();
    this._drawLanes();
    this._drawSelection();
    if (this.onViewChange) this.onViewChange(this.isFullView());
  }

  _xOfNs(ns, w) {
    const span = this.viewEndNs - this.viewStartNs;
    return ((ns - this.viewStartNs) / span) * w;
  }

  _nsOfX(x, w) {
    const span = this.viewEndNs - this.viewStartNs;
    return this.viewStartNs + (x / w) * span;
  }

  _drawRuler() {
    const c = this.rulerCanvas;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#9a9aa2";
    ctx.font = '11px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.textBaseline = "middle";
    const t0 = this.viewStartNs - this.profile.startNs;
    const t1 = this.viewEndNs - this.profile.startNs;
    const ticks = pickTicks(t0, t1, w);
    for (const tn of ticks) {
      const x = this._xOfNs(this.profile.startNs + tn, w);
      ctx.strokeStyle = "#3a3a42";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.fillText(fmtMs(tn), x + 4, h / 2);
    }
  }

  _drawLanes() {
    const c = this.lanesCanvas;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.fillStyle = "#1e1e22";
    ctx.fillRect(0, 0, w, h);

    // Tick lines
    const t0 = this.viewStartNs - this.profile.startNs;
    const t1 = this.viewEndNs - this.profile.startNs;
    const ticks = pickTicks(t0, t1, w);
    ctx.strokeStyle = "#2a2a32";
    for (const tn of ticks) {
      const x = this._xOfNs(this.profile.startNs + tn, w);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    // Lane backgrounds
    for (let li = 0; li < this.lanes.length; li++) {
      const y = li * LANE_H;
      ctx.fillStyle = li % 2 === 0 ? "#22222a" : "#25252d";
      ctx.fillRect(0, y, w, LANE_H);
      ctx.fillStyle = "#1a1a1e";
      ctx.fillRect(0, y + LANE_H - 1, w, 1);
    }

    // Bucket visible samples per-lane per-pixel by binary-searching the time array.
    const W = Math.max(1, Math.floor(w));
    const L = this.lanes.length;
    const tidToIdx = new Map();
    this.lanes.forEach((l, i) => tidToIdx.set(l.tid, i));
    const buckets = new Uint32Array(W * L);
    const span = Math.max(1, this.viewEndNs - this.viewStartNs);
    const { times, tids } = this.profile.samples;
    const lo = lowerBound(times, this.viewStartNs);
    const hi = upperBound(times, this.viewEndNs);
    for (let i = lo; i < hi; i++) {
      const li = tidToIdx.get(tids[i]);
      if (li === undefined) continue;
      const px = Math.min(W - 1, Math.floor((times[i] - this.viewStartNs) / span * W));
      buckets[li * W + px]++;
    }

    // Absolute density: each pixel column covers `pixelTimeNs` of wall time, and
    // at the recorded sampling rate the maximum number of samples that could land
    // in it is `pixelTimeNs / nsPerSample`. Cap at 1 so we use the full bar
    // height when a thread is fully on-CPU. When zoomed in past one sample per
    // pixel, maxPerPixel < 1, so individual samples render at full height.
    const pixelTimeNs = span / W;
    const nsPerSample = this.profile.nsPerSample || pixelTimeNs;
    const maxPerPixel = pixelTimeNs / nsPerSample;

    for (let li = 0; li < L; li++) {
      const lane = this.lanes[li];
      const y = li * LANE_H;
      const baseY = y + 3, barH = LANE_H - 6;
      ctx.fillStyle = lane.color;
      ctx.globalAlpha = 0.85;
      const rowOff = li * W;
      for (let px = 0; px < W; px++) {
        const n = buckets[rowOff + px];
        if (n === 0) continue;
        const v = Math.min(1, n / maxPerPixel);
        const bh = Math.max(1, v * barH);
        ctx.fillRect(px, baseY + (barH - bh), 1, bh);
      }
      ctx.globalAlpha = 1;

      if (this.selectedTids && !this.selectedTids.has(lane.tid)) {
        ctx.fillStyle = "rgba(20,20,24,0.55)";
        ctx.fillRect(0, y, w, LANE_H);
      }
    }
  }

  _drawSelection() {
    const w = this.lanesCanvas.clientWidth;
    let rect = this.overlayEl.querySelector(".selection-rect");
    if (!rect) {
      rect = document.createElement("div");
      rect.className = "selection-rect";
      rect.innerHTML = `<div class="handle handle-left"></div><div class="handle handle-right"></div>`;
      this.overlayEl.appendChild(rect);
    }
    const x1 = this._xOfNs(this.selStartNs, w);
    const x2 = this._xOfNs(this.selEndNs, w);
    rect.style.left = Math.min(x1, x2) + "px";
    rect.style.width = Math.abs(x2 - x1) + "px";
  }

  _installInput() {
    let drag = null;     // selection drag (left button)
    let panDrag = null;  // pan drag (middle button)
    const ov = this.overlayEl;

    ov.addEventListener("mousedown", (e) => {
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.button === 1) {
        // Middle-button drag = pan.
        panDrag = { startX: x, startView: this.viewStartNs, endView: this.viewEndNs };
        ov.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const ns = this._nsOfX(x, rect.width);
      let mode = e.shiftKey ? "extend" : "new";
      if (e.target && e.target.classList) {
        if (e.target.classList.contains("handle-left"))  mode = "resize-left";
        else if (e.target.classList.contains("handle-right")) mode = "resize-right";
      }
      drag = { startX: x, startNs: ns, mode, origStart: this.selStartNs, origEnd: this.selEndNs };
      if (mode === "new") {
        this.selStartNs = ns;
        this.selEndNs = ns;
      }
      this._drawSelection();
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (panDrag) {
        const span = panDrag.endView - panDrag.startView;
        const dxPx = x - panDrag.startX;
        const dxNs = -(dxPx / rect.width) * span;
        let s = panDrag.startView + dxNs;
        let f = panDrag.endView + dxNs;
        [s, f] = this._clampWindow(s, f);
        this.viewStartNs = s;
        this.viewEndNs = f;
        this.draw();
        return;
      }
      if (!drag) return;
      const ns = this._nsOfX(x, rect.width);
      if (drag.mode === "new") {
        this.selStartNs = Math.min(drag.startNs, ns);
        this.selEndNs = Math.max(drag.startNs, ns);
      } else if (drag.mode === "resize-left") {
        // Anchor on the original right edge; allow swap if dragged past it.
        this.selStartNs = Math.min(drag.origEnd, ns);
        this.selEndNs   = Math.max(drag.origEnd, ns);
      } else if (drag.mode === "resize-right") {
        this.selStartNs = Math.min(drag.origStart, ns);
        this.selEndNs   = Math.max(drag.origStart, ns);
      } else {
        // extend
        this.selStartNs = Math.min(drag.origStart, drag.origEnd, ns);
        this.selEndNs = Math.max(drag.origStart, drag.origEnd, ns);
      }
      this._drawSelection();
      this._scheduleFire();
    });

    window.addEventListener("mouseup", (e) => {
      if (panDrag) {
        panDrag = null;
        ov.style.cursor = "";
        return;
      }
      if (!drag) return;
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const moved = Math.abs(x - drag.startX) > 2;
      if (!moved && drag.mode === "new") {
        // click on empty area = reset to full range
        this.selStartNs = this.profile.startNs;
        this.selEndNs = this.profile.endNs;
        this._drawSelection();
      }
      drag = null;
      this.fire();
    });

    // Wheel: pan horizontally; Ctrl/Cmd-wheel (also trackpad pinch) zooms around cursor.
    const onWheel = (target) => (e) => {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      if (e.ctrlKey || e.metaKey) {
        const anchorNs = this._nsOfX(x, rect.width);
        const factor = Math.exp(e.deltaY * 0.0025);
        this.zoom(factor, anchorNs);
      } else {
        const dx = e.shiftKey ? e.deltaY : (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
        const span = this.viewEndNs - this.viewStartNs;
        this.pan((dx / rect.width) * span);
      }
    };
    ov.addEventListener("wheel", onWheel(ov), { passive: false });
    this.rulerCanvas.addEventListener("wheel", onWheel(this.rulerCanvas), { passive: false });

    // Double-click empty area = reset zoom to full.
    ov.addEventListener("dblclick", (e) => {
      if (e.button !== 0) return;
      this.resetView();
    });

    window.addEventListener("resize", () => this.resize());
  }

  fire() {
    if (this.onChange) {
      this.onChange({
        startNs: this.selStartNs,
        endNs: this.selEndNs,
        tids: this.selectedTids,
      });
    }
  }

  // Coalesce live-update fires during drag to one per animation frame so a
  // slow tree rebuild doesn't queue up behind every mousemove.
  _scheduleFire() {
    if (this._fireScheduled) return;
    this._fireScheduled = true;
    requestAnimationFrame(() => {
      this._fireScheduled = false;
      this.fire();
    });
  }

  // --- View (pan/zoom) helpers ---

  isFullView() {
    return this.viewStartNs === this.profile.startNs && this.viewEndNs === this.profile.endNs;
  }

  resetView() {
    this.viewStartNs = this.profile.startNs;
    this.viewEndNs = this.profile.endNs;
    this.draw();
  }

  // Zoom by `factor` (>1 = zoom out, <1 = zoom in), keeping `anchorNs` fixed.
  zoom(factor, anchorNs) {
    const span = this.viewEndNs - this.viewStartNs;
    const fullSpan = this.profile.endNs - this.profile.startNs;
    let newSpan = Math.max(MIN_VIEW_NS, Math.min(fullSpan, span * factor));
    const ratio = (anchorNs - this.viewStartNs) / span;
    let newStart = anchorNs - ratio * newSpan;
    let newEnd = newStart + newSpan;
    [newStart, newEnd] = this._clampWindow(newStart, newEnd);
    this.viewStartNs = newStart;
    this.viewEndNs = newEnd;
    this.draw();
  }

  // Shift the view by `dxNs`, clamped to profile bounds.
  pan(dxNs) {
    let newStart = this.viewStartNs + dxNs;
    let newEnd = this.viewEndNs + dxNs;
    [newStart, newEnd] = this._clampWindow(newStart, newEnd);
    this.viewStartNs = newStart;
    this.viewEndNs = newEnd;
    this.draw();
  }

  _clampWindow(start, end) {
    const span = end - start;
    if (start < this.profile.startNs) { start = this.profile.startNs; end = start + span; }
    if (end > this.profile.endNs)     { end   = this.profile.endNs;   start = end - span; }
    if (start < this.profile.startNs) start = this.profile.startNs;
    return [start, end];
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function laneColor(i) {
  const palette = [
    "#4ea1ff", "#ff7a59", "#7ad991", "#ffd24e",
    "#c08fff", "#5ce0d4", "#ff8fb1", "#a4ce5a",
    "#69c8e0", "#ffb74e", "#9aa5ff", "#ff9b87",
  ];
  return palette[i % palette.length];
}

function pickTicks(t0, t1, pixelW) {
  // Aim for one label every ~110 pixels (so labels don't overlap).
  const span = t1 - t0;
  const target = Math.max(2, Math.floor(pixelW / 110));
  const rawStep = span / target;
  // Pick a "nice" step >= rawStep from {1,2,5} * 10^k (in ns).
  const exp = Math.floor(Math.log10(Math.max(1, rawStep)));
  let step = 1;
  outer: for (let e = exp; e <= exp + 3; e++) {
    for (const m of [1, 2, 5]) {
      const s = m * Math.pow(10, e);
      if (s >= rawStep) { step = s; break outer; }
    }
  }
  const first = Math.ceil(t0 / step) * step;
  const out = [];
  for (let t = first; t <= t1; t += step) out.push(t);
  return out;
}
