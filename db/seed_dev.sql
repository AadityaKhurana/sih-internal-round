-- =============================================================================
-- DEV / DEMO SEED — NOT for production.
-- Simulated camera network on a real Bengaluru corridor (MG Road → CMH Road).
-- Idempotent: safe to run repeatedly (ON CONFLICT guards on natural keys).
--
-- Apply:  docker compose exec -T postgres psql -U anpr -d anpr < db/seed_dev.sql
-- =============================================================================
BEGIN;

-- Refresh time-anchored demo rows so RE-RUNNING realigns them to "now".
-- sightings/alerts are inserted at now()-offsets; ON CONFLICT alone can't move
-- an existing timestamp, so delete the seed-owned rows first and let the inserts
-- below recreate them fresh. Deleting sightings cascades to their alerts (FK).
DELETE FROM sightings WHERE source_event_id LIKE 'seed-%';
DELETE FROM alerts    WHERE dedup_key LIKE 'seed-%';

-- --- Road -------------------------------------------------------------------
INSERT INTO roads (road_code, name) VALUES
    ('MG-CORR-1', 'MG Road Corridor (W→E)')
ON CONFLICT (road_code) DO NOTHING;

-- --- Cameras (5, west → east) ----------------------------------------------
INSERT INTO cameras (camera_code, display_name, location, heading_degrees, status) VALUES
    ('CAM-01', 'Trinity Circle',      ST_SetSRID(ST_MakePoint(77.6010, 12.9750), 4326), 90, 'active'),
    ('CAM-02', 'MG Road Metro',       ST_SetSRID(ST_MakePoint(77.6090, 12.9762), 4326), 90, 'active'),
    ('CAM-03', 'Halasuru Gate',       ST_SetSRID(ST_MakePoint(77.6175, 12.9775), 4326), 90, 'active'),
    ('CAM-04', 'Indiranagar 100ft',   ST_SetSRID(ST_MakePoint(77.6260, 12.9788), 4326), 90, 'active'),
    ('CAM-05', 'CMH Road',            ST_SetSRID(ST_MakePoint(77.6345, 12.9800), 4326), 90, 'active')
ON CONFLICT (camera_code) DO NOTHING;

-- --- Camera links (consecutive cameras, both directions) --------------------
--   distance_meters + free_flow_time_seconds derived from geography length,
--   assuming a 50 kph free-flow speed (50*1000/3600 = 13.89 m/s).
WITH chain(a, b) AS (
    VALUES ('CAM-01','CAM-02'), ('CAM-02','CAM-03'), ('CAM-03','CAM-04'), ('CAM-04','CAM-05')
),
pairs AS (
    SELECT a AS from_code, b AS to_code, 'W→E' AS dir FROM chain
    UNION ALL
    SELECT b, a, 'E→W' FROM chain
)
INSERT INTO camera_links
    (from_camera_id, to_camera_id, road_id, direction_label, path,
     distance_meters, free_flow_time_seconds, speed_limit_kph)
SELECT f.camera_id, t.camera_id,
       (SELECT road_id FROM roads WHERE road_code = 'MG-CORR-1'),
       p.dir,
       ST_SetSRID(ST_MakeLine(f.location, t.location), 4326),
       ROUND(ST_Length(ST_MakeLine(f.location, t.location)::geography))::int,
       ROUND(ST_Length(ST_MakeLine(f.location, t.location)::geography) / (50.0 * 1000 / 3600))::int,
       50
FROM pairs p
JOIN cameras f ON f.camera_code = p.from_code
JOIN cameras t ON t.camera_code = p.to_code
ON CONFLICT (from_camera_id, to_camera_id) DO NOTHING;

-- --- Plates -----------------------------------------------------------------
INSERT INTO plates (normalized_plate) VALUES
    ('KA01AB1234'),   -- normal W→E trip
    ('KA03EF9012'),   -- short trip
    ('KA05CD5678')    -- blacklisted + impossible-travel demo
ON CONFLICT (normalized_plate) DO NOTHING;

-- --- Sightings: KA01AB1234 full W→E trip (all accepted, feasible) -----------
INSERT INTO sightings
    (source_event_id, camera_id, plate_id, raw_plate_text, normalized_plate_candidate,
     detection_confidence, ocr_confidence, ocr_candidates, validation_status,
     spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)
SELECT v.eid, c.camera_id, p.plate_id, v.raw, v.norm,
       v.det, v.ocr, '[]'::jsonb, 'accepted',
       now() - v.ago, 90, 'car', 'white', 2, 'anpr-v1'
FROM (VALUES
    ('seed-KA01AB1234-01', 'CAM-01', 'KA01A81234', 'KA01AB1234', 0.97, 0.93, INTERVAL '30 minutes'),
    ('seed-KA01AB1234-02', 'CAM-02', 'KA01AB1234', 'KA01AB1234', 0.96, 0.92, INTERVAL '28 minutes 45 seconds'),
    ('seed-KA01AB1234-03', 'CAM-03', 'KA01AB1234', 'KA01AB1234', 0.95, 0.90, INTERVAL '27 minutes 20 seconds'),
    ('seed-KA01AB1234-04', 'CAM-04', 'KA0IAB1234', 'KA01AB1234', 0.94, 0.88, INTERVAL '25 minutes 50 seconds'),
    ('seed-KA01AB1234-05', 'CAM-05', 'KA01AB1234', 'KA01AB1234', 0.96, 0.91, INTERVAL '24 minutes 30 seconds')
) AS v(eid, camera_code, raw, norm, det, ocr, ago)
JOIN cameras c ON c.camera_code = v.camera_code
JOIN plates  p ON p.normalized_plate = v.norm
ON CONFLICT (source_event_id) DO NOTHING;

-- --- Sightings: KA03EF9012 short trip CAM-02 → CAM-03 -----------------------
INSERT INTO sightings
    (source_event_id, camera_id, plate_id, raw_plate_text, normalized_plate_candidate,
     detection_confidence, ocr_confidence, ocr_candidates, validation_status,
     spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)
SELECT v.eid, c.camera_id, p.plate_id, v.norm, v.norm,
       0.95, 0.89, '[]'::jsonb, 'accepted',
       now() - v.ago, 90, 'truck', 'blue', 1, 'anpr-v1'
FROM (VALUES
    ('seed-KA03EF9012-01', 'CAM-02', 'KA03EF9012', INTERVAL '15 minutes'),
    ('seed-KA03EF9012-02', 'CAM-03', 'KA03EF9012', INTERVAL '13 minutes 30 seconds')
) AS v(eid, camera_code, norm, ago)
JOIN cameras c ON c.camera_code = v.camera_code
JOIN plates  p ON p.normalized_plate = v.norm
ON CONFLICT (source_event_id) DO NOTHING;

-- --- Blacklist: KA05CD5678 --------------------------------------------------
INSERT INTO blacklist_entries (plate_id, reason, severity, status, added_by, case_reference)
SELECT p.plate_id, 'Reported stolen (demo)', 'high', 'active', 'seed', 'DEMO-CASE-001'
FROM plates p
WHERE p.normalized_plate = 'KA05CD5678'
  AND NOT EXISTS (
      SELECT 1 FROM blacklist_entries b
      WHERE b.plate_id = p.plate_id AND b.case_reference = 'DEMO-CASE-001'
  );

-- --- Sightings: KA05CD5678 IMPOSSIBLE travel (CAM-01 then CAM-05 ~5s later) --
--   ~3.3 km apart but 5s apart => physically impossible; for the alerts worker.
INSERT INTO sightings
    (source_event_id, camera_id, plate_id, raw_plate_text, normalized_plate_candidate,
     detection_confidence, ocr_confidence, ocr_candidates, validation_status,
     spotted_at, direction_degrees, vehicle_type, vehicle_color, lane_number, model_version)
SELECT v.eid, c.camera_id, p.plate_id, v.norm, v.norm,
       0.93, 0.87, '[]'::jsonb, 'accepted',
       now() - v.ago, 90, 'car', 'black', 3, 'anpr-v1'
FROM (VALUES
    ('seed-KA05CD5678-01', 'CAM-01', 'KA05CD5678', INTERVAL '10 minutes'),
    ('seed-KA05CD5678-02', 'CAM-05', 'KA05CD5678', INTERVAL '9 minutes 55 seconds')
) AS v(eid, camera_code, norm, ago)
JOIN cameras c ON c.camera_code = v.camera_code
JOIN plates  p ON p.normalized_plate = v.norm
ON CONFLICT (source_event_id) DO NOTHING;

-- --- Demo alerts (normally produced by the alerts worker; seeded for API/UI dev) --
-- Blacklist alert: KA05CD5678 seen at CAM-01.
INSERT INTO alerts (dedup_key, alert_type, sighting_id, blacklist_entry_id,
                    status, match_confidence, details)
SELECT 'seed-bl-KA05CD5678-CAM01', 'blacklist', s.sighting_id, b.blacklist_entry_id,
       'new', 1.0, jsonb_build_object('note', 'blacklisted vehicle seen', 'camera', 'CAM-01')
FROM sightings s
JOIN plates p            ON p.plate_id = s.plate_id AND p.normalized_plate = 'KA05CD5678'
JOIN blacklist_entries b ON b.plate_id = p.plate_id
WHERE s.source_event_id = 'seed-KA05CD5678-01'
ON CONFLICT (dedup_key) DO NOTHING;

-- Route-anomaly alert: CAM-01 -> CAM-05 in ~5s (impossible travel time).
INSERT INTO alerts (dedup_key, alert_type, sighting_id, previous_sighting_id,
                    anomaly_reason, status, match_confidence, details)
SELECT 'seed-anom-KA05CD5678', 'route_anomaly', cur.sighting_id, prev.sighting_id,
       'impossible_travel_time', 'new', 0.98,
       jsonb_build_object('observed_seconds', 5, 'note', 'CAM-01 to CAM-05 in 5s')
FROM sightings cur
JOIN sightings prev ON prev.source_event_id = 'seed-KA05CD5678-01'
WHERE cur.source_event_id = 'seed-KA05CD5678-02'
ON CONFLICT (dedup_key) DO NOTHING;

COMMIT;
