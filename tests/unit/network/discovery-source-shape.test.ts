import { describe, expect, it } from "vitest";
import { readSource as read, stripComments } from "../../support/source";

// TASK 3's OWN LEAKAGE ASSERTION #2 -- THE SOURCE-SHAPE HALF.
//
// ===========================================================================
// THE PAIR THIS IS HALF OF
// ===========================================================================
// The brief's leakage assertions are deliberately TWO, and the pairing is the
// point:
//
//   1. (the HTTP suite, supabase/tests/run-rls-tests.sh) a hand-crafted
//      `GET /rest/v1/network_profiles?select=*` for a non-owning caller
//      returns every masked column POPULATED -- and that is EXPECTED AND
//      CORRECT, because the base table is deliberately readable and the view
//      is the mask (20260904003000's own comment on
//      `network_profiles_select_published_directory`). That assertion exists
//      to keep the design intent on permanent record.
//   2. (THIS FILE) the one that matters: no application code path reachable
//      from Task 3's read surface selects from `public.network_profiles` for
//      a foreign organisation. Because assertion #1 is true, this is the ONLY
//      thing standing between "the base table is readable by design" and "the
//      base table is readable by an application bug".
//
// ===========================================================================
// WHY THIS IS SOURCE-ONLY, AND WHY THAT IS NOT A LESSER VERSION OF THE SAME
// CLAIM
// ===========================================================================
// CI runs `pnpm exec vitest run tests/unit` and NOTHING ELSE network-shaped
// (the phase's own Global Constraints, "CI note"). A behavioural leak here
// would only ever be caught on a developer's machine, by
// `tests/integration/network/discovery.test.ts` or the psql/HTTP suite. This
// file is the one that reddens IN CI: it reads the THREE FILES Task 3 shipped
// for the read path -- `lib/network/discovery.ts` and the two page files --
// and asserts none of them names `network_profiles` as a query source. It
// cannot see a leak introduced anywhere ELSE (a helper this file does not
// read, a change to a file that already passed); what it can see, it sees on
// every commit.


/** Comments stripped, so a doc comment that NAMES the forbidden call (as this
 *  very test file's own header does, and as lib/network/discovery.ts's header
 *  does at length) cannot trip a naive substring search. */

/** Every `.from("<table>")` / `.from('<table>')` call site in `code`. */
function fromCalls(code: string): string[] {
  return Array.from(
    code.matchAll(/\.from\(\s*["']([\w.]+)["']\s*\)/g),
    (m) => m[1]!,
  );
}

const FILES = [
  "lib/network/discovery.ts",
  "app/(app)/[orgSlug]/network/page.tsx",
  "app/(app)/[orgSlug]/network/[profileId]/page.tsx",
] as const;

describe("Constraint 19 / N2, at the application layer: Task 3's read surface never selects public.network_profiles", () => {
  it("every `.from(...)` call site in the three files is inspected, and there is at least one", () => {
    // THE DENOMINATOR. A file rename that silently drops one of the three
    // paths above from FILES would make every assertion below vacuously true
    // over an empty set; this is what stops that from passing quietly.
    const allCalls = FILES.flatMap((file) => fromCalls(stripComments(read(file))));
    expect(allCalls.length, "select call sites inspected across the three files").toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${file}: no \`.from("network_profiles")\``, () => {
      // NOT asserted non-empty PER FILE: the two page files correctly make NO
      // `.from(...)` call of their own at all -- they delegate entirely to
      // `lib/network/discovery.ts` and `lib/network/entities.ts`, which is the
      // stronger shape, not a gap. The denominator lives in the test above,
      // over the three files TOGETHER, so this file being one of the ones
      // that contributes zero calls cannot make that assertion vacuous.
      const calls = fromCalls(stripComments(read(file)));
      expect(
        calls,
        `${file} selects from network_profiles -- the base table, unmasked, ` +
          "for a profile that may belong to a foreign organisation. Read " +
          "through public.network_directory or public.network_connected_" +
          "profiles instead (lib/network/discovery.ts).",
      ).not.toContain("network_profiles");
    });
  }

  it("lib/network/discovery.ts names exactly the two masking views, and nothing else, as its query sources", () => {
    const calls = fromCalls(stripComments(read("lib/network/discovery.ts")));
    expect(new Set(calls)).toEqual(
      new Set(["network_directory", "network_connected_profiles"]),
    );
  });

  it("POSITIVE CONTROL: the same detector, run against a fixture string naming network_profiles, DOES flag it", () => {
    // Proves the regex and the assertion shape actually fire on the thing
    // they exist to catch, rather than passing over the real files by
    // accident (a typo'd table name, a changed quoting style the regex does
    // not match). This is the paired positive control the brief asks for.
    const hostile = `
      export async function leaky(profileId: string) {
        const supabase = await createClient();
        return supabase.from("network_profiles").select("*").eq("id", profileId);
      }
    `;
    const calls = fromCalls(stripComments(hostile));
    expect(calls).toContain("network_profiles");
  });
});
