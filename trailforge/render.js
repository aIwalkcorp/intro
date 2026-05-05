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

  // ─── derived-schedule machinery ───────────────────────────────────────
  // The view-mode timeline is now generated entirely from the rest-points
  // editor's data: per-day start_time + segments[base_minutes / from / to /
  // note] × the global speed factor. day.schedule[] is kept only for
  // first-time MIGRATION (its notes get copied into segment.note before any
  // render pulls from it), then ignored.
  function readSpeedFactor() {
    try {
      const v = parseFloat(localStorage.getItem('jm_overview_speed'));
      if (Number.isFinite(v) && v >= 0.5 && v <= 2.5) return v;
    } catch (e) {}
    return 1;
  }
  function fmtClockMin(totalMin) {
    const t = ((totalMin % 1440) + 1440) % 1440;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  function buildItemsFromSegments(segs, startMin, factor) {
    if (!Array.isArray(segs) || !segs.length || startMin == null) return null;
    const items = [];
    items.push({
      time: fmtClockMin(startMin),
      title: segs[0].from || '起登',
      note: null,
      highlight: false,
    });
    let cum = 0;
    segs.forEach((s, i) => {
      const baseMin = +s.base_minutes || 0;
      cum += baseMin;
      items.push({
        time: fmtClockMin(startMin + Math.round(cum * factor)),
        title: s.to || '',
        note: s.note || null,
        highlight: i === segs.length - 1,
      });
    });
    return items;
  }
  // One-shot migration: if a segment has no note but a schedule item with the
  // same endpoint name has one, copy it. Runs at every render but is a no-op
  // once segments carry their own notes.
  function migrateScheduleNotesToSegments(day) {
    const ep = day && day.elevation_profile;
    if (!ep) return;
    const stripHtml = (h) => {
      const t = document.createElement('div');
      t.innerHTML = String(h || '');
      return (t.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const matchNote = (sched, name) => {
      if (!Array.isArray(sched) || !name) return null;
      const hit = sched.find(it => {
        const title = String(it.title || '').trim();
        return title === name || title.indexOf(name) >= 0;
      });
      if (!hit) return null;
      if (hit.note) return hit.note;
      if (hit.note_html) return stripHtml(hit.note_html);
      return null;
    };
    const fillSegs = (segs, sched) => {
      (segs || []).forEach(s => {
        if (s.note) return;
        const fromName = matchNote(sched, s.to) || matchNote(sched, s.from);
        if (fromName) s.note = fromName;
      });
    };
    fillSegs(ep.shanghe_segments, day.schedule);
    if (ep.route_variants && Array.isArray(day.routes)) {
      day.routes.forEach(r => {
        const variant = ep.route_variants[r.id];
        if (variant) fillSegs(variant.shanghe_segments, r.schedule);
      });
    }
  }
  // Compute derived items for a day (or for a specific route variant).
  function deriveScheduleForDay(day) {
    const ep = day && day.elevation_profile;
    if (!ep) return null;
    const start = ep.start_time;
    if (!/^\d{1,2}:\d{2}$/.test(String(start || ''))) return null;
    const [sh, sm] = start.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const factor = readSpeedFactor();
    return buildItemsFromSegments(ep.shanghe_segments, startMin, factor);
  }
  function deriveScheduleForRoute(day, route) {
    const ep = day && day.elevation_profile;
    if (!ep || !ep.route_variants) return null;
    const variant = ep.route_variants[route && route.id];
    if (!variant) return null;
    const start = ep.start_time;
    if (!/^\d{1,2}:\d{2}$/.test(String(start || ''))) return null;
    const [sh, sm] = start.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const factor = readSpeedFactor();
    return buildItemsFromSegments(variant.shanghe_segments, startMin, factor);
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
    // Try derived schedule per route — use it when start_time + segments
    // exist; fall back to r.schedule otherwise.
    const derivedByRoute = {};
    routes.forEach(r => {
      const items = deriveScheduleForRoute(day, r);
      if (items) derivedByRoute[r.id] = items;
    });
    const tabs = `<div class="route-tabs">${
      routes.map(r =>
        `<div class="r-tab${r.active ? ' active' : ''}" onclick="switchRoute('${attr(r.id)}')">${escapeHtml(r.tab_label)}</div>`
      ).join('')
    }</div>`;
    const contents = routes.map(r => {
      const items = derivedByRoute[r.id] || r.schedule || [];
      return `
        <div class="route-content${r.active ? ' active' : ''}" id="route-${attr(r.id)}">
          ${r.tag_text ? `<span class="day-tag ${attr(r.tag_class || '')}">${escapeHtml(r.tag_text)}</span>` : ''}
          ${renderTimeline(items)}
        </div>`;
    }).join('');
    return tabs + contents;
  }

  // ---- main schedule section ----
  function renderScheduleSection(day) {
    // Migrate legacy schedule notes into segment.note BEFORE the first
    // derive — one-shot, idempotent. Lets the demo's "12:00 白木林觀景台
    // (午餐行動糧 30 分鐘)" surface as the segment's 備註 in both edit and
    // view modes without the user having to re-type anything.
    migrateScheduleNotesToSegments(day);

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
    // Prefer derived items when start_time + segments exist; legacy
    // day.schedule[] is fallback only (and after migration, even its notes
    // have already been pulled into segments).
    const items = deriveScheduleForDay(day) || day.schedule || [];
    return `
      <div class="section">
        <div class="sec-title">${escapeHtml(day.section_title || '')}</div>
        ${tag}
        ${renderTimeline(items)}
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

  // ---- elevation profile section ----
  // PR-22: Per-day elevation card removed. The unified Elevation Profile +
  // Rest Points list now live in the Overview card at the top of itin tab
  // (rendered by js/overview.js, only visible in 規劃模式). The day-panel
  // keeps only its schedule timeline for View mode; planning mode hides
  // everything except the day-notes block (CSS — see index.html § PLANNING
  // / EDIT MODE).
  function renderModeSection(day) {
    return renderScheduleSection(day);
  }

  // After day panels are inserted, kick the global Overview renderer (for
  // 規劃模式 elevation chart + unified rest-points list at the top of the
  // itin tab). modeToggle.refreshAll() will redraw everything; overview.js
  // hooks the same refresh cycle so it stays in sync with route variants.
  function hydrateElevation(rootEl) {
    rootEl = rootEl || document;
    if (window.TF && TF.modeToggle) {
      TF.modeToggle.init(rootEl);
      if (TF.modeToggle.refreshAll) requestAnimationFrame(TF.modeToggle.refreshAll);
    }
    if (window.TF && TF.overview && TF.overview.render) {
      requestAnimationFrame(TF.overview.render);
    }
    // gpx-io re-renders after plan arrives from API so the strip
    // reflects gpx_meta/gpx_tracks fetched from the backend.
    if (window.TF && TF.gpxIO && TF.gpxIO.render) {
      requestAnimationFrame(TF.gpxIO.render);
    }
  }

  // ---- planning-mode notes block ----
  // A free-form day-notes editor surfaced ONLY in elevation/edit mode (CSS
  // toggles visibility). Each day gets its own notes block — header (day
  // label) + N note cards (icon + title + plain-text body + N hyperlinks)
  // + "add note" button. Body text is contenteditable=plaintext-only and
  // persists to localStorage under jm_notes_<dayId>; the cloud-sync
  // placeholder lives in the header (locked until login — handled in
  // index.html).
  //
  // Initial seed: any day.details items become starter notes (icon, title,
  // body flattened to plain text, AND <a href> links extracted from
  // rows_html into a structured links array). User edits override the seed.
  // The 20 climbing-relevant emoji palette is picked here too.
  function renderNotes(day) {
    // Seed: collect ALL links across day.details rows_html into one
    // day-level link list (chips render once per day, above the notes).
    // Note cards keep only icon + title + body (no per-note links).
    const dayLinks = [];
    const seenHref = new Set();
    (day.quick_links || []).forEach(L => {
      const href = L.href || '';
      if (!href || seenHref.has(href)) return;
      seenHref.add(href);
      dayLinks.push({ href, label: L.text || L.label || href });
    });
    (day.details || []).forEach(d => {
      (d.rows_html || []).forEach(r => extractLinks(r).forEach(L => {
        if (!seenHref.has(L.href)) { seenHref.add(L.href); dayLinks.push(L); }
      }));
    });

    const seed = (day.details || []).map((d, i) => ({
      id: `${day.id}-note-${i}`,
      icon: d.icon || '📝',
      title: d.title || '',
      body: (d.rows_html || []).map(r => stripHtml(r)).join('\n'),
    }));
    const dateLine = day.date_label || '';
    const dayName  = day.label || ('Day ' + day.id);
    return `<div class="day-notes" data-day-id="${attr(day.id)}">
      <div class="dn-head">
        <div class="dn-head-l">
          <span class="dn-day">${escapeHtml(dayName)}</span>
          <span class="dn-date">${escapeHtml(dateLine)}</span>
        </div>
      </div>

      <!-- Links section (above notes) — one chip set per day. -->
      <div class="dn-section">
        <div class="dn-section-head">
          <span class="dn-section-l">🔗 連結</span>
          <button type="button" class="dn-link-add" data-day-id="${attr(day.id)}" aria-label="新增連結">+ 連結</button>
        </div>
        <div class="dn-links" data-day-id="${attr(day.id)}">${
          dayLinks.map(L => renderLinkChip(L)).join('')
        }</div>
      </div>

      <!-- Notes section. -->
      <div class="dn-section">
        <div class="dn-section-head">
          <span class="dn-section-l">📝 備註</span>
          <button type="button" class="dn-add" data-day-id="${attr(day.id)}" aria-label="新增備註">+ 備註</button>
        </div>
        <div class="dn-list" data-day-id="${attr(day.id)}">${
          seed.map(n => renderNoteCard(n)).join('')
        }</div>
      </div>
    </div>`;
  }
  function renderNoteCard(n) {
    return `<div class="dn-card" data-note-id="${attr(n.id)}">
      <button type="button" class="dn-icon" data-note-id="${attr(n.id)}" aria-label="選擇圖示">${escapeHtml(n.icon)}</button>
      <div class="dn-body-wrap">
        <div class="dn-title" contenteditable="plaintext-only" data-field="title" data-note-id="${attr(n.id)}" spellcheck="false">${escapeHtml(n.title)}</div>
        <div class="dn-body" contenteditable="plaintext-only" data-field="body" data-note-id="${attr(n.id)}" spellcheck="false">${escapeHtml(n.body)}</div>
      </div>
      <button type="button" class="dn-del" data-note-id="${attr(n.id)}" aria-label="刪除備註">×</button>
    </div>`;
  }
  function renderLinkChip(L) {
    const icon = inferLinkIcon(L.href);
    return `<a class="dn-link" href="${attr(L.href)}" target="_blank" rel="noopener noreferrer" data-href="${attr(L.href)}">
      <span class="dn-link-ic">${icon}</span>
      <span class="dn-link-lbl">${escapeHtml(L.label || L.href)}</span>
      <button type="button" class="dn-link-del" aria-label="刪除連結">×</button>
    </a>`;
  }
  function inferLinkIcon(href) {
    const h = String(href || '').toLowerCase();
    if (h.startsWith('tel:'))     return '📞';
    if (h.startsWith('mailto:'))  return '✉️';
    if (h.includes('maps.google') || h.includes('goo.gl/maps') || h.includes('share.google')) return '🗺';
    if (h.includes('cwa.gov') || h.includes('weather'))         return '🌦';
    if (h.includes('youtube') || h.includes('youtu.be'))         return '📹';
    return '🔗';
  }
  function extractLinks(html) {
    if (!html) return [];
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html);
    return [...tmp.querySelectorAll('a[href]')].map(a => ({
      href: a.getAttribute('href') || '',
      label: (a.textContent || '').trim() || a.getAttribute('href') || '',
    }));
  }
  function stripHtml(s) {
    if (!s) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = String(s);
    return (tmp.textContent || '').trim();
  }
  TF.renderNotes = renderNotes;
  TF.renderNoteCard = renderNoteCard;
  TF.renderLinkChip = renderLinkChip;
  TF.inferLinkIcon = inferLinkIcon;

  // ---- per-day panel ----
  function renderDayPanel(day, emergencyDefault) {
    // Surface the day id (D0/D1/D2) as a data attribute so planning-mode CSS
    // can render a small gutter label on each band.
    const labelText = (day.id || '').toUpperCase();
    return `<div class="day-panel" id="day-${attr(day.id)}" data-day-label="${attr(labelText)}">
      <!-- Emergency -->
      ${renderEqCard(day, emergencyDefault)}
      ${renderQLinks(day)}
      ${renderModeSection(day)}
      ${renderDetails(day)}
      ${renderRetreat(day)}
      ${renderNotes(day)}
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
    // Range string includes depart_date if present (e.g. 4/17 出發 → 4/19),
    // otherwise just start–end. Format: "4/17–4/19" if depart differs from
    // start, else "2026/4/18–19".
    let range = '';
    if (m.depart_date && m.start_date && m.depart_date !== m.start_date) {
      const departSlash = m.depart_date.replace(/-/g, '/');
      const endSlash = m.end_date ? m.end_date.replace(/-/g, '/') : '';
      range = endSlash ? `${departSlash}–${endSlash.split('/').slice(-1)[0]}` : departSlash;
    } else {
      range = startSlash && endDay ? `${startSlash}–${endDay}` : startSlash;
    }
    let dur = '';
    if (m.start_date && m.end_date) {
      // Hiking days: start_date → end_date (inclusive count).
      const hikingDays = Math.round((new Date(m.end_date) - new Date(m.start_date)) / 86400000) + 1;
      // Nights: from depart_date if present (counts the pre-trail lodging
      // night too, so 4/17 出發 + 4/18 山屋 = 2 nights), else hikingDays-1.
      const nightsFrom = m.depart_date || m.start_date;
      const nights = Math.max(0, Math.round((new Date(m.end_date) - new Date(nightsFrom)) / 86400000));
      dur = m.lang === 'en' ? `${hikingDays}D${nights}N` : `${hikingDays}天${nights}夜`;
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
    window.__PLAN__ = plan;
    try { document.dispatchEvent(new CustomEvent('tf:plan-loaded', { detail: { plan } })); } catch(e){}
    // Wrap each render step independently so a partial failure (e.g. a
    // schema mismatch in one day) doesn't blank the entire page — users
    // were reporting only the footer being visible after JS crashes.
    try { renderHeader(plan); }     catch (e) { console.error('renderHeader failed', e); }
    try { renderDayBar(plan); }     catch (e) { console.error('renderDayBar failed', e); }
    try { renderDayPanels(plan); }  catch (e) { console.error('renderDayPanels failed', e); showFallback(e); }
    // Activate a day panel. The bootstrap in index.html calls switchDayTab('d0')
    // before personal-plan panels exist in the DOM (autoRender → fetchAndRender
    // is async), and personal plans may not have a 'd0' (e.g. single-day trips
    // that start at id 'd1'). Pick saved-day if it still matches an existing
    // panel, otherwise fall back to the first day in the plan.
    try {
      if (typeof window.switchDayTab === 'function') {
        const days = plan.days || [];
        if (days.length) {
          let savedDay = null;
          try { savedDay = localStorage.getItem('jm_day'); } catch (e) {}
          const valid = savedDay && days.some(d => d.id === savedDay);
          window.switchDayTab(valid ? savedDay : days[0].id, false);
        }
      }
    } catch (e) { console.error('post-render switchDayTab failed', e); }
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

  // PWA standalone mode = "frozen offline app per plan". Once the plan has
  // been fetched once into localStorage[tf_pwa_frozen_<id>], we never refetch
  // on subsequent launches — users explicitly tap a 同步/refresh action to
  // pull a new copy. This makes each installed PWA behave like a downloaded
  // offline map, immune to network flakiness or unexpected reconnects.
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }
  function frozenKey(id) { return 'tf_pwa_frozen_' + id; }
  function readFrozen(id) {
    try { const raw = localStorage.getItem(frozenKey(id)); if (raw) return JSON.parse(raw); }
    catch (e) {}
    return null;
  }
  function writeFrozen(id, title, data) {
    try { localStorage.setItem(frozenKey(id), JSON.stringify({ at: Date.now(), title, data })); }
    catch (e) {}
  }
  function clearFrozen(id) {
    try { localStorage.removeItem(frozenKey(id)); } catch (e) {}
  }
  // Expose so the "強制更新" button can wipe + reload.
  window.TF = window.TF || {};
  window.TF.refreshFrozen = function (planId) {
    if (!planId) {
      const p = new URLSearchParams(location.search).get('plan');
      if (p) planId = p;
    }
    if (planId) clearFrozen(planId);
    // strip any ?refresh=1 remnant before reload to avoid loops
    const u = new URL(location.href);
    u.searchParams.delete('refresh');
    location.replace(u.toString());
  };

  function autoRender() {
    const params = new URLSearchParams(location.search);
    const planId = params.get('plan');
    const wantsRefresh = params.get('refresh') === '1';

    // When ?plan=<id> is present, the user is opening their personal plan.
    // DO NOT first paint the inline 玉山 demo — that causes the "mess up
    // with jade mountain" flash users were reporting.
    if (planId) {
      const cacheKey = 'tf_plan_cache_' + planId;
      const standalone = isStandalone();

      // Manual "force refresh" path: drop the frozen snapshot and proceed to
      // a normal fetch. Triggered by the 同步 chip in PWA mode.
      if (wantsRefresh) clearFrozen(planId);

      // ── PWA frozen-snapshot path ──
      // Standalone + frozen exists → render frozen, NEVER touch the network.
      // This is the primary "offline app per plan" behavior the user asked
      // for — once installed, the plan is locked at install-time content.
      if (standalone && !wantsRefresh) {
        const frozen = readFrozen(planId);
        if (frozen && frozen.data) {
          window.__PLAN__ = frozen.data;
          render(frozen.data);
          if (frozen.title && document.getElementById('plan-title')) {
            document.getElementById('plan-title').textContent = frozen.title;
          }
          return;   // skip the fetch entirely
        }
        // First standalone launch → fall through to fetch + freeze.
      }

      // ── Normal browser / first PWA launch path ──
      // 1. Paint cached data if any (instant)
      // 2. Fetch from API; on success replace + (in PWA) freeze
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
      fetchAndRender(params, planId, cacheKey, { freezeAfter: standalone });
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

  function fetchAndRender(params, planId, cacheKey, opts) {
    const o = opts || {};
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
      // Freeze for PWA standalone mode — locks the snapshot until user taps 同步.
      if (o.freezeAfter) writeFrozen(planId, row.title, row.data);
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
