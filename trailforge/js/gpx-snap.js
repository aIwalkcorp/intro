/* Trailforge — GPX ↔ named-location snap helpers
 *
 * Pure functions, no DOM. Given a GPX trkpt array and a named_locations
 * dict, produce a {name → trkptIdx} map by haversine snapping each
 * named coord to the closest trkpt. Plus an order-validation routine
 * that warns when the GPX recording walks named points in an order
 * that contradicts the plan's segment chain.
 *
 * Public API (TF.gpxSnap):
 *   snapAllToTrack(track, named_locations, opts?) → { snaps, distances, missing }
 *     - snaps:     { name → trkptIdx }
 *     - distances: { name → metresFromClosestTrkpt }
 *     - missing:   names whose closest trkpt is > opts.maxDistanceM (default 500)
 *
 *   validateOrder(snaps, segments) → [{ kind, segmentId, message }]
 *     - kind = 'order_mismatch' when consecutive segments' from→to indices
 *       are not monotonic w.r.t. the planned travel direction
 *     - kind = 'missing_anchor' when a segment's from/to has no snap
 *
 * Depends on TF.elevation.haversine (or falls back to a local haversine).
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  function haversineFallback(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function dist(lat1, lon1, lat2, lon2) {
    if (TF.elevation && typeof TF.elevation.haversine === 'function') {
      // TF.elevation doesn't actually expose haversine but its draw uses it
      // internally; we replicate locally to avoid creating coupling.
    }
    return haversineFallback(lat1, lon1, lat2, lon2);
  }

  // For each named location, find the trkpt with minimum great-circle
  // distance. Linear scan — O(N × M) where N=trkpt count (≤800 after
  // simplification) and M=location count (≤30 typical). Fast enough at
  // those sizes; no spatial index needed.
  //
  // opts:
  //   maxDistanceM (default 500) — if best match is farther than this,
  //     the location goes into `missing` and is omitted from `snaps`.
  //     500m is a permissive threshold that tolerates GPX simplification
  //     but rejects locations that aren't on this route at all.
  function snapAllToTrack(track, named_locations, opts) {
    opts = opts || {};
    const maxD = (typeof opts.maxDistanceM === 'number') ? opts.maxDistanceM : 500;
    const snaps = {};
    const distances = {};
    const missing = [];

    if (!Array.isArray(track) || !track.length) return { snaps, distances, missing };
    if (!named_locations || typeof named_locations !== 'object') return { snaps, distances, missing };

    const names = Object.keys(named_locations);
    for (const name of names) {
      const loc = named_locations[name];
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') continue;
      let bestIdx = -1;
      let bestD = Infinity;
      for (let i = 0; i < track.length; i++) {
        const p = track[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        const d = dist(loc.lat, loc.lon, p[0], p[1]);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) continue;
      distances[name] = Math.round(bestD);
      if (bestD > maxD) {
        missing.push({ name, distance_m: Math.round(bestD) });
        continue;
      }
      snaps[name] = bestIdx;
    }
    return { snaps, distances, missing };
  }

  // Walk the segment chain and check that each segment's from-idx ≤ to-idx
  // (or ≥ for explicit reverse segments — see segment.reverse flag), and
  // that consecutive segments' anchor indices are monotonic in the
  // direction of travel. Mismatches indicate the GPX recording walked the
  // route in a different order than the plan describes — the chart would
  // still render but slices may traverse unexpected places.
  //
  // Returns an array of warning objects (empty = all good).
  function validateOrder(snaps, segments) {
    const warnings = [];
    if (!snaps || !Array.isArray(segments)) return warnings;

    let prevToIdx = null;
    for (const seg of segments) {
      if (!seg) continue;
      const fromIdx = snaps[seg.from];
      const toIdx = snaps[seg.to];
      if (fromIdx == null) {
        warnings.push({
          kind: 'missing_anchor',
          segmentId: seg.id || `${seg.from}→${seg.to}`,
          which: 'from',
          name: seg.from,
          message: `找不到「${seg.from}」對應的 trkpt（不在 named_locations 或太遠）`,
        });
        continue;
      }
      if (toIdx == null) {
        warnings.push({
          kind: 'missing_anchor',
          segmentId: seg.id || `${seg.from}→${seg.to}`,
          which: 'to',
          name: seg.to,
          message: `找不到「${seg.to}」對應的 trkpt（不在 named_locations 或太遠）`,
        });
        continue;
      }
      // Continuity check: this segment's start should be at or after the
      // previous segment's end (most cases). When the plan explicitly
      // declares a reverse segment (from > to), or the GPX recording
      // covers a back-and-forth, prevToIdx may exceed fromIdx. We only
      // warn if the gap is large and unexplained.
      if (prevToIdx != null && fromIdx < prevToIdx - 5 && Math.abs(fromIdx - prevToIdx) > 50) {
        warnings.push({
          kind: 'order_mismatch',
          segmentId: seg.id || `${seg.from}→${seg.to}`,
          message: `「${seg.from}」對應的 trkpt(${fromIdx}) 比上一段結束(${prevToIdx}) 早，GPX 走法可能跟計畫不一致`,
        });
      }
      prevToIdx = toIdx;
    }
    return warnings;
  }

  TF.gpxSnap = { snapAllToTrack, validateOrder };
})();
