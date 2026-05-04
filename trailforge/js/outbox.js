/* Trailforge — outbox (lightweight retry queue)
 *
 * Wraps fetches that mutate server state. If a request fails because of
 * network unreachability (fetch throws TypeError), the request body + url +
 * method are stashed in localStorage. A pinned "⬆ 上傳 (N)" pill is shown
 * top-right; clicking it tries to drain the queue.
 *
 * NOT a local plan cache. The user does not see "edited offline plans" — they
 * see "你有 N 筆暫存的修改尚未上傳" and explicitly chooses when to retry.
 *
 * Auth: drain uses the current tf_access_token (re-attached at retry time)
 * so expired-token retries surface as real 401s, not silent failures.
 */
(function () {
  "use strict";
  const KEY = "tf_outbox";
  const TOKEN_KEY = "tf_access_token";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
  }
  function save(q) {
    localStorage.setItem(KEY, JSON.stringify(q));
    renderPill();
  }
  function count() { return load().length; }

  function isNetworkError(e) {
    // fetch's TypeError: Failed to fetch / NetworkError. Distinguish from HTTP 5xx,
    // which are real server responses we should NOT auto-queue.
    return e instanceof TypeError;
  }

  /**
   * send(url, opts) — fetch with auto-queue on network failure.
   * Returns {ok, queued, status, body, error}.
   *
   * opts.queueOnly = true → skip the fetch entirely; just enqueue. Used so
   * that "儲存" only commits locally and the user must explicitly tap the
   * "上傳" pill to push edits to the backend.
   */
  async function send(url, opts) {
    const headers = { ...(opts.headers || {}) };
    // strip Authorization from anything we might persist; we always re-attach at send
    const persistedHeaders = { ...headers };
    delete persistedHeaders.Authorization;
    delete persistedHeaders.authorization;

    if (opts.queueOnly) {
      const q = load();
      q.push({
        url,
        method: (opts.method || "GET").toUpperCase(),
        headers: persistedHeaders,
        body: typeof opts.body === "string" ? opts.body : null,
        ts: Date.now(),
        label: opts.label || `${opts.method || "GET"} ${url}`,
      });
      save(q);
      return { ok: false, queued: true, queueOnly: true };
    }

    try {
      const r = await fetch(url, opts);
      let body = null;
      try { body = await r.json(); } catch {}
      return { ok: r.ok, queued: false, status: r.status, body };
    } catch (e) {
      if (!isNetworkError(e)) {
        return { ok: false, queued: false, error: String(e?.message || e) };
      }
      const q = load();
      q.push({
        url,
        method: (opts.method || "GET").toUpperCase(),
        headers: persistedHeaders,
        body: typeof opts.body === "string" ? opts.body : null,
        ts: Date.now(),
        label: opts.label || `${opts.method || "GET"} ${url}`,
      });
      save(q);
      return { ok: false, queued: true, error: e.message };
    }
  }

  /**
   * drain() — retry every queued item with the current auth token.
   * Failures (network or HTTP error) stay in the queue; successes are removed.
   */
  async function drain() {
    const q = load();
    if (q.length === 0) return { sent: 0, failed: 0, remaining: 0 };
    const tok = localStorage.getItem(TOKEN_KEY);
    const remaining = [];
    let sent = 0, failed = 0;
    for (const item of q) {
      const headers = { ...(item.headers || {}) };
      if (tok) headers["Authorization"] = "Bearer " + tok;
      try {
        const r = await fetch(item.url, {
          method: item.method,
          headers,
          body: item.body,
        });
        if (r.ok) sent++;
        else { remaining.push(item); failed++; }
      } catch {
        remaining.push(item);
        failed++;
      }
    }
    save(remaining);
    return { sent, failed, remaining: remaining.length };
  }

  // ---------------- UI pill (right-aligned alongside chip / dash-pill) ----------------
  const css = `
  .tf-outbox-pill{
    position:fixed;
    top: calc(env(safe-area-inset-top, 0px) + 10px);
    right: calc(env(safe-area-inset-right, 0px) + 10px);  /* JS adjusts after layout */
    z-index:1305;
    appearance:none; cursor:pointer; border:none;
    display:none; align-items:center; gap:7px;
    padding:6px 12px 6px 9px;
    background:linear-gradient(178deg,#fff5d6,#f0deaa);
    color:#6e5316;
    border:1px solid #6e5316;
    border-radius:999px;
    font-family:"Noto Serif TC","Songti TC",serif;
    font-size:12px; font-weight:700; letter-spacing:.16em;
    box-shadow:
      0 2px 10px rgba(168,128,44,0.25),
      inset 0 1px 0 rgba(255,255,255,0.6);
    transition:transform .18s ease, box-shadow .18s ease, background .18s ease;
  }
  .tf-outbox-pill.show{display:inline-flex}
  .tf-outbox-pill:hover{
    transform:translateY(-1px);
    background:linear-gradient(178deg,#fffbe5,#f6e7bf);
    box-shadow:0 4px 14px rgba(168,128,44,0.4), inset 0 1px 0 rgba(255,255,255,0.7);
  }
  .tf-outbox-pill:active{transform:translateY(0)}
  .tf-outbox-pill svg{width:13px; height:13px; stroke:currentColor; stroke-width:2.4; fill:none; stroke-linecap:round; stroke-linejoin:round}
  .tf-outbox-pill .num{
    background:#a8802c; color:#fffbe5;
    font-family:"JetBrains Mono",ui-monospace,monospace;
    font-size:10px; font-weight:800; letter-spacing:.04em;
    padding:1px 7px; border-radius:999px; min-width:18px; text-align:center;
  }
  .tf-outbox-pill.draining{opacity:.7; cursor:wait}
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "tf-outbox-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "tf-outbox-pill";
  pill.title = "上傳暫存的修改";
  pill.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span>上傳</span><span class="num">0</span>`;
  pill.addEventListener("click", async () => {
    if (pill.classList.contains("draining")) return;
    pill.classList.add("draining");
    const r = await drain();
    pill.classList.remove("draining");
    showToast(
      r.remaining === 0
        ? `已上傳 ${r.sent} 筆。重新載入計劃書…`
        : `${r.sent} 筆已上傳，${r.remaining} 筆仍失敗（請稍後再試）`
    );
    placePill();
    // After a clean drain, reload so the page picks up fresh server state
    // (the user's edits are now persisted; render fetches the canonical copy).
    if (r.remaining === 0 && r.sent > 0) {
      if (window.tfMarkIntentionalNav) window.tfMarkIntentionalNav();
      // Drop the dirty class first so the beforeunload guard doesn't fire
      // even if the marker race-conditions with the reload.
      document.body.classList.remove("tf-dirty");
      // Also drop the PWA frozen snapshot so the reload re-freezes with the
      // freshly-uploaded server state.
      try {
        const planId = new URLSearchParams(location.search).get("plan");
        if (planId) localStorage.removeItem("tf_pwa_frozen_" + planId);
      } catch (e) {}
      setTimeout(() => location.reload(), 600);
    }
  });

  function showToast(msg) {
    // Reuse permitToast if present (plan/auth page), else permit-pop fallback
    const t = document.getElementById("permitToast");
    if (t) {
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => t.classList.remove("show"), 2400);
      return;
    }
    // Generic toast
    let g = document.getElementById("tfOutboxToast");
    if (!g) {
      g = document.createElement("div");
      g.id = "tfOutboxToast";
      g.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
        "z-index:1500;padding:10px 16px;background:#1f3a23;color:#f4eddc;" +
        "font-family:'Noto Serif TC',serif;font-size:.92rem;border:1px solid #a8802c;" +
        "opacity:0;transition:opacity .25s;";
      document.body.appendChild(g);
    }
    g.textContent = msg;
    g.style.opacity = "1";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { g.style.opacity = "0"; }, 2400);
  }

  function renderPill() {
    const n = count();
    pill.querySelector(".num").textContent = String(n);
    pill.classList.toggle("show", n > 0);
    placePill();
  }
  function placePill() {
    // Sit to the LEFT of save chip → lang toggle → mode toggle (whichever exists
    // and is visible). Falls back to the legacy top-right strip if none found.
    const anchors = [
      document.getElementById("jmSaveChip"),
      document.getElementById("jmLangToggle"),
      document.getElementById("jmModeToggle"),
      document.querySelector(".tf-edit-fab"),
      document.querySelector(".dash-pill.show"),
      document.getElementById("dashPill"),
      document.getElementById("permitChip"),
    ];
    let anchor = null;
    for (const a of anchors) {
      if (!a) continue;
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      anchor = a; break;
    }
    if (!anchor) { pill.style.right = "10px"; return; }
    const r = anchor.getBoundingClientRect();
    pill.style.right = (window.innerWidth - r.left + 8) + "px";
  }

  function attach() {
    if (!document.body) return;
    if (!pill.isConnected) document.body.appendChild(pill);
    renderPill();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
  window.addEventListener("resize", placePill);
  window.addEventListener("online", () => {
    // gentle nudge: if there are queued items and we're back online, blink
    if (count() > 0) {
      pill.style.transform = "scale(1.06)";
      setTimeout(() => { pill.style.transform = ""; }, 220);
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) renderPill();   // cross-tab queue update
  });
  // re-place periodically in case other top-right elements shift in
  setTimeout(placePill, 300);
  setTimeout(placePill, 1000);

  // Public API
  window.TF_OUTBOX = { send, drain, count };
})();
