#!/usr/bin/env python3
"""
Step 2 of 2: score the model against your ground truth.

Usage:
    python benchmark.py --results results.json --labels labels.csv

Outputs:
    - a report printed to the terminal (this is your slide)
    - confusion_matrix.json   <- hand this to the backend team, their
                                 fuzzy matching is parameterised by it
    - failures.csv            <- every miss, so you can eyeball what broke

Stdlib only. No installs.
"""
import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# ---------------------------------------------------------------- #
# Indian plate grammar.
#
# Sources to re-verify yourself before you defend this to a judge:
#   - RTO format: STATE(2 letters) DISTRICT(1-2 digits) SERIES(0-3 letters) NUMBER(4 digits)
#   - Bharat series: 22BH1234AA
#   - Reported convention: letters O and I are avoided to prevent
#     confusion with 0 and 1. VERIFY which parts of the plate this
#     applies to before relying on it.
# ---------------------------------------------------------------- #

STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ",
    "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP",
    "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UA",
    "UK", "UP", "WB",
}

PATTERNS = [
    ("standard",  re.compile(r"^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{4})$")),
    ("no_series", re.compile(r"^([A-Z]{2})(\d{1,2})(\d{4})$")),
    ("bharat",    re.compile(r"^(\d{2})(BH)(\d{4})([A-Z]{1,2})$")),
]

# Digit-position fixes: a letter appearing where a digit belongs.
LETTER_TO_DIGIT = {
    "O": "0", "D": "0", "Q": "0",
    "I": "1", "L": "1",
    "Z": "2",
    "A": "4",
    "S": "5",
    "G": "6",
    "T": "7",
    "B": "8",
}

# Letter-position fixes: a digit appearing where a letter belongs.
# Note we deliberately never produce O or I here.
DIGIT_TO_LETTER = {
    "0": "D",
    "1": "T",
    "2": "Z",
    "4": "A",
    "5": "S",
    "6": "G",
    "8": "B",
}


def normalise(s):
    """Uppercase, strip anything that isn't A-Z0-9."""
    if s is None:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(s).upper())


def grammar_fix(plate):
    """
    Try to coerce a read into a valid Indian plate.

    Returns (fixed_string, is_valid, layout_name).
    Conservative on purpose: only rewrites characters, never inserts,
    deletes or reorders. If nothing fits, hands back the input unchanged.
    """
    p = normalise(plate)
    if not p:
        return p, False, "empty"

    for name, rx in PATTERNS:
        if rx.match(p):
            if name != "bharat" and p[:2] not in STATE_CODES:
                continue
            return p, True, name

    # Standard layout is by far the most common -- try to repair into it.
    # Length 9 or 10 covers the overwhelming majority of plates.
    if len(p) in (9, 10):
        n_series = len(p) - 6  # 2 state + district + series + 4 number
        district_len = 2 if len(p) == 10 else 1
        # Two plausible splits; test both, take the first that validates.
        for district_len in (2, 1):
            n_series = len(p) - 2 - district_len - 4
            if not 1 <= n_series <= 3:
                continue
            i = 0
            out = []
            # state: letters
            for _ in range(2):
                c = p[i]
                out.append(DIGIT_TO_LETTER.get(c, c) if c.isdigit() else c)
                i += 1
            # district: digits
            for _ in range(district_len):
                c = p[i]
                out.append(LETTER_TO_DIGIT.get(c, c) if c.isalpha() else c)
                i += 1
            # series: letters
            for _ in range(n_series):
                c = p[i]
                out.append(DIGIT_TO_LETTER.get(c, c) if c.isdigit() else c)
                i += 1
            # number: digits
            for _ in range(4):
                c = p[i]
                out.append(LETTER_TO_DIGIT.get(c, c) if c.isalpha() else c)
                i += 1
            cand = "".join(out)
            for name, rx in PATTERNS:
                if rx.match(cand) and (name == "bharat" or cand[:2] in STATE_CODES):
                    return cand, True, name

    return p, False, "invalid"


def edit_ops(a, b):
    """Levenshtein distance plus the substitution pairs, for the matrix."""
    la, lb = len(a), len(b)
    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)

    # backtrace for substitutions only
    subs = []
    i, j = la, lb
    while i > 0 and j > 0:
        cost = 0 if a[i - 1] == b[j - 1] else 1
        if d[i][j] == d[i - 1][j - 1] + cost:
            if cost:
                subs.append((a[i - 1], b[j - 1]))  # (truth, predicted)
            i, j = i - 1, j - 1
        elif d[i][j] == d[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    return d[la][lb], subs


def load_predictions(path):
    """
    Parse whatever shape results.json comes back in.

    I have not seen the Awiros test.py output, so this tries the likely
    layouts. If it fails, print the first 400 chars of your results.json
    and add a branch -- do not guess silently.
    """
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    preds = {}

    def key_of(v):
        for k in ("filename", "file", "image", "image_path", "path", "name"):
            if k in v:
                return os.path.basename(str(v[k]))
        return None

    def text_of(v):
        for k in ("text", "prediction", "pred", "rec_text", "plate", "label", "result"):
            if k in v:
                return v[k]
        return None

    if isinstance(data, dict):
        # {"a.jpg": "DL8CAF5030"}  or  {"a.jpg": {"text": ...}}
        for k, v in data.items():
            if isinstance(v, str):
                preds[os.path.basename(k)] = v
            elif isinstance(v, dict):
                t = text_of(v)
                if t is not None:
                    preds[os.path.basename(k)] = t
            elif isinstance(v, (list, tuple)) and v:
                preds[os.path.basename(k)] = v[0]
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                k, t = key_of(item), text_of(item)
                if k is not None and t is not None:
                    preds[k] = t

    if not preds:
        sys.exit(
            "Could not parse results.json.\n"
            "Print the first few lines of it and extend load_predictions()."
        )
    return preds


def pct(n, d):
    return f"{100.0 * n / d:5.1f}%" if d else "  n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--matrix-out", default="confusion_matrix.json")
    ap.add_argument("--failures-out", default="failures.csv")
    args = ap.parse_args()

    preds = load_predictions(args.results)

    rows = []
    with open(args.labels, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r.get("truth", "").strip():
                rows.append(r)

    if not rows:
        sys.exit("No labelled rows in labels.csv -- fill in the 'truth' column first.")

    counts = defaultdict(lambda: defaultdict(int))
    stats = defaultdict(lambda: {"n": 0, "raw": 0, "fixed": 0, "chars": 0, "errs": 0})
    failures = []
    missing = 0
    valid_after_fix = 0

    for r in rows:
        fn = r["filename"]
        truth = normalise(r["truth"])
        conds = [c.strip() for c in (r.get("condition") or "all").split("|") if c.strip()]
        conds = conds or ["all"]
        nrows = (r.get("rows") or "1").strip()

        if fn not in preds:
            missing += 1
            continue

        raw = normalise(preds[fn])
        fixed, is_valid, layout = grammar_fix(raw)
        if is_valid:
            valid_after_fix += 1

        dist, subs = edit_ops(truth, raw)
        for t, p in subs:
            if t in CHARS and p in CHARS:
                counts[t][p] += 1

        buckets = ["ALL"] + [f"cond:{c}" for c in conds] + [f"rows:{nrows}"]
        for b in buckets:
            s = stats[b]
            s["n"] += 1
            s["raw"] += (raw == truth)
            s["fixed"] += (fixed == truth)
            s["chars"] += len(truth)
            s["errs"] += dist

        if fixed != truth:
            failures.append({
                "filename": fn, "truth": truth, "raw": raw,
                "after_grammar": fixed, "edit_distance": dist,
                "condition": "|".join(conds), "layout": layout,
            })

    # ---------------- report ----------------
    a = stats["ALL"]
    print()
    print("=" * 66)
    print("  ANPR RECOGNITION BENCHMARK")
    print("=" * 66)
    print(f"  Labelled images       : {len(rows)}")
    print(f"  Scored (found in json): {a['n']}")
    if missing:
        print(f"  MISSING from results  : {missing}  <-- investigate")
    print()
    print(f"  Exact match, model raw       : {pct(a['raw'], a['n'])}  ({a['raw']}/{a['n']})")
    print(f"  Exact match, + grammar layer : {pct(a['fixed'], a['n'])}  ({a['fixed']}/{a['n']})")
    lift = a["fixed"] - a["raw"]
    print(f"  Lift from YOUR grammar layer : {lift:+d} plates"
          f"  ({100.0 * lift / a['n']:+.1f} points)   <-- your contribution")
    print(f"  Character Error Rate         : {pct(a['errs'], a['chars'])}")
    print(f"  Grammar-valid after fix      : {pct(valid_after_fix, a['n'])}")
    print()

    print("  Breakdown")
    print("  " + "-" * 62)
    print(f"  {'bucket':<22}{'n':>5}{'raw':>10}{'+grammar':>11}{'CER':>9}")
    print("  " + "-" * 62)
    for k in sorted(stats):
        if k == "ALL":
            continue
        s = stats[k]
        print(f"  {k:<22}{s['n']:>5}{pct(s['raw'], s['n']):>10}"
              f"{pct(s['fixed'], s['n']):>11}{pct(s['errs'], s['chars']):>9}")
    print("  " + "-" * 62)
    print()

    # ---------------- confusion matrix ----------------
    total_subs = sum(sum(v.values()) for v in counts.values())
    matrix = {}
    for t in CHARS:
        row_total = sum(counts[t].values())
        if row_total:
            matrix[t] = {p: round(c / row_total, 4) for p, c in sorted(counts[t].items())}

    with open(args.matrix_out, "w", encoding="utf-8") as fh:
        json.dump({
            "description": "P(predicted | truth) for substituted characters. "
                           "Use as the substitution cost in the backend's "
                           "confusion-weighted edit distance.",
            "n_images": a["n"],
            "n_substitutions": total_subs,
            "matrix": matrix,
        }, fh, indent=2)

    top = sorted(
        ((t, p, c) for t, d in counts.items() for p, c in d.items()),
        key=lambda x: -x[2],
    )[:12]
    if top:
        print("  Top character confusions (truth -> predicted)")
        for t, p, c in top:
            print(f"    {t} -> {p}   {c:>4}")
        print()

    # ---------------- failures ----------------
    if failures:
        with open(args.failures_out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(failures[0].keys()))
            w.writeheader()
            w.writerows(failures)

    print(f"  Wrote {args.matrix_out}  -> give this to the backend team")
    print(f"  Wrote {args.failures_out}  -> {len(failures)} misses, go look at them")
    print("=" * 66)
    print()


if __name__ == "__main__":
    main()
