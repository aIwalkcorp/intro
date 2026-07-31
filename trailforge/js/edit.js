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
  /* FAB hidden — the segmented mode toggle (檢視/編輯) is now the unified
     view/edit switch, shared across all tabs. Kept in DOM as a safety net but
     not visually shown. */
  .tf-edit-fab{ display:none !important; }
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

  /* Save bar — DOM-only now. The top-right #jmSaveChip is the primary
     save affordance; this bottom bar was redundant and overlapped the
     stats footer in mobile widths. Hidden visually but #tfEditSave /
     #tfEditCancel are still in the DOM because index.html's save chip
     delegates clicks to them. */
  .tf-edit-bar{ display:none !important; }
  body.tf-dirty .tf-edit-bar.show{ display:none !important; }
  .tf-edit-bar .close-x{
    appearance:none; background:transparent; border:none; cursor:pointer;
    width:26px; height:26px; padding:0;
    display:flex; align-items:center; justify-content:center;
    color:#7a7468; font-family:"JetBrains Mono",monospace; font-size:1.1rem; line-height:1;
    margin-right:-2px;
    transition: color .15s, background .15s; border-radius:50%;
  }
  .tf-edit-bar .close-x:hover{color:#8b2a1f; background:rgba(139,42,31,0.1)}
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

  /* Read-only qlinks/exp stay visible in edit mode now that the dedicated
     editor blocks (tf-ql-block / tf-det-block) are no longer injected — the
     display is the only source of truth for those fields. */

  /* Retreat-times editor — sits inside the elevation pane below the rest
     points block. Visual: ledger of timed warnings + free-form notes. */
  .tf-rt-block{
    background:linear-gradient(180deg, rgba(254,226,226,0.55), rgba(252,165,165,0.18));
    border-color:rgba(220,38,38,0.45);
  }
  .tf-rt-block::before{ background:#dc2626 }
  .tf-rt-title-wrap{margin-bottom:8px}
  .tf-rt-title{
    width:100%; padding:7px 10px;
    background:rgba(255,255,255,0.7); border:1px solid rgba(42,36,24,0.18);
    border-radius:6px; font-family:"Noto Serif TC",serif; font-weight:700;
    font-size:.95rem; color:#7c1d1d;
  }
  .tf-rt-title:focus{outline:none; border-color:#dc2626; background:#fff}
  .tf-rt-rows{display:flex; flex-direction:column; gap:6px}
  .tf-rt-row{
    display:grid; gap:6px; align-items:center;
    padding:6px 8px; border-radius:6px;
    background:rgba(255,255,255,0.65);
    border:1px solid rgba(42,36,24,0.14);
    grid-template-columns: 88px 96px 1fr 28px;
  }
  .tf-rt-row-note{ grid-template-columns: 50px 1fr 28px; }
  .tf-rt-row .tf-rt-sev,
  .tf-rt-row .tf-rt-time,
  .tf-rt-row .tf-rt-text{
    background:transparent; border:0; border-bottom:1px dotted rgba(42,36,24,0.25);
    border-radius:0; padding:5px 4px; font:inherit;
    font-family:"Noto Serif TC",serif; font-size:.88rem; color:#3b2e14;
    min-width:0;
  }
  .tf-rt-row .tf-rt-sev{font-family:"JetBrains Mono",monospace; font-size:.72rem}
  .tf-rt-row .tf-rt-time{font-family:"JetBrains Mono",monospace; font-weight:700; color:#7c1d1d}
  .tf-rt-row input:focus, .tf-rt-row select:focus{outline:none; border-bottom:1px solid #dc2626; background:rgba(255,255,255,0.5)}
  .tf-rt-row .tf-rt-tag{
    font-family:"JetBrains Mono",monospace; font-size:.6rem; letter-spacing:.22em;
    color:#7a5a1a; text-transform:uppercase; font-weight:700; text-align:center;
  }
  .tf-rt-foot{margin-top:8px; display:flex; flex-wrap:wrap; gap:8px}
  .tf-rt-foot .tf-row-add{font-size:.72rem; padding:5px 12px}
  .tf-rt-hint{
    margin-top:6px;
    font-family:"JetBrains Mono",monospace; font-size:.58rem; letter-spacing:.18em;
    color:#7a7468; text-transform:uppercase;
  }
  @media(max-width:520px){
    .tf-rt-row{grid-template-columns: 64px 80px 1fr 24px; gap:4px; padding:5px 6px}
    .tf-rt-row-note{grid-template-columns: 40px 1fr 24px}
    .tf-rt-row .tf-rt-text{font-size:.82rem}
  }
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
  // Online: PATCH/POST go straight to the backend through the outbox
  // wrapper, which auto-queues ONLY on real network errors (TypeError
  // from fetch). Returns a fetch-like Response so callers can branch on
  // r.ok / r.status / r.json().
  // Offline (navigator.onLine === false): skip the doomed fetch attempt
  // and queue immediately — the upload pill takes over and the user
  // drains it manually when they're back online. The two-step "save
  // then upload" is PWA-only behavior; online users see save → reload.
  async function api(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const headers = { Authorization: "Bearer " + token, ...(opts.headers || {}) };
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";

    if (method !== "GET" && window.TF_OUTBOX) {
      const offline = (typeof navigator !== "undefined" && navigator.onLine === false);
      const sendOpts = {
        method, headers, body: opts.body, label: method + " " + path,
      };
      if (offline) sendOpts.queueOnly = true;
      const r = await window.TF_OUTBOX.send(apiBase + path, sendOpts);
      if (r.queued) {
        return { ok: true, status: 202, queued: true, json: async () => (r.body || {}) };
      }
      return {
        ok: r.ok, status: r.status, queued: false,
        json: async () => (r.body || {}),
      };
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
    <button type="button" class="close-x" id="tfEditClose" aria-label="收起編輯列" title="收起 (Esc)">×</button>
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

  // ---- Bridge: segmented mode toggle (檢視/編輯) ↔ edit mode ----
  // The top-right segmented control sets body[data-jm-mode] = checkpoint|elevation.
  // Treat "elevation" as the unified edit-mode trigger so contacts/gear tabs
  // also respond to it. Sync both directions so FAB/programmatic enter still
  // updates the segmented chip.
  let bridging = false;          // re-entry guard
  function syncModeFromEditing() {
    if (!window.TF || !TF.modeToggle) return;
    bridging = true;
    try { TF.modeToggle.set(editing ? "elevation" : "checkpoint"); }
    finally { setTimeout(() => { bridging = false; }, 30); }
  }
  const modeObs = new MutationObserver(() => {
    if (bridging) return;
    const mode = document.body.getAttribute("data-jm-mode") || "checkpoint";
    if (mode === "elevation" && !editing) {
      enterEdit();
    } else if (mode === "checkpoint" && editing) {
      if (dirty && !confirm("有未儲存的變更，確定要切回檢視？")) {
        // user cancelled — revert chip back to elevation
        bridging = true;
        try { document.body.setAttribute("data-jm-mode", "elevation"); }
        finally { setTimeout(() => { bridging = false; }, 30); }
        return;
      }
      intentionalReload();   // exit edit mode by reloading to a clean state
    }
  });
  modeObs.observe(document.body, { attributes: true, attributeFilter: ["data-jm-mode"] });
  document.addEventListener("tf:edit-enter", syncModeFromEditing);

  // If we have stashed pending edits for this plan AND a valid auth token,
  // auto-enter edit mode so the user lands back where they were after login.
  // ONLY when the stash carries real unsaved `data` — cloneSeed stashes (the
  // pre-arm from the dashboard/auth clone flow) had no payload yet looped the
  // user into edit mode every reload, making 檢視 toggle look broken.
  function maybeAutoResumeEdit() {
    if (!planId) return;
    const token = localStorage.getItem("tf_access_token");
    if (!token) return;
    // Honor the user's explicit mode preference. If `jm_mode_global` is
    // 檢視 (checkpoint), they last said "I want to view, not edit" — drop
    // any leftover stash and stay out of edit mode. Without this, a user
    // running an older edit.js (cached from a previous SW) where
    // intentionalReload didn't clear the stash would loop right back into
    // 編輯 on every reload no matter how many times they tap 檢視.
    let lastMode = null;
    try { lastMode = localStorage.getItem("jm_mode_global"); } catch (e) {}
    if (lastMode === "checkpoint") {
      try { localStorage.removeItem("tf_pending_edit_" + planId); } catch (e) {}
      return;
    }
    let stash = null;
    try {
      const raw = localStorage.getItem("tf_pending_edit_" + planId);
      if (raw) stash = JSON.parse(raw);
    } catch (e) {}
    if (!stash || stash.planId !== planId) return;
    if (!stash.data) {
      // Legacy cloneSeed pre-arm with no payload — drop it so next reload
      // lands cleanly on 檢視 mode. Real unsaved edits always carry .data.
      try { localStorage.removeItem("tf_pending_edit_" + planId); } catch (e) {}
      return;
    }
    // Defer slightly so render.js / contacts.js have a chance to mount first.
    setTimeout(() => { if (!editing) enterEdit(); }, 600);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeAutoResumeEdit);
  } else {
    maybeAutoResumeEdit();
  }

  function setDirty(v) {
    dirty = v;
    const s = document.getElementById("tfEditStatus");
    if (s) {
      s.textContent = v ? "未儲存" : "未變更";
      s.classList.toggle("dirty", v);
    }
    // Toggle a body-level class so the top-right save chip can react to dirty
    // state via CSS alone (paired with body.tf-editing).
    document.body.classList.toggle("tf-dirty", !!v);
  }

  // All edit.js-side navigation (reload after save/cancel/exit) is intentional;
  // clear dirty + flag the navigation so the global beforeunload guard skips.
  function intentionalReload(delay) {
    setDirty(false);
    // Every caller of intentionalReload() is "user explicitly exited edit mode"
    // (檢視 toggle, FAB ✕, Esc, cancel button). Drop any pending edit stash so
    // maybeAutoResumeEdit doesn't drag them back into 編輯 on the next load.
    // Without this, an offline-save failure or a stale 401-redirect stash
    // would loop the user into edit mode after every reload, making the
    // 檢視 toggle look broken.
    if (planId) {
      try { localStorage.removeItem("tf_pending_edit_" + planId); } catch (e) {}
    }
    if (window.tfMarkIntentionalNav) window.tfMarkIntentionalNav();
    if (delay) setTimeout(() => location.reload(), delay);
    else location.reload();
  }

  // Public extension API — lets other modules (contacts editor, gear editor,
  // etc.) participate in edit-mode lifecycle without duplicating save/dirty
  // plumbing. They register a collector that runs during save() and merges
  // its return value into the saved data.
  const collectors = [];
  window.TF_EDIT = window.TF_EDIT || {};
  // Replace any early <body> stub markers — this is the auth-aware version.
  window.TF_EDIT._isStub = false;
  // Carry over collectors registered against the stub before edit.js loaded.
  if (window.TF_EDIT._stubCollectors && window.TF_EDIT._stubCollectors.length) {
    collectors.push(...window.TF_EDIT._stubCollectors);
    window.TF_EDIT._stubCollectors = [];
  }
  window.TF_EDIT.setDirty = (v) => setDirty(!!v);
  window.TF_EDIT.isEditing = () => editing;
  window.TF_EDIT.registerCollector = (fn) => { if (typeof fn === "function") collectors.push(fn); };
  // Custom event so modules can re-render on enter/exit edit mode.
  window.TF_EDIT.onEnter = (fn) => document.addEventListener("tf:edit-enter", fn);
  window.TF_EDIT.onExit  = (fn) => document.addEventListener("tf:edit-exit",  fn);

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
      // If we previously stashed unsaved edits (e.g. user got 401 and was sent
      // to auth.html, then came back), restore them now.
      let restored = false;
      try {
        const raw = localStorage.getItem("tf_pending_edit_" + planId);
        if (raw) {
          const stash = JSON.parse(raw);
          if (stash && stash.data && stash.planId === planId) {
            workingData = stash.data;
            restored = true;
          }
        }
      } catch (e) {}
      document.body.classList.add("tf-editing");
      editing = true;
      setDirty(restored);
      if (restored) {
        showToast("已還原上次未儲存的變更");
      }
      bar.classList.add("show");
      fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg><span class="label-stack"><span class="zh">結束</span><span class="en">EXIT</span></span>`;
      placeFab();
      decorate();
      document.dispatchEvent(new CustomEvent("tf:edit-enter", { detail: { workingData } }));
    } catch (e) {
      showToast("載入失敗：" + e.message);
    } finally {
      fab.disabled = false;
    }
  }

  function exitEditAsk() {
    if (dirty && !confirm("有未儲存的變更，確定要結束編輯？")) return;
    intentionalReload();
  }

  // ---------- Decorations ----------
  // We used to inject "編輯快速連結" / "編輯備註區塊" blocks per-day. The
  // user found them redundant — the read-only display below already shows
  // the same content, and adding editor chrome above duplicates the UI.
  // Decoration is now a no-op for those fields; they remain editable via
  // collect()'s tolerant "if block exists" check (the blocks just don't
  // exist any more). Re-enable by re-introducing decorateDayLinks/Details
  // calls below if a future iteration brings the editor UI back.
  function decorate() {
    /* All day-level edit blocks (qlinks, details, retreat) are now
       intentionally disabled. Per user direction:
         - quick_links: edited inline via render.js's renderQLinks
           (commit 8d0b46a) — no separate "編輯快速連結" block.
         - retreat: 撤退方案的設定仰賴休息點 Table 設定即可，不需要
           獨立的「編輯撤退時間」這樣的區塊. The render path keeps
           reading day.retreat for any HTML pre-baked into plan-data;
           future retreat-from-rest-points derivation TBD.
         - details: not yet brought back; tagged as future work. */
  }

  // ---- retreat editor (per day, inside elevation pane) ----
  // Schema preserved as items_html (matches existing render path). On read we
  // parse <div class="ret-i" style="background:..."> rows back into rich rows
  // {kind:'time'|'note', time:'HH:MM', text:'…', severity:'critical'|'warn'|'note'};
  // on save we regenerate the same HTML so render.js works unchanged.
  function parseRetreatItems(items_html) {
    const out = [];
    (items_html || []).forEach((raw) => {
      const s = String(raw);
      // Try to detect "<div class=ret-i ...>...</div>"
      const m = s.match(/^<div\s+class="ret-i"([^>]*)>([\s\S]*)<\/div>\s*$/i);
      const inner = m ? m[2] : s;
      const styleAttr = m ? m[1] : "";
      let severity = "note";
      if (/#dc2626|#fee2e2|#fecaca/i.test(styleAttr)) severity = "critical";
      else if (/#d97706|#fef3c7|#fde68a|#fcd34d/i.test(styleAttr)) severity = "warn";
      // Try to peel "⏰ HH:MM" + remaining
      let time = "", text = "";
      const tm = inner.match(/⏰\s*(\d{1,2}:\d{2})\s*(.*?)(?:<\/b>|$)/i);
      if (tm) {
        time = tm[1];
        text = stripTags(tm[2] + inner.slice(inner.indexOf("</b>") + 4));
      } else {
        text = stripTags(inner);
      }
      out.push({
        kind: time ? "time" : "note",
        time, text: text.trim(), severity,
      });
    });
    return out;
  }
  function stripTags(s) {
    const t = document.createElement("div");
    t.innerHTML = String(s);
    return (t.textContent || "").replace(/\s+/g, " ").trim();
  }
  function buildRetreatItem(row) {
    const text = (row.text || "").replace(/[<>]/g, (c) => ({ "<": "&lt;", ">": "&gt;" }[c]));
    if (row.kind === "time" && row.time) {
      const bg = row.severity === "warn"
        ? "linear-gradient(180deg,#fef3c7,#fde68a);border-left-color:#d97706;"
        : "linear-gradient(180deg,#fee2e2,#fecaca);border-left-color:#dc2626;";
      return `<div class="ret-i" style="background:${bg}"><b>⏰ ${row.time}</b> ${text}</div>`;
    }
    return `<div class="ret-i"><b>${text}</b></div>`;
  }

  function decorateDayRetreat(panel, day) {
    if (panel.querySelector(".tf-rt-block")) return;
    // Anchor: shanghe-block if exists, else mode-shell, else first child
    const anchor = panel.querySelector(".shanghe-block") || panel.querySelector(".mode-shell") || panel.firstChild;
    if (!anchor) return;
    const block = document.createElement("div");
    block.className = "tf-edit-block tf-rt-block";
    block.dataset.dayId = day.id;
    const r = day.retreat || {};
    block.innerHTML = `
      <div class="blk-head">
        <span>編輯撤退時間</span>
        <span class="blk-day">${esc(day.label || day.id)}</span>
      </div>
      <div class="tf-rt-title-wrap">
        <input type="text" class="tf-rt-title" placeholder="撤退方案標題（如：Day 2 撤退方案）" value="${attr(r.title || "")}">
      </div>
      <div class="tf-rt-rows"></div>
      <div class="tf-rt-foot">
        <button type="button" class="tf-row-add tf-rt-add-time">＋ 新增關鍵時間</button>
        <button type="button" class="tf-row-add tf-rt-add-note">＋ 新增備註</button>
      </div>
      <div class="tf-rt-hint">關鍵時間使用紅色（嚴重）／琥珀色（警告）背景；備註為純文字。</div>
    `;
    // Insert after anchor's parent's anchor (so the editor sits BELOW the
    // shanghe block within the elevation pane).
    anchor.parentNode.insertBefore(block, anchor.nextSibling);

    const rowsHost = block.querySelector(".tf-rt-rows");
    parseRetreatItems(r.items_html).forEach((row) => rowsHost.appendChild(makeRetreatRow(row)));

    block.querySelector(".tf-rt-title").addEventListener("input", () => setDirty(true));
    block.querySelector(".tf-rt-add-time").addEventListener("click", () => {
      rowsHost.appendChild(makeRetreatRow({ kind: "time", time: "", text: "", severity: "critical" }));
      setDirty(true);
    });
    block.querySelector(".tf-rt-add-note").addEventListener("click", () => {
      rowsHost.appendChild(makeRetreatRow({ kind: "note", text: "" }));
      setDirty(true);
    });
  }

  function makeRetreatRow(row) {
    const wrap = document.createElement("div");
    wrap.className = "tf-rt-row tf-rt-row-" + (row.kind || "time");
    wrap.dataset.kind = row.kind || "time";
    if (row.kind === "time") {
      wrap.innerHTML = `
        <select class="tf-rt-sev" aria-label="嚴重程度">
          <option value="critical" ${row.severity !== "warn" ? "selected" : ""}>🔴 嚴重</option>
          <option value="warn" ${row.severity === "warn" ? "selected" : ""}>🟡 警告</option>
        </select>
        <input type="time" class="tf-rt-time" value="${attr(row.time || "")}" required>
        <input type="text" class="tf-rt-text" placeholder="例：未登頂主峰 → 立即折返排雲" value="${attr(row.text || "")}">
        <button type="button" class="tf-row-del" aria-label="刪除">×</button>`;
    } else {
      wrap.innerHTML = `
        <span class="tf-rt-tag">備註</span>
        <input type="text" class="tf-rt-text" placeholder="例：天候惡劣請立即折返" value="${attr(row.text || "")}">
        <button type="button" class="tf-row-del" aria-label="刪除">×</button>`;
    }
    wrap.querySelectorAll("input, select").forEach((i) => i.addEventListener("input", () => setDirty(true)));
    wrap.querySelector(".tf-row-del").addEventListener("click", () => { wrap.remove(); setDirty(true); });
    return wrap;
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
      // retreat times — read from per-day editor block, regenerate items_html
      const rtBlock = document.querySelector(`.tf-rt-block[data-day-id="${cssEscape(day.id)}"]`);
      if (rtBlock) {
        const title = rtBlock.querySelector(".tf-rt-title").value.trim();
        const items = [];
        rtBlock.querySelectorAll(".tf-rt-row").forEach((row) => {
          const kind = row.dataset.kind;
          const text = (row.querySelector(".tf-rt-text")?.value || "").trim();
          if (kind === "time") {
            const time = (row.querySelector(".tf-rt-time")?.value || "").trim();
            const severity = (row.querySelector(".tf-rt-sev")?.value || "critical");
            if (!time && !text) return;
            items.push(buildRetreatItem({ kind, time, text, severity }));
          } else {
            if (!text) return;
            items.push(buildRetreatItem({ kind, text }));
          }
        });
        if (title || items.length) {
          // Preserve existing title_color/title_border if user left them; else
          // pick sensible defaults that match the demo.
          const prev = day.retreat || {};
          day.retreat = {
            title: title || prev.title || "撤退方案",
            title_color: prev.title_color || "#dc2626",
            title_border: prev.title_border || "#dc2626",
            items_html: items,
            raw_html: true,
          };
        } else {
          day.retreat = null;
        }
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
    // Run any externally-registered collectors (contacts, gear, etc.).
    for (const fn of collectors) {
      try {
        const patch = fn(data);
        if (patch && typeof patch === "object") Object.assign(data, patch);
      } catch (e) { console.warn("[tf-edit] collector failed:", e); }
    }
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
        // queueOnly path: edit is now in the upload queue. Don't reload —
        // keep the user's edits visible until they tap 上傳 to push. Save
        // chip goes dormant (not dirty), upload pill takes over the "you have
        // pending action" signal via its own count badge + breath animation.
        setDirty(false);
        showToast("已暫存於本機。請點右上「⬆ 上傳」推送到伺服器。");
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = "儲存";
        return;
      }
      // Auth required — token missing/expired. Stash unsaved data so the user
      // doesn't lose work when redirected to auth, then jump.
      if (r.status === 401) {
        stashPendingAndRedirect(data, "尚未登入或登入已過期。登入後將自動還原你的變更。");
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + r.status);
      }
      // Successful save — clear stash + frozen snapshot, then SOFT refresh
      // (no page reload, so user stays in edit mode + scroll position +
      // open inline forms aren't torn down). The data we just sent IS
      // already in window.__PLAN__ (collect() mutated through it), so we
      // only need to refresh derived UI: rest-points, chart, and any
      // module that listens for tf:plan-loaded.
      clearPendingFor(planId);
      try { localStorage.removeItem("tf_pwa_frozen_" + planId); } catch (e) {}
      setDirty(false);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = "儲存";
      showToast("已儲存");
      try { document.dispatchEvent(new CustomEvent("tf:plan-saved", { detail: { plan: window.__PLAN__ } })); } catch (e) {}
      try { if (window.TF && TF.render) TF.render(window.__PLAN__); } catch (e) {}
      try { if (window.TF && TF.modeToggle && TF.modeToggle.refreshAll) TF.modeToggle.refreshAll(); } catch (e) {}
    } catch (e) {
      // Network failure: stash locally so the next session can recover.
      const offline = e && /Failed to fetch|NetworkError|TypeError/i.test(e.message || "");
      if (offline) {
        stashPendingAndRedirect(data, "目前無法連線到伺服器，變更已暫存於本機。", { redirect: false });
      } else {
        showToast("儲存失敗：" + e.message);
      }
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = "儲存";
    }
  }

  // Stash unsaved edit data in localStorage keyed by planId; on auth-required
  // we redirect to auth.html with ?next=<this URL> so we come back here after
  // the user logs in. enterEdit() picks up any stash on the next visit.
  function stashPendingAndRedirect(data, msg, opts) {
    const o = opts || {};
    try {
      const stash = { at: Date.now(), planId, data,
                      title: data && data.meta && data.meta.title || null };
      localStorage.setItem("tf_pending_edit_" + planId, JSON.stringify(stash));
    } catch (e) { /* quota / disabled storage — fall through */ }
    if (msg) showToast(msg);
    if (o.redirect === false) return;
    const params = new URLSearchParams(location.search);
    const apiVal = params.get("api");
    const here = location.pathname + location.search;
    const qs = new URLSearchParams();
    if (apiVal) qs.set("api", apiVal);
    qs.set("next", here);
    if (window.tfMarkIntentionalNav) window.tfMarkIntentionalNav();
    setTimeout(() => { location.href = "auth.html?" + qs.toString(); }, 900);
  }
  function clearPendingFor(id) {
    try { localStorage.removeItem("tf_pending_edit_" + id); } catch (e) {}
  }

  bar.addEventListener("click", (e) => {
    if (e.target.id === "tfEditSave") save();
    if (e.target.id === "tfEditCancel" || e.target.id === "tfEditClose") {
      if (dirty && !confirm("放棄所有未儲存的變更？")) return;
      intentionalReload();
    }
  });
  // Esc dismisses the bar (and exits edit mode after confirm-if-dirty)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!editing) return;
    if (dirty && !confirm("放棄所有未儲存的變更？")) return;
    intentionalReload();
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
