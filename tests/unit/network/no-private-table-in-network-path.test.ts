import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, stripComments } from "../../support/source";
import { appSourceFiles, relPath } from "../support/app-source";

// PHASE 6 (NETWORK), TASK 5: THE CI-VISIBLE HALF OF THE LEAKAGE PROOF.
//
// ===========================================================================
// WHY A SOURCE-SHAPE FILE IS THE HALF THAT MATTERS FOR CI
// ===========================================================================
// `.github/workflows/ci.yml` runs `pnpm lint`, `next typegen`, `pnpm
// typecheck`, `pnpm exec vitest run tests/unit`, `pnpm audit` and gitleaks.
// It does NOT run `tests/integration`, it does not run Playwright, and it
// does not run `supabase/tests/run-rls-tests.sh`. So the whole of
// `supabase/tests/network_leakage_phase6.sql` -- the suite CLAUDE.md
// § Testing gates calls the kind that "matters most" -- reddens only on a
// developer's machine.
//
// This file is what reddens IN CI. It cannot see a behavioural leak; what it
// can see is the SHAPE of one: a file on the network path reaching for a
// tenant-private table by name. That is the shape every leak in this class has
// had, and it is the shape a reviewer misses at 3pm on a Friday.
//
// ===========================================================================
// HOW IT DIFFERS FROM discovery-source-shape.test.ts, WHICH ALREADY EXISTS
// ===========================================================================
// That file (Task 3) reads THREE NAMED FILES and asserts none of them selects
// `network_profiles` -- the base table -- for a foreign organisation. It is a
// statement about the DISCOVERY READ PATH and about ONE table, and it is
// deliberately not folded in here: the two make different claims and a merged
// file would blur them.
//
// THIS file reads the WHOLE network path -- every file under `lib/network/`,
// `components/network/` and `app/(app)/[orgSlug]/network/`, DISCOVERED BY
// DIRECTORY LISTING rather than by a hardcoded list, so a file added tomorrow
// is inspected tomorrow -- and asserts none of them names ANY tenant-private
// relation. A hardcoded FILES array is exactly how a guard goes quiet: the
// leak arrives in the file nobody added to the array.
//
// ===========================================================================
// THE DENOMINATOR AND THE POSITIVE CONTROL (Constraint 14)
// ===========================================================================
// "No file names a private table" is satisfied perfectly by inspecting no
// files. So: the file count is asserted at or above the real current count,
// the `.from(...)` call-site count is asserted non-zero, the needle list's own
// size is asserted, and a planted hostile fixture containing `from("notes")`
// is run through the SAME detector and must be flagged.

/** Comments stripped, so a doc comment that NAMES a forbidden table -- as this
 *  file's own header does, and as several modules' headers do at length --
 *  cannot trip the search. */

/** Every `.from("<literal>")` call site. */
function literalFromCalls(code: string): string[] {
  return Array.from(
    code.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]\s*\)/g),
    (m) => m[1]!,
  );
}

/** Every `.from(<expression>)` call site whose argument is NOT a string
 *  literal -- a dynamic table name, which a literal search cannot see and
 *  which therefore has to be enumerated and justified rather than ignored. */
function dynamicFromCalls(code: string): string[] {
  return Array.from(code.matchAll(/\.from\(\s*([^"'`\s)][^)]*)\)/g), (m) =>
    m[1]!.trim(),
  );
}

const NETWORK_PATH_DIRS = [
  "lib/network",
  "components/network",
  "app/(app)/[orgSlug]/network",
] as const;

// ===========================================================================
// THE SWEEP IS DERIVED FROM THE WHOLE REPOSITORY (census audit A4, second half)
// ===========================================================================
// The three directories above were the whole subject set, so "a network read
// path added elsewhere -- lib/crm/..., a route handler under app/api/... -- is
// outside the sweep", and the `>= 36` floor does not move when that happens.
//
// The candidate set is now every app-shipped source file whose PATH names the
// network (a `network` directory segment, or a `network-`/`network.` file
// name), taken from `appSourceFiles()` -- so a `app/api/network/route.ts`, a
// root `hooks/use-network.ts` or a `lib/crm/network-panel.ts` is swept the day
// it exists, with no list to edit. The three directories are kept as declared
// floors below: a derivation that grows by default still has to be shown to
// contain what it is known to contain.
const NETWORK_PATH = /(^|\/)network(\/|-|\.)/;
const FILES = appSourceFiles()
  .map((f) => relPath(f))
  .filter((f) => NETWORK_PATH.test(f))
  .sort();

/**
 * WHAT THE DERIVATION DROPS, PINNED (the rule this whole audit turns on:
 * `tests/unit/org/reserved-slugs.test.ts:248-251`).
 *
 * A file can read a network relation without living on the network path, and
 * such a file is dropped by the filter above in silence. So every app-shipped
 * file that NAMES a network relation and is not swept is enumerated here with
 * the reason it is not a network read path. A fourth one appearing is red, and
 * the choice it forces -- sweep it, or justify it -- is the point.
 */
const NETWORK_RELATIONS = [
  "network_profiles",
  "network_directory",
  "network_connected_profiles",
  "network_connection_requests",
  "network_links",
] as const;

const OFF_PATH_NETWORK_READERS: Record<string, string> = {
  "lib/list/query.ts":
    "the ONE list chokepoint. It names network_directory to meter the " +
    "Q107 network-discovery budget on that spec, and reads whatever table " +
    "the caller's spec names -- so it names every relation in the product " +
    "and a private-relation needle here would be a false positive on the " +
    "generic mechanism rather than a finding.",
  // PHASE 8 TASK 7 (20261006000000, Q122): the audit catalogue maps each
  // audited target to its physical table, and network_profiles /
  // network_links are two of the sixteen tables that task audited.
  "lib/admin/audit-actions.ts":
    "the audit ACTION CATALOGUE, not a read path. CRM_AUDIT_TARGET_TABLE " +
    "names network_profiles and network_links as the physical tables two " +
    "audit targets live on (and AUDIT_COVERAGE_EXCUSALS names " +
    "network_connection_requests' dedicated writer); it issues no query, " +
    "and the integration census binds those strings to pg_trigger.",
};
// MEASURED at 163 migrations: exactly ONE; TWO since 208 (Phase 8 Task 7). Two other files name a network
// relation in PROSE only -- `lib/admin/audit-log.ts` and the company detail
// page -- and the comment stripper removes both, which is the first thing this
// assertion happens to prove about the stripper rewritten in this same task.
const SOURCES = new Map(
  FILES.map((f) => [f, stripComments(readFileSync(root + f, "utf8").replace(/\r\n/g, "\n"))]),
);

// ===========================================================================
// THE NEEDLE LIST -- EVERY TENANT-PRIVATE RELATION
// ===========================================================================
// A SIBLING of `supabase/tests/network_leakage_phase6.sql`'s
// `leak.private_rel` list, NOT a copy kept at equal size on purpose (Task 6
// doc-reconciliation note, Constraint 13: an earlier version of this header
// implied the two lists should agree in COUNT, which is false and was never
// measured). Each list is sized to what IT is allowed to find on its own
// path: this one deliberately EXCLUDES the four CRM entity kinds a network
// profile can speak for -- companies, artists, venues, agencies -- because
// `lib/network/entities.ts` legitimately reads them, for the caller's OWN
// organisation only, to build the "publish a record" picker and resolve a
// linked record's name (see `ALLOWED_LITERAL_TABLES` below); a needle for any
// of those four would have to be suppressed on that one file rather than
// caught by it. `leak.private_rel` has no such caller-owns-it exception to
// carve out, so it carries all four. Each list's OWN size is asserted below
// (this one) and in `network_leakage_phase6.sql` LF1b (28) independently --
// the two numbers are not required to match and do not. `ratings` is on this
// list even though `public.ratings` does not exist -- N5/Q85's forward guard:
// the day it lands, this assertion is already watching.
//
// The four CRM entity tables a network profile can SPEAK FOR -- companies,
// artists, venues, agencies -- are deliberately NOT on it. `lib/network/
// entities.ts` reads them, correctly and only for the caller's OWN
// organisation, to build the "publish a record" picker and to resolve a linked
// record's name. They get their own assertion below instead of a blanket ban
// that would have to be suppressed on the one file that needs them.
const PRIVATE_RELATIONS = [
  "contacts",
  "contact_companies",
  "venue_rooms",
  "events",
  "event_lineup",
  "event_status_changes",
  "event_finance_summary",
  "tasks",
  "task_links",
  "meetings",
  "meeting_links",
  "notes",
  "note_links",
  "documents",
  "document_links",
  "document_versions",
  "financial_entries",
  "custom_field_values",
  "custom_field_definitions",
  "activity_events",
  "audit_events",
  "merges",
  "merge_candidates",
  "ratings",
  "feedback",
] as const;

/** The only tables the network path may name, and each one's reason. */
const ALLOWED_LITERAL_TABLES = new Set([
  // The network's own three tables and two masking views.
  "network_profiles",
  "network_directory",
  "network_connected_profiles",
  "network_connection_requests",
  "network_links",
  // The four kinds a profile can speak for -- read for the caller's OWN
  // organisation only (lib/network/entities.ts), never for a foreign one.
  "companies",
  "artists",
  "venues",
  "agencies",
]);

describe("the network path names no tenant-private relation (the CI-visible half of the leakage proof)", () => {
  it("DENOMINATOR: it inspected the whole network path, and that is at least 36 files", () => {
    // 14 in lib/network, 16 in components/network, 6 under the route tree at
    // the time this was written -- measured, not guessed. Asserted as a FLOOR
    // so adding a file is not a test edit, while DELETING the directory (or
    // mistyping its name, which readdirSync would throw on) cannot pass.
    expect(FILES.length, `inspected: ${FILES.join(", ")}`).toBeGreaterThanOrEqual(36);
  });

  it("DENOMINATOR: what the network-path filter DROPPED is pinned, not discarded", () => {
    // Every app-shipped file that names a network relation and is NOT swept.
    // Walk the tree ONCE: re-walking it per roll entry below made this test run
    // past vitest's 5 s ceiling under full parallel load (follow-up F-T8-1).
    const appFiles = appSourceFiles();
    const appPaths = appFiles.map((f) => relPath(f));
    const offPath = appFiles
      .map((f) => ({ path: relPath(f), text: stripComments(readFileSync(f, "utf8").replace(/\r\n/g, "\n")) }))
      .filter((f) => !FILES.includes(f.path))
      .filter((f) => NETWORK_RELATIONS.some((r) => new RegExp(`\\b${r}\\b`).test(f.text)))
      .map((f) => f.path)
      .sort();
    expect(
      offPath,
      "a file outside the network path names a network relation. Either it is " +
        "a network read path -- in which case it belongs in the sweep -- or it " +
        "is not, in which case say why in OFF_PATH_NETWORK_READERS. The one " +
        "thing it cannot be is unexamined.",
    ).toEqual(Object.keys(OFF_PATH_NETWORK_READERS).sort());
    // And each justification is a real sentence about a real file, so the roll
    // cannot become a place to park a name.
    for (const [file, why] of Object.entries(OFF_PATH_NETWORK_READERS)) {
      expect(appPaths, file).toContain(file);
      expect(why.length, file).toBeGreaterThan(60);
    }
    expect(new Set(NETWORK_RELATIONS).size).toBe(5);
    // It reads every app source file: ~1.5 s alone, past vitest's 5 s default
    // under full parallel load on a memory-constrained machine (F-T8-1). An
    // explicit ceiling, not a retry -- the assertions are unchanged.
  }, 20_000);

  // Phase 8 Task 7 fix round 1, M4. The audit catalogue's exemption says "it
  // issues no query", and that was a sentence rather than an assertion: the
  // exemption covers the whole file for ever, so a query on network_profiles
  // added here later would be exempt too. These are the off-path files whose
  // justification is that they are CATALOGUES, and this makes the claim
  // binding -- no module import of any kind (so no client), no dynamic
  // import or require, no `.rpc(`, no `fetch(`, and no `.from(` other than
  // the standard library's `Array.from(`.
  const CATALOGUE_ONLY_OFF_PATH = ["lib/admin/audit-actions.ts"] as const;
  function queryShapes(text: string): string[] {
    const found: string[] = [];
    if (/^\s*import\b/m.test(text)) found.push("an import");
    if (/\bimport\s*\(/.test(text)) found.push("a dynamic import");
    if (/\brequire\s*\(/.test(text)) found.push("a require");
    if (/\.rpc\s*\(/.test(text)) found.push("an .rpc( call");
    if (/\bfetch\s*\(/.test(text)) found.push("a fetch( call");
    if (/(?<!\bArray)\.from\s*\(/.test(text)) found.push("a .from( call");
    return found;
  }

  it("a CATALOGUE-ONLY off-path file stays query-free, so its exemption cannot shelter a read (M4)", () => {
    for (const file of CATALOGUE_ONLY_OFF_PATH) {
      expect(Object.keys(OFF_PATH_NETWORK_READERS), file).toContain(file);
      const text = stripComments(readFileSync(root + file, "utf8").replace(/\r\n/g, "\n"));
      // DENOMINATOR: the file really is the catalogue and really names a
      // network relation -- otherwise "no query in it" would be vacuous.
      expect(text, file).toContain("CRM_AUDIT_TARGET_TABLE");
      expect(NETWORK_RELATIONS.some((r) => text.includes(r)), file).toBe(true);
      expect(queryShapes(text), `${file} is declared a catalogue and now issues a query`).toEqual([]);
    }
  });

  it("POSITIVE CONTROL: the query-shape detector flags each shape it claims to, and not Array.from", () => {
    expect(queryShapes(`const a = Array.from(new Set(["x"]));`)).toEqual([]);
    expect(queryShapes(`import { createClient } from "@/lib/supabase/server";`)).toEqual(["an import"]);
    expect(queryShapes(`const m = await import("./x");`)).toEqual(["a dynamic import"]);
    expect(queryShapes(`const m = require("./x");`)).toEqual(["a require"]);
    expect(queryShapes(`await supabase.rpc("f");`)).toEqual(["an .rpc( call"]);
    expect(queryShapes(`await fetch("/rest/v1/network_profiles");`)).toEqual(["a fetch( call"]);
    expect(queryShapes(`await db.from("network_profiles").select("*");`)).toEqual(["a .from( call"]);
  });

  it("DENOMINATOR: all three directories contributed files", () => {
    // A floor over the union is satisfied by one very full directory. This is
    // what stops `components/network` quietly dropping out of the sweep.
    for (const dir of NETWORK_PATH_DIRS) {
      expect(
        FILES.filter((f) => f.startsWith(dir + "/")).length,
        `${dir} contributed no files to the sweep`,
      ).toBeGreaterThan(0);
    }
  });

  it("DENOMINATOR: the needle list is 25 private relation names", () => {
    // NOT tied to `leak.private_rel`'s own size assertion in
    // supabase/tests/network_leakage_phase6.sql (LF1b, 28) -- see this file's
    // own header for why the two lists are deliberately different sizes (this
    // one excludes the four CRM entity kinds a network profile can speak for,
    // legitimately read by lib/network/entities.ts). This assertion pins THIS
    // list's own count so a needle silently dropped from the array is a test
    // edit, not a shrinking denominator nobody notices.
    expect(new Set(PRIVATE_RELATIONS).size).toBe(25);
  });

  it("DENOMINATOR: there is at least one `.from(...)` call site to inspect", () => {
    const all = FILES.flatMap((f) => literalFromCalls(SOURCES.get(f)!));
    expect(all.length, "literal .from() call sites across the network path").toBeGreaterThan(0);
  });

  it("no file on the network path names a tenant-private relation, in a query or anywhere else", () => {
    // NOT limited to `.from(...)`. A private table can be reached by an
    // `.rpc()` whose name embeds it, by a raw `sql` template, or by a
    // PostgREST embed string like `select=*,notes(*)` -- which is exactly the
    // shape SECURITY.md § 10's contact_companies lesson is about and which no
    // `.from()` regex would see. So this searches the whole (comment-stripped)
    // source for the identifier, bounded by word edges so `notes` does not
    // match `noteshown` and `events` does not match `eventsList`.
    const hits: string[] = [];
    for (const [file, code] of SOURCES) {
      for (const rel of PRIVATE_RELATIONS) {
        if (new RegExp(`\\b${rel}\\b`).test(code)) hits.push(`${file}: ${rel}`);
      }
    }
    expect(
      hits,
      "a file on the network path names a tenant-private relation. The network " +
        "surface reads network_profiles / the two masking views / the three " +
        "network tables, and the four entity tables a profile speaks for -- " +
        "nothing else. See supabase/tests/network_leakage_phase6.sql § LC.",
    ).toEqual([]);
  });

  it("every LITERAL `.from(...)` target across the whole path is on the allowlist", () => {
    // The complement of the assertion above, and the stronger direction: that
    // one catches a name on the needle list, this one catches ANY table not
    // explicitly sanctioned -- including one added in a future phase that
    // nobody thought to add to PRIVATE_RELATIONS.
    const targets = new Set(FILES.flatMap((f) => literalFromCalls(SOURCES.get(f)!)));
    const unexpected = [...targets].filter((t) => !ALLOWED_LITERAL_TABLES.has(t));
    expect(
      unexpected,
      `unsanctioned query source(s) on the network path: ${unexpected.join(", ")}`,
    ).toEqual([]);
    // ...and the allowlist is not vacuously satisfied by an empty target set.
    expect(targets.size).toBeGreaterThan(0);
  });

  it("every DYNAMIC `.from(...)` target is enumerated, and there are exactly two", () => {
    // A literal search cannot see `.from(SOME_MAP[kind])`, so a dynamic call
    // site is a hole in the assertion above unless it is named and justified.
    // There are two on the whole path, both in lib/network/entities.ts and
    // both dispatching over ENTITY_TABLE, whose four values are the four
    // entity tables on ALLOWED_LITERAL_TABLES: loadEntityName, and (Phase 10
    // Task 14, G6) loadPublishableEntities' bounded scan. Each query carries
    // `.eq("organisation_id", organisationId)` for the caller's OWN
    // organisation. A third dynamic call site turns this red and has to be
    // justified the same way.
    const dynamic = FILES.flatMap((f) =>
      dynamicFromCalls(SOURCES.get(f)!).map((expr) => `${f}: ${expr}`),
    );
    expect(dynamic).toEqual([
      "lib/network/entities.ts: ENTITY_TABLE[entityKind]",
      "lib/network/entities.ts: ENTITY_TABLE[entityKind]",
    ]);
  });

  it("ENTITY_TABLE's four values are all on the allowlist, so the dynamic call cannot escape it", () => {
    const entities = SOURCES.get("lib/network/entities.ts")!;
    const map = /ENTITY_TABLE[^=]*=\s*\{([^}]*)\}/.exec(entities);
    expect(map, "ENTITY_TABLE is no longer an object literal in entities.ts").not.toBeNull();
    const values = Array.from(map![1]!.matchAll(/["'`]([\w.]+)["'`]/g), (m) => m[1]!);
    expect(values.length, "ENTITY_TABLE's values").toBe(4);
    for (const v of values) expect(ALLOWED_LITERAL_TABLES.has(v), v).toBe(true);
  });

  it("POSITIVE CONTROL: the same detectors, run on a planted hostile fixture, DO flag it", () => {
    // The brief's own words: "a fixture string containing `from(\"notes\")` is
    // detected". Without this, every assertion above is a claim about a regex
    // nobody has watched fire.
    const hostile = `
      export async function leaky(orgId: string) {
        const supabase = await createClient();
        return supabase.from("notes").select("*").eq("organisation_id", orgId);
      }
    `;
    const code = stripComments(hostile);
    expect(literalFromCalls(code)).toContain("notes");
    expect(
      [...new Set(literalFromCalls(code))].filter((t) => !ALLOWED_LITERAL_TABLES.has(t)),
    ).toEqual(["notes"]);
    expect(PRIVATE_RELATIONS.filter((rel) => new RegExp(`\\b${rel}\\b`).test(code))).toEqual([
      "notes",
    ]);
  });

  it("POSITIVE CONTROL: a PostgREST EMBED of a private table is flagged too, not just a `.from`", () => {
    // The embed is the shape a `.from()` regex misses entirely, and the one
    // SECURITY.md § 10 was written about. The identifier search is what covers
    // it; this is the proof that it does.
    const hostile = `const q = supabase.from("network_directory").select("*,notes(*)");`;
    const code = stripComments(hostile);
    expect(literalFromCalls(code)).not.toContain("notes");
    expect(PRIVATE_RELATIONS.filter((rel) => new RegExp(`\\b${rel}\\b`).test(code))).toEqual([
      "notes",
    ]);
  });

  it("POSITIVE CONTROL: the comment stripper really is what keeps the header honest", () => {
    // Several modules on this path name private tables in prose -- so does
    // this file. If stripComments() stopped working, the sweep above would go
    // red for the wrong reason and somebody would weaken the needle list to
    // quiet it. This pins the mechanism instead.
    const commented = `// we deliberately never read public.notes here\nconst x = 1;\n`;
    expect(/\bnotes\b/.test(commented)).toBe(true);
    expect(/\bnotes\b/.test(stripComments(commented))).toBe(false);
  });
});
