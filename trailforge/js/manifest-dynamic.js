/* Trailforge — per-plan PWA manifest.
 *
 * When the page is opened with ?plan=<id>, replace the static manifest with
 * a Blob-URL manifest whose name / short_name / start_url are tailored to
 * THAT plan. Browsers identify installed PWAs by (origin, start_url), so
 * installing while viewing plan A and later plan B yields two distinct app
 * icons on the home screen.
 *
 * Without ?plan, the static manifest.json is left untouched (covers the
 * "demo / unauthenticated visitor" install path).
 */
(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  const planId = params.get("plan");
  if (!planId) return;

  // Wait for render.js to populate window.__PLAN__ (set after the API GET
  // /api/plans/<id> resolves). Fall back to <script id="plan-data"> if API
  // didn't fire (offline or token expired).
  let pollHandle = null;
  let attempts = 0;
  function readPlan() {
    if (window.__PLAN__) return window.__PLAN__;
    const tag = document.getElementById("plan-data");
    if (tag) {
      try { return JSON.parse(tag.textContent); } catch {}
    }
    return null;
  }

  function shorten(s, n) {
    if (!s) return "";
    return [...s].slice(0, n).join("");
  }

  function buildManifest(plan) {
    const meta = (plan && plan.meta) || {};
    const title = meta.title || "Trailforge 計劃書";
    const short = meta.short_name || shorten(title, 12);
    return {
      name: title,
      short_name: short,
      start_url: "./index.html?plan=" + encodeURIComponent(planId),
      scope: "./",
      display: "standalone",
      orientation: "portrait",
      background_color: meta.background_color || "#f4eddc",
      theme_color: meta.theme_color || "#1e3a1a",
      lang: meta.lang || "zh-TW",
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
      // a UID makes the manifest URL stable per-plan when cached by browser/OS
      id: "/trailforge/?plan=" + encodeURIComponent(planId),
    };
  }

  // Replace existing manifest or inject one if missing.
  let currentBlobUrl = null;
  function applyManifest(plan) {
    const m = buildManifest(plan);
    const blob = new Blob([JSON.stringify(m)], { type: "application/manifest+json" });
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(blob);

    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.appendChild(link);
    }
    link.href = currentBlobUrl;

    // theme-color meta also drives the OS-level UI chrome on installed PWAs;
    // keep it aligned so the splash screen doesn't flash a different colour.
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc && m.theme_color) tc.content = m.theme_color;
  }

  function tick() {
    const plan = readPlan();
    if (plan) {
      applyManifest(plan);
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      return;
    }
    if (++attempts > 25) {
      // Give up after 5s; static manifest still works as fallback.
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }
  }

  // Try once immediately (covers same-tick render), then poll.
  tick();
  if (!pollHandle) pollHandle = setInterval(tick, 200);
})();
