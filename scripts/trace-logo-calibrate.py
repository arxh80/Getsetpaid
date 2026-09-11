"""Re-derive TRACE_HEIGHT, EPSILON_OUT and DECIMALS for scripts/trace-logo.py.

    python scripts/trace-logo-calibrate.py            # the shipped config
    python scripts/trace-logo-calibrate.py --sweep    # the grid it was picked from

This is the measurement behind the "chosen by measurement, not taste" comment in
trace-logo.py. Without it that claim is unfalsifiable and a future artwork swap
has no way to re-derive the constants -- which matters, because the useful
result was counter-intuitive (see EPSILON_OUT's floor) and would not survive
being guessed at again.

NOT A UNIT TEST, deliberately. It needs Pillow and the source PNGs; CI runs
`pnpm exec vitest run tests/unit` on a Node container with neither. The
properties that CAN be pinned without Pillow are pinned, in
tests/unit/design/wordmark.test.ts.

HOW FIDELITY IS SCORED. Intersection-over-union between the emitted path and
the source mask. The path is rasterised the way the consumer renders it: one
polygon per subpath, XOR-composited, which IS the even-odd fill rule. Note the
half-pixel correction when drawing -- a lattice coordinate names a pixel
CORNER, while ImageDraw names a pixel CENTRE. Getting that wrong costs about
0.05 IoU and looks exactly like a bad trace: the giveaway is that filled area
still matches the source almost exactly, so area ratio is reported next to IoU.

WHAT THE NUMBERS MEAN. The mark asymptotes near IoU 0.954 however much you
spend -- the residue is polygon-versus-antialiased-threshold, not trace error
-- so read the mark's column as "how close to 0.954", not "how close to 1".
"""

import importlib.util
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

# Score against a mask rendered well above TRACE_HEIGHT, so the comparison is
# not itself limited by the resolution being judged.
SCORE_HEIGHT = 1600

_spec = importlib.util.spec_from_file_location(
    "trace_logo", ROOT / "scripts" / "trace-logo.py"
)
tl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tl)


def sources():
    word_box = tl.white_box(ROOT / "brand" / "logo_with_text.png")
    return [
        ("mark", ROOT / "brand" / "LOGO.png", "alpha", None),
        ("word", ROOT / "brand" / "logo_with_text.png", "white", word_box),
    ]


def _count(img):
    return sum(1 for v in img.convert("L").tobytes() if v)


def reference(path, mode, box):
    im = Image.open(path).convert("RGBA")
    if box:
        im = im.crop(box)
    w = max(1, round(im.width * SCORE_HEIGHT / im.height))
    mask = tl._mask(im.resize((w, SCORE_HEIGHT), tl.LANCZOS), mode)
    return mask.point(lambda v: 255 if v >= 128 else 0).convert("1"), w


def rasterise(d, view_h, width):
    """Render `d` under even-odd: one polygon per subpath, XOR-composited."""
    scale = SCORE_HEIGHT / view_h
    acc = Image.new("1", (width, SCORE_HEIGHT), 0)
    for chunk in d.split("M")[1:]:
        pts = [tuple(map(float, s.split())) for s in chunk.rstrip("Z").split("L")]
        layer = Image.new("1", (width, SCORE_HEIGHT), 0)
        # -0.5: lattice coordinates name pixel corners, ImageDraw names centres.
        ImageDraw.Draw(layer).polygon(
            [(x * scale - 0.5, y * scale - 0.5) for x, y in pts], fill=1
        )
        acc = ImageChops.logical_xor(acc, layer)
    return acc


def score(name, path, mode, box, refs):
    grid, w, h = tl.load_grid(path, mode, box)
    d, _, view_h, contours = tl.to_path(tl.contours(grid, w, h), w, h)
    ref, width = refs[name]
    got = rasterise(d, view_h, width)
    inter = _count(ImageChops.logical_and(got, ref))
    union = _count(ImageChops.logical_or(got, ref))
    points = sum(c.count("L") + 1 for c in d.split("M")[1:])
    return {
        "bytes": len(d),
        "contours": contours,
        "points": points,
        "iou": inter / union,
        "area_ratio": _count(got) / _count(ref),
    }


def report(label, refs):
    total = 0
    line = [label]
    for name, path, mode, box in sources():
        r = score(name, path, mode, box, refs)
        total += r["bytes"]
        line.append(
            "%s IoU %.4f area %.4f %5db %2dc %5dpt"
            % (name, r["iou"], r["area_ratio"], r["bytes"], r["contours"], r["points"])
        )
    line.append("total %5d/%d" % (total, 15360))
    print("  ".join(line))
    return total


def main():
    refs = {n: reference(p, m, b) for n, p, m, b in sources()}
    sweep = "--sweep" in sys.argv

    if not sweep:
        print("Shipped config: TRACE_HEIGHT=%d EPSILON_OUT=%.2f DECIMALS=%d"
              % (tl.TRACE_HEIGHT, tl.EPSILON_OUT, tl.DECIMALS))
        print("Scoring against a %dpx-tall source mask.\n" % SCORE_HEIGHT)
        report("shipped ", refs)
        print(
            "\nEPSILON_OUT floor = max(10**-DECIMALS, 100/TRACE_HEIGHT)"
            " = max(%g, %g) = %g output units; shipped value is %.2fx that."
            % (
                10 ** -tl.DECIMALS,
                100 / tl.TRACE_HEIGHT,
                max(10 ** -tl.DECIMALS, 100 / tl.TRACE_HEIGHT),
                tl.EPSILON_OUT / max(10 ** -tl.DECIMALS, 100 / tl.TRACE_HEIGHT),
            )
        )
        print("Re-run with --sweep to see the grid this was chosen from.")
        return

    keep = (tl.TRACE_HEIGHT, tl.EPSILON_OUT, tl.DECIMALS)
    print("Sweep. Watch two things: IoU stops improving below EPSILON_OUT's")
    print("floor while bytes keep climbing, and point counts are identical")
    print("across DECIMALS -- which is what shows the staircase, not the")
    print("rounding, drives the blow-up at this precision.\n")
    try:
        for dec in (1, 2):
            for th in (500, 1100, 1600, 2200):
                for eps in (0.30, 0.15, 0.12, 0.08, 0.06):
                    tl.TRACE_HEIGHT, tl.EPSILON_OUT, tl.DECIMALS = th, eps, dec
                    floor = max(10 ** -dec, 100 / th)
                    report(
                        "dec=%d TH=%4d eps=%.2f (%.2fx floor, %.2f trace px)"
                        % (dec, th, eps, eps / floor, eps / (100 / th)),
                        refs,
                    )
                print()
    finally:
        tl.TRACE_HEIGHT, tl.EPSILON_OUT, tl.DECIMALS = keep


if __name__ == "__main__":
    main()
