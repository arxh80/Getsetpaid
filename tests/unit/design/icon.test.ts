import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MARK_PATH, MARK_VIEWBOX } from "@/components/wordmark.paths";

// app/icon.svg is served as a static file (Task 5 of the dark-rebrand plan)
// and is now the mark's ONLY home in the product -- the header lockup does
// not render it (founder ruling: its strokes fall below one pixel at header
// size). A defect here is a defect the whole product ships with no visible
// warning anywhere else.
//
// THIS FILE EXISTS BECAUSE OF A REAL ESCAPE. `scripts/trace-logo.py` once
// emitted `<!-- GENERATED FILE -- do not edit. -->` as the icon's first line.
// A double hyphen inside an XML comment is illegal per the XML spec (a
// constraint HTML comments do not share). The server returned the file with
// a 200 and the correct content-type; every browser parsed up to the
// malformed comment and rendered nothing. Nothing else in the existing gates
// could have caught it: `pnpm lint` and `pnpm typecheck` do not read `.svg`,
// and `tests/e2e/brand.spec.ts` asserts on the header wordmark, which never
// requests this file.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const iconPath = `${root}app/icon.svg`;
const svg = readFileSync(iconPath, "utf-8");

/**
 * Find a Python 3 interpreter that actually runs, trying both common names.
 * Real invocations, not `--help`/ENOENT sniffing: on Windows, `python3` can
 * resolve to a Microsoft Store shim that exits non-zero with an install
 * prompt rather than failing to spawn at all, so `spawnSync`'s `.error`
 * (ENOENT) is not enough on its own to tell "missing" from "found".
 */
function findPython(): string {
  for (const cmd of ["python3", "python"]) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
    const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    if (probe.status === 0 && /^Python 3\./.test(out)) {
      return cmd;
    }
  }
  throw new Error(
    "no working `python3`/`python` interpreter found on PATH -- this repo " +
      "already requires Python for scripts/trace-logo.py and scripts/" +
      "contrast.py, so this is a missing prerequisite, not a design flaw " +
      "in this test.",
  );
}

describe("app/icon.svg", () => {
  it("is well-formed XML, not just a string a browser happens to render", () => {
    // Vitest runs in environment: "node" (vitest.config.ts) -- no DOM, no
    // jsdom, and no XML/HTML parser is a dependency of this project. Rather
    // than approximate well-formedness with a regex (which is exactly the
    // kind of check that would have missed the `--`-in-a-comment defect,
    // since the string itself is perfectly ordinary), this shells out to a
    // REAL XML parser: Python's xml.etree.ElementTree, built on libexpat.
    // That is not a new project dependency -- Python is already a required
    // build-time tool here (scripts/trace-logo.py generates this very file;
    // scripts/contrast.py audits DESIGN.md's tokens).
    const python = findPython();
    const result = spawnSync(
      python,
      [
        "-c",
        "import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])",
        iconPath,
      ],
      { encoding: "utf-8" },
    );
    expect(result.status, result.stderr || "expat parse failed").toBe(0);
  });

  it("declares a viewBox", () => {
    expect(svg).toMatch(/<svg\b[^>]*\bviewBox="0 0 [\d.]+ [\d.]+"/);
  });

  it("paints an opaque full-bleed ground rect -- a transparent icon is invisible on a dark tab strip", () => {
    const rectMatch = svg.match(/<rect\b[^>]*\/?>/);
    expect(rectMatch).not.toBeNull();
    const rect = rectMatch![0];
    expect(rect).toMatch(/width="100%"/);
    expect(rect).toMatch(/height="100%"/);
    expect(rect).toMatch(/fill="#[0-9A-Fa-f]{6}"/);
    // Opaque means no attribute is quietly letting the ground show through.
    expect(rect).not.toMatch(/\bopacity=/);
    expect(rect).not.toMatch(/\bfill-opacity=/);
  });

  it('renders the mark with fill-rule="evenodd" -- it is an outlined glyph whose counters are separate contours', () => {
    const pathMatch = svg.match(/<path\b[^>]*\/?>/);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![0]).toMatch(/fill-rule="evenodd"/);
  });

  it("carries the traced MARK_PATH/MARK_VIEWBOX verbatim, not a hand-copied approximation", () => {
    // Guards against the failure mode the brief warned about: MARK_PATH is a
    // multi-kilobyte string, and hand-copying it invites silent truncation.
    // This file is generated from the same in-memory value
    // components/wordmark.paths.ts's MARK_PATH is written from, so the two
    // must match exactly.
    expect(svg).toContain(`d="${MARK_PATH}"`);
    expect(svg).toContain(`viewBox="${MARK_VIEWBOX}"`);
  });
});
