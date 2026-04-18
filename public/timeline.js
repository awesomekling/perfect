// Canvas timeline. Per-thread lane shows sample density over the visible time range.
// Click+drag on the canvas to select a time range.

import { fmtMs } from "./profile.js";

const LANE_H = 26;

export class Timeline {
  constructor({ profile, laneLabelsEl, lanesCanvas, rulerCanvas, overlayEl, onChange }) {
    this.profile = profile;
    this.laneLabelsEl = laneLabelsEl;
    this.lanesCanvas = lanesCanvas;
    this.rulerCanvas = rulerCanvas;
    this.overlayEl = overlayEl;
    this.onChange = onChange;

    // selection in absolute ns
    this.selStartNs = profile.startNs;
    this.selEndNs = profile.endNs;
    // visible window (for zoom later — for now = full range)
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

    // Pre-bin per-lane sample density at high resolution for fast redraw.
    this._densityBins = null;
    this._binCount = 0;
    this._binStartNs = 0;
    this._binEndNs = 0;

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

    this._buildDensityBins(w);
    this.draw();
  }

  _buildDensityBins(pixelW) {
    const N = Math.max(64, Math.min(4096, pixelW * 2));
    this._binCount = N;
    this._binStartNs = this.profile.startNs;
    this._binEndNs = this.profile.endNs;
    const span = Math.max(1, this._binEndNs - this._binStartNs);
    const bins = new Map(); // tid -> Uint32Array(N)
    for (const ln of this.lanes) bins.set(ln.tid, new Uint32Array(N));
    const { times, tids } = this.profile.samples;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const idx = Math.min(N - 1, Math.floor((t - this._binStartNs) * N / span));
      const arr = bins.get(tids[i]);
      if (arr) arr[idx]++;
    }
    this._densityBins = bins;
  }

  draw() {
    this._drawRuler();
    this._drawLanes();
    this._drawSelection();
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
    const span = this.viewEndNs - this.viewStartNs;
    const ticks = pickTicks(span, w);
    for (const tn of ticks) {
      const x = this._xOfNs(this.viewStartNs + tn, w);
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
    const span = this.viewEndNs - this.viewStartNs;
    const ticks = pickTicks(span, w);
    ctx.strokeStyle = "#2a2a32";
    for (const tn of ticks) {
      const x = this._xOfNs(this.viewStartNs + tn, w);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    // Lanes
    const N = this._binCount;
    const binStart = this._binStartNs, binEnd = this._binEndNs;
    const binSpan = binEnd - binStart;
    for (let li = 0; li < this.lanes.length; li++) {
      const lane = this.lanes[li];
      const y = li * LANE_H;
      // alternating background
      ctx.fillStyle = li % 2 === 0 ? "#22222a" : "#25252d";
      ctx.fillRect(0, y, w, LANE_H);
      // separator
      ctx.fillStyle = "#1a1a1e";
      ctx.fillRect(0, y + LANE_H - 1, w, 1);

      const bins = this._densityBins.get(lane.tid);
      if (!bins) continue;

      // Find bin range that overlaps the visible window.
      const viewW = w;
      const baseY = y + 3, barH = LANE_H - 6;
      // For each pixel column, compute density by accumulating overlapping bins.
      const pixelStep = 1;
      // Map pixel x -> ns
      let max = 1;
      for (let i = 0; i < N; i++) if (bins[i] > max) max = bins[i];

      ctx.fillStyle = lane.color;
      for (let px = 0; px < viewW; px += pixelStep) {
        const nsLo = this.viewStartNs + (px / viewW) * (this.viewEndNs - this.viewStartNs);
        const nsHi = this.viewStartNs + ((px + pixelStep) / viewW) * (this.viewEndNs - this.viewStartNs);
        const lo = Math.max(0, Math.floor((nsLo - binStart) / binSpan * N));
        const hi = Math.min(N, Math.ceil((nsHi - binStart) / binSpan * N));
        let sum = 0;
        for (let i = lo; i < hi; i++) sum += bins[i];
        if (sum === 0) continue;
        const v = Math.min(1, sum / max);
        const bh = Math.max(1, v * barH);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(px, baseY + (barH - bh), pixelStep, bh);
      }
      ctx.globalAlpha = 1;

      // dim if not in selectedTids
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
      this.overlayEl.appendChild(rect);
    }
    const x1 = this._xOfNs(this.selStartNs, w);
    const x2 = this._xOfNs(this.selEndNs, w);
    rect.style.left = Math.min(x1, x2) + "px";
    rect.style.width = Math.abs(x2 - x1) + "px";
  }

  _installInput() {
    let drag = null;
    const ov = this.overlayEl;
    ov.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ns = this._nsOfX(x, rect.width);
      drag = { startX: x, startNs: ns, mode: e.shiftKey ? "extend" : "new", origStart: this.selStartNs, origEnd: this.selEndNs };
      if (drag.mode === "new") {
        this.selStartNs = ns;
        this.selEndNs = ns;
      }
      this._drawSelection();
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ns = this._nsOfX(x, rect.width);
      if (drag.mode === "new") {
        this.selStartNs = Math.min(drag.startNs, ns);
        this.selEndNs = Math.max(drag.startNs, ns);
      } else {
        this.selStartNs = Math.min(drag.origStart, drag.origEnd, ns);
        this.selEndNs = Math.max(drag.origStart, drag.origEnd, ns);
      }
      this._drawSelection();
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      const rect = ov.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const moved = Math.abs(x - drag.startX) > 2;
      if (!moved) {
        // click without drag = reset to full range
        this.selStartNs = this.profile.startNs;
        this.selEndNs = this.profile.endNs;
        this._drawSelection();
      }
      drag = null;
      this.fire();
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
}

function laneColor(i) {
  const palette = [
    "#4ea1ff", "#ff7a59", "#7ad991", "#ffd24e",
    "#c08fff", "#5ce0d4", "#ff8fb1", "#a4ce5a",
    "#69c8e0", "#ffb74e", "#9aa5ff", "#ff9b87",
  ];
  return palette[i % palette.length];
}

function pickTicks(spanNs, pixelW) {
  // Aim for one label every ~110 pixels (so labels don't overlap).
  const target = Math.max(2, Math.floor(pixelW / 110));
  const rawStep = spanNs / target;
  // Pick a "nice" step >= rawStep from {1,2,5} * 10^k (in ns).
  const exp = Math.floor(Math.log10(Math.max(1, rawStep)));
  let step = 1;
  outer: for (let e = exp; e <= exp + 2; e++) {
    for (const m of [1, 2, 5]) {
      const s = m * Math.pow(10, e);
      if (s >= rawStep) { step = s; break outer; }
    }
  }
  const out = [];
  for (let t = 0; t <= spanNs; t += step) out.push(t);
  return out;
}
