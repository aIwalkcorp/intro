#!/usr/bin/env python3
# One-shot: walk every shanghe_segment in inline plan-data, slice the
# matching gpxDay{1,2} array between segment.anchor_idx[0..1], and
# overwrite distance_km / ascent_m / descent_m with cumulative numbers.
#
# Why: hand-written endpoint deltas (e.g. 主北岔 3800m → 北峰 3858m =
# +58m) under-represent reality on undulating ridges. Cumulative GPX
# walk is what the chart already uses; segment metadata should match.
#
# Reads / writes: trailforge/index.html (in place).
# Mirrors the algorithm in overview.js's gpxStatsBetween(): haversine
# distance + sum of positive elev deltas (asc) + sum of negative deltas
# (desc) between min(ai0,ai1) and max(ai0,ai1). Reverses asc/desc when
# the seg goes backwards (ai0 > ai1) — same as the chart.
import re, json, math, sys
from pathlib import Path

HTML = Path(__file__).resolve().parent.parent / "index.html"

# ─── extract: inline gpxDay{1,2} arrays + plan-data JSON ────────────
def extract_inline_array(text: str, name: str) -> list:
    m = re.search(rf'const\s+{name}\s*=\s*(\[[^;]+\])\s*;', text, re.S)
    if not m: raise SystemExit(f"could not find {name}")
    return json.loads(m.group(1))

def extract_plan_block(text: str) -> tuple[str, dict, int, int]:
    pat = re.compile(r'(<script[^>]*id="plan-data"[^>]*>)(.+?)(</script>)', re.S)
    m = pat.search(text)
    if not m: raise SystemExit("plan-data block not found")
    return (m.group(2), json.loads(m.group(2)), m.start(2), m.end(2))

# ─── algorithm: same as overview.js gpxStatsBetween() ───────────────
def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lat2 - lat1); do = math.radians(lon2 - lon1)
    a = math.sin(dl/2)**2 + math.cos(p1) * math.cos(p2) * math.sin(do/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def gpx_stats(track, ai0, ai1):
    if ai0 is None or ai1 is None: return None
    lo, hi = min(ai0, ai1), max(ai0, ai1)
    if lo == hi or hi >= len(track) or lo < 0: return None
    dist = asc = desc = 0.0
    for i in range(lo + 1, hi + 1):
        p0, p1 = track[i-1], track[i]
        dist += haversine_m(p0[0], p0[1], p1[0], p1[1])
        de = (p1[2] or 0) - (p0[2] or 0)
        if de > 0: asc += de
        else:      desc -= de
    reversed_ = ai0 > ai1
    return {
        "distance_km": round(dist / 1000, 2),
        "ascent_m":  round(desc if reversed_ else asc),
        "descent_m": round(asc  if reversed_ else desc),
    }

# ─── main ───────────────────────────────────────────────────────────
def main():
    src = HTML.read_text(encoding="utf-8")
    gpx = {
        "d1": extract_inline_array(src, "gpxDay1"),
        "d2": extract_inline_array(src, "gpxDay2"),
    }
    raw_json, plan, jstart, jend = extract_plan_block(src)
    print(f"GPX d1: {len(gpx['d1'])} pts | d2: {len(gpx['d2'])} pts\n")

    rows = []
    def walk_segs(day_id, ref, segs, where):
        track = gpx.get(ref)
        if not track:
            return
        for s in segs:
            if s.get("is_rest_stop"):
                continue
            ai = s.get("anchor_idx")
            if not (isinstance(ai, list) and len(ai) == 2):
                continue
            stats = gpx_stats(track, ai[0], ai[1])
            if not stats:
                continue
            old = (s.get("distance_km", 0), s.get("ascent_m", 0), s.get("descent_m", 0))
            s["distance_km"] = stats["distance_km"]
            s["ascent_m"]    = stats["ascent_m"]
            s["descent_m"]   = stats["descent_m"]
            rows.append((where, s["from"], s["to"], old, stats))

    for d in plan.get("days", []):
        ep = d.get("elevation_profile") or {}
        ref = ep.get("gpx_ref") or d.get("id")
        # Default segments
        if ep.get("shanghe_segments"):
            walk_segs(d["id"], ref, ep["shanghe_segments"], d["id"])
        # Per-variant segments (D2A / D2B)
        for vid, v in (ep.get("route_variants") or {}).items():
            walk_segs(d["id"], ref, v.get("shanghe_segments", []), f'{d["id"]}/{vid}')

    # Print before/after table
    print(f"{'where':<8}{'from→to':<36}{'km old→new':<22}{'↑ old→new':<18}{'↓ old→new'}")
    print("-" * 100)
    for where, fr, to, old, new in rows:
        ko, ao, do_ = old
        kn, an, dn  = new["distance_km"], new["ascent_m"], new["descent_m"]
        print(f"{where:<8}{(fr+'→'+to):<36}{ko:>5} → {kn:<10}  {ao:>4} → {an:<8}  {do_:>4} → {dn}")

    # Write back, preserving everything except the JSON block
    new_json = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    out = src[:jstart] + new_json + src[jend:]
    HTML.write_text(out, encoding="utf-8")
    print(f"\n✔ wrote {len(rows)} segment updates back to index.html")

if __name__ == "__main__":
    main()
