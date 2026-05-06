/* Trailforge — Overview pane (規劃模式)
 *
 * Renders the unified, full-trip Elevation Profile + Rest Points list that
 * lives at the top of the itinerary tab. This pane is only visible in
 * 規劃模式 (body[data-jm-mode="elevation"]) — see CSS in index.html.
 *
 * Two responsibilities:
 *   1. Stitch all days' GPX tracks into one continuous profile (with linear
 *      interpolation across day-boundaries when the next day's start
 *      elevation differs from the previous day's end). Hand the stitched
 *      result + per-day metadata (summit / direction / segments) to
 *      TF.elevation.drawOverview which already handles colour-split,
 *      day-band labels and summit markers.
 *   2. Build a single, continuous Rest-Points list — every 上河 segment
 *      across the whole trip in cumulative-distance order, with a Day chip
 *      (D0/D1/D2) on each row and a single speed-factor input above.
 *
 * Public API
 *   TF.overview.render() — recompute and re-paint the overview card.
 *
 * Listens for: nothing directly. Mode-toggle.js calls render() via
 * `requestAnimationFrame` after refreshAll(), and render.js calls it
 * after renderDayPanels().
 *
 * Storage
 *   jm_overview_speed   — Number (0.5 – 2.5), shared across all days.
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});
  const SPEED_KEY = 'jm_overview_speed';

  // ─── helpers ─────────────────────────────────────────────────────────
  function readSpeed() {
    try {
      const v = parseFloat(localStorage.getItem(SPEED_KEY));
      if (Number.isFinite(v) && v >= 0.5 && v <= 2.5) return v;
    } catch (e) {}
    return 1.0;
  }
  function writeSpeed(f) {
    try { localStorage.setItem(SPEED_KEY, String(f)); } catch (e) {}
  }
  function getPlan() {
    return window.__PLAN__ || (TF.loadPlan && TF.loadPlan()) || null;
  }
  function fmtMin(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), r = m % 60;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }
  function escapeHtml(s) {
    return TF.escape ? TF.escape(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  // ─── pick the active route variant for each day ─────────────────────
  // Mirrors the logic in mode-toggle.js' drawOverviewChart so the two
  // panels stay consistent.
  // ── GPX-derived geometry helpers (module-scoped, reused across the
  //    add-地標 form, delete-merge, inline 回程 generation, and any
  //    future GPX-time recompute paths). One implementation, four
  //    callers — keeps the "compute distance + asc + desc between two
  //    GPX track points" rule in a single spot.
  function haversineMeters(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function findWaypointTrackIdx(plan, name) {
    if (!name) return null;
    const target = String(name).trim();
    const days = (plan && plan.days) || [];
    for (const d of days) {
      const ep = d.elevation_profile;
      if (!ep) continue;
      const dayRef = d.gpx_ref || ep.gpx_ref || null;
      const scan = (segs, vRef) => {
        for (const s of (segs || [])) {
          const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : null;
          if (!ai || ai.length < 2) continue;
          if (s.from === target) return { trackRef: s.gpx_ref || vRef || dayRef, idx: ai[0] };
          if (s.to === target)   return { trackRef: s.gpx_ref || vRef || dayRef, idx: ai[1] };
        }
        return null;
      };
      const fromMain = scan(ep.shanghe_segments, dayRef);
      if (fromMain) return fromMain;
      if (ep.route_variants) {
        for (const vid of Object.keys(ep.route_variants)) {
          const v = ep.route_variants[vid];
          const fromV = scan(v && v.shanghe_segments, (v && v.gpx_ref) || dayRef);
          if (fromV) return fromV;
        }
      }
    }
    return null;
  }
  // Returns null when GPX data is unavailable; the swap-on-reverse rule
  // ("walking the track backwards turns ascent into descent") lives here
  // so callers don't have to re-implement it.
  function gpxStatsBetween(plan, trackRef, idxA, idxB) {
    if (!trackRef || idxA == null || idxB == null) return null;
    const tracks = plan && plan.data && plan.data.gpx_tracks;
    const track = tracks && tracks[trackRef];
    if (!Array.isArray(track) || track.length < 2) return null;
    const lo = Math.min(idxA, idxB);
    const hi = Math.max(idxA, idxB);
    if (lo === hi || hi >= track.length) return null;
    let dist = 0, asc = 0, desc = 0;
    for (let i = lo + 1; i <= hi; i++) {
      const p0 = track[i - 1];
      const p1 = track[i];
      if (!p0 || !p1) continue;
      dist += haversineMeters(p0[0], p0[1], p1[0], p1[1]);
      const dE = (p1[2] || 0) - (p0[2] || 0);
      if (dE > 0) asc += dE;
      else        desc -= dE;
    }
    const reversed = idxA > idxB;
    return {
      distance_km: +(dist / 1000).toFixed(2),
      ascent_m:  Math.round(reversed ? desc : asc),
      descent_m: Math.round(reversed ? asc  : desc),
    };
  }
  // Convenience: given two waypoint NAMES, look both up and compute
  // stats. Returns null if either anchor is missing or the two ends sit
  // on different GPX tracks.
  function gpxStatsBetweenNames(plan, fromName, toName) {
    const a = findWaypointTrackIdx(plan, fromName);
    const b = findWaypointTrackIdx(plan, toName);
    if (!a || !b || a.trackRef !== b.trackRef) return null;
    return gpxStatsBetween(plan, a.trackRef, a.idx, b.idx);
  }
  // Naismith baseline: 5 km/h flat + 1 hour per 600 m of climb. Used as
  // a default when GPX gives us geometry but no minute count is known
  // (add-地標 form, delete-merge geometry recompute, future automation).
  // Existing user-set base_minutes is never overwritten — callers gate.
  function computeBaseMinutes(distance_km, ascent_m /*, descent_m */) {
    const horiz = (+distance_km || 0) * 12;
    const asc   = (+ascent_m   || 0) / 10;
    return Math.max(0, Math.round(horiz + asc));
  }
  // ISO date arithmetic (YYYY-MM-DD ± delta days). Handles month/year
  // rollover via the Date object; returns null for unparseable inputs.
  function addDaysIso(iso, delta) {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + (delta || 0));
    const yy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  function nextDayId(days) {
    let max = 0;
    let nonNumericSeen = false;
    for (const d of (days || [])) {
      const m = /^d(\d+)$/.exec(d && d.id || '');
      if (m) max = Math.max(max, +m[1]);
      else nonNumericSeen = true;
    }
    if (max > 0) return 'd' + (max + 1);
    return 'd' + ((days || []).length + (nonNumericSeen ? 1 : 1));
  }
  // Pick a prepend id: prefer 'd0' if free, else d-pre-1, d-pre-2, …
  function nextPrependId(days) {
    const ids = new Set((days || []).map(d => (d && d.id) || ''));
    if (!ids.has('d0')) return 'd0';
    let n = 1;
    while (ids.has('d-pre-' + n)) n++;
    return 'd-pre-' + n;
  }
  // Recompute meta dates so the title's "幾天幾夜" stays in sync with
  // plan.days. Called after every add/remove. start_date = first
  // non-pretrip day; end_date = last day; depart_date = first day iff
  // it looks like a transport / 出發 day.
  function refreshMetaDates(plan) {
    if (!plan || !plan.meta) return;
    const days = plan.days || [];
    if (!days.length) return;
    const isPretrip = (d) => d && (d.id === 'd0' || /^d-pre/.test(d.id || '')
      || (d.tag_text && /出發|交通|移動/.test(d.tag_text)));
    const firstHike = days.find(d => !isPretrip(d)) || days[0];
    const lastDay = days[days.length - 1];
    if (firstHike && firstHike.date) plan.meta.start_date = firstHike.date;
    if (lastDay && lastDay.date)     plan.meta.end_date   = lastDay.date;
    if (isPretrip(days[0]) && days[0].date) plan.meta.depart_date = days[0].date;
    else if (plan.meta.depart_date && !days.some(isPretrip)) delete plan.meta.depart_date;
  }

  // ── Auto-return synthesis (shared by Edit + View) ─────────────────────
  // Locates the ascent_only day whose segments should be reversed onto
  // the trip's last day. Returns null when the trip starts and ends at
  // the same place (round-trip), or when no ascent_only day matches.
  function findAutoReturnSource(plan) {
    if (!plan || plan.auto_return_descent === false) return null;
    const days = plan.days || [];
    if (days.length < 2) return null;
    // Trip "start" is the first ASCENT_ONLY day's first segment from —
    // not realDays[0]. The 出發/移動 day (D0) often carries a transport
    // hop like "集合地點 → 民宿" which would mis-anchor the trailhead.
    // Same rule the chart uses (mode-toggle filters non-gpx days), but
    // expressed in terms of segment intent rather than gpx_ref presence.
    let firstAscentSegs = null;
    for (const d of days) {
      const v = activeVariantFor(d);
      if (!v || v.direction !== 'ascent_only') continue;
      const segs = v.segments || [];
      if (segs.length) { firstAscentSegs = segs; break; }
    }
    let lastSegs = [], lastDay = null;
    for (let i = days.length - 1; i >= 0; i--) {
      const v = activeVariantFor(days[i]);
      const segs = (v && v.segments) || [];
      // Skip pure-rest tail segments when reading the trip's true endpoint —
      // a 排雲山莊→排雲山莊 dwell at end of D2 would otherwise tell us the
      // trip ends there, which is fine, but if the LAST day's segments are
      // ALL rest-stops we keep walking back.
      const lastNonRest = [...segs].reverse().find(s => !s.is_rest_stop);
      if (lastNonRest) { lastSegs = segs; lastDay = days[i]; break; }
    }
    if (!firstAscentSegs || !lastSegs.length || !lastDay) return null;
    const startName = firstAscentSegs[0].from;
    const endName = ([...lastSegs].reverse().find(s => !s.is_rest_stop) || {}).to;
    if (!startName || !endName || startName === endName) return null;
    for (const d of days) {
      const v = activeVariantFor(d);
      if (!v || v.direction !== 'ascent_only') continue;
      const segs = v.segments || [];
      if (!segs.length) continue;
      if (segs[0].from !== startName) continue;
      const lastNonRestTo = ([...segs].reverse().find(s => !s.is_rest_stop) || {}).to;
      if (lastNonRestTo !== endName) continue;
      return { sourceDay: d, sourceSegs: segs, targetDayId: lastDay.id, startName, endName };
    }
    return null;
  }
  // Reverse a chain of segments. Uses GPX point arithmetic (haversine +
  // per-step elevation diff) for distance/asc/desc when anchor_idx is
  // available, falling back to the pre-stored stats with asc/desc
  // swapped. Same logic that the add-地標 form and delete-merge handler
  // use, applied to the auto-return path.
  function buildReverseSegments(sourceSegs, plan) {
    if (!Array.isArray(sourceSegs)) return [];
    const out = [];
    // Walk source in REVERSE; for each non-rest-stop seg, push a
    // mirrored copy and remember which source index it came from
    // (sourceSegIdx) so the Edit table can write a descent override
    // back to the right place when the user types a new minute count.
    for (let i = sourceSegs.length - 1; i >= 0; i--) {
      const s = sourceSegs[i];
      if (!s || s.is_rest_stop) continue;
      const a = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
      const ai0 = a[0], ai1 = a[1];
      const ref = s.gpx_ref || null;
      let stats = null;
      if (ref && ai0 != null && ai1 != null) {
        stats = gpxStatsBetween(plan, ref, ai1, ai0);
      }
      // Per-source override wins; otherwise apply the default 0.7
      // descent factor (or s.descent_factor if explicitly set).
      const override = (s.descent_override_minutes != null)
        ? Math.max(0, Math.round(+s.descent_override_minutes || 0))
        : null;
      const factored = Math.round((+s.base_minutes || 0) * (+s.descent_factor || 0.7));
      out.push(Object.assign({}, s, {
        id: 'r-' + (s.id || Math.random().toString(36).slice(2, 7)),
        from: s.to,
        to: s.from,
        anchor_idx: (ai0 != null && ai1 != null) ? [ai1, ai0] : null,
        distance_km: stats ? stats.distance_km : (+s.distance_km || 0),
        ascent_m:    stats ? stats.ascent_m    : (+s.descent_m   || 0),
        descent_m:   stats ? stats.descent_m   : (+s.ascent_m    || 0),
        is_auto_return: true,
        sourceSegIdx: i,
        base_minutes: override != null ? override : factored,
      }));
    }
    return out;
  }
  // Persistable descent generator — used by the "+ 下山段" button to
  // materialise the auto-补齊 reverse into REAL segments the user can
  // then branch / delete / annotate independently. Differs from
  // buildReverseSegments in three ways:
  //   1. Notes are NOT inherited (descent has its own emergent context;
  //      "上河左側捷徑" on ascent doesn't apply going down).
  //   2. Fresh random ids — no "r-" prefix tying back to the source.
  //   3. No is_auto_return / sourceSegIdx flags — the segs are
  //      first-class user-owned data after materialisation.
  function cloneDescentFromAscent(plan, sourceSegs) {
    if (!Array.isArray(sourceSegs)) return [];
    const out = [];
    for (let i = sourceSegs.length - 1; i >= 0; i--) {
      const s = sourceSegs[i];
      if (!s || s.is_rest_stop) continue;
      const a = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
      const ai0 = a[0], ai1 = a[1];
      const ref = s.gpx_ref || null;
      let stats = null;
      if (ref && ai0 != null && ai1 != null) {
        stats = gpxStatsBetween(plan, ref, ai1, ai0);
      }
      const factored = Math.round((+s.base_minutes || 0) * (+s.descent_factor || 0.7));
      out.push({
        id: 'd-' + Math.random().toString(36).slice(2, 9),
        from: s.to || '',
        to: s.from || '',
        anchor_idx: (ai0 != null && ai1 != null) ? [ai1, ai0] : null,
        distance_km: stats ? stats.distance_km : (+s.distance_km || 0),
        ascent_m:    stats ? stats.ascent_m    : (+s.descent_m   || 0),
        descent_m:   stats ? stats.descent_m   : (+s.ascent_m    || 0),
        base_minutes: factored,
        note: '',
      });
    }
    return out;
  }

  function effectiveSegmentsForVariant(plan, day, variant) {
    const segs = (variant && variant.shanghe_segments) || [];
    const ret = findAutoReturnSource(plan);
    if (!ret || ret.targetDayId !== day.id) return segs;
    return segs.concat(buildReverseSegments(ret.sourceSegs, plan));
  }

  // Single source of truth for "what does Day N look like right now?"
  // Both Edit (rest-points table + start_time picker) and View (timeline
  // derivation) read through this. No legacy day.schedule[] fallbacks —
  // missing start_time means no times rendered, same as Edit's behavior.
  function getEffectiveDayContext(plan, day, variantId) {
    const ep = (day && day.elevation_profile) || null;
    const isHM = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ''));

    let resolvedId = variantId || null;
    if (ep && ep.route_variants) {
      if (!resolvedId) {
        const dayPanel = day && document.getElementById('day-' + day.id);
        const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
        const m = activeTab && (activeTab.getAttribute('onclick') || '').match(/switchRoute\(['"]([^'"]+)['"]\)/);
        if (m) resolvedId = m[1];
      }
      if (!resolvedId) resolvedId = ep.default_variant || Object.keys(ep.route_variants)[0] || null;
    }
    const variant = (ep && ep.route_variants && resolvedId) ? ep.route_variants[resolvedId] : null;

    let startStr = null;
    if (variant && isHM(variant.start_time)) startStr = variant.start_time;
    else if (ep && isHM(ep.start_time))      startStr = ep.start_time;
    const startMin = startStr ? parseHM(startStr) : null;

    const segments = (variant && variant.shanghe_segments && variant.shanghe_segments.length)
      ? variant.shanghe_segments
      : ((ep && ep.shanghe_segments) || []);

    const ret = findAutoReturnSource(plan);
    const tail = (ret && day && ret.targetDayId === day.id)
      ? buildReverseSegments(ret.sourceSegs, plan)
      : [];
    const segmentsWithReturn = tail.length ? segments.concat(tail) : segments;

    return { variantId: resolvedId, startStr, startMin, segments, segmentsWithReturn };
  }

  function activeVariantFor(day) {
    const ep = day.elevation_profile;
    if (!ep) return null;
    const out = {
      summitIdx: ep.summit_idx,
      summitLabel: ep.summit_label,
      direction: ep.direction,
      segments: ep.shanghe_segments || [],
    };
    if (ep.route_variants) {
      const dayPanel = document.getElementById('day-' + day.id);
      const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
      let routeId = null;
      if (activeTab) {
        const m = (activeTab.getAttribute('onclick') || '').match(/switchRoute\(['"]([^'"]+)['"]\)/);
        routeId = m && m[1];
      }
      if (!routeId) routeId = ep.default_variant || null;
      const v = routeId && ep.route_variants[routeId];
      if (v) {
        if (v.summit_idx != null) out.summitIdx = v.summit_idx;
        if (v.summit_label) out.summitLabel = v.summit_label;
        if (v.direction) out.direction = v.direction;
        if (v.shanghe_segments) out.segments = v.shanghe_segments;
      }
    }
    return out;
  }

  // ─── stitch GPX tracks across day boundaries ────────────────────────
  // Some plans have day0 (lodging only) without a GPX track — we skip
  // those for the chart but still surface them in the rest-points table
  // (with no segment math, just a Day-chip header row to label the day).
  // For consecutive GPX days, if the elevation at the end of day N
  // differs from the start of day N+1 by more than 5m, insert N short
  // interpolated points so drawOverview can render a smooth join. We
  // attach `__synthetic` to interpolated points so future logic can
  // distinguish them from real GPX samples (not used by drawOverview
  // today, but useful for tooltips later).
  function stitchTrack(gpxA, gpxB) {
    if (!gpxA || !gpxA.length) return gpxB || [];
    if (!gpxB || !gpxB.length) return gpxA;
    const aEnd = gpxA[gpxA.length - 1];
    const bStart = gpxB[0];
    const dE = Math.abs((bStart[2] || 0) - (aEnd[2] || 0));
    if (dE <= 5) return gpxA.concat(gpxB);
    // Insert 6 interpolated points between aEnd and bStart so the join
    // looks natural rather than a vertical cliff.
    const STEPS = 6;
    const filler = [];
    for (let i = 1; i < STEPS; i++) {
      const t = i / STEPS;
      const lat = aEnd[0] + (bStart[0] - aEnd[0]) * t;
      const lon = aEnd[1] + (bStart[1] - aEnd[1]) * t;
      const elev = aEnd[2] + (bStart[2] - aEnd[2]) * t;
      const p = [lat, lon, elev];
      p.__synthetic = true;
      filler.push(p);
    }
    return gpxA.concat(filler, gpxB);
  }

  // ─── collect rest-points across all days ────────────────────────────
  // Returns one row per 上河 segment, in chronological / cumulative
  // distance order. Each row carries enough context to drive a click-to-
  // focus interaction:
  //   - dayId: maps to plan.days[].id (overview chart resolves to dayIdx)
  //   - anchorLo/anchorHi: GPX indices within that day's track
  //   - cumKm: running cumulative km for display
  // Synthetic "day-header" rows surface non-hiking days; "subtotal" rows
  // sit after each day's last segment summarising km / ↑ / ↓ / minutes.
  // "Start of hike" clock time for a day. Delegates to the unified
  // getEffectiveDayContext — variant.start_time wins when route_variants
  // exist (active variant resolved via DOM tab → ep.default_variant), else
  // ep.start_time. No legacy day.schedule[0].time fallback.
  function dayStartTimeFor(day) {
    return getEffectiveDayContext(getPlan(), day, null).startStr;
  }
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = +m[1], mm = +m[2];
    if (h < 0 || h > 47 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }
  function fmtHM(mins) {
    const m = ((mins % 1440) + 1440) % 1440;     // normalize, keep within day
    const h = Math.floor(m / 60), mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // Shift every "HH:MM" time string in this day's schedule (and inside any
  // route variants + key_times) by the given minute delta. Used when the
  // user edits the day's start_time so the view-mode timeline + 🚨 popup
  // ride along. Items without a parseable time are left untouched.
  function shiftDayScheduleByOffset(day, deltaMin) {
    if (!day || !deltaMin) return;
    const shiftTimeField = (obj, key) => {
      if (!obj || typeof obj[key] !== 'string') return;
      // value field can be a range like "16-17" — only shift if it parses
      // cleanly as HH:MM. Skip otherwise (the 玉山 demo has these on key_times).
      const cur = parseHM(obj[key]);
      if (cur == null) return;
      obj[key] = fmtHM(cur + deltaMin);
    };
    (day.schedule || []).forEach((it) => shiftTimeField(it, 'time'));
    (day.routes || []).forEach((r) => (r && r.schedule || []).forEach((it) => shiftTimeField(it, 'time')));
    (day.key_times || []).forEach((kt) => shiftTimeField(kt, 'value'));
  }

  function collectRestPoints(plan) {
    const rows = [];
    let cumKm = 0;
    const realDays = plan.days || [];
    const ret = findAutoReturnSource(plan);
    const returnTargetDayId = ret ? ret.targetDayId : null;

    realDays.forEach(day => {
      // Single source of truth for segments + start_time. Variant resolution,
      // auto-return tail, and start_time precedence all live inside the
      // function — Edit and View cannot drift apart.
      const ctx = getEffectiveDayContext(plan, day, null);
      const baseSegs = ctx.segments;
      const segs = ctx.segmentsWithReturn;
      const dayId = day.id;
      const dayLabel = day.label || ('Day ' + day.id);
      const dayStart = ctx.startStr;
      const dayStartMin = ctx.startMin;
      if (!segs.length) {
        rows.push({
          kind: 'day-header',
          dayId, dayLabel, dayStart,
          note: '無步行段（' + (day.section_title || '出發/移動日') + '）',
        });
        return;
      }
      // Header row first so the user can see/edit start time even before segs
      rows.push({
        kind: 'day-header',
        dayId, dayLabel, dayStart,
        note: dayStart ? `起登 ${dayStart}` : '尚未設定起登時間',
      });
      // Active variant id (resolved by getEffectiveDayContext) — needed by
      // note editing so we can mutate the right segment object on input.
      const ep = day.elevation_profile;
      const useRoute = !!(ep && ep.route_variants);
      const activeRouteId = useRoute ? ctx.variantId : null;

      // For days with route_variants, find how many leading segments are
      // shared across all variants. The fork happens AFTER that index, so
      // we'll inject a variant-picker pseudo-row right at the fork point —
      // exactly where the user makes the decision in real life.
      let sharedPrefix = 0;
      if (useRoute && day.elevation_profile.route_variants) {
        const ids = Object.keys(day.elevation_profile.route_variants);
        if (ids.length >= 2) {
          const segArrays = ids.map(id => day.elevation_profile.route_variants[id].shanghe_segments || []);
          const minLen = Math.min.apply(null, segArrays.map(arr => arr.length));
          for (let i = 0; i < minLen; i++) {
            const refFrom = segArrays[0][i].from, refTo = segArrays[0][i].to;
            let allEqual = true;
            for (let j = 1; j < segArrays.length; j++) {
              if (segArrays[j][i].from !== refFrom || segArrays[j][i].to !== refTo) { allEqual = false; break; }
            }
            if (!allEqual) { sharedPrefix = i; break; }
            sharedPrefix = i + 1;
          }
        }
      }

      const baseSegCount = baseSegs.length;
      let dayKm = 0, dayAsc = 0, dayDesc = 0, dayMin = 0, cumDayBaseMin = 0;
      segs.forEach((s, segIdx) => {
        const isReturnSeg = segIdx >= baseSegCount;
        const dist = +s.distance_km || 0;
        const baseMin = +s.base_minutes || 0;
        const startKm = cumKm;
        const endKm = cumKm + dist;
        const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
        const anchorLo = ai.length >= 2 ? ai[0] : null;
        const anchorHi = ai.length >= 2 ? ai[1] : null;
        const cumAfter = cumDayBaseMin + baseMin;
        const isRest = !!s.is_rest_stop || (s.from && s.from === s.to);
        // Return rows store source-day pointers so the minute editor can
        // write back to D1's seg.descent_override_minutes; transit rows
        // edit themselves via segIdx + variantId.
        const sourceDayId = isReturnSeg && ret ? ret.sourceDay.id : null;
        const sourceSegIdx = isReturnSeg ? (s.sourceSegIdx != null ? s.sourceSegIdx : null) : null;
        rows.push({
          kind: isRest ? 'rest' : 'segment',
          dayId, dayLabel,
          from: s.from || '',
          to: s.to || '',
          atName: s.from || s.to || '',
          note: s.note || '',
          segIdx: isReturnSeg ? null : segIdx,
          variantId: useRoute ? activeRouteId : null,
          sourceDayId, sourceSegIdx,
          distance_km: dist,
          ascent_m: +s.ascent_m || 0,
          descent_m: +s.descent_m || 0,
          base_minutes: baseMin,
          cumDayBaseMinAfter: cumAfter,
          cumDayBaseMinBefore: cumDayBaseMin,
          dayStartMin,
          startKm, endKm,
          anchorLo: isReturnSeg ? null : anchorLo,
          anchorHi: isReturnSeg ? null : anchorHi,
          isReturn: isReturnSeg,
        });
        cumKm = endKm;
        cumDayBaseMin = cumAfter;
        dayKm   += dist;
        dayAsc  += (+s.ascent_m || 0);
        dayDesc += (+s.descent_m || 0);
        dayMin  += baseMin;

        if (useRoute && sharedPrefix > 0 && segIdx === sharedPrefix - 1) {
          rows.push({
            kind: 'variant-fork',
            dayId, dayLabel,
            forkAt: s.to || '',
          });
        }

        // Per-row "+" affordance — only on real (non-synthesised) rows,
        // and not when the very next seg is already a rest at the same
        // place (it would render as a sub-row that already documents the
        // dwell — adding "+ 地標 / + 休息" between them is just noise).
        const nextSeg = segs[segIdx + 1];
        const nextIsRestHere = !!nextSeg
          && (!!nextSeg.is_rest_stop || (nextSeg.from && nextSeg.from === nextSeg.to))
          && nextSeg.from === s.to;
        if (!isReturnSeg && !nextIsRestHere) {
          rows.push({
            kind: 'add-segment',
            dayId, dayLabel,
            variantId: useRoute ? activeRouteId : null,
            afterIdx: segIdx,
            atName: s.to || '',
          });
        }
      });

      // Subtotal covers 攻頂 + 回程 when the auto-return tail is present.
      rows.push({
        kind: 'subtotal',
        dayId, dayLabel,
        distance_km: dayKm,
        ascent_m: dayAsc,
        descent_m: dayDesc,
        base_minutes: dayMin,
        dayStartMin,
        cumDayBaseMinAfter: cumDayBaseMin,
      });
    });

    // (Synthetic 回程 rows are now emitted INLINE inside the per-day
    // loop above so they sit before the day's subtotal — see the
    // returnTargetDayId block. No separate post-loop synth pass needed.)

    return rows;
  }

  // ─── route-variant picker (chips per day with variants) ─────────────
  // Returns HTML for the row of route-switch chips. One chip group per
  // day that declares route_variants. Each chip is clickable; the active
  // one is highlighted. Clicking calls window.switchRoute(variantId).
  function buildVariantPickerHtml(plan) {
    const groups = [];
    (plan.days || []).forEach(day => {
      const ep = day.elevation_profile;
      if (!ep || !ep.route_variants) return;
      const variantIds = Object.keys(ep.route_variants);
      if (variantIds.length < 2) return;
      // Detect the currently-active variant from the day-panel's r-tab
      const dayPanel = document.getElementById('day-' + day.id);
      const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
      let activeId = null;
      if (activeTab) {
        const m = (activeTab.getAttribute('onclick') || '').match(/switchRoute\(['"]([^'"]+)['"]\)/);
        activeId = m && m[1];
      }
      if (!activeId) activeId = ep.default_variant || variantIds[0];
      const chipsHtml = variantIds.map(vid => {
        const v = ep.route_variants[vid];
        const label = (v && v.label) || vid.toUpperCase();
        const isActive = vid === activeId;
        return `<button type="button"
          class="rp-rv-chip${isActive ? ' active' : ''}"
          data-route-id="${escapeHtml(vid)}"
          aria-pressed="${isActive ? 'true' : 'false'}"
          ${isActive ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
      }).join('');
      groups.push(`<div class="rp-rv-group">
        <span class="rp-rv-day">${escapeHtml(day.label || ('Day ' + day.id))}</span>
        <span class="rp-rv-arrow">→</span>
        <div class="rp-rv-chips">${chipsHtml}</div>
      </div>`);
    });
    if (!groups.length) return '';
    return `<div class="rp-route-variants" data-section="route-variants">
      <span class="rp-rv-title">路線方案</span>
      ${groups.join('')}
    </div>`;
  }

  function bindVariantPickers(host) {
    if (host.__rvBound) return;
    host.__rvBound = true;
    // Single delegated listener — catches both the legacy top-of-table
    // strip (.rp-route-variants) AND the new inline fork rows
    // (.rp-fork-row .rp-rv-chips). Either button has class .rp-rv-chip.
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('button.rp-rv-chip');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.routeId;
      if (!id) return;
      if (typeof window.switchRoute === 'function') window.switchRoute(id);
    });
  }

  // ─── render everything into #overview-rest-points ───────────────────
  function renderRestPoints(plan, factor) {
    const host = document.getElementById('overview-rest-points');
    if (!host) return;
    const overview = document.getElementById('elev-overview');

    // (Reverted: auto-materialising descent into the target day's
    // shanghe_segments broke the elevation chart — descent anchor_idx
    // values point at the SOURCE ascent day's GPX track, but the chart
    // stitches a day's track from a single gpx_ref, so attacking those
    // indices against the target day's track produced garbage. Descent
    // stays runtime-synth; full branch/delete/note on descent rows
    // needs a non-materialisation design and is deferred.)

    const rows = collectRestPoints(plan);
    let totalBase = 0, totalDerived = 0, totalKm = 0, totalAsc = 0, totalDesc = 0;
    rows.forEach(r => {
      if (r.kind !== 'segment') return;
      totalBase    += r.base_minutes;
      totalDerived += Math.round(r.base_minutes * factor);
      totalKm      += r.distance_km;
      totalAsc     += r.ascent_m;
      totalDesc    += r.descent_m;
    });

    // Currently-focused segment (sticky across re-renders so the user
    // doesn't lose their selection when the speed factor changes).
    const focusDayId = overview && overview.dataset.focusDayId;
    const focusLo    = overview && overview.dataset.focusLo;
    const focusHi    = overview && overview.dataset.focusHi;

    const rowsHtml = rows.map((r, idx) => {
      const dayChip = `<span class="rp-chip rp-chip-${escapeHtml(r.dayId)}">${escapeHtml((r.dayId || '').toUpperCase())}</span>`;

      if (r.kind === 'day-header') {
        const editing = document.body.classList.contains('tf-editing');
        const startCell = editing
          ? `<input type="time" class="rp-day-start-edit" data-day-id="${escapeHtml(r.dayId)}" value="${escapeHtml(r.dayStart || '')}" aria-label="起登時間">`
          : (r.dayStart
              ? `<span class="rp-day-start"><small>起登</small>${escapeHtml(r.dayStart)}</span>`
              : `<span class="rp-day-start rp-day-start-empty"><small>起登</small>—</span>`);

        // Section title — editable when in edit mode, read-only label otherwise.
        // Pulled from day.section_title (e.g. "Day 1 — 4/18(六) 塔塔加→排雲山莊").
        const day = (plan.days || []).find(d => d.id === r.dayId);
        const secTitle = (day && day.section_title) || '';
        const titleCell = editing && day && !r.isReturn
          ? `<input type="text" class="rp-section-title-edit" data-day-id="${escapeHtml(r.dayId)}" value="${escapeHtml(secTitle)}" placeholder="行程標題（如：Day 1 — 塔塔加 → 排雲山莊）" aria-label="行程標題">`
          : (secTitle
              ? `<span class="rp-section-title">${escapeHtml(secTitle)}</span>`
              : '');

        // Delete-day button — sits at the right of the day-header in
        // edit mode (skipped on synthesised return-day headers since
        // those are derived, not stored). Removes the entire day from
        // plan.days; the rest-points table + day-bar + chart all
        // re-render off the mutation.
        const delDayBtn = (editing && day && !r.isReturn)
          ? `<button type="button" class="rp-day-del-btn"
              data-day-id="${escapeHtml(r.dayId)}"
              data-day-label="${escapeHtml(r.dayLabel || r.dayId)}"
              aria-label="刪除此日"
              title="刪除此日">✕</button>`
          : '';

        return `<div class="rp-row rp-day-header${r.isReturn ? ' rp-day-header-return' : ''}">
          ${dayChip}
          <span class="rp-day-name">${escapeHtml(r.dayLabel)}</span>
          <span class="rp-day-note">${escapeHtml(r.note || '')}</span>
          ${startCell}
          ${delDayBtn}
        </div>${titleCell ? `<div class="rp-section-title-row">${titleCell}</div>` : ''}`;
      }

      if (r.kind === 'add-segment') {
        const editing = document.body.classList.contains('tf-editing');
        if (!editing) return '';   // hide in view mode
        const at = r.atName || '';
        const dataAttrs = `data-day-id="${escapeHtml(r.dayId)}"
            data-variant-id="${escapeHtml(r.variantId || '')}"
            data-after-idx="${r.afterIdx}"
            data-at-name="${escapeHtml(at)}"`;
        return `<div class="rp-row rp-add-row">
          <button type="button" class="rp-add-seg-btn" ${dataAttrs}
            title="從此處再走到下一個地標">＋ 地標</button>
          <button type="button" class="rp-add-rest-btn" ${dataAttrs}
            title="在此處原地停留（用餐／補水／拍照等請填於備註）">＋ 休息</button>
        </div>`;
      }

      if (r.kind === 'variant-fork') {
        // Build per-day variant picker chips inline.
        const day = (plan.days || []).find(d => d.id === r.dayId);
        if (!day) return '';
        const ep = day.elevation_profile;
        if (!ep || !ep.route_variants) return '';
        const variantIds = Object.keys(ep.route_variants);
        if (variantIds.length < 2) return '';
        // active variant detection — same logic as activeVariantFor
        const dayPanel = document.getElementById('day-' + day.id);
        const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
        let activeId = null;
        if (activeTab) {
          const m = (activeTab.getAttribute('onclick') || '').match(/switchRoute\(['"]([^'"]+)['"]\)/);
          activeId = m && m[1];
        }
        if (!activeId) activeId = ep.default_variant || variantIds[0];
        const chipsHtml = variantIds.map(vid => {
          const v = ep.route_variants[vid];
          const label = (v && v.label) || vid.toUpperCase();
          const isActive = vid === activeId;
          return `<button type="button"
            class="rp-rv-chip${isActive ? ' active' : ''}"
            data-route-id="${escapeHtml(vid)}"
            aria-pressed="${isActive ? 'true' : 'false'}"
            ${isActive ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
        }).join('');
        return `<div class="rp-row rp-fork-row">
          <span class="rp-fork-mark" aria-hidden="true">⇄</span>
          <span class="rp-fork-label"><b>${escapeHtml(r.forkAt)}</b> 分歧</span>
          <div class="rp-rv-chips">${chipsHtml}</div>
        </div>`;
      }

      if (r.kind === 'rest') {
        // Compact sub-row tucked under the prior transit segment —
        // semantically "after arriving at X, dwell N minutes here".
        // Same affordance family as .rp-note-row (↳ + indent), with sage
        // tint, an asterism mark, and inline mins / clock-range / note.
        // Place name is implicit (it's the prior segment's `to`), so
        // we don't repeat it.
        const editing = document.body.classList.contains('tf-editing');
        const canEdit = !r.isReturn && r.segIdx != null;
        const derived = Math.round(r.base_minutes * factor);
        const startClock = r.dayStartMin != null
          ? fmtHM(r.dayStartMin + Math.round(r.cumDayBaseMinBefore * factor))
          : null;
        const endClock = r.dayStartMin != null
          ? fmtHM(r.dayStartMin + Math.round(r.cumDayBaseMinAfter * factor))
          : null;
        const minsCell = (canEdit && editing)
          ? `<input type="number" class="rp-min-edit"
                data-day-id="${escapeHtml(r.dayId)}"
                data-seg-idx="${r.segIdx}"
                data-variant-id="${escapeHtml(r.variantId || '')}"
                min="0" step="1" value="${derived}"
                aria-label="此段休息分鐘">`
          : `<span class="rp-sub-rest-mins-num">${derived}</span>`;
        const delBtn = (canEdit && editing) ? `<button type="button" class="rp-del-btn rp-sub-del-btn"
            data-day-id="${escapeHtml(r.dayId)}"
            data-seg-idx="${r.segIdx}"
            data-variant-id="${escapeHtml(r.variantId || '')}"
            data-to-name="${escapeHtml(r.atName || '休息')}"
            aria-label="刪除此休息" title="刪除此休息">✕</button>` : '';
        const clockText = (startClock && endClock)
          ? `<span class="rp-sub-rest-clock">${startClock}<span class="rp-rest-arrow">～</span>${endClock}</span>`
          : '';
        // Note inline on the same line. View mode → italic serif text.
        // Edit mode → dotted-underline input that spans the remaining
        // flex space. Either way, single-line stays compact.
        const noteCell = (canEdit && editing)
          ? `<input class="rp-sub-rest-note rp-sub-rest-note-edit" type="text"
                value="${escapeHtml(r.note || '')}"
                placeholder="備註（午餐／補水／拍照…）"
                data-day-id="${escapeHtml(r.dayId)}"
                data-seg-idx="${r.segIdx}"
                data-variant-id="${escapeHtml(r.variantId || '')}"
                aria-label="此段備註">`
          : (r.note ? `<span class="rp-sub-rest-note">${escapeHtml(r.note)}</span>` : '');
        return `<div class="rp-sub-rest${r.isReturn ? ' rp-sub-rest-return' : ''}"
            data-day-id="${escapeHtml(r.dayId)}"
            data-seg-idx="${r.segIdx == null ? '' : r.segIdx}"
            data-variant-id="${escapeHtml(r.variantId || '')}">
          <span class="rp-sub-mark" aria-hidden="true">↳</span>
          <span class="rp-sub-rest-pill"><span class="rp-sub-rest-glyph" aria-hidden="true">❋</span>休息</span>
          <span class="rp-sub-rest-mins">${minsCell}<small>分</small></span>
          ${clockText}
          ${noteCell}
          ${delBtn}
        </div>`;
      }

      if (r.kind === 'subtotal') {
        const dayDerived = Math.round(r.base_minutes * factor);
        const elevBits = [];
        if (r.distance_km) elevBits.push(`<span class="rp-km">${r.distance_km.toFixed(1)}<small>km</small></span>`);
        if (r.ascent_m)    elevBits.push(`<span class="rp-asc">↑${r.ascent_m}<small>m</small></span>`);
        if (r.descent_m)   elevBits.push(`<span class="rp-desc">↓${r.descent_m}<small>m</small></span>`);
        const arrival = r.dayStartMin != null
          ? fmtHM(r.dayStartMin + Math.round(r.cumDayBaseMinAfter * factor))
          : null;
        return `<div class="rp-row rp-subtotal">
          <span class="rp-subtotal-l">
            ${dayChip}
            <span class="rp-subtotal-day">${escapeHtml(r.dayLabel)} 小結</span>
            <span class="rp-subtotal-meta">${elevBits.join('')}</span>
          </span>
          <span class="rp-cost">
            <span class="rp-time-derived">${dayDerived}</span><small>分</small>
            <span class="rp-time-base">基準 ${r.base_minutes}分</span>
          </span>
          <span class="rp-arrive">${arrival
            ? `<small>抵達</small><b>${arrival}</b>`
            : '<small class="rp-arrive-empty">—</small>'}</span>
          <span class="rp-row-spacer" aria-hidden="true"></span>
        </div>`;
      }

      // segment
      const elevBits = [];
      if (r.ascent_m)  elevBits.push(`<span class="rp-asc">↑${r.ascent_m}<small>m</small></span>`);
      if (r.descent_m) elevBits.push(`<span class="rp-desc">↓${r.descent_m}<small>m</small></span>`);
      if (!elevBits.length) elevBits.push(`<span class="rp-flat">─</span>`);
      const derived = Math.round(r.base_minutes * factor);
      const arrival = r.dayStartMin != null
        ? fmtHM(r.dayStartMin + Math.round(r.cumDayBaseMinAfter * factor))
        : null;
      const focusable = (r.anchorLo != null && r.anchorHi != null);
      const isFocused = focusable
        && r.dayId === focusDayId
        && String(r.anchorLo) === focusLo
        && String(r.anchorHi) === focusHi;
      const attrs = focusable
        ? ` data-focusable="true" data-day-id="${escapeHtml(r.dayId)}" data-anchor-lo="${r.anchorLo}" data-anchor-hi="${r.anchorHi}" role="button" tabindex="0" aria-pressed="${isFocused ? 'true' : 'false'}"`
        : '';
      const rowExtraClass = r.isReturn ? ' rp-row-return' : '';
      // Per-segment 備註 row — sits directly below the segment row. Edit
      // mode shows a clean dotted-underline input; the branch button now
      // lives next to the minutes cell (rp-cost) so it sits right where
      // the user is "spending time" — visually closer to the decision
      // point than dangling off the end of the note row.
      const editing = document.body.classList.contains('tf-editing');
      const canEditNote = !r.isReturn && r.segIdx != null;
      // Return rows can edit MINUTES (writes to source D1 seg's
      // descent_override_minutes via sourceDayId + sourceSegIdx) but
      // not branch/delete/notes — the descent geometry is derived.
      const canEditMins = canEditNote || (r.isReturn && r.sourceDayId != null && r.sourceSegIdx != null);
      // Git-branch SVG: vertical stem with a fork branching off to the
      // right. Click opens the inline new-variant form below.
      const branchBtn = (canEditNote && editing) ? `<button type="button" class="rp-branch-btn"
            data-day-id="${escapeHtml(r.dayId)}"
            data-seg-idx="${r.segIdx}"
            data-variant-id="${escapeHtml(r.variantId || '')}"
            aria-label="從此處創建新路線分歧"
            title="從此處創建新路線分歧">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle cx="4" cy="3" r="1.6" fill="currentColor"/>
            <circle cx="4" cy="13" r="1.6" fill="currentColor"/>
            <circle cx="12" cy="8" r="1.6" fill="currentColor"/>
            <path d="M4 4.5v7" stroke="currentColor" stroke-width="1.4" fill="none"/>
            <path d="M4 7.5 q 0 -2 4 -2 t 4 1" stroke="currentColor" stroke-width="1.4" fill="none"/>
          </svg>
          <span>分歧</span>
        </button>` : '';
      // Delete-segment button — sits beside the branch button. Removes
      // THIS segment from the active variant's shanghe_segments. The
      // next segment's "from" auto-derives from collectRestPoints, so
      // a chain like A→B→C with B deleted reads correctly as A→C iff
      // the user fixes the next segment's `from` (we leave that as is
      // for now; the chain may show a visual jump).
      const deleteBtn = (canEditNote && editing) ? `<button type="button" class="rp-del-btn"
            data-day-id="${escapeHtml(r.dayId)}"
            data-seg-idx="${r.segIdx}"
            data-variant-id="${escapeHtml(r.variantId || '')}"
            data-to-name="${escapeHtml(r.to || '')}"
            aria-label="刪除此地標"
            title="刪除此地標">✕</button>` : '';
      let noteHtml = '';
      if (canEditNote && editing) {
        noteHtml = `<div class="rp-note-row" data-day-id="${escapeHtml(r.dayId)}" data-seg-idx="${r.segIdx}" data-variant-id="${escapeHtml(r.variantId || '')}">
          <span class="rp-note-mark" aria-hidden="true">↳</span>
          <input class="rp-note-input" type="text" value="${escapeHtml(r.note || '')}" placeholder="備註（可選）" aria-label="此段備註">
        </div>`;
      } else if (r.note) {
        noteHtml = `<div class="rp-note-row rp-note-readonly">
          <span class="rp-note-mark" aria-hidden="true">↳</span>
          <span class="rp-note-text">${escapeHtml(r.note)}</span>
        </div>`;
      }

      // Per-row info-key (for the triangulation-benchmark toggle). Lives
      // on host._openInfoRows Set so re-renders preserve open state.
      const infoKey = `${r.dayId}|${r.variantId || ''}|${r.segIdx == null ? '_'+idx : r.segIdx}|${r.isReturn ? 'R' : 'F'}`;
      const infoOpen = host && host._openInfoRows && host._openInfoRows.has(infoKey);
      const infoBtn = `<button type="button" class="rp-info-btn"
            data-info-key="${escapeHtml(infoKey)}"
            aria-pressed="${infoOpen ? 'true' : 'false'}"
            aria-label="顯示／隱藏此段詳情"
            title="顯示／隱藏此段詳情">
          <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
            <path d="M9 3.6 v6.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>
            <circle cx="9" cy="13.5" r="1.15" fill="currentColor"/>
          </svg>
        </button>`;

      return `<div class="rp-row${rowExtraClass}${infoOpen ? ' rp-row-info-open' : ''}"${attrs}>
        ${dayChip}
        <span class="rp-cum">${r.startKm.toFixed(1)}<small>km</small></span>
        <span class="rp-route">
          <span class="rp-from">${escapeHtml(r.from)}</span>
          <span class="rp-arrow">→</span>
          <span class="rp-to">${escapeHtml(r.to)}</span>
        </span>
        <span class="rp-cost">
          <span class="rp-cost-main">
            ${(canEditMins && editing) ? `<input type="number" class="rp-min-edit"
              data-day-id="${escapeHtml(r.dayId)}"
              data-seg-idx="${r.segIdx == null ? '' : r.segIdx}"
              data-variant-id="${escapeHtml(r.variantId || '')}"
              data-source-day-id="${escapeHtml(r.sourceDayId || '')}"
              data-source-seg-idx="${r.sourceSegIdx == null ? '' : r.sourceSegIdx}"
              min="0" step="1" value="${derived}"
              aria-label="${r.isReturn ? '下山段分鐘（覆寫源段）' : '此段步行分鐘'}">` : `<span class="rp-time-derived">${derived}</span>`}<small>分</small>
            ${branchBtn}
            ${deleteBtn}
          </span>
        </span>
        <span class="rp-arrive">${
          (canEditMins && editing && arrival)
            ? `<small>抵達</small><input type="text" class="rp-arrive-edit"
                inputmode="numeric" maxlength="5"
                pattern="\\d{1,2}:\\d{2}"
                data-day-id="${escapeHtml(r.dayId)}"
                data-seg-idx="${r.segIdx == null ? '' : r.segIdx}"
                data-variant-id="${escapeHtml(r.variantId || '')}"
                data-source-day-id="${escapeHtml(r.sourceDayId || '')}"
                data-source-seg-idx="${r.sourceSegIdx == null ? '' : r.sourceSegIdx}"
                data-day-start-min="${r.dayStartMin == null ? '' : r.dayStartMin}"
                data-cum-before="${r.cumDayBaseMinBefore == null ? r.cumDayBaseMinAfter - r.base_minutes : r.cumDayBaseMinBefore}"
                value="${arrival}" aria-label="抵達時間（編輯回推此段分鐘，格式 HH:MM）">`
            : (arrival
                ? `<small>抵達</small><b>${arrival}</b>`
                : '<small class="rp-arrive-empty">—</small>')
        }</span>
        ${infoBtn}
      </div><div class="rp-info-row${infoOpen ? ' rp-info-row-open' : ''}" data-info-key="${escapeHtml(infoKey)}">
        <span class="rp-info-stamp">▲ DETAILS</span>
        <span class="rp-info-base">基準 <b>${r.base_minutes}</b><small>分</small></span>
        <span class="rp-info-km">${r.distance_km.toFixed(1)}<small>km</small></span>
        ${elevBits.join('')}
      </div>${noteHtml}`;
    }).join('');

    // Route-variant pickers — moved INLINE into the segment list right at
    // the fork point (kind:'variant-fork' rows in collectRestPoints). The
    // separate top-of-table chip strip is gone; the chips now sit between
    // "排雲山莊→主北岔(風口)" and "主北岔→玉山北峰" — exactly where the
    // user makes the decision in real life.

    // Per-row open state for the triangulation-benchmark toggle. Lives on
    // host so re-renders (speed factor, minute edit, etc) preserve which
    // rows the user expanded. Set keys: dayId|variantId|segIdx|F-or-R.
    if (!host._openInfoRows) host._openInfoRows = new Set();

    host.innerHTML = `
      <div class="rp-head">
        <div class="rp-title">休息點<span class="rp-title-en">REST POINTS</span></div>
      </div>
      <div class="rp-speed-control">
        <label for="overview-speed" class="rp-sc-lbl">上河速度倍率</label>
        <input type="number" class="rp-speed-input"
               id="overview-speed"
               min="0.5" max="2.5" step="0.05" value="${factor.toFixed(2)}"
               inputmode="decimal" aria-label="上河速度倍率">
        <span class="rp-sc-x">×</span>
        <span class="rp-sc-hint">1.0 = 上河基準｜&gt;1 較慢｜&lt;1 較快｜點選列以聚焦該段</span>
      </div>
      <div class="rp-list">${rowsHtml}</div>
      ${(document.body.classList.contains('tf-editing')) ? `<div class="rp-day-add-row">
        <button type="button" class="rp-day-add-btn" data-add-kind="prepend" title="在最前面加一天（沒 D0 時自動帶出發日模板）">＋ 加在前面</button>
        <button type="button" class="rp-day-add-btn" data-add-kind="append" title="在最後面追加一天">＋ 多加一天</button>
      </div>` : ''}
      <div class="rp-total">
        <span class="rp-total-l">全程總計</span>
        <span class="rp-total-meta">
          <span class="rp-total-km">${totalKm.toFixed(1)}<small>km</small></span>
          <span class="rp-total-asc">↑${totalAsc}<small>m</small></span>
          <span class="rp-total-desc">↓${totalDesc}<small>m</small></span>
        </span>
        <span class="rp-total-time">
          <span class="rp-total-derived">${fmtMin(totalDerived)}</span>
          <small class="rp-total-base">基準 ${fmtMin(totalBase)}</small>
        </span>
      </div>`;

    // ── Bind per-row info buttons (the "!" detail toggle) ──
    // Bound ONCE per host. renderRestPoints fires on every speed/minute
    // edit and host.innerHTML wipes its children, but the host element
    // itself persists — so addEventListener on every render stacks N
    // handlers; with N≥2 the toggles cancel each other and clicks look
    // broken. _infoBtnBound gate fixes this.
    if (!host._infoBtnBound) {
      host._infoBtnBound = true;
      host.addEventListener('click', (e) => {
        const btn = e.target.closest('.rp-info-btn');
        if (!btn || !host.contains(btn)) return;
        e.stopPropagation();
        const key = btn.dataset.infoKey;
        if (!key) return;
        const row = btn.closest('.rp-row');
        const infoRow = row && row.nextElementSibling && row.nextElementSibling.classList.contains('rp-info-row')
          ? row.nextElementSibling
          : null;
        const nowOpen = !host._openInfoRows.has(key);
        if (nowOpen) host._openInfoRows.add(key); else host._openInfoRows.delete(key);
        btn.setAttribute('aria-pressed', nowOpen ? 'true' : 'false');
        if (row) row.classList.toggle('rp-row-info-open', nowOpen);
        if (infoRow) infoRow.classList.toggle('rp-info-row-open', nowOpen);
      });
    }

    // ── Bind speed input ── (event delegation not used so input.value can
    //    be normalised in onChange before re-render).
    const input = host.querySelector('#overview-speed');
    if (input) {
      const refreshChart = () => {
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
      };
      const onChange = () => {
        let f = parseFloat(input.value);
        if (!Number.isFinite(f) || f < 0.5) f = 0.5;
        if (f > 2.5) f = 2.5;
        input.value = f.toFixed(2);
        writeSpeed(f);
        renderRestPoints(plan, f);
        refreshChart();
      };
      input.addEventListener('change', onChange);
      // No `input` listener — every keystroke would re-render the host's
      // innerHTML and destroy the very <input> the user is typing in,
      // making the speed factor essentially uneditable. Re-render only
      // on `change` (blur / Enter) which preserves focus during typing.
    }

    // Helper: resolve the live segments array for a given (dayId, variantId).
    function resolveSegArr(dayId, variantId) {
      const day = (plan.days || []).find(d => d.id === dayId);
      if (!day || !day.elevation_profile) return null;
      if (variantId) {
        const rv = day.elevation_profile.route_variants;
        return rv && rv[variantId] && rv[variantId].shanghe_segments;
      }
      return day.elevation_profile.shanghe_segments;
    }

    // ── Bind per-segment note inputs (edit mode only) ──
    // Both .rp-note-input (transit segs, sibling note row) and
    // .rp-sub-rest-note-edit (compact rest sub-row, inline note) write
    // through to seg.note. Data attrs sit on the input itself for the
    // sub-rest case; for transit, fall back to the wrapping .rp-note-row.
    host.querySelectorAll('.rp-note-input, .rp-sub-rest-note-edit').forEach((inp) => {
      inp.addEventListener('input', () => {
        const ds = inp.dataset.segIdx ? inp.dataset : (inp.closest('.rp-note-row') || {}).dataset;
        if (!ds || ds.segIdx == null) return;
        const segArr = resolveSegArr(ds.dayId, ds.variantId || null);
        const segIdx = +ds.segIdx;
        if (!Array.isArray(segArr) || !segArr[segIdx]) return;
        segArr[segIdx].note = inp.value;
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
      });
    });

    // ── Bind per-segment 分鐘 inputs ──────────────────────────────────
    // The input shows the DERIVED minutes (base_minutes × speed factor)
    // since that's the number the user reads from the table. On edit we
    // back out base_minutes = round(typed / factor) so the speed-factor
    // mechanism stays consistent. Live mutate on `input`; full re-render
    // on `change` (blur / Enter) so derived/arrival/chart all refresh.
    host.querySelectorAll('.rp-min-edit').forEach((inp) => {
      const writeBase = () => {
        const factor = readSpeed() || 1;
        const typed = Math.max(0, Math.round(+inp.value || 0));
        const newBase = Math.max(0, Math.round(typed / factor));
        // Return-row writes go to the SOURCE day's seg.descent_override_minutes
        // (buildReverseSegments reads override-first, factor as fallback).
        const sourceDayId = inp.dataset.sourceDayId || '';
        const sourceSegIdx = inp.dataset.sourceSegIdx;
        if (sourceDayId && sourceSegIdx !== '') {
          const srcArr = resolveSegArr(sourceDayId, null);
          const sIdx = +sourceSegIdx;
          if (!Array.isArray(srcArr) || !srcArr[sIdx]) return false;
          if (srcArr[sIdx].descent_override_minutes === newBase) return false;
          srcArr[sIdx].descent_override_minutes = newBase;
          if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
          return true;
        }
        const segArr = resolveSegArr(inp.dataset.dayId, inp.dataset.variantId || null);
        const segIdx = +inp.dataset.segIdx;
        if (!Array.isArray(segArr) || !segArr[segIdx]) return false;
        if (segArr[segIdx].base_minutes === newBase) return false;
        segArr[segIdx].base_minutes = newBase;
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        return true;
      };
      // Live mutate on input (so the dirty flag flips immediately) but
      // skip the rerender to keep focus. Rerender unconditionally on
      // change (blur/Enter) — the per-input writeBase has usually
      // already updated base_minutes, so the early-return guard inside
      // it must NOT gate the rerender.
      inp.addEventListener('input', writeBase);
      inp.addEventListener('change', () => {
        writeBase();
        renderRestPoints(plan, readSpeed() || 1);
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
      });
    });

    // ── Bind per-segment 抵達時間 inputs ──────────────────────────────
    // Bidirectional with the 分鐘 input: editing the arrival clock
    // back-solves base_minutes so the segment ends at the typed time.
    // Same source-row dispatch as min-edit (return rows write to the
    // source D1 seg's descent_override_minutes). Cumulative downstream
    // arrivals shift on rerender, mirroring the user's mental model.
    host.querySelectorAll('.rp-arrive-edit').forEach((inp) => {
      const writeFromArrival = () => {
        const factor = readSpeed() || 1;
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(inp.value || ''));
        if (!m) return false;
        const newArr = (+m[1]) * 60 + (+m[2]);
        const dayStart = +inp.dataset.dayStartMin;
        const cumBefore = +inp.dataset.cumBefore;
        if (!Number.isFinite(dayStart) || !Number.isFinite(cumBefore)) return false;
        // base_minutes is in raw (un-factored) minutes; the displayed
        // clock is dayStart + cum*factor. Solve for the new base.
        const wantCumAfter = (newArr - dayStart) / factor;
        let newBase = Math.round(wantCumAfter - cumBefore);
        if (newBase < 0) newBase = 0;
        const sourceDayId = inp.dataset.sourceDayId || '';
        const sourceSegIdx = inp.dataset.sourceSegIdx;
        if (sourceDayId && sourceSegIdx !== '') {
          const srcArr = resolveSegArr(sourceDayId, null);
          const sIdx = +sourceSegIdx;
          if (!Array.isArray(srcArr) || !srcArr[sIdx]) return false;
          if (srcArr[sIdx].descent_override_minutes === newBase) return false;
          srcArr[sIdx].descent_override_minutes = newBase;
        } else {
          const segArr = resolveSegArr(inp.dataset.dayId, inp.dataset.variantId || null);
          const segIdx = +inp.dataset.segIdx;
          if (!Array.isArray(segArr) || !segArr[segIdx]) return false;
          if (segArr[segIdx].base_minutes === newBase) return false;
          segArr[segIdx].base_minutes = newBase;
        }
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        return true;
      };
      inp.addEventListener('change', () => {
        writeFromArrival();
        renderRestPoints(plan, readSpeed() || 1);
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
      });
    });

    // ── Bind per-segment branch buttons (edit mode only) ──
    // Click → opens an inline split form below the segment row asking for
    // a new intermediate waypoint name + how many minutes from the segment
    // start it sits. On confirm, splits the segment into two proportionally.
    // Future: wire this to a GPX+OSM rest-point scanner that suggests known
    // stops between the two anchor points.
    host.querySelectorAll('.rp-branch-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        // Button now lives in .rp-cost (next to the derived-minutes
        // value), not in the note row. Read data straight off the
        // button and use the parent .rp-row as the anchor for the form.
        const dayId = btn.dataset.dayId;
        const variantId = btn.dataset.variantId || null;
        const segIdx = +btn.dataset.segIdx;
        const wrap = btn.closest('.rp-row');
        if (!wrap) return;
        const day = (plan.days || []).find(d => d.id === dayId);
        if (!day) return;
        const segArr = resolveSegArr(dayId, variantId);
        if (!Array.isArray(segArr) || !segArr[segIdx]) return;
        const seg = segArr[segIdx];
        // Toggle inline form
        let form = wrap.nextElementSibling;
        // Skip the per-segment note row that may sit between rp-row and
        // the form anchor — it's part of the same logical row.
        if (form && form.classList.contains('rp-note-row')) form = form.nextElementSibling;
        if (form && form.classList.contains('rp-branch-form')) {
          form.remove();
          return;
        }
        // Fade rows BELOW the current row to communicate "this branch
        // replaces the rest of the path". closeForm() restores them.
        const segListHost = wrap.parentNode;
        segListHost.classList.add('rp-branching');
        // Anchor is either the rp-row or its sibling note row, whichever
        // sits last for THIS segment.
        let anchor = wrap;
        if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('rp-note-row')) {
          anchor = anchor.nextElementSibling;
        }
        let cur = anchor.nextSibling;
        while (cur) {
          if (cur.nodeType === 1) cur.classList.add('rp-faded-out');
          cur = cur.nextSibling;
        }
        const prefixInfo = nextVariantPrefix(day);
        form = document.createElement('div');
        form.className = 'rp-branch-form';
        form.innerHTML = `
          <div class="rp-branch-head">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="4" cy="3" r="1.6" fill="currentColor"/><circle cx="4" cy="13" r="1.6" fill="currentColor"/><circle cx="12" cy="8" r="1.6" fill="currentColor"/>
              <path d="M4 4.5v7" stroke="currentColor" stroke-width="1.4" fill="none"/>
              <path d="M4 7.5 q 0 -2 4 -2 t 4 1" stroke="currentColor" stroke-width="1.4" fill="none"/>
            </svg>
            從 <b>${escapeHtml(seg.to)}</b> 創建一個新的路線分歧
          </div>
          <div class="rp-branch-fields">
            <label><span>新路線名稱</span>
              <span class="rp-branch-name-row">
                <span class="rp-branch-prefix" aria-label="自動編號">${escapeHtml(prefixInfo.prefix)}</span>
                <input type="text" class="rp-branch-suffix" placeholder="例如：北峰+主峰 或 僅主峰" autocomplete="off">
              </span>
            </label>
          </div>
          <div class="rp-branch-actions">
            <button type="button" class="rp-branch-cancel">取消</button>
            <button type="button" class="rp-branch-confirm">＋ 建立新路線</button>
          </div>
          <p class="rp-branch-hint">${escapeHtml(prefixInfo.prefix)} 會自動編號；只需描述這條路線的差異即可。建立後以 <b>${escapeHtml(seg.to)}</b> 為分歧點，下方路線會清空。</p>
        `;
        anchor.parentNode.insertBefore(form, anchor.nextSibling);
        const labelEl = form.querySelector('.rp-branch-suffix');
        if (labelEl) labelEl.focus();

        // Helper: cleanly close the form + restore faded-out rows below.
        const closeForm = () => {
          form.remove();
          segListHost.classList.remove('rp-branching');
          segListHost.querySelectorAll('.rp-faded-out').forEach(el => el.classList.remove('rp-faded-out'));
        };

        form.querySelector('.rp-branch-cancel').addEventListener('click', closeForm);
        form.querySelector('.rp-branch-confirm').addEventListener('click', () => {
          const suffixInput = form.querySelector('.rp-branch-suffix');
          const suffix = (suffixInput.value || '').trim() || '新路線';
          const newLabel = prefixInfo.prefix + suffix;
          const newId = createForkVariant(day, segIdx, variantId, newLabel);
          if (!newId) {
            console.warn('[trailforge] createForkVariant failed');
            return;
          }
          if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
          renderRestPoints(plan, readSpeed());
          if (TF.modeToggle && TF.modeToggle.refreshAll) {
            requestAnimationFrame(() => TF.modeToggle.refreshAll());
          }
          if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        });
      });
    });

    // ── Bind "+ 新增休息點" buttons (per-day end of segments OR per-row) ──
    host.querySelectorAll('.rp-add-seg-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const dayId = btn.dataset.dayId;
        const variantId = btn.dataset.variantId || null;
        const afterIdx = btn.dataset.afterIdx === '' ? -1 : +btn.dataset.afterIdx;  // -1 = append at end
        const segArr = resolveSegArr(dayId, variantId);
        if (!Array.isArray(segArr)) return;
        // Toggle inline form below the button
        let form = btn.parentElement.nextElementSibling;
        if (form && form.classList.contains('rp-add-seg-form')) {
          form.remove();
          return;
        }
        const lastSeg = afterIdx >= 0 ? segArr[afterIdx] : segArr[segArr.length - 1];
        const fromName = lastSeg ? lastSeg.to : '';
        const datalistId2 = 'rp-wp-add-' + Math.random().toString(36).slice(2, 8);
        const sugg = collectKnownWaypointNames(plan);
        form = document.createElement('div');
        form.className = 'rp-add-seg-form';
        // Look up the FROM-anchor once so subsequent name picks can
        // derive distance / asc / desc from GPX point arithmetic.
        const fromAnchor = findWaypointTrackIdx(plan, fromName);
        form.innerHTML = `
          <div class="rp-branch-head">＋ 新增地標</div>
          <div class="rp-branch-fields">
            <label><span>從</span><span class="rp-add-from">${escapeHtml(fromName || '起點')}</span></label>
            <label><span>下一個地標</span>
              <input type="text" class="rp-add-name" list="${datalistId2}" placeholder="輸入或從建議清單選擇" autocomplete="off">
              <datalist id="${datalistId2}">
                ${sugg.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}
              </datalist>
            </label>
            <label><span>步行</span><input type="number" class="rp-add-min" min="1" value="60"><span class="rp-branch-unit">分</span></label>
            <label><span>距離</span><input type="number" class="rp-add-km" min="0" step="0.1" value="0"><span class="rp-branch-unit">km</span></label>
            <label><span>↑</span><input type="number" class="rp-add-asc" min="0" value="0"><span class="rp-branch-unit">m</span></label>
            <label><span>↓</span><input type="number" class="rp-add-desc" min="0" value="0"><span class="rp-branch-unit">m</span></label>
          </div>
          <div class="rp-add-gpx-status" hidden></div>
          <div class="rp-branch-actions">
            <button type="button" class="rp-branch-cancel">取消</button>
            <button type="button" class="rp-branch-confirm">＋ 新增</button>
          </div>
        `;
        btn.parentElement.parentNode.insertBefore(form, btn.parentElement.nextSibling);
        const nameInput = form.querySelector('.rp-add-name');
        const kmInput   = form.querySelector('.rp-add-km');
        const ascInput  = form.querySelector('.rp-add-asc');
        const descInput = form.querySelector('.rp-add-desc');
        const minInput  = form.querySelector('.rp-add-min');
        const status    = form.querySelector('.rp-add-gpx-status');
        // Track which numeric fields the user has typed in by hand —
        // we won't overwrite those from GPX. Manual edits set a marker.
        const manual = { km: false, asc: false, desc: false, min: false };
        const markManual = (key) => () => { manual[key] = true; };
        kmInput.addEventListener('input', markManual('km'));
        ascInput.addEventListener('input', markManual('asc'));
        descInput.addEventListener('input', markManual('desc'));
        minInput.addEventListener('input', markManual('min'));
        // On name change (datalist pick or blur), if both endpoints
        // resolve to the same GPX track, auto-fill numeric fields with
        // straight-line GPX-derived stats. Skip fields the user already
        // edited.
        const tryAutofill = () => {
          const picked = nameInput.value.trim();
          if (!picked || !fromAnchor) {
            status.hidden = true; status.textContent = '';
            return;
          }
          const toAnchor = findWaypointTrackIdx(plan, picked);
          if (!toAnchor) {
            status.hidden = false;
            status.className = 'rp-add-gpx-status rp-gpx-miss';
            status.textContent = '此地標尚無 GPX 對應點，請手動填入距離 / 海拔';
            return;
          }
          if (toAnchor.trackRef !== fromAnchor.trackRef) {
            status.hidden = false;
            status.className = 'rp-add-gpx-status rp-gpx-miss';
            status.textContent = '兩端 GPX 軌跡不同，無法自動估算';
            return;
          }
          const stats = gpxStatsBetween(plan, fromAnchor.trackRef, fromAnchor.idx, toAnchor.idx);
          if (!stats) {
            status.hidden = false;
            status.className = 'rp-add-gpx-status rp-gpx-miss';
            status.textContent = 'GPX 資料不足，無法估算';
            return;
          }
          if (!manual.km)   kmInput.value   = stats.distance_km;
          if (!manual.asc)  ascInput.value  = stats.ascent_m;
          if (!manual.desc) descInput.value = stats.descent_m;
          const naismith = computeBaseMinutes(stats.distance_km, stats.ascent_m, stats.descent_m);
          if (!manual.min)  minInput.value  = naismith;
          status.hidden = false;
          status.className = 'rp-add-gpx-status rp-gpx-hit';
          status.textContent = `已由 GPX 估算：${stats.distance_km} km　↑${stats.ascent_m}m　↓${stats.descent_m}m　≈ ${naismith} 分（Naismith；可手動覆寫）`;
        };
        nameInput.addEventListener('change', tryAutofill);
        nameInput.addEventListener('blur',   tryAutofill);
        nameInput.focus();
        form.querySelector('.rp-branch-cancel').addEventListener('click', () => form.remove());
        form.querySelector('.rp-branch-confirm').addEventListener('click', () => {
          const name = nameInput.value.trim();
          if (!name) { nameInput.focus(); return; }
          // Anchor the new segment's from/to to the GPX track if we
          // resolved both ends — keeps chart focus, tooltips and future
          // GPX recomputes consistent.
          const toAnchor = findWaypointTrackIdx(plan, name);
          let anchor_idx = null;
          if (fromAnchor && toAnchor && fromAnchor.trackRef === toAnchor.trackRef) {
            anchor_idx = [fromAnchor.idx, toAnchor.idx];
          }
          const insertIdx = afterIdx >= 0 ? afterIdx + 1 : segArr.length;
          segArr.splice(insertIdx, 0, {
            id: 'seg-' + Math.random().toString(36).slice(2, 7),
            from: fromName,
            to: name,
            base_minutes: +form.querySelector('.rp-add-min').value || 0,
            distance_km: +kmInput.value || 0,
            ascent_m: +ascInput.value || 0,
            descent_m: +descInput.value || 0,
            anchor_idx,
            note: '',
          });
          if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
          renderRestPoints(plan, readSpeed());
          if (TF.modeToggle && TF.modeToggle.refreshAll) {
            requestAnimationFrame(() => TF.modeToggle.refreshAll());
          }
          if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        });
      });
    });

    // ── Bind ✕ delete-segment buttons ─────────────────────────────────
    // Removes a LANDMARK (the segment's `to` waypoint), healing the
    // chain: if there's a segment after this one, it's merged into the
    // current row — combined km / asc / desc, or re-derived from GPX
    // if both endpoints share a track. This means deleting 白木林 from
    // 塔塔加→白木林→排雲山莊 yields 塔塔加→排雲山莊 with the elevation
    // curve unchanged (since the curve is GPX-driven, not segment-sum).
    host.querySelectorAll('.rp-del-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dayId = btn.dataset.dayId;
        const variantId = btn.dataset.variantId || null;
        const segIdx = +btn.dataset.segIdx;
        const toName = btn.dataset.toName || '此地標';
        const segArr = resolveSegArr(dayId, variantId);
        if (!Array.isArray(segArr) || !segArr[segIdx]) return;
        let ok = true;
        if (typeof window.tfConfirm === 'function') {
          ok = await window.tfConfirm({
            title: '刪除地標',
            message: `確定要從路線中移除「${toName}」嗎？兩側路段會自動合併。`,
            confirmText: '刪除',
            cancelText: '取消',
            destructive: true,
          });
        } else {
          ok = window.confirm(`刪除「${toName}」？`);
        }
        if (!ok) return;
        const cur  = segArr[segIdx];
        const next = segArr[segIdx + 1];
        if (next) {
          // Heal the chain. Try GPX recompute first; fall back to
          // straight-sum of the two segments' stats.
          const fromAnchor = cur.anchor_idx && cur.anchor_idx[0] != null
            ? { trackRef: cur.gpx_ref || null, idx: cur.anchor_idx[0] }
            : null;
          const toAnchor = next.anchor_idx && next.anchor_idx[1] != null
            ? { trackRef: next.gpx_ref || null, idx: next.anchor_idx[1] }
            : null;
          let derived = null;
          if (fromAnchor && toAnchor) {
            // Resolve the actual gpx_ref via day-level metadata if the
            // segments don't carry their own — same fallback rule as
            // findWaypointTrackIdx.
            const day = (plan.days || []).find(d => d.id === dayId);
            const ep = day && day.elevation_profile;
            const ref = fromAnchor.trackRef || toAnchor.trackRef
                     || (day && day.gpx_ref) || (ep && ep.gpx_ref) || null;
            if (ref) derived = gpxStatsBetween(plan, ref, fromAnchor.idx, toAnchor.idx);
          }
          // When GPX gave us a fresh distance/ascent for the merged leg,
          // re-derive base_minutes from Naismith too — straight summing
          // the two old base_minutes values would over-count if the
          // detour through the deleted landmark added time the direct
          // route doesn't need.
          const mergedMinutes = derived
            ? computeBaseMinutes(derived.distance_km, derived.ascent_m, derived.descent_m)
            : (+cur.base_minutes || 0) + (+next.base_minutes || 0);
          const merged = Object.assign({}, next, {
            from: cur.from,
            base_minutes: mergedMinutes,
            distance_km: derived ? derived.distance_km : ((+cur.distance_km || 0) + (+next.distance_km || 0)),
            ascent_m:    derived ? derived.ascent_m    : ((+cur.ascent_m    || 0) + (+next.ascent_m    || 0)),
            descent_m:   derived ? derived.descent_m   : ((+cur.descent_m   || 0) + (+next.descent_m   || 0)),
            anchor_idx: (cur.anchor_idx && next.anchor_idx)
              ? [cur.anchor_idx[0], next.anchor_idx[1]]
              : (next.anchor_idx || cur.anchor_idx || null),
            note: next.note || '',
          });
          segArr.splice(segIdx, 2, merged);
        } else {
          // Last segment — no neighbour to merge with, just drop it.
          segArr.splice(segIdx, 1);
        }
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        renderRestPoints(plan, readSpeed());
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
      });
    });

    // ── Bind "+ 休息" buttons (in-place rest stop, no movement) ────────
    // Inserts a synthetic segment with from===to, distance/asc/desc=0,
    // base_minutes = user input. Optional name (e.g. "午餐", "茶水")
    // becomes the segment's "to" so the row reads "排雲山莊→排雲山莊・午餐".
    host.querySelectorAll('.rp-add-rest-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const dayId = btn.dataset.dayId;
        const variantId = btn.dataset.variantId || null;
        const afterIdx = btn.dataset.afterIdx === '' ? -1 : +btn.dataset.afterIdx;
        const atName = btn.dataset.atName || '';
        const segArr = resolveSegArr(dayId, variantId);
        if (!Array.isArray(segArr)) return;
        // Toggle inline form below the button row
        let form = btn.parentElement.nextElementSibling;
        if (form && form.classList.contains('rp-add-rest-form')) {
          form.remove();
          return;
        }
        // Remove any other open form on this row
        if (form && (form.classList.contains('rp-add-seg-form') || form.classList.contains('rp-add-rest-form'))) {
          form.remove();
        }
        form = document.createElement('div');
        form.className = 'rp-add-rest-form';
        form.innerHTML = `
          <div class="rp-branch-head">＋ 原地休息　<small style="font-weight:400; opacity:.7">於 <b>${escapeHtml(atName || '當前位置')}</b></small></div>
          <div class="rp-branch-fields">
            <label><span>停留</span><input type="number" class="rp-rest-min" min="1" value="30"><span class="rp-branch-unit">分</span></label>
            <small class="rp-rest-hint">用餐／補水／拍照等說明請於建立後填入該段備註欄</small>
          </div>
          <div class="rp-branch-actions">
            <button type="button" class="rp-branch-cancel">取消</button>
            <button type="button" class="rp-branch-confirm">＋ 新增</button>
          </div>
        `;
        btn.parentElement.parentNode.insertBefore(form, btn.parentElement.nextSibling);
        form.querySelector('.rp-rest-min').focus();
        form.querySelector('.rp-rest-min').select();
        form.querySelector('.rp-branch-cancel').addEventListener('click', () => form.remove());
        form.querySelector('.rp-branch-confirm').addEventListener('click', () => {
          const mins = +form.querySelector('.rp-rest-min').value || 0;
          if (mins <= 0) { form.querySelector('.rp-rest-min').focus(); return; }
          // from === to so the next walking segment's auto-derived "from"
          // still reads correctly (the next segment didn't move). The
          // user describes WHY the rest happened in the per-segment 備註.
          const insertIdx = afterIdx >= 0 ? afterIdx + 1 : segArr.length;
          segArr.splice(insertIdx, 0, {
            id: 'rest-' + Math.random().toString(36).slice(2, 7),
            from: atName,
            to: atName,
            base_minutes: mins,
            distance_km: 0,
            ascent_m: 0,
            descent_m: 0,
            anchor_idx: null,
            note: '',
            is_rest_stop: true,
          });
          if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
          renderRestPoints(plan, readSpeed());
          if (TF.modeToggle && TF.modeToggle.refreshAll) {
            requestAnimationFrame(() => TF.modeToggle.refreshAll());
          }
          if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        });
      });
    });

    // ── Helpers shared by branch form / add-seg form ───────────────────

    // Compute the auto-generated "Day 2C・" style prefix for the next
    // variant on this day. The user only ever writes the descriptive
    // tail (e.g. "北峰+主峰" / "僅主峰"); the system keeps the Day-letter
    // identity in sync with the variant id, so promoting/renaming
    // doesn't drift between the two.
    //   Returns: { prefix, letter, dayNum }
    function nextVariantPrefix(day) {
      const ep = day && day.elevation_profile;
      const dayNum = (day.id || '').replace(/^d/, '');
      // First fork → letter B (we'll promote the existing day to "main"
      // which keeps its own existing label, and the user's branch
      // becomes Day NB).
      if (!ep || !ep.route_variants) {
        return { prefix: `Day ${dayNum}B・`, letter: 'B', dayNum };
      }
      const ids = Object.keys(ep.route_variants);
      const letters = ids
        .map(id => /^d\d+([a-z])$/.exec(id) || /^([a-z])$/.exec(id))
        .map(m => m && m[1] || '')
        .filter(Boolean);
      // First existing variant is 'main' → it occupies the A slot.
      let next = 'a';
      const occupied = new Set(letters);
      occupied.add('a'); // main = A
      while (occupied.has(next)) next = String.fromCharCode(next.charCodeAt(0) + 1);
      return {
        prefix: `Day ${dayNum}${next.toUpperCase()}・`,
        letter: next.toUpperCase(),
        dayNum,
      };
    }

    function suggestNextVariantLabel(day) {
      const p = nextVariantPrefix(day);
      return p.prefix + '新路線';
    }

    // Create a new route variant by forking the current variant at fromSegIdx.
    // Promotes a non-variant day into route_variants on first fork. Returns
    // the new variant's id, or null on failure. Also adds an entry to
    // day.routes (the front-end tab strip) and switches active to the new id.
    function createForkVariant(day, fromSegIdx, currentVariantId, newLabel) {
      const ep = day && day.elevation_profile;
      if (!ep) return null;
      // 1) Promote to route_variants if needed
      if (!ep.route_variants) {
        ep.route_variants = {};
        const mainSegs = ep.shanghe_segments || [];
        const mainId = 'main';
        ep.route_variants[mainId] = {
          label: day.label || 'Day ' + day.id,
          shanghe_segments: JSON.parse(JSON.stringify(mainSegs)),
          summit_idx: ep.summit_idx,
          summit_label: ep.summit_label,
          direction: ep.direction || 'ascent_only',
        };
        ep.default_variant = mainId;
        if (!Array.isArray(day.routes)) day.routes = [];
        if (!day.routes.find(r => r.id === mainId)) {
          day.routes.unshift({
            id: mainId,
            tab_label: day.label || 'Day ' + day.id,
            tag_class: mainId,
            tag_text: day.label || 'Day ' + day.id,
            active: true,
            schedule: day.schedule || [],
          });
        }
        currentVariantId = currentVariantId || mainId;
      }
      // 2) Generate a new id
      const ids = Object.keys(ep.route_variants);
      const baseLetter = (ids.map(id => /^d\d+([a-z])$/.exec(id))
                            .map(m => m && m[1])
                            .filter(Boolean)
                            .sort().pop() || 'a');
      let nextLetter = String.fromCharCode(baseLetter.charCodeAt(0) + 1);
      const dayNum = (day.id || '').replace(/^d/, '');
      let newId = `d${dayNum}${nextLetter}`;
      let safety = 0;
      while (ep.route_variants[newId] && safety++ < 26) {
        nextLetter = String.fromCharCode(nextLetter.charCodeAt(0) + 1);
        newId = `d${dayNum}${nextLetter}`;
      }
      if (ep.route_variants[newId]) newId = 'fork-' + Math.random().toString(36).slice(2, 6);
      // 3) Copy shared prefix segments (up to and including fromSegIdx)
      const srcSegs = (ep.route_variants[currentVariantId] || {}).shanghe_segments
                    || ep.shanghe_segments || [];
      const sharedPrefix = srcSegs.slice(0, fromSegIdx + 1).map(s => Object.assign({}, s, {
        id: (s.id || 'seg') + '-' + newId,
      }));
      ep.route_variants[newId] = {
        label: newLabel || (`Day ${dayNum}${nextLetter.toUpperCase()}・新路線`),
        shanghe_segments: sharedPrefix,
        direction: 'ascent_only',
      };
      // 4) Add to day.routes tabs
      if (!Array.isArray(day.routes)) day.routes = [];
      day.routes.forEach(r => { r.active = false; });
      day.routes.push({
        id: newId,
        tab_label: newLabel || `Day ${dayNum}${nextLetter.toUpperCase()}`,
        tag_class: newId,
        tag_text: newLabel || `Day ${dayNum}${nextLetter.toUpperCase()}`,
        active: true,
        schedule: [],
      });
      return newId;
    }

    // ── GPX-derived geometry helpers ──────────────────────────────────────
    // Same haversine + cum-distance + ascent/descent maths used by
    // plan-from-gpx.js, copied here so the rest-points editor can derive
    // distance / ascent / descent for a NEW segment when both endpoints
    // are known waypoints with anchor_idx → GPX track points.
    function _haversine(a1, o1, a2, o2) {
      const R = 6371e3;
      const dL = ((a2 - a1) * Math.PI) / 180;
      const dO = ((o2 - o1) * Math.PI) / 180;
      const a = Math.sin(dL / 2) ** 2 +
                Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
                Math.sin(dO / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    // Look up the GPX track index of a waypoint by name, by scanning
    // existing segments' anchor_idx pairs (segment.from → anchor_idx[0],
    // segment.to → anchor_idx[1]) across all days and variants. Also
    // consults GPX <wpt> markers if the loaded GPX exposes them with
    // pre-snapped indices on `__JM_GPX__.__wpts`.
    // Returns { trackRef, idx } or null. trackRef tells us which GPX
    // track in plan.data.gpx_tracks the index belongs to; segments
    // without an explicit gpx_ref fall back to the day's gpx_ref.
    function findWaypointTrackIdx(plan, name) {
      if (!name) return null;
      const target = String(name).trim();
      const days = plan.days || [];
      for (const d of days) {
        const ep = d.elevation_profile;
        if (!ep) continue;
        const dayRef = d.gpx_ref || ep.gpx_ref || null;
        const scan = (segs, vRef) => {
          for (const s of (segs || [])) {
            const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : null;
            if (!ai || ai.length < 2) continue;
            if (s.from === target) return { trackRef: s.gpx_ref || vRef || dayRef, idx: ai[0] };
            if (s.to === target)   return { trackRef: s.gpx_ref || vRef || dayRef, idx: ai[1] };
          }
          return null;
        };
        const fromMain = scan(ep.shanghe_segments, dayRef);
        if (fromMain) return fromMain;
        if (ep.route_variants) {
          for (const vid of Object.keys(ep.route_variants)) {
            const v = ep.route_variants[vid];
            const fromV = scan(v && v.shanghe_segments, v && v.gpx_ref || dayRef);
            if (fromV) return fromV;
          }
        }
      }
      return null;
    }
    // Compute distance / ascent / descent between two GPX track indices
    // on the same track. Returns null if the track isn't loaded or the
    // indices are degenerate.
    function gpxStatsBetween(plan, trackRef, idxA, idxB) {
      if (!trackRef || idxA == null || idxB == null) return null;
      const tracks = plan && plan.data && plan.data.gpx_tracks;
      const track = tracks && tracks[trackRef];
      if (!Array.isArray(track) || track.length < 2) return null;
      const lo = Math.min(idxA, idxB);
      const hi = Math.max(idxA, idxB);
      if (lo === hi || hi >= track.length) return null;
      let dist = 0, asc = 0, desc = 0;
      for (let i = lo + 1; i <= hi; i++) {
        const p0 = track[i - 1];
        const p1 = track[i];
        if (!p0 || !p1) continue;
        dist += _haversine(p0[0], p0[1], p1[0], p1[1]);
        const dE = (p1[2] || 0) - (p0[2] || 0);
        if (dE > 0) asc += dE;
        else        desc -= dE;
      }
      // If the user picked B before A in the GPX track (i.e. they're
      // walking the track in reverse), swap ascent/descent so the
      // returned numbers match the *direction of travel*.
      const reversed = idxA > idxB;
      return {
        distance_km: +(dist / 1000).toFixed(2),
        ascent_m:  Math.round(reversed ? desc : asc),
        descent_m: Math.round(reversed ? asc  : desc),
      };
    }

    // Helper for the branch form's name autocomplete: union of every
    // segment endpoint across the plan + any GPX waypoint names if loaded.
    function collectKnownWaypointNames(plan) {
      const set = new Set();
      const add = (n) => { const s = String(n || '').trim(); if (s) set.add(s); };
      (plan.days || []).forEach(d => {
        const ep = d.elevation_profile;
        if (!ep) return;
        (ep.shanghe_segments || []).forEach(s => { add(s.from); add(s.to); });
        if (ep.route_variants) {
          Object.values(ep.route_variants).forEach(v => {
            (v.shanghe_segments || []).forEach(s => { add(s.from); add(s.to); });
          });
        }
        if (ep.summit_label) add(ep.summit_label);
      });
      // GPX waypoints (uploaded via gpx-io). Names live on each <wpt>'s name.
      const wpts = (window.__JM_GPX_WPTS__) || (window.__JM_GPX__ && window.__JM_GPX__.__wpts) || [];
      if (Array.isArray(wpts)) wpts.forEach(w => add(w && w.name));
      return [...set].sort();
    }

    // ── Bind day section_title inputs (edit mode only) ──
    // ── Bind add-day buttons (edit mode only) ────────────────────────
    // "+ 出發日 (D0)" prepends a transport/lodging day; "+ 多加一天"
    // appends a blank trailing day. Both produce empty elevation_profile
    // so future + 地標 / + 休息 actions start from a clean slate. setDirty
    // + refresh chart + render so day-bar / chart pick up the new day.
    // ── Bind delete-day buttons (edit mode only) ────────────────────
    // ✕ on the day-header. Confirm via tfConfirm; on accept, splice
    // the day out of plan.days, refresh meta dates, and re-render.
    host.querySelectorAll('.rp-day-del-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dayId = btn.dataset.dayId;
        const label = btn.dataset.dayLabel || dayId;
        const days = plan.days || [];
        const idx = days.findIndex(d => d.id === dayId);
        if (idx < 0) return;
        let ok = true;
        if (typeof window.tfConfirm === 'function') {
          ok = await window.tfConfirm({
            title: '刪除此日',
            message: `確定要刪除「${label}」整天嗎？此天的所有地標、休息、備註都會一併移除。`,
            confirmText: '刪除',
            cancelText: '取消',
            destructive: true,
          });
        } else {
          ok = window.confirm(`刪除「${label}」整天？`);
        }
        if (!ok) return;
        days.splice(idx, 1);
        refreshMetaDates(plan);
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        renderRestPoints(plan, readSpeed());
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (err) {} });
      });
    });

    host.querySelectorAll('.rp-day-add-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const kind = btn.dataset.addKind;
        const days = plan.days || (plan.days = []);
        const blankEp = () => ({ shanghe_segments: [], gpx_ref: null, start_time: null });
        if (kind === 'prepend') {
          const firstDate = days[0] && days[0].date;
          const newDate = addDaysIso(firstDate, -1);
          const newId = nextPrependId(days);
          // First-prepend (no D0 yet) gets the 出發日 template; subsequent
          // prepends get a generic blank early day so multi-prepend stays
          // disambiguable.
          const isD0 = newId === 'd0';
          const newDay = {
            id: newId,
            date: newDate,
            label: isD0 ? 'Day 0・出發' : 'Day 前置・(待命名)',
            tag_text: isD0 ? '出發日' : null,
            tag_color_override: isD0 ? 'linear-gradient(135deg,#4b5563,#6b7280)' : null,
            section_title: '',
            elevation_profile: blankEp(),
            schedule: [],
            routes: undefined,
            key_times: [],
            quick_links: [],
            details: [],
            retreat: null,
          };
          days.unshift(newDay);
        } else if (kind === 'append') {
          const lastDate = days[days.length - 1] && days[days.length - 1].date;
          const newDate = addDaysIso(lastDate, 1);
          const newId = nextDayId(days);
          const num = newId.replace(/^d/, '');
          days.push({
            id: newId,
            date: newDate,
            label: `Day ${num}・(待命名)`,
            section_title: '',
            elevation_profile: blankEp(),
            schedule: [],
            routes: undefined,
            key_times: [],
            quick_links: [],
            details: [],
            retreat: null,
          });
        }
        // Sync meta dates so the title's "幾天幾夜" counter follows
        // plan.days. start_date / end_date / depart_date all derived
        // from the (post-mutation) day list inside refreshMetaDates.
        refreshMetaDates(plan);
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        renderRestPoints(plan, readSpeed());
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (err) {} });
      });
    });

    host.querySelectorAll('.rp-section-title-edit').forEach((inp) => {
      inp.addEventListener('input', () => {
        const dayId = inp.dataset.dayId;
        const day = (plan.days || []).find(d => d.id === dayId);
        if (!day) return;
        day.section_title = inp.value;
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        // Refresh day panels so the heading inside the schedule section
        // (which renders day.section_title) reflects the edit live.
        if (TF.render) {
          requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        }
      });
    });

    // ── Bind day-start time inputs (edit mode only) ──
    host.querySelectorAll('.rp-day-start-edit').forEach((inp) => {
      inp.addEventListener('input', () => {
        const dayId = inp.dataset.dayId;
        const v = inp.value;
        const day = (plan.days || []).find(d => d.id === dayId);
        if (!day) return;
        // 1) Capture the old "first time" so we can shift the schedule by
        //    the offset between old and new start. The view-mode timeline
        //    reads from day.schedule[].time / day.routes[i].schedule[].time
        //    directly, so unless we shift those too, "改 start 但檢視時間
        //    沒變" — exactly the bug the user just reported.
        const oldStart = dayStartTimeFor(day);
        if (!day.elevation_profile) day.elevation_profile = {};
        day.elevation_profile.start_time = /^\d{1,2}:\d{2}$/.test(v) ? v : '';
        const oldMin = parseHM(oldStart);
        const newMin = parseHM(v);
        if (oldMin != null && newMin != null && oldMin !== newMin) {
          shiftDayScheduleByOffset(day, newMin - oldMin);
        }
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);

        // Refresh:
        //   • rest-points table (arrival pills)
        //   • elevation chart (arrival pills above dots)
        //   • day-panels (so checkpoint mode reflects shifted schedule)
        const cur = document.activeElement;
        renderRestPoints(plan, readSpeed());
        if (TF.modeToggle && TF.modeToggle.refreshAll) {
          requestAnimationFrame(() => TF.modeToggle.refreshAll());
        }
        if (TF.render) {
          // Re-render day panels with shifted schedule. Day-bar / hero are
          // also rebuilt but that's harmless. Defer to next frame so the
          // browser commits the time-input value before we redraw.
          requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        }

        if (cur && cur.dataset && cur.dataset.dayId) {
          // After re-render the input is a fresh node — re-focus it so the
          // user can keep typing in the time picker without click hunting.
          requestAnimationFrame(() => {
            const again = host.querySelector(`.rp-day-start-edit[data-day-id="${cur.dataset.dayId}"]`);
            if (again) again.focus();
          });
        }
      });
    });

    // ── Bind row click → focus chart ──
    bindRowFocus(host);
    // ── Bind route-variant chips → switchRoute ──
    bindVariantPickers(host);
  }

  // ─── click / Enter on a segment row → write focus state and redraw ──
  function bindRowFocus(host) {
    const list = host.querySelector('.rp-list');
    if (!list || list.__focusBound) return;
    list.__focusBound = true;

    const overview = document.getElementById('elev-overview');
    if (!overview) return;

    const apply = (row) => {
      const dayId = row.dataset.dayId;
      const lo = row.dataset.anchorLo;
      const hi = row.dataset.anchorHi;
      if (!dayId || lo == null || hi == null) return;
      const wasFocused = row.getAttribute('aria-pressed') === 'true';
      // Toggle: clicking the active row clears focus; otherwise replace.
      if (wasFocused) {
        clearFocus();
      } else {
        overview.dataset.focusDayId = dayId;
        overview.dataset.focusLo = lo;
        overview.dataset.focusHi = hi;
        overview.dataset.focused = 'true';
        triggerRedraw();
      }
    };

    list.addEventListener('click', (e) => {
      // Ignore clicks that originated on an interactive child (the
      // branch button, add-seg pill, note input, etc.). Without this
      // the row-level focus handler triggers a full re-render and
      // tears down any inline form the user just opened.
      if (e.target.closest('button, input, select, textarea, label, datalist, .rp-branch-form, .rp-add-seg-form, .rp-add-rest-form')) return;
      const row = e.target.closest('.rp-row[data-focusable="true"]');
      if (row && list.contains(row)) apply(row);
    });
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button, input, select, textarea, label')) return;
      const row = e.target.closest('.rp-row[data-focusable="true"]');
      if (row && list.contains(row)) { e.preventDefault(); apply(row); }
    });
  }

  function clearFocus() {
    const overview = document.getElementById('elev-overview');
    if (!overview) return;
    delete overview.dataset.focusDayId;
    delete overview.dataset.focusLo;
    delete overview.dataset.focusHi;
    overview.dataset.focused = 'false';
    triggerRedraw();
  }

  function triggerRedraw() {
    // Refresh both the chart (via mode-toggle's drawOverviewChart, called by
    // refreshAll) and the rest-points list (so aria-pressed updates).
    if (TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll();
    const plan = window.__PLAN__ || (TF.loadPlan && TF.loadPlan());
    if (plan) renderRestPoints(plan, readSpeed());
  }

  // Bind the legend's "全程" reset button once on first render.
  function bindResetButton() {
    const btn = document.querySelector('[data-action="overview-focus-reset"]');
    if (!btn || btn.__bound) return;
    btn.__bound = true;
    btn.addEventListener('click', clearFocus);
  }

  // ─── render the overview card (chart + rest points) ─────────────────
  function render() {
    const plan = window.__PLAN__ || (TF.loadPlan && TF.loadPlan());
    if (!plan || !Array.isArray(plan.days)) return;

    // (1) Stitched-track chart — only when on itin tab + elevation mode.
    // We delegate the actual canvas draw to TF.elevation.drawOverview via
    // mode-toggle.js' drawOverviewChart (which already collects per-day
    // info correctly). We just make sure the rest-points list renders.

    // (2) Rest-points list (always recomputed; cheap).
    renderRestPoints(plan, readSpeed());
    bindResetButton();
  }

  // ─── stitch GPX tracks across day boundaries (PR-22 part 2) ─────────
  // The Overview chart draws each day's track as a separate fill+line zone
  // (so each day keeps its own colour split + summit marker). When the
  // elevation at the end of day N differs from the start of day N+1 by
  // more than 5m, the join visually reads as a vertical cliff because the
  // two zones simply abut.
  //
  // We don't want to re-architect drawOverview to consume one stitched
  // array (that loses per-day metadata). Instead we patch each day's
  // GPX in-place: append a few synthetic samples to day N (interpolating
  // toward day N+1's start elevation) and prepend a few to day N+1
  // (interpolating from day N's end elevation). Both halves now visually
  // converge on the join point so the line is continuous.
  //
  // We tag synthetic samples with __synthetic for future tooltip code.
  const STITCH_THRESHOLD_M = 5;
  const STITCH_STEPS = 4;  // 4 each side = smooth without much extra width
  function stitchDayBoundaries(daysWithGpx) {
    for (let i = 0; i < daysWithGpx.length - 1; i++) {
      const a = daysWithGpx[i];
      const b = daysWithGpx[i + 1];
      if (!a.gpx || !b.gpx || !a.gpx.length || !b.gpx.length) continue;
      const aEnd = a.gpx[a.gpx.length - 1];
      const bStart = b.gpx[0];
      const dE = (bStart[2] || 0) - (aEnd[2] || 0);
      if (Math.abs(dE) <= STITCH_THRESHOLD_M) continue;
      // Append filler to A (climbing/descending toward B's start elev).
      const aTail = [];
      for (let k = 1; k <= STITCH_STEPS; k++) {
        const t = k / (STITCH_STEPS + 1);
        const lat = aEnd[0] + (bStart[0] - aEnd[0]) * (t * 0.5);  // half-step in lat/lon — visually sits "between" days but doesn't overrun map
        const lon = aEnd[1] + (bStart[1] - aEnd[1]) * (t * 0.5);
        const elev = aEnd[2] + dE * t;
        const p = [lat, lon, elev];
        p.__synthetic = true;
        aTail.push(p);
      }
      a.gpx = a.gpx.concat(aTail);
      // Prepend filler to B (continuing from A's last filler elev).
      const bHead = [];
      for (let k = 1; k <= STITCH_STEPS; k++) {
        const t = k / (STITCH_STEPS + 1);
        const lat = bStart[0] - (bStart[0] - aEnd[0]) * ((1 - t) * 0.5);
        const lon = bStart[1] - (bStart[1] - aEnd[1]) * ((1 - t) * 0.5);
        const elev = aEnd[2] + dE * (STITCH_STEPS / (STITCH_STEPS + 1) + t * (1 / (STITCH_STEPS + 1)));
        const p = [lat, lon, elev];
        p.__synthetic = true;
        bHead.push(p);
      }
      b.gpx = bHead.concat(b.gpx);
      // Shift summitIdx and segment anchor_idx forward by STITCH_STEPS to
      // account for the prepended head — otherwise the summit marker and
      // checkpoint dots land on the wrong sample.
      if (typeof b.summitIdx === 'number') b.summitIdx += STITCH_STEPS;
      if (Array.isArray(b.segments)) {
        b.segments = b.segments.map(s => {
          if (!Array.isArray(s.anchor_idx)) return s;
          return { ...s, anchor_idx: s.anchor_idx.map(x => x + STITCH_STEPS) };
        });
      }
      // Decision anchors live in the same gpx index space — shift them
      // too so route-fork markers land on the correct sample after the
      // prepended boundary-stitch head.
      if (Array.isArray(b.decisionAnchors)) {
        b.decisionAnchors = b.decisionAnchors.map(a => {
          if (a == null || typeof a.idx !== 'number') return a;
          return { ...a, idx: a.idx + STITCH_STEPS };
        });
      }

      // Cross-day duplicate checkpoint dedupe: if Day N's last segment ends
      // at the same name Day N+1's first segment starts at (e.g. 排雲山莊
      // appears as both arrival and departure point), drawOverview would
      // draw two ticks several samples apart. We:
      //   1. Pull Day N's last segment.to forward into the appended tail
      //      (so its tick lands close to the day boundary, not at the
      //      stitch start)
      //   2. Suppress the duplicate name on Day N+1 so it isn't redrawn
      const aLastSeg = a.segments && a.segments[a.segments.length - 1];
      const bFirstSeg = b.segments && b.segments[0];
      if (aLastSeg && bFirstSeg && aLastSeg.to && aLastSeg.to === bFirstSeg.from) {
        // Move Day N's last anchor_idx[1] to the midpoint of its appended
        // tail — visually the marker now sits at the boundary instead of
        // jutting back into Day N proper.
        if (Array.isArray(aLastSeg.anchor_idx) && aLastSeg.anchor_idx.length >= 2) {
          aLastSeg.anchor_idx = [
            aLastSeg.anchor_idx[0],
            a.gpx.length - 1 - Math.floor(STITCH_STEPS / 2),
          ];
        }
        b._suppressCheckpointNames = b._suppressCheckpointNames || new Set();
        b._suppressCheckpointNames.add(aLastSeg.to);
      }
    }
    return daysWithGpx;
  }

  // ─── Auto-return-descent synthesis ───────────────────────────────────
  // Most hikes return to the trailhead, but a one-way ascent_only day
  // (e.g. d1: 登山口 → 排雲山莊) often has no matching descent track on
  // the last hiking day. Without intervention the elevation chart's right
  // edge stops at the high camp, hiding the entire descent home.
  //
  // Default behaviour: if the trip's last segment.to ≠ first segment.from,
  // and there is an ascent_only day whose segments span exactly that
  // trailhead → endpoint route, append a synthetic "回程" day made of that
  // day's GPX + segments reversed. Opt out with plan.auto_return_descent
  // === false (e.g. for traverses ending at a different trailhead).
  //
  // Operates on the same {gpx, label, summitIdx, summitLabel, direction,
  // segments} day objects that drawOverview consumes.
  function synthesizeReturnDay(days, plan, opts) {
    if (!days || days.length < 2) return days;
    // User-level toggle (checkbox in the overview header) wins; absent
    // an explicit pref we default ON. plan.auto_return_descent === false
    // remains a hard plan-level disable for cases like one-way traverses.
    if (opts && opts.enabled === false) return days;
    if (plan && plan.auto_return_descent === false) return days;

    const first = days[0];
    const last = days[days.length - 1];
    const firstSeg = first.segments && first.segments[0];
    const lastSegs = last.segments || [];
    const lastSeg = lastSegs[lastSegs.length - 1];
    if (!firstSeg || !lastSeg) return days;
    const startName = firstSeg.from;
    const endName = lastSeg.to;
    if (!startName || !endName || startName === endName) return days;

    // Find an ascent_only day whose segment chain starts at startName
    // and ends at endName. If found, its reverse is exactly the descent
    // home we're missing.
    for (const d of days) {
      if (d.direction !== 'ascent_only') continue;
      const segs = d.segments || [];
      if (!segs.length) continue;
      if (segs[0].from !== startName) continue;
      if (segs[segs.length - 1].to !== endName) continue;
      if (!Array.isArray(d.gpx) || !d.gpx.length) continue;

      const N = d.gpx.length;
      const revGpx = d.gpx.slice().reverse();
      const revSegments = segs.slice().reverse().map(s => {
        const ai = (Array.isArray(s.anchor_idx) && s.anchor_idx.length === 2)
          ? [N - 1 - s.anchor_idx[1], N - 1 - s.anchor_idx[0]]
          : null;
        return Object.assign({}, s, {
          id: (s.id || 'seg') + '-ret',
          from: s.to,
          to: s.from,
          ascent_m: +s.descent_m || 0,
          descent_m: +s.ascent_m || 0,
          anchor_idx: ai,
          __synthetic_return: true,
        });
      });
      // Inherit the LAST real day's identity so the synthetic 回程 reads as
      // "still Day 2" — same dayId for chip + palette index, label keeps the
      // "Day N·" prefix so the band header makes sense in context. Without
      // this the chart shows a stand-alone "回程" that looks like a third day.
      const sourceDayLabel = (last && last.label) || '';
      const dayPrefix = sourceDayLabel.split('・')[0].split('·')[0] || sourceDayLabel || 'Day';
      days.push({
        gpx: revGpx,
        label: `${dayPrefix}·回程`,
        summitIdx: 0,           // makes drawOverview render the whole day as descent zone
        summitLabel: null,
        direction: 'descent_only',
        segments: revSegments,
        dayId: last && last.dayId,
        __synthetic_return: true,
        __returnFromDayIdx: days.indexOf(last),
      });
      break;
    }
    return days;
  }

  // ─── Route-aware GPX derivation ──────────────────────────────────────
  // gpxDay2 is recorded in the order the survey was walked (often
  // 排雲→風口→主峰→…→北峰), but a route variant like Day 2A actually
  // travels 排雲→風口→北峰→風口→主峰→排雲. If we draw the raw GPX
  // left-to-right by index, the chart's X-axis follows the SURVEY order
  // (主峰 first, then 北峰) — confusing because it doesn't match the
  // planned travel sequence.
  //
  // This helper takes the raw gpx + the variant's segments and stitches
  // a new sub-track that walks each segment's anchor_idx in order,
  // reversing slices where anchor_idx[0] > anchor_idx[1]. It also returns
  // segMap[i] = { startInOut, endInOut } so callers can remap segment
  // anchor_idx, summit_idx, and decision_anchors to the new index space.
  //
  // Continuity dedupe: if a segment's start matches the previous
  // segment's end (same original index), we skip pushing the duplicate
  // sample so the line stays continuous instead of stuttering.
  function deriveTrackFromSegments(gpx, segments, opts) {
    if (!Array.isArray(gpx) || !gpx.length) return null;
    if (!Array.isArray(segments) || !segments.length) return null;
    opts = opts || {};
    // visits: optional [[idx, canonName], ...] from gpx-unitize.detectVisits.
    // When provided, each segment's slice gets HYBRID synthesis: real
    // trkpts everywhere EXCEPT where the slice physically transits a
    // named location not on the segment's leg-path. Those trkpts'
    // elevations get smoothed (linear interp) so the wiggle doesn't
    // appear in the chart, while real terrain is preserved elsewhere.
    // Without visits, the function falls back to faithful trkpt slicing.
    const visits = Array.isArray(opts.visits) ? opts.visits : [];
    const canon = opts.canonName || ((n) => n);
    const skipRadius = opts.skipRadius || 12;  // ± trkpts around an unwanted visit

    const out = [];
    const segMap = [];
    let prevEnd = null;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const ai = Array.isArray(s && s.anchor_idx) ? s.anchor_idx : null;
      if (!ai || ai.length !== 2) { segMap.push(null); continue; }
      const a = ai[0], b = ai[1];
      if (a < 0 || b < 0 || a >= gpx.length || b >= gpx.length) { segMap.push(null); continue; }
      const lo = Math.min(a, b), hi = Math.max(a, b);

      // Build skip-set for this segment. A trkpt is skipped (elevation
      // smoothed) if it's within skipRadius of an unwanted visit — a
      // named-loc visit in the slice that ISN'T this segment's from
      // or to (canon-compared). Endpoints are protected (visits at
      // exactly lo or hi are always on-path).
      const fromCanon = canon(s.from || '');
      const toCanon   = canon(s.to   || '');
      const skipSet = new Set();
      if (visits.length) {
        for (const v of visits) {
          const vIdx = v[0], vName = v[1];
          if (vIdx <= lo || vIdx >= hi) continue;
          if (vName === fromCanon || vName === toCanon) continue;
          // Also protect intermediate visits that ARE part of the
          // planned chain — but we don't have that info here, so
          // we conservatively only skip visits whose anchor is in the
          // strict interior. Endpoint visits handled by lo/hi check.
          for (let k = Math.max(lo + 1, vIdx - skipRadius); k <= Math.min(hi - 1, vIdx + skipRadius); k++) {
            skipSet.add(k);
          }
        }
      }

      const dedupeFirst = (prevEnd === a && out.length > 0);
      const startInOut = out.length;
      const pushSmoothed = (k) => {
        if (!skipSet.has(k)) { out.push(gpx[k]); return; }
        // Find boundary trkpts before and after this skip run for
        // linear elevation interp. Walk back/forward until non-skip.
        let bIdx = k - 1;
        while (bIdx >= lo && skipSet.has(bIdx)) bIdx--;
        let aIdx = k + 1;
        while (aIdx <= hi && skipSet.has(aIdx)) aIdx++;
        const eB = (bIdx >= lo ? gpx[bIdx][2] : gpx[k][2]) || 0;
        const eA = (aIdx <= hi ? gpx[aIdx][2] : gpx[k][2]) || 0;
        const span = aIdx - bIdx;
        const t = (k - bIdx) / (span || 1);
        const eSmooth = eB + (eA - eB) * t;
        // Keep lat/lon (so cumulative km still tracks real distance);
        // only smooth the elevation. The chart's X-axis is cumulative
        // km, Y is elevation — smoothing Y removes the wiggle without
        // shrinking the segment.
        out.push([gpx[k][0], gpx[k][1], eSmooth]);
      };

      if (a === b) {
        if (!dedupeFirst) out.push(gpx[a]);
      } else if (a < b) {
        for (let k = (dedupeFirst ? a + 1 : a); k <= b; k++) pushSmoothed(k);
      } else {
        for (let k = (dedupeFirst ? a - 1 : a); k >= b; k--) pushSmoothed(k);
      }
      const endInOut = out.length - 1;
      segMap.push({ startInOut, endInOut, fromOrig: a, toOrig: b });
      prevEnd = b;
    }
    if (!out.length) return null;
    return { gpx: out, segMap };
  }

  // Apply deriveTrackFromSegments to a day's data and remap related
  // indices (segments, summit, decision anchors). Mutates the passed
  // day-info object in place. Returns true on success.
  function applyDerivedTrack(dayInfo, opts) {
    if (!dayInfo || !Array.isArray(dayInfo.gpx) || !Array.isArray(dayInfo.segments)) return false;
    // Pass through optional visits + canonName so the slicer can smooth
    // elevation around named-loc visits that aren't segment endpoints
    // (the "no spurious 主峰 spike inside seg 3 北峰→主北岔" case).
    const derived = deriveTrackFromSegments(dayInfo.gpx, dayInfo.segments, opts || {});
    if (!derived) return false;
    const { gpx: newGpx, segMap } = derived;

    // Remap segments to derived indices.
    const newSegments = dayInfo.segments.map((s, i) => {
      const m = segMap[i];
      if (!m) return s;
      return Object.assign({}, s, { anchor_idx: [m.startInOut, m.endInOut] });
    });

    // Remap summit: prefer the segment whose anchor_idx[1] matches the
    // original summitIdx (typical pattern); fall back to anchor_idx[0].
    let newSummit = dayInfo.summitIdx;
    if (typeof dayInfo.summitIdx === 'number') {
      let matched = false;
      for (let i = 0; i < dayInfo.segments.length; i++) {
        const s = dayInfo.segments[i];
        const ai = s && s.anchor_idx;
        const m = segMap[i];
        if (!ai || !m) continue;
        if (ai[1] === dayInfo.summitIdx) { newSummit = m.endInOut; matched = true; break; }
        if (ai[0] === dayInfo.summitIdx) { newSummit = m.startInOut; matched = true; break; }
      }
      // If summit didn't match a segment endpoint, scan segments for
      // a range containing it and interpolate within the slice.
      if (!matched) {
        for (let i = 0; i < dayInfo.segments.length; i++) {
          const s = dayInfo.segments[i];
          const ai = s && s.anchor_idx;
          const m = segMap[i];
          if (!ai || !m) continue;
          const lo = Math.min(ai[0], ai[1]);
          const hi = Math.max(ai[0], ai[1]);
          if (dayInfo.summitIdx < lo || dayInfo.summitIdx > hi) continue;
          if (ai[0] <= ai[1]) newSummit = m.startInOut + (dayInfo.summitIdx - ai[0]);
          else                newSummit = m.startInOut + (ai[0] - dayInfo.summitIdx);
          break;
        }
      }
    }

    // Remap decision anchors to first matching segment endpoint.
    let newDecisions = dayInfo.decisionAnchors;
    if (Array.isArray(dayInfo.decisionAnchors) && dayInfo.decisionAnchors.length) {
      newDecisions = dayInfo.decisionAnchors.map(a => {
        if (!a || typeof a.idx !== 'number') return a;
        for (let i = 0; i < dayInfo.segments.length; i++) {
          const s = dayInfo.segments[i];
          const ai = s && s.anchor_idx;
          const m = segMap[i];
          if (!ai || !m) continue;
          if (a.idx === ai[0]) return Object.assign({}, a, { idx: m.startInOut });
          if (a.idx === ai[1]) return Object.assign({}, a, { idx: m.endInOut });
        }
        return a;  // unmatched — leave as-is (may render off-screen)
      });
    }

    // Stash original segments + segMap so callers (e.g. focus-range
    // translation in mode-toggle.js) can map a click on a rest-points
    // row (original anchor_idx) to the right slice of the derived gpx.
    dayInfo.__originalSegments = dayInfo.segments;
    dayInfo.__segMap = segMap;
    dayInfo.gpx = newGpx;
    dayInfo.segments = newSegments;
    dayInfo.summitIdx = newSummit;
    dayInfo.decisionAnchors = newDecisions;
    return true;
  }

  // ─── Name matching (waypoint → segment from/to) ─────────────────────
  // GPX waypoints often label the same place slightly differently than
  // the plan's segment.from/to (e.g. "主北岔路(風口)" vs "主北岔(風口)",
  // or "玉山北峰" vs just "北峰"). We normalize away parens, common
  // street-suffix kana, and whitespace, then accept either exact match
  // or substring overlap so the matcher is forgiving without being
  // wildly fuzzy.
  function normalizeName(s) {
    if (!s) return '';
    let r = String(s).replace(/[（(].*?[）)]/g, '').trim();
    r = r.replace(/[路巷弄段]+$/g, '');  // trailing road-type suffix
    r = r.replace(/\s+/g, '');
    return r;
  }
  function namesMatch(a, b) {
    if (!a || !b) return false;
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 2 && nb.includes(na)) return true;
    if (nb.length >= 2 && na.includes(nb)) return true;
    return false;
  }

  // ─── Synthesize a route-faithful track from named waypoints ─────────
  // For days whose route_variants don't match the GPX recording order
  // (e.g. the recording walked 排雲→風口→主峰→…→北峰, but Day 2A plans
  // 排雲→風口→北峰→…→主峰), trkpt slicing produces an X-axis that's
  // confusingly out of order. If we have named waypoints for each
  // segment endpoint, we can stop relying on trkpt indices entirely:
  // each segment becomes a straight line from waypoint A to waypoint B
  // with linearly-interpolated elevation. Loses topographic detail in
  // exchange for matching the planned travel order exactly.
  //
  // Returns { ok: true, gpx, segMap } when every segment endpoint
  // resolves to a waypoint; otherwise { ok: false, missing: <name> }
  // so the caller can fall back to trkpt slicing + warn the user.
  function buildSyntheticFromWaypoints(waypoints, segments, opts) {
    if (!Array.isArray(waypoints) || !waypoints.length) return { ok: false };
    if (!Array.isArray(segments) || !segments.length) return { ok: false };
    opts = opts || {};
    const STEPS = Math.max(2, opts.stepsPerSegment || 20);

    const find = (name) => waypoints.find(w => namesMatch(w && w.name, name));
    const resolved = [];
    for (const s of segments) {
      const from = find(s && s.from);
      const to   = find(s && s.to);
      if (!from || !to) {
        return { ok: false, missing: from ? s.to : s.from };
      }
      resolved.push({ seg: s, from, to });
    }

    const out = [];
    const segMap = [];
    let prevSig = null;
    resolved.forEach(({ from, to }) => {
      const fromSig = `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`;
      const dedupe = (prevSig === fromSig && out.length > 0);
      const startInOut = out.length;
      const e1 = (typeof from.ele === 'number') ? from.ele : 0;
      const e2 = (typeof to.ele   === 'number') ? to.ele   : 0;
      for (let k = (dedupe ? 1 : 0); k <= STEPS; k++) {
        const t = k / STEPS;
        out.push([
          from.lat + (to.lat - from.lat) * t,
          from.lon + (to.lon - from.lon) * t,
          e1 + (e2 - e1) * t,
        ]);
      }
      const endInOut = out.length - 1;
      segMap.push({ startInOut, endInOut, fromOrig: null, toOrig: null });
      prevSig = `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;
    });

    return { ok: true, gpx: out, segMap };
  }

  // Apply buildSyntheticFromWaypoints to a dayInfo and remap summit /
  // decision_anchors to the new index space (same contract as
  // applyDerivedTrack — mutates dayInfo in place, returns true on success).
  function applySyntheticFromWaypoints(dayInfo, waypoints, opts) {
    if (!dayInfo || !Array.isArray(dayInfo.segments)) return false;
    const result = buildSyntheticFromWaypoints(waypoints, dayInfo.segments, opts);
    if (!result || !result.ok) return false;
    const { gpx: newGpx, segMap } = result;

    const origSegments = dayInfo.segments;
    const newSegments = origSegments.map((s, i) => {
      const m = segMap[i];
      return Object.assign({}, s, { anchor_idx: [m.startInOut, m.endInOut] });
    });

    // Remap summit by matching segment endpoints (same trick as
    // applyDerivedTrack but starting from anchor_idx in original space).
    let newSummit = dayInfo.summitIdx;
    if (typeof dayInfo.summitIdx === 'number') {
      for (let i = 0; i < origSegments.length; i++) {
        const ai = origSegments[i] && origSegments[i].anchor_idx;
        if (!ai) continue;
        if (ai[1] === dayInfo.summitIdx) { newSummit = segMap[i].endInOut; break; }
        if (ai[0] === dayInfo.summitIdx) { newSummit = segMap[i].startInOut; break; }
      }
    }

    let newDecisions = dayInfo.decisionAnchors;
    if (Array.isArray(dayInfo.decisionAnchors) && dayInfo.decisionAnchors.length) {
      newDecisions = dayInfo.decisionAnchors.map(a => {
        if (!a || typeof a.idx !== 'number') return a;
        for (let i = 0; i < origSegments.length; i++) {
          const ai = origSegments[i] && origSegments[i].anchor_idx;
          if (!ai) continue;
          if (a.idx === ai[0]) return Object.assign({}, a, { idx: segMap[i].startInOut });
          if (a.idx === ai[1]) return Object.assign({}, a, { idx: segMap[i].endInOut });
        }
        return a;
      });
    }

    dayInfo.__originalSegments = origSegments;
    dayInfo.__segMap = segMap;
    dayInfo.__synthetic_source = 'waypoints';
    dayInfo.gpx = newGpx;
    dayInfo.segments = newSegments;
    dayInfo.summitIdx = newSummit;
    dayInfo.decisionAnchors = newDecisions;
    return true;
  }

  TF.overview = {
    render, stitchDayBoundaries, synthesizeReturnDay,
    deriveTrackFromSegments, applyDerivedTrack,
    buildSyntheticFromWaypoints, applySyntheticFromWaypoints,
    namesMatch, normalizeName,
    findAutoReturnSource, buildReverseSegments, cloneDescentFromAscent, effectiveSegmentsForVariant,
    getEffectiveDayContext,
    findWaypointTrackIdx, gpxStatsBetween, gpxStatsBetweenNames,
    computeBaseMinutes,
  };

  // Register a collector so per-day start_time edits made in the rest-points
  // editor flow back into the saved plan when the user clicks 儲存. We mirror
  // from window.__PLAN__ (where our input handler wrote) into the cloned save
  // payload's matching day.elevation_profile.start_time.
  function registerStartTimeCollector() {
    if (!window.TF_EDIT || !window.TF_EDIT.registerCollector) return;
    if (window.__TF_OVERVIEW_COLLECTOR_REGISTERED__) return;
    window.__TF_OVERVIEW_COLLECTOR_REGISTERED__ = true;
    window.TF_EDIT.registerCollector((data) => {
      const live = window.__PLAN__;
      if (!live || !Array.isArray(live.days) || !Array.isArray(data.days)) return;
      data.days.forEach((d) => {
        const m = live.days.find((x) => x.id === d.id);
        if (!m) return;
        // Mirror entire elevation_profile (includes start_time + shanghe_segments
        // + route_variants — any of which may have been edited via the
        // rest-points table notes / start time picker).
        if (m.elevation_profile) {
          d.elevation_profile = JSON.parse(JSON.stringify(m.elevation_profile));
        }
        // Mirror shifted schedule / routes / key_times — these ride along
        // with start_time edits via shiftDayScheduleByOffset, so without
        // mirroring them the saved plan would still hold the old times.
        if (Array.isArray(m.schedule))   d.schedule   = JSON.parse(JSON.stringify(m.schedule));
        if (Array.isArray(m.routes))     d.routes     = JSON.parse(JSON.stringify(m.routes));
        if (Array.isArray(m.key_times))  d.key_times  = JSON.parse(JSON.stringify(m.key_times));
      });
      // Mutating data in place; nothing to merge.
    });
  }
  // Register both immediately (in case TF_EDIT is already up via the early
  // body stub) and once on the first edit-mode entry (in case edit.js
  // overwrote TF_EDIT later with the auth-aware version).
  registerStartTimeCollector();
  document.addEventListener('tf:edit-enter', registerStartTimeCollector);

  // Auto-render once at DOM ready — render.js will re-call after fetch.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    requestAnimationFrame(render);
  }
})();
