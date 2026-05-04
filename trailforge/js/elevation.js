/* Trailforge — Elevation module
 * Pure functions for elevation profile rendering and 上河 (Shanghe) segment math.
 *
 * Public API (attached to window.TF.elevation):
 *   stats(gpx)                   → {distanceKm, ascentM, descentM, maxElev, minElev}
 *   draw(canvas, gpx, opts)      → render filled elevation profile to canvas
 *   applyShanghe(segments, gpx, factor) → distribute base_minutes proportionally
 *   formatHM(minutes)            → "5h 20m" / "45 min"
 *
 * No DOM mutation outside the supplied canvas. No globals other than TF namespace.
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  // ─── Geometry helpers ────────────────────────────────────────────────────
  // Haversine distance in metres between two lat/lon pairs.
  function haversine(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Cumulative distance (m) per gpx point.
  function cumDist(gpx) {
    const d = [0];
    for (let i = 1; i < gpx.length; i++) {
      d.push(d[i - 1] + haversine(gpx[i - 1][0], gpx[i - 1][1], gpx[i][0], gpx[i][1]));
    }
    return d;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────
  function stats(gpx) {
    if (!gpx || !gpx.length) {
      return { distanceKm: 0, ascentM: 0, descentM: 0, maxElev: 0, minElev: 0 };
    }
    const cd = cumDist(gpx);
    let ascent = 0, descent = 0;
    let maxE = gpx[0][2], minE = gpx[0][2];
    for (let i = 1; i < gpx.length; i++) {
      const dE = gpx[i][2] - gpx[i - 1][2];
      if (dE > 0) ascent += dE; else descent += -dE;
      if (gpx[i][2] > maxE) maxE = gpx[i][2];
      if (gpx[i][2] < minE) minE = gpx[i][2];
    }
    return {
      distanceKm: cd[cd.length - 1] / 1000,
      ascentM: Math.round(ascent),
      descentM: Math.round(descent),
      maxElev: Math.round(maxE),
      minElev: Math.round(minE),
    };
  }

  // ─── Projection helper (shared by draw() and renderDecisionOverlays) ─────
  // Computes the canvas → graph mapping. When opts.focusRange is set, the
  // chart zooms to that gpx-index slice (still drawing only those points
  // with new x/y bounds derived from the slice).
  function buildProjection(canvas, gpx, opts) {
    opts = opts || {};
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;

    const W = r.width, H = r.height;
    const pad = { t: 14, r: 14, b: 22, l: 44 };
    const gW = W - pad.l - pad.r;
    const gH = H - pad.t - pad.b;

    let lo = 0, hi = gpx.length - 1;
    if (Array.isArray(opts.focusRange) && opts.focusRange.length === 2) {
      const [a, b] = opts.focusRange;
      const aa = Math.max(0, Math.min(gpx.length - 1, Math.min(a, b)));
      const bb = Math.max(0, Math.min(gpx.length - 1, Math.max(a, b)));
      if (bb > aa) { lo = aa; hi = bb; }
    }
    const slice = gpx.slice(lo, hi + 1);
    const cd = cumDist(slice);
    const totalD = cd[cd.length - 1] || 1;
    const elevs = slice.map(p => p[2]);
    const minE = Math.min(...elevs) - 30;
    const maxE = Math.max(...elevs) + 30;
    const eRange = maxE - minE || 1;

    return {
      r, W, H, pad, gW, gH, lo, hi, slice, cd, totalD, minE, maxE, eRange,
      xOfGlobal: (idx) => {
        if (idx < lo || idx > hi) return null;
        return pad.l + (cd[idx - lo] / totalD) * gW;
      },
      yOfGlobal: (idx) => {
        if (idx < lo || idx > hi) return null;
        return pad.t + gH - ((gpx[idx][2] - minE) / eRange) * gH;
      },
    };
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────
  // opts = {
  //   color: '#1e3a1a',           // line stroke colour
  //   fill:  'rgba(168,128,44,.18)',
  //   anchorIdx: [0, 23, ...]     // gpx indices to mark as 上河 anchor points
  //   anchorLabels: [...],        // optional labels
  //   focusRange: [startIdx, endIdx]  // optional zoom to this gpx slice
  // }
  function draw(canvas, gpx, opts) {
    if (!canvas || !gpx || !gpx.length) return;
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const proj = buildProjection(canvas, gpx, opts);
    if (!proj) return;

    canvas.width = proj.r.width * dpr;
    canvas.height = proj.r.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const { W, H, pad, gW, gH, lo, hi, slice, cd, totalD, minE, maxE, eRange } = proj;
    const xOf = (sliceIdx) => pad.l + (cd[sliceIdx] / totalD) * gW;
    const yOf = (sliceIdx) => pad.t + gH - ((slice[sliceIdx][2] - minE) / eRange) * gH;

    // Background (paper texture matches outer card)
    ctx.fillStyle = '#fdf9ee';
    ctx.fillRect(0, 0, W, H);

    // Horizontal grid + labels
    ctx.strokeStyle = 'rgba(42,36,24,0.10)';
    ctx.lineWidth = 0.5;
    ctx.fillStyle = '#7a7468';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + gH - (i / 4) * gH;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + gW, y);
      ctx.stroke();
      const e = Math.round(minE + (eRange * i) / 4);
      ctx.fillText(e + 'm', pad.l - 4, y + 3);
    }

    // Filled profile
    const fillColor = opts.fill || 'rgba(168,128,44,0.22)';
    const lineColor = opts.color || '#1e3a1a';

    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + gH);
    for (let i = 0; i < slice.length; i++) ctx.lineTo(xOf(i), yOf(i));
    ctx.lineTo(pad.l + gW, pad.t + gH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, 'rgba(168,128,44,0.04)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Profile line
    ctx.beginPath();
    for (let i = 0; i < slice.length; i++) {
      if (i === 0) ctx.moveTo(xOf(i), yOf(i));
      else ctx.lineTo(xOf(i), yOf(i));
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Anchor markers (上河 segment endpoints) — only those within the focus range
    const anchors = Array.isArray(opts.anchorIdx) ? opts.anchorIdx : [];
    const labels  = Array.isArray(opts.anchorLabels) ? opts.anchorLabels : [];
    const visibleAnchors = anchors
      .map((idx, k) => ({ idx, label: labels[k] }))
      .filter(a => a.idx >= lo && a.idx <= hi);
    visibleAnchors.forEach((a, k) => {
      const sliceIdx = a.idx - lo;
      const x = xOf(sliceIdx), y = yOf(sliceIdx);
      // vertical hairline
      ctx.strokeStyle = 'rgba(110,83,22,0.35)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + gH);
      ctx.stroke();
      ctx.setLineDash([]);
      // brass dot
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      const dotG = ctx.createRadialGradient(x - 1.2, y - 1.2, 0, x, y, 4.5);
      dotG.addColorStop(0, '#e8c870');
      dotG.addColorStop(1, '#6e5316');
      ctx.fillStyle = dotG;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0a1a06';
      ctx.stroke();
      // label
      if (a.label) {
        ctx.font = '600 9px "Noto Serif TC", serif';
        ctx.fillStyle = '#0a1a06';
        ctx.textAlign = (k === 0) ? 'left' : (k === visibleAnchors.length - 1) ? 'right' : 'center';
        ctx.fillText(a.label, x, pad.t - 3);
      }
    });

    // X-axis distance scale (labels at 0 / end of visible range)
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#7a7468';
    ctx.textAlign = 'left';
    ctx.fillText('0', pad.l, pad.t + gH + 13);
    ctx.textAlign = 'right';
    ctx.fillText((totalD / 1000).toFixed(1) + ' km', pad.l + gW, pad.t + gH + 13);
  }

  // ─── 上河 segment math ───────────────────────────────────────────────────
  // segments: [{ id, from, to, base_minutes, ascent_m, distance_km, anchor_idx:[a,b] }]
  // gpx:      [[lat, lon, elev], ...]
  // factor:   speed factor (>1 = slower than 上河, default 1.3)
  // returns:  { segments: [{...seg, derived_minutes, derived_distance_km, derived_ascent_m}], totalMinutes, totalDistanceKm }
  function applyShanghe(segments, gpx, factor) {
    factor = (typeof factor === 'number' && factor > 0) ? factor : 1.3;
    if (!segments || !segments.length) {
      return { segments: [], totalMinutes: 0, totalDistanceKm: 0 };
    }

    const cd = gpx ? cumDist(gpx) : null;
    let totalMin = 0, totalKm = 0;
    const out = segments.map(s => {
      const derivedMin = Math.round((s.base_minutes || 0) * factor);
      let derivedKm = s.distance_km || 0;
      if (cd && Array.isArray(s.anchor_idx) && s.anchor_idx.length === 2) {
        const [a, b] = s.anchor_idx;
        if (a >= 0 && b < cd.length && b > a) {
          derivedKm = (cd[b] - cd[a]) / 1000;
        }
      }
      totalMin += derivedMin;
      totalKm += derivedKm;
      return Object.assign({}, s, {
        derived_minutes: derivedMin,
        derived_distance_km: derivedKm,
      });
    });
    return { segments: out, totalMinutes: totalMin, totalDistanceKm: totalKm };
  }

  // ─── Formatters ──────────────────────────────────────────────────────────
  function formatHM(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }

  // ─── Decision-point overlay ──────────────────────────────────────────────
  // Inserts (or refreshes) clickable <button> markers on top of the canvas at
  // the gpx indices listed in decisionAnchors. Used for Day 2's 主北岔/風口
  // fork — clicking the marker switches the active route (2A ↔ 2B).
  //
  // decisionAnchors: [{ idx: 94, label: '風口・決策點', onClick: () => {} }]
  function renderDecisionOverlays(canvas, gpx, decisionAnchors, opts) {
    if (!canvas || !gpx || !gpx.length) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    // Clear any previous overlays for this canvas
    wrap.querySelectorAll('.elev-decision-marker').forEach(el => el.remove());

    const proj = buildProjection(canvas, gpx, opts || {});
    if (!proj) return;
    const { lo, hi } = proj;

    decisionAnchors.forEach(a => {
      if (a.idx == null || a.idx < lo || a.idx > hi) return;  // outside focus range
      const x = proj.xOfGlobal(a.idx);
      const y = proj.yOfGlobal(a.idx);
      if (x == null || y == null) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'elev-decision-marker';
      btn.style.left = `${x}px`;
      btn.style.top = `${y}px`;
      btn.title = a.title || a.label || '決策點 — 點擊切換路線';
      btn.setAttribute('aria-label', btn.title);
      btn.innerHTML = `<span class="edm-ring" aria-hidden="true"></span>` +
                      (a.label ? `<span class="edm-label">${a.label}</span>` : '');
      if (typeof a.onClick === 'function') {
        btn.addEventListener('click', (ev) => { ev.preventDefault(); a.onClick(ev); });
      }
      wrap.appendChild(btn);
    });
  }

  // ─── Multi-day overview chart ────────────────────────────────────────────
  // Renders ALL days concatenated end-to-end on a single canvas, with:
  //   - day boundaries (vertical dashed line + label at top)
  //   - ascent (toward summit) and descent (back from summit) colour-coded
  //   - per-day summit anchor marker
  //
  // days: [{
  //   gpx:      [[lat,lon,elev], ...],
  //   label:    'Day 1',
  //   summitIdx: 394,      // index within this day's gpx where ascent ends
  //   summitLabel: '排雲山莊',
  //   direction: 'ascent_only' | 'out_and_back',
  // }, ...]
  // opts.focusRange (optional):
  //   { dayIdx, lo, hi } — clamp the X-axis to days[dayIdx].gpx[lo..hi]
  //   The chart still uses the same elevation range for stable Y context,
  //   but the visible distance window is just that segment. When focusRange
  //   is set, dimmed-context day labels and other days' fills are skipped
  //   so the eye lands on the focused segment.
  // opts.minimap (optional, boolean):
  //   When true, render a flat 50px-tall minimap variant: full-trip outline
  //   only, with a translucent highlight rectangle over the focusRange.
  //   Suppresses axes / labels / summit markers / checkpoints — purely for
  //   "where in the whole trip am I zoomed to?" navigation.
  function drawOverview(canvas, days, opts) {
    if (!canvas || !Array.isArray(days) || !days.length) return;
    opts = opts || {};
    const isMinimap = !!opts.minimap;
    const focusRange = opts.focusRange || null;
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = r.width, H = r.height;
    const pad = isMinimap
      ? { t: 4, r: 8, b: 4, l: 8 }
      : { t: 32, r: 18, b: 56, l: 52 };
    const gW = W - pad.l - pad.r;
    const gH = H - pad.t - pad.b;

    // Per-day cumulative distances + global offsets so we can draw
    // continuously left → right across the whole trip.
    const perDay = days.map(d => {
      const cd = cumDist(d.gpx);
      return { ...d, cd, len: cd[cd.length - 1] || 0 };
    });
    const totalDist = perDay.reduce((a, d) => a + d.len, 0) || 1;

    // Compute global offsets
    let runOff = 0;
    perDay.forEach(d => { d.offset = runOff; runOff += d.len; });

    // ── Focus window: compute the global-distance range we want X-mapped to
    // span pad.l..pad.l+gW. Without focus, that's [0, totalDist].
    let focusStartDist = 0, focusEndDist = totalDist;
    if (focusRange && !isMinimap) {
      const fd = perDay[focusRange.dayIdx];
      if (fd) {
        const lo = Math.max(0, Math.min(fd.cd.length - 1, focusRange.lo));
        const hi = Math.max(0, Math.min(fd.cd.length - 1, focusRange.hi));
        if (hi > lo) {
          focusStartDist = fd.offset + fd.cd[lo];
          focusEndDist   = fd.offset + fd.cd[hi];
        }
      }
    }
    const focusSpan = (focusEndDist - focusStartDist) || totalDist;

    // Combined elevation min/max — when focused, only sample within the
    // focused window so Y axis is sized to the segment of interest.
    let minE = Infinity, maxE = -Infinity;
    if (focusRange && !isMinimap) {
      const fd = perDay[focusRange.dayIdx];
      if (fd) {
        const lo = Math.max(0, Math.min(fd.gpx.length - 1, focusRange.lo));
        const hi = Math.max(0, Math.min(fd.gpx.length - 1, focusRange.hi));
        for (let i = lo; i <= hi; i++) {
          const e = fd.gpx[i][2];
          if (e < minE) minE = e;
          if (e > maxE) maxE = e;
        }
      }
    }
    if (!Number.isFinite(minE) || !Number.isFinite(maxE)) {
      minE = Infinity; maxE = -Infinity;
      perDay.forEach(d => d.gpx.forEach(p => {
        if (p[2] < minE) minE = p[2];
        if (p[2] > maxE) maxE = p[2];
      }));
    }
    minE -= 50; maxE += 50;
    const eRange = maxE - minE || 1;

    const xOf = (dayObj, sliceIdx) =>
      pad.l + ((dayObj.offset + dayObj.cd[sliceIdx] - focusStartDist) / focusSpan) * gW;
    const yOf = (dayObj, sliceIdx) =>
      pad.t + gH - ((dayObj.gpx[sliceIdx][2] - minE) / eRange) * gH;

    // Background
    ctx.fillStyle = '#fdf9ee';
    ctx.fillRect(0, 0, W, H);

    // ── Minimap variant: flat full-trip outline + focus highlight rect.
    // Bails out before any of the heavyweight axes / labels / summit
    // markers / checkpoints; minimap is purely navigational.
    if (isMinimap) {
      // Simple combined area chart, no day-split colours.
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + gH);
      perDay.forEach(d => {
        for (let i = 0; i < d.gpx.length; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
      });
      ctx.lineTo(pad.l + gW, pad.t + gH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(30,58,26,0.18)';
      ctx.fill();
      // Outline
      ctx.beginPath();
      let firstPt = true;
      perDay.forEach(d => {
        for (let i = 0; i < d.gpx.length; i++) {
          if (firstPt) { ctx.moveTo(xOf(d, i), yOf(d, i)); firstPt = false; }
          else ctx.lineTo(xOf(d, i), yOf(d, i));
        }
      });
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#1e3a1a';
      ctx.stroke();
      // Day boundaries — thin dashed
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(110,83,22,0.55)';
      ctx.lineWidth = 0.8;
      perDay.forEach((d, k) => {
        if (k === 0) return;
        const bx = pad.l + (d.offset / totalDist) * gW;
        ctx.beginPath();
        ctx.moveTo(bx, pad.t);
        ctx.lineTo(bx, pad.t + gH);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      // Focus highlight rectangle
      if (focusRange) {
        const fd = perDay[focusRange.dayIdx];
        if (fd) {
          const lo = Math.max(0, Math.min(fd.gpx.length - 1, focusRange.lo));
          const hi = Math.max(0, Math.min(fd.gpx.length - 1, focusRange.hi));
          if (hi > lo) {
            const x1 = pad.l + ((fd.offset + fd.cd[lo]) / totalDist) * gW;
            const x2 = pad.l + ((fd.offset + fd.cd[hi]) / totalDist) * gW;
            ctx.fillStyle = 'rgba(168,128,44,0.32)';
            ctx.fillRect(x1, pad.t, Math.max(2, x2 - x1), gH);
            ctx.strokeStyle = '#a8802c';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x1, pad.t, Math.max(2, x2 - x1), gH);
          }
        }
      }
      return;
    }

    // Y-grid + elevation labels
    ctx.strokeStyle = 'rgba(42,36,24,0.10)';
    ctx.lineWidth = 0.5;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#7a7468';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + gH - (i / 4) * gH;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + gW, y);
      ctx.stroke();
      ctx.fillText(Math.round(minE + (eRange * i) / 4) + 'm', pad.l - 4, y + 3);
    }

    // Per-day fills, split into 去程 (ascent) and 回程 (descent) colour zones
    const ASCENT_COLOR  = '#1e3a1a';            // forest green
    const ASCENT_FILL   = 'rgba(30,58,26,0.22)';
    const DESCENT_COLOR = '#a8802c';            // brass
    const DESCENT_FILL  = 'rgba(168,128,44,0.30)';
    // Optional override per-day
    perDay.forEach(d => {
      const ascentEnd = (d.direction === 'ascent_only')
        ? (d.gpx.length - 1)
        : Math.max(0, Math.min(d.gpx.length - 1, d.summitIdx ?? (d.gpx.length - 1)));

      // Filled ascent zone
      ctx.beginPath();
      ctx.moveTo(xOf(d, 0), pad.t + gH);
      for (let i = 0; i <= ascentEnd; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
      ctx.lineTo(xOf(d, ascentEnd), pad.t + gH);
      ctx.closePath();
      const gA = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
      gA.addColorStop(0, ASCENT_FILL);
      gA.addColorStop(1, 'rgba(30,58,26,0.05)');
      ctx.fillStyle = gA;
      ctx.fill();

      // Filled descent zone (if any)
      if (ascentEnd < d.gpx.length - 1) {
        ctx.beginPath();
        ctx.moveTo(xOf(d, ascentEnd), pad.t + gH);
        for (let i = ascentEnd; i < d.gpx.length; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
        ctx.lineTo(xOf(d, d.gpx.length - 1), pad.t + gH);
        ctx.closePath();
        const gD = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
        gD.addColorStop(0, DESCENT_FILL);
        gD.addColorStop(1, 'rgba(168,128,44,0.06)');
        ctx.fillStyle = gD;
        ctx.fill();
      }

      // Profile line — coloured per zone
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xOf(d, 0), yOf(d, 0));
      for (let i = 1; i <= ascentEnd; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
      ctx.strokeStyle = ASCENT_COLOR;
      ctx.stroke();
      if (ascentEnd < d.gpx.length - 1) {
        ctx.beginPath();
        ctx.moveTo(xOf(d, ascentEnd), yOf(d, ascentEnd));
        for (let i = ascentEnd + 1; i < d.gpx.length; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
        ctx.strokeStyle = DESCENT_COLOR;
        ctx.stroke();
      }

      // Summit marker — only when we have a label (a peak worth naming).
      // Synthetic/descent-only days set summitIdx=0 to drive zone colours
      // but don't want a dot at the start.
      if (d.summitLabel && typeof d.summitIdx === 'number' && d.summitIdx >= 0 && d.summitIdx < d.gpx.length) {
        const sx = xOf(d, d.summitIdx);
        const sy = yOf(d, d.summitIdx);
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        const sg = ctx.createRadialGradient(sx - 1.5, sy - 1.5, 0, sx, sy, 5);
        sg.addColorStop(0, '#fde68a');
        sg.addColorStop(1, '#a8802c');
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#0a1a06';
        ctx.stroke();
        if (d.summitLabel) {
          ctx.font = '700 9px "Noto Serif TC", serif';
          ctx.fillStyle = '#0a1a06';
          ctx.textAlign = 'center';
          ctx.fillText('▲ ' + d.summitLabel, sx, sy - 9);
        }
      }

      // Per-segment checkpoint markers — every segment endpoint becomes a
      // labelled tick. We collect unique gpx indices from segment.anchor_idx
      // and build a name map from segment.from / segment.to so we can draw
      // each checkpoint exactly once with the correct station name.
      // Skip indices that coincide with the summit (already marked above).
      // Also skip names listed in d._suppressCheckpointNames — used by the
      // cross-day dedupe pass below to avoid drawing e.g. 排雲山莊 twice
      // when it appears as Day N's last stop AND Day N+1's first stop.
      if (Array.isArray(d.segments) && d.segments.length) {
        const cpMap = new Map(); // idx -> name
        d.segments.forEach(s => {
          const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
          if (ai.length >= 2) {
            if (s.from && !cpMap.has(ai[0])) cpMap.set(ai[0], s.from);
            if (s.to   && !cpMap.has(ai[1])) cpMap.set(ai[1], s.to);
          }
        });
        const suppress = d._suppressCheckpointNames || new Set();
        // Sort so labels render left → right (helps stagger placement)
        const cps = [...cpMap.entries()]
          .filter(([idx]) => idx >= 0 && idx < d.gpx.length)
          .filter(([idx]) => idx !== d.summitIdx)
          .filter(([, name]) => !suppress.has(name))
          .sort((a, b) => a[0] - b[0]);

        ctx.font = '600 9px "Noto Serif TC", serif';
        cps.forEach(([idx, name], i) => {
          const cx = xOf(d, idx);
          const cy = yOf(d, idx);
          // Tick — small dark green dot ringed in cream
          ctx.beginPath();
          ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = '#fdf9ee';
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = '#1e3a1a';
          ctx.stroke();
          // Drop line down to baseline so checkpoint reads as a station
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 0.7;
          ctx.strokeStyle = 'rgba(30,58,26,0.35)';
          ctx.beginPath();
          ctx.moveTo(cx, cy + 4);
          ctx.lineTo(cx, pad.t + gH);
          ctx.stroke();
          ctx.setLineDash([]);
          // Label — all labels live on the X-axis (below the chart) so
          // the elevation profile itself stays clean. Stagger two rows
          // to reduce collision when checkpoints sit close together.
          ctx.fillStyle = '#0a1a06';
          ctx.textAlign = 'center';
          const rowY = (i % 2 === 0) ? (pad.t + gH + 13) : (pad.t + gH + 25);
          ctx.fillText(name, cx, rowY);
        });
      }
    });

    // Day boundary lines + top labels
    ctx.font = '700 11px "Fraunces", "Noto Serif TC", serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0a1a06';
    let cursor = pad.l;
    perDay.forEach((d, k) => {
      const startX = pad.l + (d.offset / totalDist) * gW;
      const endX = pad.l + ((d.offset + d.len) / totalDist) * gW;
      // top label band
      ctx.fillStyle = (k % 2 === 0) ? 'rgba(30,58,26,0.07)' : 'rgba(168,128,44,0.10)';
      ctx.fillRect(startX, 2, endX - startX, pad.t - 6);
      // day label centred
      ctx.fillStyle = '#0a1a06';
      ctx.textAlign = 'center';
      ctx.fillText(d.label || `Day ${k + 1}`, (startX + endX) / 2, pad.t - 8);
      // boundary line (skip first day's left edge)
      if (k > 0) {
        ctx.strokeStyle = 'rgba(110,83,22,0.55)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(startX, pad.t);
        ctx.lineTo(startX, pad.t + gH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // X-axis distance scale — sits below the two checkpoint-label rows
    // (rows are at +13 and +25; km labels live at +40).
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#7a7468';
    ctx.textAlign = 'left';
    ctx.fillText('0', pad.l, pad.t + gH + 40);
    ctx.textAlign = 'right';
    ctx.fillText((totalDist / 1000).toFixed(1) + ' km', pad.l + gW, pad.t + gH + 40);
  }

  TF.elevation = {
    stats, draw, drawOverview, applyShanghe, formatHM,
    renderDecisionOverlays,
    _cumDist: cumDist,
  };
})();
