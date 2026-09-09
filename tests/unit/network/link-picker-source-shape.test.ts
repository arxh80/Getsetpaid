import { describe, expect, it } from "vitest";
import { readSource as read, stripComments } from "../../support/source";

// Task 4 / Gap B (Q73): THE LINK PICKER'S SOURCE-SHAPE GUARD.
//
// ===========================================================================
// THE REFUSAL, AS A TEST RATHER THAN A COMMENT
// ===========================================================================
// The brief's own words: "the link picker's search input has no initial
// value derived from the private record, and the module contains no
// similarity/ranking call (Q73), with a positive control that the assertion
// detects a planted `similarity(` string." Both halves of this are
// STRUCTURAL claims about the source, not behavioural ones -- there is no
// database state that would make a hand-typed search box "pre-filled", so
// this is exactly the CI-visible source-only guard Global Constraints'
// "CI note" asks every network control to have: CI runs
// `vitest run tests/unit` and nothing network-shaped beyond it, so this is
// the one assertion that reddens on every commit rather than only on a
// developer's machine.
//
// SAME METHOD AS tests/unit/network/discovery-source-shape.test.ts: comments
// stripped first (this very file's header names `similarity(` in prose, and a
// naive substring search would flag itself), then a regex over the raw
// source.



const FILES = [
  "components/network/link-picker.tsx",
  "lib/network/link-search.ts",
] as const;

describe("Q73, at the source: the link picker never pre-fills and never ranks by similarity", () => {
  it("finds the call sites at all, so this suite cannot pass vacuously", () => {
    const total = FILES.reduce((n, f) => n + read(f).length, 0);
    expect(total, "the two files exist and have content to inspect").toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${file}: no \`similarity(\` call -- no ranking by similarity`, () => {
      const code = stripComments(read(file));
      expect(
        code,
        `${file} calls similarity(...) -- Q73 forbids ranking link-picker ` +
          "candidates by similarity to the private record. The search must " +
          "return exactly what the ordinary network directory search returns, " +
          "unranked beyond its own alphabetical default.",
      ).not.toMatch(/\bsimilarity\s*\(/);
    });
  }

  it("the search input's defaultValue is the PRIOR SEARCH STATE, never a value derived from the private record", () => {
    const code = stripComments(read("components/network/link-picker.tsx"));
    // THE POSITIVE SHAPE: the one `defaultValue` on the search `<input>` must
    // read `searchState.query` -- the server action's own echo of what was
    // typed and submitted (starting at "", EMPTY_LINK_PICKER_SEARCH_STATE) --
    // and nothing else.
    expect(code).toMatch(/name="q"[\s\S]{0,200}defaultValue=\{searchState\.query\}/);
  });

  it("no prop or import in the picker or the search action carries the private record's OWN field values into the search", () => {
    // entityType/entityId are the link TARGET identifiers (Q73's own
    // component header) and are asserted to reach only the hidden fields of
    // the LINK form, never the search input. A future regression that added,
    // say, `initialQuery={entityName}` would be a NEW prop this regex does
    // not already name -- so this also asserts the closed prop list on
    // LinkPicker's own destructured parameters.
    const picker = stripComments(read("components/network/link-picker.tsx"));
    const propsMatch = picker.match(/export function LinkPicker\(\{([\s\S]*?)\}:/);
    expect(propsMatch, "LinkPicker's destructured props were found").not.toBeNull();
    const propNames = Array.from(
      propsMatch![1]!.matchAll(/^\s*([a-zA-Z0-9_]+)/gm),
      (m) => m[1]!,
    );
    expect(new Set(propNames)).toEqual(
      new Set(["orgSlug", "entityType", "entityId", "disabledReason"]),
    );
  });

  it("POSITIVE CONTROL: the same detector, run against a fixture string with a planted `similarity(` call, DOES flag it", () => {
    const hostile = `
      export async function rankedSearch(term: string, entityName: string) {
        return loadNetworkDirectory({ net_q: term })
          .then((page) => page.rows.sort((a, b) => similarity(b.displayName, entityName) - similarity(a.displayName, entityName)));
      }
    `;
    expect(stripComments(hostile)).toMatch(/\bsimilarity\s*\(/);
  });
});
