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
      // top: day-band (32px) + 3-row label stack (~88px) so dense
      // ascent/descent regions can stagger without overlapping.
      // bottom: km axis labels (~14px) — names moved up to above the dots
      : { t: 124, r: 18, b: 22, l: 52 };
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

    // Per-day palette — two-tone per day so Day 1 vs Day 2 vs … are
    // visually distinguishable on the stitched chart. Synthetic 回程 days
    // inherit their source day's dayId, so they pick the same palette and
    // read as a continuation rather than a new day.
    const DAY_PALETTES = [
      // Day 1 — forest green ascent / brass descent (the existing palette)
      { asc: '#1e3a1a', ascF: 'rgba(30,58,26,0.24)',  ascF2: 'rgba(30,58,26,0.05)',
        desc: '#a8802c', descF: 'rgba(168,128,44,0.30)', descF2: 'rgba(168,128,44,0.06)' },
      // Day 2 — slate blue ascent / sage olive descent
      { asc: '#1d4e6f', ascF: 'rgba(29,78,111,0.22)', ascF2: 'rgba(29,78,111,0.04)',
        desc: '#7a8456', descF: 'rgba(122,132,86,0.32)', descF2: 'rgba(122,132,86,0.06)' },
      // Day 3 — rust ascent / forest descent
      { asc: '#7a3924', ascF: 'rgba(122,57,36,0.22)', ascF2: 'rgba(122,57,36,0.04)',
        desc: '#1e3a1a', descF: 'rgba(30,58,26,0.30)', descF2: 'rgba(30,58,26,0.05)' },
      // Day 4 — eggplant ascent / mustard descent
      { asc: '#54295c', ascF: 'rgba(84,41,92,0.22)',  ascF2: 'rgba(84,41,92,0.04)',
        desc: '#b8862c', descF: 'rgba(184,134,44,0.30)', descF2: 'rgba(184,134,44,0.06)' },
    ];
    // Stable palette index keyed off dayId (so the synthetic 回程 inherits
    // its source day's colour) — fall back to position when dayId missing.
    const dayIdSeen = new Map();
    let nextPaletteSlot = 0;
    perDay.forEach((d, k) => {
      const key = d.dayId != null ? String(d.dayId) : '__pos_' + k;
      if (!dayIdSeen.has(key)) dayIdSeen.set(key, nextPaletteSlot++);
      d._paletteIdx = dayIdSeen.get(key);
    });

    // Optional override per-day
    perDay.forEach((d, dayK) => {
      const pal = DAY_PALETTES[d._paletteIdx % DAY_PALETTES.length];
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
      gA.addColorStop(0, pal.ascF);
      gA.addColorStop(1, pal.ascF2);
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
        gD.addColorStop(0, pal.descF);
        gD.addColorStop(1, pal.descF2);
        ctx.fillStyle = gD;
        ctx.fill();
      }

      // Profile line — coloured per zone
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xOf(d, 0), yOf(d, 0));
      for (let i = 1; i <= ascentEnd; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
      ctx.strokeStyle = pal.asc;
      ctx.stroke();
      if (ascentEnd < d.gpx.length - 1) {
        ctx.beginPath();
        ctx.moveTo(xOf(d, ascentEnd), yOf(d, ascentEnd));
        for (let i = ascentEnd + 1; i < d.gpx.length; i++) ctx.lineTo(xOf(d, i), yOf(d, i));
        ctx.strokeStyle = pal.desc;
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
        const cpMap = new Map();         // idx → name
        const cumMinByIdx = new Map();   // idx → cum minutes at FIRST visit
        const dwellEndByIdx = new Map(); // idx → cum minutes after a same-place rest stop
        let cumMin = 0;
        d.segments.forEach((s, i) => {
          const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
          const baseMin = +s.base_minutes || 0;
          if (ai.length >= 2) {
            if (s.from && !cpMap.has(ai[0])) cpMap.set(ai[0], s.from);
            if (s.to   && !cpMap.has(ai[1])) cpMap.set(ai[1], s.to);
            if (!cumMinByIdx.has(ai[0])) cumMinByIdx.set(ai[0], cumMin);
            const cumAtTo = cumMin + baseMin;
            // First-visit-wins: out-and-back loops revisit the same anchor
            // index later with a higher cum; the chart should still report
            // the original arrival time.
            if (!cumMinByIdx.has(ai[1])) cumMinByIdx.set(ai[1], cumAtTo);
            // Look ahead — if the very next segment is an in-place dwell
            // at this same waypoint, record the cum at its end so the
            // label can render "T1～T2" (e.g. 玉山主峰 09:30～10:30).
            const next = d.segments[i + 1];
            if (next && next.is_rest_stop && next.from === s.to && !dwellEndByIdx.has(ai[1])) {
              dwellEndByIdx.set(ai[1], cumAtTo + (+next.base_minutes || 0));
            }
          }
          // Always advance the day's cumulative clock — including
          // is_rest_stop dwells that have no anchor_idx. Without this,
          // any waypoint after 北峰 dwell / 主峰 dwell read as too early.
          cumMin += baseMin;
        });
        const suppress = d._suppressCheckpointNames || new Set();
        // Sort by idx (left → right), then dedupe by NAME — within ONE
        // day. Out-and-back loops (D2A: 排雲→主北岔→北峰→主北岔→主峰→排雲)
        // visit the same name multiple times in the stitched track; only
        // the first visit's clock is useful on the chart. Cross-day
        // dedupe is handled separately by stitchDayBoundaries (sets
        // d._suppressCheckpointNames for adjacent same-name boundaries),
        // so synth-return descent days still draw 孟祿亭 / 白木林 / 大峭壁
        // again with their descent times — they're on a different day.
        const seenNames = new Set();
        const cps = [...cpMap.entries()]
          .filter(([idx]) => idx >= 0 && idx < d.gpx.length)
          .filter(([idx]) => idx !== d.summitIdx)
          .filter(([, name]) => !suppress.has(name))
          .sort((a, b) => a[0] - b[0])
          .filter(([, name]) => {
            if (seenNames.has(name)) return false;
            seenNames.add(name);
            return true;
          });

        const factor = (typeof opts.speedFactor === 'number' && opts.speedFactor > 0) ? opts.speedFactor : 1;
        const parseMin = (s) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
          if (!m) return null;
          const h = +m[1], mm = +m[2];
          if (h < 0 || h > 47 || mm < 0 || mm > 59) return null;
          return h * 60 + mm;
        };
        // Synthetic-return days (auto-补齊 descent) have no startTime
        // of their own — chain off the source day's clock so the
        // descent's arrival pills continue from where the attack ended.
        let startMin = parseMin(d.startTime);
        if (startMin == null && d.__synthetic_return && days[d.__returnFromDayIdx]) {
          const src = days[d.__returnFromDayIdx];
          const srcStart = parseMin(src.startTime);
          if (srcStart != null) {
            const srcCum = (src.segments || []).reduce(
              (acc, s) => acc + (+s.base_minutes || 0), 0);
            startMin = srcStart + Math.round(srcCum * factor);
          }
        }
        const fmtClock = (mins) => {
          const t = ((mins % 1440) + 1440) % 1440;
          return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
        };

        // Stack labels (name on top, time pill below) at the top of the
        // chart with a thin vertical guide down to the dot. Three-row
        // staggering: each label picks the topmost free row. Dense
        // sequences (D1 ascent + D2 attack + D2 descent ≈ 16 labels) no
        // longer collapse on the 2-row lane.
        if (!opts._stackLastX) opts._stackLastX = [-Infinity, -Infinity, -Infinity];
        const stackBaseY = 30;            // upper-row name baseline y
        const rowDelta   = 28;            // y offset between rows
        const minHGap    = 6;             // px breathing room between labels

        cps.forEach(([idx, name]) => {
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

          // ── Build label content ──
          let arrivalText = '';
          if (startMin != null) {
            const cumBase = cumMinByIdx.get(idx);
            if (cumBase != null) {
              arrivalText = fmtClock(startMin + Math.round(cumBase * factor));
              // Same-day dwell directly after this waypoint (in-place rest
              // stop) → render as a range: "09:30～10:30".
              const dwellEnd = dwellEndByIdx.get(idx);
              if (dwellEnd != null && dwellEnd !== cumBase) {
                arrivalText += '～' + fmtClock(startMin + Math.round(dwellEnd * factor));
              }
            }
          }
          // If a LATER day's first segment departs from this same
          // waypoint, fold its start time into the pill as a range —
          // "15:20～03:00" reads as "arrived 15:20, leaves 03:00 the
          // next morning" for overnight stays at huts like 排雲山莊.
          for (let nk = dayK + 1; nk < perDay.length; nk++) {
            const nx = perDay[nk];
            const nsegs = nx && nx.segments || [];
            if (!nsegs.length) continue;
            if (nsegs[0].from === name && nx.startTime && /^\d{1,2}:\d{2}$/.test(nx.startTime)) {
              arrivalText = (arrivalText ? arrivalText + '～' : '') + nx.startTime;
              break;
            }
          }

          // Width driven by the wider of (name, time pill).
          ctx.font = '600 10px "Noto Serif TC", serif';
          const nameW = ctx.measureText(name).width;
          ctx.font = '700 10px "JetBrains Mono", monospace';
          const timeW = arrivalText ? (ctx.measureText(arrivalText).width + 8) : 0;
          const widest = Math.max(nameW, timeW);
          const half = widest / 2 + minHGap;

          // Pick the topmost row whose previous label ended before this
          // one's left edge. If all three are still occupied, fall back
          // to whichever one's right edge is leftmost (least overlap).
          let row = 0;
          for (let rr = 0; rr < 3; rr++) {
            if ((cx - half) >= opts._stackLastX[rr]) { row = rr; break; }
            row = rr;
            if (rr === 2) {
              // all rows blocked — choose the freest
              let best = 0;
              for (let kk = 1; kk < 3; kk++) {
                if (opts._stackLastX[kk] < opts._stackLastX[best]) best = kk;
              }
              row = best;
            }
          }
          opts._stackLastX[row] = cx + half;
          const rowBaseY = stackBaseY + row * rowDelta;

          // Vertical guide line from row baseline down to the dot.
          const guideTop = rowBaseY + (arrivalText ? 14 : 2);
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 0.7;
          ctx.strokeStyle = 'rgba(110,83,22,0.45)';
          ctx.beginPath();
          ctx.moveTo(cx, guideTop);
          ctx.lineTo(cx, cy - 5);
          ctx.stroke();
          ctx.setLineDash([]);

          // Draw name (top of stack)
          ctx.font = '600 10px "Noto Serif TC", serif';
          ctx.fillStyle = '#0a1a06';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(name, cx, rowBaseY - 1);

          // Draw arrival time pill below name
          if (arrivalText) {
            ctx.font = '700 10px "JetBrains Mono", monospace';
            const tw = timeW;
            const py = rowBaseY + 2;     // pill top
            const px = cx - tw / 2;
            ctx.fillStyle = 'rgba(253,249,238,0.92)';
            ctx.strokeStyle = 'rgba(168,128,44,0.55)';
            ctx.lineWidth = 0.8;
            if (typeof ctx.roundRect === 'function') {
              ctx.beginPath();
              ctx.roundRect(px, py, tw, 14, 4);
              ctx.fill(); ctx.stroke();
            } else {
              ctx.fillRect(px, py, tw, 14);
              ctx.strokeRect(px, py, tw, 14);
            }
            ctx.fillStyle = '#6e5316';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(arrivalText, cx, py + 7);
            ctx.textBaseline = 'alphabetic';
          }
        });

        // (Per-segment km/elev tags moved off the canvas — the chart
        // now shows them only on hover via an HTML tooltip overlay
        // populated from canvas.__segHitMap, populated below in the
        // zebra-band pass.)
      }
    });

    // ── Zebra-stripe segment bands + hit-map for hover tooltip ────────────
    // Each segment gets a faint vertical band so dense ascent days read
    // as a series of "chapters" rather than a single uninterrupted curve.
    // Alternating tints (paper / sage) within the same day; day-band
    // boundaries already separated by the dashed vertical lines drawn
    // above. The bands are drawn UNDER the curve (below the elevation
    // line and dots) so they don't obscure them — this means we render
    // them by going back to a saved ctx state, then re-drawing the curve
    // and dots on top. Easier alternative: draw bands here at low alpha,
    // accept slight curve dimming. We pick the latter (alpha 0.04).
    const segHitMap = canvas.__segHitMap = [];
    perDay.forEach((d) => {
      if (!Array.isArray(d.segments) || !d.segments.length) return;
      const seenIdx = new Set();
      let zebra = 0;
      d.segments.forEach((s) => {
        const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
        if (ai.length < 2) return;
        const lo = Math.min(ai[0], ai[1]);
        const hi = Math.max(ai[0], ai[1]);
        if (lo < 0 || hi >= d.gpx.length || lo === hi) return;
        // Out-and-back loops revisit the same anchor pair (e.g. 主北岔↔
        // 北峰 traversed twice). Hit-map keeps every visit, but zebra
        // alternation tracks unique segs to avoid same-x stacking issues.
        const x0 = xOf(d, lo);
        const x1 = xOf(d, hi);
        const w = x1 - x0;
        if (w <= 0) return;
        const isAlt = (zebra++) % 2 === 1;
        // Paper / sage alternation at very low alpha — visible enough
        // to chunk the chart, faint enough not to fight the curve.
        ctx.fillStyle = isAlt ? 'rgba(120,140,90,0.06)' : 'rgba(168,128,44,0.05)';
        ctx.fillRect(x0, pad.t, w, gH);
        const asc = +s.ascent_m || 0;
        const desc = +s.descent_m || 0;
        const dist = +s.distance_km || 0;
        const baseMin = +s.base_minutes || 0;
        segHitMap.push({
          x0, x1,
          from: s.from || '',
          to: s.to || '',
          distance_km: dist,
          ascent_m: asc,
          descent_m: desc,
          base_minutes: baseMin,
          day_label: d.label || '',
          is_rest_stop: !!s.is_rest_stop,
        });
      });
    });

    // Day boundary lines + top label band — kept to a fixed 22px header so
    // it doesn't occupy the same vertical strip as the per-checkpoint name
    // + arrival pill stack (which lives at y=27..62 below the band).
    const bandTop = 2, bandH = 22;
    ctx.font = '700 11px "Fraunces", "Noto Serif TC", serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0a1a06';
    perDay.forEach((d, k) => {
      const startX = pad.l + (d.offset / totalDist) * gW;
      const endX = pad.l + ((d.offset + d.len) / totalDist) * gW;
      ctx.fillStyle = (k % 2 === 0) ? 'rgba(30,58,26,0.07)' : 'rgba(168,128,44,0.10)';
      ctx.fillRect(startX, bandTop, endX - startX, bandH);
      ctx.fillStyle = '#0a1a06';
      ctx.textAlign = 'center';
      ctx.fillText(d.label || `Day ${k + 1}`, (startX + endX) / 2, bandTop + 16);
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

    // X-axis distance scale — sits just below the chart now that names
    // moved up to the header strip. Bottom padding (pad.b=22) gives ~14px
    // of clearance for the km labels.
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#7a7468';
    ctx.textAlign = 'left';
    ctx.fillText('0', pad.l, pad.t + gH + 14);
    ctx.textAlign = 'right';
    ctx.fillText((totalDist / 1000).toFixed(1) + ' km', pad.l + gW, pad.t + gH + 14);

    // ── Clickable route-decision markers ──
    // Days that declare route_variants + decision_anchors get a DOM <button>
    // overlay at the fork point so the user can switch routes from inside
    // the chart itself. Mode-toggle.js prepares opts.decisionAnchors with
    // a per-anchor onClick that calls switchRoute(nextVariantId).
    const wrap = canvas.parentElement;
    if (wrap && Array.isArray(opts.decisionAnchors) && opts.decisionAnchors.length) {
      // Clear any previous overview decision markers first so the dataset
      // stays in sync with each redraw (route-switch / focus / resize).
      wrap.querySelectorAll('.elev-overview-decision').forEach(el => el.remove());
      opts.decisionAnchors.forEach(a => {
        const d = perDay[a.dayIdx];
        if (!d) return;
        const idx = a.idx;
        if (typeof idx !== 'number' || idx < 0 || idx >= d.gpx.length) return;
        const xRaw = pad.l + ((d.offset + (d.cd[idx] || 0) - focusStartDist) / focusSpan) * gW;
        // Skip if outside focus window
        if (xRaw < pad.l - 4 || xRaw > pad.l + gW + 4) return;
        const yRaw = pad.t + gH - ((d.gpx[idx][2] - minE) / eRange) * gH;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'elev-overview-decision';
        btn.style.left = xRaw + 'px';
        btn.style.top = yRaw + 'px';
        btn.title = a.title || a.label || '決策點 — 點擊切換路線';
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML =
          `<span class="eod-ring" aria-hidden="true"></span>` +
          (a.label ? `<span class="eod-label">${a.label}</span>` : '');
        if (typeof a.onClick === 'function') {
          btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); a.onClick(ev); });
        }
        wrap.appendChild(btn);
      });
    }
  }

  TF.elevation = {
    stats, draw, drawOverview, applyShanghe, formatHM,
    renderDecisionOverlays,
    _cumDist: cumDist,
  };
})();
