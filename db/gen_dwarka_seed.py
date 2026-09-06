#!/usr/bin/env python3
"""Generate db/seed_dwarka.sql — GENUINE Dwarka, New Delhi network.

Cameras = the user's chosen sector-outline junctions (snapped to the nearest real
road via OSRM, since the given lat/lngs are approximate) PLUS extra real
traffic-signal junctions from OpenStreetMap (Overpass) to extend the outline.
Links form a MESH: each camera connects to its nearest neighbours (the sectors
are outlined, not a single corridor), routed along real roads via OSRM.

Run: python3 db/gen_dwarka_seed.py   (needs network). Applying the output
TRUNCATEs the network tables — STOP the pipeline workers first.
"""
import json
import math
import subprocess
import time
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"
OSRM = "https://router.project-osrm.org"
BBOX = "28.545,77.015,28.625,77.085"
ADD_MORE = 0            # 0 = no auto-added OSM extras (junction set is explicit below)
NEAR_M = 300            # dedup / "already covered" radius
KNN = 2                 # each camera links to its N nearest neighbours
DROP_CODES = set()      # camera codes to omit (curate via the explicit list instead)

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
    ("Palam Najafgarh Road signal",28.603458, 77.055721),
    ("Sector 10",                  28.591491, 77.057784),
    ("Rd. No. 224 signal",         28.586308, 77.065467),
    ("Rd. No. 224 signal",         28.590778, 77.069232),
    ("Rd. No. 224 signal",         28.594659, 77.071697),
    ("Dwarka signal",              28.581808, 77.061651),
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


def snap(lat, lon):
    """OSRM nearest -> on-road (lon, lat) + street name."""
    try:
        d = json.loads(curl(f"{OSRM}/nearest/v1/driving/{lon},{lat}"))
        wp = d["waypoints"][0]
        loc = wp["location"]  # [lon, lat]
        return round(loc[0], 6), round(loc[1], 6), (wp.get("name") or "").strip()
    except Exception:
        return round(lon, 6), round(lat, 6), ""


def fetch_signals():
    q = f'[out:json][timeout:50];node["highway"="traffic_signals"]({BBOX});out body;'
    d = json.loads(curl(OVERPASS, f"data={q}"))
    return [(e["lat"], e["lon"]) for e in d.get("elements", [])]


def route(a, b):  # a,b = (code,name,lon,lat)
    d = json.loads(curl(f"{OSRM}/route/v1/driving/{a[2]},{a[3]};{b[2]},{b[3]}"
                        f"?overview=full&geometries=geojson"))
    rt = d["routes"][0]
    return rt["geometry"], round(rt["distance"]), max(1, round(rt["duration"]))


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def nn_order(nodes):  # nodes = [(name,lon,lat)], nearest-neighbour tour from northernmost
    pts = nodes[:]
    start = max(range(len(pts)), key=lambda i: pts[i][2])
    order = [pts.pop(start)]
    while pts:
        last = order[-1]
        j = min(range(len(pts)), key=lambda i: haversine((last[2], last[1]), (pts[i][2], pts[i][1])))
        order.append(pts.pop(j))
    return order


def main():
    nodes = []  # (name, lon, lat)
    for label, lat, lon in USER_POINTS:
        slon, slat, rd = snap(lat, lon); time.sleep(0.3)
        nm = label or (f"{rd} junction" if rd else "Dwarka junction")
        nodes.append((nm[:60], slon, slat))
        print(f"snapped {nm} -> {slat:.5f},{slon:.5f} ({rd or 'road'})")

    # Extra real signal junctions not already covered by a user point.
    extras = []
    if ADD_MORE > 0:
        sigs = fetch_signals()
        uniq = []
        for lat, lon in sigs:
            if all(haversine((lat, lon), (n[2], n[1])) >= NEAR_M for n in nodes) and \
               all(haversine((lat, lon), (u[2], u[1])) >= NEAR_M for u in uniq):
                uniq.append(("", lon, lat))
        extras = uniq[:: max(1, len(uniq) // ADD_MORE)][:ADD_MORE] if uniq else []
        for _, lon, lat in extras:
            rd = snap(lat, lon)[2]; time.sleep(0.3)
            nodes.append((f"{rd} signal" if rd else "Dwarka signal", round(lon, 6), round(lat, 6)))
    print(f"{len(USER_POINTS)} junctions + {len(extras)} OSM extras = {len(nodes)} cameras")

    ordered = nn_order(nodes)
    CAMERAS = [(f"CAM-{i + 1:02d}", n[0][:60], n[1], n[2]) for i, n in enumerate(ordered)]
    CAMERAS = [c for c in CAMERAS if c[0] not in DROP_CODES]  # omit dropped codes; others keep theirs

    # Camera facing = bearing toward its nearest neighbour (the road it watches).
    heading = {}
    for i, ci in enumerate(CAMERAS):
        j = min((k for k in range(len(CAMERAS)) if k != i),
                key=lambda k: haversine((ci[3], ci[2]), (CAMERAS[k][3], CAMERAS[k][2])))
        heading[ci[0]] = bearing((ci[3], ci[2]), (CAMERAS[j][3], CAMERAS[j][2]))

    # KNN mesh: each camera -> KNN nearest neighbours (unordered pairs).
    pairs = set()
    for i, ci in enumerate(CAMERAS):
        dists = sorted(range(len(CAMERAS)), key=lambda j: haversine((ci[3], ci[2]), (CAMERAS[j][3], CAMERAS[j][2])) if j != i else 9e9)
        for j in dists[:KNN]:
            pairs.add((min(i, j), max(i, j)))

    edge = {}   # (i,j) -> (geometry, dist, ff)
    links = []  # (from_code, to_code, dir, geometry, dist, ff)
    for (i, j) in sorted(pairs):
        g, dist, ff = route(CAMERAS[i], CAMERAS[j]); time.sleep(0.3)
        edge[(i, j)] = (g, dist, ff)
        links.append((CAMERAS[i][0], CAMERAS[j][0], "FWD", g, dist, ff))
        g_rev = {"type": "LineString", "coordinates": g["coordinates"][::-1]}
        links.append((CAMERAS[j][0], CAMERAS[i][0], "REV", g_rev, dist, ff))
    print(f"{len(pairs)} unique edges, {len(links)} directed links")

    # Trajectory: greedy walk over the mesh from CAM-01 (each hop is a real link).
    adj = {}
    for (i, j) in pairs:
        adj.setdefault(i, []).append(j); adj.setdefault(j, []).append(i)
    trip, ffs, cur, seen = [0], [], 0, {0}
    while len(trip) < min(8, len(CAMERAS)):
        nbrs = [n for n in adj.get(cur, []) if n not in seen]
        if not nbrs:
            break
        nxt = min(nbrs, key=lambda n: haversine((CAMERAS[cur][3], CAMERAS[cur][2]), (CAMERAS[n][3], CAMERAS[n][2])))
        ffs.append(edge[(min(cur, nxt), max(cur, nxt))][2])
        trip.append(nxt); seen.add(nxt); cur = nxt
    offsets = [0]
    for ff in ffs:
        offsets.append(offsets[-1] + round(ff * 1.15))
    total = offsets[-1]

    out = []; w = out.append
    w("-- ============================================================================")
    w("-- DEV/DEMO SEED — Dwarka, New Delhi. GENERATED by db/gen_dwarka_seed.py.")
    w("-- Cameras: user-chosen sector-outline junctions (OSRM-snapped to real roads)")
    w("-- + extra real OSM traffic-signal junctions. Links: nearest-neighbour MESH,")
    w("-- OSRM-routed. Re-runnable; TRUNCATEs the network — STOP the workers first.")
    w("-- ============================================================================")
    w("BEGIN;")
    w("TRUNCATE cameras, roads, plates, camera_links, sightings, blacklist_entries,")
    w("         alerts, camera_metrics_5m, traffic_metrics_5m RESTART IDENTITY CASCADE;")
    w("")
    w("INSERT INTO roads (road_code, name) VALUES ('DWK-NET-1', 'Dwarka Sector Network');")
    w("")
    w("INSERT INTO cameras (camera_code, display_name, location, heading_degrees, status) VALUES")
    w(",\n".join(f"  ({sql_str(c)}, {sql_str(n)}, ST_SetSRID(ST_MakePoint({lng}, {lat}), 4326), {heading[c]}, 'active')"
                 for c, n, lng, lat in CAMERAS) + ";")
    w("")
    for fc, tc, dl, g, dist, ff in links:
        geo = json.dumps(g).replace("'", "''")
        w("INSERT INTO camera_links (from_camera_id, to_camera_id, road_id, direction_label, "
          "path, distance_meters, free_flow_time_seconds, speed_limit_kph)")
        w(f"SELECT f.camera_id, t.camera_id, r.road_id, {sql_str(dl)},")
        w(f"       ST_SetSRID(ST_GeomFromGeoJSON('{geo}'), 4326), {dist}, {ff}, 50")
        w("FROM cameras f, cameras t, roads r")
        w(f"WHERE f.camera_code={sql_str(fc)} AND t.camera_code={sql_str(tc)} AND r.road_code='DWK-NET-1';")
    w("")
    w(f"INSERT INTO plates (normalized_plate) VALUES ({sql_str(PLATES_TRIP)}), ({sql_str(PLATE_BLACK)});")
    w("")
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    trip_rows = []
    for k, idx in enumerate(trip):
        code = CAMERAS[idx][0]
        trip_rows.append(
            f"  ({sql_str('seed-'+PLATES_TRIP+'-'+code)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(code)}), "
            f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATES_TRIP)}), "
            f"{sql_str(PLATES_TRIP)}, {sql_str(PLATES_TRIP)}, 0.96, 0.93, '[]'::jsonb, 'accepted', "
            f"now() - make_interval(secs => {total - offsets[k]}), {heading[code]}, 'car', 'white', 2, 'anpr-v1')")
    w("VALUES\n" + ",\n".join(trip_rows) + ";")
    w("")
    c1, c2 = CAMERAS[0][0], CAMERAS[-1][0]
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    bl = [f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c1)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c1)}), "
          f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
          f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
          f"now() - make_interval(secs => 600), {heading[c1]}, 'car', 'black', 3, 'anpr-v1')",
          f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c2)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c2)}), "
          f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
          f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
          f"now() - make_interval(secs => 595), {heading[c2]}, 'car', 'black', 3, 'anpr-v1')"]
    w("VALUES\n" + ",\n".join(bl) + ";")
    w("")
    w("INSERT INTO blacklist_entries (plate_id, reason, severity, status, added_by, case_reference)")
    w(f"SELECT plate_id, 'Reported stolen (demo)', 'high', 'active', 'seed', 'DWK-CASE-001' "
      f"FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)};")
    w("")
    w("INSERT INTO alerts (dedup_key, alert_type, sighting_id, blacklist_entry_id, status, match_confidence, details)")
    w(f"SELECT 'seed-bl-{PLATE_BLACK}', 'blacklist', s.sighting_id, b.blacklist_entry_id, 'new', 1.0, "
      f"jsonb_build_object('camera',{sql_str(c1)})")
    w(f"FROM sightings s JOIN plates p ON p.plate_id=s.plate_id AND p.normalized_plate={sql_str(PLATE_BLACK)}")
    w("JOIN blacklist_entries b ON b.plate_id=p.plate_id")
    w(f"WHERE s.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c1)};")
    w("")
    w("INSERT INTO alerts (dedup_key, alert_type, sighting_id, previous_sighting_id, anomaly_reason, status, match_confidence, details)")
    w(f"SELECT 'seed-anom-{PLATE_BLACK}', 'route_anomaly', cur.sighting_id, prev.sighting_id, "
      "'impossible_travel_time', 'new', 0.98, jsonb_build_object('observed_seconds',5)")
    w(f"FROM sightings cur JOIN sightings prev ON prev.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c1)}")
    w(f"WHERE cur.source_event_id={sql_str('seed-'+PLATE_BLACK+'-'+c2)};")
    w("")
    w("COMMIT;")

    Path("db/seed_dwarka.sql").write_text("\n".join(out) + "\n")
    print(f"wrote db/seed_dwarka.sql ({len(CAMERAS)} cameras, {len(links)} links, trip {len(trip)} cams)")


if __name__ == "__main__":
    main()
