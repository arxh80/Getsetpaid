import { describe, expect, it } from "vitest";
import { stripComments } from "../../support/source";

// ===========================================================================
// THE STRIPPER MUST NOT EAT CODE (census audit A4, finding 4)
// ===========================================================================
// `stripComments()` feeds the private/network leak guard
// (tests/unit/network/no-private-table-in-network-path.test.ts:94) and three
// other network source censuses. Every positive control those files carry
// points ONE WAY -- does the detector fire on a planted hostile fixture? None
// of them asked the other question, which is the one that turns a leak green:
// DID THE STRIPPER REMOVE CODE?
//
// It did. The measured evasions below are all ordinary code, not contrivances,
// and every one of them was GREEN (i.e. the `.from("notes")` after it was
// invisible) under the regex `line.replace(/\/\/.*$/, "")` this file's subject
// replaced. They are kept as a permanent control: the day anyone reaches for a
// regex again, these red.
// ===========================================================================

/** The exact regex implementation this replaced, kept so the fixtures are measured, not asserted. */
function regexStripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const EVASIONS: [string, string][] = [
  ["a URL in a string", `const docs = "https://supabase.com/docs"; const q = supabase.from("notes");`],
  ["a regex literal containing an escaped slash", `const slash = /a\/\/b/; const q = supabase.from("notes");`],
  ["a protocol-relative URL", `const href = "//cdn.example.com/x.png"; const q = supabase.from("notes");`],
  ["a template literal", `const u = \`https://x/\${id}\`; const q = supabase.from("notes");`],
  ["a single-quoted URL in JSX", `const el = <a href='https://x/y'>{supabase.from("notes")}</a>;`],
];

describe("stripComments removes comments and nothing else", () => {
  it.each(EVASIONS)("keeps the code after %s", (_label, code) => {
    expect(stripComments(code)).toContain(`from("notes")`);
  });

  it("MEASURED: every one of those evasions defeated the regex it replaced", () => {
    const defeated = EVASIONS.filter(([, code]) => !regexStripComments(code).includes(`from("notes")`)).map(
      ([label]) => label,
    );
    expect(
      defeated,
      "the regex stripper is supposed to eat the code in all five of these -- if it no longer does, " +
        "this control has stopped measuring anything",
    ).toEqual(EVASIONS.map(([label]) => label));
  });

  it("still removes a real line comment, a trailing one and a block comment", () => {
    expect(stripComments(`// const q = supabase.from("notes");\nconst ok = 1;`)).not.toContain("notes");
    expect(stripComments(`const ok = 1; // supabase.from("notes")`)).not.toContain("notes");
    expect(stripComments(`/*\n supabase.from("notes")\n*/\nconst ok = 1;`)).not.toContain("notes");
  });

  it("keeps line and column positions, so a line-indexed assertion still lines up", () => {
    const code = `const a = 1; // one\nconst b = supabase.from("notes");\n// three\n`;
    const out = stripComments(code);
    expect(out.split("\n")).toHaveLength(code.split("\n").length);
    expect(out.split("\n")[1]).toBe(`const b = supabase.from("notes");`);
  });

  it("does not throw on source it cannot parse cleanly", () => {
    expect(stripComments(`const a = ( ; // broken\nconst q = supabase.from("notes");`)).toContain(`from("notes")`);
  });
});
