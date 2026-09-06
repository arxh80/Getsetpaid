import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Every file under `relative`, recursively, with a source extension. */
function sourceFilesUnder(relative: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(root + dir)) {
      const path = `${dir}/${entry}`;
      if (statSync(root + path).isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(path);
      }
    }
  };
  walk(relative);
  return out.sort();
}

/** Comments stripped, so a doc comment that NAMES a forbidden table -- as this
 *  file's own header does, and as several modules' headers do at length --
 *  cannot trip the search. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

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

const FILES = NETWORK_PATH_DIRS.flatMap(sourceFilesUnder);
const SOURCES = new Map(
  FILES.map((f) => [f, stripComments(readFileSync(root + f, "utf8").replace(/\r\n/g, "\n"))]),
);

// ===========================================================================
// THE NEEDLE LIST -- EVERY TENANT-PRIVATE RELATION
// ===========================================================================
// The same list `supabase/tests/network_leakage_phase6.sql`'s `leak.private_rel`
// carries, kept in step by hand and asserted at both ends (the psql suite
// asserts its own size, this file asserts this one). `ratings` is on it even
// though `public.ratings` does not exist -- N5/Q85's forward guard: the day it
// lands, this assertion is already watching.
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
    // If this number ever disagrees with `leak.private_rel`'s own size
    // assertion in supabase/tests/network_leakage_phase6.sql (LF1b), one of
    // the two lists has drifted and the disagreement is the finding.
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

  it("every DYNAMIC `.from(...)` target is enumerated, and there is exactly one", () => {
    // A literal search cannot see `.from(SOME_MAP[kind])`, so a dynamic call
    // site is a hole in the assertion above unless it is named and justified.
    // There is exactly one on the whole path: lib/network/entities.ts:305
    // dispatches over ENTITY_TABLE, whose four values are the four entity
    // tables on ALLOWED_LITERAL_TABLES -- and the query it builds carries
    // `.eq("organisation_id", organisationId)` for the caller's OWN
    // organisation. A second dynamic call site turns this red and has to be
    // justified the same way.
    const dynamic = FILES.flatMap((f) =>
      dynamicFromCalls(SOURCES.get(f)!).map((expr) => `${f}: ${expr}`),
    );
    expect(dynamic).toEqual(["lib/network/entities.ts: ENTITY_TABLE[entityKind]"]);
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
