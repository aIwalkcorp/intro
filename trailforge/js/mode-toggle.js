/* Trailforge — Global itinerary mode toggle (打卡 ⇄ 海拔)
 *
 * One floating segmented control switches every day-panel's panes
 * simultaneously by toggling body[data-jm-mode]. CSS handles visibility.
 *
 * Public API:
 *   TF.modeToggle.set(mode)          — programmatic switch ('checkpoint' | 'elevation')
 *   TF.modeToggle.get()              — current mode
 *   TF.modeToggle.refreshAll()       — redraw all elevation canvases
 *   TF.modeToggle.init(rootEl?)      — re-bind newly-rendered .mode-shell sections
 *
 * Depends on: window.TF.elevation, window.__JM_GPX__
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});
  const STORAGE_KEY = 'jm_mode_global';
  const DEFAULT_MODE = 'checkpoint';

  function recall() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'elevation' ? 'elevation' : 'checkpoint';
    } catch (e) { return DEFAULT_MODE; }
  }
  function remember(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) {}
  }

  function get() {
    return document.body.dataset.jmMode || DEFAULT_MODE;
  }

  function set(mode) {
    if (mode !== 'checkpoint' && mode !== 'elevation') mode = DEFAULT_MODE;
    document.body.dataset.jmMode = mode;
    document.querySelectorAll('.jm-mode-toggle button').forEach(btn => {
      btn.setAttribute('aria-selected', btn.dataset.targetMode === mode ? 'true' : 'false');
    });
    remember(mode);
    if (mode === 'elevation') {
      // Defer to next frame so display:block applies before measuring.
      requestAnimationFrame(refreshAll);
    }
  }

  // Show a transient toast inside an .elev-card with a message.
  function showElevToast(card, msg) {
    if (!card) return;
    let toast = card.querySelector('.elev-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'elev-toast';
      const wrap = card.querySelector('.elev-canvas-wrap') || card;
      wrap.appendChild(toast);
    }
    toast.textContent = msg;
    requestAnimationFrame(() => {
      toast.classList.add('show');
      clearTimeout(toast.__t);
      toast.__t = setTimeout(() => toast.classList.remove('show'), 2400);
    });
  }

  // Refresh the elev-route-info badge in elev-head with current active route.
  function updateRouteInfo(activeDayPanel) {
    if (!activeDayPanel) return;
    const card = activeDayPanel.querySelector('.elev-card');
    if (!card) return;
    const info = card.querySelector('[data-route-info]');
    if (!info) return;
    const activeTab = activeDayPanel.querySelector('.r-tab.active');
    if (activeTab) {
      info.textContent = activeTab.textContent.trim();
      info.classList.remove('flash');
      // force reflow so animation restarts
      void info.offsetWidth;
      info.classList.add('flash');
    }
  }

  // Switch the currently active sub-route (used by decision-point overlays).
  // Cycles through the available .r-tab buttons in the active day-panel.
  function cycleRoute() {
    const active = document.querySelector('.day-panel.active');
    if (!active) {
      console.warn('[trailforge] cycleRoute: no active day-panel');
      return;
    }
    const tabs = Array.from(active.querySelectorAll('.r-tab'));
    if (tabs.length < 2) {
      console.warn('[trailforge] cycleRoute: <2 .r-tab found in active panel');
      return;
    }
    const current = tabs.findIndex(t => t.classList.contains('active'));
    const nextIdx = (current + 1) % tabs.length;
    const nextTab = tabs[nextIdx];
    const onclick = nextTab.getAttribute('onclick') || '';
    const m = onclick.match(/switchRoute\(['"]([^'"]+)['"]\)/);
    if (m && typeof window.switchRoute === 'function') {
      window.switchRoute(m[1]);
    } else if (typeof window.switchRoute === 'function') {
      // Fallback: derive id from data-route or text
      const fallbackId = nextTab.dataset.route || (nextTab.textContent.includes('僅') ? 'd2b' : 'd2a');
      window.switchRoute(fallbackId);
    } else {
      console.warn('[trailforge] cycleRoute: switchRoute() not on window');
      return;
    }
    // Visual feedback (user is likely viewing elevation mode and wouldn't
    // otherwise see the schedule timeline change).
    requestAnimationFrame(() => {
      const card = active.querySelector('.elev-card');
      const newActive = active.querySelector('.r-tab.active');
      const label = newActive ? newActive.textContent.trim() : '路線已切換';
      // Get the route id from onclick (e.g. d2a / d2b)
      const onclickAttr = (newActive && newActive.getAttribute('onclick')) || '';
      const m2 = onclickAttr.match(/switchRoute\(['"]([^'"]+)['"]\)/);
      const routeId = m2 ? m2[1] : null;
      applyRouteVariant(card, routeId);
      showElevToast(card, '已切換 → ' + label);
      updateRouteInfo(active);
    });
  }

  // ─── Route-variant switching for the elevation card ─────────────────────
  // When the active sub-route changes (e.g. Day 2A ↔ 2B), rebuild the
  // 休息點 list, total, anchors on the canvas, and decision overlays.
  function applyRouteVariant(card, routeId) {
    if (!card || !routeId) return;
    const block = card.querySelector('.shanghe-block');
    if (!block) return;

    let variants = null;
    try { variants = JSON.parse(block.dataset.routeVariants || 'null'); } catch (e) {}
    if (!variants || !variants[routeId]) return;  // no per-route data; nothing to update

    const variant = variants[routeId];
    const segs = variant.shanghe_segments || [];

    // 1) Rebuild segment list HTML (keep current speed factor + focus state)
    const list = block.querySelector('[data-list]');
    if (list && window.TF && TF.segmentRowsHTML) {
      list.innerHTML = TF.segmentRowsHTML(segs);
    }

    // 2) Update canvas anchors + decision overlays
    const canvas = card.querySelector('canvas.elev-canvas-day');
    if (canvas && TF.segmentAnchors) {
      const a = TF.segmentAnchors(segs);
      canvas.dataset.anchorIdx = JSON.stringify(a.idx);
      canvas.dataset.anchorLabels = JSON.stringify(a.labels);
      if (Array.isArray(variant.decision_anchors)) {
        canvas.dataset.decisionAnchors = JSON.stringify(variant.decision_anchors);
      }
      // Clear any active focus so user sees the new route in full
      delete canvas.dataset.focusStart;
      delete canvas.dataset.focusEnd;
      card.dataset.focused = 'false';
    }

    // 3) Re-apply current speed factor to the new rows (rows are fresh DOM
    //    but bound via event delegation, so no re-binding needed).
    const speedInput = block.querySelector('.speed-input');
    const factor = (speedInput && parseFloat(speedInput.value)) || 1;
    applySpeedFactor(block, factor);

    // 4) Redraw the canvas with new anchors / decision points
    if (canvas) drawCanvas(canvas);

    // 5) Refresh the multi-day overview (its summit/direction info changes
    //    when the active route variant flips).
    drawOverviewChart();
  }

  function drawCanvas(canvas) {
    if (!canvas) return;
    const gpxRef = canvas.dataset.gpxRef;
    const data = (window.__JM_GPX__ && window.__JM_GPX__[gpxRef]) || null;
    if (!data || !TF.elevation) return;
    let anchors = [], labels = [], decisionList = [];
    try {
      anchors = JSON.parse(canvas.dataset.anchorIdx || '[]');
      labels  = JSON.parse(canvas.dataset.anchorLabels || '[]');
      decisionList = JSON.parse(canvas.dataset.decisionAnchors || '[]');
    } catch (e) {}

    let focusRange = null;
    if (canvas.dataset.focusStart && canvas.dataset.focusEnd) {
      const fs = parseInt(canvas.dataset.focusStart, 10);
      const fe = parseInt(canvas.dataset.focusEnd, 10);
      if (Number.isFinite(fs) && Number.isFinite(fe) && fe > fs) {
        focusRange = [fs, fe];
      }
    }

    TF.elevation.draw(canvas, data, {
      color: canvas.dataset.color || '#1e3a1a',
      fill: canvas.dataset.fill || 'rgba(168,128,44,0.22)',
      anchorIdx: anchors,
      anchorLabels: labels,
      focusRange,
    });
    if (decisionList.length && TF.elevation.renderDecisionOverlays) {
      TF.elevation.renderDecisionOverlays(canvas, data,
        decisionList.map(d => ({
          idx: d.idx,
          label: d.label,
          title: d.title,
          onClick: cycleRoute,
        })),
        { focusRange }
      );
    }
  }

  // ─── Segment focus (click-to-zoom on a 上河 row) ─────────────────────────
  function setFocusOnCanvas(canvas, lo, hi) {
    if (lo == null || hi == null) {
      delete canvas.dataset.focusStart;
      delete canvas.dataset.focusEnd;
    } else {
      canvas.dataset.focusStart = String(lo);
      canvas.dataset.focusEnd = String(hi);
    }
    drawCanvas(canvas);
  }

  function bindSegmentClicks(rootEl) {
    (rootEl || document).querySelectorAll('.elev-card').forEach(card => {
      if (card.__segBound) return;
      card.__segBound = true;

      const canvas = card.querySelector('canvas.elev-canvas-day');
      const block  = card.querySelector('.shanghe-block');
      const reset  = card.querySelector('.elev-focus-reset');
      const list   = block && block.querySelector('[data-list]');

      function applyFocus(row) {
        if (!canvas) return;
        const lo = parseInt(row.dataset.focusStart, 10);
        const hi = parseInt(row.dataset.focusEnd, 10);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;

        const wasActive = row.getAttribute('aria-pressed') === 'true';
        // single-select toggle: clear other rows
        card.querySelectorAll('.sl-row[aria-pressed="true"]').forEach(r => r.setAttribute('aria-pressed', 'false'));
        if (wasActive) {
          card.dataset.focused = 'false';
          setFocusOnCanvas(canvas, null, null);
        } else {
          row.setAttribute('aria-pressed', 'true');
          card.dataset.focused = 'true';
          setFocusOnCanvas(canvas, lo, hi);
        }
      }

      // Use event delegation so re-rendering the row list (after a route
      // switch) doesn't require re-binding individual handlers.
      if (list) {
        list.addEventListener('click', (e) => {
          const row = e.target.closest('.sl-row');
          if (row && list.contains(row)) applyFocus(row);
        });
        list.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const row = e.target.closest('.sl-row');
          if (row && list.contains(row)) { e.preventDefault(); applyFocus(row); }
        });
      }
      if (reset) {
        reset.addEventListener('click', () => {
          card.querySelectorAll('.sl-row[aria-pressed="true"]').forEach(r => r.setAttribute('aria-pressed', 'false'));
          card.dataset.focused = 'false';
          setFocusOnCanvas(canvas, null, null);
        });
      }

      // Speed-factor input
      if (block) {
        const input = block.querySelector('.speed-input');
        if (input) {
          const gpxRef = input.dataset.gpxRef;
          const storageKey = 'jm_speed_' + gpxRef;
          // restore persisted factor
          try {
            const saved = parseFloat(localStorage.getItem(storageKey));
            if (Number.isFinite(saved) && saved >= 0.5 && saved <= 2.5) {
              input.value = saved.toFixed(2);
            }
          } catch (e) {}
          applySpeedFactor(block, parseFloat(input.value) || 1);

          const onChange = () => {
            let f = parseFloat(input.value);
            if (!Number.isFinite(f) || f < 0.5) f = 0.5;
            if (f > 2.5) f = 2.5;
            input.value = f.toFixed(2);
            try { localStorage.setItem(storageKey, String(f)); } catch (e) {}
            applySpeedFactor(block, f);
          };
          input.addEventListener('change', onChange);
          input.addEventListener('input', () => {
            const f = parseFloat(input.value);
            if (Number.isFinite(f) && f >= 0.5 && f <= 2.5) applySpeedFactor(block, f);
          });
        }
      }
    });
  }

  function fmtMin(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), r = m % 60;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }

  function applySpeedFactor(block, factor) {
    if (!block) return;
    block.dataset.speedFactor = factor.toFixed(2);
    let totalBase = 0, totalDerived = 0;
    block.querySelectorAll('.sl-row').forEach(row => {
      const base = parseInt(row.dataset.baseMin, 10) || 0;
      const derived = Math.round(base * factor);
      totalBase += base;
      totalDerived += derived;
      const dEl = row.querySelector('[data-derived]');
      const bEl = row.querySelector('[data-base]');
      if (dEl) dEl.textContent = String(derived);
      if (bEl) bEl.textContent = `(基準 ${base} 分)`;
    });
    const totalEl = block.querySelector('[data-total-derived]');
    const baseEl  = block.querySelector('[data-total-base]');
    if (totalEl) totalEl.textContent = fmtMin(totalDerived);
    if (baseEl)  baseEl.textContent  = `基準 ${fmtMin(totalBase)}`;
  }

  function refreshAll() {
    if (get() !== 'elevation') return;
    document.querySelectorAll('canvas.elev-canvas-day').forEach(canvas => {
      if (canvas.offsetParent !== null) drawCanvas(canvas);
    });
    drawOverviewChart();
  }

  // ─── Overview chart (all-days consolidated, only in elevation mode) ─────
  // Reads optional focus state from the overview card's dataset (set by
  // overview.js when the user clicks a rest-point row). Renders both the
  // main chart (with zoom applied if focused) and a flat minimap below it
  // (always full-trip, with a highlight rectangle when focused).
  function drawOverviewChart() {
    if (!TF.elevation || !TF.elevation.drawOverview) return;
    const overview = document.getElementById('elev-overview');
    if (!overview) return;
    const canvas = document.getElementById('elev-overview-canvas');
    if (!canvas) return;

    // Collect days from window.__PLAN__ (or static plan-data) + GPX from __JM_GPX__
    const plan = window.__PLAN__ || (window.TF && TF.loadPlan && TF.loadPlan());
    if (!plan || !Array.isArray(plan.days)) return;

    const gpx = window.__JM_GPX__ || {};
    const days = [];
    const dayIds = [];  // parallel array of plan-day ids, so overview.js can map
    plan.days.forEach(d => {
      const ep = d.elevation_profile;
      if (!ep || !ep.gpx_ref) return;
      const track = gpx[ep.gpx_ref];
      if (!track || !track.length) return;
      // Detect active route variant for this day
      let summitIdx = ep.summit_idx;
      let summitLabel = ep.summit_label;
      let direction = ep.direction;
      let segments = ep.shanghe_segments || [];
      if (ep.route_variants) {
        // Find which route is currently active in DOM
        const dayPanel = document.getElementById('day-' + d.id);
        const activeTab = dayPanel && dayPanel.querySelector('.r-tab.active');
        if (activeTab) {
          const onclickAttr = activeTab.getAttribute('onclick') || '';
          const m = onclickAttr.match(/switchRoute\(['"]([^'"]+)['"]\)/);
          const routeId = m && m[1];
          const v = routeId && ep.route_variants[routeId];
          if (v) {
            if (v.summit_idx != null) summitIdx = v.summit_idx;
            if (v.summit_label) summitLabel = v.summit_label;
            if (v.direction) direction = v.direction;
            if (v.shanghe_segments) segments = v.shanghe_segments;
          }
        }
      }
      days.push({
        gpx: track,
        label: d.label || ('Day ' + d.id),
        summitIdx, summitLabel, direction,
        segments,
      });
      dayIds.push(d.id);
    });
    if (!days.length) return;

    // Auto-return-descent: append a reversed-ascent_only synthetic day
    // when the trip clearly returns to its trailhead but no later day
    // covers that descent. Must run BEFORE stitchDayBoundaries so the
    // synthetic day participates in boundary stitching. Driven by a
    // user-level checkbox (see initAutoReturnToggle below); falls back
    // to default ON when no preference recorded.
    if (TF.overview && TF.overview.synthesizeReturnDay) {
      TF.overview.synthesizeReturnDay(days, plan, { enabled: getAutoReturn() });
    }

    // PR-22 part 2: stitch day boundaries so vertical cliffs at junctions
    // become smooth interpolated joins. We mutate the days array (overview
    // chart is the only consumer) — anchor_idx shifts are applied inline.
    if (TF.overview && TF.overview.stitchDayBoundaries) {
      TF.overview.stitchDayBoundaries(days);
    }

    // Read focus from dataset (set by overview.js row clicks).
    let focusRange = null;
    if (overview.dataset.focusDayId && overview.dataset.focusLo && overview.dataset.focusHi) {
      const dayIdx = dayIds.indexOf(overview.dataset.focusDayId);
      const lo = parseInt(overview.dataset.focusLo, 10);
      const hi = parseInt(overview.dataset.focusHi, 10);
      if (dayIdx >= 0 && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
        focusRange = { dayIdx, lo, hi };
      }
    }

    TF.elevation.drawOverview(canvas, days, { focusRange });

    // Minimap (only when card has focus state — saves a render otherwise)
    const mini = document.getElementById('elev-overview-minimap');
    if (mini) {
      TF.elevation.drawOverview(mini, days, { focusRange, minimap: true });
    }
  }

  function bindToggle() {
    const toggle = document.getElementById('jmModeToggle');
    if (!toggle || toggle.__bound) return;
    toggle.__bound = true;
    toggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        set(btn.dataset.targetMode);
      });
    });
  }

  function init(rootEl) {
    bindToggle();
    bindSegmentClicks(rootEl);
    // For days that have routes (e.g. Day 2 → 2A/2B), pre-populate the
    // route-info badge with the currently-active variant so the user can
    // immediately read which route is selected.
    (rootEl || document).querySelectorAll('.day-panel').forEach(panel => {
      if (panel.querySelector('.r-tab')) updateRouteInfo(panel);
    });
  }

  // ─── Auto-return-descent toggle ──────────────────────────────────────
  // Per-plan localStorage (so two different plans can have different
  // settings on the same device). Default ON when no preference recorded.
  function autoReturnKey() {
    const params = new URLSearchParams(location.search);
    const planId = params.get('plan') || 'static';
    return 'tf_auto_return::' + planId;
  }
  function getAutoReturn() {
    try {
      const v = localStorage.getItem(autoReturnKey());
      if (v === '0') return false;
      return true;  // default on
    } catch (e) { return true; }
  }
  function setAutoReturn(v) {
    try { localStorage.setItem(autoReturnKey(), v ? '1' : '0'); } catch (e) {}
  }
  function initAutoReturnToggle() {
    const cb = document.getElementById('elev-auto-return');
    if (!cb || cb.__bound) return;
    cb.__bound = true;
    cb.checked = getAutoReturn();
    cb.addEventListener('change', () => {
      setAutoReturn(!!cb.checked);
      drawOverviewChart();
    });
  }

  // Initialise the global mode on DOM ready (or immediately if already loaded).
  function boot() {
    bindToggle();
    initAutoReturnToggle();
    set(recall());
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Redraw on resize (debounced).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshAll, 120);
  });

  TF.modeToggle = { set, get, init, refreshAll };
})();
