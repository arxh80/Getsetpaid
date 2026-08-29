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
import { readFileSync } from "node:fs";
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
