-- =============================================================================
-- DEV METRICS SEED — NOT for production. GENERIC: adapts to whatever cameras /
-- camera_links exist (per-camera base + per-link congestion derived from a hash
-- of the id, so it works for any seed without hardcoded codes). Some links come
-- out congested (ratio > 2). Regenerable: truncates + rebuilds the last hour.
--
-- Apply:  docker compose exec -T postgres psql -U anpr -d anpr < db/seed_metrics.sql
-- =============================================================================
BEGIN;

TRUNCATE camera_metrics_5m;
TRUNCATE traffic_metrics_5m;

-- Camera node metrics (heatmap): per-camera base intensity from a hash of the
-- code (20..64), plus per-window variation.
INSERT INTO camera_metrics_5m (camera_id, window_start, vehicle_count, unique_plate_count, significant_change)
SELECT c.camera_id,
       date_bin('5 minutes', now(), timestamptz 'epoch') - (g * interval '5 minutes'),
       (20 + (abs(hashtext(c.camera_code)) % 45) + (g % 5) * 3)                     AS vehicle_count,
       GREATEST(1, ((20 + (abs(hashtext(c.camera_code)) % 45) + (g % 5) * 3) * 8) / 10) AS unique_plate_count,
       false
FROM cameras c
CROSS JOIN generate_series(0, 11) AS g
ON CONFLICT (camera_id, window_start) DO NOTHING;

-- Link congestion metrics: per-link congestion ratio (median/free_flow) from a
-- hash of the link id (~1.0..2.4), so some links are bottlenecks.
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
CROSS JOIN generate_series(0, 11) AS g
CROSS JOIN LATERAL (
    SELECT (1.0 + (abs(hashtext(cl.camera_link_id::text)) % 140) / 100.0)::numeric AS ratio
) AS fac
ON CONFLICT (camera_link_id, window_start) DO NOTHING;

COMMIT;
