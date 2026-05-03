/* Trailforge plan renderer — v0.1
 * Reads plan data from <script id="plan-data" type="application/json"> (or
 * window.__PLAN__) and renders the day-bar + day-panels into the DOM. The
 * outer scaffolding (tab buttons, contact tab, map tab, elevation chart,
 * pack-split, etc.) stays static for PR-1 — only the per-day content is
 * driven by data so the AI customizer can swap plans without re-templating
 * everything.
 *
 * Public API
 *   TF.render(plan)          — full render
 *   TF.renderDayBar(plan)    — partial
 *   TF.renderDayPanels(plan) — partial
 *   TF.escape(str)           — html escape util
 */
(function () {
  'use strict';

  // IMPORTANT: merge with any TF namespace that other modules (elevation.js,
  // mode-toggle.js) may have already populated. Using `const TF = {}` here and
  // then `window.TF = TF` at the bottom would WIPE TF.elevation / TF.modeToggle.
  const TF = (window.TF = window.TF || {});

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  TF.escape = escapeHtml;

  function attr(s) { return escapeHtml(s); }

  // ---- emergency card ----
  function renderEqCard(day, emergencyDefault) {
    const e = emergencyDefault || {};
    const stb = e.standby || {};
    const callRows = [];
    if (stb.name && stb.phone) {
      callRows.push(
        `<a href="tel:${attr(stb.phone_tel || stb.phone.replace(/[^0-9]/g, ''))}">☎ 留守 ${escapeHtml(stb.name)}<small>${escapeHtml(stb.phone)}</small></a>`
      );
    }
    if (e.messenger_url) {
      callRows.push(`<a class="msg" href="${attr(e.messenger_url)}" target="_blank">💬 Messenger</a>`);
    }
    if (e.include_112 !== false) {
      callRows.push(`<a href="tel:112">📡 112 國際緊急<small>任何網路/無 SIM 皆可</small></a>`);
    }
    if (e.include_119 !== false) {
      callRows.push(`<a href="tel:119">🚑 119<small>${escapeHtml(e.local_emergency_label || '消防')}</small></a>`);
    }

    const keyRows = (day.key_times || []).map(k =>
      `<div class="eq-row"><div class="lb">${escapeHtml(k.label)}</div><div class="vl">${escapeHtml(k.value)}${k.note ? `<small>${escapeHtml(k.note)}</small>` : ''}</div></div>`
    ).join('');

    return `
      <div class="eq-card">
        <h3>${escapeHtml(day.emergency_card_title || '🚨 關鍵時間')}</h3>
        <div class="eq-rows">${keyRows}</div>
        <div class="eq-call">${callRows.join('')}</div>
      </div>`;
  }

  // ---- quick links ----
  function renderQLinks(day) {
    const links = day.quick_links || [];
    if (!links.length) return '';
    return `<div class="qlinks">${
      links.map(l =>
        `<a href="${attr(l.href)}"${l.external ? ' target="_blank"' : ''}>${escapeHtml(l.icon || '')} ${escapeHtml(l.text)}</a>`
      ).join('')
    }</div>`;
  }

  // ---- timeline ----
  function renderTimelineItem(item) {
    const cls = ['tl-i'];
    if (item.highlight) cls.push('hl');
    if (item.decision) cls.push('decision');
    const parts = [`<div class="tl-t">${escapeHtml(item.time || '')}</div>`,
                   `<div class="tl-p">${escapeHtml(item.title || '')}</div>`];
    if (item.elevation) parts.push(`<div class="tl-e">${escapeHtml(item.elevation)}</div>`);
    if (item.note_html) parts.push(`<div class="tl-n">${item.note_html}</div>`);
    else if (item.note) parts.push(`<div class="tl-n">${escapeHtml(item.note)}</div>`);
    if (item.decision_buttons && item.decision_buttons.length) {
      parts.push('<div>' + item.decision_buttons.map(b => {
        const style = [];
        if (b.border) style.push(`border-color:${b.border}`);
        if (b.border_var) style.push(`border-color:var(${b.border_var})`);
        if (b.bg) style.push(`background:${b.bg}`);
        if (b.color) style.push(`color:${b.color}`);
        return `<span class="dec-btn" style="${style.join(';')}" onclick="switchRoute('${attr(b.switch_to)}')">${escapeHtml(b.text)}</span>`;
      }).join('') + '</div>');
    }
    return `<div class="${cls.join(' ')}">${parts.join('')}</div>`;
  }

  function renderTimeline(items) {
    return `<div class="tl">${(items || []).map(renderTimelineItem).join('')}</div>`;
  }

  // ---- routes (Day 2 has 2A/2B variants) ----
  function renderRoutes(day) {
    const routes = day.routes;
    if (!routes || !routes.length) return '';
    const tabs = `<div class="route-tabs">${
      routes.map(r =>
        `<div class="r-tab${r.active ? ' active' : ''}" onclick="switchRoute('${attr(r.id)}')">${escapeHtml(r.tab_label)}</div>`
      ).join('')
    }</div>`;
    const contents = routes.map(r => `
      <div class="route-content${r.active ? ' active' : ''}" id="route-${attr(r.id)}">
        ${r.tag_text ? `<span class="day-tag ${attr(r.tag_class || '')}">${escapeHtml(r.tag_text)}</span>` : ''}
        ${renderTimeline(r.schedule)}
      </div>`).join('');
    return tabs + contents;
  }

  // ---- main schedule section ----
  function renderScheduleSection(day) {
    if (day.routes && day.routes.length) {
      return `
        <div class="section">
          <div class="sec-title">${escapeHtml(day.section_title || '')}</div>
          ${renderRoutes(day)}
        </div>`;
    }
    let tag = '';
    if (day.tag_text) {
      const styleAttr = day.tag_color_override ? ` style="background:${day.tag_color_override};"` : '';
      tag = `<span class="day-tag ${attr(day.tag || 'd1')}"${styleAttr}>${escapeHtml(day.tag_text)}</span>`;
    }
    return `
      <div class="section">
        <div class="sec-title">${escapeHtml(day.section_title || '')}</div>
        ${tag}
        ${renderTimeline(day.schedule)}
      </div>`;
  }

  // ---- expandable details ----
  function renderDetails(day) {
    const details = day.details || [];
    if (!details.length) return '';
    return details.map(d => `
      <details class="exp"${day.details.indexOf(d) === 0 ? ' style="margin-top:10px;"' : ''}>
        <summary>${escapeHtml(d.icon || '')} ${escapeHtml(d.title)}</summary>
        <div class="exp-body">${
          (d.rows_html || []).map(r => /^<(div|p|details|ul|ol|table)/.test(r.trim()) ? r : `<div>${r}</div>`).join('')
        }</div>
      </details>`).join('');
  }

  // ---- retreat section ----
  function renderRetreat(day) {
    const r = day.retreat;
    if (!r) return '';
    const titleStyle = [];
    if (r.title_color) titleStyle.push(`color:${r.title_color}`);
    if (r.title_border) titleStyle.push(`border-bottom-color:${r.title_border}`);
    const items = (r.items_html || []).map(it => {
      if (r.raw_html || /^<div/.test(it.trim())) return it;
      return `<div class="ret-i">${it}</div>`;
    }).join('');
    return `
      <div class="section retreat-section">
        <div class="sec-title" style="${titleStyle.join(';')}">${escapeHtml(r.title || '')}</div>
        ${items}
      </div>`;
  }

  // ---- segment-row HTML + anchor computation (used by elevation pane and
  //      by route-switch updates from mode-toggle.js) ---------------------
  function segmentRowsHTML(segs) {
    return (segs || []).map(s => {
      const ai = Array.isArray(s.anchor_idx) ? s.anchor_idx : [];
      const lo = ai.length === 2 ? Math.min(ai[0], ai[1]) : '';
      const hi = ai.length === 2 ? Math.max(ai[0], ai[1]) : '';
      const baseMin = s.base_minutes || 0;
      const asc = +s.ascent_m || 0;
      const desc = +s.descent_m || 0;
      const elevBits = [];
      if (asc) elevBits.push(`<span class="sl-asc">↑${asc}<small>m</small></span>`);
      if (desc) elevBits.push(`<span class="sl-desc">↓${desc}<small>m</small></span>`);
      if (!elevBits.length) elevBits.push(`<span class="sl-flat">─ 平</span>`);
      const distHtml = s.distance_km != null ? `<span class="sl-km">${(+s.distance_km).toFixed(1)}<small>km</small></span>` : '';
      return `
      <div class="sl-row" role="button" tabindex="0" aria-pressed="false"
              data-segment-id="${attr(s.id || '')}"
              data-focus-start="${attr(String(lo))}"
              data-focus-end="${attr(String(hi))}"
              data-base-min="${baseMin}"
              title="點擊聚焦此段海拔剖面">
        <div class="sl-route">${escapeHtml(s.from || '')}<span class="sl-arrow">→</span>${escapeHtml(s.to || '')}</div>
        <div class="sl-meta">${distHtml}${elevBits.join('')}</div>
        <div class="sl-bar" style="flex-grow:${Math.max(1, baseMin / 30)}"></div>
        <div class="sl-time" data-display="time">
          <span class="sl-time-derived" data-derived>${baseMin}</span><small class="sl-time-unit"> 分</small>
          <span class="sl-time-base" data-base>(基準 ${baseMin} 分)</span>
        </div>
      </div>`;
    }).join('');
  }
  TF.segmentRowsHTML = segmentRowsHTML;

  // Build deduped left-to-right anchor list from a segments array.
  function segmentAnchors(segs) {
    const seenIdx = new Set();
    const anchorPairs = [];
    (segs || []).forEach((s, i) => {
      const candidates = (i === 0)
        ? [{ idx: s.anchor_idx?.[0], lbl: s.from }, { idx: s.anchor_idx?.[1], lbl: s.to }]
        : [{ idx: s.anchor_idx?.[1], lbl: s.to }];
      candidates.forEach(c => {
        if (c.idx != null && !seenIdx.has(c.idx)) {
          seenIdx.add(c.idx);
          anchorPairs.push(c);
        }
      });
    });
    anchorPairs.sort((a, b) => a.idx - b.idx);
    return {
      idx: anchorPairs.map(p => p.idx),
      labels: anchorPairs.map(p => p.lbl),
    };
  }
  TF.segmentAnchors = segmentAnchors;

  // ---- elevation profile section (海拔模式) ----
  // Renders the segmented control + two panes (打卡 / 海拔). For days without
  // `elevation_profile`, returns the schedule section directly (no toggle).
  function renderModeSection(day) {
    const ep = day.elevation_profile;
    const scheduleHtml = renderScheduleSection(day);
    if (!ep || !ep.gpx_ref) return scheduleHtml;  // no toggle for non-hiking days

    const segs = Array.isArray(ep.shanghe_segments) ? ep.shanghe_segments : [];
    const segRows = segmentRowsHTML(segs);

    const totalBase = segs.reduce((acc, s) => acc + (s.base_minutes || 0), 0);
    const totalH = Math.floor(totalBase / 60), totalM = totalBase % 60;
    const totalLabel = totalH > 0 ? `${totalH}h ${totalM}m` : `${totalM} min`;

    // Deduped + sorted anchors for the chart (collapses lollipop revisits).
    const _a = segmentAnchors(segs);
    const anchorIdxStr = JSON.stringify(_a.idx);
    const anchorLblStr = JSON.stringify(_a.labels);

    return `
      <div class="mode-shell" data-day="${attr(day.id)}">
        <div class="mode-panes">
          <div class="mode-pane" data-mode="checkpoint">
            ${scheduleHtml}
          </div>
          <div class="mode-pane" data-mode="elevation">
            <div class="elev-pane">
              <div class="elev-card">
                <div class="elev-head">
                  <span class="eh-l">Elevation Profile</span>
                  <button type="button" class="elev-focus-reset" data-action="reset-focus" title="檢視全段海拔">全段</button>
                  <span class="elev-route-info" data-route-info>${escapeHtml(ep.label || '上河文化步程基準')}</span>
                </div>
                <div class="elev-canvas-wrap">
                  <canvas class="elev-canvas-day"
                          data-gpx-ref="${attr(ep.gpx_ref)}"
                          data-color="${attr(ep.color || '#1e3a1a')}"
                          data-fill="${attr(ep.fill || 'rgba(168,128,44,0.22)')}"
                          data-anchor-idx='${attr(anchorIdxStr)}'
                          data-anchor-labels='${attr(anchorLblStr)}'
                          data-decision-anchors='${attr(JSON.stringify(ep.decision_anchors || []))}'></canvas>
                </div>
                <div class="elev-stats-row" data-stats-for="${attr(ep.gpx_ref)}">
                  <div class="elev-stat"><div class="es-lbl">Distance</div><div class="es-val" data-stat="distance">— km</div></div>
                  <div class="elev-stat"><div class="es-lbl">Ascent</div><div class="es-val" data-stat="ascent">— m</div></div>
                  <div class="elev-stat"><div class="es-lbl">Descent</div><div class="es-val" data-stat="descent">— m</div></div>
                  <div class="elev-stat"><div class="es-lbl">Max Elev</div><div class="es-val" data-stat="max">— m</div></div>
                </div>
                ${segs.length ? `
                <div class="shanghe-block" data-speed-factor="1.00"
                     data-gpx-ref="${attr(ep.gpx_ref)}"
                     data-route-variants='${attr(JSON.stringify(ep.route_variants || null))}'>
                  <div class="sb-head">
                    <div class="sb-title">休息點<span class="sb-en">REST POINTS</span></div>
                    <div class="sb-source">資料來源：上河圖步程 + 他人健行筆記紀錄綜合</div>
                  </div>
                  <div class="speed-control">
                    <label for="speed-${attr(ep.gpx_ref)}" class="sc-lbl">上河速度倍率</label>
                    <input type="number" class="speed-input"
                           id="speed-${attr(ep.gpx_ref)}"
                           min="0.5" max="2.5" step="0.05" value="1.00"
                           data-gpx-ref="${attr(ep.gpx_ref)}"
                           inputmode="decimal" aria-label="上河速度倍率">
                    <span class="sc-x">×</span>
                    <span class="sc-hint">1.0 = 上河基準｜&gt;1 較慢｜&lt;1 較快</span>
                    <span class="sc-warn" title="此倍率目前只更新休息點段落表的衍生時間，出發模式時間軸尚未自動套用">⚠ 出發時間軸暫未連動</span>
                  </div>
                  <div class="shanghe-list" data-list>${segRows}</div>
                  <div class="sl-total">
                    <span class="slt-l">總計</span>
                    <span class="slt-v">
                      <span data-total-derived>${totalLabel}</span>
                      <small data-total-base>基準 ${totalLabel}</small>
                    </span>
                  </div>
                </div>` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // After day panels are inserted into the DOM, fill in stats values for each
  // elevation card and bind toggles. Called by renderDayPanels().
  function hydrateElevation(rootEl) {
    rootEl = rootEl || document;
    if (window.TF && TF.elevation) {
      rootEl.querySelectorAll('.elev-stats-row').forEach(row => {
        const ref = row.dataset.statsFor;
        const data = (window.__JM_GPX__ && window.__JM_GPX__[ref]) || null;
        if (!data) return;
        const s = TF.elevation.stats(data);
        const setVal = (sel, txt) => {
          const el = row.querySelector(`[data-stat="${sel}"]`);
          if (el) el.innerHTML = txt;
        };
        setVal('distance', `${s.distanceKm.toFixed(1)}<small style="font-family:var(--mono);font-size:.6rem;color:var(--ink-soft,#7a7468);"> km</small>`);
        setVal('ascent',   `+${s.ascentM}<small style="font-family:var(--mono);font-size:.6rem;color:var(--ink-soft,#7a7468);"> m</small>`);
        setVal('descent',  `−${s.descentM}<small style="font-family:var(--mono);font-size:.6rem;color:var(--ink-soft,#7a7468);"> m</small>`);
        setVal('max',      `${s.maxElev}<small style="font-family:var(--mono);font-size:.6rem;color:var(--ink-soft,#7a7468);"> m</small>`);
      });
    }
    if (window.TF && TF.modeToggle) {
      TF.modeToggle.init(rootEl);
      // If user persisted mode === 'elevation' from a previous visit, the
      // toggle may have fired refreshAll() before day panels existed in DOM.
      // Re-run it now that canvases are present.
      if (TF.modeToggle.refreshAll) requestAnimationFrame(TF.modeToggle.refreshAll);
    }
  }

  // ---- per-day panel ----
  function renderDayPanel(day, emergencyDefault) {
    return `<div class="day-panel" id="day-${attr(day.id)}">
      <!-- Emergency -->
      ${renderEqCard(day, emergencyDefault)}
      ${renderQLinks(day)}
      ${renderModeSection(day)}
      ${renderDetails(day)}
      ${renderRetreat(day)}
    </div>`;
  }

  // ---- day bar (tab buttons) ----
  function renderDayBar(plan) {
    const bar = document.getElementById('day-bar');
    if (!bar) return;
    const days = plan.days || [];
    bar.innerHTML = days.map(d =>
      `<button class="day-btn" data-day="${attr(d.id)}" onclick="switchDayTab('${attr(d.id)}')"><span class="dlbl">${escapeHtml(d.date_label || '')}</span><span class="dname">${escapeHtml(d.label || '')}</span></button>`
    ).join('');
    // Single-day trips: collapse the day-bar (it's just one tab, no value)
    bar.style.display = (days.length <= 1) ? 'none' : '';
  }
  TF.renderDayBar = renderDayBar;

  // ---- all day panels ----
  function renderDayPanels(plan) {
    const host = document.getElementById('day-panels-host');
    if (!host) return;
    host.innerHTML = (plan.days || [])
      .map(d => renderDayPanel(d, plan.emergency_default))
      .join('');
    hydrateElevation(host);
  }
  TF.renderDayPanels = renderDayPanels;

  // ---- header ----
  function renderHeader(plan) {
    const m = plan.meta || {};
    const h = document.querySelector('.hdr h1');
    const sub = document.querySelector('.hdr .sub');
    if (h && m.title) h.textContent = m.title;
    if (!sub) return;
    const startSlash = m.start_date ? m.start_date.replace(/-/g, '/') : '';
    const endDay = m.end_date ? m.end_date.split('-')[2] : '';
    const range = startSlash && endDay ? `${startSlash}–${endDay}` : startSlash;
    let dur = '';
    if (m.start_date && m.end_date) {
      const days = Math.round((new Date(m.end_date) - new Date(m.start_date)) / 86400000) + 1;
      const nights = Math.max(0, days - 1);
      dur = m.lang === 'en' ? `${days}D${nights}N` : `${days}天${nights}夜`;
    }
    const parts = [range, dur, m.party_label].filter(Boolean);
    sub.textContent = parts.join(' ｜ ');
  }
  TF.renderHeader = renderHeader;

  // ---- entry ----
  function loadPlan() {
    if (window.__PLAN__) return window.__PLAN__;
    const tag = document.getElementById('plan-data');
    if (!tag) return null;
    try { return JSON.parse(tag.textContent); }
    catch (e) { console.error('plan JSON parse error', e); return null; }
  }

  function render(plan) {
    plan = plan || loadPlan();
    if (!plan) { console.warn('TF.render: no plan'); return; }
    // Wrap each render step independently so a partial failure (e.g. a
    // schema mismatch in one day) doesn't blank the entire page — users
    // were reporting only the footer being visible after JS crashes.
    try { renderHeader(plan); }     catch (e) { console.error('renderHeader failed', e); }
    try { renderDayBar(plan); }     catch (e) { console.error('renderDayBar failed', e); }
    try { renderDayPanels(plan); }  catch (e) { console.error('renderDayPanels failed', e); showFallback(e); }
    if (typeof window.lucide !== 'undefined' && lucide.createIcons) {
      try { lucide.createIcons(); } catch (e) {}
    }
  }
  function showFallback(err) {
    const host = document.getElementById('day-panels-host');
    if (!host) return;
    host.innerHTML = `
      <div style="padding:32px 20px; text-align:center; font-family:'Noto Serif TC',serif; color:#7a7468; background:rgba(168,128,44,0.05); border:1px dashed rgba(42,36,24,0.2); border-radius:6px; margin:18px 0;">
        <div style="font-size:1rem; color:#0a1a06; margin-bottom:6px; font-weight:700;">⚠ 計劃書載入錯誤</div>
        <div style="font-size:.82rem; margin-bottom:12px;">資料格式有異常，請重新整理或回報。</div>
        <details style="font-size:.72rem; text-align:left; max-width:480px; margin:0 auto; color:#92400e;"><summary>技術細節</summary><pre style="white-space:pre-wrap; word-break:break-word; padding:8px; background:#fef3c7; border-radius:3px;">${(err && err.stack || String(err)).replace(/</g, '&lt;')}</pre></details>
      </div>`;
  }
  TF.render = render;
  TF.loadPlan = loadPlan;
  // (TF was bound to window.TF up top — no reassignment here.)

  // If URL has ?plan=<id> and we have an access token, fetch from API and
  // re-render once it arrives. Otherwise (or in addition) render the static
  // plan.json baked into <script id="plan-data"> immediately so the page is
  // never blank on first paint.
  function autoRender() {
    const params = new URLSearchParams(location.search);
    const planId = params.get('plan');

    // When ?plan=<id> is present, the user is opening their personal plan.
    // DO NOT first paint the inline 玉山 demo — that causes the "mess up
    // with jade mountain" flash users were reporting. Instead:
    //   1. Try a localStorage-cached copy of this plan for instant paint
    //   2. Otherwise show a loading skeleton
    //   3. Fetch from API; on success replace; on failure show error
    if (planId) {
      const cacheKey = 'tf_plan_cache_' + planId;
      let cached = null;
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) cached = JSON.parse(raw);
      } catch (e) {}
      if (cached && cached.data) {
        window.__PLAN__ = cached.data;
        render(cached.data);
      } else {
        showLoadingSkeleton();
      }
      fetchAndRender(params, planId, cacheKey);
      return;
    }

    // No ?plan= → public demo / first paint with inline 玉山 plan-data.
    render();
  }

  function showLoadingSkeleton() {
    const host = document.getElementById('day-panels-host');
    const bar = document.getElementById('day-bar');
    if (bar) bar.innerHTML = '';
    if (host) {
      host.innerHTML = `
        <div class="tf-skeleton" style="padding:32px 18px; text-align:center; font-family:'Noto Serif TC',serif; color:#6e5316;">
          <div style="width:46px; height:46px; border-radius:50%;
                      background:radial-gradient(circle at 35% 30%, #e8c870, #a8802c 70%);
                      margin:0 auto 14px; opacity:.7;
                      animation:tfPulse 1.6s ease-in-out infinite;"></div>
          <div style="font-size:.86rem; letter-spacing:.18em;">載入計劃書中…</div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:.62rem;
                      letter-spacing:.32em; color:#7a7468; margin-top:6px; text-transform:uppercase;">
            FETCHING FROM API
          </div>
        </div>
        <style>@keyframes tfPulse{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.12);opacity:.9}}</style>`;
    }
  }

  function showApiError(msg) {
    const host = document.getElementById('day-panels-host');
    if (!host) return;
    host.innerHTML = `
      <div style="padding:28px 22px; text-align:center; font-family:'Noto Serif TC',serif; color:#7f1d1d;
                  background:#fef2f2; border:1px solid #fecaca; border-radius:6px; margin:18px 0;">
        <div style="font-size:1rem; font-weight:700; margin-bottom:6px;">⚠ 無法載入計劃書</div>
        <div style="font-size:.82rem; color:#92400e; margin-bottom:14px;">${msg}</div>
        <button onclick="location.reload()" style="appearance:none; cursor:pointer; padding:6px 14px;
                  font-family:'Noto Serif TC',serif; font-size:.78rem; letter-spacing:.16em;
                  background:#1f3a23; color:#f4eddc; border:1px solid #6e5316; border-radius:999px;">
          重新整理
        </button>
      </div>`;
  }

  function fetchAndRender(params, planId, cacheKey) {
    const token = localStorage.getItem('tf_access_token');
    if (!token) {
      showApiError('尚未登入，請先 <a href="auth.html" style="color:#1f3a23;">登入</a> 後再開此計劃。');
      return;
    }
    const apiBase = (params.get('api') || 'https://trailforge-api.fly.dev').replace(/\/+$/, '');
    fetch(apiBase + '/api/plans/' + encodeURIComponent(planId), {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(r => {
      if (r.status === 401) throw new Error('Token 已過期，請重新登入。');
      if (r.status === 404) throw new Error('找不到此計劃書（可能已被刪除或不屬於你）。');
      if (!r.ok) throw new Error('伺服器錯誤 (HTTP ' + r.status + ')');
      return r.json();
    }).then(row => {
      if (!row || !row.data) throw new Error('回應格式不正確（缺 data 欄位）');
      window.__PLAN__ = row.data;
      // Cache for instant paint next time.
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), title: row.title, data: row.data })); } catch (e) {}
      render(row.data);
      if (row.title && document.getElementById('plan-title')) {
        document.getElementById('plan-title').textContent = row.title;
      }
    }).catch(err => {
      // If we already painted from cache, leave that visible — log and bail.
      const host = document.getElementById('day-panels-host');
      const hasContent = host && host.querySelector('.day-panel');
      if (hasContent) {
        console.warn('[trailforge] fetch failed but cache is showing:', err);
        return;
      }
      showApiError(String(err.message || err));
    });
  }

  // Legacy entry retained for compatibility (unused now that autoRender
  // handles the ?plan= flow internally — but kept in case other code calls
  // the old shape).
  function _legacyAutoRender_unused() {
    render();
    try {
      const params = new URLSearchParams(location.search);
      const planId = params.get('plan');
      const token = localStorage.getItem('tf_access_token');
      if (!planId || !token) return;
      const apiBase = (params.get('api') || 'https://trailforge-api.fly.dev').replace(/\/+$/, '');
      fetch(apiBase + '/api/plans/' + encodeURIComponent(planId), {
        headers: { 'Authorization': 'Bearer ' + token },
      }).then(r => {
        if (!r.ok) return null;
        return r.json();
      }).then(row => {
        if (!row || !row.data) return;
        window.__PLAN__ = row.data;
        render(row.data);
        // Update title if available
        if (row.title && document.getElementById('plan-title')) {
          document.getElementById('plan-title').textContent = row.title;
        }
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  if (document.getElementById('day-bar') || document.getElementById('day-panels-host')) {
    autoRender();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoRender);
  } else {
    autoRender();
  }
})();
