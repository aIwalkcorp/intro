/* Trailforge — day-notes editor
 *
 * Free-form per-day editor surfaced ONLY in planning/edit mode (海拔). Each
 * day has TWO sections:
 *
 *   1. Links  — a single chip set per day. Each chip is icon + label + url.
 *               Powers View-mode .qlinks too (hydrateViewQlinks below).
 *   2. Notes  — N free-form cards: icon + title + plain-text body.
 *
 * Seeded from day.quick_links (links) and day.details (notes) on first
 * render (handled in render.js); user edits override the seed and persist
 * to localStorage as jm_notes_<dayId> = { notes: [...], links: [...] }.
 *
 * This file binds delegated listeners on `body` so it works no matter when
 * day-panels render. It also re-applies any localStorage overrides after
 * each renderDayPanels.
 *
 * Public API
 *   TF.dayNotes.init()             — bind listeners, hydrate from cache
 *   TF.dayNotes.hydrate(rootEl?)   — re-apply localStorage overrides
 *   TF.dayNotes.dumpAll()          — { d0: {notes,links}, ... } for upload
 */
(function () {
  const TF = (window.TF = window.TF || {});
  const STORE_PREFIX = 'jm_notes_';

  // Climbing-relevant emoji palette (20). Order: lodging / payment /
  // weather / safety / nav / camp first so users grab obvious ones fast.
  const EMOJI_PALETTE = [
    '🏠', '💳', '🌦', '⛺', '🥾',
    '🗺', '🧭', '📍', '⛰', '🏔',
    '🌲', '☀️', '🌧', '❄️', '🌙',
    '🎒', '🔦', '🚨', '📞', '📝',
  ];

  // ─── store ────────────────────────────────────────────────────────────
  function readStore(dayId) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + dayId);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      // Backward-compat: older builds stored a bare array of notes.
      if (Array.isArray(v)) return { notes: v, links: [] };
      return {
        notes: Array.isArray(v.notes) ? v.notes : [],
        links: Array.isArray(v.links) ? v.links : [],
      };
    } catch (e) { return null; }
  }
  function writeStore(dayId, payload) {
    try { localStorage.setItem(STORE_PREFIX + dayId, JSON.stringify(payload)); }
    catch (e) { /* quota — silent */ }
  }
  function snapshotDay(dayId) {
    return {
      notes: snapshotNotes(dayId),
      links: snapshotLinks(dayId),
    };
  }
  function snapshotNotes(dayId) {
    const list = document.querySelector(`.dn-list[data-day-id="${cssEsc(dayId)}"]`);
    if (!list) return [];
    return [...list.querySelectorAll('.dn-card')].map(card => ({
      id:    card.dataset.noteId || '',
      icon:  card.querySelector('.dn-icon')?.textContent?.trim() || '📝',
      title: card.querySelector('.dn-title')?.textContent || '',
      body:  card.querySelector('.dn-body')?.textContent || '',
    }));
  }
  function snapshotLinks(dayId) {
    const links = document.querySelector(`.dn-links[data-day-id="${cssEsc(dayId)}"]`);
    if (!links) return [];
    return [...links.querySelectorAll('.dn-link')].map(a => ({
      href:  a.dataset.href || a.getAttribute('href') || '',
      label: a.querySelector('.dn-link-lbl')?.textContent || '',
    }));
  }
  function persist(dayId) {
    if (!dayId) return;
    writeStore(dayId, snapshotDay(dayId));
    // Keep View-mode quick-links in sync with the planning-mode link store.
    hydrateViewQlinks(dayId);
  }

  function cssEsc(s) { return String(s).replace(/"/g, '\\"'); }

  // ─── hydrate from store after render ──────────────────────────────────
  function hydrate(rootEl) {
    rootEl = rootEl || document;
    rootEl.querySelectorAll('.day-notes').forEach(block => {
      const dayId = block.dataset.dayId;
      const stored = readStore(dayId);
      if (!stored) {
        // No stored override — still mirror the seeded links into the
        // View-mode .qlinks so they stay consistent across renders.
        hydrateViewQlinks(dayId);
        return;
      }
      // Replace notes if stored
      if (stored.notes && stored.notes.length) {
        const list = block.querySelector('.dn-list');
        if (list) list.innerHTML = stored.notes.map(renderCard).join('');
      }
      // Replace links if stored (an empty stored array is a valid "user
      // deleted everything" state, so we honour it too — tested with
      // length check on stored.links presence).
      if (Array.isArray(stored.links)) {
        const linksWrap = block.querySelector('.dn-links');
        if (linksWrap) linksWrap.innerHTML = stored.links.map(renderLinkChip).join('');
      }
      hydrateViewQlinks(dayId);
    });
  }

  // Mirror the planning-mode link list into the View-mode .qlinks chip row
  // for the same day. View-mode markup lives in the same .day-panel root
  // (#day-<dayId>) and uses the .qlinks class with anchor children.
  function hydrateViewQlinks(dayId) {
    const dayPanel = document.getElementById('day-' + dayId);
    if (!dayPanel) return;
    const qlinks = dayPanel.querySelector(':scope > .qlinks');
    if (!qlinks) return;
    const links = snapshotLinks(dayId);
    if (!links.length) {
      qlinks.style.display = 'none';
      return;
    }
    qlinks.style.display = '';
    qlinks.innerHTML = links.map(L => {
      const icon = inferLinkIcon(L.href);
      const label = L.label || L.href;
      const isExt = !/^(tel:|mailto:)/i.test(L.href);
      const target = isExt ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="qlink" href="${esc(L.href)}"${target}>
        <span class="qi">${icon}</span><span>${esc(label)}</span>
      </a>`;
    }).join('');
  }

  // ─── render helpers ───────────────────────────────────────────────────
  function renderCard(n) {
    const safeIcon = esc(n.icon || '📝');
    const safeTitle = esc(n.title || '');
    const safeBody  = esc(n.body || '');
    const id = esc(n.id || ('note-' + Math.random().toString(36).slice(2, 8)));
    return `<div class="dn-card" data-note-id="${id}">
      <button type="button" class="dn-icon" data-note-id="${id}" aria-label="選擇圖示">${safeIcon}</button>
      <div class="dn-body-wrap">
        <div class="dn-title" contenteditable="plaintext-only" data-field="title" data-note-id="${id}" spellcheck="false">${safeTitle}</div>
        <div class="dn-body" contenteditable="plaintext-only" data-field="body" data-note-id="${id}" spellcheck="false">${safeBody}</div>
      </div>
      <button type="button" class="dn-del" data-note-id="${id}" aria-label="刪除備註">×</button>
    </div>`;
  }
  function renderLinkChip(L) {
    const href = String(L.href || '');
    const label = L.label || href;
    const icon = inferLinkIcon(href);
    return `<a class="dn-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-href="${esc(href)}">
      <span class="dn-link-ic">${icon}</span>
      <span class="dn-link-lbl">${esc(label)}</span>
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
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── note add / delete ────────────────────────────────────────────────
  function addNote(dayId) {
    const list = document.querySelector(`.dn-list[data-day-id="${cssEsc(dayId)}"]`);
    if (!list) return;
    const id = `${dayId}-note-${Date.now().toString(36)}`;
    const card = document.createElement('div');
    card.innerHTML = renderCard({ id, icon: '📝', title: '', body: '' });
    const newCard = card.firstElementChild;
    list.appendChild(newCard);
    requestAnimationFrame(() => {
      newCard.querySelector('.dn-title')?.focus();
    });
    persist(dayId);
  }
  function deleteNote(noteEl) {
    const card = noteEl.closest('.dn-card');
    if (!card) return;
    const list = card.closest('.dn-list');
    const dayId = list?.dataset.dayId;
    card.remove();
    if (dayId) persist(dayId);
  }

  // ─── popovers (emoji + link form) ─────────────────────────────────────
  let openPop = null;
  function closePop() { if (openPop) { openPop.remove(); openPop = null; } }

  function openEmojiPop(iconBtn) {
    closePop();
    const pop = document.createElement('div');
    pop.className = 'dn-emoji-pop';
    pop.innerHTML = EMOJI_PALETTE.map(e =>
      `<button type="button" data-emoji="${e}">${e}</button>`
    ).join('') + `<input type="text" maxlength="2" placeholder="或輸入任意 emoji…" aria-label="自訂 emoji">`;
    document.body.appendChild(pop);
    positionPopBelow(pop, iconBtn);
    openPop = pop;

    pop.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-emoji]');
      if (!btn) return;
      ev.preventDefault();
      applyEmoji(iconBtn, btn.dataset.emoji);
    });
    const input = pop.querySelector('input');
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const v = input.value.trim();
        if (v) applyEmoji(iconBtn, v);
        ev.preventDefault();
      } else if (ev.key === 'Escape') {
        closePop();
      }
    });
    armDocClick();
  }
  function applyEmoji(iconBtn, emoji) {
    iconBtn.textContent = emoji;
    closePop();
    const list = iconBtn.closest('.dn-list');
    if (list?.dataset.dayId) persist(list.dataset.dayId);
  }

  function openLinkForm(addBtn) {
    closePop();
    const pop = document.createElement('div');
    pop.className = 'dn-link-form';
    pop.innerHTML = `
      <label>顯示名稱
        <input type="text" name="label" placeholder="如:民宿電話" autocomplete="off" />
      </label>
      <label>連結
        <input type="text" name="href" placeholder="https://… 或 tel:0900-000-000 或 mailto:…" autocomplete="off" />
      </label>
      <div class="dn-link-form-actions">
        <button type="button" data-act="cancel">取消</button>
        <button type="button" data-act="save">新增</button>
      </div>
    `;
    document.body.appendChild(pop);
    positionPopBelow(pop, addBtn);
    openPop = pop;

    const labelInput = pop.querySelector('input[name="label"]');
    const hrefInput  = pop.querySelector('input[name="href"]');
    requestAnimationFrame(() => labelInput.focus());

    const commit = () => {
      const label = labelInput.value.trim();
      let href = hrefInput.value.trim();
      if (!href) { hrefInput.focus(); return; }
      if (/^[\d+\-\s()]{7,}$/.test(href) && !/^[a-z]+:/.test(href)) {
        href = 'tel:' + href.replace(/\s+/g, '');
      } else if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(href) && !/^[a-z]+:/.test(href)) {
        href = 'mailto:' + href;
      } else if (!/^[a-z]+:/i.test(href) && /\./.test(href)) {
        href = 'https://' + href;
      }
      const dayId = addBtn.dataset.dayId;
      const linksContainer = document.querySelector(`.dn-links[data-day-id="${cssEsc(dayId)}"]`);
      if (linksContainer) {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderLinkChip({ href, label: label || href });
        linksContainer.appendChild(tmp.firstElementChild);
        if (dayId) persist(dayId);
      }
      closePop();
    };

    pop.addEventListener('click', (ev) => {
      const act = ev.target.closest('button[data-act]')?.dataset.act;
      if (act === 'save')   { ev.preventDefault(); commit(); }
      if (act === 'cancel') { ev.preventDefault(); closePop(); }
    });
    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); closePop(); }
    });
    armDocClick();
  }

  function positionPopBelow(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = r.left + window.scrollX;
    let top  = r.bottom + window.scrollY + 6;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (top + popH > window.scrollY + window.innerHeight - 8) {
      top = r.top + window.scrollY - popH - 6;
    }
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  }
  function armDocClick() {
    setTimeout(() => document.addEventListener('click', onDocClick, { once: true }), 0);
  }
  function onDocClick(ev) {
    if (!openPop) return;
    if (openPop.contains(ev.target) ||
        ev.target.closest('.dn-icon') ||
        ev.target.closest('.dn-link-add')) {
      armDocClick();
      return;
    }
    closePop();
  }

  // ─── link delete ──────────────────────────────────────────────────────
  function deleteLink(delBtn) {
    const chip = delBtn.closest('.dn-link');
    if (!chip) return;
    const wrap = chip.closest('.dn-links');
    const dayId = wrap?.dataset.dayId;
    chip.remove();
    if (dayId) persist(dayId);
  }

  // ─── delegated event wiring ───────────────────────────────────────────
  function init() {
    if (init._bound) return;
    init._bound = true;

    document.body.addEventListener('click', (ev) => {
      // + 新增備註
      const addBtn = ev.target.closest('.dn-add');
      if (addBtn) {
        ev.preventDefault();
        addNote(addBtn.dataset.dayId);
        return;
      }
      // × 刪除備註
      const delBtn = ev.target.closest('.dn-del');
      if (delBtn) {
        ev.preventDefault();
        deleteNote(delBtn);
        return;
      }
      // emoji icon
      const iconBtn = ev.target.closest('.dn-icon');
      if (iconBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        openEmojiPop(iconBtn);
        return;
      }
      // × 刪除連結 — must run BEFORE the link-open handler since the delete
      // button is inside the <a>.
      const linkDel = ev.target.closest('.dn-link-del');
      if (linkDel) {
        ev.preventDefault();
        ev.stopPropagation();
        deleteLink(linkDel);
        return;
      }
      // + 新增連結
      const linkAdd = ev.target.closest('.dn-link-add');
      if (linkAdd) {
        ev.preventDefault();
        ev.stopPropagation();
        openLinkForm(linkAdd);
        return;
      }
      // Click on link chip — let the <a> default-open in new tab.
    });

    // Persist on edit (debounced via input event)
    let saveTimer = null;
    document.body.addEventListener('input', (ev) => {
      const field = ev.target.closest('.dn-title, .dn-body');
      if (!field) return;
      const list = field.closest('.dn-list');
      if (!list) return;
      const dayId = list.dataset.dayId;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist(dayId), 250);
    });

    hydrate(document);
  }

  // ─── upload payload ──────────────────────────────────────────────────
  function dumpAll() {
    const out = {};
    document.querySelectorAll('.day-notes').forEach(block => {
      const id = block.dataset.dayId;
      if (id) out[id] = snapshotDay(id);
    });
    return out;
  }

  TF.dayNotes = { init, hydrate, dumpAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // Re-hydrate after each renderDayPanels.
  function tryWrap() {
    if (TF.renderDayPanels && !TF.renderDayPanels.__notesWrapped) {
      const orig = TF.renderDayPanels;
      const wrapped = function (plan) {
        const r = orig.apply(this, arguments);
        try { hydrate(document); } catch (e) { console.warn('day-notes hydrate failed', e); }
        return r;
      };
      wrapped.__notesWrapped = true;
      TF.renderDayPanels = wrapped;
      return true;
    }
    return false;
  }
  if (!tryWrap()) {
    let tries = 0;
    const iv = setInterval(() => {
      if (tryWrap() || ++tries > 40) clearInterval(iv);
    }, 50);
  }
})();
