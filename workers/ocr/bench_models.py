#!/usr/bin/env python3
"""
Throughput benchmark for vehicle+plate detection configurations.

Why this exists: our earlier speed numbers were taken in separate sessions,
under different thermal and background-load conditions, and produced an
impossible result (a cascade doing strictly more work than its own baseline
appeared to run 32% FASTER). Wall-clock across sessions is not a measurement.

What this fixes:
  - all configs timed BACK-TO-BACK in one process
  - images decoded ONCE into RAM, so disk I/O is excluded
  - warm-up iterations discarded (first inference is always slow)
  - N repeats, reporting MEDIAN not a single run
  - background load checked before starting
  - hardware recorded in the output

Accuracy is unaffected by any of this -- recall is hardware-independent.
Only throughput needs controlled conditions.

    python bench_models.py --images ~/Downloads/tbFcZE-RodoSol-ALPR/images/motorcycles-me \
        --plate-weights plate_model/license-plate-finetune-v1m.pt --n 60 --repeats 3
"""
import argparse
import json
import os
import platform
import statistics
import sys
import time

import cv2

# (label, primary vehicle model, cascade fallback or None)
CONFIGS = [
    ("yolo11n",        "yolo11n.pt", None),
    ("yolo26n",        "yolo26n.pt", None),
    ("cascade n->s",   "yolo11n.pt", "yolo11s.pt"),
    ("yolo11s",        "yolo11s.pt", None),
    ("yolo11m",        "yolo11m.pt", None),
]


def hardware():
    info = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or platform.machine(),
        "cpu_count": os.cpu_count(),
        "python": platform.python_version(),
    }
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
        info["mps"] = getattr(torch.backends, "mps", None) is not None and \
            torch.backends.mps.is_available()
    except Exception:
        pass
    return info


def check_load():
    """A busy machine invalidates the comparison. Warn loudly."""
    try:
        load1, _, _ = os.getloadavg()
    except (OSError, AttributeError):
        return
    cores = os.cpu_count() or 1
    ratio = load1 / cores
    if ratio > 0.3:
        print(f"\n  !! load average {load1:.1f} on {cores} cores "
              f"({100*ratio:.0f}%). Other processes are running.")
        print("  !! Throughput numbers will not be comparable. "
              "Stop other jobs and re-run.\n")
    else:
        print(f"  machine idle (load {load1:.2f} / {cores} cores)\n")


def time_config(label, primary, fallback, frames, warmup, repeats,
                plate_weights, device=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from detector import PlateDetector

    det = PlateDetector(primary, plate_weights, camera_id="BENCH",
                        vehicle_weights_fallback=fallback, device=device)

    # Warm-up: first inference allocates buffers and JIT-compiles kernels.
    # Including it would penalise whichever config runs first.
    for f in frames[:warmup]:
        det.process_frame(f)

    times = []
    for _ in range(repeats):
        det2 = PlateDetector(primary, plate_weights, camera_id="BENCH",
                             vehicle_weights_fallback=fallback, device=device)
        for f in frames[:warmup]:
            det2.process_frame(f)
        t0 = time.perf_counter()
        for f in frames:
            det2.process_frame(f)
        times.append(time.perf_counter() - t0)

    med = statistics.median(times)
    return {
        "label": label,
        "device": device or "auto",
        "primary": primary,
        "fallback": fallback,
        "n_frames": len(frames),
        "repeats": repeats,
        "median_s": round(med, 2),
        "min_s": round(min(times), 2),
        "max_s": round(max(times), 2),
        "spread_pct": round(100 * (max(times) - min(times)) / med, 1),
        "fps": round(len(frames) / med, 2),
        "ms_per_frame": round(1000 * med / len(frames), 1),
        "escalated": det2.n_escalated,
        "plate_infer": det2.n_plate_infer,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True, help="folder of test images")
    ap.add_argument("--plate-weights", required=True)
    ap.add_argument("--n", type=int, default=60, help="frames per timed run")
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--configs", default=None,
                    help="comma-separated subset of config labels")
    ap.add_argument("--device", default=None,
                    help="cpu | mps | cuda. Default = Ultralytics' choice "
                         "(CPU on Apple Silicon, leaving the GPU idle)")
    ap.add_argument("--out", default="bench_results.json")
    args = ap.parse_args()

    hw = hardware()
    print("\n" + "=" * 72)
    print("  THROUGHPUT BENCHMARK")
    print("=" * 72)
    for k, v in hw.items():
        print(f"  {k:<12} {v}")
    check_load()

    # Decode once into RAM. Disk I/O is not what we are measuring, and
    # OS page-cache warming would favour whichever config runs second.
    exts = {".jpg", ".jpeg", ".png"}
    files = sorted(f for f in os.listdir(args.images)
                   if os.path.splitext(f)[1].lower() in exts)[:args.n]
    if len(files) < args.n:
        print(f"  only {len(files)} images available")
    frames = [cv2.imread(os.path.join(args.images, f)) for f in files]
    frames = [f for f in frames if f is not None]
    if not frames:
        sys.exit("no readable images")
    h, w = frames[0].shape[:2]
    print(f"  {len(frames)} frames at {w}x{h}, decoded into RAM")
    print(f"  device: {args.device or 'auto (CPU on Apple Silicon)'}")
    print(f"  {args.warmup} warm-up frames discarded, "
          f"{args.repeats} timed repeats, reporting median\n")

    wanted = ([c.strip() for c in args.configs.split(",")]
              if args.configs else None)
    rows = []
    for label, primary, fallback in CONFIGS:
        if wanted and label not in wanted:
            continue
        print(f"  running {label} ...", end=" ", flush=True)
        try:
            r = time_config(label, primary, fallback, frames,
                            args.warmup, args.repeats, args.plate_weights,
                            device=args.device)
            rows.append(r)
            print(f"{r['fps']} fps  (spread {r['spread_pct']}%)")
        except Exception as e:
            print(f"FAILED: {e}")

    if not rows:
        sys.exit("no configs completed")

    base = rows[0]
    print("\n" + "-" * 72)
    print(f"  {'config':<16}{'fps':>8}{'ms/frame':>11}{'vs base':>10}"
          f"{'spread':>9}{'escal.':>9}")
    print("  " + "-" * 70)
    for r in rows:
        rel = r["fps"] / base["fps"]
        print(f"  {r['label']:<16}{r['fps']:>8.2f}{r['ms_per_frame']:>11.1f}"
              f"{rel:>9.2f}x{r['spread_pct']:>8.1f}%"
              f"{r['escalated']:>9}")
    print("  " + "-" * 70)
    print(f"  baseline = {base['label']}   device = {base['device']}")
    print("\n  Spread is max-min across repeats. Above ~10% means the machine")
    print("  was not stable and the comparison should be repeated.")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"hardware": hw, "results": rows}, fh, indent=2)
    print(f"\n  written to {args.out}")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    main()
