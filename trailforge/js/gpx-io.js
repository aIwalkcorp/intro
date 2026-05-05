/* Trailforge — GPX upload/download (PR-23)
 *
 * Mounts a GPX management strip at the top of the Overview card. Users
 * can upload .gpx files for any of the plan's gpx_refs, see analysis
 * (ascent/descent, ascent-only detection) and download the current
 * track as a GPX file.
 *
 * Storage model — Option A (GPX embedded in plan.data):
 *   plan.data.gpx_tracks[ref] = [[lat, lon, elev], ...]
 *   plan.data.gpx_meta[ref]   = {
 *     filename, uploaded_at, ascent_m, descent_m, ascent_only,
 *     point_count, source: 'upload' | 'default'
 *   }
 *
 * No new backend endpoint needed — we PATCH /api/plans/:id with the
 * full data payload (the same flow edit.js already uses) so the
 * outbox + auth path are reused as-is. Plans without uploaded tracks
 * fall back to the inline window.__JM_GPX__ defaults.
 *
 * Public API
 *   TF.gpxIO.render()          — paint the upload strip into #gpx-io
 *   TF.gpxIO.parse(xmlString)  — return [[lat,lon,elev], ...]
 *   TF.gpxIO.encode(track, opts) — stringify back to GPX XML
 *
 * Depends on: TF.elevation (for stats), edit.js's apiBase + token (we
 * read the same URL params + localStorage to stay in sync).
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});
  const TOKEN_KEY = 'tf_access_token';
  const MAX_POINTS = 800;  // hard cap after simplification (keeps plan JSON < ~80 KB total)
  const ASCENT_ONLY_DESCENT_THRESHOLD = 30;  // metres

  // ─── XML parsing ─────────────────────────────────────────────────────
  // GPX is well-formed XML; DOMParser handles it. We extract every
  // <trkpt lat lon> with optional <ele> child. <rtept> route points are
  // ignored. Returns null on parse failure (caller surfaces a toast).
  function parse(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') return null;
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const pts = [];
    doc.querySelectorAll('trkpt').forEach(node => {
      const lat = parseFloat(node.getAttribute('lat'));
      const lon = parseFloat(node.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const eleNode = node.querySelector('ele');
      const elev = eleNode ? parseFloat(eleNode.textContent) : 0;
      pts.push([lat, lon, Number.isFinite(elev) ? elev : 0]);
    });
    return pts.length ? pts : null;
  }

  // Extract <wpt lat lon><name>...</name><ele>...</ele></wpt> from a GPX
  // doc. Each waypoint becomes {lat, lon, ele, name}. Used by the route-
  // variant chart to replace trkpt slicing with named-anchor straight-
  // line segments — solves the "風口→北峰 went via 主峰" problem when
  // the GPX recording order doesn't match the planned travel order.
  // Returns [] if no named waypoints (still safe to call).
  function parseWaypoints(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') return [];
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const out = [];
    doc.querySelectorAll('wpt').forEach(node => {
      const lat = parseFloat(node.getAttribute('lat'));
      const lon = parseFloat(node.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const nameNode = node.querySelector('name');
      const name = nameNode ? (nameNode.textContent || '').trim() : '';
      if (!name) return;  // unnamed waypoint can't drive anchor matching
      const eleNode = node.querySelector('ele');
      const ele = eleNode ? parseFloat(eleNode.textContent) : NaN;
      out.push({ lat, lon, name, ele: Number.isFinite(ele) ? ele : null });
    });
    return out;
  }

  // ─── Douglas-Peucker simplification ──────────────────────────────────
  // Keep large GPX uploads from bloating plan.data. Operates on the
  // (cumulative-distance, elevation) plane so we preserve the elevation
  // profile shape (the line you'd care about) rather than the lat/lon
  // path. Recursive — fine for <10k points which is well within the
  // size of any realistic 2-day hike.
  function simplifyByElevation(track, targetCount) {
    if (!track || track.length <= targetCount) return track;
    // Compute cumulative distance
    const cum = [0];
    for (let i = 1; i < track.length; i++) {
      const dx = (track[i][0] - track[i-1][0]) * 111000;
      const dy = (track[i][1] - track[i-1][1]) * 111000 * Math.cos(track[i][0] * Math.PI/180);
      cum.push(cum[i-1] + Math.hypot(dx, dy));
    }
    // Iteratively raise epsilon until we hit target count
    let lo = 0.5, hi = 50, kept = track;
    for (let iter = 0; iter < 12; iter++) {
      const mid = (lo + hi) / 2;
      kept = douglasPeucker(track, cum, mid);
      if (kept.length > targetCount) lo = mid;
      else if (kept.length < targetCount * 0.7) hi = mid;
      else break;
    }
    return kept;
  }
  function douglasPeucker(track, cum, eps) {
    const n = track.length;
    if (n <= 2) return track.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n-1] = 1;
    const stack = [[0, n-1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a <= 1) continue;
      // Perpendicular distance in (cum, elev) plane from each pt to line a-b
      const x1 = cum[a], y1 = track[a][2], x2 = cum[b], y2 = track[b][2];
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      let maxD = 0, maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const x0 = cum[i], y0 = track[i][2];
        const d = Math.abs(dx * (y1 - y0) - (x1 - x0) * dy) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > eps && maxI !== -1) {
        keep[maxI] = 1;
        stack.push([a, maxI], [maxI, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(track[i]);
    return out;
  }

  // ─── Track analysis ──────────────────────────────────────────────────
  // Returns { ascent_m, descent_m, ascent_only, point_count }. Uses
  // TF.elevation.stats() if available, falls back to a local calc so
  // gpxIO is testable in isolation.
  function analyse(track) {
    if (!track || !track.length) return null;
    let asc = 0, desc = 0;
    for (let i = 1; i < track.length; i++) {
      const dE = track[i][2] - track[i-1][2];
      if (dE > 0) asc += dE;
      else        desc -= dE;
    }
    return {
      ascent_m: Math.round(asc),
      descent_m: Math.round(desc),
      ascent_only: desc < ASCENT_ONLY_DESCENT_THRESHOLD,
      point_count: track.length,
    };
  }

  // ─── GPX encoding (track → XML string) ───────────────────────────────
  // We produce a minimal but valid GPX 1.1 file with a single <trk>
  // containing one <trkseg>. Elevation is included only when non-zero
  // for at least one point (else GPX consumers may infer it's missing).
  // Filename hint comes from gpx_meta if available.
  function encode(track, opts) {
    opts = opts || {};
    const name = opts.name || 'trailforge-track';
    const desc = opts.desc || 'Exported by Trailforge';
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Trailforge" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${escapeXml(name)}</name><desc>${escapeXml(desc)}</desc></metadata>`,
      `  <trk><name>${escapeXml(name)}</name><trkseg>`,
    ];
    track.forEach(p => {
      lines.push(`    <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"><ele>${(p[2] || 0).toFixed(1)}</ele></trkpt>`);
    });
    lines.push('  </trkseg></trk>', '</gpx>', '');
    return lines.join('\n');
  }
  function escapeXml(s) {
    return String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({
      '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;',
    }[c]));
  }

  // ─── Plan I/O ────────────────────────────────────────────────────────
  function getPlan() {
    if (window.__PLAN__) return window.__PLAN__;
    // Static mode: render.js's loadPlan() parses #plan-data fresh each
    // call. We need a stable reference so our mutations stick — promote
    // it to window.__PLAN__ on first read so all subsequent reads (and
    // mode-toggle/overview) see the same object.
    const p = (TF.loadPlan && TF.loadPlan()) || null;
    if (p) window.__PLAN__ = p;
    return p;
  }
  // Read effective track for a ref: plan.data first, then inline default
  function effectiveTrack(ref) {
    const plan = getPlan();
    const fromPlan = plan && plan.data && plan.data.gpx_tracks && plan.data.gpx_tracks[ref];
    if (Array.isArray(fromPlan) && fromPlan.length) return { track: fromPlan, source: 'upload' };
    const fromInline = (window.__JM_GPX__ || {})[ref];
    if (Array.isArray(fromInline) && fromInline.length) return { track: fromInline, source: 'default' };
    return { track: null, source: 'none' };
  }
  function effectiveMeta(ref) {
    const plan = getPlan();
    return (plan && plan.data && plan.data.gpx_meta && plan.data.gpx_meta[ref]) || null;
  }

  // Hard cap on total GPX slots per plan. Day-derived refs count toward
  // this. Beyond it, the "+ 新增" button is hidden.
  const MAX_REFS = 10;

  // Collect refs to display. Two sources:
  //   1. Day-derived refs from plan.days[].elevation_profile.gpx_ref —
  //      these are wired to the elevation chart and cannot be removed.
  //   2. Custom refs found in plan.data.gpx_tracks (or top-level
  //      gpx_tracks in static-demo shape) that aren't already covered
  //      by (1) — user-added slots, removable.
  function collectRefs() {
    const plan = getPlan();
    if (!plan) return [];
    const days = (plan.data && Array.isArray(plan.data.days))
      ? plan.data.days
      : (Array.isArray(plan.days) ? plan.days : []);
    const seen = new Set();
    const refs = [];
    days.forEach(d => {
      const ep = d.elevation_profile;
      if (!ep || !ep.gpx_ref || seen.has(ep.gpx_ref)) return;
      seen.add(ep.gpx_ref);
      refs.push({
        ref: ep.gpx_ref,
        dayId: d.id,
        dayLabel: d.label || ('Day ' + d.id),
        kind: 'day',
      });
    });
    // Custom (user-added) refs — read from whichever shape stores them
    const dataRoot = plan.data || plan;
    const extra = dataRoot.gpx_tracks || {};
    Object.keys(extra).forEach(key => {
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({
        ref: key,
        dayId: '_',
        dayLabel: '自訂',
        kind: 'custom',
      });
    });
    return refs;
  }

  // Generate a unique ref name (extra-1, extra-2, …) for a new slot.
  function nextCustomRef() {
    const used = new Set(collectRefs().map(r => r.ref));
    for (let i = 1; i <= MAX_REFS; i++) {
      const name = 'extra-' + i;
      if (!used.has(name)) return name;
    }
    return null;
  }

  // ─── Local-storage fallback ─────────────────────────────────────────
  // Used when:
  //   - No auth (public demo mode) — survives reloads on this device
  //   - Backend rejects the PATCH (e.g. schema rejects gpx_tracks key)
  // Key shape: tf_gpx_local::<planId-or-static> — versioned per plan
  // so different plans don't collide. We store the WHOLE map (not per
  // ref) so a single read on rehydrate covers everything.
  function localKey() {
    const params = new URLSearchParams(location.search);
    const planId = params.get('plan') || 'static';
    return 'tf_gpx_local::' + planId;
  }
  function saveLocal(plan) {
    try {
      const payload = {
        gpx_tracks:    plan.data.gpx_tracks    || {},
        gpx_meta:      plan.data.gpx_meta      || {},
        gpx_waypoints: plan.data.gpx_waypoints || {},
        saved_at: new Date().toISOString(),
      };
      localStorage.setItem(localKey(), JSON.stringify(payload));
      return true;
    } catch (e) {
      console.warn('[gpx-io] localStorage write failed:', e);
      return false;
    }
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(localKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ─── PATCH the plan back to backend (with localStorage fallback) ────
  // Strategy:
  //   1. Try PATCH /api/plans/:id with full plan.data (same flow edit.js
  //      uses — outbox-aware, offline-queues automatically).
  //   2. If no auth (public demo) OR backend rejects (4xx — typically
  //      means schema doesn't allow gpx_tracks key), fall back to
  //      localStorage. Survives reloads on this device but doesn't
  //      sync across devices.
  //   3. If network fails entirely, outbox already queued it — caller
  //      surfaces "已暫存（離線）" toast.
  // Returns: { ok, persisted, queued, source: 'cloud'|'local'|'none', status, reason }
  async function persist(ref, track, meta, waypoints) {
    const plan = getPlan();
    if (!plan) return { ok: false, reason: 'no-plan' };
    plan.data = plan.data || {};
    plan.data.gpx_tracks    = plan.data.gpx_tracks    || {};
    plan.data.gpx_meta      = plan.data.gpx_meta      || {};
    plan.data.gpx_waypoints = plan.data.gpx_waypoints || {};
    plan.data.gpx_tracks[ref] = track;
    plan.data.gpx_meta[ref]   = meta;
    if (Array.isArray(waypoints) && waypoints.length) {
      plan.data.gpx_waypoints[ref] = waypoints;
      window.__JM_GPX_WAYPOINTS__ = window.__JM_GPX_WAYPOINTS__ || {};
      window.__JM_GPX_WAYPOINTS__[ref] = waypoints;
    } else if (plan.data.gpx_waypoints[ref]) {
      // Empty upload — clear any stale waypoints for this ref
      delete plan.data.gpx_waypoints[ref];
      if (window.__JM_GPX_WAYPOINTS__) delete window.__JM_GPX_WAYPOINTS__[ref];
    }
    // Update inline cache so chart redraws immediately read it
    window.__JM_GPX__ = window.__JM_GPX__ || {};
    window.__JM_GPX__[ref] = track;

    const params = new URLSearchParams(location.search);
    const planId = params.get('plan');
    const token = localStorage.getItem(TOKEN_KEY);

    // No auth / static demo → localStorage only
    if (!planId || !token) {
      const saved = saveLocal(plan);
      return { ok: true, persisted: saved, source: 'local', reason: 'no-auth' };
    }

    const apiBase = (params.get('api') || 'https://trailforge-api.fly.dev').replace(/\/+$/, '');
    const url = apiBase + '/api/plans/' + encodeURIComponent(planId);
    const body = JSON.stringify({ data: plan.data });
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

    console.log('[gpx-io] PATCH', url, 'gpx_tracks keys:', Object.keys(plan.data.gpx_tracks));

    try {
      // Prefer outbox (offline-safe); fall back to direct fetch.
      let result;
      if (window.TF_OUTBOX && window.TF_OUTBOX.send) {
        result = await window.TF_OUTBOX.send(url, { method: 'PATCH', headers, body, label: 'PATCH /api/plans/:id (gpx)' });
      } else {
        const r = await fetch(url, { method: 'PATCH', headers, body });
        result = { ok: r.ok, status: r.status, queued: false };
      }
      console.log('[gpx-io] PATCH result:', result);

      if (result.ok) {
        // Cloud succeeded — also mirror to localStorage as cache so
        // rehydrate is instant on next reload (before API responds).
        saveLocal(plan);
        return { ok: true, persisted: true, source: 'cloud', queued: result.queued, status: result.status };
      }

      // Outbox queued (offline) — already persisted in IndexedDB,
      // mirror to localStorage too so we paint correctly on reload
      if (result.queued) {
        saveLocal(plan);
        return { ok: true, persisted: true, source: 'cloud', queued: true };
      }

      // 4xx/5xx — backend rejected. Fall back to localStorage so the
      // user's work isn't lost.
      const saved = saveLocal(plan);
      return {
        ok: saved,
        persisted: saved,
        source: 'local',
        status: result.status,
        reason: 'backend-rejected',
      };
    } catch (e) {
      console.warn('[gpx-io] PATCH threw:', e);
      const saved = saveLocal(plan);
      return { ok: saved, persisted: saved, source: 'local', reason: 'network', error: e.message };
    }
  }

  // ─── UI render ───────────────────────────────────────────────────────
  function render() {
    const host = document.getElementById('gpx-io');
    if (!host) return;
    const refs = collectRefs();
    // Always render the strip (even with zero day-derived refs) so the
    // user can add custom GPX slots from scratch.
    const canAddMore = refs.length < MAX_REFS;

    const rowsHtml = refs.map(r => {
      const { track, source } = effectiveTrack(r.ref);
      const meta = effectiveMeta(r.ref);
      const stats = track ? analyse(track) : null;
      const hasTrack = !!track;
      const isUploaded = source === 'upload';
      // Distinguish cloud-synced vs. local-only uploads — meta.source
      // is set to 'upload' for both, but if the plan has a planId in
      // the URL AND we have a token, we assume cloud sync succeeded
      // (any later PATCH failure falls back to local + we re-render).
      // Simpler signal: read meta.persistence (we set it below).
      const persistence = meta && meta.persistence;  // 'cloud' | 'local' | undefined
      const filename = (meta && meta.filename) || `${r.ref}-default.gpx`;
      const sourceChip = !hasTrack
        ? `<span class="gx-chip gx-chip-empty">無資料</span>`
        : !isUploaded
          ? `<span class="gx-chip gx-chip-default">本地預設</span>`
          : persistence === 'local'
            ? `<span class="gx-chip gx-chip-localonly" title="後端拒絕或未登入；資料儲存於此瀏覽器">僅存本機</span>`
            : `<span class="gx-chip gx-chip-cloud">雲端同步</span>`;
      const ascentOnlyBadge = stats && stats.ascent_only
        ? `<span class="gx-badge" title="偵測到只有上升、幾乎沒有下降——下山將以原路折返計算">偵測為純上行 · 下山以原路折返</span>`
        : '';
      const statsLine = stats
        ? `<span class="gx-stats">
             <span class="gx-stat-asc">↑${stats.ascent_m}<small>m</small></span>
             <span class="gx-stat-desc">↓${stats.descent_m}<small>m</small></span>
             <span class="gx-stat-pts">${stats.point_count}<small>點</small></span>
             ${ascentOnlyBadge}
           </span>`
        : `<span class="gx-stats gx-stats-empty">尚未上傳</span>`;
      const deleteBtn = r.kind === 'custom'
        ? `<button type="button" class="gx-btn gx-btn-delete" data-action="delete" data-ref="${r.ref}" title="刪除此 GPX">✕</button>`
        : '';
      const dayChipLabel = r.kind === 'custom' ? '＋' : (r.dayId || '').toUpperCase();
      const dayChipClass = r.kind === 'custom' ? 'gx-day-custom' : `gx-day-${r.dayId}`;
      return `<div class="gx-row gx-row-${r.kind}" data-ref="${r.ref}">
        <div class="gx-row-l">
          <span class="gx-day-chip ${dayChipClass}">${dayChipLabel}</span>
          <span class="gx-ref-name">${r.ref}</span>
          ${sourceChip}
          <span class="gx-filename">${filename}</span>
        </div>
        <div class="gx-row-m">${statsLine}</div>
        <div class="gx-row-r">
          <button type="button" class="gx-btn gx-btn-upload" data-action="upload" data-ref="${r.ref}">
            <span class="gx-btn-i">⬆</span> 上傳 .gpx
          </button>
          <button type="button" class="gx-btn gx-btn-download" data-action="download" data-ref="${r.ref}" ${hasTrack ? '' : 'disabled'}>
            <span class="gx-btn-i">⬇</span> 下載
          </button>
          ${deleteBtn}
        </div>
      </div>`;
    }).join('');

    const addRowHtml = canAddMore
      ? `<div class="gx-row gx-row-add">
           <button type="button" class="gx-btn gx-btn-add" data-action="add-ref">
             <span class="gx-btn-i">＋</span> 新增 GPX 軌跡（${refs.length}/${MAX_REFS}）
           </button>
         </div>`
      : `<div class="gx-row gx-row-add gx-row-add-full">
           <span class="gx-add-full-msg">已達上限 ${MAX_REFS} 個軌跡</span>
         </div>`;

    host.innerHTML = `
      <div class="gx-head">
        <div class="gx-title">GPX 軌跡<span class="gx-title-en">TRACKS</span></div>
        <div class="gx-hint">上傳 .gpx 檔覆蓋預設軌跡；資料儲存於計劃書，會自動同步至雲端（最多 ${MAX_REFS} 個）</div>
      </div>
      <div class="gx-list">${rowsHtml}${addRowHtml}</div>
      <input type="file" id="gpx-file-input" accept=".gpx,application/gpx+xml,text/xml" style="display:none;">
    `;

    bindActions(host);
  }

  function bindActions(host) {
    if (host.__bound) return;
    host.__bound = true;
    const fileInput = host.querySelector('#gpx-file-input');
    let pendingRef = null;

    host.addEventListener('click', (e) => {
      const btn = e.target.closest('button.gx-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const ref = btn.dataset.ref;
      if (action === 'upload') {
        pendingRef = ref;
        fileInput.value = '';  // allow re-uploading same filename
        fileInput.click();
      } else if (action === 'download') {
        downloadGpx(ref);
      } else if (action === 'add-ref') {
        const newRef = nextCustomRef();
        if (!newRef) { toast(`已達上限 ${MAX_REFS} 個軌跡`, 'err'); return; }
        pendingRef = newRef;
        fileInput.value = '';
        fileInput.click();
      } else if (action === 'delete') {
        if (!confirm(`刪除 GPX「${ref}」？此動作會同步至雲端。`)) return;
        deleteRef(ref);
      }
    });

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f || !pendingRef) return;
      await handleUpload(pendingRef, f);
      pendingRef = null;
    });
  }

  // Delete a custom (user-added) ref and persist via the same path as
  // upload. Day-derived refs are never offered a delete button so we
  // assume `ref` here is custom.
  async function deleteRef(ref) {
    const plan = getPlan();
    if (!plan) return;
    plan.data = plan.data || {};
    plan.data.gpx_tracks    = plan.data.gpx_tracks    || {};
    plan.data.gpx_meta      = plan.data.gpx_meta      || {};
    plan.data.gpx_waypoints = plan.data.gpx_waypoints || {};
    delete plan.data.gpx_tracks[ref];
    delete plan.data.gpx_meta[ref];
    delete plan.data.gpx_waypoints[ref];
    if (window.__JM_GPX__) delete window.__JM_GPX__[ref];
    if (window.__JM_GPX_WAYPOINTS__) delete window.__JM_GPX_WAYPOINTS__[ref];

    const params = new URLSearchParams(location.search);
    const planId = params.get('plan');
    const token = localStorage.getItem(TOKEN_KEY);

    if (!planId || !token) {
      saveLocal(plan);
      render();
      if (TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll();
      if (TF.overview && TF.overview.render) TF.overview.render();
      toast(`已刪除「${ref}」（僅本機，未登入）`);
      return;
    }

    const apiBase = (params.get('api') || 'https://trailforge-api.fly.dev').replace(/\/+$/, '');
    const url = apiBase + '/api/plans/' + encodeURIComponent(planId);
    const body = JSON.stringify({ data: plan.data });
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    try {
      let result;
      if (window.TF_OUTBOX && window.TF_OUTBOX.send) {
        result = await window.TF_OUTBOX.send(url, { method: 'PATCH', headers, body, label: 'PATCH /api/plans/:id (gpx delete)' });
      } else {
        const r = await fetch(url, { method: 'PATCH', headers, body });
        result = { ok: r.ok, status: r.status, queued: false };
      }
      saveLocal(plan);  // mirror in case reload happens before sync settles
      render();
      if (TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll();
      if (TF.overview && TF.overview.render) TF.overview.render();
      if (result.queued) toast(`已刪除「${ref}」（離線暫存，上線後同步）`);
      else if (result.ok) toast(`已刪除「${ref}」`);
      else toast(`刪除失敗：HTTP ${result.status}`, 'err');
    } catch (e) {
      saveLocal(plan);
      render();
      if (TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll();
      toast(`刪除失敗：${e.message}`, 'err');
    }
  }

  async function handleUpload(ref, file) {
    const row = document.querySelector(`.gx-row[data-ref="${ref}"]`);
    setRowStatus(row, '解析中…');
    let text;
    try { text = await file.text(); }
    catch (e) { setRowStatus(row, '讀檔失敗', 'err'); return; }

    let track = parse(text);
    if (!track) { setRowStatus(row, '不是有效的 GPX 檔', 'err'); return; }

    if (track.length > MAX_POINTS) {
      const before = track.length;
      track = simplifyByElevation(track, MAX_POINTS);
      console.log(`[gpx-io] simplified ${before} → ${track.length} points for ref ${ref}`);
    }

    // Pull any <wpt name="...">s — these become anchor points for
    // route-variant charts, where they replace error-prone trkpt slicing.
    const waypoints = parseWaypoints(text);
    if (waypoints.length) {
      console.log(`[gpx-io] found ${waypoints.length} named waypoints for ref ${ref}`);
    }

    const stats = analyse(track);
    const meta = {
      filename: file.name,
      uploaded_at: new Date().toISOString(),
      ascent_m: stats.ascent_m,
      descent_m: stats.descent_m,
      ascent_only: stats.ascent_only,
      point_count: stats.point_count,
      waypoint_count: waypoints.length,
      source: 'upload',
    };

    setRowStatus(row, '上傳中…');
    const result = await persist(ref, track, meta, waypoints);

    // Stamp persistence flag onto plan.data.gpx_meta so the UI chip
    // reflects whether this track is on the server or local-only.
    const plan = getPlan();
    if (plan && plan.data && plan.data.gpx_meta && plan.data.gpx_meta[ref]) {
      plan.data.gpx_meta[ref].persistence = result.source || 'local';
      // Also persist this updated meta to localStorage so reloads keep
      // the chip accurate without another PATCH.
      saveLocal(plan);
    }

    // Re-render strip (reflects new meta + chip) and the chart
    render();
    if (TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll();
    if (TF.overview && TF.overview.render) TF.overview.render();

    if (!result.ok) {
      toast(`上傳失敗：${result.reason || result.status || 'unknown'}`, 'err');
    } else if (result.queued) {
      toast(`已暫存（離線）：上線後會自動同步至雲端`);
    } else if (result.source === 'local') {
      if (result.reason === 'backend-rejected') {
        toast(`已儲存於本機（雲端拒絕：HTTP ${result.status}）`, 'err');
      } else if (result.reason === 'no-auth') {
        toast(`已儲存於本機（未登入時無法同步至雲端）`);
      } else {
        toast(`已儲存於本機（網路問題，稍後重試）`);
      }
    } else {
      toast(`已上傳並同步至雲端：${file.name}`);
    }
  }

  function downloadGpx(ref) {
    const { track } = effectiveTrack(ref);
    if (!track) return;
    const meta = effectiveMeta(ref);
    const name = (meta && meta.filename && meta.filename.replace(/\.gpx$/i, '')) || `trailforge-${ref}`;
    const xml = encode(track, { name, desc: `Trailforge ${ref}` });
    const blob = new Blob([xml], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.gpx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function setRowStatus(row, msg, kind) {
    if (!row) return;
    const m = row.querySelector('.gx-row-m');
    if (!m) return;
    m.innerHTML = `<span class="gx-status${kind === 'err' ? ' gx-status-err' : ''}">${msg}</span>`;
  }

  function toast(msg, kind) {
    let t = document.getElementById('gx-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gx-toast';
      t.className = 'gx-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle('gx-toast-err', kind === 'err');
    t.classList.add('show');
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  TF.gpxIO = { render, parse, parseWaypoints, encode, analyse, simplifyByElevation };

  // Rehydrate __JM_GPX__ on boot so any tracks the user uploaded in a
  // previous session override the inline defaults BEFORE elevation/
  // mode-toggle do their first paint. Two sources, in order:
  //   1. plan.data.gpx_tracks — the cloud-synced copy (lands once API
  //      response arrives in API mode, or already present from inline
  //      <script id="plan-data"> in static mode)
  //   2. localStorage tf_gpx_local::<planId> — fallback when backend
  //      rejected the PATCH or user wasn't authenticated. Merged INTO
  //      plan.data so subsequent PATCHes (e.g. once schema is fixed)
  //      include the local tracks too.
  function rehydrateFromPlan() {
    const plan = getPlan();
    if (!plan) return;
    plan.data = plan.data || {};

    // (1) cloud copy — already in plan.data, just mirror to __JM_GPX__
    //     and __JM_GPX_WAYPOINTS__.
    const cloud = plan.data.gpx_tracks;
    const cloudWp = plan.data.gpx_waypoints;
    window.__JM_GPX__ = window.__JM_GPX__ || {};
    window.__JM_GPX_WAYPOINTS__ = window.__JM_GPX_WAYPOINTS__ || {};
    if (cloud) {
      Object.keys(cloud).forEach(ref => {
        if (Array.isArray(cloud[ref]) && cloud[ref].length) {
          window.__JM_GPX__[ref] = cloud[ref];
        }
      });
    }
    if (cloudWp) {
      Object.keys(cloudWp).forEach(ref => {
        if (Array.isArray(cloudWp[ref]) && cloudWp[ref].length) {
          window.__JM_GPX_WAYPOINTS__[ref] = cloudWp[ref];
        }
      });
    }

    // (2) local fallback — merge any refs not already in cloud
    const local = loadLocal();
    if (local && local.gpx_tracks) {
      plan.data.gpx_tracks    = plan.data.gpx_tracks    || {};
      plan.data.gpx_meta      = plan.data.gpx_meta      || {};
      plan.data.gpx_waypoints = plan.data.gpx_waypoints || {};
      Object.keys(local.gpx_tracks).forEach(ref => {
        const arr = local.gpx_tracks[ref];
        if (!Array.isArray(arr) || !arr.length) return;
        // Only fill if cloud doesn't already have it (cloud wins on
        // conflict — assume server is authoritative once it responds)
        if (!plan.data.gpx_tracks[ref]) {
          plan.data.gpx_tracks[ref] = arr;
          window.__JM_GPX__[ref] = arr;
        }
        if (local.gpx_meta && local.gpx_meta[ref] && !plan.data.gpx_meta[ref]) {
          plan.data.gpx_meta[ref] = local.gpx_meta[ref];
        }
      });
      if (local.gpx_waypoints) {
        Object.keys(local.gpx_waypoints).forEach(ref => {
          const wp = local.gpx_waypoints[ref];
          if (!Array.isArray(wp) || !wp.length) return;
          if (!plan.data.gpx_waypoints[ref]) {
            plan.data.gpx_waypoints[ref] = wp;
            window.__JM_GPX_WAYPOINTS__[ref] = wp;
          }
        });
      }
    }
  }
  // Run rehydrate immediately (synchronously) — gpx-io.js is loaded
  // after edit.js + outbox.js but BEFORE manifest-dynamic.js, and the
  // elevation/mode-toggle scripts above us only do their first paint
  // on DOMContentLoaded, so this lands in time.
  rehydrateFromPlan();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    requestAnimationFrame(render);
  }
})();
