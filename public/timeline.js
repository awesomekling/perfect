// Canvas timeline. Per-thread lane shows sample density over the visible time range.
// Click+drag on the canvas to select a time range.
// Wheel pans, Ctrl/Cmd+wheel zooms around the cursor.

import { fmtMs, fmtBytesShort } from "./profile.js";
import { PALETTE as SCOPE_PALETTE } from "./scopes.js";

const LANE_H = 26;
const MIN_VIEW_NS = 1000; // 1 µs floor on zoom

export class Timeline {
  constructor({ profile, scopes, laneLabelsEl, lanesCanvas, rulerCanvas, highlightCanvas, overlayEl, getHideScoped, onChange, onViewChange }) {
    this.profile = profile;
    this.scopes = scopes || null;
    this.laneLabelsEl = laneLabelsEl;
    this.lanesCanvas = lanesCanvas;
    this.rulerCanvas = rulerCanvas;
    this.highlightCanvas = highlightCanvas || null;
    this.overlayEl = overlayEl;
    this.getHideScoped = getHideScoped || (() => false);
    this.onChange = onChange;
    this.onViewChange = onViewChange;
    // Hover context from the tree, or null.
    //   `{focus, local, mode, hideUnknown}` — both chains outer→inner.
    // A sample is highlighted iff its stack contains the focus chain (if
    // any) contiguously and the local chain in the position implied by mode
    // (inverted: anchored at innermost; otherwise: contiguous anywhere).
    // Persisted so the highlight redraws correctly on zoom/pan/resize.
    this._hoverContext = null;

    // selection in absolute ns
    this.selStartNs = profile.startNs;
    this.selEndNs = profile.endNs;
    // visible window in absolute ns
    this.viewStartNs = profile.startNs;
    this.viewEndNs = profile.endNs;

    // tids selection (null = all)
    this.selectedTids = null;

    // Sample-density lanes: one row per thread, sorted by sample count desc.
    // Each lane carries a `tid` so click/shift-click filters samples on that
    // thread; the renderer buckets profile.samples per (lane, pixel-column).
    const sampleLanes = profile.threads
      .map((t) => ({
        kind: "samples",
        tid: t.tid,
        label: `${t.primaryComm}`,
        sublabel: `tid ${t.tid}`,
        sampleCount: 0,
      }));
    const counts = new Map();
    for (let i = 0; i < profile.sampleCount; i++) {
      const tid = profile.samples.tids[i];
      counts.set(tid, (counts.get(tid) || 0) + 1);
    }
    for (const ln of sampleLanes) ln.sampleCount = counts.get(ln.tid) || 0;
    sampleLanes.sort((a, b) => b.sampleCount - a.sampleCount);

    // Series lanes: a precomputed (times, bytes) curve rendered as a
    // filled area chart in the lane area. No tid attached — they're not
    // per-thread, just per-profile, and don't participate in tid filtering.
    // Heaptrack profiles contribute up to two: live-heap (running
    // alloc-minus-free) and RSS (process resident-set, sampled by
    // heaptrack every ~10ms). Either may be absent.
    const seriesLanes = [];
    if (profile.liveSeries) {
      seriesLanes.push(makeSeriesLane({
        label: "Live heap",
        sublabel: "allocated − freed",
        series: profile.liveSeries,
        color: "#22c55e",
      }));
    }
    if (profile.rssSeries) {
      seriesLanes.push(makeSeriesLane({
        label: "RSS",
        sublabel: "process resident",
        series: profile.rssSeries,
        color: "#f59e0b",
      }));
    }

    // Series lanes lead, then sample lanes — for heap profiles the heap
    // shape is the orientation cue, for perf profiles there are no series
    // lanes and the order is unchanged.
    this.lanes = [...seriesLanes, ...sampleLanes];

    this.laneByTid = new Map();
    this.lanes.forEach((l, i) => {
      // Sample lanes get auto-assigned colors from laneColor; series lanes
      // already declared their own.
      if (l.kind === "samples") l.color = laneColor(i);
      if (l.tid != null) this.laneByTid.set(l.tid, l);
    });

    this._buildLabels();
    this._installInput();
    this.resize();
  }

  _buildLabels() {
    this.laneLabelsEl.innerHTML = "";
    for (const lane of this.lanes) {
      const row = document.createElement("div");
      row.className = "lane-row" + (lane.kind === "series" ? " lane-series" : "");
      if (lane.tid != null) row.dataset.tid = lane.tid;
      const meta = lane.kind === "series"
        ? fmtBytesShort(lane.peak)
        : (lane.sampleCount || 0).toLocaleString();
      const titleAttr = lane.kind === "series"
        ? `${lane.label} · ${lane.sublabel} · peak ${fmtBytesShort(lane.peak)}`
        : `${lane.label} (tid ${lane.tid}, ${lane.sampleCount} samples)`;
      row.innerHTML = `
        <span class="swatch" style="background:${lane.color}"></span>
        <span class="label" title="${titleAttr}">${lane.label}</span>
        <span class="meta">${meta}</span>
      `;
      // Only sample lanes participate in tid filtering. Series lanes are
      // per-profile readouts; clicking them does nothing.
      if (lane.kind === "samples") {
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
      }
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
    if (this.highlightCanvas) {
      this.highlightCanvas.width = w * dpr;
      this.highlightCanvas.height = h * dpr;
      this.highlightCanvas.style.width = w + "px";
      this.highlightCanvas.style.height = h + "px";
    }

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
    this._drawHighlight();
    this._drawSelection();
    if (this.onViewChange) this.onViewChange(this.isFullView());
  }

  // Called whenever the scope set changes. Lane bars are colored from the
  // per-sample scope map, so we have to redraw the lanes (not just overlays).
  scopesChanged() {
    this.draw();
  }

  // Called from the tree view on hover (debounced). `ctx` is
  // `{focus, local, mode, hideUnknown}` (focus may be empty), or null to
  // clear.
  setHoverChain(ctx) {
    this._hoverContext = (ctx && ctx.local && ctx.local.length > 0) ? ctx : null;
    this._drawHighlight();
  }

  _drawHighlight() {
    if (!this.highlightCanvas) return;
    const c = this.highlightCanvas;
    const ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const hctx = this._hoverContext;
    if (!hctx) return;
    const { focus, local, mode, hideUnknown } = hctx;
    const profile = this.profile;

    const W = Math.max(1, Math.floor(w));
    const L = this.lanes.length;
    const tidToIdx = new Map();
    this.lanes.forEach((l, i) => { if (l.tid != null) tidToIdx.set(l.tid, i); });
    const buckets = new Float64Array(W * L);
    const span = Math.max(1, this.viewEndNs - this.viewStartNs);
    const { times, tids, stackOffsets, stackFrames, weights } = this.profile.samples;
    const lo = lowerBound(times, this.viewStartNs);
    const hi = upperBound(times, this.viewEndNs);
    // Match _drawLanes: when "hide scoped" is on, the lanes are painted
    // without in-scope samples, so the hover overlay must also exclude them
    // (otherwise the yellow could hover over empty lane space).
    const hideScoped = this.getHideScoped();
    const sampleColor = (hideScoped && this.scopes) ? this.scopes.sampleColorIdx() : null;
    for (let i = lo; i < hi; i++) {
      const li = tidToIdx.get(tids[i]);
      if (li === undefined) continue;
      if (sampleColor && sampleColor[i] !== 0) continue;
      const off = stackOffsets[i];
      const end = stackOffsets[i + 1];
      // Focus matches contiguous-anywhere; local matches per mode (anchored
      // at innermost in inverted, contiguous-anywhere elsewhere). Inverted
      // anchoring is what makes a leaf row highlight only samples where it
      // really is the leaf, instead of every sample that contains it.
      if (focus.length > 0 && !containsChain(stackFrames, off, end, focus)) continue;
      if (mode === "inverted") {
        if (!matchAtInner(stackFrames, profile, hideUnknown, off, end, local)) continue;
      } else {
        if (!containsChain(stackFrames, off, end, local)) continue;
      }
      const px = Math.min(W - 1, Math.floor((times[i] - this.viewStartNs) / span * W));
      buckets[li * W + px] += weights ? weights[i] : 1;
    }

    // Match the density scaling of _drawLanes so highlight bar heights mean
    // the same thing as the base lane bars.
    let maxPerPixel;
    if (weights) {
      // For weighted profiles _drawLanes normalizes against the local peak
      // across all visible bucket cells (lanes × pixels × colors). We can't
      // see those values from here — they belong to the full lanes pass —
      // but the overlay only needs to be visible relative to the lane
      // backdrop, so re-deriving a peak from the highlight buckets alone
      // gives a good-enough scaling: a row that contains the entire
      // highlighted weight in one column hits the top.
      let peak = 0;
      for (let i = 0; i < buckets.length; i++) if (buckets[i] > peak) peak = buckets[i];
      maxPerPixel = peak || 1;
    } else {
      const pixelTimeNs = span / W;
      const nsPerSample = this.profile.nsPerSample || pixelTimeNs;
      maxPerPixel = pixelTimeNs / nsPerSample;
    }

    ctx.fillStyle = "#ffd24e";
    for (let li = 0; li < L; li++) {
      const y = li * LANE_H;
      const baseY = y + 3, barH = LANE_H - 6;
      const rowOff = li * W;
      for (let px = 0; px < W; px++) {
        const n = buckets[rowOff + px];
        if (n === 0) continue;
        const v = Math.min(1, n / maxPerPixel);
        const bh = Math.max(1, v * barH);
        ctx.fillRect(px, baseY + (barH - bh), 1, bh);
      }
    }
  }

  _xOfNs(ns, w) {
    const span = this.viewEndNs - this.viewStartNs;
    return ((ns - this.viewStartNs) / span) * w;
  }

  _nsOfX(x, w) {
    const span = this.viewEndNs - this.viewStartNs;
    const ns = this.viewStartNs + (x / w) * span;
    // Clamp to the recorded profile bounds so dragging past the canvas edge
    // can't produce a selection that extends beyond where samples actually
    // exist (which would otherwise inflate the window size in the stats line).
    if (ns < this.profile.startNs) return this.profile.startNs;
    if (ns > this.profile.endNs)   return this.profile.endNs;
    return ns;
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

    // Bucket visible samples per-lane per-pixel per-color. C = out-of-scope + N
    // palette colors; if there are no scopes (or no Scopes instance), C is 1
    // and we degenerate to the original single-color path.
    //
    // For weighted profiles (heaptrack: weight = bytes per allocation) we sum
    // weights into buckets instead of counting, so bar height reflects byte
    // throughput rather than alloc-event density. Float64 buckets keep byte
    // sums exact for any view; Int counters are fine for the perf path but
    // we use one type to keep this loop branch-free.
    const sampleColor = this.scopes ? this.scopes.sampleColorIdx() : null;
    const C = (this.scopes && this.scopes.size() > 0) ? SCOPE_PALETTE.length + 1 : 1;
    // "Hide scoped samples" mode subtracts the in-scope samples from the
    // lanes so what's left is the unaccounted-for time. Inactive scopes
    // already contribute 0 to sampleColorIdx, so they don't subtract.
    const hideScoped = this.getHideScoped();
    const W = Math.max(1, Math.floor(w));
    const L = this.lanes.length;
    // Only sample lanes participate in tid bucketing; series lanes leave
    // their slice of `buckets` empty and get rendered separately below.
    const tidToIdx = new Map();
    this.lanes.forEach((l, i) => { if (l.tid != null) tidToIdx.set(l.tid, i); });
    const buckets = new Float64Array(W * L * C);
    const span = Math.max(1, this.viewEndNs - this.viewStartNs);
    const { times, tids, weights } = this.profile.samples;
    const lo = lowerBound(times, this.viewStartNs);
    const hi = upperBound(times, this.viewEndNs);
    for (let i = lo; i < hi; i++) {
      const li = tidToIdx.get(tids[i]);
      if (li === undefined) continue;
      const c = (C > 1 && sampleColor) ? sampleColor[i] : 0;
      if (hideScoped && c !== 0) continue;
      const px = Math.min(W - 1, Math.floor((times[i] - this.viewStartNs) / span * W));
      buckets[(li * W + px) * C + c] += weights ? weights[i] : 1;
    }

    // Bar-height denominator. For unweighted (perf) profiles we use the
    // absolute on-CPU density: each pixel covers `pixelTimeNs` of wall time
    // and at the recorded sampling rate `pixelTimeNs / nsPerSample` is the
    // most samples that could land there, so a fully on-CPU thread fills the
    // bar. For weighted (heaptrack) profiles "100%" doesn't have a fixed
    // physical meaning — bar height is byte throughput — so we normalize to
    // the local peak across the visible window: the busiest pixel-column in
    // any lane reaches the top, and quieter spans scale relative to it.
    let maxPerPixel;
    if (weights) {
      let peak = 0;
      const total = buckets.length;
      for (let i = 0; i < total; i++) if (buckets[i] > peak) peak = buckets[i];
      maxPerPixel = peak || 1;
    } else {
      const pixelTimeNs = span / W;
      const nsPerSample = this.profile.nsPerSample || pixelTimeNs;
      maxPerPixel = pixelTimeNs / nsPerSample;
    }

    for (let li = 0; li < L; li++) {
      const lane = this.lanes[li];
      const y = li * LANE_H;
      const baseY = y + 3, barH = LANE_H - 6;
      if (lane.kind === "series") {
        // Filled area chart for series lanes (live-heap, RSS, etc.). The
        // curve is sampled at heaptrack's `c` rate (~10ms), so we look up
        // the value at each pixel-column's center via binary search and
        // fill from the lane floor.
        this._drawSeriesLane(ctx, lane, baseY, barH, W);
        continue;
      }
      const rowOff = (li * W) * C;
      for (let px = 0; px < W; px++) {
        // Total weight across colors in this pixel column.
        let total = 0;
        for (let c = 0; c < C; c++) total += buckets[rowOff + px * C + c];
        if (total === 0) continue;
        const v = Math.min(1, total / maxPerPixel);
        const bh = Math.max(1, v * barH);
        // Stack from the bottom up: scope colors anchor at the lane floor
        // (so they read as the "narrative paint"), with out-of-scope lane color
        // layered above.
        let stackBottom = baseY + barH;
        for (let c = 1; c < C; c++) {
          const n = buckets[rowOff + px * C + c];
          if (n === 0) continue;
          const sh = (n / total) * bh;
          ctx.fillStyle = SCOPE_PALETTE[c - 1];
          ctx.globalAlpha = 1;
          ctx.fillRect(px, stackBottom - sh, 1, sh);
          stackBottom -= sh;
        }
        const nUnscoped = buckets[rowOff + px * C + 0];
        if (nUnscoped > 0) {
          const sh = (nUnscoped / total) * bh;
          ctx.fillStyle = lane.color;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(px, stackBottom - sh, 1, sh);
          stackBottom -= sh;
        }
      }
      ctx.globalAlpha = 1;

      if (this.selectedTids && !this.selectedTids.has(lane.tid)) {
        ctx.fillStyle = "rgba(20,20,24,0.55)";
        ctx.fillRect(0, y, w, LANE_H);
      }
    }
  }

  _drawSeriesLane(ctx, lane, baseY, barH, W) {
    const { times, bytes } = lane.series;
    const N = times.length;
    if (N === 0 || lane.peak <= 0) return;
    const span = Math.max(1, this.viewEndNs - this.viewStartNs);
    const peak = lane.peak;

    // For each pixel column, find the maximum series value within the
    // time window that pixel covers. Using max (not "value at pixel
    // center") preserves spikes when zoomed out — heaptrack's 10ms
    // sampling is much finer than per-pixel time, and a single-cell
    // spike collapsing into nothing would mislead.
    ctx.fillStyle = lane.color;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, baseY + barH);
    let prevX = 0, prevY = baseY + barH;
    let i = lowerBound(times, this.viewStartNs);
    if (i > 0) i--; // include the sample just before the window for left edge
    let nextPx = 0;
    while (i < N) {
      const tNs = times[i];
      if (tNs > this.viewEndNs) break;
      const px = Math.floor((tNs - this.viewStartNs) / span * W);
      const v = bytes[i];
      const yPos = baseY + barH - Math.min(barH, (v / peak) * barH);
      if (px > nextPx) {
        ctx.lineTo(px, prevY);
        nextPx = px;
      }
      ctx.lineTo(px, yPos);
      prevX = px;
      prevY = yPos;
      i++;
    }
    // Carry the last value to the right edge of the visible window so the
    // area doesn't dip back to zero on the right.
    ctx.lineTo(W, prevY);
    ctx.lineTo(W, baseY + barH);
    ctx.closePath();
    ctx.fill();

    // Stroke the top edge so the curve stays visible against busy backgrounds.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = lane.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    i = lowerBound(times, this.viewStartNs);
    if (i > 0) i--;
    while (i < N) {
      const tNs = times[i];
      if (tNs > this.viewEndNs) break;
      const px = (tNs - this.viewStartNs) / span * W;
      const yPos = baseY + barH - Math.min(barH, (bytes[i] / peak) * barH);
      if (!started) { ctx.moveTo(px, yPos); started = true; }
      else ctx.lineTo(px, yPos);
      i++;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
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

// True if `chain` (outer→inner) appears contiguously somewhere in
// stackFrames[off..end). The stack is inner→outer, hence the reversed
// comparison.
function containsChain(stackFrames, off, end, chain) {
  const K = chain.length;
  outer: for (let j = off; j + K <= end; j++) {
    for (let k = 0; k < K; k++) {
      if (stackFrames[j + k] !== chain[K - 1 - k]) continue outer;
    }
    return true;
  }
  return false;
}

// True if `chain` (outer→inner) sits at the innermost end of the stack —
// the first non-unknown frames going outward from `off` must be the chain's
// innermost element first, then the next outer, etc. With hideUnknown the
// rendered tree skips unknowns, so the matcher does too; otherwise unknowns
// must match positionally.
function matchAtInner(stackFrames, profile, hideUnknown, off, end, chain) {
  const K = chain.length;
  let pos = off;
  for (let k = K - 1; k >= 0; k--) {
    while (pos < end && hideUnknown && profile.isUnknown(stackFrames[pos])) pos++;
    if (pos >= end) return false;
    if (stackFrames[pos] !== chain[k]) return false;
    pos++;
  }
  return true;
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

function makeSeriesLane({ label, sublabel, series, color }) {
  // Pre-compute peak; used both for the rendering normalization and the
  // sublabel ("RSS · peak 3.12 GB"). Series may be empty for very short
  // captures, in which case peak stays 0 and the lane just shows nothing.
  const bytes = series.bytes;
  let peak = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > peak) peak = bytes[i];
  return { kind: "series", label, sublabel, color, series, peak };
}

// Every lane is painted in the accent blue. Per-thread coloring used to be
// the only signal a row carried, but scopes now own that semantic — assigning
// arbitrary colors to threads would compete with scope colors for attention,
// and would also collide with whichever lane happened to draw the scope blue.
// Yellow (#ffd24e) is owned by the hover highlight; scope colors avoid both.
function laneColor(_i) {
  return "#4ea1ff";
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
