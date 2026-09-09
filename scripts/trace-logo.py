"""Trace brand/*.png into SVG path data for components/wordmark.tsx.

    python scripts/trace-logo.py

Writes components/wordmark.paths.ts. Re-run after changing the artwork.

WHY THIS EXISTS RATHER THAN A ONE-LINE potrace CALL: no vector tracer is
installed on this project's machines -- potrace, vtracer, inkscape and
ImageMagick's `magick` are all absent -- and numpy is not available to Python
either. Pillow is. So this is marching squares plus Douglas-Peucker in pure
Python, which removes a build dependency nobody has.

The artwork is flat single-colour with hard edges, which is the easy case for
a contour tracer: no anti-aliasing decisions beyond one threshold, no colour
quantisation, no curve fitting. Straight line segments are enough -- the output
is polygons, not beziers, and at the sizes this renders (20px in a header,
200px on a marketing page) the difference is not visible.

The output is consumed with fill-rule="evenodd". The mark is an OUTLINED
glyph, so every stroke yields an outer and an inner contour, and a tracer that
emitted them all the same way round would fill the counters solid under the SVG
default of nonzero.

This one does not, and the reason is worth knowing before anyone "fixes" it:
the walk keeps the filled region on the right-hand side throughout, which makes
a hole's boundary come out wound opposite to the outer boundary that contains
it, at every nesting depth. So the output is nonzero-safe as well as
evenodd-safe -- measured, not assumed, in tests/unit/design/wordmark.test.ts.
evenodd remains what the consumer should ask for, because it is the rule that
survives a future change to the walk; nonzero merely happens to agree today.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "components" / "wordmark.paths.ts"

# Trace at a fixed HEIGHT rather than a fixed width. Both outputs are
# normalised to a 100-unit-tall viewBox, so height is what sets the effective
# resolution; the wordmark is ~5:1 and the mark ~0.8:1, and pinning width would
# give the two wildly different amounts of vertical detail.
TRACE_HEIGHT = 1600

# Douglas-Peucker tolerance in OUTPUT units (hundredths of the glyph height),
# converted to trace pixels per image. Expressed this way it means the same
# thing for both sources regardless of TRACE_HEIGHT.
#
# THESE THREE NUMBERS WERE CHOSEN BY MEASUREMENT, NOT TASTE, and two of them
# are non-obvious. Fidelity was scored as intersection-over-union between the
# emitted path (rasterised under even-odd, which is how it is consumed) and the
# source mask, swept over TRACE_HEIGHT x EPSILON_OUT x DECIMALS:
#
#   * EPSILON_OUT must stay ABOVE the coordinate-rounding granularity. Below
#     it, Douglas-Peucker preserves vertices that then round onto each other,
#     and the result is both larger and LESS accurate -- at DECIMALS=1 an
#     epsilon of 0.08 cost 20344 bytes for a worse trace than 0.15 got for
#     9508. Smaller is not safer here.
#   * The mark's accuracy asymptotes near IoU 0.954 (the residue is polygon-vs-
#     antialiased-threshold, not trace error). This setting measures 0.951 for
#     the mark and 0.996 for the wordmark in 8856 bytes -- at the knee, and a
#     little over half the 15360-byte budget.
EPSILON_OUT = 0.12

# Coordinates are emitted at this many decimals. 2 gives 0.01 units on a
# 100-unit box -- a hundredth of a percent of the glyph height, far below a
# pixel at any size this renders. See the sweep note above before lowering it:
# DECIMALS and EPSILON_OUT are coupled, not independent dials.
DECIMALS = 2

# Contours smaller than this many trace pixels on BOTH axes are resampling
# specks, not artwork.
MIN_EXTENT = 1.5

# logo_with_text.png carries a one-to-two-pixel ring of semi-transparent WHITE
# around the outside of its black ground -- a rasteriser edge artefact, not
# artwork (the corners read (255,255,255,alpha=192) against a ground whose own
# bounding box starts at 5,5). A naive white-pixel bounding box latches onto
# that ring and returns the whole 4172-square canvas, which is exactly the
# failure that makes the wordmark come out as a fifteen-contour smudge. Ignore
# a margin this wide before looking for the wordmark.
BORDER_MARGIN = 8

LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


# --------------------------------------------------------------------------
# masks


def _band_threshold(band, cut):
    return band.point(lambda v, c=cut: 255 if v >= c else 0)


def _mask(im, mode):
    """RGBA image -> L-mode image, 255 where the artwork is.

    mode "alpha" -- opaque pixels (the mark, on transparency)
    mode "white" -- opaque AND white pixels. Thresholding all three channels
                    rather than their mean is load-bearing: the green mark is
                    #20FC8F, whose channel mean (142) clears a 128 mean-cut but
                    whose red (32) does not clear a per-channel one. A mean
                    test would drag the green mark into the wordmark trace.
    """
    r, g, b, a = im.split()
    out = _band_threshold(a, 128)
    if mode == "white":
        for ch in (r, g, b):
            out = ImageChops.multiply(out, _band_threshold(ch, 128))
    return out


def load_grid(path, mode, box=None):
    """Return (grid, w, h) where a truthy grid[y][x] means artwork.

    Rows are `bytes`, not lists of bool. At TRACE_HEIGHT the wordmark grid is
    7821x1600; as a list-of-lists of Python bools that is ~12.5M pointers and a
    quarter of a gigabyte, and as one bytes object per row it is 12.5MB.
    """
    im = Image.open(path).convert("RGBA")
    if box:
        im = im.crop(box)
    h = TRACE_HEIGHT
    w = max(1, round(im.width * TRACE_HEIGHT / im.height))
    im = im.resize((w, h), LANCZOS)
    flat = _mask(im, mode).tobytes()
    grid = [flat[y * w:(y + 1) * w] for y in range(h)]
    return grid, w, h


def white_box(path):
    """Bounding box of the WHITE pixels only, so the green mark is excluded.

    Measured inside BORDER_MARGIN (see above) and returned in whole-image
    coordinates, so the caller can crop the original with it.
    """
    im = Image.open(path).convert("RGBA")
    m = BORDER_MARGIN
    inner = im.crop((m, m, im.width - m, im.height - m))
    box = _mask(inner, "white").getbbox()
    if box is None:
        sys.exit("no white pixels found in " + str(path))
    return (box[0] + m, box[1] + m, box[2] + m, box[3] + m)


# --------------------------------------------------------------------------
# contour walk


def contours(grid, w, h):
    """Marching squares over the pixel-corner lattice -> closed point loops.

    Vertices are lattice points (0..w, 0..h). An edge of the walk separates two
    pixels, and the invariant is that the FILLED pixel is on the right-hand
    side of travel (with y pointing down, "right of (dx,dy)" is (-dy,dx)).
    Writing the four pixels around vertex (x,y) as

        a = (x-1,y-1)   b = (x,y-1)
        c = (x-1,y)     e = (x,y)

    that invariant makes each outgoing direction a two-term test:

        right  needs  e and not b
        down   needs  c and not e
        left   needs  a and not c
        up     needs  b and not a

    Exactly one of the four holds at every boundary vertex except the two
    saddles (a+e filled, or b+c filled), where two hold. Preferring a right
    turn resolves both saddles the same way -- 4-connected foreground, so
    pixels touching only at a corner stay separate contours rather than
    pinching the outline through a single point. That consistency is what makes
    the successor relation a bijection on boundary edges, hence a set of
    disjoint cycles, hence a walk that always terminates where it started.

    Both outer contours and the inner contours of holes come out, which is
    exactly what an OUTLINED mark needs since every stroke has two edges.
    """

    def on(x, y):
        return 0 <= x < w and 0 <= y < h and grid[y][x]

    # 0=right 1=down 2=left 3=up
    step = ((1, 0), (0, 1), (-1, 0), (0, -1))

    def valid(x, y, d):
        if d == 0:
            return on(x, y) and not on(x, y - 1)
        if d == 1:
            return on(x - 1, y) and not on(x, y)
        if d == 2:
            return on(x - 1, y - 1) and not on(x - 1, y)
        return on(x, y - 1) and not on(x - 1, y - 1)

    # Seeding only needs rightward edges. A rightward edge is exactly "pixel
    # (x,y) filled, pixel above it empty", and every cycle is closed, so every
    # cycle contains at least one -- there is no all-vertical closed walk.
    # Probing all four directions at every lattice vertex instead costs four
    # times (w+1)(h+1) tests and finds nothing extra.
    seen = set()
    loops = []
    for sy in range(h):
        row = grid[sy]
        above = grid[sy - 1] if sy else None
        for sx in range(w):
            if not row[sx] or (above is not None and above[sx]):
                continue
            if (sx, sy, 0) in seen:
                continue
            loop = []
            x, y, d = sx, sy, 0
            while True:
                seen.add((x, y, d))
                loop.append((x, y))
                x += step[d][0]
                y += step[d][1]
                # Right turn first, then straight, then left, then back.
                for turn in (1, 0, 3, 2):
                    nd = (d + turn) % 4
                    if valid(x, y, nd):
                        d = nd
                        break
                else:  # unreachable if the walk is sound
                    sys.exit("dead end at %r heading %d" % ((x, y), d))
                if (x, y, d) == (sx, sy, 0):
                    break
            if len(loop) >= 4:
                loops.append(loop)
    return loops


# --------------------------------------------------------------------------
# simplification


def perpendicular_distance(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    return abs(dy * px - dx * py + bx * ay - by * ax) / (dx * dx + dy * dy) ** 0.5


def simplify(points, epsilon):
    """Douglas-Peucker, iterative so a long contour cannot blow the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, worst_i = 0.0, -1
        for i in range(lo + 1, hi):
            dist = perpendicular_distance(points[i], points[lo], points[hi])
            if dist > worst:
                worst, worst_i = dist, i
        if worst > epsilon and worst_i > 0:
            keep[worst_i] = True
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    return [p for p, k in zip(points, keep) if k]


def simplify_closed(loop, epsilon):
    """Douglas-Peucker on a CLOSED loop.

    Plain DP pins the first and last point, which on a ring is one arbitrary
    vertex held twice -- park it on a real corner rather than mid-edge by
    rotating the loop to start at the point furthest from its centroid, then
    close the ring explicitly and drop the duplicate afterwards.
    """
    n = len(loop)
    cx = sum(p[0] for p in loop) / n
    cy = sum(p[1] for p in loop) / n
    start = max(
        range(n), key=lambda i: (loop[i][0] - cx) ** 2 + (loop[i][1] - cy) ** 2
    )
    rot = loop[start:] + loop[:start]
    return simplify(rot + [rot[0]], epsilon)[:-1]


# --------------------------------------------------------------------------
# emit


def num(v):
    s = ("%.*f" % (DECIMALS, round(v, DECIMALS))).rstrip("0").rstrip(".")
    return "0" if s in ("", "-0", "-") else s


def to_path(loops, w, h, scale_to=100.0):
    """Normalise to a viewBox whose HEIGHT is `scale_to`, and emit `d`."""
    s = scale_to / h
    eps = EPSILON_OUT / s
    parts = []
    kept = 0
    for loop in loops:
        xs = [p[0] for p in loop]
        ys = [p[1] for p in loop]
        if max(xs) - min(xs) < MIN_EXTENT and max(ys) - min(ys) < MIN_EXTENT:
            continue
        pts = simplify_closed(loop, eps)
        if len(pts) < 3:
            continue
        kept += 1
        parts.append(
            "M" + "L".join("%s %s" % (num(x * s), num(y * s)) for x, y in pts) + "Z"
        )
    return "".join(parts), round(w * s, 2), scale_to, kept


def main():
    mark_grid, mw, mh = load_grid(ROOT / "brand" / "LOGO.png", "alpha")
    mark_d, mark_w, mark_h, mark_n = to_path(contours(mark_grid, mw, mh), mw, mh)

    src = ROOT / "brand" / "logo_with_text.png"
    word_grid, ww, wh = load_grid(src, "white", white_box(src))
    word_d, word_w, word_h, word_n = to_path(contours(word_grid, ww, wh), ww, wh)

    OUT.write_text(
        "// GENERATED FILE -- do not edit.\n"
        "// Regenerate with: python scripts/trace-logo.py\n"
        "// Generated by scripts/trace-logo.py from brand/LOGO.png and\n"
        '// brand/logo_with_text.png. Render with fill-rule="evenodd": the mark\n'
        "// is an outlined glyph whose counters are separate contours.\n"
        "\n"
        'export const MARK_PATH =\n  "%s";\n'
        'export const MARK_VIEWBOX = "0 0 %s %g";\n'
        "\n"
        'export const WORD_PATH =\n  "%s";\n'
        'export const WORD_VIEWBOX = "0 0 %s %g";\n'
        % (mark_d, mark_w, mark_h, word_d, word_w, word_h),
        encoding="utf-8",
    )
    total = len(mark_d) + len(word_d)
    print("mark  grid %dx%d  viewBox %sx%g  %d contours  %d bytes"
          % (mw, mh, mark_w, mark_h, mark_n, len(mark_d)))
    print("word  grid %dx%d  viewBox %sx%g  %d contours  %d bytes"
          % (ww, wh, word_w, word_h, word_n, len(word_d)))
    print("aspect mark %.5f  source %.5f" % (mark_w / mark_h, 2226 / 2805))
    print("total %d bytes (budget 15360)" % total)
    if total >= 15360:
        sys.exit("over the path budget -- raise EPSILON_OUT and re-run")


if __name__ == "__main__":
    main()
