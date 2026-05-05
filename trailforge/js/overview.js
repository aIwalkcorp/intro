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
  function collectRestPoints(plan) {
    const rows = [];
    let cumKm = 0;
    (plan.days || []).forEach(day => {
      const variant = activeVariantFor(day);
      const segs = variant ? variant.segments : [];
      const dayId = day.id;
      const dayLabel = day.label || ('Day ' + day.id);
      if (!segs.length) {
        rows.push({
          kind: 'day-header',
          dayId, dayLabel,
          note: '無步行段（' + (day.section_title || '出發/移動日') + '）',
        });
        return;
      }
      // Day's segment subtotal accumulators
      let dayKm = 0, dayAsc = 0, dayDesc = 0, dayMin = 0;
      segs.forEach(s => {
        const dist = +s.distance_km || 0;
        const startKm = cumKm;
        const endKm = cumKm + dist;
        const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
        const anchorLo = ai.length >= 2 ? ai[0] : null;
        const anchorHi = ai.length >= 2 ? ai[1] : null;
        rows.push({
          kind: 'segment',
          dayId, dayLabel,
          from: s.from || '',
          to: s.to || '',
          distance_km: dist,
          ascent_m: +s.ascent_m || 0,
          descent_m: +s.descent_m || 0,
          base_minutes: +s.base_minutes || 0,
          startKm, endKm,
          anchorLo, anchorHi,
        });
        cumKm = endKm;
        dayKm   += dist;
        dayAsc  += (+s.ascent_m || 0);
        dayDesc += (+s.descent_m || 0);
        dayMin  += (+s.base_minutes || 0);
      });
      // Subtotal row for this day
      rows.push({
        kind: 'subtotal',
        dayId, dayLabel,
        distance_km: dayKm,
        ascent_m: dayAsc,
        descent_m: dayDesc,
        base_minutes: dayMin,
      });
    });
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
    const root = host.querySelector('.rp-route-variants');
    if (!root || root.__bound) return;
    root.__bound = true;
    root.addEventListener('click', (e) => {
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
        return `<div class="rp-row rp-day-header">
          ${dayChip}
          <span class="rp-day-name">${escapeHtml(r.dayLabel)}</span>
          <span class="rp-day-note">${escapeHtml(r.note || '')}</span>
        </div>`;
      }

      if (r.kind === 'subtotal') {
        const dayDerived = Math.round(r.base_minutes * factor);
        const elevBits = [];
        if (r.distance_km) elevBits.push(`<span class="rp-km">${r.distance_km.toFixed(1)}<small>km</small></span>`);
        if (r.ascent_m)    elevBits.push(`<span class="rp-asc">↑${r.ascent_m}<small>m</small></span>`);
        if (r.descent_m)   elevBits.push(`<span class="rp-desc">↓${r.descent_m}<small>m</small></span>`);
        return `<div class="rp-row rp-subtotal">
          <span class="rp-subtotal-l">
            ${dayChip}
            <span class="rp-subtotal-day">${escapeHtml(r.dayLabel)} 小結</span>
          </span>
          <span class="rp-subtotal-meta">${elevBits.join('')}</span>
          <span class="rp-subtotal-time">
            <span class="rp-time-derived">${dayDerived}<small>分</small></span>
            <span class="rp-time-base">基準 ${r.base_minutes}分</span>
          </span>
        </div>`;
      }

      // segment
      const elevBits = [];
      if (r.ascent_m)  elevBits.push(`<span class="rp-asc">↑${r.ascent_m}<small>m</small></span>`);
      if (r.descent_m) elevBits.push(`<span class="rp-desc">↓${r.descent_m}<small>m</small></span>`);
      if (!elevBits.length) elevBits.push(`<span class="rp-flat">─</span>`);
      const derived = Math.round(r.base_minutes * factor);
      const focusable = (r.anchorLo != null && r.anchorHi != null);
      const isFocused = focusable
        && r.dayId === focusDayId
        && String(r.anchorLo) === focusLo
        && String(r.anchorHi) === focusHi;
      const attrs = focusable
        ? ` data-focusable="true" data-day-id="${escapeHtml(r.dayId)}" data-anchor-lo="${r.anchorLo}" data-anchor-hi="${r.anchorHi}" role="button" tabindex="0" aria-pressed="${isFocused ? 'true' : 'false'}"`
        : '';
      return `<div class="rp-row"${attrs}>
        ${dayChip}
        <span class="rp-cum">${r.startKm.toFixed(1)}<small>km</small></span>
        <span class="rp-route">
          <span class="rp-from">${escapeHtml(r.from)}</span>
          <span class="rp-arrow">→</span>
          <span class="rp-to">${escapeHtml(r.to)}</span>
        </span>
        <span class="rp-meta">
          <span class="rp-km">${r.distance_km.toFixed(1)}<small>km</small></span>
          ${elevBits.join('')}
        </span>
        <span class="rp-time">
          <span class="rp-time-derived">${derived}</span><small>分</small>
          <span class="rp-time-base">基準 ${r.base_minutes}分</span>
        </span>
      </div>`;
    }).join('');

    // Route-variant pickers — for any day declaring route_variants we
    // surface a chip strip so the user can flip between them right from
    // the rest-points table. Clicking a chip calls window.switchRoute,
    // which triggers a full overview refresh.
    const variantPickerHtml = buildVariantPickerHtml(plan);

    host.innerHTML = `
      <div class="rp-head">
        <div class="rp-title">休息點<span class="rp-title-en">REST POINTS</span></div>
        <div class="rp-source">資料來源：上河圖步程 + 他人健行筆記紀錄綜合</div>
      </div>
      ${variantPickerHtml}
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
      const onChange = () => {
        let f = parseFloat(input.value);
        if (!Number.isFinite(f) || f < 0.5) f = 0.5;
        if (f > 2.5) f = 2.5;
        input.value = f.toFixed(2);
        writeSpeed(f);
        renderRestPoints(plan, f);
      };
      input.addEventListener('change', onChange);
      // Live update on every keystroke — table is small enough that a full
      // re-render per input event is fine and keeps the focus selection
      // sticky (we read overview.dataset before re-rendering).
      input.addEventListener('input', () => {
        const f = parseFloat(input.value);
        if (Number.isFinite(f) && f >= 0.5 && f <= 2.5) {
          writeSpeed(f);
          renderRestPoints(plan, f);
        }
      });
    }

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
      days.push({
        gpx: revGpx,
        label: '回程',
        summitIdx: 0,           // makes drawOverview render the whole day as descent zone
        summitLabel: null,
        direction: 'descent_only',
        segments: revSegments,
        __synthetic_return: true,
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

  // Auto-render once at DOM ready — render.js will re-call after fetch.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    requestAnimationFrame(render);
  }
})();
