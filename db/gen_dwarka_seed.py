#!/usr/bin/env python3
"""Generate db/seed_dwarka.sql — Dwarka, New Delhi ANPR network.

REALISTIC per-approach camera model: each junction gets ONE camera per connected
road (its real approaches), positioned ~25 m back from the junction along that
approach and facing the INCOMING traffic — exactly how ANPR is deployed. Camera
links are through-movements (arrival at J from I -> arrival at K from J), i.e. the
road segment J->K, so a plate's consecutive sightings map onto real links.

Junctions come from an explicit curated list (snapped to real roads via OSRM);
their adjacency is a nearest-neighbour mesh bridged into one connected component;
each junction edge is routed along real roads via OSRM.

Run: python3 db/gen_dwarka_seed.py   (needs network). Applying the output
TRUNCATEs the network — STOP the pipeline workers first.
"""
import json
import math
import subprocess
import time
from pathlib import Path

OSRM = "https://router.project-osrm.org"
OFFSET_M = 22.0         # camera set-back from the junction along its approach (a few m)
MIN_CLEAR = 16.0        # min straight-line clearance so a camera never sits on the junction
MAX_ARC = 70.0          # never set a camera back further than this (prevents overshoot)
LAT_M = 5.0             # lateral offset onto the incoming (left) carriageway

PLATES_TRIP = "DL3CAB1234"
PLATE_BLACK = "DL8CAF5678"

# Explicit curated junction set (label, lat, lon). Empty label -> named from the
# snapped road. Coords are approximate; each is snapped to the nearest real road.
USER_POINTS = [
    ("Dwarka Mor",                 28.619035, 77.031604),
    ("Azad Hind Fauj Marg (north)",28.606204, 77.035627),
    ("Azad Hind Fauj Marg (south)",28.601849, 77.042208),
    ("Sector 13 (north)",          28.595355, 77.036515),
    ("Sector 13 (south)",          28.592758, 77.034389),
    ("Sector 14 / Vegas Mall",     28.599697, 77.029488),
    ("KM Chowk",                   28.592108, 77.046116),
    ("Sector 11",                  28.587581, 77.042327),
    ("Sector 13/14 corner",        28.596670, 77.049931),
    ("Palam Najafgarh Road",       28.603458, 77.055721),
    ("Sector 10",                  28.591491, 77.057784),
    ("Rd 224 (south)",             28.586308, 77.065467),
    ("Rd 224 (mid)",               28.590778, 77.069232),
    ("Rd 224 (north)",             28.594659, 77.071697),
    ("Sector 17",                  28.581808, 77.061651),
    # newly added junctions (approx coords; snapped + labelled from road)
    ("",                           28.598420, 77.063715),
    ("",                           28.577145, 77.057713),
    ("",                           28.582473, 77.050029),
]


def curl(url, data=None):
    cmd = ["curl", "-s", "--max-time", "60", url]
    if data:
        cmd += ["--data-urlencode", data]
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def haversine(a, b):  # (lat, lon)
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0]); dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):  # (lat, lon) -> compass degrees for direction a->b
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return round((math.degrees(math.atan2(x, y)) + 360) % 360)


def move(lat, lon, brng, d):  # move point d metres along compass bearing -> (lat, lon)
    R = 6371000.0
    br = math.radians(brng); dr = d / R
    la = math.radians(lat); lo = math.radians(lon)
    la2 = math.asin(math.sin(la) * math.cos(dr) + math.cos(la) * math.sin(dr) * math.cos(br))
    lo2 = lo + math.atan2(math.sin(br) * math.sin(dr) * math.cos(la),
                          math.cos(dr) - math.sin(la) * math.sin(la2))
    return math.degrees(la2), math.degrees(lo2)


def snap(lat, lon):
    """OSRM nearest -> on-road (lon, lat) + street name."""
    try:
        d = json.loads(curl(f"{OSRM}/nearest/v1/driving/{lon},{lat}"))
        wp = d["waypoints"][0]; loc = wp["location"]
        return round(loc[0], 6), round(loc[1], 6), (wp.get("name") or "").strip()
    except Exception:
        return round(lon, 6), round(lat, 6), ""


def route(a, b):  # a,b = (name,lon,lat) with lon@1, lat@2
    d = json.loads(curl(f"{OSRM}/route/v1/driving/{a[1]},{a[2]};{b[1]},{b[2]}"
                        f"?overview=full&geometries=geojson"))
    rt = d["routes"][0]
    return rt["geometry"]["coordinates"], round(rt["distance"]), max(1, round(rt["duration"]))


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def point_at_arc(pts, s):
    """Point at arc-length s from the junction end (pts[-1]) walking outward, plus
    the (near, far) segment vertices it lies on (near = toward junction)."""
    acc = 0.0
    for k in range(len(pts) - 1, 0, -1):
        near_k, far_k = pts[k], pts[k - 1]
        d = haversine((near_k[1], near_k[0]), (far_k[1], far_k[0]))
        if acc + d >= s:
            t = (s - acc) / d if d > 0 else 0.0
            return (near_k[0] + (far_k[0] - near_k[0]) * t, near_k[1] + (far_k[1] - near_k[1]) * t), (near_k, far_k)
        acc += d
    return pts[0], (pts[min(1, len(pts) - 1)], pts[0])


def approach(coords, end_is_last):
    """Camera on the INCOMING (left) carriageway, a few metres before the junction
    end of `coords`, ON the road. Start at arc OFFSET_M; if still too close to the
    junction (roundabout/curve) step outward until clear, capped at MAX_ARC so it
    never overshoots. Local road tangent for heading + left-side lateral offset.
    Returns (lon, lat, travel_dir) = incoming heading toward the junction."""
    pts = coords if end_is_last else coords[::-1]   # pts[-1] = junction approached
    jx = pts[-1]
    s = OFFSET_M
    pos, (near, far) = point_at_arc(pts, s)
    while haversine((pos[1], pos[0]), (jx[1], jx[0])) < MIN_CLEAR and s < MAX_ARC:
        s += 4.0
        pos, (near, far) = point_at_arc(pts, s)
    td = bearing((far[1], far[0]), (near[1], near[0]))     # local travel dir toward junction
    la, lo = move(pos[1], pos[0], (td - 90) % 360, LAT_M)  # onto the left carriageway
    return round(lo, 6), round(la, 6), td


def main():
    # ---- Junctions: snap the curated list to real roads ----
    JUNC = []   # (name, lon, lat)
    for label, lat, lon in USER_POINTS:
        slon, slat, rd = snap(lat, lon); time.sleep(0.25)
        nm = label or (f"{rd} junction" if rd else "Dwarka junction")
        JUNC.append((nm[:60], slon, slat))
        print(f"snapped {nm} -> {slat:.5f},{slon:.5f} ({rd or 'road'})")
    n = len(JUNC)

    def jpt(i):
        return (JUNC[i][2], JUNC[i][1])  # (lat, lon)

    # ---- Road-based adjacency (NOT aerial): A-B is a DIRECT link iff the OSRM
    # road route A->B passes close to NO other junction; otherwise the road really
    # runs A-...-C-...-B and those sub-segments are the real links. Aerial distance
    # is used ONLY as a coarse prune to skip far pairs, never to decide adjacency. ----
    PASS_M = 45.0            # a junction this close to a route lies ON it
    PRUNE_M = 2600.0         # skip obviously-far pairs (performance only)
    seg = {}
    for i in range(n):
        for j in range(i + 1, n):
            if haversine(jpt(i), jpt(j)) > PRUNE_M:
                continue
            coords, dist, ff = route(("", JUNC[i][1], JUNC[i][2]), ("", JUNC[j][1], JUNC[j][2]))
            time.sleep(0.2)
            through = any(
                k not in (i, j) and
                min(haversine(jpt(k), (c[1], c[0])) for c in coords) < PASS_M
                for k in range(n))
            if not through:
                seg[(i, j)] = (coords, dist, ff)
    pairs = set(seg.keys())

    # Ensure one connected component; bridge by shortest ROAD route between components.
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    def union(a, b):
        parent[find(a)] = find(b)
    for (i, j) in pairs:
        union(i, j)
    while len({find(i) for i in range(n)}) > 1:
        cross = sorted(((i, j) for i in range(n) for j in range(i + 1, n) if find(i) != find(j)),
                       key=lambda p: haversine(jpt(p[0]), jpt(p[1])))
        best = None
        for (i, j) in cross[:8]:
            coords, dist, ff = route(("", JUNC[i][1], JUNC[i][2]), ("", JUNC[j][1], JUNC[j][2]))
            time.sleep(0.2)
            if best is None or dist < best[1]:
                best = ((i, j), dist, (coords, dist, ff))
        (i, j), _, data = best
        seg[(i, j)] = data; pairs.add((i, j)); union(i, j)

    # ---- Per-approach cameras: one arrival camera at each end of each edge ----
    cam_of = {}   # (junction j, from-neighbour i) -> camera index
    CAM = []      # (code, name, lon, lat, facing, travel_dir)
    cam_junc = [] # camera index -> junction index (the junction it guards)
    for (i, j) in sorted(pairs):
        coords, dist, ff = seg[(i, j)]
        lon, lat, td = approach(coords, True)    # arrival at j, from i (i->j flow)
        cam_of[(j, i)] = len(CAM); cam_junc.append(j)
        CAM.append((None, f"{JUNC[j][0]} <- {JUNC[i][0]}"[:60], lon, lat, (td + 180) % 360, td))
        lon, lat, td = approach(coords, False)   # arrival at i, from j (j->i flow)
        cam_of[(i, j)] = len(CAM); cam_junc.append(i)
        CAM.append((None, f"{JUNC[i][0]} <- {JUNC[j][0]}"[:60], lon, lat, (td + 180) % 360, td))
    CAM = [(f"CAM-{k + 1:02d}", nm, lon, lat, fac, td) for k, (_, nm, lon, lat, fac, td) in enumerate(CAM)]
    sb = sorted(haversine((CAM[k][3], CAM[k][2]), jpt(cam_junc[k])) for k in range(len(CAM)))
    print(f"set-back from junction (m): min {sb[0]:.0f}, median {sb[len(sb)//2]:.0f}, max {sb[-1]:.0f}")
    code_at = {jk: CAM[idx][0] for jk, idx in cam_of.items()}

    # ---- Through-links: arrival at j from i -> arrival at k from j (segment j->k) ----
    adjj = {}
    for (i, j) in pairs:
        adjj.setdefault(i, set()).add(j); adjj.setdefault(j, set()).add(i)
    links = []  # (from_code, to_code, geometry_dict, dist, ff)
    for j in range(n):
        nb = list(adjj.get(j, []))
        for i in nb:
            for k in nb:
                if i == k:
                    continue
                coords, dist, ff = seg[(min(j, k), max(j, k))]
                jk = coords if j < k else coords[::-1]
                links.append((code_at[(j, i)], code_at[(k, j)],
                              {"type": "LineString", "coordinates": jk}, dist, ff))
    print(f"{n} junctions, {len(pairs)} roads -> {len(CAM)} approach cameras, {len(links)} through-links")

    # ---- Trajectory: walk junction graph; sighting at each = arrival cam from predecessor ----
    path, cur, seen = [0], 0, {0}
    while len(path) < min(7, n):
        cand = [x for x in adjj.get(cur, []) if x not in seen]
        if not cand:
            break
        nxt = min(cand, key=lambda x: haversine(jpt(cur), jpt(x)))
        path.append(nxt); seen.add(nxt); cur = nxt
    trip = [cam_of[(path[t], path[t - 1])] for t in range(1, len(path))]
    ffs = [seg[(min(path[t - 1], path[t]), max(path[t - 1], path[t]))][2] for t in range(1, len(path))]
    offs = [0]
    for f in ffs:
        offs.append(offs[-1] + round(f * 1.15))
    total = offs[-1]
    b1 = trip[0]
    b2 = max(range(len(CAM)), key=lambda x: haversine((CAM[b1][3], CAM[b1][2]), (CAM[x][3], CAM[x][2])))

    # ---- Emit SQL ----
    out = []; w = out.append
    w("-- ============================================================================")
    w("-- DEV/DEMO SEED — Dwarka, New Delhi. GENERATED by db/gen_dwarka_seed.py.")
    w("-- REALISTIC per-approach cameras: one camera per road arriving at each")
    w("-- junction, offset ~25m back and facing incoming traffic. Links are through-")
    w("-- movements (arrival at J from I -> arrival at K from J). OSRM-routed.")
    w("-- Re-runnable; TRUNCATEs the network — STOP the pipeline workers first.")
    w("-- ============================================================================")
    w("BEGIN;")
    w("TRUNCATE cameras, roads, plates, camera_links, sightings, blacklist_entries,")
    w("         alerts, camera_metrics_5m, traffic_metrics_5m RESTART IDENTITY CASCADE;")
    w("")
    w("INSERT INTO roads (road_code, name) VALUES ('DWK-NET-1', 'Dwarka Sector Network');")
    w("")
    w("INSERT INTO cameras (camera_code, display_name, location, heading_degrees, status) VALUES")
    w(",\n".join(f"  ({sql_str(c)}, {sql_str(nm)}, ST_SetSRID(ST_MakePoint({lon}, {lat}), 4326), {fac}, 'active')"
                 for c, nm, lon, lat, fac, td in CAM) + ";")
    w("")
    for fc, tc, g, dist, ff in links:
        geo = json.dumps(g).replace("'", "''")
        w("INSERT INTO camera_links (from_camera_id, to_camera_id, road_id, direction_label, "
          "path, distance_meters, free_flow_time_seconds, speed_limit_kph)")
        w(f"SELECT f.camera_id, t.camera_id, r.road_id, 'through',")
        w(f"       ST_SetSRID(ST_GeomFromGeoJSON('{geo}'), 4326), {dist}, {ff}, 50")
        w("FROM cameras f, cameras t, roads r")
        w(f"WHERE f.camera_code={sql_str(fc)} AND t.camera_code={sql_str(tc)} AND r.road_code='DWK-NET-1';")
    w("")
    w(f"INSERT INTO plates (normalized_plate) VALUES ({sql_str(PLATES_TRIP)}), ({sql_str(PLATE_BLACK)});")
    w("")
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    tr = []
    for k, idx in enumerate(trip):
        code, td = CAM[idx][0], CAM[idx][5]
        tr.append(f"  ({sql_str('seed-'+PLATES_TRIP+'-'+code)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(code)}), "
                  f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATES_TRIP)}), "
                  f"{sql_str(PLATES_TRIP)}, {sql_str(PLATES_TRIP)}, 0.96, 0.93, '[]'::jsonb, 'accepted', "
                  f"now() - make_interval(secs => {total - offs[k]}), {td}, 'car', 'white', 2, 'anpr-v1')")
    w("VALUES\n" + ",\n".join(tr) + ";")
    w("")
    c1, h1 = CAM[b1][0], CAM[b1][5]
    c2, h2 = CAM[b2][0], CAM[b2][5]
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    w("VALUES\n" + ",\n".join([
        f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c1)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c1)}), "
        f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
        f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
        f"now() - make_interval(secs => 600), {h1}, 'car', 'black', 3, 'anpr-v1')",
        f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c2)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c2)}), "
        f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
        f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
        f"now() - make_interval(secs => 595), {h2}, 'car', 'black', 3, 'anpr-v1')"]) + ";")
    w("")
    w("INSERT INTO blacklist_entries (plate_id, reason, severity, status, added_by, case_reference)")
    w(f"SELECT plate_id, 'Reported stolen (demo)', 'high', 'active', 'seed', 'DWK-CASE-001' "
      f"FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)};")
    w("")
    w("INSERT INTO alerts (dedup_key, alert_type, sighting_id, blacklist_entry_id, status, match_confidence, details)")
    w(f"SELECT 'seed-bl-{PLATE_BLACK}', 'blacklist', s.sighting_id, b.blacklist_entry_id, 'new', 1.0, jsonb_build_object('camera',{sql_str(c1)})")
    w(f"FROM sightings s JOIN plates p ON p.plate_id=s.plate_id AND p.normalized_plate={sql_str(PLATE_BLACK)}")
    w("JOIN blacklist_entries b ON b.plate_id=p.plate_id")
    w(f"WHERE s.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c1)};")
    w("")
    w("INSERT INTO alerts (dedup_key, alert_type, sighting_id, previous_sighting_id, anomaly_reason, status, match_confidence, details)")
    w(f"SELECT 'seed-anom-{PLATE_BLACK}', 'route_anomaly', cur.sighting_id, prev.sighting_id, 'impossible_travel_time', 'new', 0.98, jsonb_build_object('observed_seconds',5)")
    w(f"FROM sightings cur JOIN sightings prev ON prev.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c1)}")
    w(f"WHERE cur.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c2)};")
    w("")
    w("COMMIT;")
    Path("db/seed_dwarka.sql").write_text("\n".join(out) + "\n")
    print(f"wrote db/seed_dwarka.sql ({len(CAM)} cameras, {len(links)} links, trip {len(trip)} sightings)")


if __name__ == "__main__":
    main()
