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

  const TF = {};

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
      <div class="section">
        <div class="sec-title" style="${titleStyle.join(';')}">${escapeHtml(r.title || '')}</div>
        ${items}
      </div>`;
  }

  // ---- per-day panel ----
  function renderDayPanel(day, emergencyDefault) {
    return `<div class="day-panel" id="day-${attr(day.id)}">
      <!-- Emergency -->
      ${renderEqCard(day, emergencyDefault)}
      ${renderQLinks(day)}
      ${renderScheduleSection(day)}
      ${renderDetails(day)}
      ${renderRetreat(day)}
    </div>`;
  }

  // ---- day bar (tab buttons) ----
  function renderDayBar(plan) {
    const bar = document.getElementById('day-bar');
    if (!bar) return;
    bar.innerHTML = (plan.days || []).map(d =>
      `<button class="day-btn" data-day="${attr(d.id)}" onclick="switchDayTab('${attr(d.id)}')"><span class="dlbl">${escapeHtml(d.date_label || '')}</span><span class="dname">${escapeHtml(d.label || '')}</span></button>`
    ).join('');
  }
  TF.renderDayBar = renderDayBar;

  // ---- all day panels ----
  function renderDayPanels(plan) {
    const host = document.getElementById('day-panels-host');
    if (!host) return;
    host.innerHTML = (plan.days || [])
      .map(d => renderDayPanel(d, plan.emergency_default))
      .join('');
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
    renderHeader(plan);
    renderDayBar(plan);
    renderDayPanels(plan);
    if (typeof window.lucide !== 'undefined' && lucide.createIcons) {
      try { lucide.createIcons(); } catch (e) {}
    }
  }
  TF.render = render;
  TF.loadPlan = loadPlan;

  window.TF = TF;

  // Render synchronously now: this script tag is placed in the body AFTER
  // #day-bar and #day-panels-host, so the containers already exist. We must
  // NOT wait for DOMContentLoaded — the page's own initState IIFE runs as a
  // synchronous inline <script> after this one, and it calls switchDayTab()
  // immediately, which depends on .day-btn / .day-panel existing.
  if (document.getElementById('day-bar') || document.getElementById('day-panels-host')) {
    render();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => render());
  } else {
    render();
  }
})();
