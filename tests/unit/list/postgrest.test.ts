import { describe, expect, it } from "vitest";
import {
  containsPattern,
  quoteLogicValue,
  topLevelValue,
} from "@/lib/list/postgrest";

// PostgREST value encoding.
//
// Every expectation here was first established against the running stack --
// see lib/list/postgrest.ts for the plans and responses. These tests exist so
// that the encoders cannot drift away from the grammar that was measured, and
// so that "we tried quoting everywhere" cannot be reintroduced: the top-level
// and logic-tree grammars are DIFFERENT, and using one encoder in the other's
// position returns the wrong page with a 200 and no error anywhere.

const ADVERSARIAL = [
  "Comma, Name",
  "Paren) Name",
  '(Paren Name',
  'Quote" Name',
  "Back\\slash Name",
  "Dot.eq.Name",
  "Star* Name",
  "Percent% Name",
  "Under_score Name",
  "Plus+Name",
  "Amp&and=Name",
  "Hash#Name",
  'All,")\\.*%_ Name',
];

describe("quoteLogicValue -- for or=() and and=()", () => {
  it("always quotes, even when nothing needs it", () => {
    // Unconditional, not "when it looks dangerous". A conditional quoter is
    // one missed character away from a silent wrong page.
    expect(quoteLogicValue("Ada")).toBe('"Ada"');
    expect(quoteLogicValue("")).toBe('""');
  });

  it("escapes a double quote", () => {
    expect(quoteLogicValue('Quote" Name')).toBe('"Quote\\" Name"');
  });

  it("escapes a backslash", () => {
    expect(quoteLogicValue("Back\\slash")).toBe('"Back\\\\slash"');
  });

  it("escapes the backslash BEFORE the quote", () => {
    // Order matters and getting it wrong is invisible in the easy cases. If
    // quotes were escaped first, the backslash added for `"` would then be
    // doubled by the backslash pass, producing `\\"` -- a literal backslash
    // followed by an unescaped quote, which terminates the value early.
    expect(quoteLogicValue('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("leaves PostgREST grammar characters alone inside the quotes", () => {
    // They do not need escaping -- being inside the quotes is what makes them
    // safe. Escaping them as well would change the value being compared.
    expect(quoteLogicValue("Comma, Name")).toBe('"Comma, Name"');
    expect(quoteLogicValue("Paren) Name")).toBe('"Paren) Name"');
    expect(quoteLogicValue("Dot.eq.Name")).toBe('"Dot.eq.Name"');
  });

  it("produces a value whose quotes are balanced, for every adversarial name", () => {
    // A crude but load-bearing property: after removing every escaped pair,
    // exactly two quote characters remain -- the delimiters. If an input
    // could smuggle a third, it could close the value and start a new
    // condition.
    for (const name of ADVERSARIAL) {
      const encoded = quoteLogicValue(name);
      expect(encoded.startsWith('"')).toBe(true);
      expect(encoded.endsWith('"')).toBe(true);
      const inner = encoded.slice(1, -1);
      const unescaped = inner.replace(/\\\\/g, "").replace(/\\"/g, "");
      expect(unescaped).not.toContain('"');
    }
  });

  it("survives a payload shaped like a filter expression", () => {
    const attack = '"),id.gt.00000000-0000-0000-0000-000000000000)&x=(';
    const encoded = quoteLogicValue(attack);
    const inner = encoded.slice(1, -1);
    expect(inner.replace(/\\\\/g, "").replace(/\\"/g, "")).not.toContain('"');
  });

  it("is reversible -- the value Postgres compares is the original", () => {
    // Undoing the escaping must give back exactly what went in. If it does
    // not, the cursor points at a row that is not the one the page ended on.
    for (const name of [...ADVERSARIAL, "", "\\", '"', '\\"', '"\\']) {
      const inner = quoteLogicValue(name).slice(1, -1);
      const unescaped = inner.replace(/\\(.)/g, "$1");
      expect(unescaped).toBe(name);
    }
  });
});

describe("topLevelValue -- for column=op.value", () => {
  it("is the identity, because PostgREST takes the value literally there", () => {
    // Measured, not assumed: `name=eq.Comma, Name` matches and
    // `name=eq."Comma, Name"` matches nothing, because the quotes become part
    // of the compared string. See lib/list/postgrest.ts.
    for (const name of ADVERSARIAL) {
      expect(topLevelValue(name)).toBe(name);
    }
  });

  it("is NOT quoteLogicValue -- the two must never be swapped", () => {
    // The regression guard. Swapping them silently changes which rows a page
    // starts at rather than raising anything.
    expect(topLevelValue("Ada")).not.toBe(quoteLogicValue("Ada"));
  });
});

describe("containsPattern -- ILIKE from user search text", () => {
  it("wraps in % rather than *", () => {
    // % and * both mean "anything" to PostgREST, but only % survives its
    // rewrite unchanged, so a pattern built with % means the same thing
    // before and after.
    expect(containsPattern("ada")).toBe("%ada%");
  });

  it("escapes the Postgres LIKE metacharacters", () => {
    expect(containsPattern("50%")).toBe("%50\\%%");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
  });

  it("escapes the backslash BEFORE the wildcards, in one pass", () => {
    // A two-pass implementation (backslashes, then %) would double-escape the
    // backslash it had just inserted. The single regex is not a style choice.
    expect(containsPattern("\\%")).toBe("%\\\\\\%%");
  });

  it("leaves * alone, because there is no escape for it", () => {
    // PostgREST rewrites `*` to `%` unconditionally, and rewrites `\*` to
    // `\%` -- a literal percent sign, which is not what the user typed
    // either. Measured against two planted contacts, "ZzStarX" and
    // "ZzStar* X": `ilike.%ZzStar*X%` matched both, `ilike.%ZzStar\*X%`
    // matched neither. So `*` is a user-facing wildcard, deliberately, and
    // the widest pattern it can produce is the no-search query, which is
    // indexed and takes 0.5 ms.
    expect(containsPattern("a*b")).toBe("%a*b%");
  });

  it("leaves the logic-tree grammar characters alone", () => {
    // A top-level filter, so they are literal. Escaping them here would make
    // a contact called "O'Brien, Sean" unfindable by their own surname.
    expect(containsPattern("O'Brien, Sean")).toBe("%O'Brien, Sean%");
    expect(containsPattern("Paren)")).toBe("%Paren)%");
    expect(containsPattern('Quote"')).toBe('%Quote"%');
  });

  it("handles an empty term without producing a bare wildcard by accident", () => {
    // Callers must not search an empty term at all -- lib/list/query.ts
    // checks -- but if one ever did, the result is the no-filter query rather
    // than anything broken.
    expect(containsPattern("")).toBe("%%");
  });
});
