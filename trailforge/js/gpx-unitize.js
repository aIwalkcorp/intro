/* Trailforge — GPX unitizer (PR-26)
 *
 * Slices a GPX track into atomic legs at every named-waypoint visit,
 * then recomposes per-segment stats by finding the shortest leg path
 * matching each rest-points entry. Mirrors scripts/recompute-gpx-stats.py
 * so server/migration and client/upload share one algorithm.
 *
 * Why: the recorded GPX is one continuous trace, but the rest-points
 * table can describe many LOGICAL routes through it (D2A vs D2B). A
 * naive walker that slices anchor_idx[0..1] silently includes detours
 * — D2B's 主峰→排雲 was 7.31km because the slice spanned the 北峰 loop.
 * Unitization separates "what was recorded" from "what was planned".
 *
 * Public API (TF.gpxUnitize):
 *   detectVisits(track, named, opts)        → [(idx, canonName), ...]
 *   buildLegs(track, visits)                → [{from,to,lo,hi,km,asc,desc}]
 *   findPath(legs, fr, to)                  → [legIdx,...] | null
 *   recomputeSegmentStats(plan, ref)        → { updated: [...], skipped: [...] }
 *
 * Coordinate-equal aliases (e.g. 主峰/玉山主峰 share lat/lon) collapse
 * to one canonical name at visit-detection time so consecutive same-name
 * visits don't fight at the same idx. Plan-segment names go through the
 * same canon() before matching.
 */
(function () {
  const TF = window.TF = window.TF || {};

  const DEFAULT_THRESHOLD_M = 80;

  // Static aliases that the玉山 demo + most TW hiking plans use. New
  // aliases get auto-detected via lat/lon equality below, so this list
  // is just a tiebreaker for dedupe ordering.
  const STATIC_ALIASES = {
    '北峰': '玉山北峰',
    '主峰': '玉山主峰',
    '主北岔': '主北岔(風口)',
  };

  // Build the canon map from named_locations: any pair of names whose
  // lat/lon are identical (within 1e-5 deg ≈ 1m) get aliased — the
  // longer name wins (heuristic: full name is canonical).
  function buildCanon(named) {
    const map = Object.assign({}, STATIC_ALIASES);
    if (!named) return map;
    const entries = Object.entries(named);
    for (let i = 0; i < entries.length; i++) {
      const [n1, l1] = entries[i];
      if (!l1 || l1.lat == null || l1.lon == null) continue;
      for (let j = i + 1; j < entries.length; j++) {
        const [n2, l2] = entries[j];
        if (!l2 || l2.lat == null || l2.lon == null) continue;
        if (Math.abs(l1.lat - l2.lat) < 1e-5 && Math.abs(l1.lon - l2.lon) < 1e-5) {
          // Same coords — pick the longer name as canonical.
          const [shorter, longer] = n1.length >= n2.length ? [n2, n1] : [n1, n2];
          if (!map[shorter]) map[shorter] = longer;
        }
      }
    }
    return map;
  }

  function canonName(name, canonMap) {
    if (!name) return '';
    return (canonMap && canonMap[name]) || name;
  }

  // ─── Geometry ──────────────────────────────────────────────────
  function haversineMeters(a1, o1, a2, o2) {
    const R = 6371000;
    const p1 = a1 * Math.PI / 180;
    const p2 = a2 * Math.PI / 180;
    const dl = (a2 - a1) * Math.PI / 180;
    const dlon = (o2 - o1) * Math.PI / 180;
    const a = Math.sin(dl/2) ** 2
            + Math.cos(p1) * Math.cos(p2) * Math.sin(dlon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function sliceStats(track, lo, hi) {
    let dist = 0, asc = 0, desc = 0;
    for (let i = lo + 1; i <= hi; i++) {
      const p0 = track[i - 1], p1 = track[i];
      if (!p0 || !p1) continue;
      dist += haversineMeters(p0[0], p0[1], p1[0], p1[1]);
      const de = (p1[2] || 0) - (p0[2] || 0);
      if (de > 0) asc += de; else desc -= de;
    }
    return { km: dist / 1000, asc, desc };
  }

  // ─── Visit detection (multi-visit per location) ────────────────
  function detectVisits(track, named, opts) {
    opts = opts || {};
    const thresholdM = opts.thresholdM || DEFAULT_THRESHOLD_M;
    const canonMap = opts.canonMap || buildCanon(named);
    if (!Array.isArray(track) || !named) return [];

    const visits = [];
    for (const [name, loc] of Object.entries(named)) {
      if (!loc || loc.lat == null || loc.lon == null) continue;
      const cname = canonName(name, canonMap);
      let inVisit = false;
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < track.length; i++) {
        const p = track[i];
        if (!p) continue;
        const d = haversineMeters(loc.lat, loc.lon, p[0], p[1]);
        if (d < thresholdM) {
          if (!inVisit) { inVisit = true; bestIdx = i; bestDist = d; }
          else if (d < bestDist) { bestIdx = i; bestDist = d; }
        } else if (inVisit) {
          visits.push([bestIdx, cname]);
          inVisit = false; bestIdx = -1; bestDist = Infinity;
        }
      }
      if (inVisit) visits.push([bestIdx, cname]);
    }
    visits.sort((a, b) => a[0] - b[0]);

    // Dedupe consecutive same-canon visits — keep the smallest idx in
    // each cluster. Covers both threshold-flicker and alias collisions.
    const out = [];
    for (const v of visits) {
      if (out.length && out[out.length - 1][1] === v[1]) {
        if (v[0] < out[out.length - 1][0]) out[out.length - 1] = v;
        continue;
      }
      out.push(v);
    }
    return out;
  }

  // ─── Leg catalogue ─────────────────────────────────────────────
  function buildLegs(track, visits) {
    const legs = [];
    for (let i = 0; i < visits.length - 1; i++) {
      const [lo, fr] = visits[i];
      const [hi, to] = visits[i + 1];
      if (hi <= lo) continue;
      const s = sliceStats(track, lo, hi);
      legs.push({ from: fr, to, lo, hi, km: s.km, asc: s.asc, desc: s.desc });
    }
    return legs;
  }

  // ─── Shortest-path search (Dijkstra on leg DAG) ────────────────
  function findPath(legs, fr, to, opts) {
    opts = opts || {};
    const maxLegs = opts.maxLegs || 8;
    if (!Array.isArray(legs) || legs.length === 0) return null;

    // Min-heap simulation via sorted insert (small N — fine for ≤20 legs).
    const frontier = [];
    const push = (km, path) => {
      let i = 0;
      while (i < frontier.length && frontier[i].km <= km) i++;
      frontier.splice(i, 0, { km, path });
    };
    const seen = Object.create(null);

    for (let i = 0; i < legs.length; i++) {
      if (legs[i].from === fr) push(legs[i].km, [i]);
    }
    while (frontier.length) {
      const { km, path } = frontier.shift();
      const last = legs[path[path.length - 1]];
      const cur = last.to;
      if (cur === to) return path.slice();
      if (seen[cur] != null && seen[cur] <= km) continue;
      seen[cur] = km;
      if (path.length >= maxLegs) continue;
      for (let j = 0; j < legs.length; j++) {
        if (legs[j].from !== cur) continue;
        push(km + legs[j].km, path.concat(j));
      }
    }
    return null;
  }

  // ─── Main entry: walk plan segments, rewrite stats + anchor_idx ──
  // Returns { updated: [{where, from, to, oldKm, newKm, ...}], skipped: [...] }
  function recomputeSegmentStats(plan, ref, opts) {
    opts = opts || {};
    if (!plan) return { updated: [], skipped: [] };
    const tracks = plan.data && plan.data.gpx_tracks;
    const track = tracks && tracks[ref];
    const named = plan.data && plan.data.named_locations;
    if (!Array.isArray(track) || track.length < 2 || !named) {
      return { updated: [], skipped: [], reason: 'missing track or named_locations' };
    }

    const canonMap = buildCanon(named);
    const visits = detectVisits(track, named, { canonMap });
    const legs = buildLegs(track, visits);

    const updated = [];
    const skipped = [];

    function processSegs(segs, where) {
      if (!Array.isArray(segs)) return;
      for (const s of segs) {
        if (!s || s.is_rest_stop) continue;
        const fr = canonName(s.from, canonMap);
        const to = canonName(s.to, canonMap);
        let path = findPath(legs, fr, to);
        let reversed = false;
        if (!path) { path = findPath(legs, to, fr); reversed = true; }
        if (!path) { skipped.push({ where, from: s.from, to: s.to }); continue; }

        let km = 0, asc = 0, desc = 0;
        for (const idx of path) { km += legs[idx].km; asc += legs[idx].asc; desc += legs[idx].desc; }

        const old = { km: s.distance_km, asc: s.ascent_m, desc: s.descent_m };
        s.distance_km = +(km).toFixed(2);
        s.ascent_m  = Math.round(reversed ? desc : asc);
        s.descent_m = Math.round(reversed ? asc  : desc);

        const first = legs[path[0]], last = legs[path[path.length - 1]];
        s.anchor_idx = reversed ? [last.hi, first.lo] : [first.lo, last.hi];

        updated.push({
          where, from: s.from, to: s.to, reversed, legs: path.length,
          oldKm: old.km, newKm: s.distance_km,
          oldAsc: old.asc, newAsc: s.ascent_m,
          oldDesc: old.desc, newDesc: s.descent_m,
        });
      }
    }

    // Walk every day whose ep.gpx_ref (or seg.gpx_ref) matches the
    // requested ref. Both the day's default segments and per-variant
    // segment arrays get re-stats'd from the same catalogue.
    for (const d of plan.days || []) {
      const ep = d.elevation_profile;
      if (!ep) continue;
      const dayRef = ep.gpx_ref || d.id;
      if (dayRef !== ref) continue;
      if (Array.isArray(ep.shanghe_segments)) processSegs(ep.shanghe_segments, d.id);
      const rv = ep.route_variants || {};
      for (const [vid, v] of Object.entries(rv)) {
        if (Array.isArray(v.shanghe_segments)) processSegs(v.shanghe_segments, `${d.id}/${vid}`);
      }
    }

    return { updated, skipped, visits, legs };
  }

  TF.gpxUnitize = {
    detectVisits, buildLegs, findPath, recomputeSegmentStats,
    buildCanon, canonName, haversineMeters,
  };
})();
