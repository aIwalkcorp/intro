/* Trailforge — GPX-driven plan generator
 *
 * Builds a fresh plan.data from an uploaded GPX + OSM-derived
 * named_locations. The shape mirrors the玉山 demo (so render.js +
 * mode-toggle + overview all keep working with no special-casing) but
 * every prose field — annotations, links, retreat plans, schedule
 * notes — is left BLANK for the user to fill in afterwards.
 *
 * What gets auto-populated:
 *   - meta.start_date / end_date / depart_date  (from GPX timestamps)
 *   - days[]  (one or two — split on > 4h trkpt time gap = overnight stay)
 *   - days[].schedule  (time + place name only, no notes)
 *   - days[].elevation_profile.shanghe_segments  (consecutive snapped
 *     POIs in trkpt order; distance/ascent/descent computed from track)
 *   - gpx_tracks[ref] / gpx_meta[ref] / gpx_anchor_idx[ref]
 *   - named_locations (whatever OSM gave us, snapped within tolerance)
 *
 * What stays blank for the user:
 *   - meta.title (auto-set to GPX trk name or "新計劃書"; user renames)
 *   - meta.subtitle, page_title, party_size  (defaults filled, editable)
 *   - emergency_default.standby (placeholder)
 *   - days[].quick_links / details / retreat (all empty)
 *   - schedule items' .note (omitted entirely)
 *
 * Public API:
 *   TF.planFromGpx.generate({ track, waypoints, osm_locations, gpxFilename, trkName })
 *     → { data, snaps, missing }
 *
 * Depends on TF.gpxSnap.snapAllToTrack and TF.elevation._cumDist.
 */
(function () {
  'use strict';

  const TF = (window.TF = window.TF || {});

  // ─── helpers ─────────────────────────────────────────────────────────
  function haversine(a1, o1, a2, o2) {
    const R = 6371e3;
    const dL = ((a2 - a1) * Math.PI) / 180;
    const dO = ((o2 - o1) * Math.PI) / 180;
    const a = Math.sin(dL / 2) ** 2 +
              Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) *
              Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function cumDist(track) {
    const out = [0];
    for (let i = 1; i < track.length; i++) {
      out.push(out[i - 1] + haversine(track[i-1][0], track[i-1][1], track[i][0], track[i][1]));
    }
    return out;
  }
  function trackStats(track, lo, hi) {
    let asc = 0, desc = 0;
    for (let i = Math.max(1, lo); i <= hi && i < track.length; i++) {
      const dE = (track[i][2] || 0) - (track[i-1][2] || 0);
      if (dE > 0) asc += dE;
      else        desc -= dE;
    }
    return { ascent_m: Math.round(asc), descent_m: Math.round(desc) };
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoDate(t) {
    if (!t) return null;
    const d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function dowLabel(t) {
    if (!t) return null;
    const d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return null;
    const dow = ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()];
    return `${d.getMonth()+1}/${d.getDate()} ${dow}`;
  }
  function hmLabel(t) {
    if (!t) return '';
    const d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ─── Day splitting ───────────────────────────────────────────────────
  // Look at the timestamps array (one per trkpt; may have gaps when GPS
  // off). Any gap > 4h between consecutive points is treated as an
  // overnight stay → split into two days at that index. If no timestamps
  // or no big gap, return single-day [{ lo: 0, hi: track.length-1 }].
  function detectDayBoundaries(timestamps, trackLength) {
    if (!Array.isArray(timestamps) || timestamps.length !== trackLength) {
      return [{ lo: 0, hi: trackLength - 1, startTs: null, endTs: null }];
    }
    const days = [];
    let lo = 0;
    let lastTs = timestamps[0];
    for (let i = 1; i < trackLength; i++) {
      const ts = timestamps[i];
      if (lastTs && ts) {
        const gapMs = ts.getTime() - lastTs.getTime();
        if (gapMs > 4 * 3600 * 1000) {
          // Close out current day at i-1, start new day at i
          days.push({ lo, hi: i - 1, startTs: timestamps[lo], endTs: timestamps[i - 1] });
          lo = i;
        }
      }
      lastTs = ts;
    }
    days.push({
      lo, hi: trackLength - 1,
      startTs: timestamps[lo],
      endTs: timestamps[trackLength - 1],
    });
    return days;
  }

  // ─── Build segments from snapped POIs in trkpt order ─────────────────
  // Given a day's [lo..hi] index range and a snaps map, returns segments
  // of consecutive snapped POIs ordered by their trkpt index. Each
  // segment has from/to/distance_km/ascent_m/descent_m/anchor_idx.
  function buildDaySegments(track, daySpan, snaps, namedLocations, dayId) {
    const events = [];
    for (const name of Object.keys(snaps)) {
      const idx = snaps[name];
      if (idx >= daySpan.lo && idx <= daySpan.hi) {
        events.push({ name, idx });
      }
    }
    events.sort((a, b) => a.idx - b.idx);

    const segments = [];
    for (let i = 1; i < events.length; i++) {
      const a = events[i - 1];
      const b = events[i];
      if (b.idx === a.idx) continue;
      const cd = cumDist(track.slice(a.idx, b.idx + 1));
      const distKm = cd[cd.length - 1] / 1000;
      const stats = trackStats(track, a.idx, b.idx);
      // base_minutes left null — user can fill or import from上河
      segments.push({
        id: `${dayId}-s${i - 1}`,
        from: a.name,
        to: b.name,
        base_minutes: 0,
        distance_km: +distKm.toFixed(2),
        ascent_m: stats.ascent_m,
        descent_m: stats.descent_m,
        anchor_idx: [a.idx, b.idx],
      });
    }
    return { segments, events };
  }

  // ─── Build a single day object (with玉山 demo's full shape, content blank) ───
  function buildDayBlank(opts) {
    const {
      id, dayIdx, daySpan, segments, events, snaps, namedLocations, gpxRef,
    } = opts;
    const startDate = daySpan.startTs ? isoDate(daySpan.startTs) : null;
    const dateLabel = daySpan.startTs ? dowLabel(daySpan.startTs) : `Day ${dayIdx + 1}`;

    // Schedule entries: one per snapped event, time from trkpt timestamp
    const schedule = events.map(e => {
      const ts = (Array.isArray(opts.timestamps) ? opts.timestamps[e.idx] : null);
      const elev = namedLocations[e.name] && namedLocations[e.name].ele;
      const item = {
        time: ts ? hmLabel(ts) : '',
        title: e.name,
      };
      if (elev != null) item.elevation = `${Math.round(elev)}m`;
      return item;
    });

    // Cumulative distance + ascent for the day's tag
    const dayCd = cumDist(opts.track.slice(daySpan.lo, daySpan.hi + 1));
    const dayKm = (dayCd[dayCd.length - 1] || 0) / 1000;
    const dayStats = trackStats(opts.track, daySpan.lo, daySpan.hi);
    const tagText = `${dayKm.toFixed(1)} KM ｜ +${dayStats.ascent_m} M`;

    // Direction: ascent_only when ascent > descent + 100m, else out_and_back
    let direction = 'out_and_back';
    if (dayStats.ascent_m > dayStats.descent_m + 100) direction = 'ascent_only';
    else if (dayStats.descent_m > dayStats.ascent_m + 100) direction = 'descent_only';

    // Summit: highest-elevation event in the day (or null if none)
    let summitIdx = null, summitLabel = null;
    let maxEle = -Infinity;
    for (const e of events) {
      const ele = namedLocations[e.name] && namedLocations[e.name].ele;
      if (ele != null && ele > maxEle) {
        maxEle = ele;
        summitIdx = e.idx;
        summitLabel = e.name;
      }
    }

    return {
      id,
      date: startDate,
      date_label: dateLabel,
      label: `Day ${dayIdx + 1}`,
      tag: dayIdx === 0 ? 'd1' : null,
      tag_text: tagText,
      tag_color_override: null,
      summary: null,
      stats: null,
      section_title: `Day ${dayIdx + 1}`,
      emergency_card_title: `🚨 Day ${dayIdx + 1} 關鍵時間`,
      key_times: [],
      quick_links: [],
      schedule,
      details: [],
      retreat: null,
      elevation_profile: {
        gpx_ref: gpxRef,
        color: dayIdx === 0 ? '#1e3a1a' : '#8b2a1f',
        fill: dayIdx === 0 ? 'rgba(30,58,26,0.20)' : 'rgba(139,42,31,0.18)',
        label: 'GPX 軌跡',
        shanghe_segments: segments,
        summit_idx: summitIdx,
        summit_label: summitLabel,
        direction,
      },
    };
  }

  // ─── Main generator ──────────────────────────────────────────────────
  // Inputs:
  //   track:         [[lat, lon, elev], ...]  — already simplified to ≤800 points
  //   timestamps:    [Date|null, ...]         — parallel array, one per trkpt (optional)
  //   waypoints:     [{lat, lon, ele, name}]  — from <wpt> in GPX (optional)
  //   osm_locations: same shape as named_locations dict — from /api/mountains/around
  //   gpxFilename:   string — file basename for ref naming
  //   trkName:       string — <trk><name> from GPX, used as initial plan title
  // Output:
  //   { data: planData, snaps, missing }
  function generate(input) {
    const {
      track,
      timestamps = [],
      waypoints = [],
      osm_locations = {},
      gpxFilename = 'gpx_main.gpx',
      trkName = '',
    } = input || {};

    if (!Array.isArray(track) || track.length < 2) {
      throw new Error('track is required and must have at least 2 points');
    }

    // Merge waypoint sources into a unified named_locations dict.
    // Priority: OSM > GPX wpts (OSM is curated; wpts may be auto-IDs).
    const namedLocations = {};
    waypoints.forEach(w => {
      if (!w || !w.name) return;
      // Filter out auto-numbered wpt names like "0000172"
      if (/^0+\d+$/.test(w.name)) return;
      namedLocations[w.name] = {
        lat: w.lat, lon: w.lon,
        ele: (typeof w.ele === 'number') ? w.ele : null,
        source: 'gpx_wpt',
      };
    });
    Object.keys(osm_locations).forEach(name => {
      // OSM wins if same name (overwrite)
      namedLocations[name] = osm_locations[name];
    });

    // Snap named_locations onto the track
    const snap = (TF.gpxSnap && TF.gpxSnap.snapAllToTrack)
      ? TF.gpxSnap.snapAllToTrack(track, namedLocations, { maxDistanceM: 500 })
      : { snaps: {}, missing: [] };

    // Drop locations that didn't snap from the canonical dict — they
    // confuse the chart later if left in. The user can re-add them
    // manually in edit mode if they want.
    const finalNamed = {};
    Object.keys(snap.snaps).forEach(name => {
      finalNamed[name] = namedLocations[name];
    });

    // Day boundaries
    const dayBoundaries = detectDayBoundaries(timestamps, track.length);

    // Reference name for the gpx track
    const gpxRef = (gpxFilename || 'gpx_main').replace(/\.gpx$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 30) || 'gpx_main';

    // Build days
    const days = dayBoundaries.map((daySpan, dayIdx) => {
      const id = `d${dayIdx + 1}`;
      const { segments, events } = buildDaySegments(track, daySpan, snap.snaps, finalNamed, id);
      return buildDayBlank({
        id, dayIdx, daySpan, segments, events,
        snaps: snap.snaps, namedLocations: finalNamed,
        gpxRef, track, timestamps,
      });
    });

    // Trip date range
    const startDate = days[0]?.date || null;
    const endDate = days[days.length - 1]?.date || startDate;
    const departDate = startDate; // default to start; user can adjust

    // Title default: GPX trk name → fallback to filename → fallback to generic
    let title = (trkName || '').trim();
    if (!title) title = (gpxFilename || '').replace(/\.gpx$/i, '').trim();
    if (!title) title = '新計劃書';

    // Stats for gpx_meta
    const totalCd = cumDist(track);
    const totalKm = (totalCd[totalCd.length - 1] || 0) / 1000;
    const totalStats = trackStats(track, 0, track.length - 1);

    // Build the final plan.data — mirrors玉山 demo shape, content blanked
    const data = {
      version: 1,
      meta: {
        title,
        subtitle: '登山計劃書',
        start_date: startDate,
        end_date: endDate,
        depart_date: departDate,
        party_size: 1,
        party_label: '1人',
        lang: 'zh-TW',
        theme_color: '#1e3a1a',
        activity_type: 'hiking',
        page_title: title,
        short_name: title.slice(0, 8),
      },
      emergency_default: {
        standby: { name: '', phone: '', phone_tel: '' },
        messenger_url: '',
        include_112: true,
        include_119: true,
        local_emergency_label: '',
      },
      days,
      named_locations: finalNamed,
      gpx_tracks: {
        [gpxRef]: track,
      },
      gpx_meta: {
        [gpxRef]: {
          filename: gpxFilename,
          uploaded_at: new Date().toISOString(),
          ascent_m: totalStats.ascent_m,
          descent_m: totalStats.descent_m,
          ascent_only: totalStats.descent_m < 30,
          point_count: track.length,
          source: 'upload',
          distance_km: +totalKm.toFixed(2),
        },
      },
      gpx_anchor_idx: {
        [gpxRef]: snap.snaps,
      },
    };

    return {
      data,
      snaps: snap.snaps,
      missing: snap.missing,
      gpxRef,
    };
  }

  TF.planFromGpx = { generate };
})();
