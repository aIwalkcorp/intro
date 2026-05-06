/* Trailforge — Junction (岔路) detector
 *
 * Pure functions, no DOM. Given a GPX track and (optional) named_locations
 * dict + snaps, identify trkpts that the path visits more than once with
 * a clear directional change — these are physical 岔路 / fork points where
 * a hiker can choose between alternate destinations.
 *
 * Algorithm summary (matches plan §演算法):
 *   1. Geometric self-revisit clustering
 *      - For pairs (i, j) where trajectory length(i..j) > MIN_BRANCH_M
 *        AND haversine(track[i], track[j]) < SAME_PT_M
 *        AND bearing change at i vs j > BEARING_GATE_DEG
 *        → cluster
 *   2. Drop clusters touching trkpt[0] or trkpt[N-1] settle window
 *   3. Align cluster centroid to nearest named_location (≤ NAME_RADIUS_M)
 *      else generate "J{idx}" placeholder
 *   4. Add OSM kind='junction' POIs to results, dedupe by name
 *   5. Compute reachable destinations between consecutive cluster_idxs
 *      (highest elev / farthest point / named_location in span)
 *      reorder_enabled = (reachable.length >= 2)
 *
 * Public API:
 *   TF.junctionDetector.detect(track, named_locations, snaps, opts)
 *     → [{ name, idx, cluster_idxs, source, reachable, reorder_enabled }, ...]
 *
 * Depends on: nothing (haversine + bearing inlined to avoid coupling).
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  // ─── Constants (rationale in the plan file under §閾值決斷) ────────────
  const SAME_PT_M           = 15;   // same-point haversine threshold
  const BEARING_GATE_DEG    = 90;   // direction-change gate at revisit
  const MIN_BRANCH_M        = 500;  // minimum out-and-back trajectory length
  const NAME_RADIUS_M       = 100;  // cluster centroid → named_location alignment
  const SETTLE_WINDOW_PTS   = 10;   // ignore clusters touching ±10 pts of start/end
  const BEARING_WINDOW_PTS  = 20;   // ±N pts to compute approach bearing
  const MANUAL_GUARD_PTS    = 20;   // skip geometric write if manual anchor within ±20 idx
  const VISIT_RUN_GAP       = 30;   // sorted idxs gap > this start a new "visit" run
  const TRAILHEAD_RADIUS_M  = 200;  // trkpts within this of track[0] or track[N-1]
                                    // are treated as start/end zone, regardless
                                    // of idx — covers OB trails that loop back
                                    // to the same trailhead at very different idxs.

  // Visit-count thresholds vary by name signal (玉山主北 case: 風口 has
  // only 2 visits because the user took a ridge traverse between peaks
  // instead of returning to 風口 mid-loop. Pure geometric needs ≥3 to
  // distinguish junction from mid-trail OB self-revisit, but a name
  // keyword like 岔 / fork is a strong prior).
  const MIN_VISITS_STRONG       = 2;     // when name signals "junction" (岔/路口/…)
  const MIN_VISITS_GEOMETRIC    = 3;     // pure geometric, no name signal
  // Names containing these tokens count as strong junction signal.
  const STRONG_JUNCTION_NAME_RE = /岔|分岔|路口|交叉|三叉|丫|fork|junction|crossroad/i;
  // Names containing these tokens are PASSTHROUGH (huts, peaks, trailheads,
  // etc). Skip even if visited many times — these are destinations / way
  // points, not branching points.
  const PASSTHROUGH_NAME_RE     = /山莊|亭|登山口|接駁|車站|民宿|雲海|峰$|hut|trailhead|summit|peak$|station/i;

  // ─── Geometry helpers (inlined; do not import) ─────────────────────────
  function haversine(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  // Bearing in degrees (0–360) from p1 to p2 in (lat, lon).
  function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }
  function bearingDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  // Approach bearing at trkpt idx, averaged over a window (smooths GPS jitter).
  // Returns null if window can't be formed (too close to start/end).
  function approachBearing(track, idx, windowPts) {
    const lo = Math.max(0, idx - windowPts);
    const hi = Math.min(track.length - 1, idx + windowPts);
    if (hi <= lo) return null;
    const a = track[lo];
    const b = track[hi];
    if (!a || !b) return null;
    return bearing(a[0], a[1], b[0], b[1]);
  }
  // Cumulative distance array. cum[i] = trajectory length from track[0] to track[i].
  function cumulativeDistances(track) {
    const cum = [0];
    for (let i = 1; i < track.length; i++) {
      cum.push(cum[i - 1] + haversine(track[i-1][0], track[i-1][1], track[i][0], track[i][1]));
    }
    return cum;
  }

  // ─── Step 1: cluster self-revisits ─────────────────────────────────────
  // Returns clusters as arrays of trkpt indices that visit the same physical
  // location with directional change. O(N²) on track length — N≤800 typical
  // after Douglas-Peucker, so ~640K comparisons; fast enough without spatial
  // index (haversine is the inner cost; <50ms in practice on Bun).
  function clusterRevisits(track, opts) {
    const samePtM       = opts.samePtM       ?? SAME_PT_M;
    const bearingGate   = opts.bearingGate   ?? BEARING_GATE_DEG;
    const minBranchM    = opts.minBranchM    ?? MIN_BRANCH_M;
    const bearingWinPts = opts.bearingWinPts ?? BEARING_WINDOW_PTS;

    const cum = cumulativeDistances(track);
    const N = track.length;
    // parent[i] = root index of cluster containing i (union-find lite).
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = -1;

    function find(i) {
      let r = i;
      while (parent[r] !== -1 && parent[r] !== r) r = parent[r];
      return r;
    }
    function union(i, j) {
      const ri = find(i), rj = find(j);
      if (ri === rj) {
        if (parent[ri] === -1) parent[ri] = ri;
        return;
      }
      const root = Math.min(ri, rj);
      const other = Math.max(ri, rj);
      parent[other] = root;
      if (parent[root] === -1) parent[root] = root;
    }

    // Pair scan with trajectory-length filter (trjLen[j]-trjLen[i] > minBranchM).
    // Use cum-array binary search for the lower-bound j given each i.
    for (let i = 0; i < N; i++) {
      const minJTrjLen = cum[i] + minBranchM;
      // Linear forward scan from i+1 until cum[j] > minJTrjLen — typical
      // distance is ~ minBranchM / step_size which is small.
      let j = i + 1;
      while (j < N && cum[j] < minJTrjLen) j++;
      for (; j < N; j++) {
        const d = haversine(track[i][0], track[i][1], track[j][0], track[j][1]);
        if (d >= samePtM) continue;
        // Bearing gate: if we approach the point twice in same direction,
        // we're on the same trail (not a fork). Need a clear angle change.
        const ba = approachBearing(track, i, bearingWinPts);
        const bb = approachBearing(track, j, bearingWinPts);
        if (ba == null || bb == null) continue;
        if (bearingDiff(ba, bb) < bearingGate) continue;
        union(i, j);
      }
    }

    // Collect clusters keyed by root.
    const groups = new Map();
    for (let i = 0; i < N; i++) {
      const r = parent[i];
      if (r === -1) continue;
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    return Array.from(groups.values()).filter(g => g.length >= 2);
  }

  // ─── Step 2a: drop start/end-touching clusters ─────────────────────────
  // Two filters: (a) idx-based settle window (covers immediate trailhead
  // points), (b) coord-based trailhead-zone (covers OB trails that loop
  // back to the same trailhead at very different idxs — the玉山主北
  // GPX revisits its 塔塔加 starting area at idx 4818 even though the
  // settle window only covers ±10 pts).
  function isStartEndCluster(cluster, track, settleWin, trailheadRadiusM) {
    const w = settleWin ?? SETTLE_WINDOW_PTS;
    const r = trailheadRadiusM ?? TRAILHEAD_RADIUS_M;
    const N = track.length;
    const start = track[0], end = track[N - 1];
    for (const idx of cluster) {
      if (idx <= w) return true;
      if (idx >= N - 1 - w) return true;
      const p = track[idx];
      if (!p) continue;
      if (start && haversine(start[0], start[1], p[0], p[1]) < r) return true;
      if (end && haversine(end[0], end[1], p[0], p[1]) < r) return true;
    }
    return false;
  }

  // ─── Step 2b: count distinct visits in a cluster ───────────────────────
  // Group sorted idxs into "visit runs" where consecutive idxs are within
  // VISIT_RUN_GAP; each run = one physical visit. A true junction has
  // ≥MIN_VISITS distinct runs (you walked OUT, then came back from each
  // alternate destination → 1 + N runs for an N-way fork).
  // Mid-trail out-and-back self-revisits produce exactly 2 runs (going
  // out + coming back), so MIN_VISITS=3 cleanly filters them out.
  function visitRuns(sortedCluster, gap) {
    const g = gap ?? VISIT_RUN_GAP;
    const runs = [];
    if (!sortedCluster.length) return runs;
    let cur = [sortedCluster[0]];
    for (let i = 1; i < sortedCluster.length; i++) {
      if (sortedCluster[i] - sortedCluster[i-1] > g) {
        runs.push(cur);
        cur = [];
      }
      cur.push(sortedCluster[i]);
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  // ─── Step 3: align cluster centroid to nearest named_location ──────────
  // Returns { name, distance_m } or null. Centroid is the cluster's median
  // trkpt (geometric mean would drift on large clusters; median is robust).
  function alignToNamedLocation(cluster, track, named_locations, radiusM) {
    if (!named_locations) return null;
    const r = radiusM ?? NAME_RADIUS_M;
    // Use median trkpt as centroid.
    const mid = cluster[Math.floor(cluster.length / 2)];
    const p = track[mid];
    if (!p) return null;
    let bestName = null;
    let bestD = Infinity;
    for (const name of Object.keys(named_locations)) {
      const loc = named_locations[name];
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') continue;
      const d = haversine(loc.lat, loc.lon, p[0], p[1]);
      if (d < bestD) {
        bestD = d;
        bestName = name;
      }
    }
    if (bestName == null || bestD > r) return null;
    return { name: bestName, distance_m: Math.round(bestD) };
  }

  // ─── Step 5: compute reachable destinations ────────────────────────────
  // Between consecutive cluster idxs (a, b), the track went out-and-back
  // somewhere. The "destination" of that span is the most distinctive trkpt:
  //   1. Highest elevation point in [a..b] (if elev range > 50m)
  //   2. Else: a named_location whose snap idx ∈ [a..b]
  //   3. Else: farthest trkpt by haversine from the junction centroid
  // We label by named_location when one exists in the span; otherwise we
  // label by elevation ("頂 3950m") or distance ("J→2.4km").
  function computeReachable(cluster, track, named_locations, snaps, selfName) {
    const sorted = cluster.slice().sort((a, b) => a - b);
    if (sorted.length < 2) return [];
    // Collapse the raw cluster idxs into visit runs first, then take each
    // run's median as the visit "centroid". Pairs of consecutive centroids
    // bracket the side-trip to one alternate destination.
    const runs = visitRuns(sorted);
    if (runs.length < 2) return [];
    const centroids = runs.map(r => r[Math.floor(r.length / 2)]);
    const reachable = [];

    for (let k = 0; k < centroids.length - 1; k++) {
      const a = centroids[k];
      const b = centroids[k + 1];
      if (b - a < 5) continue;  // too short to be a real out-and-back

      // Collect ALL named_locations whose snap idx lies in (a, b) — at a
      // 3-way fork, the user descends to 主峰 AND 北峰 between two
      // 風口 visits, so we need both branches in `reachable`, not just
      // the highest-elev pick. Exclude the junction's own name (the
      // closest-snap to the centroid) so it doesn't appear as a
      // destination of itself.
      const inSpan = [];
      if (snaps && named_locations) {
        for (const name of Object.keys(snaps)) {
          if (name === selfName) continue;  // junction excluded from own reachable
          const idx = snaps[name];
          if (idx > a && idx < b) {
            const elev = (named_locations[name] && named_locations[name].ele) || null;
            inSpan.push({ name, idx, elev });
          }
        }
      }

      if (inSpan.length) {
        for (const it of inSpan) {
          reachable.push({
            to: it.name,
            via_idx_range: [a, b],
            elev_m: it.elev != null ? Math.round(it.elev) : null,
          });
        }
      } else {
        // Fallback: highest-elevation trkpt in (a, b).
        let maxElev = -Infinity, maxIdx = -1;
        for (let i = a + 1; i < b; i++) {
          const e = (track[i] && track[i][2]) || 0;
          if (e > maxElev) { maxElev = e; maxIdx = i; }
        }
        if (maxIdx >= 0) {
          reachable.push({
            to: `高點 ${Math.round(maxElev)}m`,
            via_idx_range: [a, b],
            elev_m: Math.round(maxElev),
          });
        }
      }
    }

    // Dedupe by .to (a destination might appear in multiple consecutive
    // spans if the user wandered).
    const seen = new Set();
    return reachable.filter(r => {
      if (seen.has(r.to)) return false;
      seen.add(r.to);
      return true;
    });
  }

  // ─── Main detector ─────────────────────────────────────────────────────
  // opts:
  //   samePtM, bearingGate, minBranchM, nameRadiusM, settleWin (override constants)
  //   manualAnchors: existing decision_anchors[] from plan; new geometric
  //     entries within MANUAL_GUARD_PTS of any manual idx are skipped to
  //     preserve hand-curated semantics.
  //
  // Algorithm: NAMED-LOCATION-SEEDED detection. For each named_location,
  // count how many distinct visit runs the track makes through that
  // place's coordinate. If ≥MIN_VISITS runs separated by ≥MIN_BRANCH_M
  // of trail length, it's a junction. This sidesteps union-find's
  // transitive-merge issue (where cross-trail trkpts within 15m of each
  // other got chained into 400+ point clusters that spanned multiple
  // junctions and whole trail sections).
  function detect(track, named_locations, snaps, opts) {
    opts = opts || {};
    if (!Array.isArray(track) || track.length < 10) return [];

    const N = track.length;
    const samePtM = opts.samePtM ?? SAME_PT_M;
    const minBranchM = opts.minBranchM ?? MIN_BRANCH_M;
    const settleWin = opts.settleWin ?? SETTLE_WINDOW_PTS;
    const trailheadR = opts.trailheadRadiusM ?? TRAILHEAD_RADIUS_M;
    const strongRe = opts.strongJunctionNameRe || STRONG_JUNCTION_NAME_RE;
    const passthroughRe = opts.passthroughNameRe || PASSTHROUGH_NAME_RE;

    const cum = cumulativeDistances(track);

    const manualIdxs = [];
    if (Array.isArray(opts.manualAnchors)) {
      for (const a of opts.manualAnchors) {
        if (a && typeof a.idx === 'number' && (a.source == null || a.source === 'manual')) {
          manualIdxs.push(a.idx);
        }
      }
    }
    function nearManual(idx) {
      for (const m of manualIdxs) {
        if (Math.abs(m - idx) <= MANUAL_GUARD_PTS) return true;
      }
      return false;
    }

    const out = [];
    const seenNames = new Set();

    for (const [name, loc] of Object.entries(named_locations || {})) {
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') continue;
      if (seenNames.has(name)) continue;

      // Skip passthroughs (山莊/亭/登山口/peak/etc). These are destinations
      // and waypoints, not branch points — even if visited many times.
      if (passthroughRe.test(name)) continue;

      // Visit-count threshold depends on name signal. 岔/路口 names get
      // a strong prior and only need 2 visits; unnamed/generic places
      // need 3+ to distinguish from mid-trail out-and-back self-revisit.
      const isStrong = strongRe.test(name) || loc.kind === 'junction';
      const minVisits = opts.minVisits ?? (isStrong ? MIN_VISITS_STRONG : MIN_VISITS_GEOMETRIC);

      // Collect every trkpt within samePtM of this loc.
      const idxs = [];
      for (let i = 0; i < N; i++) {
        if (haversine(loc.lat, loc.lon, track[i][0], track[i][1]) < samePtM) idxs.push(i);
      }
      if (idxs.length < minVisits) continue;
      if (isStartEndCluster(idxs, track, settleWin, trailheadR)) continue;

      // Group into visit runs (gap > VISIT_RUN_GAP starts a new visit).
      const runs = visitRuns(idxs);
      if (runs.length < minVisits) continue;

      // Each pair of consecutive visits must be separated by enough
      // trail length to count as a real branch (mid-trail OB self-
      // revisits typically fail this when MIN_BRANCH_M is generous).
      let separated = true;
      for (let k = 1; k < runs.length; k++) {
        const a = runs[k-1][runs[k-1].length - 1];
        const b = runs[k][0];
        if (cum[b] - cum[a] < minBranchM) { separated = false; break; }
      }
      if (!separated) continue;

      // First visit's centroid — where the user MAKES the decision in
      // trail order (the median or last visit would land mid-loop or
      // post-decision, less useful for chart anchor placement).
      const centroidIdx = runs[0][Math.floor(runs[0].length / 2)];
      if (nearManual(centroidIdx)) continue;

      const reachable = computeReachable(idxs, track, named_locations, snaps, name);
      out.push({
        name,
        idx: centroidIdx,
        cluster_idxs: idxs,
        source: 'geometric',
        reachable,
        reorder_enabled: reachable.length >= 2,
        label: '決策點',
        title: `${name} — 偵測為岔路（造訪 ${runs.length} 次）`,
      });
      seenNames.add(name);
    }

    // Step 4: OSM kind='junction' supplement (without geometric backing).
    // These get reorder_enabled=false unless they happen to align with a
    // geometric cluster (then they were already added above by name dedupe).
    if (named_locations) {
      for (const n of Object.keys(named_locations)) {
        const loc = named_locations[n];
        if (!loc || loc.kind !== 'junction') continue;
        if (seenNames.has(n)) continue;
        const idx = (snaps && typeof snaps[n] === 'number') ? snaps[n] : null;
        if (idx == null) continue;
        if (nearManual(idx)) continue;
        out.push({
          name: n,
          idx,
          cluster_idxs: [idx],
          source: 'osm',
          reachable: [],
          reorder_enabled: false,
          label: '決策點',
          title: `${n} — OSM 標記為岔路`,
        });
        seenNames.add(n);
      }
    }

    out.sort((a, b) => a.idx - b.idx);
    return out;
  }

  TF.junctionDetector = {
    detect,
    // Expose internals for unit testing
    _haversine: haversine,
    _bearing: bearing,
    _bearingDiff: bearingDiff,
    _clusterRevisits: clusterRevisits,
    _computeReachable: computeReachable,
    _alignToNamedLocation: alignToNamedLocation,
  };
})();
