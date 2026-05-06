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
  // Pull a "start of hike" clock time for a day. Priority:
  //   1. day.elevation_profile.start_time  (explicit, set via the editor)
  //   2. day.schedule[0].time              (legacy: first scheduled item)
  //   3. null                              (no start = no arrival column)
  function dayStartTimeFor(day) {
    const ep = day && day.elevation_profile;
    if (ep && /^\d{1,2}:\d{2}$/.test(String(ep.start_time || ''))) return ep.start_time;
    const pickFirstTime = (sched) => {
      for (const item of (sched || [])) {
        if (item && /^\d{1,2}:\d{2}$/.test(String(item.time || ''))) return item.time;
      }
      return null;
    };
    // 1) day-level schedule (most plans).
    const a = pickFirstTime(day && day.schedule);
    if (a) return a;
    // 2) route-variant schedule — 玉山 Day 2 keeps its 02:00 起床 inside
    //    routes[active].schedule, NOT at the day level.
    const routes = (day && day.routes) || [];
    const active = routes.find(r => r && r.active) || routes[0];
    return pickFirstTime(active && active.schedule);
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
    (plan.days || []).forEach(day => {
      const variant = activeVariantFor(day);
      const segs = variant ? variant.segments : [];
      const dayId = day.id;
      const dayLabel = day.label || ('Day ' + day.id);
      const dayStart = dayStartTimeFor(day);
      const dayStartMin = parseHM(dayStart);
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
      // Detect which path holds this day's segments — needed by note editing
      // so we can mutate the right segment object on input.
      const ep = day.elevation_profile;
      const useRoute = !!(ep && ep.route_variants);
      let activeRouteId = null;
      if (useRoute) {
        const dayPanel = document.getElementById('day-' + day.id);
        const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
        if (activeTab) {
          const m = (activeTab.getAttribute('onclick') || '').match(/switchRoute\(['"]([^'"]+)['"]\)/);
          activeRouteId = m && m[1];
        }
        if (!activeRouteId) activeRouteId = ep.default_variant || Object.keys(ep.route_variants)[0] || null;
      }

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

      // Day's segment subtotal accumulators (also drives arrival times)
      let dayKm = 0, dayAsc = 0, dayDesc = 0, dayMin = 0, cumDayBaseMin = 0;
      segs.forEach((s, segIdx) => {
        const dist = +s.distance_km || 0;
        const baseMin = +s.base_minutes || 0;
        const startKm = cumKm;
        const endKm = cumKm + dist;
        const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
        const anchorLo = ai.length >= 2 ? ai[0] : null;
        const anchorHi = ai.length >= 2 ? ai[1] : null;
        // Arrival is at the END of this segment: start + cumulative-up-to-end.
        const cumAfter = cumDayBaseMin + baseMin;
        rows.push({
          kind: 'segment',
          dayId, dayLabel,
          from: s.from || '',
          to: s.to || '',
          note: s.note || '',
          // Path back to this segment's home so the note input can mutate it:
          //   useRoute=true  → plan.days[id].elevation_profile.route_variants[activeRouteId].shanghe_segments[segIdx]
          //   useRoute=false → plan.days[id].elevation_profile.shanghe_segments[segIdx]
          segIdx,
          variantId: useRoute ? activeRouteId : null,
          distance_km: dist,
          ascent_m: +s.ascent_m || 0,
          descent_m: +s.descent_m || 0,
          base_minutes: baseMin,
          cumDayBaseMinAfter: cumAfter,    // base minutes from day start through end of THIS segment
          dayStartMin,                     // null if no start time
          startKm, endKm,
          anchorLo, anchorHi,
        });
        cumKm = endKm;
        cumDayBaseMin = cumAfter;
        dayKm   += dist;
        dayAsc  += (+s.ascent_m || 0);
        dayDesc += (+s.descent_m || 0);
        dayMin  += baseMin;

        // Inject variant picker right after the last shared segment. So
        // for 玉山 Day 2 the chip strip sits between "排雲山莊→主北岔(風口)"
        // and "主北岔→玉山北峰" — exactly where the fork happens IRL.
        if (useRoute && sharedPrefix > 0 && segIdx === sharedPrefix - 1) {
          rows.push({
            kind: 'variant-fork',
            dayId, dayLabel,
            forkAt: s.to || '',
          });
        }
      });
      // Subtotal row for this day
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

    // ── Synthetic 回程 rows ───────────────────────────────────────────────
    // Mirrors synthesizeReturnDay's matching logic: when the trip starts and
    // ends at different named points but contains an ascent_only day going
    // start→end, we auto-emit the reversed segments as a "Day N·回程" tail
    // so the rest-points table matches what the chart already shows.
    const realDays = plan.days || [];
    const autoReturn = plan.auto_return_descent !== false;
    if (autoReturn && realDays.length >= 2) {
      const first = realDays[0];
      const last = realDays[realDays.length - 1];
      const fv = activeVariantFor(first);
      const lv = activeVariantFor(last);
      const firstSegs = (fv && fv.segments) || [];
      const lastSegs = (lv && lv.segments) || [];
      const startName = firstSegs[0] && firstSegs[0].from;
      const endName = lastSegs.length && lastSegs[lastSegs.length - 1].to;
      if (startName && endName && startName !== endName) {
        for (const d of realDays) {
          const v = activeVariantFor(d);
          if (!v || v.direction !== 'ascent_only') continue;
          const segs = v.segments || [];
          if (!segs.length) continue;
          if (segs[0].from !== startName) continue;
          if (segs[segs.length - 1].to !== endName) continue;
          // Found an ascent_only day going start→end; reverse its segments
          // and tag them as belonging to the LAST day's 回程.
          const dayId = last.id;
          const sourceLabel = last.label || ('Day ' + last.id);
          const dayPrefix = sourceLabel.split('・')[0].split('·')[0] || sourceLabel;
          const dayLabel = `${dayPrefix}·回程`;
          rows.push({
            kind: 'day-header',
            dayId, dayLabel,
            dayStart: null,
            note: `自動補齊：${endName} → ${startName}`,
            isReturn: true,
          });
          let dayKm = 0, dayAsc = 0, dayDesc = 0, dayMin = 0, cumDayBaseMin = 0;
          const revSegs = segs.slice().reverse();
          revSegs.forEach((s) => {
            const dist = +s.distance_km || 0;
            const baseMin = +s.base_minutes || 0;
            const startKm = cumKm;
            const endKm = cumKm + dist;
            const ascR = +s.descent_m || 0;   // descent of original = ascent of return
            const descR = +s.ascent_m || 0;
            const cumAfter = cumDayBaseMin + baseMin;
            rows.push({
              kind: 'segment',
              dayId, dayLabel,
              from: s.to || '',
              to: s.from || '',
              distance_km: dist,
              ascent_m: ascR,
              descent_m: descR,
              base_minutes: baseMin,
              cumDayBaseMinAfter: cumAfter,
              dayStartMin: null,           // no start clock for synthetic return
              startKm, endKm,
              anchorLo: null, anchorHi: null,   // no chart focus on synth rows
              isReturn: true,
            });
            cumKm = endKm;
            cumDayBaseMin = cumAfter;
            dayKm   += dist;
            dayAsc  += ascR;
            dayDesc += descR;
            dayMin  += baseMin;
          });
          rows.push({
            kind: 'subtotal',
            dayId, dayLabel,
            distance_km: dayKm,
            ascent_m: dayAsc,
            descent_m: dayDesc,
            base_minutes: dayMin,
            dayStartMin: null,
            cumDayBaseMinAfter: cumDayBaseMin,
            isReturn: true,
          });
          break;
        }
      }
    }

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

        return `<div class="rp-row rp-day-header${r.isReturn ? ' rp-day-header-return' : ''}">
          ${dayChip}
          <span class="rp-day-name">${escapeHtml(r.dayLabel)}</span>
          <span class="rp-day-note">${escapeHtml(r.note || '')}</span>
          ${startCell}
        </div>${titleCell ? `<div class="rp-section-title-row">${titleCell}</div>` : ''}`;
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
          </span>
          <span class="rp-cost">
            <span class="rp-time-derived">${dayDerived}</span><small>分</small>
            <span class="rp-time-base">基準 ${r.base_minutes}分</span>
          </span>
          <span class="rp-subtotal-meta">${elevBits.join('')}</span>
          <span class="rp-arrive">${arrival
            ? `<small>抵達</small><b>${arrival}</b>`
            : '<small class="rp-arrive-empty">—</small>'}</span>
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
      // Per-segment 備註 row — sits directly below the segment row. Edit
      // mode shows a clean dotted-underline input + branch button; view
      // mode shows muted italic prose only when there's content. Synthetic
      // 回程 rows skip the note (no source segment to mutate).
      const editing = document.body.classList.contains('tf-editing');
      const canEditNote = !r.isReturn && r.segIdx != null;
      let noteHtml = '';
      if (canEditNote && editing) {
        // Git-branch SVG: a vertical stem with a fork branching off to the
        // right — universally recognised as "branch from here". Click opens
        // an inline split form below.
        const branchBtn = `<button type="button" class="rp-branch-btn"
            data-day-id="${escapeHtml(r.dayId)}"
            data-seg-idx="${r.segIdx}"
            data-variant-id="${escapeHtml(r.variantId || '')}"
            aria-label="在此段插入分歧點 / 休息點"
            title="在此段插入新的休息點">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="4" cy="3" r="1.6" fill="currentColor"/>
            <circle cx="4" cy="13" r="1.6" fill="currentColor"/>
            <circle cx="12" cy="8" r="1.6" fill="currentColor"/>
            <path d="M4 4.5v7" stroke="currentColor" stroke-width="1.4" fill="none"/>
            <path d="M4 7.5 q 0 -2 4 -2 t 4 1" stroke="currentColor" stroke-width="1.4" fill="none"/>
          </svg>
          <span>分歧</span>
        </button>`;
        noteHtml = `<div class="rp-note-row" data-day-id="${escapeHtml(r.dayId)}" data-seg-idx="${r.segIdx}" data-variant-id="${escapeHtml(r.variantId || '')}">
          <span class="rp-note-mark" aria-hidden="true">↳</span>
          <input class="rp-note-input" type="text" value="${escapeHtml(r.note || '')}" placeholder="備註（可選）" aria-label="此段備註">
          ${branchBtn}
        </div>`;
      } else if (r.note) {
        noteHtml = `<div class="rp-note-row rp-note-readonly">
          <span class="rp-note-mark" aria-hidden="true">↳</span>
          <span class="rp-note-text">${escapeHtml(r.note)}</span>
        </div>`;
      }

      return `<div class="rp-row"${attrs}>
        ${dayChip}
        <span class="rp-cum">${r.startKm.toFixed(1)}<small>km</small></span>
        <span class="rp-route">
          <span class="rp-from">${escapeHtml(r.from)}</span>
          <span class="rp-arrow">→</span>
          <span class="rp-to">${escapeHtml(r.to)}</span>
        </span>
        <span class="rp-cost">
          <span class="rp-time-derived">${derived}</span><small>分</small>
          <span class="rp-time-base">基準 ${r.base_minutes}分</span>
        </span>
        <span class="rp-meta">
          <span class="rp-km">${r.distance_km.toFixed(1)}<small>km</small></span>
          ${elevBits.join('')}
        </span>
        <span class="rp-arrive">${arrival
          ? `<small>抵達</small><b>${arrival}</b>`
          : '<small class="rp-arrive-empty">—</small>'}</span>
      </div>${noteHtml}`;
    }).join('');

    // Route-variant pickers — moved INLINE into the segment list right at
    // the fork point (kind:'variant-fork' rows in collectRestPoints). The
    // separate top-of-table chip strip is gone; the chips now sit between
    // "排雲山莊→主北岔(風口)" and "主北岔→玉山北峰" — exactly where the
    // user makes the decision in real life.

    host.innerHTML = `
      <div class="rp-head">
        <div class="rp-title">休息點<span class="rp-title-en">REST POINTS</span></div>
        <div class="rp-source">資料來源：上河圖步程 + 他人健行筆記紀錄綜合</div>
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
      // Live update on every keystroke — table is small enough that a full
      // re-render per input event is fine and keeps the focus selection
      // sticky (we read overview.dataset before re-rendering). Also
      // re-draws the overview chart so arrival pills above the dots track
      // the new factor.
      input.addEventListener('input', () => {
        const f = parseFloat(input.value);
        if (Number.isFinite(f) && f >= 0.5 && f <= 2.5) {
          writeSpeed(f);
          renderRestPoints(plan, f);
          refreshChart();
        }
      });
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
    host.querySelectorAll('.rp-note-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const wrap = inp.closest('.rp-note-row');
        if (!wrap) return;
        const segArr = resolveSegArr(wrap.dataset.dayId, wrap.dataset.variantId || null);
        const segIdx = +wrap.dataset.segIdx;
        if (!Array.isArray(segArr) || !segArr[segIdx]) return;
        segArr[segIdx].note = inp.value;
        if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
        // Don't re-render — would lose typing focus. The note is already in
        // memory; renderRestPoints reads .note on next refresh.
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
        const wrap = btn.closest('.rp-note-row');
        if (!wrap) return;
        const dayId = wrap.dataset.dayId;
        const variantId = wrap.dataset.variantId || null;
        const segIdx = +wrap.dataset.segIdx;
        const segArr = resolveSegArr(dayId, variantId);
        if (!Array.isArray(segArr) || !segArr[segIdx]) return;
        const seg = segArr[segIdx];
        // Toggle inline form
        let form = wrap.nextElementSibling;
        if (form && form.classList.contains('rp-branch-form')) {
          form.remove();
          return;
        }
        const halfMin = Math.max(1, Math.round((+seg.base_minutes || 0) / 2));
        // Collect waypoint suggestions from across the plan + GPX wpts so
        // the user can pick a known stop instead of typing free-hand.
        const waypointSuggestions = collectKnownWaypointNames(plan);
        const datalistId = 'rp-wp-suggestions-' + Math.random().toString(36).slice(2, 8);
        // Fade rows BELOW the current row to communicate "this branch
        // replaces the rest of the path". closeForm() restores them.
        const segListHost = wrap.parentNode;
        segListHost.classList.add('rp-branching');
        let cur = wrap.nextSibling;
        while (cur) {
          if (cur.nodeType === 1) cur.classList.add('rp-faded-out');
          cur = cur.nextSibling;
        }
        form = document.createElement('div');
        form.className = 'rp-branch-form';
        form.innerHTML = `
          <div class="rp-branch-head">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="4" cy="3" r="1.6" fill="currentColor"/><circle cx="4" cy="13" r="1.6" fill="currentColor"/><circle cx="12" cy="8" r="1.6" fill="currentColor"/>
              <path d="M4 4.5v7" stroke="currentColor" stroke-width="1.4" fill="none"/>
              <path d="M4 7.5 q 0 -2 4 -2 t 4 1" stroke="currentColor" stroke-width="1.4" fill="none"/>
            </svg>
            從 <b>${escapeHtml(seg.from)}</b> 創建一個新的路線
          </div>
          <div class="rp-branch-fields">
            <label><span>下一個休息點</span>
              <input type="text" class="rp-branch-name" list="${datalistId}" placeholder="輸入或從建議清單選擇" autocomplete="off">
              <datalist id="${datalistId}">
                ${waypointSuggestions.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}
              </datalist>
            </label>
            <label><span>從 ${escapeHtml(seg.from)} 走</span><input type="number" class="rp-branch-min" min="1" max="${(+seg.base_minutes || 1) - 1}" value="${halfMin}"><span class="rp-branch-unit">分</span></label>
          </div>
          <div class="rp-branch-actions">
            <button type="button" class="rp-branch-cancel">取消</button>
            <button type="button" class="rp-branch-confirm">＋ 建立新路線</button>
          </div>
          <p class="rp-branch-hint">確認後會從此點起為起點，後續路線將由你新建的休息點組成。</p>
        `;
        wrap.parentNode.insertBefore(form, wrap.nextSibling);
        form.querySelector('.rp-branch-name').focus();

        // Helper: cleanly close the form + restore faded-out rows below.
        const closeForm = () => {
          form.remove();
          segListHost.classList.remove('rp-branching');
          segListHost.querySelectorAll('.rp-faded-out').forEach(el => el.classList.remove('rp-faded-out'));
        };

        form.querySelector('.rp-branch-cancel').addEventListener('click', closeForm);
        form.querySelector('.rp-branch-confirm').addEventListener('click', () => {
          const newName = form.querySelector('.rp-branch-name').value.trim();
          const splitMin = +form.querySelector('.rp-branch-min').value;
          if (!newName) {
            form.querySelector('.rp-branch-name').focus();
            return;
          }
          const total = +seg.base_minutes || 0;
          const m1 = Math.max(1, Math.min(total - 1, splitMin || halfMin));
          const m2 = Math.max(1, total - m1);
          // Proportionally split km / ascent / descent.
          const f = m1 / total;
          const dKm = +seg.distance_km || 0;
          const dAsc = +seg.ascent_m || 0;
          const dDesc = +seg.descent_m || 0;
          const before = {
            ...seg,
            id: (seg.id || 'seg') + '-a',
            to: newName,
            base_minutes: m1,
            distance_km: +(dKm * f).toFixed(2),
            ascent_m: Math.round(dAsc * f),
            descent_m: Math.round(dDesc * f),
            anchor_idx: null,   // user can re-pin via GPX picker later
            note: seg.note || '',
          };
          const after = {
            ...seg,
            id: (seg.id || 'seg') + '-b',
            from: newName,
            base_minutes: m2,
            distance_km: +(dKm * (1 - f)).toFixed(2),
            ascent_m: dAsc - before.ascent_m,
            descent_m: dDesc - before.descent_m,
            anchor_idx: null,
            note: '',
          };
          segArr.splice(segIdx, 1, before, after);
          if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
          // The full re-render below replaces the entire rest-points list,
          // so the faded-out rows + form get blown away naturally — no
          // explicit closeForm() needed here.
          renderRestPoints(plan, readSpeed());
          if (TF.modeToggle && TF.modeToggle.refreshAll) {
            requestAnimationFrame(() => TF.modeToggle.refreshAll());
          }
          if (TF.render) requestAnimationFrame(() => { try { TF.render(plan); } catch (e) {} });
        });
      });
    });

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
      const row = e.target.closest('.rp-row[data-focusable="true"]');
      if (row && list.contains(row)) apply(row);
    });
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
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
  function deriveTrackFromSegments(gpx, segments) {
    if (!Array.isArray(gpx) || !gpx.length) return null;
    if (!Array.isArray(segments) || !segments.length) return null;
    const out = [];
    const segMap = [];
    let prevEnd = null;  // last anchor_idx[1] of the previous segment, or null
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const ai = Array.isArray(s && s.anchor_idx) ? s.anchor_idx : null;
      if (!ai || ai.length !== 2) { segMap.push(null); continue; }
      const a = ai[0], b = ai[1];
      if (a < 0 || b < 0 || a >= gpx.length || b >= gpx.length) { segMap.push(null); continue; }
      const dedupeFirst = (prevEnd === a && out.length > 0);
      const startInOut = out.length;
      if (a === b) {
        if (!dedupeFirst) out.push(gpx[a]);
      } else if (a < b) {
        for (let k = (dedupeFirst ? a + 1 : a); k <= b; k++) out.push(gpx[k]);
      } else {
        for (let k = (dedupeFirst ? a - 1 : a); k >= b; k--) out.push(gpx[k]);
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
  function applyDerivedTrack(dayInfo) {
    if (!dayInfo || !Array.isArray(dayInfo.gpx) || !Array.isArray(dayInfo.segments)) return false;
    const derived = deriveTrackFromSegments(dayInfo.gpx, dayInfo.segments);
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
