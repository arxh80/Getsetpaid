// THE ONE ESCAPE FROM lib/list/query.ts's SOFT-DELETE CLAUSE, BOUND TO THE
// SCHEMA THAT JUSTIFIES IT.
//
// `applyScope()` puts `deleted_at is null` (or `is not null`) on every query
// this application's list surface makes, and its own comment is emphatic that
// no option omits it: a list with no soft-delete predicate cannot use either
// partial index and would show deleted records among live ones.
//
// `public.merges` has no `deleted_at` and must not have one -- it is
// append-only by design (20260827232512: no UPDATE grant, no DELETE grant, no
// updated_at, merged_at IS the creation timestamp). Filtering a column that
// does not exist is a PostgREST 400, so the merge history page would have
// rendered "unavailable" forever.
//
// The escape is a SET KEYED ON THE TABLE rather than a flag a spec can pass,
// so it cannot be pointed at `contacts` by a copied file. This test is the
// other half of that: it fails if a table on the list grows a `deleted_at`
// (the escape is then a bug that hides deleted rows in plain sight), and it
// fails if the set names a table that does not exist.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * Read the set out of the SOURCE rather than importing it.
 *
 * lib/list/query.ts is `import "server-only"` and pulls in the whole Supabase
 * SSR client; importing it here to read one constant would drag a request
 * context into a test that has none. The constant is not exported for the same
 * reason it is not an option -- nothing outside that file should be choosing
 * which tables skip the clause -- so this reads the literal, and a rename that
 * makes the regex miss fails the "finds it at all" assertion below rather than
 * passing silently.
 */
function tablesWithoutSoftDelete(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../../lib/list/query.ts", import.meta.url)),
    "utf8",
  );
  const match = source.match(
    /const TABLES_WITHOUT_SOFT_DELETE = new Set\(\[([^\]]*)\]\)/,
  );
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Repository root, for the source scan below. */
const root = fileURLToPath(new URL("../../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(root + relative, "utf8");
}

/**
 * Every relation named by a `table:` option in lib/, deduplicated.
 *
 * A BLUNT SCAN OVER SOURCE TEXT, for the reason tests/unit/crm/source-shape.ts
 * gives at length: the failure this catches is an OMITTED entry in a set, and
 * nothing that runs the application can see one without a real database and a
 * real request. `table:` is `FetchListPageOptions`' own field name and the
 * value is required to be a literal, so the regex reads exactly what the
 * option accepts.
 *
 * Comment lines are stripped first, same as the write census: prose about a
 * `table:` is not a call site, and counting one would prop up the floor
 * assertion below with a sentence.
 */
function fetchListPageTables(): string[] {
  const files = [
    ...readdirSync(root + "lib/crm").map((f) => "lib/crm/" + f),
    ...readdirSync(root + "lib/list").map((f) => "lib/list/" + f),
  ].filter((f) => f.endsWith(".ts"));
  const found = new Set<string>();
  for (const file of files) {
    const source = read(file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const m of source.matchAll(/\btable:\s*"([a-z_]+)"/g)) {
      found.add(m[1]!);
    }
  }
  // The five entity lists live on their page components rather than in lib/,
  // so the app directory is scanned too. Nested one level deeper than lib/,
  // hence the recursive walk.
  const walk = (dir: string): string[] =>
    readdirSync(root + dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(dir + "/" + entry.name)
        : entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")
          ? [dir + "/" + entry.name]
          : [],
    );
  for (const file of walk("app")) {
    const source = read(file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const m of source.matchAll(/\btable:\s*"([a-z_]+)"/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

describe("TABLES_WITHOUT_SOFT_DELETE names exactly the tables that have none", () => {
  it("finds the set at all, so this suite cannot pass vacuously", () => {
    expect(
      tablesWithoutSoftDelete(),
      "TABLES_WITHOUT_SOFT_DELETE was not found in lib/list/query.ts. If it " +
        "was renamed, rename it here too -- an empty match would make every " +
        "assertion below pass over nothing.",
    ).not.toHaveLength(0);
  });

  for (const table of tablesWithoutSoftDelete()) {
    it(`public.${table} exists and really has no deleted_at`, async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table],
      );
      expect(rows.length, `public.${table} does not exist`).toBeGreaterThan(0);
      expect(
        rows.map((r) => r.column_name),
        `public.${table} now HAS a deleted_at, so lib/list/query.ts is skipping ` +
          "a soft-delete filter that exists -- every list over it will show " +
          "deleted rows among live ones and nothing will error.",
      ).not.toContain("deleted_at");
    });
  }

  // ==========================================================================
  // THE OTHER DIRECTION, AND IT IS THE ONE THAT WAS MISSING
  // ==========================================================================
  // Everything above asks "is what the set NAMES still true?". Nothing asked
  // "is everything that NEEDS naming in it?" -- and Task 7's browser pass found
  // out what that costs. `public.activity_events` is a view with no columns of
  // its own; `applyScope` put `deleted_at is null` on every query against it,
  // PostgREST answered 400, and every one of the five record detail pages
  // rendered "We couldn't load this contact's activity just now".
  //
  // NOT ONE GATE SAW IT: `tsc`, eslint, the 813 unit and integration tests
  // that existed at that moment, 843 psql assertions and 174 HTTP checks were
  // ALL GREEN -- because none of them calls `fetchListPage` against a real
  // relation. The unit tests mock the client, and the psql/HTTP suites write
  // their own URLs.
  //
  // So: read every relation a `fetchListPage` call names, and require each one
  // to be on exactly one side of the line. A new list surface over a view, or
  // over a table that never gets a soft delete, is red here on the first run
  // instead of on the first page load.
  describe("every relation a list reads is on one side of the line", () => {
    const named = fetchListPageTables();

    it("finds the call sites at all, so this suite cannot pass vacuously", () => {
      // Nine today: five entity lists, two duplicate queues, the merge
      // history, the artist fee history, and the activity timeline. The floor
      // is deliberately below that -- this is a "did the scan work" check, not
      // a census that has to be edited whenever a list is added.
      expect(named.length).toBeGreaterThan(5);
    });

    for (const table of named) {
      it(`public.${table} is either soft-deletable or listed as not`, async () => {
        const { rows } = await pool.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1`,
          [table],
        );
        expect(
          rows.length,
          `public.${table} is read by a fetchListPage call and does not exist`,
        ).toBeGreaterThan(0);

        const hasColumn = rows.some((r) => r.column_name === "deleted_at");
        const exempt = tablesWithoutSoftDelete().includes(table);
        expect(
          hasColumn || exempt,
          `public.${table} has no deleted_at and is NOT in ` +
            "TABLES_WITHOUT_SOFT_DELETE, so every query fetchListPage makes " +
            "against it filters a column that does not exist -- a PostgREST " +
            "400, rendered to the user as \"we couldn't load this\". Add it " +
            "to the set in lib/list/query.ts, with the reason.",
        ).toBe(true);
        expect(
          hasColumn && exempt,
          `public.${table} HAS a deleted_at and is also exempted, so the ` +
            "list over it will show deleted rows among live ones.",
        ).toBe(false);
      });
    }
  });

  it("public.merges is still append-only, which is why it is on the list", async () => {
    // The reason the escape is acceptable at all. If merges ever gains an
    // UPDATE or DELETE grant, "append-only" stops being true and the question
    // of whether it needs a soft delete has to be re-asked -- so the assertion
    // that justifies the exemption lives beside the exemption.
    const { rows } = await pool.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'merges'
          and grantee = 'authenticated'`,
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["SELECT"]);
  });
});
