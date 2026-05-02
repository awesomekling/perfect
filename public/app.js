import { Profile, fmtMs, fmtTimeShort, fmtNodeWeight, fmtNodeWeightLong } from "./profile.js";
import { Timeline } from "./timeline.js";
import { TreeView } from "./treeview.js";
import { SamplesView } from "./samplesview.js";
import { Scopes, PALETTE as SCOPE_PALETTE } from "./scopes.js";
import { filterSampleIndices, computeScopeStats } from "./analysis.js";

const $ = (s) => document.querySelector(s);

const els = {
  fileInfo: $("#file-info"),
  openBtn: $("#open-btn"),
  fileInput: $("#file-input"),
  emptyOpenBtn: $("#empty-open-btn"),
  empty: $("#empty"),
  loading: $("#loading"),
  loadingText: $("#loading-text"),
  dropzone: $("#dropzone"),
  profileList: $("#profile-list"),
  laneLabels: $("#lane-labels"),
  lanesCanvas: $("#lanes-canvas"),
  rulerCanvas: $("#ruler-canvas"),
  highlightCanvas: $("#highlight-canvas"),
  selectionOverlay: $("#selection-overlay"),
  resetZoom: $("#reset-zoom"),
  treeScroll: $("#tree-scroll"),
  tree: $("#tree"),
  stats: $("#stats"),
  hideUnknown: $("#hide-unknown"),
  weightKindFilter: $("#weight-kind-filter"),
  weightKind: $("#weight-kind"),
  search: $("#search"),
  searchCount: $("#search-count"),
  searchPrev: $("#search-prev"),
  searchNext: $("#search-next"),
  autoExpand: $("#auto-expand"),
  topInverted: $("#top-inverted"),
  topInvertedFilter: $("#top-inverted-filter"),
  splitter: $("#splitter"),
  timeline: $("#timeline"),
  treeFilters: $("#tree-filters"),
  treeHeaderTree: $("#tree-header-tree"),
  treeHeaderSamples: $("#tree-header-samples"),
  sampleSidebar: $("#sample-sidebar"),
  scopesSidebar: $("#scopes-sidebar"),
  scopesResizer: $("#scopes-resizer"),
  scopesList: $("#scopes-list"),
  hideScoped: $("#hide-scoped"),
  focusBreadcrumbs: $("#focus-breadcrumbs"),
};

let profile = null;
let timeline = null;
let treeView = null;
let samplesView = null;
let scopes = null;
let mode = "top";

function activeView() {
  return mode === "samples" ? samplesView : treeView;
}

async function listProfiles() {
  const r = await fetch("/api/profiles");
  if (!r.ok) return [];
  return await r.json();
}

async function loadProfileByPath(p, name) {
  showLoading(`Loading ${name || p}…`);
  try {
    const r = await fetch(`/api/profile?path=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error(await r.text());
    showLoading(`Parsing ${name || p}…`);
    const json = await r.json();
    setProfile(json, name || p);
  } catch (e) {
    alert("Failed to load: " + e.message);
  } finally {
    hideLoading();
  }
}

function setProfile(json, name) {
  profile = new Profile(json);
  els.empty.classList.add("hidden");
  let summary = "";
  if (profile.weighted) {
    // Heaptrack-style: byte total is the headline; raw kept-sample count
    // (after server-side downsampling) goes in the tooltip rather than the
    // banner.
    const totalBytes = profile.meta.totalAllocated || 0;
    summary = ` · ${fmtNodeWeight(profile, totalBytes)} allocated`;
  } else if (profile.timeKnown) {
    summary = ` · ≈${fmtTimeShort(profile.sampleCount * profile.nsPerSample)} on-CPU`;
  }
  const ev = profile.meta.eventName ? ` · ${escapeHtml(profile.meta.eventName)}` : "";
  const freq = profile.meta.sampleFreq ? ` @ ${profile.meta.sampleFreq} Hz` : "";
  els.fileInfo.innerHTML = `<b>${escapeHtml(name)}</b> · ${profile.sampleCount.toLocaleString()} samples${summary} · ${fmtMs(profile.durationNs)} elapsed · ${profile.threads.length} threads${ev}${freq}`;

  scopes = new Scopes(profile);
  scopes.onChange = onScopesChanged;

  // Metric switcher: shown only on profiles that carry multiple weight
  // kinds. Switching the active kind reroutes profile.samples.weights and
  // refreshes views — the analysis path stays oblivious.
  if (profile.weightKinds && profile.weightKinds.length > 1) {
    els.weightKind.innerHTML = "";
    for (const k of profile.weightKinds) {
      const opt = document.createElement("option");
      opt.value = k.kind; opt.textContent = k.label;
      if (k.kind === profile.weightKind) opt.selected = true;
      els.weightKind.appendChild(opt);
    }
    els.weightKindFilter.classList.remove("hidden");
  } else {
    els.weightKindFilter.classList.add("hidden");
  }
  profile.onWeightKindChange = () => {
    if (timeline) timeline.draw();
    if (activeView()) activeView().refresh();
  };

  const getHideScoped = () => els.hideScoped.checked;

  timeline = new Timeline({
    profile,
    scopes,
    laneLabelsEl: els.laneLabels,
    lanesCanvas: els.lanesCanvas,
    rulerCanvas: els.rulerCanvas,
    highlightCanvas: els.highlightCanvas,
    overlayEl: els.selectionOverlay,
    getHideScoped,
    onChange: () => activeView() && activeView().refresh(),
    onViewChange: (isFull) => els.resetZoom.classList.toggle("hidden", isFull),
  });

  const getFilter = () => ({
    startNs: timeline.selStartNs,
    endNs: timeline.selEndNs,
    tids: timeline.selectedTids,
  });

  treeView = new TreeView({
    profile,
    scopes,
    scrollEl: els.treeScroll,
    treeEl: els.tree,
    statsEl: els.stats,
    getMode: () => mode,
    getFilter,
    getHideUnknown: () => els.hideUnknown.checked,
    getHideScoped,
    getSearch: () => els.search.value,
    getAutoExpand: () => els.autoExpand.checked,
    getTopInverted: () => els.topInverted.checked,
  });
  samplesView = new SamplesView({
    profile,
    scopes,
    scrollEl: els.treeScroll,
    treeEl: els.tree,
    statsEl: els.stats,
    sidebarEl: els.sampleSidebar,
    getFilter,
    getHideScoped,
    getFocusPath: () => (treeView ? treeView._focusPath : []),
  });
  // onFocusChange fires at the end of every TreeView.refresh(), so it's a
  // convenient hook for any sidebar state that needs to reflect the current
  // view scope (filter window, focus path, hideUnknown).
  treeView.onFocusChange = (crumbs) => {
    renderFocusBreadcrumbs(crumbs);
    renderScopesSidebar();
  };
  treeView.onHoverChange = (ctx) => timeline && timeline.setHoverChain(ctx);
  treeView.onMatchesChange = (cur, total) => {
    if (!els.search.value) {
      els.searchCount.textContent = "";
      els.searchCount.classList.remove("has-matches", "no-matches");
    } else if (total === 0) {
      els.searchCount.textContent = "0/0";
      els.searchCount.classList.remove("has-matches");
      els.searchCount.classList.add("no-matches");
    } else {
      els.searchCount.textContent = `${cur + 1}/${total}`;
      els.searchCount.classList.add("has-matches");
      els.searchCount.classList.remove("no-matches");
    }
    els.searchPrev.disabled = total === 0;
    els.searchNext.disabled = total === 0;
  };
  applyModeUI();
  activeView().refresh();
  renderScopesSidebar();
}

function onScopesChanged() {
  renderScopesSidebar();
  if (timeline) timeline.scopesChanged();
  // In "hide scoped samples" mode the inRange composition depends on which
  // scopes are active, so a scope change requires a full refresh — not just
  // a row re-render — to rebuild the tree. Otherwise the tree-row dots are
  // the only thing that changed and rerenderRows is enough.
  if (els.hideScoped.checked && activeView()) {
    activeView().refresh();
  } else if (treeView) {
    treeView.rerenderRows();
  }
}

function renderScopesSidebar() {
  const list = scopes ? scopes.list() : [];
  // Sidebar is meaningful only in tree modes; samples mode owns the right-hand
  // slot for its own sidebar. Hidden when there are no scopes yet.
  const visible = list.length > 0 && mode !== "samples";
  els.scopesSidebar.classList.toggle("hidden", !visible);
  if (!visible) {
    closeColorPopover();
    els.scopesList.innerHTML = "";
    return;
  }
  // Inclusive/self percentages over the same view the Top tab uses: current
  // timeline selection × thread filter × focus path × hide-unknown. Stats
  // are recomputed on every refresh, but with ~10 scopes and a single linear
  // pass this is cheap.
  const filter = timeline
    ? { startNs: timeline.selStartNs, endNs: timeline.selEndNs, tids: timeline.selectedTids }
    : {};
  const sampleIdxs = filterSampleIndices(profile, filter);
  const focusPath = treeView ? treeView._focusPath : [];
  const hideUnknown = els.hideUnknown.checked;
  const stats = computeScopeStats(profile, list.map((m) => m.fid), { sampleIdxs, hideUnknown, focusPath });

  let html = "";
  for (const m of list) {
    const label = profile.funcLabel(m.fid);
    const dso = profile.funcDsoShort(m.fid);
    const cls = m.active ? "scope-item" : "scope-item inactive";
    const titleHint = m.active ? "Click to hide from timeline" : "Click to show in timeline";
    const s = stats.perFid.get(m.fid) || { total: 0, self: 0 };
    const totalPct = stats.denom ? (100 * s.total / stats.denom) : 0;
    const selfPct  = stats.denom ? (100 * s.self  / stats.denom) : 0;
    // Second sidebar line is the inclusive amount in whichever unit the
    // profile uses: bytes for heaptrack, time for sampled perf, raw count
    // otherwise. Same formatter as tree-row totals so the user can compare
    // across surfaces without unit-switching.
    const inclusiveTxt = fmtNodeWeight(profile, s.total);
    const statsTip = `${totalPct.toFixed(2)}% inclusive · ${selfPct.toFixed(2)}% self · ${fmtNodeWeightLong(profile, s.total)}`;
    html += `
      <div class="${cls}" data-fid="${m.fid}" title="${titleHint}">
        <button class="scope-swatch" data-swatch="1" style="background:${m.color}" title="Change color"></button>
        <div class="scope-text">
          <div class="scope-sym" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <div class="scope-dso" title="${escapeHtml(dso)}">${escapeHtml(dso)}</div>
        </div>
        <div class="scope-stats" title="${statsTip}">
          <div class="scope-total-pct">${totalPct.toFixed(1)}%</div>
          <div class="scope-self-pct">${inclusiveTxt}</div>
        </div>
        <button class="scope-del" data-del="1" title="Remove scope">×</button>
      </div>`;
  }
  els.scopesList.innerHTML = html;
  for (const item of els.scopesList.children) {
    const fid = +item.dataset.fid;
    item.querySelector("[data-swatch]").addEventListener("click", (e) => {
      e.stopPropagation();
      openColorPopover(fid, e.currentTarget);
    });
    item.querySelector("[data-del]").addEventListener("click", (e) => {
      e.stopPropagation();
      scopes.remove(fid);
    });
    // Click on the row body (not the swatch or × button) toggles whether
    // this scope contributes to timeline lane coloring. The scope stays in
    // the sidebar either way.
    item.addEventListener("click", () => scopes.toggleActive(fid));
    // Hovering a scope in the sidebar highlights every sample whose stack
    // contains the scope's function — same yellow overlay used by tree-row
    // hover. Cancel the tree's pending debounced clear first, otherwise its
    // mouseleave-scheduled null would arrive 75ms later and wipe us out.
    item.addEventListener("mouseenter", () => {
      if (!timeline) return;
      if (treeView) treeView.cancelPendingHover();
      timeline.setHoverChain({ focus: [], local: [fid], mode: "calltree", hideUnknown: false });
    });
    item.addEventListener("mouseleave", () => {
      if (timeline) timeline.setHoverChain(null);
    });
  }
}

let colorPopoverEl = null;
function openColorPopover(fid, anchorEl) {
  closeColorPopover();
  const cur = scopes.get(fid);
  if (!cur) return;
  const pop = document.createElement("div");
  pop.className = "color-popover";
  let html = "";
  for (let i = 0; i < SCOPE_PALETTE.length; i++) {
    const sel = i === cur.paletteIdx ? " selected" : "";
    html += `<button class="color-cell${sel}" data-idx="${i}" style="background:${SCOPE_PALETTE[i]}" title="${SCOPE_PALETTE[i]}"></button>`;
  }
  pop.innerHTML = html;
  document.body.appendChild(pop);
  // Position below+left of the swatch, clamped to viewport.
  const r = anchorEl.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 4;
  const margin = 6;
  if (left + pr.width + margin > window.innerWidth) left = window.innerWidth - pr.width - margin;
  if (top + pr.height + margin > window.innerHeight) top = r.top - pr.height - 4;
  pop.style.left = Math.max(margin, left) + "px";
  pop.style.top  = Math.max(margin, top)  + "px";
  for (const cell of pop.children) {
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      scopes.setColor(fid, +cell.dataset.idx);
      closeColorPopover();
    });
  }
  colorPopoverEl = pop;
  // Defer the outside-click listener so this same click doesn't immediately
  // close the popover we just opened.
  setTimeout(() => document.addEventListener("mousedown", onDocMouseDownForPopover), 0);
}
function closeColorPopover() {
  if (!colorPopoverEl) return;
  colorPopoverEl.remove();
  colorPopoverEl = null;
  document.removeEventListener("mousedown", onDocMouseDownForPopover);
}
function onDocMouseDownForPopover(e) {
  if (colorPopoverEl && !colorPopoverEl.contains(e.target)) closeColorPopover();
}

function renderFocusBreadcrumbs(crumbs) {
  const el = els.focusBreadcrumbs;
  if (!crumbs || crumbs.length === 0 || mode === "samples") {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  let html = '<span class="label">Focus:</span>';
  html += '<button class="crumb" data-depth="0" title="Back to root (unfocus)">Root</button>';
  for (let i = 0; i < crumbs.length; i++) {
    const c = crumbs[i];
    html += '<span class="sep">›</span>';
    const cls = i === crumbs.length - 1 ? "crumb current" : "crumb";
    html += `<button class="${cls}" data-depth="${c.depth}" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</button>`;
  }
  el.innerHTML = html;
  el.classList.remove("hidden");
  for (const btn of el.querySelectorAll(".crumb")) {
    btn.addEventListener("click", () => {
      if (!treeView) return;
      treeView.focusToDepth(+btn.dataset.depth);
    });
  }
}

function applyModeUI() {
  const samples = mode === "samples";
  els.treeFilters.classList.toggle("hidden", samples);
  els.treeHeaderTree.classList.toggle("hidden", samples);
  els.treeHeaderSamples.classList.toggle("hidden", !samples);
  els.sampleSidebar.classList.toggle("hidden", !samples);
  // "Show callers" only applies to Top Functions — its expansion direction
  // toggle. Hide elsewhere so it doesn't suggest it affects other views.
  els.topInvertedFilter.classList.toggle("hidden", mode !== "top");
  // Breadcrumb is only meaningful for tree views. Hide now; the subsequent
  // tree refresh (if any) will re-show it if a focus is active.
  if (samples) els.focusBreadcrumbs.classList.add("hidden");
  // Hover highlight is driven by the tree; clear it when leaving tree modes.
  if (samples && timeline) timeline.setHoverChain(null);
  // Both views share the same scroll element. Detach the inactive one so its
  // scroll handler can't trample the active one's rendering.
  if (samples) { treeView.detach(); samplesView.attach(); }
  else         { samplesView.detach(); treeView.attach(); }
  els.tree.innerHTML = "";
  els.tree.style.height = "0px";
  els.treeScroll.scrollTop = 0;
  // Scopes sidebar shares the right-hand slot with the samples sidebar; only
  // one is shown at a time, and it stays hidden when there are no scopes yet.
  renderScopesSidebar();
}

function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.classList.remove("hidden");
}
function hideLoading() {
  els.loading.classList.add("hidden");
}

// ----- Mode tabs -----
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.remove("active");
    tab.classList.add("active");
    mode = tab.dataset.mode;
    if (!treeView) return;
    applyModeUI();
    activeView().refresh();
  });
}

els.hideUnknown.addEventListener("change", () => treeView && treeView.refresh());
els.weightKind.addEventListener("change", () => {
  if (profile) profile.setActiveWeightKind(els.weightKind.value);
});
els.hideScoped.addEventListener("change", () => {
  if (timeline) timeline.draw();
  if (activeView()) activeView().refresh();
});
els.topInverted.addEventListener("change", () => treeView && treeView.refresh());
els.autoExpand.addEventListener("change", () => {
  if (!treeView) return;
  treeView._currentMatch = -1; // re-anchor to first match for the new tree
  treeView.refresh();
  treeView.resetMatchCursor();
});

let searchTimer;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!treeView) return;
    treeView._currentMatch = -1;
    treeView.refresh();
    treeView.resetMatchCursor();
  }, 120);
});
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!treeView) return;
    treeView.nextMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    els.search.value = "";
    els.search.dispatchEvent(new Event("input"));
  }
});
els.searchPrev.addEventListener("click", () => treeView && treeView.nextMatch(-1));
els.searchNext.addEventListener("click", () => treeView && treeView.nextMatch(1));

// ----- Keyboard tree navigation -----
window.addEventListener("keydown", (e) => {
  if (!treeView) return;
  // Don't steal keys when the user is typing in an input.
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const view = activeView();
  const endIdx = mode === "samples" ? samplesView.samples.length - 1 : treeView.flatRows.length - 1;
  switch (e.key) {
    case "ArrowDown":  e.preventDefault(); view.moveSelection(1); break;
    case "ArrowUp":    e.preventDefault(); view.moveSelection(-1); break;
    case "ArrowLeft":  e.preventDefault(); view.collapseOrParent(); break;
    case "ArrowRight": e.preventDefault(); view.expandOrChild(); break;
    case "PageDown":   e.preventDefault(); view.movePage(1); break;
    case "PageUp":     e.preventDefault(); view.movePage(-1); break;
    case "Home":       e.preventDefault(); view.selectAt(0); break;
    case "End":        e.preventDefault(); view.selectAt(endIdx); break;
    case "Enter":
    case " ":          e.preventDefault(); view.toggleSelected(); break;
    case "/":          if (mode !== "samples") { e.preventDefault(); els.search.focus(); els.search.select(); } break;
    case "f": case "F":
      if (mode !== "samples") { e.preventDefault(); treeView.focusSelected(); }
      break;
    case "s": case "S":
      if (mode !== "samples" && scopes) {
        const fid = treeView.selectedFid();
        if (fid != null) { e.preventDefault(); scopes.toggle(fid); }
      }
      break;
    case "0":          if (timeline) { e.preventDefault(); timeline.resetView(); } break;
    case "+":
    case "=":          if (timeline) { e.preventDefault(); zoomCentered(0.5); } break;
    case "-":
    case "_":          if (timeline) { e.preventDefault(); zoomCentered(2); } break;
  }
});

function zoomCentered(factor) {
  const center = (timeline.viewStartNs + timeline.viewEndNs) / 2;
  timeline.zoom(factor, center);
}

els.resetZoom.addEventListener("click", () => timeline && timeline.resetView());

// ----- File picker / drag-drop -----
els.openBtn.addEventListener("click", () => els.fileInput.click());
els.emptyOpenBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  await uploadAndLoad(f);
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.remove("hidden");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.add("hidden"); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.add("hidden");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  await uploadAndLoad(f);
});

async function uploadAndLoad(file) {
  // Try server-side lookup first (avoids the upload entirely if it's a known file).
  const list = await listProfiles();
  const match = list.find((p) => p.name === file.name && p.size === file.size);
  if (match) {
    await loadProfileByPath(match.path, file.name);
    return;
  }
  // Otherwise stream the file body up to /api/upload and then fetch by returned path.
  showLoading(`Uploading ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`);
  try {
    const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    if (!r.ok) throw new Error(await r.text());
    const { path: uploadedPath } = await r.json();
    await loadProfileByPath(uploadedPath, file.name);
  } catch (e) {
    alert("Upload failed: " + e.message);
    hideLoading();
  }
}

// ----- Splitter -----
{
  let drag = null;
  els.splitter.addEventListener("mousedown", (e) => {
    drag = { startY: e.clientY, startH: els.timeline.getBoundingClientRect().height };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const h = Math.max(80, drag.startH + dy);
    els.timeline.style.flex = `0 0 ${h}px`;
    if (timeline) timeline.resize();
  });
  window.addEventListener("mouseup", () => { drag = null; });
}

// ----- Scopes sidebar resizer -----
// Dragging the left edge widens / narrows the scopes sidebar. Width is held
// inline so it persists for the session even if the sidebar is hidden and
// reshown (e.g. all scopes removed, then a new one added).
{
  let drag = null;
  els.scopesResizer.addEventListener("mousedown", (e) => {
    drag = { startX: e.clientX, startW: els.scopesSidebar.getBoundingClientRect().width };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = drag.startX - e.clientX; // dragging left = wider
    const w = Math.max(220, Math.min(800, drag.startW + dx));
    els.scopesSidebar.style.flex = `0 0 ${w}px`;
  });
  window.addEventListener("mouseup", () => { drag = null; });
}

// ----- Initial profile list -----
async function initEmpty() {
  const list = await listProfiles();
  els.profileList.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pname">No .data files in cwd</span>`;
    li.style.cursor = "default";
    els.profileList.appendChild(li);
    return;
  }
  for (const p of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="pmeta">${(p.size / 1024 / 1024).toFixed(1)} MB</span>`;
    li.addEventListener("click", () => loadProfileByPath(p.path, p.name));
    els.profileList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

initEmpty();

// auto-load via ?profile=perf.data
{
  const p = new URLSearchParams(location.search).get("profile");
  if (p) loadProfileByPath(p, p);
}
