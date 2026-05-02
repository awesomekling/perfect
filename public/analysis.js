// Pure profile analysis — no DOM, no view state. Imported by the browser UI
// (treeview.js) and by the server's agent-facing endpoints, so both see the
// exact same aggregates from the exact same code.
//
// Every function takes a Profile plus plain options, and returns a tree of
// nodes shaped { id, fid, total, self, children: Map<fid, node> }. Callers
// own the rendering / serialization / pruning.

// Synthetic fid used in the inverted tree to represent samples whose stack
// was truncated at a given node (i.e. perf couldn't unwind any further).
export const TRUNCATED_FID = -2;
// Only attach a [truncated] child when the gap is at least this fraction of
// the node's total — below that, it's just noise.
export const TRUNCATION_THRESHOLD = 0.05;

export function filterSampleIndices(profile, { startNs, endNs, tids } = {}) {
  const { times, tids: stids } = profile.samples;
  const s = startNs ?? profile.startNs;
  const e = endNs ?? profile.endNs;
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < s || t > e) continue;
    if (tids && !tids.has(stids[i])) continue;
    out.push(i);
  }
  return out;
}

// Find the innermost position `j` in `stack[off..end)` such that, starting
// from `j`, the stack (inner→outer) matches `focusPath` reversed. Returns
// `j` (the focused frame's index) or -1 if the chain isn't present.
// `focusPath` is stored in outer→inner order (same as call-stack notation),
// while the stack array is inner→outer, hence the reversed comparison.
export function findFocusJ(stackFrames, off, end, focusPath) {
  const K = focusPath.length;
  outer: for (let j = off; j + K <= end; j++) {
    for (let k = 0; k < K; k++) {
      if (stackFrames[j + k] !== focusPath[K - 1 - k]) continue outer;
    }
    return j;
  }
  return -1;
}

function makeCtx() { return { nodeId: 0 }; }
function newNode(ctx, fid) {
  return { id: ++ctx.nodeId, fid, total: 0, self: 0, totalCount: 0, selfCount: 0, children: new Map() };
}

// node.total / node.self semantics:
//   - unweighted profiles (perf):       sample counts (each sample contributes 1)
//   - weighted profiles   (heaptrack):  sum of per-sample weights (e.g. bytes)
// `weights` below is `profile.samples.weights || null`, hoisted out of the
// hot loop so the unweighted path doesn't pay for a branch per sample.
//
// node.totalCount / node.selfCount: when the profile carries an `alloc-count`
// weight column (heaptrack), each node also accumulates the underlying
// allocation count alongside its bytes total. The view layer can then
// render "5 GB · 1.2k allocations" and the user can tell a single big
// allocation apart from many small ones. Stays 0 on profiles without an
// alloc-count column.
function countWeightsOf(profile) {
  return profile.samples._byKind ? (profile.samples._byKind["alloc-count"] || null) : null;
}

export function buildCallTree(profile, { sampleIdxs, inverted = false, hideUnknown = false, focusPath = [] } = {}) {
  const ctx = makeCtx();
  const root = newNode(ctx, -1);
  const { stackOffsets, stackFrames, weights } = profile.samples;
  const counts = countWeightsOf(profile);
  const hasFocus = focusPath.length > 0;
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
      const focusedJ = findFocusJ(stackFrames, sampleOff, sampleEnd, focusPath);
      if (focusedJ < 0) continue;
      off = sampleOff;
      end = focusedJ + 1;
    }
    const w = weights ? weights[i] : 1;
    const cw = counts ? counts[i] : 0;
    let cur = root;
    root.total += w;
    root.totalCount += cw;
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
        child = newNode(ctx, fid);
        cur.children.set(fid, child);
      }
      child.total += w;
      child.totalCount += cw;
      cur = child;
      if (!firstChild) firstChild = child;
      lastChild = child;
    });
    // Self belongs on the sample's leaf frame. In the tree, the leaf is the
    // last child for calltree (walked outer→inner) and the first child for
    // inverted (walked inner→outer, so the innermost/leaf is reached first).
    const leafNode = inverted ? firstChild : lastChild;
    if (leafNode) {
      leafNode.self += w;
      leafNode.selfCount += cw;
    }
  }
  if (inverted) attachTruncation(ctx, root, TRUNCATION_THRESHOLD, focusPath);
  return root;
}

// Walk the tree and, for any node whose children's totals don't add up to
// its own, add a synthetic [truncated] child representing the gap. In the
// inverted view, the gap = samples where perf couldn't unwind past this
// frame, which otherwise shows up as "memcpy has 200ms self but its
// callers only sum to 10ms" — surfacing it makes the missing time obvious.
function attachTruncation(ctx, node, threshold, focusPath) {
  // The focused frame is the new "root" of every trimmed stack, so its
  // missing callers are intentional — not perf's fault. Skip it.
  const focusedFid = focusPath.length > 0 ? focusPath[focusPath.length - 1] : -1;
  if (node.fid !== -1 && node.fid !== focusedFid) {
    let sum = 0;
    for (const c of node.children.values()) sum += c.total;
    const gap = node.total - sum;
    if (gap > 0 && gap >= node.total * threshold) {
      const t = newNode(ctx, TRUNCATED_FID);
      t.total = gap;
      node.children.set(TRUNCATED_FID, t);
    }
  }
  // Snapshot before recursing, since we may have just mutated the map.
  const kids = [...node.children.values()];
  for (const c of kids) {
    if (c.fid !== TRUNCATED_FID) attachTruncation(ctx, c, threshold, focusPath);
  }
}

// Top Functions: each unique function is a top-level row; expanding aggregates
// the *callees* below that function across all stacks where it appears.
// Recursion: only the innermost occurrence of fid in a sample contributes
// to its callees (so we don't double-count recursive frames).
export function buildTopFunctions(profile, { sampleIdxs, hideUnknown = false, focusPath = [] } = {}) {
  const ctx = makeCtx();
  const F = profile.functions.length;
  // Float64 so weighted (heaptrack-style) byte sums don't overflow Int32 or
  // lose precision past 2^24. For unweighted profiles we'd be fine with Int32
  // but the memory delta on F-sized arrays is negligible (kB) and a single
  // type keeps the hot loop branch-free.
  const totals = new Float64Array(F);
  const selfs = new Float64Array(F);
  const counts = countWeightsOf(profile);
  const totalCounts = counts ? new Float64Array(F) : null;
  const selfCounts  = counts ? new Float64Array(F) : null;
  const seenStamp = new Int32Array(F);
  let stamp = 0;
  const { stackOffsets, stackFrames, weights } = profile.samples;
  const hasFocus = focusPath.length > 0;
  // When focused: only count frames at/below the focused frame in each
  // matching sample. Samples that don't contain the focus chain drop out
  // entirely, and lazy expansion below is re-scoped the same way.
  const matching = hasFocus ? [] : sampleIdxs;
  let rootTotal = 0;
  let rootCount = 0;
  for (const i of sampleIdxs) {
    stamp++;
    const off = stackOffsets[i];
    const sampleEnd = stackOffsets[i + 1];
    let end = sampleEnd;
    if (hasFocus) {
      const focusedJ = findFocusJ(stackFrames, off, sampleEnd, focusPath);
      if (focusedJ < 0) continue;
      end = focusedJ + 1;
      matching.push(i);
    }
    const w = weights ? weights[i] : 1;
    const cw = counts ? counts[i] : 0;
    rootTotal += w;
    rootCount += cw;
    if (end > off) {
      const leaf = stackFrames[off];
      if (!(hideUnknown && profile.isUnknown(leaf))) {
        selfs[leaf] += w;
        if (selfCounts) selfCounts[leaf] += cw;
      }
    }
    for (let j = off; j < end; j++) {
      const fid = stackFrames[j];
      if (hideUnknown && profile.isUnknown(fid)) continue;
      if (seenStamp[fid] === stamp) continue;
      seenStamp[fid] = stamp;
      totals[fid] += w;
      if (totalCounts) totalCounts[fid] += cw;
    }
  }
  const root = newNode(ctx, -1);
  root.total = rootTotal;
  root.totalCount = rootCount;
  for (let fid = 0; fid < F; fid++) {
    if (totals[fid] === 0) continue;
    const node = newNode(ctx, fid);
    node.total = totals[fid];
    node.self = selfs[fid];
    if (totalCounts) {
      node.totalCount = totalCounts[fid];
      node.selfCount = selfCounts[fid];
    }
    // Mark as lazy: children built on demand via expandTopFunction().
    node._lazy = true;
    node._lazySamples = matching;
    node._lazyFid = fid;
    node._ctx = ctx;
    root.children.set(fid, node);
  }
  return root;
}

// Materialize a lazy Top-Functions node's subtree. Safe to call on any node
// (no-op if not lazy). Mutates the node.
//
// `inverted=false` (default) expands callees: for each sample containing
// fid, find the innermost occurrence and walk inward to the leaf. The
// outermost-occurrence + walk-outward symmetry is `inverted=true`, which
// expands callers instead. Either direction guarantees descendant counts
// are bounded by the ancestor's count, because each descendant entry
// passes through the same single fid occurrence per sample.
//
// Descendants are NOT marked lazy: their children were populated on this
// Per-fid total/self counts for a small set of scoped fids over the given
// filtered samples. Mirrors buildTopFunctions semantics — recursion-deduped
// totals, leaf counted at the actual stack innermost, focus-path scoped —
// but skips the tree build since the scopes sidebar only needs scalars for
// ~10 fids. `denom` is the number of samples that survived focus filtering
// (matches Top Functions' percentage denominator).
export function computeScopeStats(profile, scopedFids, { sampleIdxs, hideUnknown = false, focusPath = [] } = {}) {
  const perFid = new Map();
  for (const fid of scopedFids) perFid.set(fid, { total: 0, self: 0 });
  if (scopedFids.length === 0 || !sampleIdxs || sampleIdxs.length === 0) {
    return { denom: 0, perFid };
  }
  const F = profile.functions.length;
  const inScope = new Uint8Array(F);
  for (const fid of scopedFids) if (fid >= 0 && fid < F) inScope[fid] = 1;
  const totals = new Float64Array(F);
  const selfs = new Float64Array(F);
  const seenStamp = new Int32Array(F);
  let stamp = 0;
  const { stackOffsets, stackFrames, weights } = profile.samples;
  const hasFocus = focusPath.length > 0;
  let denom = 0;
  for (const i of sampleIdxs) {
    stamp++;
    const off = stackOffsets[i];
    const sampleEnd = stackOffsets[i + 1];
    let end = sampleEnd;
    if (hasFocus) {
      const focusedJ = findFocusJ(stackFrames, off, sampleEnd, focusPath);
      if (focusedJ < 0) continue;
      end = focusedJ + 1;
    }
    const w = weights ? weights[i] : 1;
    denom += w;
    if (end > off) {
      const leaf = stackFrames[off];
      if (inScope[leaf] && !(hideUnknown && profile.isUnknown(leaf))) selfs[leaf] += w;
    }
    for (let j = off; j < end; j++) {
      const fid = stackFrames[j];
      if (!inScope[fid]) continue;
      if (hideUnknown && profile.isUnknown(fid)) continue;
      if (seenStamp[fid] === stamp) continue;
      seenStamp[fid] = stamp;
      totals[fid] += w;
    }
  }
  for (const fid of scopedFids) {
    if (fid >= 0 && fid < F) perFid.set(fid, { total: totals[fid], self: selfs[fid] });
  }
  return { denom, perFid };
}

// same walk. That avoids the old bug where re-expanding a child re-walked
// *all* samples containing that child (including paths that never passed
// through the parent top function), producing descendant costs that
// exceeded their ancestors.
export function expandTopFunction(profile, node, { hideUnknown = false, focusPath = [], inverted = false } = {}) {
  if (!node._lazy) return;
  node._lazy = false;
  const ctx = node._ctx;
  const { stackOffsets, stackFrames, weights } = profile.samples;
  const counts = countWeightsOf(profile);
  const fid = node._lazyFid;
  const hasFocus = focusPath.length > 0;
  for (const i of node._lazySamples) {
    const off = stackOffsets[i];
    const sampleEnd = stackOffsets[i + 1];
    // When focused, the lazy expansion must stay inside the same trimmed
    // window that buildTopFunctions counted against — otherwise an expanded
    // child could end up with more samples than its parent top-row.
    let end = sampleEnd;
    if (hasFocus) {
      const focusedJ = findFocusJ(stackFrames, off, sampleEnd, focusPath);
      if (focusedJ < 0) continue;
      end = focusedJ + 1;
    }
    let k = -1;
    if (inverted) {
      // Outermost occurrence: scan from end-1 back toward off.
      for (let j = end - 1; j >= off; j--) {
        if (stackFrames[j] === fid) { k = j; break; }
      }
    } else {
      // Innermost occurrence: scan from off out toward end-1.
      for (let j = off; j < end; j++) {
        if (stackFrames[j] === fid) { k = j; break; }
      }
    }
    if (k < 0) continue;
    const w = weights ? weights[i] : 1;
    const cw = counts ? counts[i] : 0;
    let cur = node;
    let lastChild = null;
    if (inverted) {
      // Walk outward (callers).
      for (let j = k + 1; j < end; j++) {
        const cfid = stackFrames[j];
        if (hideUnknown && profile.isUnknown(cfid)) continue;
        let child = cur.children.get(cfid);
        if (!child) {
          child = newNode(ctx, cfid);
          cur.children.set(cfid, child);
        }
        child.total += w;
        child.totalCount += cw;
        cur = child;
        lastChild = child;
      }
      // No self contribution on caller chains: "self" only makes sense for
      // leaf-side frames, and node.self (the leaf-side weight of fid itself)
      // was already set in buildTopFunctions.
    } else {
      // Walk inward (callees).
      for (let j = k - 1; j >= off; j--) {
        const cfid = stackFrames[j];
        if (hideUnknown && profile.isUnknown(cfid)) continue;
        let child = cur.children.get(cfid);
        if (!child) {
          child = newNode(ctx, cfid);
          cur.children.set(cfid, child);
        }
        child.total += w;
        child.totalCount += cw;
        cur = child;
        lastChild = child;
      }
      if (lastChild) {
        lastChild.self += w;
        lastChild.selfCount += cw;
      }
      // If fid was the innermost frame (k === off), node.self was already
      // counted in buildTopFunctions — don't double-count.
    }
  }
  node._lazySamples = null;
  node._ctx = null;
}

export function sortChildren(node) {
  const arr = [...node.children.values()];
  arr.sort((a, b) => b.total - a.total || b.self - a.self);
  return arr;
}
