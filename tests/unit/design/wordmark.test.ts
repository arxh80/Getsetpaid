import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MARK_PATH,
  MARK_VIEWBOX,
  WORD_PATH,
  WORD_VIEWBOX,
} from "@/components/wordmark.paths";

const root = fileURLToPath(new URL("../../../", import.meta.url));

type Point = readonly [number, number];

/** Split a `d` string back into the closed polygons the tracer emitted. */
const contoursOf = (d: string): Point[][] =>
  d
    .split("M")
    .slice(1)
    .map((sub) =>
      sub
        .slice(0, -1)
        .split("L")
        .map((p) => p.split(" ").map(Number) as [number, number]),
    );

const viewBoxOf = (vb: string) => {
  const [, , w, h] = vb.split(" ").map(Number);
  return { w, h };
};

const paths = [
  ["MARK_PATH", MARK_PATH, "MARK_VIEWBOX", MARK_VIEWBOX],
  ["WORD_PATH", WORD_PATH, "WORD_VIEWBOX", WORD_VIEWBOX],
] as const;

describe("generated logo paths", () => {
  it("both paths are non-trivial closed shapes", () => {
    for (const [name, d] of paths) {
      expect(d.startsWith("M"), `${name} starts with a moveto`).toBe(true);
      // Topology, not just "more than one". The mark is an outlined glyph --
      // an outer boundary, its inner offset, and five counters each with their
      // own inner outline, so 12. The wordmark is 11 glyphs of which G, P, A
      // and D have counters, so 15. A walk that collapsed every hole would
      // still clear a `> 1` bound, and would still pass the winding test
      // below, because a shape with no holes is trivially wound correctly.
      // Eight is well under both and does not need revisiting if the artwork
      // is nudged.
      expect(
        d.split("Z").length - 1,
        `${name} subpath count`,
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it("viewBoxes are four numbers starting at the origin", () => {
    for (const [, , name, vb] of paths) {
      expect(vb, name).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
    }
  });

  it("each path fills the viewBox it is published with", () => {
    // THIS is the "did the walk lose a region" test. The viewBox is derived
    // from the resized source grid and never from traced content, so comparing
    // it to the source's pixel dimensions (below) cannot detect a dropped
    // contour -- only a change to the artwork's dimensions. Measuring the
    // PATH's own bounding box against that viewBox can: lose a region and the
    // ink stops reaching one of the edges.
    //
    // Measured 0.75,0.75 -> 78.62,99.25 on the mark's 79.38 x 100 box (the
    // slack is real transparent padding in brand/LOGO.png) and effectively
    // edge-to-edge on the wordmark, which is cropped to its own ink.
    for (const [name, d, vbName, vb] of paths) {
      const { w, h } = viewBoxOf(vb);
      const points = contoursOf(d).flat();
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
      const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];

      expect(minX, `${name} starts inside ${vbName}`).toBeGreaterThanOrEqual(0);
      expect(minY, `${name} starts inside ${vbName}`).toBeGreaterThanOrEqual(0);
      expect(maxX, `${name} ends inside ${vbName}`).toBeLessThanOrEqual(w);
      expect(maxY, `${name} ends inside ${vbName}`).toBeLessThanOrEqual(h);

      expect((maxX - minX) / w, `${name} fills ${vbName} horizontally`)
        .toBeGreaterThan(0.95);
      expect((maxY - minY) / h, `${name} fills ${vbName} vertically`)
        .toBeGreaterThan(0.95);
    }
  });

  it("the viewBoxes match the proportions of their source artwork", () => {
    // Pins the SOURCE, not the walk: both viewBoxes are computed from the
    // resized grid, so this goes red when brand/*.png changes shape (or is
    // re-exported at a different crop) and the lockup would start looking
    // subtly wrong at every size.
    //
    // The wordmark's ratio is the one that carries weight, because it is the
    // only assertion anywhere that the white-pixel bounding box found the
    // wordmark rather than latching onto the border ring described in
    // scripts/trace-logo.py. A latched box traces the whole square canvas and
    // lands at 1.0, not 4.89 -- while still exiting 0 and still emitting a
    // plausible number of contours.
    expect(viewBoxOf(MARK_VIEWBOX).w / viewBoxOf(MARK_VIEWBOX).h).toBeCloseTo(
      2226 / 2805,
      2,
    );
    expect(viewBoxOf(WORD_VIEWBOX).w / viewBoxOf(WORD_VIEWBOX).h).toBeCloseTo(
      4.89,
      2,
    );
  });

  it("stays inside the 15KB path budget", () => {
    // Douglas-Peucker epsilon is the dial, but it has a floor -- see the long
    // note above EPSILON_OUT in scripts/trace-logo.py before reaching for it.
    // Over budget means the simplifier was too timid, not that the artwork is
    // complex; the spec's fallback (an optimised 2x PNG) is only reachable if
    // fidelity, not size, fails.
    const bytes = Buffer.byteLength(MARK_PATH + WORD_PATH, "utf8");
    expect(bytes).toBeLessThan(15_360);
  });

  it("is generated, and says so", () => {
    const src = readFileSync(`${root}components/wordmark.paths.ts`, "utf8");
    expect(src).toMatch(/generated by scripts\/trace-logo\.py/i);
    // No hand-editing: a regenerated file must be able to clobber this one.
    expect(src).not.toMatch(/export function|export default/);
  });

  it("emits nothing but the four path constants", () => {
    // Task 4 imports all four by name, and the tracer rewrites this file
    // wholesale on every run. Anything else exported here would be silently
    // deleted the next time the artwork changes, so pin the surface.
    const src = readFileSync(`${root}components/wordmark.paths.ts`, "utf8");
    const exported = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual([
      "MARK_PATH",
      "MARK_VIEWBOX",
      "WORD_PATH",
      "WORD_VIEWBOX",
    ]);
  });

  it("every subpath is a closed polygon of at least three points", () => {
    // The failure mode this catches is a marching-squares walk that mis-turns:
    // it does not crash, it emits degenerate two-point stubs and slivers that
    // read as speckle at 200px and as nothing at all at 20px.
    for (const [name, d] of paths) {
      const subpaths = d.split("M").slice(1);
      for (const [i, sub] of subpaths.entries()) {
        expect(sub.endsWith("Z"), `${name} subpath ${i} is closed`).toBe(true);
        const points = sub.slice(0, -1).split("L");
        expect(points.length, `${name} subpath ${i} point count`)
          .toBeGreaterThanOrEqual(3);
        for (const point of points) {
          expect(point, `${name} subpath ${i} coordinate pair`)
            .toMatch(/^-?\d+(\.\d+)? -?\d+(\.\d+)?$/);
        }
      }
    }
  });

  it("winds every hole opposite to the contour containing it", () => {
    // The strongest cheap check that the marching-squares walk did not
    // mis-turn. The walk keeps the filled region on one side throughout, so a
    // hole's boundary MUST come out wound opposite to its container, at every
    // nesting depth. A walker that turns the wrong way at a saddle, or that
    // stitches two regions into one loop, breaks this long before it produces
    // anything a human would notice in a 20px header.
    //
    // It is also the property that makes the output render identically under
    // fill-rule nonzero and evenodd. Task 4 asks for evenodd because that is
    // the rule which survives a change to the walk -- but if this test ever
    // goes red, "the logo fills in solid" is the bug report to expect.
    const signedArea = (poly: readonly Point[]) =>
      poly.reduce((sum, [x, y], i) => {
        const [nx, ny] = poly[(i + 1) % poly.length];
        return sum + (x * ny - nx * y);
      }, 0) / 2;

    const contains = ([x, y]: Point, poly: readonly Point[]) =>
      poly.reduce((hit, [x1, y1], i) => {
        const [x2, y2] = poly[(i + 1) % poly.length];
        const straddles = y1 > y !== y2 > y;
        return straddles && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1
          ? !hit
          : hit;
      }, false);

    for (const [name, d] of paths) {
      const contours = contoursOf(d);
      for (const [i, poly] of contours.entries()) {
        const depth = contours.filter(
          (other, j) => j !== i && contains(poly[0], other),
        ).length;
        // Even depth is an outer boundary, odd depth a hole inside one.
        const outer = depth % 2 === 0;
        expect(
          signedArea(poly) > 0,
          `${name} contour ${i} at nesting depth ${depth} winds as ${outer ? "a hole" : "an outer boundary"}`,
        ).toBe(outer);
      }
    }
  });
});

describe("the Wordmark component", () => {
  const src = () => readFileSync(`${root}components/wordmark.tsx`, "utf8");

  it("keeps the export name and prop both call sites rely on", () => {
    expect(src()).toMatch(/export function Wordmark\(/);
    expect(src()).toMatch(/className/);
  });

  it("has an accessible name", () => {
    // It is inside <Link href="/"> at both call sites with no other text, so
    // without this the link announces as its href.
    expect(src()).toMatch(/role="img"/);
    expect(src()).toMatch(/aria-label="GetSetPaid"/);
  });

  it("carries no literal hex", () => {
    // DESIGN.md § Anti-patterns. The wordmark inherits --color-ink through a
    // token utility so it follows the palette rather than pinning a value.
    expect(src()).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(src()).toMatch(/text-ink|fill-current/);
  });

  it("uses evenodd fill so the letter counters stay open", () => {
    // Every enclosed counter in G, E, S, P, A, D and the full stop is a
    // separate contour. Under a fill rule that filled them, the wordmark
    // would render as a row of solid blocks.
    expect(src()).toMatch(/fillRule="evenodd"/);
  });

  it("renders the wordmark and does not reach for the mark", () => {
    // Founder ruling: the mark is illegible at header size and lives in
    // app/icon.svg instead. A component that imported it would have no
    // call site for it.
    expect(src()).toMatch(/WORD_PATH/);
    expect(src()).not.toMatch(/MARK_PATH/);
    expect(src()).not.toMatch(/markOnly/);
  });

  it("no longer claims the product has no logo", () => {
    // The old file argued a mark would be invented content. One exists now.
    expect(src()).not.toMatch(/no logotype file/i);
  });
});
