#!/usr/bin/env python3
# Unitizer — slice each GPX track into atomic legs between consecutive
# named-waypoint visits, then recompose per-segment stats from the
# rest-points table.
#
# The previous version of this script walked seg.anchor_idx[0..1] as a
# single slice, which broke when the recorded GPX traversed extra
# waypoints between the segment's endpoints (e.g. D2 was recorded as
# 排雲→主北岔→主峰→主北岔→北峰→主北岔→排雲, but the D2A plan claims
# 排雲→主北岔→北峰→主北岔→主峰→排雲 — segment "主峰→排雲" with
# anchor_idx [140,800] then includes the 北峰 detour, giving 7.31km).
#
# Unit-based approach:
#  1) Detect ALL waypoint visits along the track (multi-visit; a single
#     point in space can be visited many times). A visit = a contiguous
#     run of trkpts within `threshold_m` of the named loc; we keep the
#     run's local-min idx as the visit's anchor.
#  2) Order visits by idx → ordered list of leg endpoints.
#  3) Each leg is the trkpt slice between consecutive visits. Compute
#     leg's distance_km / ascent_m / descent_m from haversine+elev sums.
#  4) For each plan segment (from → to), find a sequence of legs that
#     joins the named pair (forward, OR reverse if no forward match).
#     Sum stats; replace segment metadata.
#
# Reads / writes: trailforge/index.html (in place).
import re, json, math, sys
from pathlib import Path

HTML = Path(__file__).resolve().parent.parent / "index.html"
THRESHOLD_M = 80.0  # waypoint hit radius

# ─── extract: inline arrays + plan-data + named_locations ───────────
def extract_inline_array(text: str, name: str) -> list:
    m = re.search(rf'const\s+{name}\s*=\s*(\[[^;]+\])\s*;', text, re.S)
    if not m: raise SystemExit(f"could not find {name}")
    return json.loads(m.group(1))

def extract_plan_block(text: str):
    pat = re.compile(r'(<script[^>]*id="plan-data"[^>]*>)(.+?)(</script>)', re.S)
    m = pat.search(text)
    if not m: raise SystemExit("plan-data block not found")
    return (m.group(2), json.loads(m.group(2)), m.start(2), m.end(2))

# ─── geometry ───────────────────────────────────────────────────────
def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lat2 - lat1); do = math.radians(lon2 - lon1)
    a = math.sin(dl/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(do/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def slice_stats(track, lo, hi):
    """Cumulative km / ↑ / ↓ over track[lo..hi] (lo<hi assumed)."""
    dist = asc = desc = 0.0
    for i in range(lo + 1, hi + 1):
        p0, p1 = track[i-1], track[i]
        dist += haversine_m(p0[0], p0[1], p1[0], p1[1])
        de = (p1[2] or 0) - (p0[2] or 0)
        if de > 0: asc += de
        else:      desc -= de
    return dist / 1000, asc, desc

# ─── visit detection ────────────────────────────────────────────────
# Aliases — map shorthand names to canonical named_locations keys.
# Applied at BOTH visit-detection time (so 主峰 + 玉山主峰 collapse to one
# anchor cluster) and plan-segment matching time (so 北峰→ legs match
# 玉山北峰→ segments).
ALIASES = {
    "北峰": "玉山北峰",
    "主峰": "玉山主峰",
    "主北岔": "主北岔(風口)",
}
def canon(name): return ALIASES.get(name, name)

def detect_visits(track, named, threshold_m=THRESHOLD_M):
    """Sweep track once for every named loc. A visit = contiguous run of
       trkpts within threshold; we take the local-min idx as the anchor.
       Names canonicalized via ALIASES so coordinate-equal aliases (e.g.
       主峰 vs 玉山主峰) collapse to one visit cluster instead of fighting
       at the same idx. Returns visits sorted by idx, deduped on
       consecutive same-(canon)-name."""
    visits = []
    for name, loc in named.items():
        if loc.get("lat") is None or loc.get("lon") is None: continue
        cname = canon(name)
        in_visit = False
        best_idx = -1
        best_dist = float("inf")
        for i, p in enumerate(track):
            d = haversine_m(loc["lat"], loc["lon"], p[0], p[1])
            if d < threshold_m:
                if not in_visit:
                    in_visit = True
                    best_idx = i; best_dist = d
                elif d < best_dist:
                    best_idx = i; best_dist = d
            elif in_visit:
                visits.append((best_idx, cname))
                in_visit = False; best_idx = -1; best_dist = float("inf")
        if in_visit:
            visits.append((best_idx, cname))
    visits.sort(key=lambda v: v[0])
    # Dedupe consecutive same-name visits (covers both per-name double
    # entries from re-entry within threshold and alias collisions at the
    # same idx). Within a same-name run we keep the smallest idx.
    out = []
    for v in visits:
        if out and out[-1][1] == v[1]:
            if v[0] < out[-1][0]: out[-1] = v
            continue
        out.append(v)
    return out

# ─── leg catalogue ──────────────────────────────────────────────────
def build_legs(track, visits):
    """Each leg is the trkpt slice between consecutive visits.
       Returns list of dicts {from,to,lo,hi,km,asc,desc}."""
    legs = []
    for i in range(len(visits) - 1):
        lo, fr = visits[i]
        hi, to = visits[i+1]
        if hi <= lo: continue
        km, asc, desc = slice_stats(track, lo, hi)
        legs.append({
            "from": fr, "to": to, "lo": lo, "hi": hi,
            "km": km, "asc": asc, "desc": desc,
        })
    return legs

# ─── recompose: match each plan seg to a leg sequence ───────────────
def find_path(legs, fr, to, max_legs=8):
    """BFS-shortest path through the leg DAG from `fr` to `to`, weighted
       by leg km. Each visit-pair (e.g. 主北岔↔主峰) appears as one or
       more legs; we want the path whose sum km is smallest. Solves the
       'cherry-pick around detour' case: D2B's 主峰→排雲 should pick
       leg[4]+leg[5] (1.75km) rather than detour through 北峰 (7.25km),
       even though both connect.
       Path is a chain of leg indices i1, i2, ... where legs[i1].from=fr,
       legs[i_k].to == legs[i_{k+1}].from, and legs[last].to=to. Legs
       can be reused (real hiking revisits), so this is shortest-path
       on a directed graph, not a tree-walk."""
    n = len(legs)
    # Dijkstra on leg-graph: state = current "to" name, edge cost = leg km
    import heapq
    # Initial frontier: every leg starting at `fr`
    pq = []  # (cum_km, path_indices_tuple)
    seen = {}  # name -> best cum_km seen so far
    for i, L in enumerate(legs):
        if L["from"] == fr:
            heapq.heappush(pq, (L["km"], (i,)))
    while pq:
        km, path = heapq.heappop(pq)
        last = legs[path[-1]]
        cur_name = last["to"]
        if cur_name == to: return list(path)
        if seen.get(cur_name, float("inf")) <= km: continue
        seen[cur_name] = km
        if len(path) >= max_legs: continue
        for j, L in enumerate(legs):
            if L["from"] != cur_name: continue
            heapq.heappush(pq, (km + L["km"], path + (j,)))
    return None

def stats_for_path(legs, idxs):
    km = sum(legs[i]["km"]   for i in idxs)
    asc = sum(legs[i]["asc"] for i in idxs)
    desc = sum(legs[i]["desc"] for i in idxs)
    return km, asc, desc

# ─── main ───────────────────────────────────────────────────────────
def main():
    src = HTML.read_text(encoding="utf-8")
    gpx_arrays = {
        "d1": extract_inline_array(src, "gpxDay1"),
        "d2": extract_inline_array(src, "gpxDay2"),
    }
    raw_json, plan, jstart, jend = extract_plan_block(src)
    named = plan.get("named_locations") or {}

    # Catalogue per gpx_ref
    catalogues = {}
    for ref, track in gpx_arrays.items():
        visits = detect_visits(track, named, THRESHOLD_M)
        legs = build_legs(track, visits)
        catalogues[ref] = legs
        print(f"\n== {ref}: {len(track)} pts, {len(visits)} visits, {len(legs)} legs ==")
        for v in visits:
            print(f"  visit @ idx {v[0]:>4}: {v[1]}")
        for L in legs:
            print(f"   leg {L['from']:>14} → {L['to']:<14}  idx {L['lo']:>3}→{L['hi']:>3}  {L['km']:>5.2f}km ↑{int(L['asc']):>4} ↓{int(L['desc']):>4}")

    # Walk plan segments per (day, variant), consuming legs in catalogue order
    print("\n\n== plan segment recompose ==")
    rows = []
    def process(day_id, ref, segs, where):
        legs = catalogues.get(ref, [])
        for s in segs:
            if s.get("is_rest_stop"): continue
            fr, to = canon(s["from"]), canon(s["to"])
            path = find_path(legs, fr, to)
            reversed_ = False
            if path is None:
                path = find_path(legs, to, fr)
                reversed_ = True
            if path is None:
                print(f"  ⚠ {where}  {s['from']}→{s['to']}  no leg path found")
                continue
            km, asc, desc = stats_for_path(legs, path)
            old = (s.get("distance_km",0), s.get("ascent_m",0), s.get("descent_m",0))
            new_asc, new_desc = (desc, asc) if reversed_ else (asc, desc)
            s["distance_km"] = round(km, 2)
            s["ascent_m"]    = round(new_asc)
            s["descent_m"]   = round(new_desc)
            # Replace anchor_idx with the leg sequence's lo→hi span. For
            # reversed-direction matches we expose [hi, lo] so the chart
            # walks the slice in display order.
            first, last = legs[path[0]], legs[path[-1]]
            if reversed_:
                s["anchor_idx"] = [last["hi"], first["lo"]]
            else:
                s["anchor_idx"] = [first["lo"], last["hi"]]
            rows.append((where, s["from"], s["to"], old, (s["distance_km"], s["ascent_m"], s["descent_m"]), reversed_, len(path)))

    for d in plan.get("days", []):
        ep = d.get("elevation_profile") or {}
        ref = ep.get("gpx_ref") or d["id"]
        # Each variant gets its own `used` mask — variants may share the
        # GPX but consume legs independently (D2A and D2B both walk
        # 排雲→主北岔, that's fine).
        if ep.get("shanghe_segments"):
            process(d["id"], ref, ep["shanghe_segments"], d["id"])
        for vid, v in (ep.get("route_variants") or {}).items():
            process(d["id"], ref, v.get("shanghe_segments", []), f'{d["id"]}/{vid}')

    print(f"\n{'where':<10}{'from→to':<32}{'km old→new':<22}{'↑ old→new':<18}{'↓ old→new':<14}{'rev':<5}{'legs'}")
    print("-" * 110)
    for where, fr, to, old, new, rev, nlegs in rows:
        ko, ao, do_ = old; kn, an, dn = new
        print(f"{where:<10}{fr+'→'+to:<32}{ko:>5} → {kn:<10}  {ao:>4} → {an:<8}  {do_:>4} → {dn:<8}  {'R' if rev else ' ':<4}{nlegs}")

    # Write back
    new_json = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    out = src[:jstart] + new_json + src[jend:]
    HTML.write_text(out, encoding="utf-8")
    print(f"\n✔ wrote {len(rows)} segment updates back to index.html")

if __name__ == "__main__":
    main()
