import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WHY THIS TEST EXISTS.
//
// The palette lives in two places by necessity: `app/globals.css`'s @theme
// block is what the browser gets, and `scripts/contrast.py`'s TOKENS dict is
// what the WCAG audit measures. Neither can import the other -- one is CSS
// consumed by Tailwind's compiler, the other is Python. So the audit can pass
// while the shipped stylesheet says something different, which is the exact
// failure mode that makes a "contrast script" worthless: a green tick
// measuring values nobody serves.
//
// This test is the seam. It parses both files and asserts they agree.

const root = fileURLToPath(new URL("../../../", import.meta.url));

function readThemeColors(): Map<string, string> {
  const css = readFileSync(`${root}app/globals.css`, "utf8");
  const theme = css.slice(css.indexOf("@theme {"));
  const found = new Map<string, string>();
  // Only `--color-*: #hex;` -- rgb() values (scrim) and non-colour tokens are
  // out of scope for a hex-pair audit and are asserted separately below.
  for (const [, name, hex] of theme.matchAll(
    /--color-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g,
  )) {
    found.set(name, hex.toUpperCase());
  }
  return found;
}

function readContrastTokens(): Map<string, string> {
  const py = readFileSync(`${root}scripts/contrast.py`, "utf8");
  const block = py.slice(py.indexOf("TOKENS = {"), py.indexOf("\n}", py.indexOf("TOKENS = {")));
  const found = new Map<string, string>();
  for (const [, name, hex] of block.matchAll(
    /"([a-z0-9-]+)":\s*"(#[0-9A-Fa-f]{6})"/g,
  )) {
    found.set(name, hex.toUpperCase());
  }
  return found;
}

// The spec's § 3.1 table, transcribed. Written out rather than derived from
// either file so a wrong edit to BOTH files still fails here.
const EXPECTED: Record<string, string> = {
  shell: "#0B0B0E",
  surface: "#15151A",
  "surface-raised": "#1E1E25",
  ink: "#F5F5F7",
  "ink-muted": "#9A9AA4",
  primary: "#20FC8F",
  "on-primary": "#0B0B0E",
  accent: "#20FC8F",
  rule: "#2A2A33",
  "rule-strong": "#6A6A78",
  success: "#20FC8F",
  warning: "#FFB020",
  danger: "#FF6B61",
  focus: "#F5F5F7",
  "focus-on-primary": "#0B0B0E",
};

describe("design token contract", () => {
  it("app/globals.css carries exactly the specified palette", () => {
    const theme = readThemeColors();
    for (const [name, hex] of Object.entries(EXPECTED)) {
      expect(theme.get(name), `--color-${name}`).toBe(hex);
    }
  });

  it("scripts/contrast.py measures the same values globals.css serves", () => {
    const theme = readThemeColors();
    const py = readContrastTokens();
    for (const [name, hex] of py) {
      expect(theme.get(name), `--color-${name} in globals.css`).toBe(hex);
    }
  });

  it("the deleted light-palette tokens are gone", () => {
    const theme = readThemeColors();
    expect(theme.has("lilac")).toBe(false);
    expect(theme.has("pink")).toBe(false);
  });

  it("no removed hex survives anywhere in the theme", () => {
    const css = readFileSync(`${root}app/globals.css`, "utf8");
    for (const dead of [
      "#FFF4F4",
      "#14141C",
      "#0062FF",
      "#3A86FF",
      "#BDB2FF",
      "#FFD6E0",
      "#55555F",
      "#D6CBCB",
      "#0E5F42",
      "#7A4F00",
      "#9E1C15",
    ]) {
      expect(css.toUpperCase().includes(dead)).toBe(false);
    }
  });
});

// ===========================================================================
// THE TWO HAND-SYNCED COPIES OF --color-shell (plus one of --color-accent).
//
// app/icon.svg and app/layout.tsx's `themeColor` both carry a literal hex
// because they are read before any stylesheet loads -- DESIGN.md § Anti-
// patterns' three sanctioned exceptions to "no literal hex". app/layout.tsx
// says outright that its copy must be kept in sync with --color-shell "by
// hand". Nothing enforced that: tests/unit/design/icon.test.ts checks the
// icon's ground rect fill only against a hex SHAPE (/fill="#[0-9A-Fa-f]{6}"/),
// never its VALUE, and no test touched `themeColor` at all. A future shell
// (or accent) tweak could pass every other gate green and leave the iOS
// address bar and the favicon ground at the old colour.
// ===========================================================================
describe("app/icon.svg and app/layout.tsx track the theme, not a frozen copy", () => {
  const theme = readThemeColors();

  it("app/icon.svg's ground rect equals --color-shell", () => {
    const svg = readFileSync(`${root}app/icon.svg`, "utf8");
    const rect = svg.match(/<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"/);
    expect(rect, "app/icon.svg's ground <rect fill=…>").not.toBeNull();
    expect(rect![1].toUpperCase()).toBe(theme.get("shell"));
  });

  it("app/icon.svg's mark equals --color-accent", () => {
    const svg = readFileSync(`${root}app/icon.svg`, "utf8");
    const path = svg.match(/<path\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"/);
    expect(path, "app/icon.svg's mark <path fill=…>").not.toBeNull();
    expect(path![1].toUpperCase()).toBe(theme.get("accent"));
  });

  it("app/layout.tsx's themeColor equals --color-shell", () => {
    const layout = readFileSync(`${root}app/layout.tsx`, "utf8");
    const themeColor = layout.match(/themeColor:\s*"(#[0-9A-Fa-f]{6})"/);
    expect(themeColor, "app/layout.tsx's viewport.themeColor").not.toBeNull();
    expect(themeColor![1].toUpperCase()).toBe(theme.get("shell"));
  });
});

describe("base rules follow the dark ground", () => {
  const css = () => readFileSync(`${root}app/globals.css`, "utf8");

  it("declares color-scheme: dark", () => {
    // Undeclared, a dark-mode machine renders the browser's OWN chrome --
    // native <select> popups (the workspace switcher, the invite role picker),
    // form-control internals, scrollbars, autofill -- guessing. Declared, all
    // of it is pinned to the palette contrast.py actually measured.
    expect(css()).toMatch(/color-scheme:\s*dark\s*;/);
    expect(css()).not.toMatch(/color-scheme:\s*light\s*;/);
  });

  it("the skeleton shimmer breathes to a token that still exists", () => {
    // --color-pink was the light palette's breathe stop and is deleted. A
    // keyframe referencing a dead custom property does not error -- it
    // resolves to nothing and the bone silently stops moving, which is a
    // loading state that looks like a broken page.
    const theme = readThemeColors();
    const keyframe = css().slice(css().indexOf("@keyframes skeleton-pulse"));
    const refs = [...keyframe.matchAll(/var\(--color-([a-z0-9-]+)\)/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(theme.has(ref), `--color-${ref} referenced by the keyframe`).toBe(
        true,
      );
    }
    expect(refs).toContain("skeleton-breathe");
  });

  it("the skeleton breathe stop keeps a perceptible amplitude", () => {
    // The light system rested at #D6CBCB and breathed to #FFD6E0 -- 1.20:1
    // between the two stops. Below roughly that, the loop is invisible; far
    // above it, the bone strobes. #2A2A33 -> #3A3A45 is 1.27:1.
    const theme = readThemeColors();
    expect(theme.get("rule")).toBe("#2A2A33");
    expect(theme.get("skeleton-breathe")).toBe("#3A3A45");
  });
});

// ===========================================================================
// THE BAN LIST -- stale PROSE, not stale code.
//
// The tests above prove the shipped stylesheet and the WCAG audit agree on the
// values. They say nothing about the FILES THAT DESCRIBE those values, and in
// this repo that is the more dangerous half: `CLAUDE.md` § Design is what every
// agent reads BEFORE touching UI, and `DESIGN.md` is the contract the design
// skills are explicitly told outranks their own defaults. A wrong colour fails
// a test in ten seconds. A wrong SENTENCE just quietly aims the next
// contributor at a palette that has not existed for five commits.
//
// So this block is a grep with a list, kept beside the token contract because
// that is where somebody changing a colour is already looking.
// ===========================================================================

// Files whose PROSE must not describe the light palette. Not the whole repo:
// `docs/` quotes the old values on purpose (the rebrand spec's whole § 1 is a
// table of them), and `tests/` needs a threshold's provenance.
const PROSE_FILES = [
  "DESIGN.md",
  "CLAUDE.md",
  "components/ui/button.tsx",
  "components/ui/field.tsx",
  "components/ui/ruled-row.tsx",
  "components/crm/status-chip.tsx",
  "components/list/list-pager.tsx",
  "components/list/list-skeleton.tsx",
  "components/skeleton/bone.tsx",
  "components/crm/finance-chip.tsx",
  "components/crm/task-status-chip.tsx",
  "lib/crm/task-status.ts",
  "app/not-found.tsx",
  "app/(app)/not-found.tsx",
  // Palette-critical and previously the gap that let Finding 1's false
  // "3.66:1 on primary" claim survive undetected: neither file's PROSE was
  // ever scanned, only globals.css's @theme block (via the hex-survival
  // check below) and contrast.py's TOKENS dict (via the sibling test at the
  // top of this file). Comments in both can still go stale exactly like any
  // other file's.
  "app/globals.css",
  "scripts/contrast.py",
];

// Every deleted hex, every deleted token name, and the ratios that only make
// sense under the palette they came from. The RATIOS are the subtle entries:
// 3.66 was ink on the old primary fill, 4.65 was the old primary as text,
// 3.23 the old accent. All three were quoted as live facts in comments that
// survived the value change, which is exactly how a false claim outlives the
// thing it described -- app/globals.css:307-308 carried the 3.66 one until
// this test started scanning that file.
//
// "two-blue" / "two blues" and "--color-lilac" / "--color-pink" are
// deliberately NOT here. Naming an old value in WORDS to explain a current
// decision is sanctioned prose, not a stale claim -- app/globals.css:61,89,122
// say "the old palette's two blues were 11% apart" and ":215 says "Was
// --color-pink on the light palette; that token is deleted" -- both
// retrospective, both self-correcting ("that token is deleted"), neither
// claiming the old thing still exists. Banning the phrase would forbid the
// file from explaining itself. --color-lilac stays banned: nothing in
// PROSE_FILES has a legitimate reason to name it, so there is nothing for the
// ban to wrongly catch.
const DEAD = [
  "#FFF4F4",
  "#14141C",
  "#0062FF",
  "#3A86FF",
  "#BDB2FF",
  "#FFD6E0",
  "#D6CBCB",
  "#55555F",
  "#0E5F42",
  "#7A4F00",
  "#9E1C15",
  "--color-lilac",
  "3.66",
  "4.65",
  "3.23",
];

describe("no document or comment describes the dead palette", () => {
  for (const file of PROSE_FILES) {
    it(`${file} is clean`, () => {
      const text = readFileSync(`${root}${file}`, "utf8").toUpperCase();
      const hits = DEAD.filter((d) => text.includes(d.toUpperCase()));
      expect(hits, `stale palette references in ${file}`).toEqual([]);
    });
  }
});

// ===========================================================================
// NO LITERAL HEX IN A COMPONENT (DESIGN.md § Anti-patterns).
//
// THE PATTERN IS WIDER THAN THE ONE USED ELSEWHERE IN THIS SUITE, ON PURPOSE.
// The regex the rest of the repo reaches for is /#[0-9A-Fa-f]{6}/, and it has
// a hole big enough to drive `#fff` through: CSS shorthand is three digits, so
// every `#000`, `#fff` and `#0f0` passed a "no literal hex" check unnoticed.
// The `{3}` group below closes it. The trailing (?![0-9A-Fa-f]) is what stops
// the fix breaking the original case -- without it the three-digit branch
// would match the first half of a six-digit value and report the wrong string.
// ===========================================================================
const HEX = /#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?(?![0-9A-Fa-f])/g;

// The sanctioned sites, each with the reason it cannot go through a token.
const HEX_EXEMPT = new Set([
  // The token declarations themselves, plus Google's four brand colours, which
  // Google's sign-in guidelines fix and which are quarantined there as
  // --brand-google-* precisely so this rule holds everywhere else.
  "app/globals.css",
  // Served as a FILE by the browser's icon fetch, before and outside any
  // stylesheet. A custom property is unreachable from it.
  "app/icon.svg",
  // <meta name="theme-color">, read from the document head before any
  // stylesheet loads. Same unreachability as the icon.
  "app/layout.tsx",
  // Not a colour at all: the comment there is about the `#` CHARACTER
  // truncating a data: URI, and `fill:#fff` is the example of an SVG payload
  // that would trigger it. Rewriting it to avoid a hex would delete the point.
  "components/auth/mfa-enroll-gate.tsx",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${root}${dir}`, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(tsx?|svg|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe("no literal hex outside the sanctioned sites", () => {
  it("app/ and components/ go through tokens", () => {
    const offenders: string[] = [];
    for (const file of [...walk("app"), ...walk("components")]) {
      if (HEX_EXEMPT.has(file)) continue;
      const hits = readFileSync(`${root}${file}`, "utf8").match(HEX);
      if (hits) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders, "literal hex outside the documented exceptions").toEqual(
      [],
    );
  });

  it("the widened pattern catches shorthand the old one missed", () => {
    // The regression this test exists for. /#[0-9A-Fa-f]{6}/ returns null on
    // the first string and the ban would have passed it.
    expect("color: #fff".match(HEX)).toEqual(["#fff"]);
    expect("color: #20FC8F".match(HEX)).toEqual(["#20FC8F"]);
    // And the guard against the obvious way to get the widening wrong.
    expect("color: #20FC8F".match(HEX)?.[0]).not.toBe("#20F");
  });
});
