import { describe, expect, it } from "vitest";
import { displayValue, valuesAgree } from "@/lib/crm/dedup";

// FINAL REVIEW I-2 (deferred-minor L948), the "agreed" half.
//
// The merge screen decided which fields to hide behind "Show the N fields they
// agree on" with `row.keepValue === row.duplicateValue` -- two `displayValue`
// strings. `displayValue` is lossy on purpose (its job is to read well), so
// distinct stored values that render the same were classified as agreed, the
// user was never offered the choice, and `merge_records()` picked a side.
//
// A merge is the one destructive, unattended-adjacent workflow in the phase.
// The outcome is recoverable -- `merges.field_resolution` v2 records `chosen`
// AND `discarded` for every field -- but only by an engineer reading the row.
//
// Every case below is written as the PAIR: the two values render identically,
// and `valuesAgree` says they are different. Each one is red under the old
// `displayValue` comparison.

describe("valuesAgree: the cases displayValue collapsed", () => {
  const collapsed: ReadonlyArray<readonly [string, unknown, unknown]> = [
    // An empty string is an answer; null is the absence of one. This is the
    // one that actually reaches a user: `lib/forms.ts`'s `field()` normalises
    // "" to null on the form path, so a record holding "" came from an import
    // or a direct PostgREST write -- exactly the rows a dedup queue is full of.
    ["an empty string and null", "", null],
    ["an empty string and undefined", "", undefined],
    ["an empty array and null", [], null],
    ["an empty object and null", {}, null],
    ["a number and its string", 0, "0"],
    ["a boolean and its string", true, "true"],
    // displayValue drops empty entries from an object, so these two render as
    // "y: 1" apiece.
    ["an object with an empty entry", { x: "", y: "1" }, { y: "1" }],
  ];

  for (const [label, a, b] of collapsed) {
    it(`${label} render identically but do not agree`, () => {
      // The premise: this pair is exactly what the old comparison saw.
      expect(displayValue(a)).toEqual(displayValue(b));
      // The fix.
      expect(valuesAgree(a, b)).toBe(false);
      expect(valuesAgree(b, a)).toBe(false);
    });
  }
});

describe("valuesAgree: what genuinely agrees still folds", () => {
  // The fold is worth keeping -- eight rows of "these both say Brighton" is
  // how a reviewer stops reading the two rows that matter -- so the fix must
  // not simply stop folding.
  it("identical primitives agree", () => {
    expect(valuesAgree("Brighton", "Brighton")).toBe(true);
    expect(valuesAgree(42, 42)).toBe(true);
    expect(valuesAgree(false, false)).toBe(true);
  });

  it("both absent agrees, including null against undefined", () => {
    // PostgREST omits a null jsonb key rather than sending it, so the same
    // absent custom field arrives as null on one side and undefined on the
    // other.
    expect(valuesAgree(null, null)).toBe(true);
    expect(valuesAgree(null, undefined)).toBe(true);
    expect(valuesAgree(undefined, undefined)).toBe(true);
  });

  it("equal arrays agree, in order", () => {
    expect(valuesAgree(["dnb", "house"], ["dnb", "house"])).toBe(true);
  });

  it("a re-ordered array does NOT agree", () => {
    // The other direction of the same defect. `displayValue` joins in order,
    // so these already rendered differently -- folding them would be the bug
    // this test file exists to prevent, pointing the other way.
    expect(valuesAgree(["dnb", "house"], ["house", "dnb"])).toBe(false);
  });

  it("objects agree regardless of key order", () => {
    // JSON object key order carries no meaning, and PostgREST does not
    // preserve it, so two `socials` columns holding the same links must fold.
    expect(
      valuesAgree(
        { instagram: "a", soundcloud: "b" },
        { soundcloud: "b", instagram: "a" },
      ),
    ).toBe(true);
  });

  it("nested structures compare all the way down", () => {
    expect(valuesAgree({ a: [1, { b: "c" }] }, { a: [1, { b: "c" }] })).toBe(true);
    expect(valuesAgree({ a: [1, { b: "c" }] }, { a: [1, { b: "d" }] })).toBe(false);
    expect(valuesAgree({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
