// Gear & Notes tab — editable checklist (裝備檢查表).
// Schema: plan.data.gear = { checklist: [...] }
// Falls back to the bundled CHECKLIST default if absent.
//
// View mode: defers to the existing renderChecklist() (per-user tick state in
// localStorage 'jm_checklist_v1').
// Edit mode: renders rows of <input> + delete button + a single trailing
// "add row" footer.
// Render is idempotent: previous footer is always wiped before rebuild.
(function () {
  "use strict";

  function defaultChecklist() {
    if (Array.isArray(window.CHECKLIST)) return window.CHECKLIST.slice();
    // Fallback for the case where CHECKLIST is a top-level `const` in a sibling
    // inline script (lexically global but not on `window`). Resolved via a
    // try/catch since direct reference would throw a ReferenceError if absent.
    try { if (Array.isArray(CHECKLIST)) return CHECKLIST.slice(); }
    catch (e) {}
    return [];
  }

  let items = [];

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

  function loadFromPlan() {
    // 1. Demo stash priority — restore prior unsaved edits.
    try {
      const raw = localStorage.getItem("tf_demo_pending");
      if (raw) {
        const stash = JSON.parse(raw);
        if (stash && stash.gear && Array.isArray(stash.gear.checklist)) {
          items = stash.gear.checklist.slice();
          window.__TF_DEMO_RESTORED__ = true;
          return;
        }
      }
    } catch (e) {}

    // 2. Fall back to plan-bound checklist or bundled defaults.
    const plan = window.__PLAN__;
    if (plan && plan.gear && Array.isArray(plan.gear.checklist) && plan.gear.checklist.length) {
      items = plan.gear.checklist.slice();
    } else {
      items = defaultChecklist();
    }
  }

  function render() {
    const editing = document.body.classList.contains("tf-editing");
    const wrap = document.getElementById("checklist");
    if (!wrap) return;
    const section = wrap.parentNode;

    // Always remove the prior footer (one or many) before rebuilding.
    section.querySelectorAll(".gk-footer").forEach((n) => n.remove());

    if (editing) {
      wrap.classList.add("editing");
      wrap.innerHTML = items.map((it, i) =>
        `<div class="gk-row">
          <input class="gk-input" type="text" data-i="${i}" value="${esc(it)}" placeholder="裝備項目">
          <button type="button" class="tf-row-del gk-del" data-i="${i}" aria-label="刪除這項">×</button>
        </div>`
      ).join("");
      const footer = document.createElement("div");
      footer.className = "gk-footer";
      footer.innerHTML = `<button type="button" class="tf-row-add gk-add">新增裝備</button>`;
      section.appendChild(footer);
      footer.querySelector(".gk-add").addEventListener("click", () => {
        items.push("");
        markDirty();
        render();
        setTimeout(() => {
          const inputs = wrap.querySelectorAll(".gk-input");
          const last = inputs[inputs.length - 1];
          if (last) last.focus();
        }, 0);
      });
      wrap.querySelectorAll(".gk-input").forEach((inp) => {
        inp.addEventListener("input", () => {
          items[+inp.dataset.i] = inp.value;
          markDirty();
        });
      });
      wrap.querySelectorAll(".gk-del").forEach((btn) => {
        btn.addEventListener("click", () => {
          items.splice(+btn.dataset.i, 1);
          markDirty();
          render();
        });
      });
    } else {
      wrap.classList.remove("editing");
      // Sync the global so the legacy renderChecklist() / toggleCK() use the
      // same list of items as edit-mode worked on.
      window.CHECKLIST = items.slice();
      if (typeof window.renderChecklist === "function") {
        try { window.renderChecklist(); } catch (e) { console.warn(e); }
      }
    }
  }

  function markDirty() {
    if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
  }

  function init() {
    loadFromPlan();
    render();
    document.addEventListener("tf:plan-loaded", () => { loadFromPlan(); render(); });

    // Re-render when tf-editing class actually toggles. Filter on oldValue so
    // unrelated body class changes don't cause noisy redraws.
    new MutationObserver((muts) => {
      for (const m of muts) {
        const old = (m.oldValue || "").includes("tf-editing");
        const now = document.body.classList.contains("tf-editing");
        if (old !== now) { render(); break; }
      }
    }).observe(document.body, {
      attributes: true, attributeFilter: ["class"], attributeOldValue: true,
    });

    // Re-render when the user opens the gear tab. openTab() now defers to us
    // explicitly, but this is a safety net for any other path that toggles
    // body[data-jm-tab].
    new MutationObserver(() => {
      if (document.body.dataset.jmTab === "split") render();
    }).observe(document.body, {
      attributes: true, attributeFilter: ["data-jm-tab"],
    });

    if (window.TF_EDIT) {
      window.TF_EDIT.onEnter(() => { loadFromPlan(); render(); });
      window.TF_EDIT.registerCollector(() => ({ gear: { checklist: items.slice() } }));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 0);
  }

  window.__TF_GEAR__ = { get items() { return items; }, render, init };
})();
