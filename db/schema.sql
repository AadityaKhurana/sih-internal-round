-- =============================================================================
-- City-Wide ANPR Platform — Core Schema (PostgreSQL 14+ / PostGIS 3+)
-- =============================================================================
-- SIH prototype: centralized ANPR, single-plate trajectory tracking, and
-- macro traffic-flow analytics over a simulated city camera network.
--
-- Design notes (kept in sync with the Miro ERD):
--   * Routes are NOT stored. They are reconstructed at query time from accepted
--     sightings ordered by time, validated against camera_links.
--   * Binary media (plate crops, vehicle images, event clips) live in MinIO/S3;
--     only their object keys are stored on `sightings`.
--   * OCR candidates are stored inline as JSONB on `sightings` (no side table).
--   * Analytics are aggregated at 5-minute granularity only. One hour = 12 rows.
--     Roll up on read; add materialized views later only if reporting is slow.
--   * `alerts` covers BOTH blacklist and route-anomaly alerts. Anomaly alerts
--     do NOT depend on a blacklist entry.
--
-- Geometry SRID: 4326 (WGS84 lon/lat) to line up with Leaflet/OSM basemap.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- ROADS — human-readable corridor / road identity
-- -----------------------------------------------------------------------------
CREATE TABLE roads (
    road_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    road_code   text NOT NULL UNIQUE,          -- e.g. 'NH-48-SEG-3'
    name        text NOT NULL,                  -- e.g. 'MG Road (Trinity → Halasuru)'
    active      boolean NOT NULL DEFAULT true
);

-- -----------------------------------------------------------------------------
-- CAMERAS — camera node metadata + map location
-- -----------------------------------------------------------------------------
CREATE TABLE cameras (
    camera_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_code     text NOT NULL UNIQUE,       -- e.g. 'CAM-12'
    display_name    text NOT NULL,
    location        geometry(Point, 4326) NOT NULL,
    heading_degrees numeric(5,2),               -- direction the camera faces (0–360)
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive', 'maintenance', 'fault')),
    stream_uri_ref  text,                        -- opaque ref to RTSP/file source (not raw creds)
    last_seen_at    timestamptz                  -- last heartbeat / last frame processed
);

CREATE INDEX idx_cameras_location ON cameras USING gist (location);
CREATE INDEX idx_cameras_status   ON cameras (status);

-- -----------------------------------------------------------------------------
-- CAMERA_LINKS — directed monitored path between two cameras
--   Backbone of route feasibility, travel time and link-level congestion.
-- -----------------------------------------------------------------------------
CREATE TABLE camera_links (
    camera_link_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_camera_id        uuid NOT NULL REFERENCES cameras(camera_id) ON DELETE RESTRICT,
    to_camera_id          uuid NOT NULL REFERENCES cameras(camera_id) ON DELETE RESTRICT,
    road_id               uuid REFERENCES roads(road_id) ON DELETE SET NULL,
    direction_label       text,                  -- e.g. 'NB', 'SB', 'E→W'
    path                  geometry(LineString, 4326),  -- geometry to draw on the map
    distance_meters       integer NOT NULL CHECK (distance_meters >= 0),
    free_flow_time_seconds integer NOT NULL CHECK (free_flow_time_seconds >= 0),
    speed_limit_kph       integer CHECK (speed_limit_kph IS NULL OR speed_limit_kph > 0),
    active                boolean NOT NULL DEFAULT true,
    CONSTRAINT ck_camera_links_distinct_endpoints CHECK (from_camera_id <> to_camera_id),
    CONSTRAINT uq_camera_links_edge UNIQUE (from_camera_id, to_camera_id)
);

CREATE INDEX idx_camera_links_from ON camera_links (from_camera_id);
CREATE INDEX idx_camera_links_to   ON camera_links (to_camera_id);
CREATE INDEX idx_camera_links_road ON camera_links (road_id);
CREATE INDEX idx_camera_links_path ON camera_links USING gist (path);

-- -----------------------------------------------------------------------------
-- PLATES — canonical normalized registration plate
-- -----------------------------------------------------------------------------
CREATE TABLE plates (
    plate_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    normalized_plate text NOT NULL UNIQUE        -- e.g. 'DL01AB1234'
);

-- -----------------------------------------------------------------------------
-- SIGHTINGS — one vehicle pass at one camera after multi-frame OCR voting
--   plate_id is nullable until identity is resolved.
--   Raw sightings are never deleted on an impossible transition — they are
--   marked via validation_status instead.
-- -----------------------------------------------------------------------------
CREATE TABLE sightings (
    sighting_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_event_id            text NOT NULL UNIQUE,     -- idempotency key from OCR worker
    camera_id                  uuid NOT NULL REFERENCES cameras(camera_id) ON DELETE RESTRICT,
    plate_id                   uuid REFERENCES plates(plate_id) ON DELETE SET NULL,
    raw_plate_text             text,
    normalized_plate_candidate text,
    camera_track_id            text,                     -- tracker id within the camera stream
    detection_confidence       numeric(5,4) CHECK (detection_confidence BETWEEN 0 AND 1),
    ocr_confidence             numeric(5,4) CHECK (ocr_confidence BETWEEN 0 AND 1),
    ocr_candidates             jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{plate, confidence}, ...]
    validation_status          text NOT NULL DEFAULT 'pending'
                                   CHECK (validation_status IN ('pending','accepted','uncertain','conflict')),
    validation_reason          text,
    spotted_at                 timestamptz NOT NULL,     -- when the vehicle passed the camera
    processed_at               timestamptz NOT NULL DEFAULT now(),
    direction_degrees          numeric(5,2),
    vehicle_type               text,                     -- car, truck, bus, two_wheeler, ...
    vehicle_color              text,
    lane_number                integer,
    quality_flags              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- blur, night, occluded, angled...
    model_version              text,
    plate_crop_object_key      text,                     -- MinIO/S3 keys (media not stored in PG)
    vehicle_image_object_key   text,
    context_clip_object_key    text
);

-- Trajectory reconstruction: all accepted sightings for a plate, in time order.
CREATE INDEX idx_sightings_plate_time  ON sightings (plate_id, spotted_at);
-- Camera timeline / node metrics.
CREATE INDEX idx_sightings_camera_time ON sightings (camera_id, spotted_at);
-- Alert / validation sweeps.
CREATE INDEX idx_sightings_status      ON sightings (validation_status);
CREATE INDEX idx_sightings_candidate   ON sightings (normalized_plate_candidate);

-- -----------------------------------------------------------------------------
-- BLACKLIST_ENTRIES — active / historical blacklist records
-- -----------------------------------------------------------------------------
CREATE TABLE blacklist_entries (
    blacklist_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plate_id           uuid NOT NULL REFERENCES plates(plate_id) ON DELETE CASCADE,
    reason             text NOT NULL,
    severity           text NOT NULL DEFAULT 'medium'
                           CHECK (severity IN ('low','medium','high','critical')),
    status             text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','inactive','expired')),
    active_from        timestamptz NOT NULL DEFAULT now(),
    active_until       timestamptz,               -- NULL = open-ended
    added_by           text,
    case_reference     text
);

CREATE INDEX idx_blacklist_plate  ON blacklist_entries (plate_id);
CREATE INDEX idx_blacklist_active ON blacklist_entries (status, active_from, active_until);

-- -----------------------------------------------------------------------------
-- ALERTS — blacklist AND route-anomaly alerts (Miro ERD sync)
--   Anomaly alerts are independent of blacklist_entry_id (nullable).
-- -----------------------------------------------------------------------------
CREATE TABLE alerts (
    alert_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedup_key            text NOT NULL UNIQUE,     -- suppress duplicate alerts for same event
    alert_type           text NOT NULL CHECK (alert_type IN ('blacklist','route_anomaly')),
    sighting_id          uuid NOT NULL REFERENCES sightings(sighting_id) ON DELETE CASCADE,
    previous_sighting_id uuid REFERENCES sightings(sighting_id) ON DELETE SET NULL,
    blacklist_entry_id   uuid REFERENCES blacklist_entries(blacklist_entry_id) ON DELETE SET NULL,
    anomaly_reason       text CHECK (anomaly_reason IN
                             ('impossible_travel_time','wrong_direction','suspected_clone')),
    match_confidence     numeric(5,4) CHECK (match_confidence BETWEEN 0 AND 1),
    status               text NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new','delivered','acknowledged','resolved')),
    details              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    delivered_at         timestamptz,
    acknowledged_at      timestamptz,
    acknowledged_by      text,
    resolution_notes     text,
    -- shape guards: blacklist alerts must cite an entry; anomaly alerts must cite a reason
    CONSTRAINT ck_alerts_blacklist_shape CHECK (
        alert_type <> 'blacklist' OR blacklist_entry_id IS NOT NULL),
    CONSTRAINT ck_alerts_anomaly_shape CHECK (
        alert_type <> 'route_anomaly' OR anomaly_reason IS NOT NULL)
);

CREATE INDEX idx_alerts_status   ON alerts (status);
CREATE INDEX idx_alerts_type     ON alerts (alert_type);
CREATE INDEX idx_alerts_sighting ON alerts (sighting_id);
CREATE INDEX idx_alerts_created  ON alerts (created_at);

-- -----------------------------------------------------------------------------
-- CAMERA_METRICS_5M — camera-node 5-minute metrics (Miro ERD sync)
--   Drives camera/node heatmaps. Node-level counts only.
-- -----------------------------------------------------------------------------
CREATE TABLE camera_metrics_5m (
    camera_id          uuid NOT NULL REFERENCES cameras(camera_id) ON DELETE CASCADE,
    window_start       timestamptz NOT NULL,        -- aligned to 5-minute boundary
    vehicle_count      integer NOT NULL DEFAULT 0,
    unique_plate_count integer NOT NULL DEFAULT 0,
    significant_change boolean NOT NULL DEFAULT false,
    PRIMARY KEY (camera_id, window_start)
);

CREATE INDEX idx_camera_metrics_window ON camera_metrics_5m (window_start);

-- -----------------------------------------------------------------------------
-- TRAFFIC_METRICS_5M — link-level 5-minute congestion metrics
--   Supports congestion on the path from Camera A → Camera B.
--   Typical corridor speed is derived on read as:
--       distance_meters / median_travel_time_seconds
--   (no stored average_speed_kph, per design decision).
-- -----------------------------------------------------------------------------
CREATE TABLE traffic_metrics_5m (
    camera_link_id             uuid NOT NULL REFERENCES camera_links(camera_link_id) ON DELETE CASCADE,
    window_start               timestamptz NOT NULL,   -- aligned to 5-minute boundary
    vehicle_count              integer NOT NULL DEFAULT 0,
    unique_vehicle_count       integer NOT NULL DEFAULT 0,
    median_travel_time_seconds integer,
    baseline_travel_time_seconds integer,              -- expected/typical for this window-of-week
    baseline_vehicle_count     integer,
    congestion_score           numeric(6,3),           -- e.g. median / baseline ratio
    -- number of valid journeys matched at BOTH ends of the link in this window;
    -- indicates how reliable the travel-time/congestion figures are.
    travel_time_sample_count   integer NOT NULL DEFAULT 0,
    significant_change         boolean NOT NULL DEFAULT false,
    PRIMARY KEY (camera_link_id, window_start)
);

CREATE INDEX idx_traffic_metrics_window ON traffic_metrics_5m (window_start);

-- -----------------------------------------------------------------------------
-- AUDIT_LOGS — records sensitive actions (searches, trajectory/owner/evidence
--   views, alert acknowledgements) for accountability.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
    audit_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_subject text NOT NULL,                    -- who performed the action
    action       text NOT NULL,                    -- e.g. 'trajectory_query','evidence_view'
    target_type  text,                             -- e.g. 'plate','sighting','alert'
    target_id    text,
    purpose      text,                             -- stated reason for sensitive access
    request_id   text,
    source_ip    inet,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_subject   ON audit_logs (user_subject, occurred_at);
CREATE INDEX idx_audit_target    ON audit_logs (target_type, target_id);
CREATE INDEX idx_audit_occurred  ON audit_logs (occurred_at);

COMMIT;
