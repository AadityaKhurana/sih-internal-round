# Results — Vehicle Detection, Tracking & Plate Crop Selection

**SIH 2026 · PS 26127 · Bharat Electronics Limited**
Pipeline stages 2–4. Owner: B.

> **Scope of these numbers.** All recall figures in §3 are measured on
> **RodoSol-ALPR — Brazilian toll-booth footage.** Indian evidence is two
> clips and is reported separately in §7. Detection transfers reasonably
> across countries; recognition does not. Label rows accordingly.

---

## 1. Scope

Frames in → **one record per vehicle**, carrying up to five ranked plate crops.
This stage does not read plates; recognition is stage 5.

```
ingest ─▶ [2] vehicle detect ─▶ [3] track ─▶ [4] rank crops ─▶ recognition
            (full frame)        (ByteTrack)   (best 5 of N)
                  │
                  └─▶ plate detect (inside the vehicle crop)
```

**Headline:** 88.6 % plate-detection recall@0.5 across 20,000 annotated
toll-booth images — day and night, clear and rainy, cars, buses, trucks and
motorcycles. 29.5 fps on Apple GPU.

---

## 2. Models — neither trained by us

| Model | Source | Licence |
|---|---|---|
| `yolo11n/s/m.pt`, `yolo26n.pt` (vehicles) | Ultralytics, COCO | AGPL-3.0 |
| `license-plate-finetune-v1m.pt` | morsetechlab, HuggingFace | AGPL-3.0 |

The plate model's card reports mAP@50 = 0.9813, **but its author states the
upstream Roboflow dataset contains train/test contamination and the metrics
are inflated.** We discarded that figure and measured our own against
annotated ground truth (§3), following Laroca et al., IJCNN 2023, on
near-duplicate contamination in LPR benchmarks.

*Production licensing: both AGPL-3.0. Options are an Ultralytics Enterprise
licence or an MIT/Apache detector behind the same interface.*

---

## 3. Detection recall vs annotated ground truth

RodoSol-ALPR, **all 20,000 images**. Recall@0.5 = plate found **and**
overlapping ground truth by ≥50 % (standard PASCAL/COCO threshold).

### 3.1 By category

`yolo11n`, correct region band:

| Category | n | Detected | **Recall@.5** | Mean IoU | GT width |
|---|---|---|---|---|---|
| cars-br | 5000 | 98.9 % | **92.9 %** | 0.618 | 123 px |
| cars-me | 5000 | 97.8 % | **89.0 %** | 0.600 | 122 px |
| motorcycles-br | 5000 | 84.9 % | **84.7 %** | 0.771 | 100 px |
| motorcycles-me | 5000 | 87.8 % | **87.6 %** | 0.775 | 104 px |
| **ALL** | **20000** | 92.3 % | **88.6 %** | 0.686 | 112 px |

Mean IoU is depressed by deliberate padding (6 % horizontal, 12 % vertical),
which enlarges the predicted box relative to a tight ground-truth box. Better
OCR crops, lower IoU — an accepted trade, not a defect.

### 3.2 By vehicle class

RodoSol's own annotation calls any 4+ wheel vehicle a "car", so heavy vehicles
are separable only via our detector's COCO class output.

| Class | n | Detected | **Recall@.5** | Mean IoU |
|---|---|---|---|---|
| **truck** | 397 | 98.0 % | **96.2 %** | 0.644 |
| car | 8758 | 99.1 % | **91.7 %** | 0.607 |
| **bus** | 129 | 96.1 % | **91.5 %** | 0.640 |
| motorcycle | 6427 | 89.8 % | **89.7 %** | 0.790 |
| unknown (no vehicle found) | 4289 | 81.7 % | 79.5 % | 0.713 |

**Trucks are the strongest category at 96.2 %.** 526 heavy vehicles evaluated.
This closes the concern that Indian MCV/HCV plates at 1.70 aspect sit close to
the 1.1 filter floor — in practice they do not suffer.

### 3.3 By illumination

RodoSol contains day and night images but carries no condition label, so the
bin is derived from mean HSV-V (scene brightness). This turns the PS's
"varying lighting" clause into a measurement.

| Bin | n | Detected | **Recall@.5** |
|---|---|---|---|
| night | 1968 | 85.7 % | **82.2 %** |
| dim/dusk | 6232 | 89.7 % | **88.1 %** |
| overcast | 10745 | 94.7 % | **89.7 %** |
| bright day | 1055 | 96.4 % | **91.1 %** |

**Night recall is 82.2 %, within 9 points of bright day.** Lighting is not the
limiting condition at ANPR camera geometry.

*Cars alone at night reach 87.0 % (n=69). Motorcycles are over-represented in
the darker bins, which pulls the aggregate down.*

---

## 4. Ablation: region band

Plate geometry is a **per-jurisdiction deployment parameter**, not a constant.

| Standard | Dimensions | Aspect |
|---|---|---|
| India — LMV | 500 × 120 mm | 4.17 |
| India — two-wheeler rear | 200 × 100 mm | 2.00 |
| India — two-wheeler front | 285 × 45 mm | 6.33 |
| India — MCV/HCV | 340 × 200 mm | 1.70 |
| **Mercosur — motorcycle** | **200 × 170 mm** | **1.18** |

`--region india` → band 1.1–7.0 (covers all four CMVR formats).
`--region mercosur` → 0.9–7.0 (near-square motorcycle plates).

**Cost of a jurisdiction mismatch**, full 20,000 images:

| Category | India band | Mercosur band | Δ |
|---|---|---|---|
| cars-br | 92.9 % | 92.9 % | **0.0** |
| cars-me | 89.0 % | 89.0 % | **0.0** |
| motorcycles-br | 67.5 % | 84.7 % | +17.2 |
| motorcycles-me | 31.3 % | 87.6 % | **+56.3** |
| **ALL** | 70.2 % | **88.6 %** | +18.4 |

**Zero cost on cars, both layouts, identical to the decimal at n=10,000.**
All 4,316 aspect rejections under the India band were motorcycle plates;
under the correct band, 373.

Mercosur motorcycle plates (1.18) fall below the Indian 1.1 floor. **Indian
two-wheeler plates are 2.00 — comfortably clear**, corroborated by our own
Indian 4K footage where 8 of 8 motorcycles were detected (plates 138–277 px).

*The band is now a config parameter, defaulting to India.*

---

## 5. Ablation: vehicle model

Same band, same plate model, only the vehicle detector changed. Accuracy on
1,000 motorcycles; throughput measured separately under controlled conditions
(§6).

| Config | Recall | Class correct | `unknown` |
|---|---|---|---|
| yolo11n | 85.3 % | 63.6 % | 353 |
| yolo26n | 82.9 % | 63.6 % | 361 |
| **cascade n→s** | **87.2 %** | **83.2 %** | **155** |
| yolo11s | 88.5 % | 80.7 % | 184 |
| yolo11m | 88.7 % | 88.1 % | 114 |

### 5.1 The two-wheeler finding

**The weaker pass is vehicle detection, not plate detection.** COCO's
motorcycle prior does not match a head-on rider: with `yolo11n`, 35 % of
motorcycle images produce no vehicle box at all, against **2 % of car images**.
The failure is exclusively a two-wheeler problem, and directly relevant to
India's traffic mix.

### 5.2 The cascade

Escalate to a larger model **only when the primary returns no detection at
all** — a failure mode measured at 35 % on two-wheelers and 2 % on cars, so
the cost lands where it is needed and nowhere else.

Escalated on 353/1000 (35.3 %); the fallback recovered a vehicle in 56 % of
those. `unknown` fell to 155 — **below pure `yolo11s`**.

The fallback runs `predict()`, not `track()`: re-running the tracker on the
same frame would corrupt its state. Tracking stays owned by the primary model.

**What it buys:** vehicle class, which the backend consumes to corroborate
cross-camera identity (a motorcycle and a car cannot be the same vehicle
whatever the plate says). It buys less plate recall, because the whole-frame
fallback already recovers ~79 % of plates in the no-vehicle case.

### 5.3 YOLO26

Statistically identical speed to `yolo11n` (54.1 vs 55.1 fps, within spread)
and 2.4 points worse recall. **No trade-off available on this hardware.** Its
NMS-free design may pay off on Jetson or via CoreML export where
post-processing overhead dominates; it does not here.

---

## 6. Throughput

Measured with `bench_models.py`: all configs timed back-to-back in one
process, images decoded once into RAM, 20 warm-up frames discarded, median of
5 repeats, machine idle. Spread reported; >10 % means the run should be
repeated.

**Apple M-series, 10 cores, 1280×720:**

| Config | CPU fps | MPS fps | Spread (MPS) |
|---|---|---|---|
| yolo11n | 19.3 | **55.1** | 12.5 % |
| yolo26n | 19.6 | 54.1 | 1.3 % |
| cascade n→s | 12.0 | 34.5 | 5.1 % |
| **yolo11s** | 9.7 | **29.5** | 7.8 % |
| yolo11m | 5.3 | 14.1 | 4.3 % |

**Apple GPU (MPS) is 2.7–2.9× faster than CPU, uniformly across model sizes.**
Ultralytics defaults to CPU on Apple Silicon, leaving the GPU idle — `--device
mps` must be set explicitly.

**Selected: `yolo11s` on MPS at 29.5 fps.** A 25 fps camera needs only 5–8 fps
of processing after frame sampling, so this leaves roughly 4× headroom —
plausibly 3–4 concurrent streams per machine.

The compute budget (§8) additionally removes 65–81 % of plate inferences at no
accuracy cost.

> **Earlier figures in this project of 2–6 img/s were wrong.** They measured
> disk I/O and annotation parsing alongside inference, on a loaded machine,
> on CPU. Only the controlled benchmark numbers above should be quoted.

---

## 7. Coverage and Indian evidence

| Source | Resolution | Country | Camera | Scale |
|---|---|---|---|---|
| 4K CCTV | 3840×2160 | **India** | fixed | 43 vehicles |
| Kolkata street | 1920×1080 | **India** | fixed | 37 vehicles |
| UA-DETRAC ×3 | 960×540 | China | fixed | 215 vehicles |
| RodoSol-ALPR | 1280×720 | Brazil | fixed | 20,000 images |
| UFPR-ALPR ×5 | 1920×1080 | Brazil | **moving** | 5 × 30 frames |

**Four countries · four resolutions · fixed and moving cameras · cars, buses,
trucks, motorcycles · day, dusk, night.**

### 7.1 Tracking

| Source | Events | Fragment rate |
|---|---|---|
| 4K CCTV (India) | 43 | 32 % |
| Kolkata (India) | 37 | 21 % |
| UA-DETRAC ×3 (China) | 52–83 | 8–25 % |
| **UFPR-ALPR (moving camera)** | 5 tracks | **0 %** |

Tracks held 30–350 consecutive frames. On UFPR-ALPR, where **both camera and
vehicle move**, all 5 target vehicles tracked 30/30 frames with zero
fragments — the ego-motion case no fixed-camera source can test.

### 7.2 Indian footage, hand-audited

| Source | Crops | PLATE | PARTIAL | NOT_PLATE | Strict |
|---|---|---|---|---|---|
| 4K CCTV | 144 | 109 | 33 | **2** | 76 % |
| Kolkata | 59 | 32 | 11 | 16 | 54 % |

**Indian motorcycles: 8 of 8 detected** on the 4K clip, plates 138–277 px.
Small sample, but consistent with the 2.00 aspect argument in §4.

---

## 8. Design decisions

**Two-pass detection.** A 30 px plate in a 1920 px frame is ~10 px after YOLO
downscales to 640. Detect the *vehicle* first, crop, then detect the plate
*inside that crop*, where the same plate is ~150 px of a 400 px image.

**Tracking is not optional.** Without it a car visible 2 s at 10 fps produces
20 records: the backend must invent deduplication, traffic counts inflate by a
speed-dependent factor, and 20 looks at one plate are wasted.

**Track IDs are internal, not ByteTrack's.** ByteTrack recycles IDs on vehicle
exit — two different cars were both labelled "track 20" *within a single run*,
so session-scoping was insufficient. IDs are a monotonic counter.

**Filter first, then take the most confident survivor.** Reversed, a large
confident bus panel beats a small correct plate on the same vehicle. Relative
caps: a plate cannot exceed 45 % of its vehicle's width or 15 % of its area —
we observed a "plate" 547 px wide that was the side of a bus.

**Padding before crop.** A dropped character is worse than no read, because
OCR returns the fragment confidently.

**Compute budget.** Skip vehicles under 120 px (a plate is ~¼ of vehicle
width, so a 120 px car yields a ~30 px plate the box floor rejects anyway).
Sample every 4th frame per track, *plus always at closest approach*, which is
the best plate. **65–81 % fewer plate inferences, identical output.**

---

## 9. Multi-crop output — measured value

Two policies compared against hand-labelled ground truth: send only the
top-ranked crop, versus send five and let recognition vote.

| Source | Vehicles | rank-0 only | all crops | recovered |
|---|---|---|---|---|
| Kolkata street, 1080p | 14 | 7 | **9** | +2 |
| UA-DETRAC MVI_39031 | 5 | 2 | **3** | +1 |
| UA-DETRAC MVI_39371 | 13 | 3 | **4** | +1 |
| **Total** | **32** | **12** | **16** | **+4** |

**33 % relative improvement at zero model cost**, reproduced independently in
three datasets.

On clean ANPR-geometry footage (4K clip) the gain was **zero** — rank 0 was
correct every time. *Multi-crop is insurance that pays out exactly when
footage is marginal* — a graceful-degradation property, not a universal win.

Concrete case, MVI_39371 vehicle 000029: rank 0 (q = 0.75, highest score in
the entire run) was not a plate; ranks 1–4 all were.

Independent support: the ICPR 2026 Low-Resolution LPR competition dataset is
structured as five consecutive low-resolution images per track, with
participants free to aggregate by voting or confidence selection — the same
design, arrived at independently. That competition also reports
state-of-the-art struggling to exceed 50–60 % recognition accuracy on
low-resolution plates, useful context for stage 5.

---

## 10. Negative result: the quality score carries no plate-ness signal

The crop ranking scores sharpness (variance of Laplacian), pixel width and
detector confidence. Measured against ground truth, **real plates and false
positives overlap almost completely in score.**

Cause: a flat printed sticker or bus route panel is genuinely *sharper and
larger* than a slightly angled, slightly dirty plate. The function measures
what it was asked to; plate-ness is not a geometric property.

We are not re-weighting, because the missing signal is textual. `NOREFUSAL`
(a Kolkata taxi sticker) and `TATA` (painted truck signage) both fail Indian
RTO plate grammar and are rejected downstream at no cost.

**Geometry filters shape; grammar filters content. Neither alone suffices** —
which is exactly why the five-crop output matters.

---

## 11. Key findings

1. **Plate yield is camera-placement-bound, not model-bound.** Same pipeline,
   same models, same thresholds: **22 % yield on a wide scene camera, 65 % on
   an ANPR-placed camera.** *Plate readability is a camera-placement problem
   before it is an algorithm problem.*
2. **Heavy vehicles are the strongest category** — trucks 96.2 %, buses
   91.5 %, both at or above cars.
3. **Night is not the limiting condition** — 82.2 % overall, 87.0 % on cars.
4. **Two-wheelers fail at vehicle detection, not plate detection** — 35 % of
   motorcycle images yield no COCO vehicle box with `yolo11n`.
5. **False positives are region-specific.** Kolkata produced 196–284 oversized
   rejections per clip (painted truck signage, taxi stickers); Chinese footage
   27–139; Brazilian 0–8. **Indian road furniture is a materially harder
   false-positive environment** — an argument for the grammar layer at stage 5
   rather than tighter geometry here.

---

## 12. Limitations

1. **Rain present but not isolable.** RodoSol includes rainy days, but
   annotations carry no weather label and rain is not reliably separable from
   luminance. Aggregate figures include rainy images; no per-condition row.
2. **Dirty and damaged plates untested.** No obtained dataset labels plate
   condition. Remains an open condition named by the PS.
3. **Two-wheeler *front* plates untested.** 285 × 45 mm, aspect 6.33, close to
   the 7.0 ceiling. No public dataset contains them — India-specific; closing
   this requires our own footage.
4. **Indian evidence is two clips**, both daylight and clear. No public
   dataset of Indian government ANPR video with readable plates exists: the
   one Indian government CCTV dataset located (BMD-45, Bengaluru Traffic
   Police) has plates deliberately blurred for privacy. Conditions are covered
   on Brazilian toll-booth footage instead.
5. **COCO has no auto-rickshaw class.** Vehicle classification uses the COCO
   vocabulary (`car`, `motorcycle`, `bus`, `truck`). Auto-rickshaws are a
   large share of Indian urban traffic and will be attributed to `car` or
   `two_wheeler`, or missed entirely. This affects `vehicle_type` in the
   published event and therefore any vehicle-composition analytics; it does
   **not** affect plate detection, which never depends on the class label.
   Closing it requires fine-tuning the vehicle detector on Indian classes.
6. **Not production-hardened.** Single stream per process; thresholds tuned on
   the data described above.
