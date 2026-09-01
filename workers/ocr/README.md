# OCR Worker — Detection Stage

Detection half of the OCR worker: RTSP/video frames in, **ranked plate crops
out**. The recognition half reads those crops and publishes `PlateSighting`
to the `plate_sightings` Redis Stream.

```
frames ─▶ [detection: this module] ─▶ ranked crops ─▶ [recognition] ─▶ PlateSighting
```

**This module does not read plates and does not publish to Redis.** Its output
is the worker-internal handoff. `plate_sighting_adapter.py` fills every
contract field the detection stage owns, so recognition only adds
`raw_plate_text`, `normalized_plate`, `ocr_confidence` and `ocr_candidates`.

## Results

| | |
|---|---|
| Plate detection recall@0.5 | **88.6 %** (20,000 annotated images) |
| Trucks / buses / cars / two-wheelers | 96.2 % / 91.5 % / 91.7 % / 89.7 % |
| Night | 82.2 % |
| Throughput | **29.5 fps** (`yolo11s`, Apple GPU, 1280×720) |
| Tracking | 0–32 % fragment rate, 4 countries, fixed and moving cameras |

Full measurements and limitations: [docs/RESULTS.md](docs/RESULTS.md).
Recall is measured on Brazilian toll-booth footage; Indian evidence is two
clips, reported separately in §7.

## Install

```bash
pip install ultralytics lap opencv-python
hf download morsetechlab/yolov11-license-plate-detection \
    license-plate-finetune-v1m.pt --local-dir plate_model
```

`lap` is a ByteTrack dependency that Ultralytics auto-downloads on first use.
Install it explicitly — the auto-download **fails on an offline machine**.

## Run

```bash
python detector.py \
    --source video.mp4 \
    --camera-id CAM-12 \
    --plate-weights plate_model/license-plate-finetune-v1m.pt \
    --vehicle-weights yolo11s.pt \
    --device mps \
    --region india \
    --stride 3 \
    --save-crops out/ \
    --events-out events.jsonl
```

`--source` takes a video file, `rtsp://` URL, image folder, or numbered frame
sequence (`"frames/img_%05d.png"`).

**`--device`** — Ultralytics defaults to CPU on Apple Silicon, leaving the GPU
idle. `mps` measured 2.7–2.9× faster; use `cuda` on NVIDIA.

**`--region`** — plate-geometry band from national standards
(`india` | `mercosur` | `global`). The wrong band costs up to 56 points of
recall on two-wheelers (RESULTS §4).

## Handing off to recognition

```python
from anpr_common import PlateSighting
from plate_sighting_adapter import detection_fields

payload = {
    **detection_fields(event, camera_code="CAM-12",
                       camera_heading_deg=cam.heading_degrees),
    "raw_plate_text": voted_text,
    "normalized_plate": normalized,
    "ocr_confidence": voted_conf,
    "ocr_candidates": candidates,
}
r.xadd(STREAM_NAME, {"data": PlateSighting(**payload).model_dump_json()})
```

**Three things recognition must not misread:**

1. **Five crops per vehicle, not one.** Vote across them — measured +33 %
   relative on marginal footage, zero gain on clean ANPR geometry
   (RESULTS §9). `ocr_candidates` in the contract is the output of that vote.
2. **`crop_quality` is a voting weight, not a plate-ness score.** Measured
   against ground truth, real plates and false positives overlap almost
   completely in quality score (RESULTS §10). Weight votes with it; do not
   select a single crop by it.
3. **`UNREAD` and `NO_PLATE` events are still emitted.** They count toward
   traffic density. Publish them with `normalized_plate: null`.

## Contract notes

`plate_sighting_adapter.py` handles four conversions that would otherwise be
silent bugs:

- **`captured_at` → UTC.** The detector stamps local offset; the contract
  requires `Z`.
- **`vehicle_type`.** COCO emits `motorcycle`; the contract enum is
  `two_wheeler`.
- **`direction_degrees` → compass.** The detector measures image-space bearing
  (0° = up the frame). The contract field drives the `wrong_direction`
  anomaly, so it needs `cameras.heading_degrees` added. **Publishing the raw
  image bearing would make that alert fire on nothing.**
- **`event_id`.** Built to the documented `<camera>-<track>-<UTC compact ts>`
  convention, since it is the `sightings.source_event_id` idempotency key.

## Tools

| Script | Purpose |
|---|---|
| `ingest.py` | Frame source: threaded reader, RTSP reconnection, capture timestamps |
| `detector.py` | Detection, tracking, crop ranking |
| `plate_sighting_adapter.py` | Detection half of the contract |
| `eval_rodosol.py` | Recall vs ground truth; exports a labelled OCR test set |
| `bench_models.py` | Controlled throughput benchmark across model configs |
| `audit_crops.py` | Browser crop audit with keyboard judging |
| `benchmark.py`, `make_labels.py` | OCR scoring and label templates |

## Licensing

Ultralytics YOLO and the morsetechlab plate detector are **AGPL-3.0**.
Production needs an Ultralytics Enterprise licence or an MIT/Apache detector
behind the same interface.

RodoSol-ALPR and UFPR-ALPR are **non-commercial academic use only and may not
be redistributed** — no dataset images are in this repository. See
[docs/REFERENCES.md](docs/REFERENCES.md) for required citations.
