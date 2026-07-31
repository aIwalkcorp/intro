/* Trailforge — GPX shape classifier
 *
 * Given a trkpt array, classify the trip's geometric shape so the
 * chart, synth-descent predicate, and edit affordances can branch on
 * it without re-deriving heuristics in three places. Replaces the old
 * "ascent_m vs descent_m + 100" guess in plan-from-gpx.js.
 *
 *   shape = 'ascent_only'   one-way uphill (登山口 → 山頂)
 *         | 'descent_only'  one-way downhill (rare; e.g. ski-mountaineering)
 *         | 'out_and_back'  start ≈ end, path overlaps itself > threshold
 *         | 'loop'          start ≈ end, low overlap (different return path)
 *         | 'traverse'      A → B, different endpoints, mixed elevation
 *         | 'complex'       multi-pivot, route_variants, or genuinely weird
 *
 * Three orthogonal signals — none of them alone is reliable, the combo is:
 *   1. endpointDistanceM   haversine(track[0], track[N-1])
 *   2. selfOverlapRatio    fraction of 50m grid cells revisited by track
 *   3. netElevationM       track[N-1].ele - track[0].ele
 *
 * Public API (TF.gpxShape):
 *   detect(track, opts?)  → { shape, signals }
 *
 * No DOM, no upload-time side effects — same module is reused server-side
 * (future) and in unit tests.
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  const ENDPOINT_CLOSE_M = 100;     // start ≈ end threshold
  const ENDPOINT_FAR_M = 500;       // distinctly different endpoints
  const OVERLAP_HIGH = 0.55;        // out_and_back lower bound (50% revisit)
  const OVERLAP_LOW = 0.25;         // loop upper bound
  const NET_ELE_THRESHOLD_M = 200;  // ascent/descent_only lower bound
  const GRID_CELL_M = 50;           // overlap-detection cell size

  function haversine(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Bin track points into ~50m square cells using equirectangular projection
  // anchored at the track centroid. Return overlap = revisited / total.
  function selfOverlapRatio(track) {
    if (!track || track.length < 4) return 0;
    let latSum = 0, lonSum = 0;
    for (const p of track) { latSum += p[0]; lonSum += p[1]; }
    const cLat = latSum / track.length, cLon = lonSum / track.length;
    const mPerDegLat = 110574;
    const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
    const seen = new Map();  // cellKey → visit count
    for (const p of track) {
      const x = Math.round(((p[1] - cLon) * mPerDegLon) / GRID_CELL_M);
      const y = Math.round(((p[0] - cLat) * mPerDegLat) / GRID_CELL_M);
      const key = x + ',' + y;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    let revisited = 0;
    for (const v of seen.values()) if (v >= 2) revisited++;
    return revisited / seen.size;
  }

  function netElevationM(track) {
    if (!track || track.length < 2) return 0;
    return (track[track.length - 1][2] || 0) - (track[0][2] || 0);
  }

  // Locate the GPX index where elevation peaks. For out_and_back this is
  // the natural ascent→descent pivot; chart layout uses it to split the
  // track into two virtual halves on the extended x-axis.
  function summitIdx(track) {
    if (!track || !track.length) return -1;
    let best = 0, bestEle = -Infinity;
    for (let i = 0; i < track.length; i++) {
      const e = track[i][2];
      if (e != null && e > bestEle) { bestEle = e; best = i; }
    }
    return best;
  }

  function detect(track, opts) {
    opts = opts || {};
    const N = (track && track.length) || 0;
    if (N < 4) return { shape: 'complex', signals: { reason: 'too_short', N } };

    const endpointDistanceM = haversine(
      track[0][0], track[0][1], track[N-1][0], track[N-1][1]
    );
    const overlap = selfOverlapRatio(track);
    const netEleM = netElevationM(track);
    const summit = summitIdx(track);

    const signals = {
      N,
      endpointDistanceM: Math.round(endpointDistanceM),
      selfOverlapRatio: Math.round(overlap * 100) / 100,
      netElevationM: Math.round(netEleM),
      summitIdx: summit,
    };

    let shape;
    if (endpointDistanceM < ENDPOINT_CLOSE_M) {
      // Endpoints coincide — distinguish out_and_back vs loop by overlap.
      // Single-trail GPX walked twice will revisit nearly every cell.
      if (overlap >= OVERLAP_HIGH) shape = 'out_and_back';
      else if (overlap <= OVERLAP_LOW) shape = 'loop';
      else shape = 'complex';  // ambiguous middle ground
    } else if (endpointDistanceM > ENDPOINT_FAR_M) {
      // Distinct endpoints — pure ascent / descent / mixed traverse.
      if (netEleM > NET_ELE_THRESHOLD_M) shape = 'ascent_only';
      else if (netEleM < -NET_ELE_THRESHOLD_M) shape = 'descent_only';
      else shape = 'traverse';
    } else {
      // 100m–500m gap is rare in real hikes; treat as complex unless caller
      // overrides. Common for malformed GPX or trip starting partway up
      // a trail near where it exits.
      shape = 'complex';
    }

    return { shape, signals };
  }

  // Map detected shape back to the legacy `direction` string the rest
  // of the codebase still reads. Kept narrow — chart layout + synth
  // predicate consume `gpx_shape` directly; only the legacy fields
  // (ep.direction, gpx_meta.ascent_only) go through this mapping.
  function shapeToLegacyDirection(shape) {
    switch (shape) {
      case 'ascent_only':   return 'ascent_only';
      case 'descent_only':  return 'descent_only';
      case 'out_and_back':  return 'out_and_back';
      case 'loop':          return 'loop';
      case 'traverse':      return 'traverse';
      default:              return 'out_and_back';  // safest legacy default
    }
  }

  TF.gpxShape = {
    detect,
    summitIdx,
    selfOverlapRatio,
    netElevationM,
    shapeToLegacyDirection,
    _thresholds: {
      ENDPOINT_CLOSE_M, ENDPOINT_FAR_M,
      OVERLAP_HIGH, OVERLAP_LOW,
      NET_ELE_THRESHOLD_M, GRID_CELL_M,
    },
  };
})();
