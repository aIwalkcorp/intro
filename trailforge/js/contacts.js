// Contacts tab — render + edit + collect.
// Schema:
//   plan.data.contacts = {
//     emergency: [{label, value}, ...],
//     members:   [{name, dob, id_no, address, phone, ec_name, ec_relation, ec_phone}, ...],
//   }
// Falls back to anonymized demo defaults if absent. Render is idempotent — call
// render() any number of times; it cleans up its own footers and rebuilds.
(function () {
  "use strict";

  const DEFAULTS = {
    emergency: [
      { label: "領隊",     value: "領隊 / 0900-000-002" },
      { label: "醫療",     value: "醫療 / 0900-000-006" },
      { label: "留守",     value: "留守 A / 0900-000-000" },
      { label: "山難管制", value: "Day2 19:00" },
      { label: "下山通知", value: "Day2 17:30" },
    ],
    members: [
      {
        name: "示範隊員", dob: "90/09/09", id_no: "A1########",
        address: "台北市信義區（地址略）",
        phone: "09##-###-###",
        ec_name: "緊急聯絡人 A", ec_relation: "親屬",
        ec_phone: "09##-###-###",
      },
    ],
  };

  // Roles match the docx 分工表 + 隊員名冊 schema (領隊 / 嚮導 / 隊員 /
  // 留守 / 交通 / 裝備 / 行政 / 回報 / 醫療 / 天氣 / 紀錄 / 保險). Used
  // by the docx exporter to fill both the leader/guide summary cells
  // and the per-row 職稱 column.
  const ROLE_OPTIONS = [
    "隊員", "領隊", "嚮導", "留守", "交通", "裝備", "行政", "回報",
    "醫療", "天氣", "紀錄", "保險",
  ];

  const FIELDS = [
    { key: "role",        label: "職稱", type: "select", options: ROLE_OPTIONS },
    { key: "name",        label: "姓名" },
    { key: "dob",         label: "生日" },
    { key: "id_no",       label: "身分證字號" },
    { key: "address",     label: "戶籍地址", wide: true },
    { key: "phone",       label: "聯絡電話" },
    { key: "ec_name",     label: "緊急聯絡人" },
    { key: "ec_relation", label: "關係" },
    { key: "ec_phone",    label: "緊急電話" },
  ];

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
  const clone = (x) => JSON.parse(JSON.stringify(x));

  let data = clone(DEFAULTS);

  function loadFromPlan() {
    // 1. Demo stash takes priority — restore unsaved edits from a prior session
    //    (page closed, jumped to auth, etc.). Cleared on successful save.
    try {
      const raw = localStorage.getItem("tf_demo_pending");
      if (raw) {
        const stash = JSON.parse(raw);
        if (stash && stash.contacts) {
          data = {
            emergency: Array.isArray(stash.contacts.emergency) ? clone(stash.contacts.emergency) : clone(DEFAULTS.emergency),
            members:   Array.isArray(stash.contacts.members)   ? clone(stash.contacts.members)   : clone(DEFAULTS.members),
          };
          // Mark restored once both modules have loaded so the user sees feedback.
          window.__TF_DEMO_RESTORED__ = true;
          return;
        }
      }
    } catch (e) {}

    // 2. Otherwise, the plan's own contacts (if loaded) or anonymized defaults.
    const plan = window.__PLAN__;
    if (plan && plan.contacts) {
      data = {
        emergency: Array.isArray(plan.contacts.emergency) ? clone(plan.contacts.emergency) : clone(DEFAULTS.emergency),
        members:   Array.isArray(plan.contacts.members)   ? clone(plan.contacts.members)   : clone(DEFAULTS.members),
      };
    } else {
      data = clone(DEFAULTS);
    }
  }

  function render() {
    const editing = document.body.classList.contains("tf-editing");
    renderEmergency(editing);
    renderMembers(editing);
  }

  // ---- Emergency contacts ----
  function renderEmergency(editing) {
    const host = document.querySelector('#tab-contact .section .info-grid');
    if (!host) return;
    const section = host.parentNode;

    // Always nuke any leftover footer (add button) before rebuilding. This
    // prevents stacking duplicates each time render() runs in edit mode.
    section.querySelectorAll(".ec-footer").forEach((n) => n.remove());

    host.innerHTML = data.emergency.map((it, i) =>
      editing ? emergencyEditRowHTML(it, i) : emergencyViewRowHTML(it, i)
    ).join("");
    host.classList.toggle("editing", editing);

    if (editing) {
      const footer = document.createElement("div");
      footer.className = "ec-footer";
      footer.innerHTML = `<button type="button" class="tf-row-add ec-add">新增聯絡項</button>`;
      section.appendChild(footer);
      footer.querySelector(".ec-add").addEventListener("click", () => {
        data.emergency.push({ label: "", value: "" });
        markDirty();
        render();
      });
      // bind inputs
      host.querySelectorAll("input[data-ec-k]").forEach((inp) => {
        inp.addEventListener("input", () => {
          const i = +inp.dataset.i, k = inp.dataset.ecK;
          data.emergency[i][k] = inp.value;
          markDirty();
        });
      });
      host.querySelectorAll(".ec-del").forEach((btn) => {
        btn.addEventListener("click", () => {
          data.emergency.splice(+btn.dataset.i, 1);
          markDirty();
          render();
        });
      });
    }
  }

  function emergencyViewRowHTML(it, i) {
    return `<div class="info-item">
      <div class="lb">${esc(it.label)}</div>
      <div class="vl">${esc(it.value)}</div>
    </div>`;
  }
  function emergencyEditRowHTML(it, i) {
    return `<div class="info-item ec-edit">
      <input class="ec-label" type="text" data-i="${i}" data-ec-k="label" value="${esc(it.label)}" placeholder="標籤">
      <input class="ec-value" type="text" data-i="${i}" data-ec-k="value" value="${esc(it.value)}" placeholder="內容">
      <button type="button" class="tf-row-del ec-del" data-i="${i}" aria-label="刪除這項">×</button>
    </div>`;
  }

  // ---- Members (personal info cards) ----
  function renderMembers(editing) {
    const host = document.querySelector("#tab-contact .member-cards");
    if (!host) return;
    const section = host.parentNode;

    // Drop any prior footer + hint (rebuilt below). Keeps the section clean
    // across edit/view toggles.
    section.querySelectorAll(".mc-footer").forEach((n) => n.remove());
    host.querySelectorAll(".mc-hint").forEach((n) => n.remove());

    host.innerHTML = data.members.map((m, i) => memberCardHTML(m, i, editing)).join("");
    host.classList.toggle("editing", editing);

    if (editing) {
      const footer = document.createElement("div");
      footer.className = "mc-footer";
      footer.innerHTML = `<button type="button" class="tf-row-add mc-add">新增隊員</button>`;
      section.appendChild(footer);
      footer.querySelector(".mc-add").addEventListener("click", () => {
        data.members.push({
          name: "新隊員", dob: "", id_no: "", address: "",
          phone: "", ec_name: "", ec_relation: "", ec_phone: "",
        });
        markDirty();
        render();
      });
      host.querySelectorAll(".mc-input").forEach((inp) => {
        inp.addEventListener("input", () => {
          const i = +inp.dataset.i, k = inp.dataset.k;
          data.members[i][k] = inp.value;
          if (k === "name") {
            const nm = host.querySelector(`[data-name-display="${i}"]`);
            if (nm) nm.textContent = inp.value || "（未命名）";
          }
          markDirty();
        });
      });
      host.querySelectorAll(".mc-del").forEach((btn) => {
        btn.addEventListener("click", () => {
          data.members.splice(+btn.dataset.i, 1);
          markDirty();
          render();
        });
      });
      host.querySelectorAll(".mc-crit").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = +btn.dataset.i;
          data.members[i].is_emergency = !data.members[i].is_emergency;
          markDirty();
          render();
        });
      });
    } else {
      // Add the read-only hint after the cards.
      const p = document.createElement("p");
      p.className = "mc-hint";
      p.textContent = "隊員資料為示範。請於編輯模式下逐一填入每位隊員的個資；本網頁僅在你的計劃書內保存，不會公開。";
      host.appendChild(p);
    }
  }

  function memberCardHTML(m, i, editing) {
    const num = String(i + 1).padStart(2, "0");
    const rows = FIELDS.map((f) => {
      const cls = "mc-pair" + (f.wide ? " mc-pair-wide" : "");
      if (editing) {
        const cur = m[f.key] || "";
        if (f.type === "select" && Array.isArray(f.options)) {
          const opts = ['<option value=""></option>']
            .concat(f.options.map(o => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`))
            .join("");
          return `<div class="${cls}">
            <dt>${esc(f.label)}</dt>
            <dd><select class="mc-input mc-input-select" data-i="${i}" data-k="${f.key}">${opts}</select></dd>
          </div>`;
        }
        return `<div class="${cls}">
          <dt>${esc(f.label)}</dt>
          <dd><input class="mc-input" type="text" data-i="${i}" data-k="${f.key}" value="${esc(cur)}" placeholder="${esc(f.label)}"></dd>
        </div>`;
      }
      const v = m[f.key];
      const display = v ? esc(v) : `<span class="mc-empty">—</span>`;
      return `<div class="${cls}">
        <dt>${esc(f.label)}</dt>
        <dd>${display}</dd>
      </div>`;
    }).join("");

    // 🚨 toggle — marks the member as a critical/emergency contact so
    // the docx export's 緊急聯絡 row (and the in-app 🚨 popup) lists
    // them. Active state shows the icon at full saturation; inactive
    // gets dropped to 50% grayscale to read as "off".
    const isCritical = !!m.is_emergency;
    const critBtn = editing
      ? `<button type="button" class="mc-crit${isCritical ? ' active' : ''}" data-i="${i}"
            aria-pressed="${isCritical}"
            title="${isCritical ? '從緊急聯絡名單移除' : '標記為緊急聯絡人'}">🚨</button>`
      : '';

    const head = editing
      ? `<header class="mc-head">
          <span class="mc-num">${num}</span>
          <h3 class="mc-name" data-name-display="${i}">${esc(m.name || "（未命名）")}</h3>
          ${critBtn}
          <button type="button" class="tf-row-del mc-del" data-i="${i}" aria-label="刪除這位隊員" title="刪除這位隊員">×</button>
        </header>`
      : `<header class="mc-head">
          <span class="mc-num">${num}</span>
          <h3 class="mc-name" data-name-display="${i}">${esc(m.name || "（未命名）")}</h3>
          ${isCritical ? '<span class="mc-crit-flag" title="緊急聯絡人">🚨</span>' : ''}
        </header>`;

    return `<article class="member-card${editing ? " editing" : ""}">
      ${head}
      <dl class="mc-grid">${rows}</dl>
    </article>`;
  }

  function markDirty() {
    if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
  }

  // ---- Public hookup ----
  function init() {
    loadFromPlan();
    render();
    document.addEventListener("tf:plan-loaded", () => { loadFromPlan(); render(); });
    // Re-render on any body class change (covers tf-editing toggle from any
    // source: edit.js bridge, no-auth bridge, or programmatic).
    new MutationObserver((muts) => {
      // Only re-render if the change actually affects edit-mode classes we
      // care about, to avoid noisy redraws when other scripts touch body.
      for (const m of muts) {
        const old = (m.oldValue || "").includes("tf-editing");
        const now = document.body.classList.contains("tf-editing");
        if (old !== now) { render(); break; }
      }
    }).observe(document.body, {
      attributes: true, attributeFilter: ["class"], attributeOldValue: true,
    });

    if (window.TF_EDIT) {
      window.TF_EDIT.onEnter(() => { loadFromPlan(); render(); });
      window.TF_EDIT.registerCollector(() => ({ contacts: clone(data) }));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.__TF_CONTACTS__ = { get data() { return data; }, render, init };
})();
