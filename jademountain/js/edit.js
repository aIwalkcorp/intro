/* Trailforge in-place plan editor.
 *
 * Activates only when the page is loaded with ?plan=<id> AND the user has a
 * tf_access_token in localStorage. Adds a brass FAB; toggling enters "edit
 * mode" which decorates each day panel with inline controls for:
 *   • quick_links    — add/edit/delete chip rows (icon emoji, text, URL, external)
 *   • details / 備註 — add/edit/delete expandable note sections (title + rows)
 *
 * Save collects the current DOM state, merges into a fresh plan.data clone,
 * PATCHes /api/plans/:id, then reloads. Cancel just reloads (no DB write).
 *
 * Self-contained: ships its own CSS via injected <style>, no external deps.
 * Compatible with the day-mode toggle (打卡/海拔) — only edits days[].quick_links
 * and days[].details, leaving everything else untouched.
 */
(function () {
  "use strict";

  // ---------- Config / context ----------
  const TOKEN_KEY = "tf_access_token";
  const params = new URLSearchParams(location.search);
  const planId = params.get("plan");
  const apiBase = (params.get("api") || "https://trailforge-api.fly.dev").replace(/\/+$/, "");
  const token = localStorage.getItem(TOKEN_KEY);
  if (!planId || !token) return; // not editable context

  // ---------- Style injection ----------
  const css = `
  /* Pinned to the top-right strip alongside the permit chip + dashboard pill.
     Position is computed by JS so it lands just LEFT of those elements. */
  .tf-edit-fab{
    position:fixed;
    top: calc(env(safe-area-inset-top, 0px) + 10px);
    right: calc(env(safe-area-inset-right, 0px) + 10px);  /* JS adjusts after layout */
    z-index:1300;
    appearance:none; cursor:pointer; border:none;
    display:inline-flex; align-items:center; gap:7px;
    padding:6px 12px 6px 10px;
    background:linear-gradient(178deg, #fbf6e8, #ebe1c9);
    color:#1f3a23;
    border:1px solid #6e5316;
    border-radius:999px;
    font-family:"Noto Serif TC","Songti TC",serif;
    font-size:12px; font-weight:600; letter-spacing:.18em;
    box-shadow:
      0 2px 10px rgba(10,26,6,0.18),
      inset 0 1px 0 rgba(255,255,255,0.6);
    transition:transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease;
  }
  .tf-edit-fab:hover{
    transform:translateY(-1px);
    background:linear-gradient(178deg, #fff8e0, #f0e6cc);
    box-shadow:0 4px 14px rgba(10,26,6,0.25), inset 0 1px 0 rgba(255,255,255,0.7);
  }
  .tf-edit-fab:active{transform:translateY(0)}
  .tf-edit-fab svg{width:13px; height:13px; stroke:#1f3a23; stroke-width:2.2; fill:none; stroke-linecap:round; stroke-linejoin:round}
  .tf-edit-fab .en{
    font-family:"JetBrains Mono",ui-monospace,monospace;
    font-size:9px; letter-spacing:.32em; color:#6e5316;
    font-weight:700; display:block; margin-top:1px;
  }
  .tf-edit-fab .label-stack{display:flex; flex-direction:column; line-height:1.15}
  /* Active state — match the forest-green ink of the chip while editing */
  body.tf-editing .tf-edit-fab{
    background:linear-gradient(160deg,#1f3a23 0%,#122118 100%);
    color:#f4eddc; border-color:rgba(232,201,138,0.6);
    box-shadow:0 4px 14px rgba(10,26,6,0.45), inset 0 1px 0 rgba(255,213,138,0.18);
  }
  body.tf-editing .tf-edit-fab svg{stroke:#f4eddc}
  body.tf-editing .tf-edit-fab .en{color:rgba(244,237,220,0.55)}
  @media (max-width: 480px){
    .tf-edit-fab .en{display:none}
    .tf-edit-fab{padding:6px 10px; gap:0}
    .tf-edit-fab .label-stack{display:none}    /* icon-only on mobile */
    .tf-edit-fab svg{width:16px; height:16px}
  }

  /* Save bar (visible while editing) */
  .tf-edit-bar{
    position:fixed; left:50%; transform:translateX(-50%) translateY(100%);
    bottom:14px; z-index:1500;
    display:flex; align-items:center; gap:10px;
    padding:10px 14px;
    background:linear-gradient(178deg,#fbf6e8,#ebe1c9);
    color:#1a1a17;
    border:1px solid rgba(42,36,24,0.45);
    box-shadow:0 14px 40px rgba(10,26,6,0.45), inset 0 1px 0 rgba(255,255,255,0.7);
    transition: transform .3s cubic-bezier(.2,.7,.2,1);
    font-family:"Noto Serif TC",serif;
  }
  .tf-edit-bar.show{transform:translateX(-50%) translateY(0)}
  .tf-edit-bar::before{
    content:""; position:absolute; top:0; left:0; right:0; height:3px;
    background:repeating-linear-gradient(90deg,#1f3a23 0 10px,transparent 10px 14px,#a8802c 14px 17px,transparent 17px 26px);
  }
  .tf-edit-bar .status{
    font-family:"JetBrains Mono",monospace; font-size:.62rem; letter-spacing:.28em;
    color:#7a7468; padding:0 8px;
  }
  .tf-edit-bar .status.dirty{color:#a8802c; font-weight:700}
  .tf-edit-bar button{
    appearance:none; cursor:pointer; border:1px solid #2a2418; background:transparent;
    padding:7px 14px;
    font-family:"Noto Serif TC",serif; font-size:.82rem; letter-spacing:.12em; color:#1a1a17;
    transition: background .15s, color .15s;
  }
  .tf-edit-bar button:hover{background:rgba(168,128,44,0.18)}
  .tf-edit-bar .save{background:#1f3a23; color:#f4eddc; border-color:#1f3a23; font-weight:700}
  .tf-edit-bar .save:hover{background:#365a2b}
  .tf-edit-bar .save:disabled{opacity:.5; cursor:wait}
  .tf-edit-bar .cancel:hover{background:rgba(139,42,31,0.15); color:#8b2a1f; border-color:#8b2a1f}

  /* Edit-mode body marker */
  body.tf-editing .day-panel{position:relative}
  body.tf-editing .day-panel::before{
    content:""; position:absolute; inset:-2px;
    border:1px dashed rgba(168,128,44,0.55);
    pointer-events:none; opacity:.7;
  }

  /* Trip-meta editor (party size + label) */
  .tf-meta-block{
    margin:14px 14px 0;
    padding:14px 16px 12px;
    background:linear-gradient(178deg, #fbf6e8, #ebe1c9);
    border:1px solid rgba(168,128,44,0.55);
    box-shadow: 0 2px 12px rgba(10,26,6,0.10), inset 0 1px 0 rgba(255,255,255,0.7);
    position:relative;
  }
  .tf-meta-block::before{
    content:""; position:absolute; top:0; left:0; right:0; height:3px;
    background:repeating-linear-gradient(90deg,#1f3a23 0 12px,transparent 12px 16px,#a8802c 16px 19px,transparent 19px 28px);
  }
  .tf-meta-block .head{
    display:flex; justify-content:space-between; align-items:baseline;
    font-family:"JetBrains Mono",monospace; font-size:.6rem; letter-spacing:.32em;
    color:#7a7468; text-transform:uppercase; font-weight:700;
    margin-bottom:12px;
  }
  .tf-meta-block .head b{font-family:"Fraunces",serif; color:#1f3a23; letter-spacing:.04em; font-size:.95rem; font-weight:700; text-transform:none}
  .tf-meta-grid{
    display:grid; grid-template-columns: 1fr 1fr; gap:14px;
  }
  @media (max-width: 540px){.tf-meta-grid{grid-template-columns:1fr}}
  .tf-meta-field{
    display:flex; flex-direction:column; gap:6px;
  }
  .tf-meta-field .lbl{
    font-family:"JetBrains Mono",monospace; font-size:.58rem; letter-spacing:.28em;
    color:#7a7468; text-transform:uppercase; font-weight:600;
    display:flex; justify-content:space-between; align-items:baseline;
  }
  .tf-meta-field .lbl .zh{font-family:"Noto Serif TC",serif; font-size:.86rem; letter-spacing:.06em; color:#1a1a17; text-transform:none; font-weight:500}
  .tf-meta-stepper{
    display:inline-flex; align-items:stretch; align-self:flex-start;
    border:1px solid #2a2418;
    background:linear-gradient(180deg, #fdf9ee, #f0e6cc);
  }
  .tf-meta-stepper .step{
    appearance:none; cursor:pointer; border:none; background:transparent;
    width:34px; height:34px;
    font-family:"JetBrains Mono",monospace; font-size:1.1rem; font-weight:800;
    color:#1f3a23;
    display:flex; align-items:center; justify-content:center;
    transition:background .15s;
  }
  .tf-meta-stepper .step:hover:not(:disabled){background:rgba(168,128,44,0.25)}
  .tf-meta-stepper .step:disabled{color:#7a7468; cursor:not-allowed; opacity:.4}
  .tf-meta-stepper .val{
    min-width:60px; padding:0 14px;
    display:flex; align-items:center; justify-content:center;
    font-family:"Fraunces",serif; font-weight:700; font-size:1.05rem; color:#1f3a23;
    border-left:1px solid #2a2418; border-right:1px solid #2a2418;
  }
  .tf-meta-input{
    appearance:none; background:rgba(255,255,255,0.7);
    border:1px solid rgba(42,36,24,0.2);
    padding:8px 10px;
    font-family:"Noto Serif TC",serif; font-size:.92rem; color:#1a1a17;
    outline:none; transition:border-color .15s, background .15s;
  }
  .tf-meta-input:focus{border-color:#a8802c; background:#fff}
  .tf-meta-hint{
    margin-top:6px;
    font-family:"JetBrains Mono",monospace; font-size:.56rem; letter-spacing:.18em;
    color:#7a7468;
  }

  /* Inline replace blocks */
  .tf-edit-block{
    margin:14px 0;
    padding:14px 14px 12px;
    background:linear-gradient(178deg, rgba(251,246,232,0.95), rgba(235,225,201,0.8));
    border:1px solid rgba(168,128,44,0.45);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
    position:relative;
  }
  .tf-edit-block::before{
    content:""; position:absolute; top:0; left:0; right:0; height:2px;
    background:repeating-linear-gradient(90deg,#1f3a23 0 8px,transparent 8px 12px,#a8802c 12px 15px,transparent 15px 22px);
  }
  .tf-edit-block .blk-head{
    font-family:"JetBrains Mono",monospace; font-size:.58rem; letter-spacing:.32em;
    color:#7a7468; text-transform:uppercase; font-weight:700;
    margin-bottom:10px;
    display:flex; justify-content:space-between; align-items:baseline;
  }
  .tf-edit-block .blk-head .blk-day{color:#1f3a23}

  /* Quick link edit row */
  .tf-ql-row{
    display:grid; grid-template-columns: 38px 1fr 1.4fr auto 28px;
    gap:6px; align-items:center;
    padding:5px 0;
    border-bottom:1px dashed rgba(42,36,24,0.18);
  }
  .tf-ql-row:last-of-type{border-bottom:none}
  .tf-ql-row input[type=text], .tf-ql-row input[type=url]{
    appearance:none; background:rgba(255,255,255,0.6); border:1px solid rgba(42,36,24,0.18);
    padding:6px 8px;
    font-family:"Noto Serif TC",serif; font-size:.86rem; color:#1a1a17;
    outline:none; transition: border-color .15s, background .15s;
    width:100%; min-width:0;
  }
  .tf-ql-row input:focus{border-color:#a8802c; background:#fff}
  .tf-ql-row .icon-input{
    text-align:center; font-family:"Apple Color Emoji","Segoe UI Emoji",sans-serif;
    font-size:1rem; padding:6px 4px;
  }
  .tf-ql-row label{
    font-family:"JetBrains Mono",monospace; font-size:.56rem; letter-spacing:.28em;
    color:#7a7468; display:flex; align-items:center; gap:5px; cursor:pointer; text-transform:uppercase;
  }
  .tf-ql-row label input{accent-color:#a8802c}
  .tf-row-del, .tf-row-add{
    appearance:none; cursor:pointer; border:1px solid rgba(42,36,24,0.3);
    background:transparent; color:#7a7468;
    width:28px; height:28px;
    display:flex; align-items:center; justify-content:center;
    font-family:"JetBrains Mono",monospace; font-size:1.1rem; font-weight:700;
    transition: color .15s, background .15s, border-color .15s;
  }
  .tf-row-del:hover{color:#fff; background:#8b2a1f; border-color:#8b2a1f}
  .tf-row-add{
    margin-top:8px; width:auto; padding:6px 14px;
    font-family:"Noto Serif TC",serif; font-size:.78rem; letter-spacing:.18em;
    color:#1f3a23; height:auto;
  }
  .tf-row-add:hover{background:rgba(168,128,44,0.2); border-color:#a8802c; color:#1f3a23}

  /* Details / note section editor */
  .tf-det-sec{
    background:rgba(255,255,255,0.5);
    border:1px solid rgba(42,36,24,0.2);
    padding:10px 12px;
    margin-bottom:10px;
  }
  .tf-det-head{display:flex; gap:8px; align-items:center; margin-bottom:8px}
  .tf-det-head .icon{
    width:34px; padding:6px 4px; text-align:center;
    background:rgba(255,255,255,0.7); border:1px solid rgba(42,36,24,0.18);
    font-family:"Apple Color Emoji","Segoe UI Emoji",sans-serif; font-size:1rem;
  }
  .tf-det-head .title{
    flex:1;
    background:rgba(255,255,255,0.7); border:1px solid rgba(42,36,24,0.18);
    padding:6px 10px;
    font-family:"Noto Serif TC",serif; font-weight:600; font-size:.96rem; color:#0a1a06;
    outline:none;
  }
  .tf-det-head .title:focus{border-color:#a8802c; background:#fff}
  .tf-det-rows{display:flex; flex-direction:column; gap:6px; margin-top:6px}
  .tf-det-row{display:flex; gap:6px; align-items:flex-start}
  .tf-det-row textarea{
    flex:1;
    background:rgba(255,255,255,0.6); border:1px solid rgba(42,36,24,0.16);
    padding:7px 10px;
    font-family:"Noto Serif TC",serif; font-size:.88rem; line-height:1.55; color:#1a1a17;
    outline:none; resize:vertical; min-height:42px;
    font-feature-settings:"liga";
  }
  .tf-det-row textarea:focus{border-color:#a8802c; background:#fff}
  .tf-det-foot{margin-top:8px; display:flex; gap:8px}
  .tf-det-add-row{font-size:.72rem; padding:5px 10px}
  .tf-det-html-warn{
    margin:6px 0 0;
    font-family:"JetBrains Mono",monospace; font-size:.56rem; letter-spacing:.18em;
    color:#7a7468;
  }

  /* Hide read-only renderings of qlinks/details while editing */
  body.tf-editing .qlinks, body.tf-editing .exp{display:none !important}
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "tf-edit-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---------- Toast (re-uses #permitToast if present, else its own) ----------
  function showToast(msg, ms = 2400) {
    const existing = document.getElementById("permitToast");
    if (existing) {
      existing.textContent = msg;
      existing.classList.add("show");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => existing.classList.remove("show"), ms);
      return;
    }
    let t = document.getElementById("tfEditToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "tfEditToast";
      t.style.cssText = "position:fixed;bottom:74px;left:50%;transform:translateX(-50%);z-index:1600;padding:10px 18px;background:#1f3a23;color:#f4eddc;font-family:'Noto Serif TC',serif;font-size:.92rem;border:1px solid #a8802c;opacity:0;transition:opacity .25s;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.style.opacity = "0"; }, ms);
  }

  // ---------- API helper ----------
  // Mutating calls go through TF_OUTBOX so a network drop queues the save.
  async function api(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const headers = { Authorization: "Bearer " + token, ...(opts.headers || {}) };
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";

    if (method !== "GET" && window.TF_OUTBOX) {
      const r = await window.TF_OUTBOX.send(apiBase + path, {
        method, headers, body: opts.body, label: method + " " + path,
      });
      if (r.queued) {
        return { ok: true, status: 202, queued: true, json: async () => r.body || {} };
      }
      return { ok: r.ok, status: r.status, json: async () => r.body || {} };
    }
    return fetch(apiBase + path, { ...opts, headers });
  }

  // ---------- State ----------
  let editing = false;
  let dirty = false;
  let originalData = null;
  let workingData = null;

  // ---------- FAB + bar ----------
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "tf-edit-fab";
  fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="label-stack"><span class="zh">編輯</span><span class="en">EDIT</span></span>`;
  fab.addEventListener("click", () => editing ? exitEditAsk() : enterEdit());

  const bar = document.createElement("div");
  bar.className = "tf-edit-bar";
  bar.innerHTML = `
    <span class="status" id="tfEditStatus">未變更</span>
    <button type="button" class="cancel" id="tfEditCancel">取消</button>
    <button type="button" class="save" id="tfEditSave">儲存</button>
  `;

  function attachUI() {
    if (!document.body) return;
    if (!fab.isConnected) document.body.appendChild(fab);
    if (!bar.isConnected) document.body.appendChild(bar);
    placeFab();
  }
  // Position FAB so it sits to the LEFT of #dashPill (when shown) or #permitChip,
  // matching the existing top-right strip.
  function placeFab() {
    const anchors = [
      document.querySelector(".dash-pill.show"),
      document.getElementById("dashPill"),
      document.getElementById("permitChip"),
    ];
    let neighbour = null;
    for (const a of anchors) {
      if (!a) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      neighbour = a; break;
    }
    if (!neighbour) {
      // fallback: pin to viewport edge
      fab.style.right = "10px";
      return;
    }
    const r = neighbour.getBoundingClientRect();
    const rightOffset = window.innerWidth - r.left + 8;   // 8px gap
    fab.style.right = rightOffset + "px";
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachUI);
  } else {
    attachUI();
  }
  window.addEventListener("resize", placeFab);
  // Re-place after the chip/pill JS may have toggled visibility post-login
  setTimeout(placeFab, 200);
  setTimeout(placeFab, 800);

  function setDirty(v) {
    dirty = v;
    const s = document.getElementById("tfEditStatus");
    if (s) {
      s.textContent = v ? "未儲存" : "未變更";
      s.classList.toggle("dirty", v);
    }
  }

  // ---------- Enter / Exit edit ----------
  async function enterEdit() {
    fab.disabled = true;
    try {
      const r = await api("/api/plans/" + encodeURIComponent(planId));
      if (!r.ok) {
        showToast("無法載入計劃書（HTTP " + r.status + "）");
        return;
      }
      const row = await r.json();
      originalData = row.data;
      workingData = JSON.parse(JSON.stringify(row.data));
      document.body.classList.add("tf-editing");
      editing = true;
      setDirty(false);
      bar.classList.add("show");
      fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg><span class="label-stack"><span class="zh">結束</span><span class="en">EXIT</span></span>`;
      placeFab();
      decorate();
    } catch (e) {
      showToast("載入失敗：" + e.message);
    } finally {
      fab.disabled = false;
    }
  }

  function exitEditAsk() {
    if (dirty && !confirm("有未儲存的變更，確定要結束編輯？")) return;
    location.reload();
  }

  // ---------- Decorations ----------
  function decorate() {
    const days = (workingData && workingData.days) || [];
    days.forEach((day) => {
      const panel = document.getElementById("day-" + day.id);
      if (!panel) return;
      decorateDayLinks(panel, day);
      decorateDayDetails(panel, day);
    });
  }

  function decorateDayLinks(panel, day) {
    // Insert/replace edit block AFTER any existing .qlinks (or after eq-card if none)
    const anchor = panel.querySelector(".qlinks") || panel.querySelector(".eq-card") || panel.firstChild;
    if (!anchor) return;
    const block = document.createElement("div");
    block.className = "tf-edit-block tf-ql-block";
    block.dataset.dayId = day.id;
    block.innerHTML = `
      <div class="blk-head"><span>編輯快速連結</span><span class="blk-day">${esc(day.label || day.id)}</span></div>
      <div class="tf-ql-rows"></div>
      <button type="button" class="tf-row-add tf-ql-add">＋ 新增連結</button>
    `;
    anchor.parentNode.insertBefore(block, anchor.nextSibling);

    const rowsHost = block.querySelector(".tf-ql-rows");
    (day.quick_links || []).forEach((l) => rowsHost.appendChild(makeQLRow(l)));
    block.querySelector(".tf-ql-add").addEventListener("click", () => {
      rowsHost.appendChild(makeQLRow({ icon: "🔗", text: "", href: "", external: true }));
      setDirty(true);
    });
  }

  function makeQLRow(l) {
    const row = document.createElement("div");
    row.className = "tf-ql-row";
    row.innerHTML = `
      <input class="icon-input" type="text" maxlength="2" placeholder="🔗" value="${attr(l.icon || "")}">
      <input type="text" class="ql-text" placeholder="名稱" value="${attr(l.text || "")}">
      <input type="url" class="ql-href" placeholder="https://" value="${attr(l.href || "")}">
      <label><input type="checkbox" class="ql-ext" ${l.external ? "checked" : ""}>新分頁</label>
      <button type="button" class="tf-row-del" aria-label="刪除這條連結">×</button>
    `;
    row.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => setDirty(true)));
    row.querySelector(".tf-row-del").addEventListener("click", () => {
      row.remove();
      setDirty(true);
    });
    return row;
  }

  function decorateDayDetails(panel, day) {
    // Place AFTER mode-shell (schedule + elevation toggle) so it sits "below the schedule"
    const anchor = panel.querySelector(".mode-shell")
      || panel.querySelector(".section")           // fallback: legacy schedule section
      || panel.querySelector(".tf-ql-block");      // fallback: after the qlinks editor
    if (!anchor) return;

    const block = document.createElement("div");
    block.className = "tf-edit-block tf-det-block";
    block.dataset.dayId = day.id;
    block.innerHTML = `
      <div class="blk-head"><span>編輯備註區塊</span><span class="blk-day">${esc(day.label || day.id)}</span></div>
      <div class="tf-det-secs"></div>
      <button type="button" class="tf-row-add tf-det-add-sec">＋ 新增備註區塊</button>
      <div class="tf-det-html-warn">提示：原本帶 HTML 的備註會以純文字呈現（保留為純文字後 HTML 標籤會被原樣顯示）。</div>
    `;
    anchor.parentNode.insertBefore(block, anchor.nextSibling);

    const secsHost = block.querySelector(".tf-det-secs");
    (day.details || []).forEach((d) => secsHost.appendChild(makeDetSection(d)));
    block.querySelector(".tf-det-add-sec").addEventListener("click", () => {
      secsHost.appendChild(makeDetSection({ icon: "📝", title: "新區塊", rows_html: [""] }));
      setDirty(true);
    });
  }

  function makeDetSection(d) {
    const sec = document.createElement("div");
    sec.className = "tf-det-sec";
    sec.innerHTML = `
      <div class="tf-det-head">
        <input class="icon" type="text" maxlength="2" placeholder="📝" value="${attr(d.icon || "")}">
        <input class="title" type="text" placeholder="區塊標題" value="${attr(d.title || "")}">
        <button type="button" class="tf-row-del" aria-label="刪除整個區塊" title="刪除整個區塊">×</button>
      </div>
      <div class="tf-det-rows"></div>
      <div class="tf-det-foot"><button type="button" class="tf-row-add tf-det-add-row">＋ 新增列</button></div>
    `;
    const rowsHost = sec.querySelector(".tf-det-rows");
    (d.rows_html || []).forEach((html) => rowsHost.appendChild(makeDetRow(html)));
    sec.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => setDirty(true)));
    sec.querySelector(".tf-det-head .tf-row-del").addEventListener("click", () => {
      if ((d.rows_html || []).length > 0 && !confirm("確定要刪除整個備註區塊？")) return;
      sec.remove();
      setDirty(true);
    });
    sec.querySelector(".tf-det-add-row").addEventListener("click", () => {
      rowsHost.appendChild(makeDetRow(""));
      setDirty(true);
    });
    return sec;
  }

  function makeDetRow(html) {
    const wrap = document.createElement("div");
    wrap.className = "tf-det-row";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    // Convert simple HTML back to readable text. Preserves text content;
    // tags become visible (acceptable for MVP).
    ta.value = htmlToPlain(html || "");
    ta.addEventListener("input", () => setDirty(true));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "tf-row-del";
    del.setAttribute("aria-label", "刪除這列");
    del.textContent = "×";
    del.addEventListener("click", () => {
      wrap.remove();
      setDirty(true);
    });
    wrap.appendChild(ta);
    wrap.appendChild(del);
    return wrap;
  }

  function htmlToPlain(s) {
    // very gentle: replace <br> with newline, strip tags, decode entities
    const tmp = document.createElement("div");
    tmp.innerHTML = String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n");
    return tmp.textContent.replace(/ /g, " ").trim();
  }
  function plainToHtml(s) {
    // store as escaped text. The renderer wraps non-block lines in <div>.
    if (!s) return "";
    const escaped = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped.replace(/\n/g, "<br>");
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }

  // ---------- Save ----------
  function collect() {
    const data = JSON.parse(JSON.stringify(workingData));
    (data.days || []).forEach((day) => {
      // quick_links
      const qlBlock = document.querySelector(`.tf-ql-block[data-day-id="${cssEscape(day.id)}"]`);
      if (qlBlock) {
        const links = [];
        qlBlock.querySelectorAll(".tf-ql-row").forEach((row) => {
          const text = row.querySelector(".ql-text").value.trim();
          const href = row.querySelector(".ql-href").value.trim();
          const icon = row.querySelector(".icon-input").value.trim();
          const ext = row.querySelector(".ql-ext").checked;
          if (!text && !href) return; // skip empties
          links.push({ icon: icon || "", text, href, external: !!ext });
        });
        day.quick_links = links;
      }
      // details
      const detBlock = document.querySelector(`.tf-det-block[data-day-id="${cssEscape(day.id)}"]`);
      if (detBlock) {
        const secs = [];
        detBlock.querySelectorAll(".tf-det-sec").forEach((sec) => {
          const icon = sec.querySelector(".icon").value.trim();
          const title = sec.querySelector(".title").value.trim();
          const rows = [];
          sec.querySelectorAll(".tf-det-row textarea").forEach((ta) => {
            const v = ta.value.trim();
            if (v) rows.push(plainToHtml(v));
          });
          if (!title && rows.length === 0) return;
          secs.push({ icon, title, rows_html: rows });
        });
        day.details = secs;
      }
    });
    return data;
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  async function save() {
    const data = collect();
    const saveBtn = document.getElementById("tfEditSave");
    const cancelBtn = document.getElementById("tfEditCancel");
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = "儲存中…";
    try {
      const r = await api("/api/plans/" + encodeURIComponent(planId), {
        method: "PATCH",
        body: JSON.stringify({ data }),
      });
      if (r.queued) {
        showToast("離線：已暫存。連回網路時請點右上「⬆ 上傳」。");
        setTimeout(() => location.reload(), 1100);
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + r.status);
      }
      showToast("已儲存。重新載入計劃書…");
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      showToast("儲存失敗：" + e.message);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = "儲存";
    }
  }

  bar.addEventListener("click", (e) => {
    if (e.target.id === "tfEditSave") save();
    if (e.target.id === "tfEditCancel") {
      if (dirty && !confirm("放棄所有未儲存的變更？")) return;
      location.reload();
    }
  });

  // ---------- Re-decorate if render.js re-renders during edit ----------
  // (rare, but if user toggles day mode etc., the day-panel innerHTML may be replaced)
  const observer = new MutationObserver(() => {
    if (!editing) return;
    // If our blocks vanished, redecorate
    const days = (workingData && workingData.days) || [];
    let needs = false;
    days.forEach((d) => {
      const panel = document.getElementById("day-" + d.id);
      if (!panel) return;
      if (!panel.querySelector(".tf-edit-block")) needs = true;
    });
    if (needs) decorate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
