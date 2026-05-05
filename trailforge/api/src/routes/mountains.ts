import { Hono } from "hono";
import { log } from "../lib/logger";

// OSM Overpass proxy. The browser can't call Overpass directly because of
// rate-limit + CORS quirks; we proxy server-side and cache for 30 minutes
// so repeat searches in the same session don't hammer the public endpoint.
//
// Two endpoints:
//   GET /api/mountains/search?q=<text>
//     → fuzzy peak search by name, returns up to 30 candidates
//   GET /api/mountains/around?lat=<>&lon=<>&radius_km=<>
//     → all named POIs (peaks / huts / trailheads / signposts) in bbox
//
// Both return a normalized shape that the frontend can drop straight into
// plan.data.named_locations without reshaping.

const router = new Hono();

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const PER_MIRROR_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_QUERY_LEN = 60;
const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 20;
const SEARCH_RESULT_LIMIT = 30;

type CacheEntry = { ts: number; data: unknown };
const cache = new Map<string, CacheEntry>();
function cacheGet(key: string): unknown | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.data;
}
function cacheSet(key: string, data: unknown) {
  cache.set(key, { ts: Date.now(), data });
  // Trim if too big — simple FIFO since 30-min TTL bounds growth anyway
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

// Race all mirrors in parallel — first 200/JSON wins. Sequential
// failover wasted time when the first mirror returned 429/504 quickly
// (silently retried) AND when a mirror was slow (full timeout window
// per mirror). Racing collapses both failure modes to the fastest
// successful response, with a hard cap of PER_MIRROR_TIMEOUT_MS.
//
// Each attempt logs its outcome (status + ms) so we can diagnose which
// mirror is reliable from the deploy region.
async function callOverpass(query: string): Promise<any> {
  const attempts = OVERPASS_URLS.map(async (url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(PER_MIRROR_TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        log.warn("overpass_mirror_non_ok", { url, status: r.status, ms });
        throw new Error(`${url} → ${r.status}`);
      }
      const json = await r.json();
      log.info("overpass_mirror_ok", { url, ms });
      return json;
    } catch (e) {
      const ms = Date.now() - t0;
      log.warn("overpass_mirror_failed", { url, error: String(e), ms });
      throw e;
    }
  });
  // Promise.any resolves with the first fulfilled — perfect race semantics.
  // If all reject we throw an AggregateError to propagate every reason.
  try {
    return await Promise.any(attempts);
  } catch (e) {
    if (e instanceof AggregateError) {
      const reasons = e.errors.map((er: any) => String(er)).join(" | ");
      throw new Error(`all_mirrors_failed: ${reasons}`);
    }
    throw e;
  }
}

// Normalize an Overpass element (node/way/relation) into a NamedLocation.
function elementToLocation(e: any): {
  name: string;
  lat: number;
  lon: number;
  ele: number | null;
  source: "osm";
  osm_id: string;
  kind: string;
  百岳?: number;
  wikipedia?: string;
} | null {
  const tags = e?.tags || {};
  const name = (tags.name || tags["name:zh"] || tags["name:zh-Hant"] || "").trim();
  if (!name) return null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const eleRaw = parseFloat(tags.ele);
  const ele = Number.isFinite(eleRaw) ? eleRaw : null;

  // Detect the feature kind from tags so the frontend can group/icon them.
  let kind = "other";
  if (tags.natural === "peak") kind = "peak";
  else if (tags.tourism === "alpine_hut") kind = "hut";
  else if (tags.amenity === "shelter" || tags.shelter_type) kind = "shelter";
  else if (tags.hiking === "trailhead" || /登山口$/.test(name)) kind = "trailhead";
  else if (/亭$|觀景台$|涼亭$/.test(name)) kind = "viewpoint";
  else if (/岔|分岔|交叉/.test(name)) kind = "junction";
  else if (/山莊$|山屋$|招待所$/.test(name)) kind = "hut";

  // Try to surface 百岳 ranking if present in `ref` tag (OSM convention).
  let baiyue: number | undefined;
  const refMatch = (tags.ref || "").match(/百岳#(\d+)/);
  if (refMatch) baiyue = parseInt(refMatch[1], 10);

  const out: any = {
    name,
    lat, lon,
    ele,
    source: "osm",
    osm_id: `${e.type}/${e.id}`,
    kind,
  };
  if (baiyue) out["百岳"] = baiyue;
  if (tags.wikipedia) out.wikipedia = tags.wikipedia;
  return out;
}

router.get("/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ error: "missing_q" }, 400);
  if (q.length > MAX_QUERY_LEN) return c.json({ error: "q_too_long" }, 413);

  const key = `search::${q}`;
  const cached = cacheGet(key);
  if (cached) return c.json(cached);

  // Search globally — prioritize Taiwan bbox first. We split into two
  // queries because Overpass treats name~ regex globally as expensive;
  // a Taiwan-first query keeps response time tight for the common case.
  const escaped = q.replace(/[\\"]/g, "\\$&");
  const query = `[out:json][timeout:25];
(
  node["natural"="peak"]["name"~"${escaped}",i](21.0,118.0,26.5,123.0);
  node["natural"="peak"]["name:zh"~"${escaped}",i](21.0,118.0,26.5,123.0);
  node["natural"="peak"]["name"~"${escaped}",i];
);
out body ${SEARCH_RESULT_LIMIT};`;

  try {
    const json = await callOverpass(query);
    const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
    // Dedupe by osm_id (Taiwan-first query may overlap with global one).
    const seen = new Set<string>();
    const peaks = [];
    for (const el of elements) {
      const loc = elementToLocation(el);
      if (!loc) continue;
      if (seen.has(loc.osm_id)) continue;
      seen.add(loc.osm_id);
      peaks.push(loc);
      if (peaks.length >= SEARCH_RESULT_LIMIT) break;
    }
    // Sort: Taiwan first (rough bbox check), then 百岳 ranked, then by elev desc.
    peaks.sort((a: any, b: any) => {
      const aTw = a.lat >= 21 && a.lat <= 26.5 && a.lon >= 118 && a.lon <= 123 ? 1 : 0;
      const bTw = b.lat >= 21 && b.lat <= 26.5 && b.lon >= 118 && b.lon <= 123 ? 1 : 0;
      if (aTw !== bTw) return bTw - aTw;
      const aBy = a["百岳"] ?? 999;
      const bBy = b["百岳"] ?? 999;
      if (aBy !== bBy) return aBy - bBy;
      return (b.ele ?? 0) - (a.ele ?? 0);
    });

    const result = { q, count: peaks.length, peaks };
    cacheSet(key, result);
    return c.json(result);
  } catch (e) {
    log.error("mountains_search_failed", { q, error: String(e) });
    return c.json({ error: "overpass_unavailable" }, 503);
  }
});

router.get("/around", async (c) => {
  const lat = parseFloat(c.req.query("lat") || "");
  const lon = parseFloat(c.req.query("lon") || "");
  const radiusKm = Math.min(
    MAX_RADIUS_KM,
    Math.max(0.5, parseFloat(c.req.query("radius_km") || String(DEFAULT_RADIUS_KM)) || DEFAULT_RADIUS_KM),
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return c.json({ error: "invalid_lat_lon" }, 400);
  }

  const key = `around::${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}`;
  const cached = cacheGet(key);
  if (cached) return c.json(cached);

  // ~1 km in lat ≈ 0.009°; in lon at lat 23° ≈ 0.0098°. Use a small over-
  // estimate so the bbox is rectangular but still close to a circle.
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  const south = lat - dLat, north = lat + dLat;
  const west = lon - dLon, east = lon + dLon;
  const bbox = `${south},${west},${north},${east}`;

  // Pull every named POI that's likely a checkpoint:
  //   - peaks
  //   - huts / shelters
  //   - trailheads (signposts)
  //   - viewpoints / junctions / signposts whose name matches Chinese
  //     keywords for hiking landmarks
  const query = `[out:json][timeout:25];
(
  node["natural"="peak"]["name"](${bbox});
  node["tourism"="alpine_hut"]["name"](${bbox});
  way["tourism"="alpine_hut"]["name"](${bbox});
  node["amenity"="shelter"]["name"](${bbox});
  node["hiking"="trailhead"]["name"](${bbox});
  node["highway"="trailhead"]["name"](${bbox});
  node["information"="guidepost"]["name"](${bbox});
  node["name"~"登山口|山莊|山屋|觀景台|岔路|交叉|涼亭|休憩|管理站|服務站"](${bbox});
);
out center;`;

  try {
    const json = await callOverpass(query);
    const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
    const seen = new Set<string>();
    const seenName = new Set<string>();
    const locations: any[] = [];
    for (const el of elements) {
      const loc = elementToLocation(el);
      if (!loc) continue;
      if (seen.has(loc.osm_id)) continue;
      // Dedupe same name appearing as both node and way (common for huts —
      // there's a building polygon AND a label node at the same place).
      // First occurrence wins.
      if (seenName.has(loc.name)) continue;
      seen.add(loc.osm_id);
      seenName.add(loc.name);
      locations.push(loc);
    }
    // Sort: peaks first (the main attractions), then huts, then anything else;
    // within each kind by name.
    const kindRank: Record<string, number> = {
      peak: 0, hut: 1, shelter: 2, trailhead: 3, viewpoint: 4, junction: 5, other: 9,
    };
    locations.sort((a: any, b: any) => {
      const ra = kindRank[a.kind] ?? 9;
      const rb = kindRank[b.kind] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, "zh-Hant");
    });
    const result = { lat, lon, radius_km: radiusKm, count: locations.length, locations };
    cacheSet(key, result);
    return c.json(result);
  } catch (e) {
    log.error("mountains_around_failed", { lat, lon, error: String(e) });
    return c.json({ error: "overpass_unavailable" }, 503);
  }
});

export default router;
