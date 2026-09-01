#!/usr/bin/env python3
"""
Step 1 of 2: build a ground-truth template you fill in by hand.

Usage:
    python make_labels.py crops/ labels.csv

Then open labels.csv and type the correct plate for each image.
Leave 'truth' blank for any image you can't read yourself -- the
benchmark skips those rather than scoring them.

The 'condition' column is what turns one number into the per-condition
table you put on your slide. Tag honestly. Allowed values (edit freely):
    day, night, blur, oblique, dirty, far, twowheeler
Multiple tags separated by '|', e.g.  night|blur
"""
import csv
import os
import sys

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    folder, out_csv = sys.argv[1], sys.argv[2]

    files = sorted(
        f for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in IMG_EXT
    )
    if not files:
        print(f"No images found in {folder}")
        sys.exit(1)

    existing = {}
    if os.path.exists(out_csv):
        with open(out_csv, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                existing[row["filename"]] = row
        print(f"Found existing {out_csv} -- keeping labels already filled in.")

    with open(out_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["filename", "truth", "condition", "rows"])
        for f in files:
            prev = existing.get(f, {})
            w.writerow([
                f,
                prev.get("truth", ""),
                prev.get("condition", "day"),
                prev.get("rows", "1"),
            ])

    print(f"Wrote {out_csv} with {len(files)} rows.")
    print("Now fill in the 'truth' column, then run benchmark.py")


if __name__ == "__main__":
    main()
