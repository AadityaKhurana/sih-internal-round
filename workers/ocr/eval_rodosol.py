#!/usr/bin/env python3
"""
Evaluate plate DETECTION against RodoSol-ALPR ground truth.

This is the first measurement in this project that computes RECALL --
how many plates we MISSED. Every earlier number was "what came out",
never "what should have". RodoSol makes it possible because every image
carries the plate's four corners.

    python eval_rodosol.py --root ~/Downloads/tbFcZE-RodoSol-ALPR \
        --plate-weights plate_model/license-plate-finetune-v1m.pt \
        --per-category 300 --export-ocr-set ocr_testset/

Also exports a ground-truth-cropped, text-labelled OCR test set -- which
is the labelled data the recognition stage needs, with zero hand labelling.

Licence: RodoSol is non-commercial academic use only. Report aggregate
numbers; do not redistribute the images.
Cite: Laroca et al., VISAPP 2022.
"""
import argparse
import csv
import os
import random
import sys
import time
from collections import defaultdict

import cv2
import numpy as np

CATEGORIES = ["cars-br", "cars-me", "motorcycles-br", "motorcycles-me"]

# A detection counts as a hit at this overlap with the ground-truth box.
# 0.5 is the standard object-detection threshold (PASCAL VOC, COCO mAP@50).
IOU_HIT = 0.5


def parse_annotation(path):
    """
    RodoSol .txt format:
        type: car
        plate: ODE2510
        layout: Brazilian
        corners: 558,438 687,439 687,482 558,481
    """
    ann = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            ann[k.strip()] = v.strip()

    pts = []
    for pair in ann.get("corners", "").split():
        x, y = pair.split(",")
        pts.append((int(x), int(y)))
    if len(pts) != 4:
        return None

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    ann["corners_pts"] = pts
    # axis-aligned box enclosing the quad -- what our detector predicts
    ann["bbox"] = (min(xs), min(ys), max(xs), max(ys))
    return ann


# Illumination bins. RodoSol contains day and night images but the
# annotations carry no condition label, so we derive it: mean V channel of
# the HSV image is a direct proxy for scene brightness. This turns
# "varying lighting" from an untested condition into a measured breakdown.
LUX_BINS = [(0, 60, "night"), (60, 110, "dim/dusk"),
            (110, 160, "overcast"), (160, 256, "bright day")]


def lux_bin(img):
    v = float(np.mean(cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 2]))
    for lo, hi, name in LUX_BINS:
        if lo <= v < hi:
            return name, v
    return "bright day", v


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="RodoSol dataset root")
    ap.add_argument("--plate-weights", required=True)
    ap.add_argument("--vehicle-weights", default="yolo11n.pt")
    ap.add_argument("--vehicle-weights-fallback", default=None,
                    help="cascade: larger model used ONLY when the primary "
                         "finds no vehicle")
    ap.add_argument("--per-category", type=int, default=300)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--export-ocr-set", default=None,
                    help="write GT-cropped plates + labels.csv here")
    ap.add_argument("--save-misses", default=None,
                    help="write images we failed to detect, for inspection")
    ap.add_argument("--categories", default=",".join(CATEGORIES),
                    help="comma-separated subset to evaluate")
    # Filter overrides -- for ablation. The default aspect floor of 1.1 was
    # derived from Indian single-row (4.2) and two-row (1.4) plate ratios and
    # is too tight for near-square layouts such as Mercosur motorcycle plates.
    ap.add_argument("--aspect-min", type=float, default=None)
    ap.add_argument("--aspect-max", type=float, default=None)
    ap.add_argument("--region", default=None,
                    help="plate aspect band: india | mercosur | global")
    ap.add_argument("--no-filters", action="store_true",
                    help="disable geometric filters entirely -- shows the "
                         "detector's ceiling, i.e. how much OUR filters cost")
    args = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import detector as D
    from detector import PlateDetector, VEHICLE_CLASSES

    if args.region:
        D.PLATE_ASPECT_MIN, D.PLATE_ASPECT_MAX = \
            D.REGION_ASPECT_BANDS[args.region]
        print(f"[region] {args.region}")

    if args.no_filters:
        D.PLATE_ASPECT_MIN, D.PLATE_ASPECT_MAX = 0.1, 100.0
        D.PLATE_MAX_WIDTH_FRAC, D.PLATE_MAX_AREA_FRAC = 1.0, 1.0
        print("[ablation] geometric filters DISABLED")
    else:
        if args.aspect_min is not None:
            D.PLATE_ASPECT_MIN = args.aspect_min
        if args.aspect_max is not None:
            D.PLATE_ASPECT_MAX = args.aspect_max
    print(f"[filters] aspect {D.PLATE_ASPECT_MIN}-{D.PLATE_ASPECT_MAX}  "
          f"max_w_frac {D.PLATE_MAX_WIDTH_FRAC}  "
          f"max_area_frac {D.PLATE_MAX_AREA_FRAC}")

    det = PlateDetector(args.vehicle_weights, args.plate_weights,
                        camera_id="RODOSOL",
                        vehicle_weights_fallback=args.vehicle_weights_fallback)

    img_root = os.path.join(args.root, "images")
    if not os.path.isdir(img_root):
        sys.exit(f"no images/ under {args.root}")

    if args.export_ocr_set:
        os.makedirs(args.export_ocr_set, exist_ok=True)
        label_rows = []
    if args.save_misses:
        os.makedirs(args.save_misses, exist_ok=True)

    rng = random.Random(args.seed)
    def _blank():
        return {"n": 0, "hit": 0, "found": 0, "iou_sum": 0.0, "gt_w_sum": 0}

    results = defaultdict(_blank)
    by_lux = defaultdict(_blank)      # recall vs illumination
    by_class = defaultdict(_blank)    # recall vs vehicle type (COCO)
    t0 = time.time()

    wanted = [c.strip() for c in args.categories.split(",") if c.strip()]
    for cat in wanted:
        cdir = os.path.join(img_root, cat)
        if not os.path.isdir(cdir):
            print(f"[skip] {cat} not found")
            continue

        stems = sorted(f[:-4] for f in os.listdir(cdir) if f.endswith(".jpg"))
        rng.shuffle(stems)
        stems = stems[:args.per_category]

        for i, stem in enumerate(stems, 1):
            jpg = os.path.join(cdir, stem + ".jpg")
            txt = os.path.join(cdir, stem + ".txt")
            ann = parse_annotation(txt) if os.path.exists(txt) else None
            if ann is None:
                continue

            img = cv2.imread(jpg)
            if img is None:
                continue
            H, W = img.shape[:2]
            gt = ann["bbox"]

            # --- our pipeline: vehicle first, then plate inside the crop ---
            vres = det.vehicle_model.predict(
                img, classes=list(VEHICLE_CLASSES), conf=det.vehicle_conf,
                imgsz=det.imgsz, verbose=False)[0]
            # cascade: escalate only when the primary found nothing
            if len(vres.boxes) == 0 and det.vehicle_model_fb is not None:
                det.n_escalated += 1
                vres = det.vehicle_model_fb.predict(
                    img, classes=list(VEHICLE_CLASSES), conf=det.vehicle_conf,
                    imgsz=det.imgsz, verbose=False)[0]
                if len(vres.boxes):
                    det.n_escalate_hit += 1

            vboxes = (vres.boxes.xyxy.cpu().numpy().astype(int)
                      if len(vres.boxes) else [])
            # RodoSol images are tight vehicle shots; if COCO finds no
            # "car" (common for motorcycles head-on), fall back to the
            # whole frame rather than scoring a miss that is not one.
            if len(vboxes) == 0:
                vboxes = [(0, 0, W, H)]

            # what COCO called the largest vehicle -- lets us report recall
            # for buses and trucks separately, which RodoSol's own "car"
            # label lumps together (its README: "car" = any 4+ wheel vehicle)
            vcls = "unknown"
            if len(vres.boxes):
                areas = [(b[2]-b[0])*(b[3]-b[1])
                         for b in vres.boxes.xyxy.cpu().numpy()]
                k = int(np.argmax(areas))
                vcls = VEHICLE_CLASSES.get(
                    int(vres.boxes.cls.cpu().numpy()[k]), "unknown")

            lname, _lv = lux_bin(img)

            best_iou, best_box = 0.0, None
            for (x1, y1, x2, y2) in vboxes:
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(W, x2), min(H, y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                crop, box, _c = det._find_plate(img[y1:y2, x1:x2], (x1, y1))
                if box is None:
                    continue
                v = iou(gt, box)
                if v > best_iou:
                    best_iou, best_box = v, box

            buckets = [results[cat], by_lux[lname], by_class[vcls]]
            for b in buckets:
                b["n"] += 1
                b["gt_w_sum"] += gt[2] - gt[0]

            if best_box is not None:
                for b in buckets:
                    b["found"] += 1
                    b["iou_sum"] += best_iou
                    if best_iou >= IOU_HIT:
                        b["hit"] += 1
                if best_iou < IOU_HIT and args.save_misses:
                    cv2.imwrite(os.path.join(args.save_misses,
                                f"{cat}_{stem}_iou{best_iou:.2f}.jpg"), img)
            elif args.save_misses:
                cv2.imwrite(os.path.join(args.save_misses,
                            f"{cat}_{stem}_nodetect.jpg"), img)

            # --- OCR test set: crop the GROUND TRUTH box, keep the text ---
            # Independent of our detector, so the recognition stage is
            # measured on recognition alone, not on our detection errors.
            if args.export_ocr_set:
                gx1, gy1, gx2, gy2 = gt
                pad_x = int(0.06 * (gx2 - gx1))
                pad_y = int(0.12 * (gy2 - gy1))
                cx1, cy1 = max(0, gx1 - pad_x), max(0, gy1 - pad_y)
                cx2, cy2 = min(W, gx2 + pad_x), min(H, gy2 + pad_y)
                fn = f"{cat}_{stem}.jpg"
                cv2.imwrite(os.path.join(args.export_ocr_set, fn),
                            img[cy1:cy2, cx1:cx2])
                label_rows.append({
                    "filename": fn,
                    "truth": ann.get("plate", ""),
                    "condition": cat,
                    "rows": "2" if cat.startswith("motorcycles") else "1",
                    "layout": ann.get("layout", ""),
                    "gt_plate_width_px": gx2 - gx1,
                })

            if i % 25 == 0:
                sys.stdout.write(f"\r  {cat}: {i}/{len(stems)}   ")
                sys.stdout.flush()
        sys.stdout.write("\r" + " " * 50 + "\r")

    # ------------------------------------------------------------------ #
    el = time.time() - t0
    print()
    print("=" * 74)
    print("  PLATE DETECTION vs RodoSol-ALPR GROUND TRUTH")
    print("=" * 74)
    print(f"  {'category':<18}{'n':>5}{'detected':>10}{'recall@.5':>11}"
          f"{'mean IoU':>10}{'gt width':>10}")
    print("  " + "-" * 70)

    tot = {"n": 0, "hit": 0, "found": 0, "iou_sum": 0.0, "gt_w_sum": 0}
    for cat in wanted:
        if cat not in results:
            continue
        r = results[cat]
        for k in tot:
            tot[k] += r[k]
        print(f"  {cat:<18}{r['n']:>5}"
              f"{100.0*r['found']/r['n']:>9.1f}%"
              f"{100.0*r['hit']/r['n']:>10.1f}%"
              f"{r['iou_sum']/max(1, r['found']):>10.3f}"
              f"{r['gt_w_sum']/r['n']:>9.0f}px")
    print("  " + "-" * 70)
    print(f"  {'ALL':<18}{tot['n']:>5}"
          f"{100.0*tot['found']/max(1,tot['n']):>9.1f}%"
          f"{100.0*tot['hit']/max(1,tot['n']):>10.1f}%"
          f"{tot['iou_sum']/max(1, tot['found']):>10.3f}"
          f"{tot['gt_w_sum']/max(1,tot['n']):>9.0f}px")
    def _table(title, d, order=None):
        keys = order or sorted(d, key=lambda k: -d[k]["n"])
        keys = [k for k in keys if k in d and d[k]["n"]]
        if not keys:
            return
        print(f"\n  {title}")
        print("  " + "-" * 70)
        print(f"  {'':<18}{'n':>5}{'detected':>10}{'recall@.5':>11}"
              f"{'mean IoU':>10}{'gt width':>10}")
        for k in keys:
            r = d[k]
            print(f"  {k:<18}{r['n']:>5}"
                  f"{100.0*r['found']/r['n']:>9.1f}%"
                  f"{100.0*r['hit']/r['n']:>10.1f}%"
                  f"{r['iou_sum']/max(1,r['found']):>10.3f}"
                  f"{r['gt_w_sum']/r['n']:>9.0f}px")

    _table("BY ILLUMINATION (mean HSV-V, derived -- no condition label "
           "in annotations)", by_lux, [b[2] for b in LUX_BINS])
    _table("BY VEHICLE CLASS (COCO label of the largest detected vehicle)",
           by_class)

    print()
    if det.vehicle_model_fb is not None:
        print(f"\n  cascade: escalated {det.n_escalated}/{tot['n']} "
              f"({100.0*det.n_escalated/max(1,tot['n']):.1f}%), "
              f"fallback found a vehicle in {det.n_escalate_hit} "
              f"({100.0*det.n_escalate_hit/max(1,det.n_escalated):.0f}% "
              f"of escalations)")
    print(f"  rejected by filters: {det.n_rejected_aspect} bad aspect, "
          f"{det.n_rejected_size} too large")
    print(f"  {tot['n']} images in {el:.0f}s  ({tot['n']/el:.1f} img/s)")
    print()
    print("  recall@.5 = plate found AND overlapping ground truth by >=50%.")
    print("  THIS is the number that says what we miss. Everything measured")
    print("  before this was output count, not recall.")

    if args.export_ocr_set:
        csv_path = os.path.join(args.export_ocr_set, "labels.csv")
        with open(csv_path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(label_rows[0].keys()))
            w.writeheader()
            w.writerows(label_rows)
        print(f"\n  OCR test set: {len(label_rows)} ground-truth crops + "
              f"labels.csv\n  -> {args.export_ocr_set}/")
        print("  Hand it to the recognition stage with benchmark.py. "
              "No manual labelling needed.")
    if args.save_misses:
        print(f"  misses written to {args.save_misses}/ -- go look at them")
    print("=" * 74)


if __name__ == "__main__":
    main()
