/* Trailforge — plan → .docx exporter
 *
 * Maps the in-memory plan structure (the same one render.js consumes) onto
 * a Word document that mirrors the 7-table 登山活動計劃書 layout shown in
 * 奇萊南華0210.docx. Fields the plan doesn't yet model (predoubtedly:
 * 預算明細, 活動費用, some 分工 angles) get printed as `____________` so
 * the user can fill them in by hand after download.
 *
 * Public API:
 *   TF.docx.exportPlan(plan)  → triggers a browser download of plan.docx
 *
 * Loads docx-js (window.docx) lazily via CDN on first use so the initial
 * page paint stays small. Subsequent calls are immediate.
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  // docx-js 9.x dropped UMD; only 8.x ships a browser-loadable bundle.
  // Bundled locally (./js/vendor/docx-8.5.0.umd.js) so the export works
  // offline / inside PWA / on networks that block jsdelivr & unpkg —
  // the previous "CDN-only" loader broke for users behind firewalls
  // and inside the standalone PWA shell where cross-origin script
  // imports don't go through the SW. CDN URLs kept as last-resort
  // fallbacks in case the local bundle is missing for some reason.
  const DOCX_LOCAL = './js/vendor/docx-8.5.0.umd.js';
  const DOCX_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
    'https://unpkg.com/docx@8.5.0/build/index.umd.js',
  ];

  function loadOneScript(src, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      // Same-origin scripts: leave crossOrigin unset so the SW can
      // intercept normally. CDN fallbacks need anonymous CORS.
      if (opts.crossOrigin) s.crossOrigin = opts.crossOrigin;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  function loadDocxLib() {
    if (window.docx) return Promise.resolve(window.docx);
    if (window.__tfDocxLoading) return window.__tfDocxLoading;
    window.__tfDocxLoading = (async () => {
      let lastErr = null;
      // 1) Local bundle first — works offline + PWA + corporate networks.
      try {
        await loadOneScript(DOCX_LOCAL);
        if (window.docx) return window.docx;
        lastErr = new Error('local bundle ran but window.docx undefined');
      } catch (e) { lastErr = e; }
      // 2) CDN fallbacks (only reached if the local bundle is missing).
      for (const url of DOCX_CDN_URLS) {
        try {
          await loadOneScript(url, { crossOrigin: 'anonymous' });
          if (window.docx) return window.docx;
          lastErr = new Error('script ran but window.docx still undefined: ' + url);
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('all docx sources failed');
    })();
    return window.__tfDocxLoading;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  const BLANK = '____________';
  // Capture groups required — dayCheckpoints() reads m[1]/m[2] to compute
  // startMin. The earlier `/^\d{1,2}:\d{2}$/` form had no parens, so
  // m[1]+m[2] were undefined → +undefined = NaN → every time printed
  // as "NaN:NaN" in the 行程/時間 row.
  const HM_RE = /^(\d{1,2}):(\d{2})$/;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoToROC(iso) {
    if (!iso) return BLANK;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return `中華民國${(+m[1]) - 1911}年${+m[2]}月${+m[3]}日`;
  }
  function dayCount(meta) {
    if (!meta || !meta.start_date || !meta.end_date) return BLANK;
    const ms = new Date(meta.end_date) - new Date(meta.start_date);
    return String(Math.round(ms / 86400000) + 1);
  }
  function membersByRole(plan, role) {
    const ms = (plan.contacts && plan.contacts.members) || [];
    return ms.filter(m => m && m.role === role);
  }
  function fmtMin(min) {
    if (!min || min < 0) return '0m';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? `${h}h${m ? pad2(m) + 'm' : ''}` : `${m}m`;
  }
  function dayCheckpoints(day) {
    // Produce {names: [], times: []} for the 行程 / 時間 rows of table 2.
    const ep = day.elevation_profile || {};
    const variant = (ep.route_variants
      ? ep.route_variants[ep.default_variant || Object.keys(ep.route_variants)[0]]
      : null);
    const segs = (variant && variant.shanghe_segments) || ep.shanghe_segments || [];
    if (!segs.length) return { names: [], times: [], totalMin: 0, totalKm: 0, asc: 0, desc: 0 };
    const startStr = (variant && variant.start_time) || ep.start_time || '';
    const m = HM_RE.exec(startStr);
    let cum = 0;
    const startMin = m ? (+m[1]) * 60 + (+m[2]) : null;
    const names = [];
    const times = [];
    if (segs[0].from) {
      names.push(segs[0].from);
      times.push(startMin != null ? `${pad2(Math.floor(startMin / 60) % 24)}:${pad2(startMin % 60)}` : BLANK);
    }
    let totalKm = 0, asc = 0, desc = 0;
    for (const s of segs) {
      cum += (+s.base_minutes || 0);
      totalKm += +s.distance_km || 0;
      asc  += +s.ascent_m  || 0;
      desc += +s.descent_m || 0;
      const tMin = startMin != null ? startMin + cum : null;
      names.push(s.to || '');
      times.push(tMin != null ? `${pad2(Math.floor(tMin / 60) % 24)}:${pad2(tMin % 60)}` : BLANK);
    }
    return { names, times, totalMin: cum, totalKm, asc, desc };
  }
  function findEmergencyValue(plan, label) {
    const arr = (plan.contacts && plan.contacts.emergency) || [];
    const hit = arr.find(e => e && e.label === label);
    if (hit) return hit.value || BLANK;
    // Fallback: first day's key_times
    for (const d of (plan.days || [])) {
      const kt = (d.key_times || []).find(k => k && k.label && k.label.includes(label));
      if (kt) return kt.value || BLANK;
    }
    return BLANK;
  }
  function htmlToText(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
  }

  // ─── builders ─────────────────────────────────────────────────────────────
  function build(plan) {
    const D = window.docx;
    const meta = plan.meta || {};

    const cellBorder = { style: D.BorderStyle.SINGLE, size: 4, color: '888888' };
    const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
    const cellMargins = { top: 80, bottom: 80, left: 100, right: 100 };

    function cell(text, opts = {}) {
      const runs = (Array.isArray(text) ? text : [text]).map(t => new D.TextRun(typeof t === 'string' ? { text: t } : t));
      return new D.TableCell({
        borders,
        width: opts.width ? { size: opts.width, type: D.WidthType.DXA } : undefined,
        shading: opts.shade ? { fill: opts.shade, type: D.ShadingType.CLEAR } : undefined,
        margins: cellMargins,
        columnSpan: opts.span,
        verticalAlign: D.VerticalAlign.CENTER,
        children: [new D.Paragraph({ alignment: opts.align || D.AlignmentType.LEFT, children: runs })],
      });
    }
    function labelCell(t, w) { return cell(t, { width: w, shade: 'F0E6D2', align: D.AlignmentType.CENTER }); }
    function valueCell(t, w) { return cell(t, { width: w }); }
    function row(cells) { return new D.TableRow({ children: cells }); }

    const sections = [];

    // ── Title ───────────────────────────────────────────────────────────────
    sections.push(new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new D.TextRun({ text: '登山活動計劃書', bold: true, size: 36 })],
    }));

    // ── Table 1: 活動概覽 (matches 奇萊 template's 7-row layout) ────────────
    // Differences from old layout:
    //   • 留守人員 + 留守電話 split onto two rows (not packed into one row)
    //   • 參加人數 sits next to 留守電話 (not next to 活動地點)
    //   • 活動地點 is its own full-width row at the bottom (label + value
    //     spanning 3 cols), matching the 奇萊 template's R6.
    const TBL_W = 9000;
    const COL = TBL_W / 4;
    const leader = membersByRole(plan, '領隊')[0] || {};
    const guide  = membersByRole(plan, '嚮導')[0] || {};
    const standby = (plan.emergency_default && plan.emergency_default.standby) || {};
    const standbyName = standby.name || (membersByRole(plan, '留守')[0] || {}).name || BLANK;
    const standbyPhone = standby.phone || (membersByRole(plan, '留守')[0] || {}).phone || BLANK;
    const tbl1Rows = [
      row([labelCell('活動名稱', COL), valueCell(meta.title || BLANK, COL),
           labelCell('活動日期', COL),
           cell(`自${isoToROC(meta.start_date)}起\n至${isoToROC(meta.end_date)}止\n共計 ${dayCount(meta)} 天`, { width: COL })]),
      row([labelCell('領    隊', COL), valueCell(leader.name || BLANK, COL),
           labelCell('嚮    導', COL), valueCell(guide.name || BLANK, COL)]),
      row([labelCell('領隊電話', COL), valueCell(leader.phone || BLANK, COL),
           labelCell('活動費用', COL), valueCell(BLANK, COL)]),
      row([labelCell('留守人員', COL), valueCell(standbyName, COL),
           cell('', { width: COL }), cell('', { width: COL })]),
      row([labelCell('留守電話', COL), valueCell(standbyPhone, COL),
           labelCell('參加人數', COL), valueCell(String(meta.party_size || BLANK), COL)]),
      row([labelCell('山難管制時間', COL), valueCell(findEmergencyValue(plan, '山難管制'), COL),
           labelCell('下山通知時間', COL), valueCell(findEmergencyValue(plan, '下山通知'), COL)]),
      row([labelCell('活動地點', COL),
           cell(meta.subtitle || meta.title || BLANK, { width: COL * 3, span: 3 })]),
    ];
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: [COL, COL, COL, COL],
      rows: tbl1Rows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 120 }, children: [] }));

    // ── Reference URL paragraphs (離線地圖 / 行程資料 / 路線參考) ───────────
    // Pulled from quick_links across all days; deduped. The template
    // had hand-typed reference blocks; we surface plan.days[].quick_links
    // here so the docx doesn't lose useful URLs the user entered in the
    // app.
    const seenLinks = new Set();
    const linkBlocks = [];
    for (const d of (plan.days || [])) {
      for (const ql of (d.quick_links || [])) {
        if (!ql || !ql.href || seenLinks.has(ql.href)) continue;
        seenLinks.add(ql.href);
        linkBlocks.push({ label: ql.text || '參考連結', url: ql.href });
      }
    }
    if (linkBlocks.length) {
      sections.push(new D.Paragraph({
        spacing: { before: 80, after: 40 },
        children: [new D.TextRun({ text: '參考資料：', bold: true })],
      }));
      for (const lb of linkBlocks) {
        sections.push(new D.Paragraph({
          spacing: { after: 30 },
          indent: { left: 360 },
          children: [new D.TextRun({ text: `${lb.label}：${lb.url}`, size: 20 })],
        }));
      }
    }

    // ── Table 2: 活動行程表 (one combined table, all days) ─────────────────
    // 奇萊 template uses ONE big itinerary table with header rows (trip
    // info + dates) followed by per-day blocks (行程 / 時間 / detail+
    // 總計), then 建議休息點 + 備註 + 撤退方案 footer rows. Replaces the
    // previous "one separate table per day" layout that broke up the
    // schedule visually.
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '活動行程表', bold: true, size: 28 })],
    }));
    const itinW = [COL * 0.85, COL * 0.55, COL * 2.6];
    const itinRows = [];
    // header — trip info + filler row (matches template R0/R1)
    itinRows.push(row([
      labelCell('活動名稱', itinW[0]),
      cell(meta.title || BLANK, { width: itinW[1] + itinW[2], span: 2 }),
    ]));
    itinRows.push(row([
      labelCell('活動日期', itinW[0]),
      cell(`${isoToROC(meta.start_date)} 起\n${isoToROC(meta.end_date)} 止`, { width: itinW[1], span: 1 }),
      cell(`填表人：${leader.name || BLANK}    頁次：1 頁`, { width: itinW[2] }),
    ]));
    // per-day blocks
    let allRetreats = [];
    for (const d of (plan.days || [])) {
      const cps = dayCheckpoints(d);
      const dateStr = (d.date_label || d.date || '').replace(/\s+/g, '');
      const dayLabelStr = `${d.label || d.id}\n${dateStr}`;
      itinRows.push(row([
        labelCell(dayLabelStr, itinW[0]),
        labelCell('行程', itinW[1]),
        cell(cps.names.length ? cps.names.join(' → ') : BLANK, { width: itinW[2] }),
      ]));
      itinRows.push(row([
        cell('', { width: itinW[0] }),
        labelCell('時間', itinW[1]),
        cell(cps.times.length ? cps.times.join('　') : BLANK, { width: itinW[2] }),
      ]));
      const statBits = [];
      if (cps.totalMin) statBits.push(`總時長 ${fmtMin(cps.totalMin)}`);
      if (cps.totalKm)  statBits.push(`距離 ${cps.totalKm.toFixed(1)} K`);
      if (cps.asc)      statBits.push(`上升 ${cps.asc}M`);
      if (cps.desc)     statBits.push(`下降 ${cps.desc}M`);
      itinRows.push(row([
        cell('', { width: itinW[0] }),
        labelCell('總計', itinW[1]),
        cell(statBits.length ? statBits.join('　') : BLANK, { width: itinW[2] }),
      ]));
      if (d.retreat) {
        const items = Array.isArray(d.retreat.items_html) ? d.retreat.items_html.map(htmlToText)
          : Array.isArray(d.retreat.items) ? d.retreat.items
          : [];
        for (const it of items) {
          if (it && it.trim()) allRetreats.push(`${d.label || d.id}：${it.trim()}`);
        }
      }
    }
    // Footer rows — 建議休息點 / 備註 / 撤退方案 (template R8-R10)
    itinRows.push(row([
      labelCell('建議休息點', itinW[0]),
      cell('小休點：依現場狀況　大休點：用餐／補水時段', { width: itinW[1] + itinW[2], span: 2 }),
    ]));
    itinRows.push(row([
      labelCell('備　註', itinW[0]),
      cell('==> 表示乘車　→ 表示重裝　--> 表示輕裝', { width: itinW[1] + itinW[2], span: 2 }),
    ]));
    itinRows.push(row([
      labelCell('撤退方案', itinW[0]),
      cell(allRetreats.length ? allRetreats.join('\n') : BLANK,
           { width: itinW[1] + itinW[2], span: 2 }),
    ]));
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: itinW.map(Math.round),
      rows: itinRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 100 }, children: [] }));

    // ── Table 3: 注意事項 (single-cell with key_times excerpts) ────────────
    const keyTimesParts = [];
    for (const d of (plan.days || [])) {
      for (const kt of (d.key_times || [])) {
        if (!kt || !kt.value) continue;
        keyTimesParts.push(`${d.label || d.id} ${kt.label || ''} ${kt.value}${kt.note ? ' ('+kt.note+')' : ''}`);
      }
    }
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: [TBL_W],
      rows: [row([cell('注意事項：' + (keyTimesParts.length ? '\n' + keyTimesParts.join('\n') : BLANK),
                      { width: TBL_W })])],
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── 工作分配 (2 rows × 5 cols, 1-10 numbered list per template) ────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '工作分配', bold: true, size: 28 })],
    }));
    const ROLES_NUM = ['嚮導', '交通', '裝備', '行政', '回報', '醫療', '天氣', '紀錄', '留守', '保險'];
    const roleW = TBL_W / 5;
    const roleRows = [];
    for (let r = 0; r < 2; r++) {
      const cells = [];
      for (let c = 0; c < 5; c++) {
        const idx = r * 5 + c;
        const role = ROLES_NUM[idx];
        const names = role === '留守'
          ? standbyName
          : (membersByRole(plan, role).map(m => m.name).filter(Boolean).join('、') || BLANK);
        cells.push(cell(`${idx + 1}. ${role}：${names}`, { width: roleW }));
      }
      roleRows.push(row(cells));
    }
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: [roleW, roleW, roleW, roleW, roleW].map(Math.round),
      rows: roleRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 120 }, children: [] }));

    // ── Standard intro paragraphs (留守 / 領隊 / 通訊 / 編制) ──────────────
    const introBlocks = [
      ['留守人員注意事項：', [
        '隊伍出發後，注意隊伍回報並作記錄，即使無收到消息也要寫留守紀錄。',
        '隊伍出隊前到下山期間須保持聯繫。',
        '過了山難管制時間仍無消息時，通知留守、安全中心召集人。',
      ]],
      ['領隊注意事項：', [
        '請定期回報隊伍行進狀況。',
        '隊伍歸來後，請領隊於下山通知時間內通知留守人解除留守。',
      ]],
      ['通訊內容：', [
        '人員狀況（身體、心理）',
        '路徑狀況',
        '天氣',
        '幾點到哪裡，休多久（當日最後紮營處）',
        '未來計畫',
      ]],
      ['隊伍編制：', [
        '兩個嚮導，一個前嚮一個後嚮，整隊速度會以最慢的那位為基準。',
      ]],
    ];
    for (const [title, lines] of introBlocks) {
      sections.push(new D.Paragraph({
        spacing: { before: 100, after: 40 },
        children: [new D.TextRun({ text: title, bold: true })],
      }));
      for (const line of lines) {
        sections.push(new D.Paragraph({
          spacing: { after: 20 },
          indent: { left: 360 },
          children: [new D.TextRun({ text: line, size: 20 })],
        }));
      }
    }

    // ── 人員名單 ────────────────────────────────────────────────────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 80 },
      children: [new D.TextRun({ text: '人員名單', bold: true, size: 28 })],
    }));
    const memberW = [COL * 0.55, COL * 0.65, COL * 0.85, COL * 0.7, COL * 0.65, COL * 0.6];
    const memberRows = [
      row([
        labelCell('職稱', memberW[0]), labelCell('姓名', memberW[1]),
        labelCell('身分證字號', memberW[2]), labelCell('連絡電話', memberW[3]),
        labelCell('緊急聯絡人', memberW[4]), labelCell('緊急連絡人電話', memberW[5]),
      ]),
    ];
    const members = (plan.contacts && plan.contacts.members) || [];
    for (const m of members) {
      memberRows.push(row([
        valueCell(m.role || BLANK, memberW[0]),
        valueCell(m.name || BLANK, memberW[1]),
        valueCell(m.id_no || BLANK, memberW[2]),
        valueCell(m.phone || BLANK, memberW[3]),
        valueCell(m.ec_name || BLANK, memberW[4]),
        valueCell(m.ec_phone || BLANK, memberW[5]),
      ]));
    }
    if (members.length === 0) memberRows.push(row(memberW.map(w => valueCell(BLANK, w))));
    sections.push(new D.Table({
      width: { size: memberW.reduce((a,b)=>a+b,0), type: D.WidthType.DXA },
      columnWidths: memberW.map(Math.round),
      rows: memberRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── 個人裝備 (gear checklist) — render in 2 cols x N rows from plan ────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 60 },
      children: [new D.TextRun({ text: '個人裝備', bold: true, size: 28 })],
    }));
    sections.push(new D.Paragraph({
      spacing: { after: 80 },
      children: [new D.TextRun({ text: '（◎ 必帶　○ 可帶可不帶）', size: 20 })],
    }));
    const gearItems = (plan.gear && Array.isArray(plan.gear.checklist)) ? plan.gear.checklist : [];
    // Lay out as a 4-col table: name | ✓, name | ✓.
    const gearW = [COL * 1.4, COL * 0.4, COL * 1.4, COL * 0.4];
    const gearRows = [
      row([
        labelCell('品名', gearW[0]), labelCell('帶／未帶', gearW[1]),
        labelCell('品名', gearW[2]), labelCell('帶／未帶', gearW[3]),
      ]),
    ];
    if (gearItems.length === 0) {
      // 8 blank rows so user can fill in by hand
      for (let i = 0; i < 8; i++) {
        gearRows.push(row([
          valueCell(BLANK, gearW[0]), valueCell('', gearW[1]),
          valueCell(BLANK, gearW[2]), valueCell('', gearW[3]),
        ]));
      }
    } else {
      for (let i = 0; i < gearItems.length; i += 2) {
        const left = gearItems[i] || '';
        const right = gearItems[i + 1] || '';
        gearRows.push(row([
          valueCell(left || BLANK, gearW[0]), valueCell('', gearW[1]),
          valueCell(right || BLANK, gearW[2]), valueCell('', gearW[3]),
        ]));
      }
    }
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: gearW.map(Math.round),
      rows: gearRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── 活動經費預算 (budget) ──────────────────────────────────────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 80 },
      children: [new D.TextRun({ text: '活動經費預算', bold: true, size: 28 })],
    }));
    const budgetW = [COL * 1.3, COL * 0.6, COL * 0.5, COL * 0.7, COL * 0.9];
    const budgetRows = [];
    // Top header (matches 奇萊 R0/R1): trip info above the 支出 columns.
    budgetRows.push(row([
      labelCell('活動名稱', budgetW[0]),
      cell(meta.title || BLANK, { width: budgetW[1] + budgetW[2], span: 2 }),
      labelCell('活動人數', budgetW[3]),
      cell(`共 ${meta.party_size || BLANK} 人`, { width: budgetW[4] }),
    ]));
    budgetRows.push(row([
      labelCell('活動日期', budgetW[0]),
      cell(`${isoToROC(meta.start_date)} 起 ~ ${isoToROC(meta.end_date)} 止`,
           { width: budgetW[1] + budgetW[2] + budgetW[3] + budgetW[4], span: 4 }),
    ]));
    budgetRows.push(row([
      labelCell('項目', budgetW[0]), labelCell('單價(元/人)', budgetW[1]),
      labelCell('數量', budgetW[2]), labelCell('總價(元)', budgetW[3]),
      labelCell('說明', budgetW[4]),
    ]));
    const budget = plan.budget || { items: [] };
    const items = Array.isArray(budget.items) ? budget.items : [];
    if (items.length === 0) {
      for (let i = 0; i < 6; i++) {
        budgetRows.push(row(budgetW.map(w => valueCell(BLANK, w))));
      }
    } else {
      for (const it of items) {
        budgetRows.push(row([
          valueCell(it.category || '', budgetW[0]),
          valueCell(it.unit_price != null ? String(it.unit_price) : '', budgetW[1]),
          valueCell(it.quantity != null ? String(it.quantity) : '', budgetW[2]),
          valueCell(it.total != null ? String(it.total) : '', budgetW[3]),
          valueCell(it.note || '', budgetW[4]),
        ]));
      }
    }
    // Subtotal row
    budgetRows.push(row([
      labelCell('小計(元)', budgetW[0]),
      cell('', { width: budgetW[1] + budgetW[2] + budgetW[3] + budgetW[4], span: 4 }),
    ]));
    // Footnote row
    budgetRows.push(row([
      cell('☆：詳列活動預算時應包含：(1)交通費；(2)保險費；(3)食材；(4)門票／入山證；(5)雜項。',
           { width: TBL_W, span: 5 }),
    ]));
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: budgetW.map(Math.round),
      rows: budgetRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── 緊急聯絡單位 (national emergency phones — fixed list) ──────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 80 },
      children: [new D.TextRun({ text: '緊急聯絡單位', bold: true, size: 28 })],
    }));
    sections.push(new D.Paragraph({
      spacing: { after: 30 },
      children: [new D.TextRun({ text: '警消、救護單位', bold: true, size: 22 })],
    }));
    const emergencyLines = [
      '行政院國家搜救中心：02-89114119',
      '中華搜救總隊專線：03-3772272',
      '內政部空中勤務總隊：02-25472110',
      '免付費直升機救難中心：0800-077795',
      '全國山難緊急救助：119／112',
    ];
    for (const line of emergencyLines) {
      sections.push(new D.Paragraph({
        spacing: { after: 20 },
        indent: { left: 360 },
        children: [new D.TextRun({ text: line, size: 20 })],
      }));
    }

    // ── Document ──────────────────────────────────────────────────────────
    return new D.Document({
      styles: {
        default: { document: { run: { font: 'PMingLiU', size: 22 } } },
      },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },   // A4
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children: sections,
      }],
    });
  }

  // ─── public API ──────────────────────────────────────────────────────────
  async function exportPlan(plan, opts) {
    if (!plan || !plan.meta) throw new Error('exportPlan: invalid plan');
    await loadDocxLib();
    const doc = build(plan);
    const blob = await window.docx.Packer.toBlob(doc);
    const filename = ((opts && opts.filename) || (plan.meta.title || '登山計劃書') + '.docx');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  TF.docx = { exportPlan };
})();
