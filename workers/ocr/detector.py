#!/usr/bin/env python3
"""
Stage 2-4 of the ANPR pipeline: detect -> track -> select best crops.

Consumes video frames. Produces ONE event per vehicle, carrying the best
few plate crops for the OCR stage. Knows nothing about OCR, MQTT or the
database -- keep it that way, it's what makes this testable on its own.

    python detector.py --source video.mp4 --plate-weights plate.pt --save-crops out/

Verified against ultralytics 8.4.132.
"""
import argparse
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from collections import defaultdict

import cv2
import numpy as np
from ultralytics import YOLO

# COCO class IDs -- verified from yolo11n.pt, do not guess these
VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}

# A track must vanish for this many frames before we call it finished
TRACK_TIMEOUT_FRAMES = 15

# Below this the plate is unreadable. Emit UNREAD rather than guess.
MIN_PLATE_WIDTH_PX = 60

# --- geometric sanity checks on a candidate plate box -------------------
# Off-the-shelf plate detectors happily fire on bus destination boards,
# advertising panels and window rows: rectangular, text-bearing, not plates.
# Real plates obey physics, so check the geometry instead of trusting conf.
#
# Indian plate standards: single-row ~500x120mm  -> ratio ~4.2
#                         two-row    ~285x200mm  -> ratio ~1.4  (motorcycles)
# Band kept generous to cover perspective foreshortening on angled shots.
# Per-jurisdiction, not a constant. Plate geometry is set by national
# standards, so the acceptance band is a deployment parameter.
#
#   India   MCV/HCV 340x200 = 1.70 | LMV 500x120 = 4.17
#           2W rear 200x100 = 2.00 | 2W front 285x45 = 6.33
#   Mercosur motorcycle 200x170 = 1.18  <- below the Indian floor
#
# Measured on RodoSol: running the INDIA band against Mercosur motorcycle
# plates costs 60 points of recall (90.3% -> 30.3%). Against cars it costs
# 0.0. Choose the band to match where the camera is installed.
REGION_ASPECT_BANDS = {
    "india":    (1.1, 7.0),   # covers all four CMVR formats
    "mercosur": (0.9, 7.0),   # near-square motorcycle plates
    "global":   (0.9, 7.5),   # permissive; more panel false positives
}
DEFAULT_REGION = "india"

PLATE_ASPECT_MIN, PLATE_ASPECT_MAX = REGION_ASPECT_BANDS[DEFAULT_REGION]

# A plate is a small part of the vehicle it is bolted to. A "plate" spanning
# 78% of a bus is the bus. These two catch nearly all board/panel hits.
PLATE_MAX_WIDTH_FRAC = 0.45      # of the vehicle box width
PLATE_MAX_AREA_FRAC = 0.15       # of the vehicle box area

# Absolute floor on a candidate box. Slivers 30x8px are clipped plate edges or
# noise -- unidentifiable even to a human, so never store them.
PLATE_MIN_BOX_W = 30
PLATE_MIN_BOX_H = 10

# Detector boxes hug the plate and shave edge characters. A dropped character
# is worse than no read at all: OCR returns it confidently and the grammar
# layer may not catch it. Pad before cropping. More vertically, because tight
# boxes clip character tops and bottoms more than the sides.
PLATE_PAD_X_FRAC = 0.06
PLATE_PAD_Y_FRAC = 0.12

# A vehicle's 5 stored crops are ranked, but rank 1-4 still go to OCR for
# voting. Anything below this is not a vote, it is noise -- drop it even if
# the vehicle's BEST crop was fine.
MIN_CROP_WIDTH_PX = 40

# --- compute budget ----------------------------------------------------
# Plate detection runs per vehicle per frame and dominates runtime (~94%).
# Almost all of it is wasted, for two reasons:
#
#  1. A vehicle narrower than this cannot contain a readable plate. Plates
#     are roughly 1/4 of vehicle width, so a 120px car gives a ~30px plate,
#     which the box floor rejects anyway. Skip it before paying for it.
MIN_VEHICLE_WIDTH_FOR_PLATE = 120
#
#  2. We keep only TOP_K_CROPS per vehicle, so running detection on all 300
#     frames of a long track is pointless. Sample instead -- but always
#     attempt when the vehicle is the largest it has been, because that is
#     its closest approach and its best plate.
PLATE_DETECT_EVERY_N = 4

# How many crops of one vehicle we keep for the OCR stage to vote over
TOP_K_CROPS = 5

# Bump on ANY change to the event payload. Additive changes only -- never
# rename or remove a field, the backend is parsing this.
SCHEMA_VERSION = "1.0"
PIPELINE_VERSION = "1.5.0"


def iso_ts(t=None):
    """Wall clock, ISO 8601, with offset. Never a bare float."""
    return datetime.fromtimestamp(t if t is not None else time.time(),
                                  tz=timezone.utc).astimezone().isoformat()


def xyxy_to_xywh(b):
    """Contract format is {x,y,w,h} in pixels of the FULL frame, top-left
    origin. Internally we carry xyxy because that is what YOLO returns.
    Convert once, here, at the boundary -- mixing the two is the single most
    common silent integration bug."""
    if b is None:
        return None
    x1, y1, x2, y2 = b
    return {"x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1)}

# Tracks shorter than this are fragments: a vehicle glimpsed at the frame
# edge, or a detection the tracker lost and restarted. They never produce a
# readable plate and they inflate traffic counts. Measured ~25% of tracks on
# real footage. Tune against your own video -- raise it if you still see
# junk, lower it if you're dropping real fast-moving vehicles.
MIN_TRACK_FRAMES = 4


def sharpness(bgr):
    """Variance of the Laplacian. Higher = crisper. Standard blur metric."""
    if bgr is None or bgr.size == 0:
        return 0.0
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def crop_quality(plate_bgr, det_conf):
    """
    Score one candidate crop so we can rank the frames of a single vehicle.

    Three signals, all cheap and all explainable to a judge:
      - sharpness  : rejects motion blur
      - pixel width: more pixels, more character detail
      - detector confidence
    The weights are a starting point. Tune them once you have labelled data
    and can measure which ranking actually picks the readable frame.
    """
    if plate_bgr is None or plate_bgr.size == 0:
        return 0.0
    h, w = plate_bgr.shape[:2]
    s = min(sharpness(plate_bgr) / 500.0, 1.0)   # 500 is an empirical ceiling
    width_score = min(w / 200.0, 1.0)
    return 0.45 * s + 0.35 * width_score + 0.20 * float(det_conf)


# colours are BGR
COL_VEHICLE = (0, 190, 255)     # amber
COL_PLATE   = (60, 230, 60)     # green
COL_TEXT    = (255, 255, 255)


def to_payload(event):
    """
    JSON-safe view of an event, ready for MQTT.

    Strips the numpy crop arrays, which exist only for the in-process handoff
    to the recognition stage. Everything the backend needs is already in the
    serialisable fields.
    """
    return {k: v for k, v in event.items() if k != "crops"}


def draw_overlay(frame, dets, frame_idx, n_events):
    """
    Annotate one frame for the demo video.

    Purely presentational -- it never feeds the pipeline. Kept separate so
    that what a judge sees is provably the same data the events came from,
    rather than a second code path that could diverge.

    dets: list of (vehicle_box, plate_box, global_id, cls, bearing)
    """
    vis = frame.copy()
    for vbox, pbox, gid, cls, bearing in dets:
        x1, y1, x2, y2 = vbox
        cv2.rectangle(vis, (x1, y1), (x2, y2), COL_VEHICLE, 2)

        short = gid.rsplit("-", 1)[-1].lstrip("0") or "0"
        label = f"#{short} {cls}"
        if bearing is not None:
            label += f" {bearing:.0f}\u00b0"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(vis, (x1, y1 - th - 7), (x1 + tw + 6, y1), COL_VEHICLE, -1)
        cv2.putText(vis, label, (x1 + 3, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

        if pbox is not None:
            px1, py1, px2, py2 = pbox
            cv2.rectangle(vis, (px1, py1), (px2, py2), COL_PLATE, 2)
            cv2.putText(vis, f"{px2 - px1}px", (px1, py2 + 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, COL_PLATE, 1,
                        cv2.LINE_AA)

    hud = f"frame {frame_idx}   tracked {len(dets)}   events {n_events}"
    cv2.rectangle(vis, (0, 0), (vis.shape[1], 30), (0, 0, 0), -1)
    cv2.putText(vis, hud, (10, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                COL_TEXT, 1, cv2.LINE_AA)
    return vis


class VehicleTrack:
    """Everything we accumulate about one vehicle while it crosses the frame."""

    def __init__(self, track_id, vehicle_class, frame_idx,
                 camera_id="CAM01", session_id=0, sequence=0,
                 ts=None, frame_size=(0, 0)):
        self.track_id = track_id
        self.camera_id = camera_id
        self.frame_w, self.frame_h = frame_size
        # wall-clock, supplied by the ingest stage. Frame indices are
        # meaningless to a backend computing transit times between cameras.
        self.first_ts = ts if ts is not None else time.time()
        self.last_ts = self.first_ts
        # ByteTrack recycles IDs once a vehicle leaves, so a raw track_id is
        # only unique among vehicles CURRENTLY on screen -- two different cars
        # 30 seconds apart are both "track 20". Even scoping by session is not
        # enough, because the reuse happens WITHIN one run. So the id is an
        # internal counter that only ever goes up, never ByteTrack's number.
        self.global_id = f"{camera_id}-{session_id}-{sequence:06d}"
        self.vehicle_class = vehicle_class
        self.first_frame = frame_idx
        self.last_frame = frame_idx
        self.n_frames = 0
        self.max_vehicle_w = 0       # closest approach so far
        self.best_det_conf = 0.0     # -> PlateSighting.detection_confidence
        self.last_plate_box = None   # newest plate box, for the overlay
        self.last_attempt = -999     # frame of last plate-detect attempt
        self.centroids = []          # for direction
        self.crops = []              # [(quality, plate_bgr, plate_box_frame)]
        self.best_plate_width = 0
        self.crop_uris = []          # filled by the caller after writing files
        self.model_desc = "unset"

    def update(self, frame_idx, vehicle_box, plate_crop, plate_box, det_conf,
               ts=None):
        self.last_frame = frame_idx
        self.n_frames += 1
        if ts is not None:
            self.last_ts = ts

        x1, y1, x2, y2 = vehicle_box
        self.centroids.append(((x1 + x2) / 2.0, (y1 + y2) / 2.0))

        if (plate_crop is not None and plate_crop.size
                and plate_crop.shape[1] >= MIN_CROP_WIDTH_PX):
            self.best_det_conf = max(self.best_det_conf, float(det_conf))
            q = crop_quality(plate_crop, det_conf)
            self.crops.append((q, plate_crop, plate_box))
            # keep only the best few -- bounds memory on long tracks
            self.crops.sort(key=lambda c: -c[0])
            del self.crops[TOP_K_CROPS:]
            self.best_plate_width = max(self.best_plate_width,
                                        plate_crop.shape[1])

    def direction(self):
        """
        Bearing from first to last centroid, in IMAGE space.

        0 deg = up the frame, 90 = right. This is NOT a compass bearing --
        converting to one requires the camera's installed bearing from
        camera_config.json. The field name says img_deg for that reason.
        """
        if len(self.centroids) < 2:
            return None
        (x0, y0), (x1, y1) = self.centroids[0], self.centroids[-1]
        dx, dy = x1 - x0, y1 - y0
        if abs(dx) < 5 and abs(dy) < 5:      # barely moved, don't guess
            return None
        return round((np.degrees(np.arctan2(dx, -dy)) + 360) % 360, 1)

    def to_event(self):
        """
        What stage 5 (OCR) receives. Note there is no plate text here --
        this stage never reads anything.
        """
        if not self.crops:
            status = "NO_PLATE"
        elif self.best_plate_width < MIN_PLATE_WIDTH_PX:
            status = "UNREAD"
        else:
            status = "PENDING_OCR"

        return {
            "schema_version": SCHEMA_VERSION,
            # UUID, generated at the edge. MQTT QoS 1 is at-least-once, so
            # buffered events WILL be re-delivered -- the backend dedupes on
            # this. global_id is human-readable; this is the idempotency key.
            "event_id": str(uuid.uuid4()),
            "global_id": self.global_id,
            "camera_id": self.camera_id,     # explicit -- do not parse global_id
            # int() casts matter: ByteTrack ids are numpy int64, which json
            # cannot serialise. Cast at the boundary, not at the publisher.
            "track_id": int(self.track_id),   # raw ByteTrack id, debug only

            "event_ts": iso_ts(self.last_ts),
            "first_seen_ts": iso_ts(self.first_ts),
            "track_frames": int(self.n_frames),
            "first_frame": int(self.first_frame),   # debugging only
            "last_frame": int(self.last_frame),     # debugging only

            "vehicle_class": self.vehicle_class,
            "plate_status": status,
            "best_plate_width_px": int(self.best_plate_width),
            # plate-detector score for the best crop. Required by the
            # PlateSighting contract (detection_confidence) -- the recognition
            # stage supplies ocr_confidence separately.
            "detection_confidence": round(float(self.best_det_conf), 4),

            # image-space, NOT compass. See direction() docstring.
            "direction_bearing_img_deg": self.direction(),

            "frame_width": int(self.frame_w),
            "frame_height": int(self.frame_h),

            "crop_quality": [round(c[0], 3) for c in self.crops],
            # {x,y,w,h} pixels of the full frame, top-left origin
            "plate_boxes": [xyxy_to_xywh(c[2]) for c in self.crops],
            "plate_crop_uris": list(self.crop_uris),

            "model": {"detector": self.model_desc,
                      "pipeline_version": PIPELINE_VERSION},

            # in-process only -- numpy arrays are not JSON serialisable and
            # are stripped by to_payload() before publishing
            "crops": [c[1] for c in self.crops],
        }


class PlateDetector:
    """
    Two-pass detection.

    Pass 1: vehicles in the full frame, with tracking.
    Pass 2: plate inside each vehicle crop.

    Pass 2 exists because a plate 30px wide in a 1920px frame is ~10px after
    YOLO downscales to 640 -- there is nothing left to find. Cropping the
    vehicle first turns that same plate into ~150px of a 400px image.
    """

    def __init__(self, vehicle_weights="yolo11n.pt", plate_weights=None,
                 vehicle_conf=0.35, plate_conf=0.25, imgsz=960,
                 camera_id="CAM01", min_track_frames=MIN_TRACK_FRAMES,
                 plate_every=PLATE_DETECT_EVERY_N,
                 min_vehicle_w=MIN_VEHICLE_WIDTH_FOR_PLATE,
                 vehicle_weights_fallback=None, device=None):
        self.vehicle_model = YOLO(vehicle_weights)

        # --- cascade -------------------------------------------------
        # A small detector is right most of the time and wrong in a
        # predictable way: it returns NO box at all. Measured on RodoSol,
        # yolo11n finds no vehicle in 35% of motorcycle images but only 2%
        # of car images. So escalate to a larger model exactly on that
        # failure -- paying the bigger model's cost only when the small one
        # gave up, rather than on every frame.
        #
        # What this buys, honestly: vehicle CLASS, which the backend needs
        # to corroborate cross-camera identity (a motorcycle and a car
        # cannot be the same vehicle whatever the plate says). It buys
        # little plate recall, because the whole-frame fallback already
        # recovers ~75% of plates in the no-vehicle case.
        self.vehicle_model_fb = (YOLO(vehicle_weights_fallback)
                                 if vehicle_weights_fallback else None)
        self.n_escalated = 0
        self.n_escalate_hit = 0
        self.plate_model = YOLO(plate_weights) if plate_weights else None
        self.vehicle_conf = vehicle_conf
        self.plate_conf = plate_conf
        self.imgsz = imgsz

        # None lets Ultralytics choose. On Apple Silicon that means CPU,
        # leaving the GPU idle -- measured 3.3x faster on "mps". On CUDA
        # machines pass "cuda". Accuracy is unaffected; only speed changes.
        self.device = device

        self.camera_id = camera_id
        self.session_id = int(time.time())   # new every process start
        self.min_track_frames = min_track_frames
        self.plate_every = plate_every
        self.min_vehicle_w = min_vehicle_w

        self.tracks = {}
        self.frame_idx = 0
        self.last_frame_dets = []   # for draw_overlay, filled each frame
        self.frame_size = (0, 0)
        self.last_ts = time.time()
        self.model_desc = (f"{os.path.basename(str(vehicle_weights))}"
                           f"+{os.path.basename(str(plate_weights))}"
                           if plate_weights
                           else os.path.basename(str(vehicle_weights)))
        self.n_discarded = 0
        self.sequence = 0        # monotonic; never reset, never reused
        self.n_rejected_aspect = 0
        self.n_rejected_size = 0
        self.n_plate_infer = 0
        self.n_plate_skipped = 0
        self.last_fallback_boxes = None

        if self.plate_model is None:
            print("[warn] no plate weights given -- vehicles and tracking "
                  "only, no plate crops will be produced")

    # ------------------------------------------------------------------ #

    def _find_plate(self, vehicle_crop, offset_xy):
        """
        Run the plate detector on ONE vehicle crop.

        Returns (plate_bgr, plate_box_in_FRAME_coords, conf) or (None, None, 0).

        The offset is the thing people get wrong: the detector returns
        coordinates relative to the crop, and the rest of the system speaks
        frame coordinates. Convert here, once, and never think about it again.
        """
        if self.plate_model is None or vehicle_crop.size == 0:
            return None, None, 0.0

        res = self.plate_model.predict(vehicle_crop, conf=self.plate_conf,
                                       device=self.device, verbose=False)[0]
        if len(res.boxes) == 0:
            return None, None, 0.0

        h, w = vehicle_crop.shape[:2]
        veh_area = float(h * w) or 1.0

        # Filter on geometry FIRST, then take the most confident survivor.
        # Picking max-confidence before filtering lets a big confident bus
        # panel beat a small correct plate.
        xyxy = res.boxes.xyxy.cpu().numpy().astype(int)
        confs = res.boxes.conf.cpu().numpy()

        best_i, best_conf = -1, -1.0
        for i in range(len(confs)):
            px1, py1, px2, py2 = xyxy[i]
            px1, px2 = max(0, px1), min(w, px2)
            py1, py2 = max(0, py1), min(h, py2)
            bw, bh = px2 - px1, py2 - py1
            if bw < PLATE_MIN_BOX_W or bh < PLATE_MIN_BOX_H:
                continue
            if not (PLATE_ASPECT_MIN <= bw / bh <= PLATE_ASPECT_MAX):
                self.n_rejected_aspect += 1
                continue
            if bw > PLATE_MAX_WIDTH_FRAC * w:
                self.n_rejected_size += 1
                continue
            if (bw * bh) > PLATE_MAX_AREA_FRAC * veh_area:
                self.n_rejected_size += 1
                continue
            if confs[i] > best_conf:
                best_i, best_conf = i, float(confs[i])

        if best_i < 0:
            return None, None, 0.0

        px1, py1, px2, py2 = xyxy[best_i]
        px1, px2 = max(0, px1), min(w, px2)
        py1, py2 = max(0, py1), min(h, py2)
        conf = best_conf

        # pad outward to recover clipped edge characters
        pad_x = int(PLATE_PAD_X_FRAC * (px2 - px1))
        pad_y = int(PLATE_PAD_Y_FRAC * (py2 - py1))
        px1, px2 = max(0, px1 - pad_x), min(w, px2 + pad_x)
        py1, py2 = max(0, py1 - pad_y), min(h, py2 + pad_y)

        plate_bgr = vehicle_crop[py1:py2, px1:px2].copy()

        ox, oy = offset_xy
        frame_box = (px1 + ox, py1 + oy, px2 + ox, py2 + oy)
        return plate_bgr, frame_box, conf

    # ------------------------------------------------------------------ #

    def process_frame(self, frame, ts=None):
        """
        Feed one frame plus its capture timestamp (unix float from the ingest
        stage). Returns finished-vehicle events -- usually empty, since events
        are emitted when a vehicle LEAVES.

        ts defaults to now() so file playback still works, but in deployment
        the ingest stage must supply the real capture time: transit-time
        calculations between cameras depend on it.
        """
        self.frame_idx += 1
        if ts is None:
            ts = time.time()
        self.last_ts = ts
        self.frame_size = (frame.shape[1], frame.shape[0])

        # persist=True is what makes IDs survive across calls. Without it
        # every frame starts numbering from 1 and you have no tracking.
        results = self.vehicle_model.track(
            frame,
            persist=True,
            tracker="bytetrack.yaml",
            classes=list(VEHICLE_CLASSES),
            conf=self.vehicle_conf,
            imgsz=self.imgsz,
            device=self.device,
            verbose=False,
        )[0]

        # Escalate only on total failure. Note the fallback runs predict(),
        # not track(): re-running the tracker on the same frame would
        # corrupt its state. Tracking stays owned by the primary model, so
        # escalated detections carry no track id and are used for their
        # class only, on the next frame the primary recovers.
        if (self.vehicle_model_fb is not None
                and (results.boxes is None or len(results.boxes) == 0)):
            self.n_escalated += 1
            fb = self.vehicle_model_fb.predict(
                frame, classes=list(VEHICLE_CLASSES), conf=self.vehicle_conf,
                imgsz=self.imgsz, device=self.device, verbose=False)[0]
            if len(fb.boxes):
                self.n_escalate_hit += 1
                self.last_fallback_boxes = fb.boxes
            else:
                self.last_fallback_boxes = None
        else:
            self.last_fallback_boxes = None

        boxes = results.boxes
        self.last_frame_dets = []
        if boxes is not None and boxes.id is not None:
            ids = boxes.id.cpu().numpy().astype(int)
            xyxy = boxes.xyxy.cpu().numpy().astype(int)
            clss = boxes.cls.cpu().numpy().astype(int)

            H, W = frame.shape[:2]
            for tid, box, cls_id in zip(ids, xyxy, clss):
                x1, y1, x2, y2 = box
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(W, x2), min(H, y2)
                if x2 <= x1 or y2 <= y1:
                    continue

                if tid not in self.tracks:
                    self.sequence += 1
                    self.tracks[tid] = VehicleTrack(
                        tid, VEHICLE_CLASSES.get(int(cls_id), "vehicle"),
                        self.frame_idx,
                        camera_id=self.camera_id,
                        session_id=self.session_id,
                        sequence=self.sequence,
                        ts=ts, frame_size=self.frame_size)
                    self.tracks[tid].model_desc = self.model_desc

                tr = self.tracks[tid]
                veh_w = x2 - x1

                # --- decide whether this frame is worth a plate inference ---
                closer = veh_w > tr.max_vehicle_w * 1.03
                due = (self.frame_idx - tr.last_attempt) >= self.plate_every
                big_enough = veh_w >= self.min_vehicle_w

                plate_bgr = plate_box = None
                pconf = 0.0
                if big_enough and (closer or due):
                    tr.last_attempt = self.frame_idx
                    self.n_plate_infer += 1
                    plate_bgr, plate_box, pconf = self._find_plate(
                        frame[y1:y2, x1:x2], offset_xy=(x1, y1))
                else:
                    self.n_plate_skipped += 1

                tr.max_vehicle_w = max(tr.max_vehicle_w, veh_w)
                tr.update(self.frame_idx, (x1, y1, x2, y2),
                          plate_bgr, plate_box, pconf, ts=ts)

                # keep the newest plate box per track so the overlay still
                # shows one on frames where inference was skipped
                if plate_box is not None:
                    tr.last_plate_box = plate_box
                self.last_frame_dets.append((
                    (x1, y1, x2, y2),
                    getattr(tr, "last_plate_box", None),
                    tr.global_id, tr.vehicle_class, tr.direction()))

        return self._reap()

    def _reap(self):
        """Emit tracks that haven't been seen for a while. Drop fragments."""
        done = []
        for tid, tr in list(self.tracks.items()):
            if self.frame_idx - tr.last_frame > TRACK_TIMEOUT_FRAMES:
                tr = self.tracks.pop(tid)
                if tr.n_frames < self.min_track_frames:
                    self.n_discarded += 1
                    continue
                done.append(tr.to_event())
        return done

    def flush(self):
        """End of video -- emit whatever is still open."""
        out = []
        for tr in self.tracks.values():
            if tr.n_frames < self.min_track_frames:
                self.n_discarded += 1
                continue
            out.append(tr.to_event())
        self.tracks.clear()
        return out


# ---------------------------------------------------------------------- #

def run_image_folder(det, folder, save_crops, limit=0):
    """
    Image mode: every file is an independent frame.

    No tracking, no temporal voting, no direction -- there is no "next frame".
    What this DOES give you, which video cannot, is recall against ground
    truth: labelled still datasets tell you how many plates were there, so
    you can measure what you missed rather than only counting what you found.
    """
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    files = sorted(f for f in os.listdir(folder)
                   if os.path.splitext(f)[1].lower() in exts)
    if limit:
        files = files[:limit]
    if not files:
        raise SystemExit(f"no images in {folder}")

    if save_crops:
        os.makedirs(save_crops, exist_ok=True)

    n_veh = n_plate = n_none = 0
    t0 = time.time()

    for i, fn in enumerate(files, 1):
        img = cv2.imread(os.path.join(folder, fn))
        if img is None:
            continue
        H, W = img.shape[:2]

        res = det.vehicle_model.predict(
            img, classes=list(VEHICLE_CLASSES), conf=det.vehicle_conf,
            imgsz=det.imgsz, device=det.device, verbose=False)[0]

        boxes = res.boxes.xyxy.cpu().numpy().astype(int) if len(res.boxes) else []

        # If no vehicle is found, the image may already BE a cropped vehicle
        # (many plate datasets ship close-ups). Fall back to the whole frame
        # rather than reporting a miss that isn't one.
        if len(boxes) == 0:
            boxes = [(0, 0, W, H)]

        found = 0
        for j, (x1, y1, x2, y2) in enumerate(boxes):
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W, x2), min(H, y2)
            if x2 <= x1 or y2 <= y1:
                continue
            n_veh += 1
            crop, box, conf = det._find_plate(img[y1:y2, x1:x2], (x1, y1))
            if crop is not None and crop.size:
                found += 1
                n_plate += 1
                if save_crops:
                    stem = os.path.splitext(fn)[0]
                    cv2.imwrite(os.path.join(
                        save_crops, f"{stem}__v{j}_c{conf:.2f}.jpg"), crop)
        if not found:
            n_none += 1

        if i % 25 == 0:
            el = time.time() - t0
            sys.stdout.write(f"\r  {i}/{len(files)}  {i/el:4.1f} img/s  "
                             f"{n_plate} plates   ")
            sys.stdout.flush()

    sys.stdout.write("\r" + " " * 60 + "\r")
    el = time.time() - t0
    print(f"\n  images processed   : {len(files)}")
    print(f"  vehicle regions    : {n_veh}")
    print(f"  plate crops found  : {n_plate}")
    print(f"  images with 0 plate: {n_none}  "
          f"({100.0*n_none/len(files):.1f}%)")
    print(f"  rejected boxes     : {det.n_rejected_aspect} bad aspect, "
          f"{det.n_rejected_size} too large")
    print(f"  wall time {el:.1f}s   {len(files)/el:.1f} img/s")
    print()
    print("  NOTE: no tracking, no multi-frame voting, no direction in image")
    print("  mode. If your dataset has ground-truth plate labels, compare")
    print("  'plate crops found' against the true count -- that is RECALL,")
    print("  which video mode cannot give you.")
    if save_crops:
        print(f"\n  crops written to {save_crops}/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="video file, or RTSP url")
    ap.add_argument("--vehicle-weights", default="yolo11n.pt")
    ap.add_argument("--plate-weights", default=None)
    ap.add_argument("--stride", type=int, default=3,
                    help="process every Nth frame (3 = ~10fps from 30fps video)")
    ap.add_argument("--save-crops", default=None,
                    help="folder to write best plate crops into")
    ap.add_argument("--max-frames", type=int, default=0,
                    help="stop after N raw frames -- use it to smoke-test a clip")
    ap.add_argument("--device", default=None,
                    help="cpu | mps (Apple GPU) | cuda | 0. Default lets "
                         "Ultralytics choose, which is CPU on Apple Silicon")
    ap.add_argument("--vehicle-weights-fallback", default=None,
                    help="larger vehicle model, used ONLY when the primary "
                         "finds no vehicle at all (cascade)")
    ap.add_argument("--plate-every", type=int, default=PLATE_DETECT_EVERY_N,
                    help="attempt plate detection every Nth frame per track")
    ap.add_argument("--min-vehicle-width", type=int,
                    default=MIN_VEHICLE_WIDTH_FOR_PLATE,
                    help="skip plate detection on vehicles narrower than this")
    ap.add_argument("--events-out", default=None,
                    help="write events.jsonl -- the backend builds against this")
    ap.add_argument("--save-video", default=None,
                    help="write an annotated mp4 (demo / submission video)")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress the progress line")
    ap.add_argument("--region", default=DEFAULT_REGION,
                    choices=sorted(REGION_ASPECT_BANDS),
                    help="plate-geometry band for the deployment jurisdiction")
    ap.add_argument("--camera-id", default="CAM01",
                    help="identifies this camera in the global track id")
    ap.add_argument("--min-track-frames", type=int, default=MIN_TRACK_FRAMES,
                    help="drop tracks shorter than this (fragments)")
    args = ap.parse_args()

    global PLATE_ASPECT_MIN, PLATE_ASPECT_MAX
    PLATE_ASPECT_MIN, PLATE_ASPECT_MAX = REGION_ASPECT_BANDS[args.region]
    print(f"[region] {args.region}: plate aspect band "
          f"{PLATE_ASPECT_MIN}-{PLATE_ASPECT_MAX}")

    det = PlateDetector(args.vehicle_weights, args.plate_weights,
                        camera_id=args.camera_id,
                        min_track_frames=args.min_track_frames,
                        plate_every=args.plate_every,
                        min_vehicle_w=args.min_vehicle_width,
                        vehicle_weights_fallback=args.vehicle_weights_fallback,
                        device=args.device)
    # a directory of images is a valid source -- see run_image_folder
    if os.path.isdir(args.source):
        run_image_folder(det, args.source, args.save_crops, args.max_frames)
        return

    try:
        from ingest import CameraStream
        stream = CameraStream(args.source, camera_id=args.camera_id)
        cap = stream.cap
        use_ingest = True
    except ImportError:
        print("[warn] ingest.py not found -- falling back to bare "
              "VideoCapture (no reconnect, no capture timestamps)")
        stream = None
        cap = cv2.VideoCapture(args.source)
        use_ingest = False
    if cap is None or not cap.isOpened():
        raise SystemExit(f"cannot open {args.source}")

    if args.save_crops:
        os.makedirs(args.save_crops, exist_ok=True)

    # ------------------------------------------------------------------
    # Stage 1 handoff. ingest.CameraStream owns opening the source, keeping
    # frames fresh, reconnecting, and stamping capture time. We only consume.
    # Falls back to bare VideoCapture if ingest.py is absent, so the detector
    # stays runnable standalone.
    # ------------------------------------------------------------------
    writer = None
    if args.save_video:
        os.makedirs(os.path.dirname(os.path.abspath(args.save_video)) or ".",
                    exist_ok=True)
        # output fps is source fps / stride, so the annotated video plays at
        # real-world speed rather than in fast-forward
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        out_fps = max(1.0, src_fps / max(1, args.stride))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(args.save_video,
                                 cv2.VideoWriter_fourcc(*"mp4v"),
                                 out_fps, (w, h))
        if not writer.isOpened():
            raise SystemExit(f"cannot open writer for {args.save_video}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if args.max_frames:
        total = min(total, args.max_frames) if total else args.max_frames
    t0 = time.time()

    def _source_frames():
        """(frame, capture_ts) from the ingest stage, or a bare fallback."""
        if use_ingest:
            for f, ts, _fid in stream.frames():
                yield f, ts
        else:
            while True:
                ok, f = cap.read()
                if not ok:
                    return
                yield f, time.time()

    events, raw_idx, done = [], 0, 0
    for frame, cap_ts in _source_frames():
        raw_idx += 1
        if raw_idx % args.stride:
            continue
        if args.max_frames and raw_idx > args.max_frames:
            break
        events.extend(det.process_frame(frame, ts=cap_ts))
        done += 1

        if writer is not None:
            writer.write(draw_overlay(frame, det.last_frame_dets,
                                      raw_idx, len(events)))

        # progress every 25 processed frames -- a long run with no output is
        # indistinguishable from a hang, and this pipeline IS slow on CPU
        if not args.quiet and done % 25 == 0:
            el = time.time() - t0
            fps = done / el if el else 0
            if total:
                pct = 100.0 * raw_idx / total
                eta = (total - raw_idx) / args.stride / fps if fps else 0
                msg = (f"\r  {pct:5.1f}%  frame {raw_idx}/{total}  "
                       f"{fps:4.1f} fps  {len(events)} events  "
                       f"ETA {eta/60:4.1f} min   ")
            else:
                msg = (f"\r  frame {raw_idx}  {fps:4.1f} fps  "
                       f"{len(events)} events   ")
            sys.stdout.write(msg)
            sys.stdout.flush()
    if not args.quiet:
        sys.stdout.write("\r" + " " * 78 + "\r")
    events.extend(det.flush())
    if use_ingest:
        stream.release()
        print(f"  ingest stats: {stream.stats}")
    elif cap is not None:
        cap.release()
    if writer is not None:
        writer.release()

    print(f"\nprocessed {raw_idx} frames -> {len(events)} vehicle events "
          f"({det.n_discarded} fragments discarded)\n")
    by_status = defaultdict(int)
    for e in events:
        by_status[e["plate_status"]] += 1
        print(f"  {e['global_id']:<34}{e['vehicle_class']:<11}"
              f"{e['plate_status']:<13} frames={e['track_frames']:>3}  "
              f"plate_w={e['best_plate_width_px']:>4}px  "
              f"dir={e['direction_bearing_img_deg']}")

        if args.save_crops:
            uris = []
            for i, crop in enumerate(e["crops"]):
                fn = f"{e['global_id']}_{i}_q{e['crop_quality'][i]:.2f}.jpg"
                path = os.path.join(args.save_crops, fn)
                cv2.imwrite(path, crop)
                uris.append(path)
            e["plate_crop_uris"] = uris

    print("\n  " + "  ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
    print(f"  rejected plate boxes: {det.n_rejected_aspect} bad aspect, "
          f"{det.n_rejected_size} too large (bus boards / panels)")
    if det.vehicle_model_fb is not None:
        print(f"  cascade: escalated on {det.n_escalated} frames "
              f"({100.0*det.n_escalated/max(1,done):.1f}% of processed), "
              f"fallback found a vehicle in {det.n_escalate_hit}")
    tot_i = det.n_plate_infer + det.n_plate_skipped
    if tot_i:
        el = time.time() - t0
        print(f"  plate inferences: {det.n_plate_infer} run, "
              f"{det.n_plate_skipped} skipped "
              f"({100.0*det.n_plate_skipped/tot_i:.0f}% saved)")
        print(f"  wall time {el:.1f}s   {done/el:.1f} processed-fps")
    if args.save_crops:
        print(f"  crops written to {args.save_crops}/ -- feed these to OCR")
    if args.save_video:
        print(f"  annotated video: {args.save_video}")

    if args.events_out:
        import json
        with open(args.events_out, "w", encoding="utf-8") as fh:
            for e in events:
                fh.write(json.dumps(to_payload(e)) + "\n")
        print(f"  events written to {args.events_out} "
              f"(JSON-safe, crops stripped -- give this to the backend)")


if __name__ == "__main__":
    main()
