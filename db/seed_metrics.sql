-- =============================================================================
-- DEV METRICS SEED — NOT for production.
-- Regenerable snapshot of the last 12 five-minute windows (~1 hour) of camera
-- node metrics and link congestion metrics. Re-runnable: truncates and rebuilds
-- so the window is always "now - 1h .. now".
--
-- CAM-03 is a hotspot; the CAM-02 -> CAM-03 link is a congestion bottleneck.
--
-- Apply:  docker compose exec -T postgres psql -U anpr -d anpr < db/seed_metrics.sql
-- =============================================================================
BEGIN;

TRUNCATE camera_metrics_5m;
TRUNCATE traffic_metrics_5m;

-- Camera node metrics (heatmap): per-camera base intensity + per-window variation.
INSERT INTO camera_metrics_5m (camera_id, window_start, vehicle_count, unique_plate_count, significant_change)
SELECT c.camera_id,
       date_bin('5 minutes', now(), timestamptz 'epoch') - (g * interval '5 minutes') AS window_start,
       (base.v + (g % 5) * 3)                        AS vehicle_count,
       GREATEST(1, ((base.v + (g % 5) * 3) * 8) / 10) AS unique_plate_count,
       false
FROM cameras c
JOIN (VALUES
    ('CAM-01', 20), ('CAM-02', 35), ('CAM-03', 60), ('CAM-04', 30),
    ('CAM-05', 25), ('CAM-06', 40), ('CAM-07', 30), ('CAM-08', 50)
) AS base(code, v) ON base.code = c.camera_code
CROSS JOIN generate_series(0, 11) AS g
ON CONFLICT (camera_id, window_start) DO NOTHING;

-- Link congestion metrics: CAM-02 -> CAM-03 is a bottleneck (~2.2x free-flow).
INSERT INTO traffic_metrics_5m
    (camera_link_id, window_start, vehicle_count, unique_vehicle_count,
     median_travel_time_seconds, baseline_travel_time_seconds, baseline_vehicle_count,
     congestion_score, travel_time_sample_count, significant_change)
SELECT cl.camera_link_id,
       date_bin('5 minutes', now(), timestamptz 'epoch') - (g * interval '5 minutes'),
       40 + (g % 4) * 5,
       35 + (g % 4) * 4,
       ROUND(cl.free_flow_time_seconds * fac.ratio)::int,
       cl.free_flow_time_seconds,
       30,
       ROUND(fac.ratio, 3),
       12 + (g % 4),
       fac.ratio > 2.0
FROM camera_links cl
JOIN cameras fc ON fc.camera_id = cl.from_camera_id
JOIN cameras tc ON tc.camera_id = cl.to_camera_id
CROSS JOIN generate_series(0, 11) AS g
CROSS JOIN LATERAL (
    SELECT CASE
             WHEN fc.camera_code = 'CAM-02' AND tc.camera_code = 'CAM-03'
             THEN 2.2 + (g % 3) * 0.1
             ELSE 1.05 + (g % 3) * 0.05
           END::numeric AS ratio
) AS fac
ON CONFLICT (camera_link_id, window_start) DO NOTHING;

COMMIT;
