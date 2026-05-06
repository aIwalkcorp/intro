// Trailforge — Service Worker
// Strategy:
//   - HTML navigation:  network-first, fall back to cache (so users see updates online)
//   - Static assets:    stale-while-revalidate (instant load, refresh in background)
//   - Cross-origin API: passthrough, never cache (auth, /api/*)
//   - POST / non-GET:   never cache

const CACHE = 'trailforge-v84';

// Same-origin assets we want available offline on first install
const PRECACHE_LOCAL = [
  './',
  './index.html',
  './auth.html',
  './manifest.json',
  './render.js',
  './plan.json',
  './js/elevation.js',
  './js/mode-toggle.js',
  './js/edit.js',
  './js/contacts.js',
  './js/gear.js',
  './js/overview.js',
  './js/day-notes.js',
  './js/outbox.js',
  './js/gpx-io.js',
  './js/gpx-snap.js',
  './js/plan-from-gpx.js',
  './js/manifest-dynamic.js',
  './icon-192.png',
  './icon-512.png',
];

// Cross-origin assets (CDNs, fonts) — best-effort, won't fail install if any 404
const PRECACHE_REMOTE = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@300;500;700;900&family=Noto+Sans+TC:wght@300;400;500;700&family=JetBrains+Mono:wght@400;600;800&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,700;0,9..144,900;1,9..144,700&display=swap',
];

// Hosts that should NEVER be cached (auth flows, API calls)
const NO_CACHE_HOSTS = [
  'trailforge-api.fly.dev',
];

// Path prefixes that should NEVER be cached, regardless of host.
// Covers local dev (localhost:4100) and any future API hosts.
const NO_CACHE_PATH_PREFIXES = ['/api/', '/auth/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE_LOCAL).catch(() => {});
    await Promise.all(
      PRECACHE_REMOTE.map((url) =>
        fetch(url, { mode: 'no-cors' })
          .then((resp) => cache.put(url, resp))
          .catch(() => {})
      )
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isNoCacheHost(url) {
  if (NO_CACHE_HOSTS.some((h) => url.host === h)) return true;
  // Path-based exclusion catches localhost API in dev (localhost:4100/api/...)
  // and any future API host without enumerating each one.
  if (NO_CACHE_PATH_PREFIXES.some((p) => url.pathname.startsWith(p))) return true;
  return false;
}

function isHtmlRequest(req) {
  const accept = req.headers.get('accept') || '';
  return req.mode === 'navigate' || (req.method === 'GET' && accept.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  if (isNoCacheHost(url)) return;

  if (isHtmlRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const copy = fresh.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
        return new Response('離線中且無快取', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const fetchPromise = fetch(req).then((resp) => {
      if (resp && resp.status === 200 && resp.type !== 'opaqueredirect') {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});
