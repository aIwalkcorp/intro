#!/usr/bin/env bun
// One-off migration: re-calibrate the玉山 demo plan.json using the same
// OSM + haversine-snap pipeline that new GPX-driven plans use, so the
// inline demo isn't a special-case any more — it carries its own
// named_locations + gpx_anchor_idx fields just like a user-uploaded
// plan would.
//
// Reads:  trailforge/index.html  (extracts gpxDay1, gpxDay2 inline arrays)
// Reads:  trailforge/plan.json   (玉山 demo data)
// Writes: trailforge/plan.json   (adds named_locations, gpx_anchor_idx,
//                                 inline gpx_tracks for portability)
//
// Sources OSM via:
//   - https://nominatim.openstreetmap.org/search  (name lookup)
//   - https://overpass-api.de/api/interpreter     (bbox of named POIs)
//
// Both are public OSM endpoints; we identify with a User-Agent so the
// servers don't rate-limit us.
//
// Run:  cd trailforge && bun scripts/migrate-yushan-demo.ts

import { readFileSync, writeFileSync } from "node:fs";

const HTML_PATH = new URL("../index.html", import.meta.url);
const PLAN_PATH = new URL("../plan.json", import.meta.url);

const UA = "Trailforge-Migration/1.0 (https://aiwalkcorp.com; chatgpt420240311@gmail.com)";

// ─── Extract inline gpx arrays from index.html ──────────────────────
function extractInlineArray(html: string, name: string): number[][] {
  // Match `const ${name} = [...]` (single line, lots of bracket pairs).
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(\\[[^;]*?\\])\\s*;`, "s");
  const m = html.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  // The body is a JSON-like array of arrays (lat, lon, ele tuples).
  return JSON.parse(m[1]);
}

// ─── Haversine distance (m) ─────────────────────────────────────────
function haversine(a1: number, o1: number, a2: number, o2: number): number {
  const R = 6371e3;
  const dL = ((a2 - a1) * Math.PI) / 180;
  const dO = ((o2 - o1) * Math.PI) / 180;
  const a = Math.sin(dL / 2) ** 2 +
            Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
            Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Snap each named loc to closest trkpt; report the distance too ──
function snap(track: number[][], named: Record<string, { lat: number; lon: number; ele: number | null }>) {
  const out: Record<string, number> = {};
  const dist: Record<string, number> = {};
  for (const [name, loc] of Object.entries(named)) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < track.length; i++) {
      const d = haversine(loc.lat, loc.lon, track[i][0], track[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    out[name] = best;
    dist[name] = Math.round(bestD);
  }
  return { snaps: out, distances: dist };
}

// ─── Overpass ───────────────────────────────────────────────────────
async function fetchOSMAround(lat: number, lon: number, radiusKm: number) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  const south = lat - dLat, north = lat + dLat;
  const west = lon - dLon, east = lon + dLon;
  const bbox = `${south},${west},${north},${east}`;
  // Targeted tag-based query — name~regex on a 10km bbox triggers full
  // node scan and times out the public mirror. Each filter below uses
  // a tag that's already indexed.
  const query = `[out:json][timeout:60];
(
  node["natural"="peak"]["name"](${bbox});
  node["tourism"="alpine_hut"]["name"](${bbox});
  way["tourism"="alpine_hut"]["name"](${bbox});
  node["amenity"="shelter"]["name"](${bbox});
  node["hiking"="trailhead"]["name"](${bbox});
  node["highway"="trailhead"]["name"](${bbox});
  node["information"="guidepost"]["name"](${bbox});
);
out center;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
      "user-agent": UA,
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!r.ok) throw new Error(`overpass ${r.status}`);
  const j: any = await r.json();
  return j.elements as any[];
}

function elementToLocation(e: any) {
  const tags = e?.tags || {};
  const name = (tags.name || tags["name:zh"] || tags["name:zh-Hant"] || "").trim();
  if (!name) return null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const eleRaw = parseFloat(tags.ele);
  const ele = Number.isFinite(eleRaw) ? eleRaw : null;
  let kind = "other";
  if (tags.natural === "peak") kind = "peak";
  else if (tags.tourism === "alpine_hut") kind = "hut";
  else if (tags.amenity === "shelter" || tags.shelter_type) kind = "shelter";
  else if (tags.hiking === "trailhead" || /登山口$/.test(name)) kind = "trailhead";
  else if (/亭$|觀景台$|涼亭$/.test(name)) kind = "viewpoint";
  else if (/岔|分岔|交叉/.test(name)) kind = "junction";
  else if (/山莊$|山屋$|招待所$/.test(name)) kind = "hut";
  let baiyue: number | undefined;
  const refMatch = (tags.ref || "").match(/百岳#(\d+)/);
  if (refMatch) baiyue = parseInt(refMatch[1], 10);
  const out: any = {
    name, lat, lon, ele,
    source: "osm",
    osm_id: `${e.type}/${e.id}`,
    kind,
  };
  if (baiyue) out["百岳"] = baiyue;
  if (tags.wikipedia) out.wikipedia = tags.wikipedia;
  return out;
}

// ─── Fuzzy name matching (segments use slightly different naming) ───
function normalizeName(s: string): string {
  return String(s || "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[路巷弄段]+$/g, "")
    .replace(/\s+/g, "");
}
// Score how well an OSM entry matches a segment name. Higher = better.
// 0 = no match (caller should skip). Encodes:
//   - exact normalized-name match → 1000
//   - segment ⊂ OSM (the OSM name has extra suffix qualifiers) → 500
//     minus 10 per extra char (prefer shorter, closer matches)
//   - OSM ⊂ segment (OSM uses the short canonical, e.g. "玉山" for
//     "玉山主峰") → 400 minus 10 per missing char
//   - then a kind-aware penalty: if the segment name implies a peak/
//     hut/trailhead/etc. but the OSM entry is a different kind (e.g. a
//     junction node that happens to share a name prefix), apply a
//     hefty penalty so a peak-named query doesn't accidentally land on
//     a junction.
function scoreMatch(segName: string, osm: any): number {
  const n1 = normalizeName(segName);
  const n2 = normalizeName(osm.name);
  if (!n1 || !n2) return 0;
  let base = 0;
  if (n1 === n2) base = 1000;
  else if (n2.includes(n1)) base = 500 - (n2.length - n1.length) * 10;
  else if (n1.includes(n2)) base = 400 - (n1.length - n2.length) * 10;
  else return 0;

  // Kind preferences inferred from segment name suffix
  const isPeak       = /(峰|山岳|岳)$/.test(segName) || /^[一二三四五六七八九十百千]?[南北東西中]?[峰山]$/.test(segName);
  const isHut        = /山莊$|山屋$|招待所$|宿舍$/.test(segName);
  const isTrailhead  = /登山口$/.test(segName);
  const isJunction   = /岔|分岔|交叉/.test(segName);
  const isViewpoint  = /亭$|觀景台$|涼亭$/.test(segName);

  if (isPeak && osm.kind !== "peak") base -= 250;
  if (isHut && osm.kind !== "hut") base -= 200;
  if (isTrailhead && osm.kind !== "trailhead" && !/登山口/.test(osm.name)) base -= 200;
  if (isJunction && osm.kind !== "junction") base -= 150;
  if (isViewpoint && osm.kind !== "viewpoint") base -= 100;

  return base;
}

// ─── Main ───────────────────────────────────────────────────────────
const html = readFileSync(HTML_PATH, "utf-8");
const gpxDay1 = extractInlineArray(html, "gpxDay1");
const gpxDay2 = extractInlineArray(html, "gpxDay2");
console.log(`extracted gpxDay1 (${gpxDay1.length} pts), gpxDay2 (${gpxDay2.length} pts)`);

const plan = JSON.parse(readFileSync(PLAN_PATH, "utf-8"));

// 1. Fetch OSM POIs in 10 km bbox around 玉山主峰 (≈ 23.470, 120.957).
//    Need 10 km to cover 玉山登山口 at lat 23.476, lon 120.900 (~5.9 km
//    from the peak in great-circle distance).
console.log("fetching OSM POIs around 玉山主峰…");
const osmRaw = await fetchOSMAround(23.470, 120.957, 10);
console.log(`OSM returned ${osmRaw.length} elements`);

const namedAll: Record<string, any> = {};
const seenName = new Set<string>();
for (const el of osmRaw) {
  const loc = elementToLocation(el);
  if (!loc) continue;
  if (seenName.has(loc.name)) continue;
  seenName.add(loc.name);
  namedAll[loc.name] = loc;
}
console.log(`unique named POIs: ${Object.keys(namedAll).length}`);

// 2. Collect every unique segment.from / .to from the demo plan
const segmentNames = new Set<string>();
for (const day of plan.days || []) {
  const ep = day.elevation_profile;
  if (!ep) continue;
  for (const s of ep.shanghe_segments || []) {
    if (s.from) segmentNames.add(s.from);
    if (s.to)   segmentNames.add(s.to);
  }
  // Variants too
  if (ep.route_variants) {
    for (const v of Object.values(ep.route_variants) as any[]) {
      for (const s of v.shanghe_segments || []) {
        if (s.from) segmentNames.add(s.from);
        if (s.to)   segmentNames.add(s.to);
      }
    }
  }
}
console.log("segment endpoints in demo:", [...segmentNames]);

// 3. Resolve each segment name. Priority for the玉山 demo:
//    (a) curated checkpointsData inline (author placed these by hand —
//        they are the ground truth for this specific plan)
//    (b) OSM (for points not in curated, or to enrich curated entries
//        with osm_id / 百岳 / wikipedia metadata)
//    (c) manual fallback (only 主北岔 — no OSM node, no inline entry
//        with that exact key)
//
// New plans uploaded by users go OSM-first via /api/mountains/around;
// the migration here is a one-off because checkpointsData already
// captures what the plan author put on the map.
function extractCheckpointsData(html: string) {
  const re = /const\s+checkpointsData\s*=\s*(\[[\s\S]*?\])\s*;/;
  const m = html.match(re);
  if (!m) return [];
  const jsLit = m[1]
    .replace(/\/\/[^\n]*/g, "")        // strip // line comments inside the literal
    .replace(/(\{|,)\s*([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(jsLit);
  } catch (e) {
    console.warn("checkpointsData parse failed:", e);
    return [];
  }
}
function parseElevString(s: any): number | null {
  if (typeof s === "number") return s;
  if (s == null || s === "") return null;
  const str = String(s).replace(/,/g, "").trim();
  if (/K$/i.test(str)) {
    const n = parseFloat(str);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}
const checkpointsData = extractCheckpointsData(html);
console.log(`extracted ${checkpointsData.length} curated checkpoints from index.html`);

// Pass A: curated checkpointsData first (primary for玉山 demo)
const resolved: Record<string, any> = {};
const unresolved: string[] = [];
for (const segName of segmentNames) {
  let best: any = null;
  let bestScore = 0;
  for (const c of checkpointsData) {
    // checkpointsData entries don't have OSM-style "kind" — use a generic
    // kind so scoreMatch's kind penalties don't kick in.
    const s = scoreMatch(segName, { name: c.label, kind: "any" });
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (best && bestScore > 0) {
    resolved[segName] = {
      name: best.label,
      lat: best.lat,
      lon: best.lon,
      ele: parseElevString(best.elev),
      source: "curated_inline",
      _matched_to: segName,
    };
  } else {
    unresolved.push(segName);
  }
}
console.log("resolved (curated checkpointsData):");
for (const [k, v] of Object.entries(resolved)) {
  console.log(`  ${k.padEnd(20)} → "${v.name}" (${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}) ele=${v.ele}`);
}

// Pass B: OSM enrichment — overwrite source to 'osm' + add osm_id /
// 百岳 / wikipedia where the OSM peak coordinates closely match the
// curated entry (within 200 m). Lat/lon stays from curated since
// that's what the plan author intended.
let enriched = 0;
for (const [segName, cur] of Object.entries(resolved)) {
  let bestOsm: any = null;
  let bestOsmScore = 0;
  for (const loc of Object.values(namedAll) as any[]) {
    const s = scoreMatch(segName, loc);
    if (s > bestOsmScore) { bestOsmScore = s; bestOsm = loc; }
  }
  if (!bestOsm) continue;
  const dist = haversine(cur.lat, cur.lon, bestOsm.lat, bestOsm.lon);
  if (dist > 200) continue;  // OSM match is for a different physical place
  cur.osm_id = bestOsm.osm_id;
  cur.kind = bestOsm.kind;
  if (bestOsm.ele && !cur.ele) cur.ele = bestOsm.ele;
  if (bestOsm["百岳"]) cur["百岳"] = bestOsm["百岳"];
  if (bestOsm.wikipedia) cur.wikipedia = bestOsm.wikipedia;
  enriched++;
}
console.log(`enriched ${enriched} entries with OSM metadata`);

// Pass C: anything still unresolved — try OSM straight (e.g. names that
// curated checkpointsData doesn't carry but OSM does)
for (const segName of unresolved.slice()) {
  let bestOsm: any = null;
  let bestOsmScore = 0;
  for (const loc of Object.values(namedAll) as any[]) {
    const s = scoreMatch(segName, loc);
    if (s > bestOsmScore) { bestOsmScore = s; bestOsm = loc; }
  }
  if (bestOsm && bestOsmScore > 200) {
    resolved[segName] = { ...bestOsm, _matched_to: segName };
    unresolved.splice(unresolved.indexOf(segName), 1);
  }
}
if (unresolved.length) {
  console.log(`\nstill unresolved (${unresolved.length}):`, unresolved);
}

// 4. Build named_locations dict keyed by SEGMENT name (so segments find them)
const namedLocations: Record<string, any> = {};
for (const [segName, loc] of Object.entries(resolved)) {
  namedLocations[segName] = {
    lat: loc.lat,
    lon: loc.lon,
    ele: loc.ele,
    source: loc.source,
    osm_id: loc.osm_id,
    kind: loc.kind,
  };
  if (loc["百岳"]) namedLocations[segName]["百岳"] = loc["百岳"];
  if (loc.wikipedia) namedLocations[segName].wikipedia = loc.wikipedia;
}

// Manually add 主北岔(風口) — OSM only has signposts there, not the
// junction itself. We approximate from one of the signposts ("←排雲1.4K")
// which is sub-200m from the actual saddle.
if (!namedLocations["主北岔(風口)"]) {
  namedLocations["主北岔(風口)"] = {
    lat: 23.4694, lon: 120.9558, ele: 3800,
    source: "manual",
    note: "approximated from OSM signpost cluster — not a single OSM node",
  };
  console.log('added manual 主北岔(風口) (no OSM node exists for the saddle)');
}

// 5. Build gpx_anchor_idx from segment.anchor_idx values (per-ref).
//    The single haversine snap is unreliable when a name appears at
//    MULTIPLE trkpt indices in the same gpx (e.g. d2's 排雲山莊 at
//    idx 0 and idx 800 — start and end of the loop). For each (ref,
//    name): if every segment endpoint that references the name agrees
//    on a single anchor_idx (within 50 pts tolerance for stitching
//    drift), record it; otherwise skip — segment-level anchor_idx
//    stays authoritative. We then sanity-check by snapping the named
//    coordinate to the gpx and warning if the snap is far from the
//    declared anchor_idx (indicates curated data may be stale).
function collectPerRefAnchors(plan: any) {
  const out: Record<string, Record<string, Set<number>>> = {};
  for (const day of plan.days || []) {
    const ep = day.elevation_profile;
    if (!ep || !ep.gpx_ref) continue;
    const ref = ep.gpx_ref;
    out[ref] = out[ref] || {};
    const segLists = [
      ep.shanghe_segments || [],
      ...(ep.route_variants ? Object.values(ep.route_variants).map((v: any) => v.shanghe_segments || []) : []),
    ];
    for (const segs of segLists) {
      for (const s of segs as any[]) {
        if (!Array.isArray(s.anchor_idx) || s.anchor_idx.length !== 2) continue;
        if (s.from) (out[ref][s.from] ||= new Set()).add(s.anchor_idx[0]);
        if (s.to)   (out[ref][s.to]   ||= new Set()).add(s.anchor_idx[1]);
      }
    }
  }
  return out;
}

const perRef = collectPerRefAnchors(plan);
const gpxAnchorIdx: Record<string, Record<string, number>> = {};
const skippedMulti: string[] = [];
for (const [ref, names] of Object.entries(perRef)) {
  gpxAnchorIdx[ref] = {};
  for (const [name, idxSet] of Object.entries(names)) {
    const arr = [...idxSet].sort((a, b) => a - b);
    const spread = arr[arr.length - 1] - arr[0];
    if (arr.length > 1 && spread > 50) {
      skippedMulti.push(`${ref}/${name} (${arr.join(",")})`);
      continue;
    }
    // Single-occurrence (or near-cluster) — record the median idx
    gpxAnchorIdx[ref][name] = arr[Math.floor(arr.length / 2)];
  }
}
console.log("\ngpx_anchor_idx (single-occurrence only):");
for (const [ref, m] of Object.entries(gpxAnchorIdx)) {
  console.log(`  ${ref}:`, m);
}
if (skippedMulti.length) {
  console.log(`skipped multi-occurrence (segment.anchor_idx remains authoritative): ${skippedMulti.join(", ")}`);
}

// 6. Sanity check: snap named coords against gpx and warn if the
//    declared anchor_idx is far from the closest trkpt to the curated
//    lat/lon. >100m gap suggests the lat/lon or the anchor_idx is
//    stale and the demo could use a manual fix.
function trackForRef(ref: string): number[][] | null {
  if (ref === "d1") return gpxDay1;
  if (ref === "d2") return gpxDay2;
  return null;
}
console.log("\nsanity check — declared anchor_idx vs nearest-trkpt to curated lat/lon:");
for (const [ref, m] of Object.entries(gpxAnchorIdx)) {
  const track = trackForRef(ref);
  if (!track) continue;
  for (const [name, idx] of Object.entries(m)) {
    const loc = namedLocations[name];
    if (!loc) continue;
    const cur = track[idx];
    const distAtIdx = haversine(loc.lat, loc.lon, cur[0], cur[1]);
    const tag = distAtIdx > 100 ? "  ⚠️ " : "      ";
    console.log(`${tag}${ref} ${name.padEnd(20)} idx=${String(idx).padStart(4)} ${Math.round(distAtIdx)}m`);
  }
}

// 7. Write into plan.json (preserving existing fields, adding new ones)
plan.named_locations = namedLocations;
plan.gpx_anchor_idx  = gpxAnchorIdx;

writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2));
console.log("\n✓ plan.json updated with named_locations + gpx_anchor_idx");
