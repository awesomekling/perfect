import { Profile, fmtMs } from "./profile.js";
import { Timeline } from "./timeline.js";
import { TreeView } from "./treeview.js";

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
  selectionOverlay: $("#selection-overlay"),
  treeScroll: $("#tree-scroll"),
  tree: $("#tree"),
  stats: $("#stats"),
  hideUnknown: $("#hide-unknown"),
  search: $("#search"),
  searchCount: $("#search-count"),
  searchPrev: $("#search-prev"),
  searchNext: $("#search-next"),
  autoExpand: $("#auto-expand"),
  splitter: $("#splitter"),
  timeline: $("#timeline"),
};

let profile = null;
let timeline = null;
let treeView = null;
let mode = "calltree";

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
  els.fileInfo.innerHTML = `<b>${escapeHtml(name)}</b> · ${profile.sampleCount.toLocaleString()} samples · ${fmtMs(profile.durationNs)} · ${profile.threads.length} threads · ${profile.functions.length.toLocaleString()} functions`;

  timeline = new Timeline({
    profile,
    laneLabelsEl: els.laneLabels,
    lanesCanvas: els.lanesCanvas,
    rulerCanvas: els.rulerCanvas,
    overlayEl: els.selectionOverlay,
    onChange: () => treeView.refresh(),
  });

  treeView = new TreeView({
    profile,
    scrollEl: els.treeScroll,
    treeEl: els.tree,
    statsEl: els.stats,
    getMode: () => mode,
    getFilter: () => ({
      startNs: timeline.selStartNs,
      endNs: timeline.selEndNs,
      tids: timeline.selectedTids,
    }),
    getHideUnknown: () => els.hideUnknown.checked,
    getSearch: () => els.search.value,
    getAutoExpand: () => els.autoExpand.checked,
  });
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
  treeView.refresh();
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
    if (treeView) treeView.refresh();
  });
}

els.hideUnknown.addEventListener("change", () => treeView && treeView.refresh());
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
  switch (e.key) {
    case "ArrowDown":  e.preventDefault(); treeView.moveSelection(1); break;
    case "ArrowUp":    e.preventDefault(); treeView.moveSelection(-1); break;
    case "ArrowLeft":  e.preventDefault(); treeView.collapseOrParent(); break;
    case "ArrowRight": e.preventDefault(); treeView.expandOrChild(); break;
    case "PageDown":   e.preventDefault(); treeView.movePage(1); break;
    case "PageUp":     e.preventDefault(); treeView.movePage(-1); break;
    case "Home":       e.preventDefault(); treeView.selectAt(0); break;
    case "End":        e.preventDefault(); treeView.selectAt(treeView.flatRows.length - 1); break;
    case "Enter":
    case " ":          e.preventDefault(); treeView.toggleSelected(); break;
    case "/":          e.preventDefault(); els.search.focus(); els.search.select(); break;
  }
});

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

// ----- Initial profile list -----
async function initEmpty() {
  const list = await listProfiles();
  els.profileList.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pname">No perf.data files in cwd</span>`;
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
