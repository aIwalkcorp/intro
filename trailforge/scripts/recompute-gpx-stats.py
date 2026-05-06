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
THRESHOLD_M = 250.0  # max distance for Voronoi-style trkpt → waypoint
                     # assignment. Generous because the cell edge is
                     # determined by the nearest competing waypoint, not
                     # this radius.

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
    """Voronoi-style assignment + run detection.

    For each trkpt, find its NEAREST named loc within `threshold_m`. A
    visit is a contiguous run of trkpts assigned to the same canonical
    name; its anchor is the run's local-min idx (closest physical
    approach). This handles the 玉山 case where 主北岔(風口) and 主峰
    sit only 155m apart — a per-name fixed-threshold sweep merged ALL
    nearby trkpts into one or two huge visits, missing the saddle
    re-passes between 主峰 ↔ 北峰. Voronoi cells let 主北岔 win the
    saddle trkpts (closest) and 主峰 win the summit trkpts.

    THRESHOLD_M is now a maximum — a trkpt only gets assigned if its
    nearest waypoint is within that distance. Wider threshold + Voronoi
    is safer than narrow per-name detection because each cell's edge is
    where it's actually equidistant from neighbours, not an arbitrary
    radius."""
    n = len(track)
    assignments = [None] * n
    best_dists = [float("inf")] * n
    for name, loc in named.items():
        if loc.get("lat") is None or loc.get("lon") is None: continue
        cname = canon(name)
        for i, p in enumerate(track):
            d = haversine_m(loc["lat"], loc["lon"], p[0], p[1])
            if d < best_dists[i] and d < threshold_m:
                best_dists[i] = d
                assignments[i] = cname

    visits = []
    i = 0
    while i < n:
        if assignments[i] is None: i += 1; continue
        cur = assignments[i]
        run_min_idx = i
        run_min_dist = best_dists[i]
        while i < n and assignments[i] == cur:
            if best_dists[i] < run_min_dist:
                run_min_dist = best_dists[i]; run_min_idx = i
            i += 1
        visits.append((run_min_idx, cur))

    # Dedupe consecutive same-name (alias collisions still possible
    # after canonicalisation if there are 3-way coordinate ties).
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
def find_path(legs, fr, to, min_idx=0, max_legs_phase1=5, max_legs_phase2=10):
    """Two-phase matcher.

    Phase 1 — greedy contiguous chain (cursor-aware, idx-monotonic):
      Walk legs in idx order. From each leg starting at idx ≥ min_idx
      with from=fr, chain forward (each next leg's lo ≥ prev.hi and
      from = prev.to) until reaching `to`. Captures "user did everything
      between fr and to including any wiggle" — the natural reading of
      a plan segment when the recording is faithful.

    Phase 2 — Dijkstra shortest-km fallback (cursor-aware, sparse):
      When the recording includes detours the plan skips (e.g. D2B
      omitting the 北峰 leg), the contiguous chain runs longer than
      max_legs_phase1 without reaching `to`. Fall back to shortest-km
      path that's allowed to skip non-contiguous trkpt ranges — picks
      up the "after-detour" continuation (D2B's 主峰→排雲 jumps from
      the first 主峰 visit to the post-北峰 主峰→主北岔→排雲 chain).

    Phase 1 fixes the GPS-noise blip issue (a 0.09km mini-trip won't be
    preferred over the real 0.41km approach because the chain walks legs
    in idx order). Phase 2 fixes the plan-skips-detour case. The 5-leg
    phase-1 cap is the gate: D2A's 主北岔→北峰 uses 4 legs (passes); D2B's
    主峰→排雲 needs 8 legs to chain through the 北峰 loop (fails → phase 2)."""
    n = len(legs)

    # Phase 1: greedy idx-monotonic chain. Among all valid starts (lo ≥
    # min_idx, from = fr) that produce a chain reaching `to` within
    # max_legs_phase1, prefer:
    #   1. SHORTEST chain length — captures "user took the directest
    #      contiguous path", e.g. D2B's 主峰→排雲 picks the 2-leg
    #      [8,9] over the 4-leg [6,7,8,9] that wanders through 主北岔.
    #   2. Among ties on length, EARLIEST start — captures plan
    #      contiguity (seg N+1 picks up where seg N left off), e.g.
    #      D2B's 主北岔→主峰 picks leg[1] (the first ascent) over the
    #      noise blip leg[3] or the post-北峰 leg[7].
    best = None
    for start in range(n):
        if legs[start]["lo"] < min_idx: continue
        if legs[start]["from"] != fr: continue
        path = [start]
        cur_to = legs[start]["to"]
        nxt = start
        reached = (cur_to == to)
        if not reached:
            for _ in range(max_legs_phase1 - 1):
                found_next = -1
                for k in range(nxt + 1, n):
                    if legs[k]["lo"] < legs[nxt]["hi"]: continue
                    if legs[k]["from"] != cur_to: continue
                    found_next = k
                    break
                if found_next < 0: break
                nxt = found_next
                path.append(nxt)
                cur_to = legs[nxt]["to"]
                if cur_to == to: reached = True; break
        if not reached: continue
        # Strict shorter wins; tie on length → first-seen (earliest start
        # since we iterate `start` ascending) is kept.
        if best is None or len(path) < len(best):
            best = path
    if best is not None: return best

    # Phase 2: Dijkstra shortest-km, skip-allowed
    import heapq
    pq = []
    seen = {}
    for i, L in enumerate(legs):
        if L["from"] == fr and L["lo"] >= min_idx:
            heapq.heappush(pq, (L["km"], (i,)))
    while pq:
        km, path = heapq.heappop(pq)
        last = legs[path[-1]]
        cur = last["to"]
        if cur == to: return list(path)
        if seen.get(cur, float("inf")) <= km: continue
        seen[cur] = km
        if len(path) >= max_legs_phase2: continue
        for j, L in enumerate(legs):
            if L["from"] != cur: continue
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
        cursor = 0
        for s in segs:
            if s.get("is_rest_stop"): continue
            fr, to = canon(s["from"]), canon(s["to"])
            path = find_path(legs, fr, to, min_idx=cursor)
            reversed_ = False
            if path is None:
                path = find_path(legs, to, fr, min_idx=cursor)
                reversed_ = True
            # Fall back: ignore cursor (segment may be out-of-order, or
            # cursor advanced past all matching starts in this variant)
            if path is None:
                path = find_path(legs, fr, to, min_idx=0)
            if path is None:
                path = find_path(legs, to, fr, min_idx=0)
                reversed_ = True
            if path is None:
                print(f"  ⚠ {where}  {s['from']}→{s['to']}  no leg path found")
                continue
            # Advance cursor past the matched path's last leg
            cursor = max(cursor, legs[path[-1]]["hi"])
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

    # Write back to BOTH the inline plan-data block in index.html AND
    # plan.json. The two used to drift — auth.html clone-on-login and
    # dashboard.createPlan both fetch plan.json, so when only index.html
    # got updated the cloned plans inherited stale anchor_idx + km/↑/↓
    # values. Keep them in sync by writing both from the same `plan`
    # object every migration run.
    new_json_compact = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    out = src[:jstart] + new_json_compact + src[jend:]
    HTML.write_text(out, encoding="utf-8")
    print(f"\n✔ wrote {len(rows)} segment updates → index.html (inline plan-data)")

    # plan.json: preserve any keys it has that the inline doesn't carry
    # (e.g. _static_kept). Indented for human-readability.
    PLAN_JSON = HTML.parent / "plan.json"
    existing = {}
    try:
        if PLAN_JSON.exists():
            existing = json.loads(PLAN_JSON.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  warn: could not read existing plan.json ({e}); writing fresh")
    merged = dict(existing)
    merged.update(plan)
    PLAN_JSON.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✔ wrote                                    → plan.json (kept _static_kept etc.)")

if __name__ == "__main__":
    main()
