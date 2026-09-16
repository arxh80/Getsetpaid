import { describe, expect, it } from "vitest";
import {
  PLACEMENT_PATTERNS,
  isMailtoAddress,
  matchLinePrefix,
  parseLegalMarkup,
  placementViolations,
  type Block,
  type Inline,
  type PlacementRule,
  trimSpacesAndTabsEnd,
  trimSpacesAndTabsStart,
} from "@/lib/legal/markup";
import { validateDraft } from "@/lib/legal/draft-validation";

// PHASE 8 TASK 1, FIX ROUND 1: M3 (where a placeholder may stand) and M5 (the
// parse is linear). Kept beside markup.test.ts rather than inside it so each
// finding's proof reads as one file.

function text(blocks: readonly Block[]): string {
  const parts: string[] = [];
  const walk = (content: readonly Inline[]) => {
    for (const p of content) parts.push(p.kind === "support-email" ? "<EMAIL>" : p.text);
  };
  for (const b of blocks) {
    if (b.kind === "paragraph" || b.kind === "heading") walk(b.content);
    if (b.kind === "list") b.items.forEach(walk);
  }
  return parts.join("|");
}

function hrefs(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const walk = (content: readonly Inline[]) => {
    for (const p of content) if (p.kind === "link") out.push(p.href);
  };
  for (const b of blocks) {
    if (b.kind === "paragraph" || b.kind === "heading") walk(b.content);
    if (b.kind === "list") b.items.forEach(walk);
  }
  return out;
}

// ===========================================================================
// M3: WHERE A PLACEHOLDER MAY STAND
// ===========================================================================
describe("placeholders -- only where they render", () => {
  it.each([
    ["inside bold", "Email **{{support_email}}** today."],
    ["inside link text", "[{{support_email}}](/legal/contact)"],
    ["inside a link target", "[write](/legal/{{support_email}})"],
    ["inside an https link target", "[write](https://example.test/{{support_email}})"],
  ])("refuses {{support_email}} %s, and renders no raw placeholder", (_label, source) => {
    const { blocks, problems } = parseLegalMarkup(source);
    expect(problems.join(" ")).toMatch(/cannot (sit between two \*\* markers|be part of a link)/);
    expect(text(blocks)).not.toContain("{{");
    expect(hrefs(blocks).join(" ")).not.toContain("{{");
  });

  it("refuses bold on either side of a placeholder on one line -- conservative, like the database", () => {
    const { blocks, problems } = parseLegalMarkup("**Email** {{support_email}} or **call**.");
    // The parser WOULD render this correctly...
    expect(text(blocks)).toBe("Email| |<EMAIL>| or |call|.");
    // ...but the database cannot tell which ** pair is which, so both refuse.
    expect(problems.join(" ")).toMatch(/cannot sit between two \*\* markers/);
  });

  it("POSITIVE CONTROL: bold on one line and the placeholder on the next is fine", () => {
    const { problems } = parseLegalMarkup("**Who we are.** Write to us.\nOur address: {{support_email}}.");
    expect(problems).toEqual([]);
  });

  it.each([
    "Our providers: {{subprocessors}}",
    "## {{storage_inventory}}",
    "- {{storage_inventory}}",
    "{{subprocessors}} and more",
    "{{subprocessors}}{{subprocessors}}",
    "\u00a0{{subprocessors}}",
  ])("refuses a block placeholder that is not alone on its line: %j", (source) => {
    const { blocks, problems } = parseLegalMarkup(source);
    expect(problems.join(" ")).toMatch(/must (each )?be on a line of (its|their) own/);
    expect(blocks.some((b) => b.kind === "subprocessors" || b.kind === "storage-inventory")).toBe(false);
  });

  it("POSITIVE CONTROL: a block placeholder alone on its line, indented or not, is a block", () => {
    for (const source of ["{{subprocessors}}", "  {{subprocessors}}\t", "- item\n  {{subprocessors}}"]) {
      const { blocks, problems } = parseLegalMarkup(source);
      expect(problems, source).toEqual([]);
      expect(
        blocks.some((b) => b.kind === "subprocessors"),
        source,
      ).toBe(true);
    }
  });

  it("refuses an unclosed or over-braced {{, which the database refuses too", () => {
    expect(parseLegalMarkup("a {{ b").problems.join(" ")).toMatch(/not a known placeholder/);
    expect(parseLegalMarkup("{{{support_email}}}").problems.join(" ")).toMatch(/not a known placeholder/);
  });

  it("bold and links do not span a line break, so the database's line-bounded rules see every one", () => {
    const { blocks } = parseLegalMarkup("**not\nbold** and [not\na](/link)");
    expect(blocks).toHaveLength(1);
    const kinds = blocks[0].kind === "paragraph" ? blocks[0].content.map((p) => p.kind) : [];
    expect(kinds).toEqual(["text"]);
  });
});

describe("validateDraft -- a required placeholder must RENDER, not merely appear", () => {
  it.each([
    ["contact", "Email **{{support_email}}** today."],
    ["contact", "[{{support_email}}](/legal/contact)"],
    ["vulnerability-disclosure", "Report to [us](/x{{support_email}})."],
    ["subprocessors", "Our providers: {{subprocessors}}"],
    ["cookies", "## {{storage_inventory}}"],
  ] as const)("refuses %s with %j", (slug, body) => {
    const result = validateDraft(slug, { title: "T", body, effectiveDate: "2026-09-22" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.body).toMatch(/must contain \{\{/);
  });

  it("POSITIVE CONTROL: the same pages with the placeholder where it renders", () => {
    const at = (slug: "contact" | "subprocessors" | "cookies", body: string) =>
      validateDraft(slug, { title: "T", body, effectiveDate: "2026-09-22" }).ok;
    expect(at("contact", "Email {{support_email}} today.")).toBe(true);
    expect(at("contact", "## Write to {{support_email}}")).toBe(true);
    expect(at("contact", "- {{support_email}}")).toBe(true);
    expect(at("subprocessors", "Our providers:\n\n{{subprocessors}}")).toBe(true);
    expect(at("cookies", "Intro\n  {{storage_inventory}}")).toBe(true);
  });
});

// ===========================================================================
// THE JAVASCRIPT SCAN EQUALS THE DATABASE'S REGULAR EXPRESSIONS
// ===========================================================================
// placementViolations() is a linear re-implementation of the five patterns the
// CHECK constraint evaluates. This proves they agree on every string of a
// generated corpus over the characters the patterns care about, so the
// validator refuses exactly what the database refuses. (That the live
// constraint carries these same pattern strings is proved in
// tests/integration/legal/legal-documents.test.ts.)
describe("placementViolations agrees with PLACEMENT_PATTERNS", () => {
  const ALPHABET = [
    "*", "**", "[", "]", "](", "(", ")", "{{", "}}", "{", "}", "\n", "\r", " ", "\t", "a", "#", "\u00a0",
    "{{support_email}}", "{{subprocessors}}", "{{storage_inventory}}",
  ];
  // Deterministic: the corpus is the same on every run.
  let state = 0x5eed;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    // The HIGH bits: an LCG's low bits cycle with a tiny period, and a
    // power-of-two alphabet would otherwise see the same few samples.
    return state >>> 11;
  };
  const corpus: string[] = [];
  for (let n = 0; n < 20000; n++) {
    const len = 1 + (next() % 18);
    let sample = "";
    for (let k = 0; k < len; k++) sample += ALPHABET[next() % ALPHABET.length];
    corpus.push(sample);
  }

  it.each(Object.keys(PLACEMENT_PATTERNS) as PlacementRule[])("rule %s", (rule) => {
    const regex = new RegExp(PLACEMENT_PATTERNS[rule]);
    let positives = 0;
    for (const sample of corpus) {
      const expected = regex.test(sample);
      if (expected) positives++;
      expect(placementViolations(sample).has(rule), JSON.stringify(sample)).toBe(expected);
    }
    // DENOMINATOR: the corpus exercised the rule both ways.
    expect(positives).toBeGreaterThan(20);
    expect(positives).toBeLessThan(corpus.length - 20);
  });
});

// ===========================================================================
// M5: THE PARSE IS LINEAR
// ===========================================================================
// The public page parses its body on every request. The old alternation regex
// took 5 840 ms on 99 990 `[` and a `]` (measured in review). The bound below
// is far above the linear parser's cost and far below the quadratic one's, so
// the quadratic form cannot come back unnoticed.
describe("parseLegalMarkup is linear on hostile input at the 100 000-character limit", () => {
  const N = 99_990;
  it.each([
    ["[ x N then ]", "[".repeat(N) + "]"],
    ["[a]( x N", "[a](".repeat(N / 4)],
    ["[a](/ then ( x N", "[a](/" + "(".repeat(N)],
    ["** then text x N", "**" + "a".repeat(N)],
    ["**a x N", "**a".repeat(N / 3)],
    ["{{ x N", "{{".repeat(N / 2)],
    ["[{{ x N then ](", "[{{".repeat(N / 3) + "]("],
    ["]( then {{ x N", "](" + "{{".repeat(N / 2)],
    ["** then {{ x N then **", "**" + "{{".repeat(N / 2) + "**"],
    ["< x N", "<".repeat(N)],
    // Fix round 2: whitespace and repeated-separator runs. Each of these was
    // quadratic in a regex the first fix round left in place (measured 4-6 s
    // at this size) and each is a body the database accepts.
    ["space x N then x (the /\s+$/ line trim)", " ".repeat(N) + "x"],
    ["a, tab x N, x", "a" + "\t".repeat(N) + "x"],
    ["space+nbsp x N/2 then x", " \u00a0".repeat(N / 2) + "x"],
    ["# then space x N then a U+2028 (the heading regex)", "#" + " ".repeat(N) + "a\u2028b"],
    ["- then space x N then a U+2028 (the bullet regex)", "-" + " ".repeat(N) + "a\u2028b"],
    ["1. then space x N then a U+2028 (the numbered regex)", "1." + " ".repeat(N) + "a\u2028b"],
    ["mailto:a@ then . x N then < (the mailto regex)", "[a](mailto:a@" + ".".repeat(N) + "<)"],
    // Two tokens: the text before the SECOND one ends in a token, not in
    // spaces, which is what made the old trim scan the run from every space.
    ["x, space x N, {{subprocessors}} x 2 (the placement trim)", "x" + " ".repeat(N) + "{{subprocessors}}".repeat(2)],
  ])("%s", (_label, source) => {
    const started = performance.now();
    parseLegalMarkup(source);
    const elapsed = performance.now() - started;
    expect(elapsed, `${elapsed.toFixed(0)} ms`).toBeLessThan(750);
  });
});

// ===========================================================================
// FIX ROUND 2 (M5 remainder): THE LINEAR HELPERS
// ===========================================================================
// Each helper replaced a regex that backtracked. The timing cases above prove
// they are fast; these prove each one decides exactly what its regex decided,
// over a generated corpus of the characters that regex cares about.
// TIMEOUT (Phase 8 Task 2): each case below makes ~40k-120k expect() calls
// over a fixed corpus. Alone they take 3-4 s; under the full `pnpm test`
// load (128 files) the trim case crossed vitest's 5 s default twice in a row.
// The time is the corpus walk's, not the helpers' (the timing guarantees live
// in their own tests), so the budget is raised and no assertion changes.
describe("the linear helpers agree with the regular expressions they replaced", { timeout: 30_000 }, () => {
  const ALPHABET = [" ", "\t", "\u00a0", "\u2028", "\u2029", "#", "-", "*", "1", ".", "@", "a", "<", "(", "x"];
  let state = 0xc0ffee;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state >>> 11;
  };
  const corpus: string[] = [];
  for (let n = 0; n < 40000; n++) {
    const len = next() % 14;
    let sample = "";
    for (let k = 0; k < len; k++) sample += ALPHABET[next() % ALPHABET.length];
    corpus.push(sample);
  }
  // Seeds that the random corpus is unlikely to hit exactly.
  corpus.push("a@b.c", "a@.c", "a@b.", "a@bc", "@b.c", "a@b@c.d", "a@b..", "a@.b.c", "# a", "#######  a", "1. a", "- a\u2028", "12.\u2028a");

  it("isMailtoAddress", () => {
    const old = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/i;
    let positives = 0;
    for (const sample of corpus) {
      const expected = old.test(sample);
      if (expected) positives++;
      expect(isMailtoAddress(sample), JSON.stringify(sample)).toBe(expected);
    }
    expect(positives).toBeGreaterThan(5);
  });

  it("trimSpacesAndTabsEnd / trimSpacesAndTabsStart / trimEnd", () => {
    for (const sample of corpus) {
      expect(trimSpacesAndTabsEnd(sample), JSON.stringify(sample)).toBe(sample.replace(/[ \t]+$/, ""));
      expect(trimSpacesAndTabsStart(sample), JSON.stringify(sample)).toBe(sample.replace(/^[ \t]+/, ""));
      expect(sample.trimEnd(), JSON.stringify(sample)).toBe(sample.replace(/\s+$/, ""));
    }
  });

  it.each([
    ["heading", /^#{1,6}\s+/, /^(#{1,6})\s+(.*)$/, 2],
    ["bullet", /^[-*]\s+/, /^[-*]\s+(.*)$/, 1],
    ["numbered", /^\d+\.\s+/, /^\d+\.\s+(.*)$/, 1],
  ] as const)("matchLinePrefix: %s", (_label, prefix, old, group) => {
    let positives = 0;
    let separators = 0;
    for (const raw of corpus) {
      // The parser only ever passes a trimmed line.
      const line = raw.trim();
      const expected = old.exec(line)?.[group] ?? null;
      if (expected !== null) positives++;
      if (/^[#\-*1]/.test(line) && /[\u2028\u2029]/.test(line)) separators++;
      expect(matchLinePrefix(prefix, line), JSON.stringify(line)).toBe(expected);
    }
    // DENOMINATOR: matches, and lines where the separator decides.
    expect(positives).toBeGreaterThan(20);
    expect(separators).toBeGreaterThan(20);
  });
});

