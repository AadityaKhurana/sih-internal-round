#!/usr/bin/env python3
"""Generate db/seed_dwarka.sql — Dwarka sectors OUTLINED by camera links.

OSM has no Dwarka sector boundary polygons (sectors are only point localities),
so we DERIVE the partition: a Voronoi diagram of the sector-center points. Each
Voronoi cell is one sector; the cell's VERTICES are sector corners -> cameras;
the cell's EDGES are sector boundaries -> camera links (each sector = a closed
loop of links). Vertices are snapped to the nearest real road (OSRM nearest) and
edges are routed along real roads (OSRM route). Pure Python — no numpy/scipy.

Voronoi is built over ALL available sector centers so boundaries facing excluded
sectors are correct; cameras/links are emitted only for the SELECTED sectors.

Env DRY=1 -> compute + print topology only (no OSRM, no SQL) to validate geometry.

Run: python3 db/gen_dwarka_sectors.py       (needs network unless DRY=1)
Applying the output TRUNCATEs the network — STOP the pipeline workers first.
"""
import json
import math
import os
import re
import subprocess
import time
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"
OSRM = "https://router.project-osrm.org"
BBOX = "28.525,76.995,28.635,77.095"   # wide: capture all Dwarka sector centres
DRY = os.environ.get("DRY") == "1"

SELECTED = {"4", "5", "6", "8", "9", "10", "11", "12", "13", "14", "17", "18",
            "19", "20", "21", "22", "23", "23B", "24", "25", "26", "27", "28", "29"}

PLATES_TRIP = "DL3CAB1234"
PLATE_BLACK = "DL8CAF5678"
EPS = 1e-9


# ---------- network helpers ----------
def curl(url, data=None):
    cmd = ["curl", "-s", "--max-time", "60", url]
    if data:
        cmd += ["--data-urlencode", data]
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def fetch_sector_points():
    q = (f'[out:json][timeout:50];node["place"="locality"]["name"~"Sector",i]'
         f'({BBOX});out body;')
    d = json.loads(curl(OVERPASS, f"data={q}"))
    pts = {}
    for e in d.get("elements", []):
        m = re.search(r"Sector[\s-]*([0-9]+[A-Da-d]?)", e["tags"].get("name", ""))
        if not m:
            continue
        sid = m.group(1).upper()
        pts.setdefault(sid, (e["lat"], e["lon"]))   # first wins
    return pts


def snap(lat, lon):
    try:
        d = json.loads(curl(f"{OSRM}/nearest/v1/driving/{lon},{lat}"))
        loc = d["waypoints"][0]["location"]
        return round(loc[0], 6), round(loc[1], 6)
    except Exception:
        return round(lon, 6), round(lat, 6)


def route(a, b):  # a,b = (lon,lat)
    d = json.loads(curl(f"{OSRM}/route/v1/driving/{a[0]},{a[1]};{b[0]},{b[1]}"
                        f"?overview=full&geometries=geojson"))
    rt = d["routes"][0]
    return rt["geometry"], round(rt["distance"]), max(1, round(rt["duration"]))


# ---------- geometry ----------
def haversine(a, b):  # (lat,lon)
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0]); dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):  # (lat,lon) -> compass deg
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return round((math.degrees(math.atan2(x, y)) + 360) % 360)


def circumcenter(a, b, c):
    ax, ay = a; bx, by = b; cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < EPS:
        return None
    a2 = ax * ax + ay * ay; b2 = bx * bx + by * by; c2 = cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    return (ux, uy)


def in_circumcircle(tri, p, pts):
    cc = circumcenter(pts[tri[0]], pts[tri[1]], pts[tri[2]])
    if cc is None:
        return False
    r2 = (pts[tri[0]][0] - cc[0]) ** 2 + (pts[tri[0]][1] - cc[1]) ** 2
    return (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 < r2 - 1e-7


def bowyer_watson(pts, n):
    # super-triangle around all real points
    xs = [p[0] for p in pts[:n]]; ys = [p[1] for p in pts[:n]]
    mx = (min(xs) + max(xs)) / 2; my = (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys)) * 10 + 1
    pts.append((mx - span, my - span)); pts.append((mx + span, my - span)); pts.append((mx, my + span))
    s0, s1, s2 = n, n + 1, n + 2
    tris = [(s0, s1, s2)]
    for i in range(n):
        p = pts[i]
        bad = [t for t in tris if in_circumcircle(t, p, pts)]
        ec = {}
        for t in bad:
            for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                k = (min(e), max(e))
                ec[k] = ec.get(k, 0) + 1
        boundary = [e for e, c in ec.items() if c == 1]
        tris = [t for t in tris if t not in bad]
        for (a, b) in boundary:
            tris.append((a, b, i))
    return tris  # keep super-triangle triangles -> hull cells bounded by far circumcenters


def clip_poly(poly, xmin, ymin, xmax, ymax):
    def clip_edge(pts_in, inside, inter):
        out = []
        for i in range(len(pts_in)):
            a = pts_in[i]; b = pts_in[(i + 1) % len(pts_in)]
            ina, inb = inside(a), inside(b)
            if ina:
                out.append(a)
                if not inb:
                    out.append(inter(a, b))
            elif inb:
                out.append(inter(a, b))
        return out
    p = poly
    p = clip_edge(p, lambda q: q[0] >= xmin, lambda a, b: (xmin, a[1] + (b[1] - a[1]) * (xmin - a[0]) / (b[0] - a[0])))
    if not p: return p
    p = clip_edge(p, lambda q: q[0] <= xmax, lambda a, b: (xmax, a[1] + (b[1] - a[1]) * (xmax - a[0]) / (b[0] - a[0])))
    if not p: return p
    p = clip_edge(p, lambda q: q[1] >= ymin, lambda a, b: (a[0] + (b[0] - a[0]) * (ymin - a[1]) / (b[1] - a[1]), ymin))
    if not p: return p
    p = clip_edge(p, lambda q: q[1] <= ymax, lambda a, b: (a[0] + (b[0] - a[0]) * (ymax - a[1]) / (b[1] - a[1]), ymax))
    return p


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    sects = fetch_sector_points()
    avail = sorted(sects.keys())
    print(f"sector centres available: {len(avail)} -> {', '.join(avail)}")
    missing = sorted(SELECTED - set(avail), key=lambda s: (int(re.sub('[A-Z]','',s)), s))
    if missing:
        print(f"REQUESTED BUT NOT IN OSM (skipped): {', '.join(missing)}")

    ids = avail
    ll = [sects[s] for s in ids]                       # (lat,lon)
    lat0 = sum(p[0] for p in ll) / len(ll)
    lon0 = sum(p[1] for p in ll) / len(ll)
    kx = math.cos(math.radians(lat0)) * 111320.0; ky = 110540.0
    pts = [((lon - lon0) * kx, (lat - lat0) * ky) for (lat, lon) in ll]   # meters
    n = len(pts)

    def to_ll(xy):
        return (round(lat0 + xy[1] / ky, 6), round(lon0 + xy[0] / kx, 6))  # (lat,lon)

    tris = bowyer_watson(pts, n)

    # bbox for clipping = selected sector centres + margin (meters)
    sel_xy = [pts[i] for i, s in enumerate(ids) if s in SELECTED]
    margin = 900.0
    xmin = min(p[0] for p in sel_xy) - margin; xmax = max(p[0] for p in sel_xy) + margin
    ymin = min(p[1] for p in sel_xy) - margin; ymax = max(p[1] for p in sel_xy) + margin

    # Voronoi cell per point = ordered circumcenters of incident triangles, clipped.
    cells = {}
    for i in range(n):
        inc = [t for t in tris if i in t]
        ccs = []
        for t in inc:
            cc = circumcenter(pts[t[0]], pts[t[1]], pts[t[2]])
            if cc:
                ccs.append(cc)
        ccs = [c for c in ccs if not (math.isinf(c[0]) or math.isnan(c[0]))]
        if len(ccs) < 3:
            continue
        px, py = pts[i]
        ccs.sort(key=lambda c: math.atan2(c[1] - py, c[0] - px))
        cells[i] = clip_poly(ccs, xmin, ymin, xmax, ymax)

    # Build cameras (unique vertices) + edges (sector boundaries) for SELECTED sectors.
    def key(xy):
        return (round(xy[0] / 45), round(xy[1] / 45))   # ~45m dedup grid

    vert_id = {}; verts = []   # id -> (lon,lat) via to_ll
    def cam_of(xy):
        k = key(xy)
        if k not in vert_id:
            vert_id[k] = len(verts)
            verts.append(to_ll(xy))
        return vert_id[k]

    edges = set(); sector_rings = {}
    for i, s in enumerate(ids):
        if s not in SELECTED or i not in cells or len(cells[i]) < 3:
            continue
        ring = [cam_of(v) for v in cells[i]]
        # collapse consecutive duplicates
        ring = [c for j, c in enumerate(ring) if c != ring[j - 1]]
        sector_rings[s] = ring
        for j in range(len(ring)):
            a, b = ring[j], ring[(j + 1) % len(ring)]
            if a != b:
                edges.add((min(a, b), max(a, b)))

    built = sorted(sector_rings.keys(), key=lambda s: (int(re.sub('[A-Z]', '', s)), s))
    print(f"sectors outlined: {len(built)} -> {', '.join(built)}")
    print(f"cameras (unique vertices): {len(verts)}   boundary edges: {len(edges)}")
    lats = [v[0] for v in verts]; lons = [v[1] for v in verts]
    print(f"camera lat range {min(lats):.4f}..{max(lats):.4f}  lon {min(lons):.4f}..{max(lons):.4f}")

    if DRY:
        print("DRY run — no OSRM, no SQL written.")
        return

    # Snap cameras to nearest road.
    CAM = []   # (code, name, lon, lat)
    snapped = []
    for idx, (lat, lon) in enumerate(verts):
        slon, slat = snap(lat, lon); time.sleep(0.25)
        snapped.append((slon, slat))
        CAM.append((f"CAM-{idx + 1:02d}", f"Sector vertex {idx + 1}", slon, slat))
    # facing = bearing to nearest neighbour camera
    heading = {}
    for i, ci in enumerate(CAM):
        j = min((k for k in range(len(CAM)) if k != i),
                key=lambda k: haversine((ci[3], ci[2]), (CAM[k][3], CAM[k][2])))
        heading[ci[0]] = bearing((ci[3], ci[2]), (CAM[j][3], CAM[j][2]))

    # Route each boundary edge along real roads.
    links = []; einfo = {}
    for (a, b) in sorted(edges):
        g, dist, ff = route(snapped[a], snapped[b]); time.sleep(0.25)
        einfo[(a, b)] = (dist, ff)
        links.append((CAM[a][0], CAM[b][0], "FWD", g, dist, ff))
        links.append((CAM[b][0], CAM[a][0], "REV", {"type": "LineString", "coordinates": g["coordinates"][::-1]}, dist, ff))
    print(f"routed {len(edges)} boundary edges -> {len(links)} directed links")

    # Trajectory: walk the boundary graph from CAM-01.
    adj = {}
    for (a, b) in edges:
        adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    trip, ffs, cur, seen = [0], [], 0, {0}
    while len(trip) < min(8, len(CAM)):
        nb = [x for x in adj.get(cur, []) if x not in seen]
        if not nb:
            break
        nxt = min(nb, key=lambda x: haversine((CAM[cur][3], CAM[cur][2]), (CAM[x][3], CAM[x][2])))
        ffs.append(einfo[(min(cur, nxt), max(cur, nxt))][1])
        trip.append(nxt); seen.add(nxt); cur = nxt
    offs = [0]
    for f in ffs:
        offs.append(offs[-1] + round(f * 1.15))
    total = offs[-1]

    out = []; w = out.append
    w("-- ============================================================================")
    w("-- DEV/DEMO SEED — Dwarka, New Delhi. GENERATED by db/gen_dwarka_sectors.py.")
    w(f"-- Sectors OUTLINED by camera links (Voronoi of sector centres). Sectors: "
      f"{', '.join(built)}.")
    w("-- Cameras at sector vertices (snapped to real roads); links = sector")
    w("-- boundaries (OSRM-routed). Re-runnable; TRUNCATEs — STOP the workers first.")
    w("-- ============================================================================")
    w("BEGIN;")
    w("TRUNCATE cameras, roads, plates, camera_links, sightings, blacklist_entries,")
    w("         alerts, camera_metrics_5m, traffic_metrics_5m RESTART IDENTITY CASCADE;")
    w("")
    w("INSERT INTO roads (road_code, name) VALUES ('DWK-SECT', 'Dwarka Sector Boundaries');")
    w("")
    w("INSERT INTO cameras (camera_code, display_name, location, heading_degrees, status) VALUES")
    w(",\n".join(f"  ({sql_str(c)}, {sql_str(nm)}, ST_SetSRID(ST_MakePoint({lng}, {lat}), 4326), {heading[c]}, 'active')"
                 for c, nm, lng, lat in CAM) + ";")
    w("")
    for fc, tc, dl, g, dist, ff in links:
        geo = json.dumps(g).replace("'", "''")
        w("INSERT INTO camera_links (from_camera_id, to_camera_id, road_id, direction_label, "
          "path, distance_meters, free_flow_time_seconds, speed_limit_kph)")
        w(f"SELECT f.camera_id, t.camera_id, r.road_id, {sql_str(dl)},")
        w(f"       ST_SetSRID(ST_GeomFromGeoJSON('{geo}'), 4326), {dist}, {ff}, 50")
        w("FROM cameras f, cameras t, roads r")
        w(f"WHERE f.camera_code={sql_str(fc)} AND t.camera_code={sql_str(tc)} AND r.road_code='DWK-SECT';")
    w("")
    w(f"INSERT INTO plates (normalized_plate) VALUES ({sql_str(PLATES_TRIP)}), ({sql_str(PLATE_BLACK)});")
    w("")
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    tr = []
    for k, idx in enumerate(trip):
        code = CAM[idx][0]
        tr.append(f"  ({sql_str('seed-'+PLATES_TRIP+'-'+code)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(code)}), "
                  f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATES_TRIP)}), "
                  f"{sql_str(PLATES_TRIP)}, {sql_str(PLATES_TRIP)}, 0.96, 0.93, '[]'::jsonb, 'accepted', "
                  f"now() - make_interval(secs => {total - offs[k]}), {heading[code]}, 'car', 'white', 2, 'anpr-v1')")
    w("VALUES\n" + ",\n".join(tr) + ";")
    w("")
    c1, c2 = CAM[0][0], CAM[-1][0]
    w("INSERT INTO sightings (source_event_id, camera_id, plate_id, raw_plate_text, "
      "normalized_plate_candidate, detection_confidence, ocr_confidence, ocr_candidates, "
      "validation_status, spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)")
    w("VALUES\n" + ",\n".join([
        f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c1)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c1)}), "
        f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
        f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
        f"now() - make_interval(secs => 600), {heading[c1]}, 'car', 'black', 3, 'anpr-v1')",
        f"  ({sql_str('seed-'+PLATE_BLACK+'-'+c2)}, (SELECT camera_id FROM cameras WHERE camera_code={sql_str(c2)}), "
        f"(SELECT plate_id FROM plates WHERE normalized_plate={sql_str(PLATE_BLACK)}), "
        f"{sql_str(PLATE_BLACK)}, {sql_str(PLATE_BLACK)}, 0.93, 0.88, '[]'::jsonb, 'accepted', "
        f"now() - make_interval(secs => 595), {heading[c2]}, 'car', 'black', 3, 'anpr-v1')"]) + ";")
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
    print(f"wrote db/seed_dwarka.sql ({len(CAM)} cameras, {len(links)} links)")


if __name__ == "__main__":
    main()
