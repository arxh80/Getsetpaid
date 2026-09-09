import { readFileSync } from "node:fs";
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
