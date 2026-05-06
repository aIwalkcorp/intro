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

  const DOCX_CDN_URL = 'https://unpkg.com/docx@9.0.4/build/index.umd.js';

  function loadDocxLib() {
    if (window.docx) return Promise.resolve(window.docx);
    if (window.__tfDocxLoading) return window.__tfDocxLoading;
    window.__tfDocxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DOCX_CDN_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => window.docx ? resolve(window.docx) : reject(new Error('docx lib loaded but window.docx is undefined'));
      s.onerror = () => reject(new Error('failed to load docx-js from CDN'));
      document.head.appendChild(s);
    });
    return window.__tfDocxLoading;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  const BLANK = '____________';
  const HM_RE = /^\d{1,2}:\d{2}$/;

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

    // ── Table 1: 活動概覽 ───────────────────────────────────────────────────
    const TBL_W = 9000;
    const COL = TBL_W / 4;
    const leader = membersByRole(plan, '領隊')[0] || {};
    const guide  = membersByRole(plan, '嚮導')[0] || {};
    const standby = (plan.emergency_default && plan.emergency_default.standby) || {};
    const tbl1Rows = [
      row([labelCell('活動名稱', COL), valueCell(meta.title || BLANK, COL),
           labelCell('活動日期', COL),
           cell(`自${isoToROC(meta.start_date)}起\n至${isoToROC(meta.end_date)}止\n共計 ${dayCount(meta)} 天`,
                { width: COL })]),
      row([labelCell('領    隊', COL), valueCell(leader.name || BLANK, COL),
           labelCell('嚮    導', COL), valueCell(guide.name || BLANK, COL)]),
      row([labelCell('領隊電話', COL), valueCell(leader.phone || BLANK, COL),
           labelCell('活動費用', COL), valueCell(BLANK, COL)]),
      row([labelCell('留守人員', COL),
           valueCell(standby.name || (membersByRole(plan, '留守')[0] || {}).name || BLANK, COL),
           labelCell('留守電話', COL),
           valueCell(standby.phone || (membersByRole(plan, '留守')[0] || {}).phone || BLANK, COL)]),
      row([labelCell('參加人數', COL), valueCell(String(meta.party_size || BLANK), COL),
           labelCell('活動地點', COL), valueCell(meta.subtitle || BLANK, COL)]),
      row([labelCell('山難管制時間', COL), valueCell(findEmergencyValue(plan, '山難管制'), COL),
           labelCell('下山通知時間', COL), valueCell(findEmergencyValue(plan, '下山通知'), COL)]),
    ];
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: [COL, COL, COL, COL],
      rows: tbl1Rows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── Table 2 (per day): 活動行程表 ───────────────────────────────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '活動行程表', bold: true, size: 28 })],
    }));
    for (const d of (plan.days || [])) {
      const cps = dayCheckpoints(d);
      const dateStr = d.date_label || d.date || BLANK;
      const headRow = row([
        labelCell(`${d.label || d.id}\n${dateStr}`, COL * 1),
        labelCell('行程', COL),
        cell(cps.names.length ? cps.names.join('  →  ') : BLANK, { width: COL * 2 }),
      ]);
      const timeRow = row([
        cell('', { width: COL }),
        labelCell('時間', COL),
        cell(cps.times.length ? cps.times.join('  　  ') : BLANK, { width: COL * 2 }),
      ]);
      const statRow = row([
        labelCell('總計', COL),
        cell(cps.totalMin ? `總時長 ${fmtMin(cps.totalMin)}` : BLANK, { width: COL }),
        cell(cps.totalKm ? `距離 ${cps.totalKm.toFixed(1)} K` : BLANK, { width: COL }),
        cell(cps.asc || cps.desc ? `↑${cps.asc}m  ↓${cps.desc}m` : BLANK, { width: COL }),
      ]);
      sections.push(new D.Table({
        width: { size: TBL_W, type: D.WidthType.DXA },
        columnWidths: [COL, COL, COL, COL],
        rows: [headRow, timeRow, statRow],
      }));
      // 撤退方案
      if (d.retreat) {
        const items = Array.isArray(d.retreat.items_html) ? d.retreat.items_html.map(htmlToText)
          : Array.isArray(d.retreat.items) ? d.retreat.items
          : [htmlToText(d.retreat.title || '')];
        sections.push(new D.Paragraph({
          spacing: { before: 100, after: 100 },
          children: [new D.TextRun({ text: `↳ 撤退方案：`, bold: true })],
        }));
        for (const it of items) {
          if (!it) continue;
          sections.push(new D.Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            children: [new D.TextRun({ text: '・' + it })],
          }));
        }
      }
      sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));
    }

    // ── Table 4: 分工表 ─────────────────────────────────────────────────────
    const ROLES = ['領隊', '嚮導', '隊員', '留守', '交通', '裝備', '行政', '回報', '醫療', '天氣', '紀錄', '保險'];
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '分工表', bold: true, size: 28 })],
    }));
    const roleRows = [];
    for (let i = 0; i < ROLES.length; i += 4) {
      const cells = [];
      for (let j = 0; j < 4 && (i + j) < ROLES.length; j++) {
        const r = ROLES[i + j];
        const names = membersByRole(plan, r).map(m => m.name).filter(Boolean).join('、') || BLANK;
        cells.push(labelCell(r, COL / 2));
        cells.push(cell(names, { width: COL * 1.5 }));
      }
      roleRows.push(row(cells));
    }
    sections.push(new D.Table({
      width: { size: TBL_W, type: D.WidthType.DXA },
      columnWidths: [COL / 2, COL * 1.5, COL / 2, COL * 1.5],
      rows: roleRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── Table 5: 隊員名冊 ───────────────────────────────────────────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '隊員名冊', bold: true, size: 28 })],
    }));
    const headerW = [COL * 0.6, COL * 0.7, COL * 0.9, COL * 0.7, COL * 0.6, COL * 0.5];
    const memberRows = [
      row([
        labelCell('職稱', headerW[0]), labelCell('姓名', headerW[1]),
        labelCell('身分證字號', headerW[2]), labelCell('連絡電話', headerW[3]),
        labelCell('緊急聯絡人', headerW[4]), labelCell('緊急電話', headerW[5]),
      ]),
    ];
    const members = (plan.contacts && plan.contacts.members) || [];
    for (const m of members) {
      memberRows.push(row([
        valueCell(m.role || BLANK, headerW[0]),
        valueCell(m.name || BLANK, headerW[1]),
        valueCell(m.id_no || BLANK, headerW[2]),
        valueCell(m.phone || BLANK, headerW[3]),
        valueCell(m.ec_name || BLANK, headerW[4]),
        valueCell(m.ec_phone || BLANK, headerW[5]),
      ]));
    }
    if (members.length === 0) memberRows.push(row(headerW.map(w => valueCell(BLANK, w))));
    sections.push(new D.Table({
      width: { size: headerW.reduce((a,b)=>a+b,0), type: D.WidthType.DXA },
      columnWidths: headerW.map(w => Math.round(w)),
      rows: memberRows,
    }));
    sections.push(new D.Paragraph({ spacing: { after: 200 }, children: [] }));

    // ── Table 7: 活動經費預算 (placeholder — schema TBD) ────────────────────
    sections.push(new D.Paragraph({
      spacing: { before: 200, after: 100 },
      children: [new D.TextRun({ text: '活動經費預算', bold: true, size: 28 })],
    }));
    const budgetW = [COL * 1.4, COL * 0.7, COL * 0.5, COL * 0.7, COL * 0.7];
    const budgetRows = [
      row([
        labelCell('項目', budgetW[0]), labelCell('單價(元/人)', budgetW[1]),
        labelCell('數量', budgetW[2]), labelCell('總價(元)', budgetW[3]),
        labelCell('說明', budgetW[4]),
      ]),
    ];
    const budget = plan.budget || { items: [] };
    const items = Array.isArray(budget.items) ? budget.items : [];
    if (items.length === 0) {
      // 5 blank rows so user can fill manually
      for (let i = 0; i < 5; i++) {
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
    sections.push(new D.Table({
      width: { size: budgetW.reduce((a,b)=>a+b,0), type: D.WidthType.DXA },
      columnWidths: budgetW.map(w => Math.round(w)),
      rows: budgetRows,
    }));

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
