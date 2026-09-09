"""Trace brand/*.png into SVG path data for components/wordmark.tsx and
app/icon.svg.

    python scripts/trace-logo.py

Writes components/wordmark.paths.ts and app/icon.svg. Re-run after changing
the artwork. app/icon.svg is a static file that cannot import the .ts module,
so it gets the mark's path data and viewBox emitted directly into markup by
this same run rather than hand-copied -- see the brief for Task 5 of the
dark-rebrand plan on why hand-copying a multi-kilobyte path string is the
failure mode to avoid. The two outputs share one source of truth (`mark_d`,
computed once below) and so cannot drift apart.

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
OUT_ICON = ROOT / "app" / "icon.svg"

# Literal hexes, not tokens -- correct here and nowhere else in app/ or
# components/. app/icon.svg is a static file the browser can request before
# any stylesheet loads, so it cannot resolve a CSS custom property; it has to
# carry the colours itself. Matches --color-shell and the mark colour from
# DESIGN.md's dark palette.
ICON_GROUND = "#0B0B0E"
ICON_MARK = "#20FC8F"

# Trace at a fixed HEIGHT rather than a fixed width. Both outputs are
# normalised to a 100-unit-tall viewBox, so height is what sets the effective
# resolution; the wordmark is ~5:1 and the mark ~0.8:1, and pinning width would
# give the two wildly different amounts of vertical detail.
TRACE_HEIGHT = 1600

# Douglas-Peucker tolerance in OUTPUT units (hundredths of the glyph height),
# converted to trace pixels per image. Expressed this way it means the same
# thing for both sources regardless of TRACE_HEIGHT.
#
# THESE THREE NUMBERS WERE CHOSEN BY MEASUREMENT, NOT TASTE, and the first
# point below is the non-obvious one. Reproduce any of it with
# scripts/trace-logo-calibrate.py, which scores fidelity as
# intersection-over-union between the emitted path (rasterised under even-odd,
# which is how it is consumed) and the source mask.
#
#   * EPSILON_OUT HAS A FLOOR, and going below it makes the trace both bigger
#     and LESS accurate. Smaller is not safer here. The floor is
#
#         max(coordinate-rounding granularity, one trace pixel)
#
#     in output units -- that is, max(10**-DECIMALS, 100/TRACE_HEIGHT). At the
#     shipped config those are 0.01 and 0.0625, so THE TRACE-PIXEL TERM BINDS
#     and the floor is 0.0625; EPSILON_OUT sits a shade under 2x above it.
#     Below one trace pixel the tolerance can no longer span the staircase
#     along a straight edge, so Douglas-Peucker stops collapsing it and starts
#     preserving it: measured point counts run 755 at 0.12, 1520 at 0.08, 4135
#     at 0.06 and 11344 at 0.04, for 8856 / 18044 / 48843 / 132931 bytes, while
#     the mark's IoU peaks at 0.12 and does not improve after.
#
#     The rounding term is real but does not bind here. It is what bit an
#     earlier DECIMALS=1 configuration, where vertices Douglas-Peucker had kept
#     then rounded onto each other -- 198 adjacent collisions at 0.06 and 1966
#     at 0.04. At DECIMALS=2 there are ZERO collisions at every epsilon tried,
#     so at this precision the staircase, not the rounding, is the whole story.
#     Point counts come out identical under both DECIMALS settings, which is
#     the measurement that separates the two mechanisms.
#
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

# logo_with_text.png carries a ring of semi-transparent WHITE around the
# outside of its black ground -- a rasteriser edge artefact, not artwork (the
# corners read (255,255,255,alpha=192) against a ground whose own bounding box
# starts at 5,5). A naive white-pixel bounding box latches onto that ring and
# returns the whole 4172-square canvas, which is what makes the wordmark come
# out as a plausible-looking fifteen-contour smudge. Ignore a margin this wide
# before looking for the wordmark.
#
# THE RING IS 5px DEEP, MEASURED: sweeping this constant, margins 0-4 all latch
# onto the ring and 5 upwards return the real wordmark box. So 8 is 1.6x the
# depth it has to clear -- a margin of safety, not a comfortable one, and NOT
# the guarantee. The guarantee is the frame-touch check in white_box() below,
# which is what actually catches a re-export whose ring is deeper than this.
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

    # A wordmark sitting on a ground does not run to the edge of the frame it
    # was found in. A latched border ring does, on all four sides at once, and
    # that is the ONLY thing separating the two cases without knowing anything
    # about the artwork -- so refuse rather than trace a full-canvas box.
    #
    # This is the guard; BORDER_MARGIN is not. Raising the margin only moves
    # the ring depth at which the silent failure comes back, whereas this check
    # has no such ceiling. It matters because the failure is otherwise
    # invisible: a latched box still exits 0, still comes in under the byte
    # budget, and still emits a dozen-odd plausible-looking contours. Today's
    # box clears the frame by 849px on the left and 1855px on top, so there is
    # no risk of a false positive.
    touching = [
        edge
        for edge, hit in (
            ("left", box[0] == 0),
            ("top", box[1] == 0),
            ("right", box[2] == inner.width),
            ("bottom", box[3] == inner.height),
        )
        if hit
    ]
    if touching:
        sys.exit(
            "white-pixel bounding box %r touches the inspected frame on the %s "
            "of %s.\nThat means the white search latched onto something "
            "running to the edge of the image -- almost certainly the "
            "semi-transparent border ring described at BORDER_MARGIN, which is "
            "currently %dpx and was 5px deep in the artwork this was written "
            "against.\nRaise BORDER_MARGIN past the ring and re-run. Do NOT "
            "delete this check: tracing the returned box would silently give a "
            "wordmark covering the whole canvas, and every other signal (exit "
            "code, contour count, byte budget) would still look correct."
            % (box, "/".join(touching), path, m)
        )
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

    total = len(mark_d) + len(word_d)
    if total >= 15360:
        # Checked BEFORE the write, not after. An over-budget run must not
        # leave a bad generated file on disk beside a non-zero exit, where the
        # next thing to look at components/ finds something that looks
        # generated, imports cleanly, and quietly blows the bundle budget.
        sys.exit(
            "over the path budget: %d bytes >= 15360. Raise EPSILON_OUT (mind "
            "the floor described above it) and re-run. Nothing was written."
            % total
        )

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

    # app/icon.svg -- the mark's only home in the product (the header lockup
    # dropped it; see Task 2 of the dark-rebrand plan). Same mark_d and the
    # same viewBox numbers as MARK_VIEWBOX above, just rendered into markup
    # instead of a TS export, since a static SVG file cannot import one.
    OUT_ICON.write_text(
        "<!-- GENERATED FILE -- do not edit. -->\n"
        "<!-- Regenerate with: python scripts/trace-logo.py -->\n"
        "<!-- Mark path/viewBox traced from brand/LOGO.png, shared with\n"
        "     components/wordmark.paths.ts's MARK_PATH/MARK_VIEWBOX. The\n"
        "     ground and mark colours are literal hex, not tokens: this file\n"
        "     is served as a static asset and has to render before any\n"
        "     stylesheet loads, so it cannot reach a CSS custom property. -->\n"
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %g">\n'
        '  <rect width="100%%" height="100%%" fill="%s"/>\n'
        '  <path d="%s" fill="%s" fill-rule="evenodd"/>\n'
        "</svg>\n"
        % (mark_w, mark_h, ICON_GROUND, mark_d, ICON_MARK),
        encoding="utf-8",
    )

    print("mark  grid %dx%d  viewBox %sx%g  %d contours  %d bytes"
          % (mw, mh, mark_w, mark_h, mark_n, len(mark_d)))
    print("word  grid %dx%d  viewBox %sx%g  %d contours  %d bytes"
          % (ww, wh, word_w, word_h, word_n, len(word_d)))
    print("aspect mark %.5f  source %.5f" % (mark_w / mark_h, 2226 / 2805))
    print("total %d bytes (budget 15360)" % total)
    print("wrote %s" % OUT_ICON.relative_to(ROOT))


if __name__ == "__main__":
    main()
