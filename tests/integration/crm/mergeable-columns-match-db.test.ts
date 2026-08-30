// THE MERGE'S FIELD LIST IS WRITTEN IN TWO LANGUAGES, AND THIS BINDS THEM.
//
// `private.dedup_mergeable_columns()` decides which columns public.merge_records()
// will actually take from either record. `MERGEABLE_COLUMNS` in lib/crm/dedup.ts
// decides which rows the merge screen renders a choice for. They have to be the
// same set, and they cannot be the same object: the screen has to draw the rows
// before the function runs, and a request cannot read a SQL function's body.
//
// WHAT DRIFT COSTS, in each direction:
//
//   a column in SQL and not in TypeScript   the merge takes it from a record
//                                           the user was never asked about --
//                                           silently, because the default
//                                           (winner keeps its value unless it
//                                           has none) still applies.
//   a column in TypeScript and not in SQL   the screen asks a question whose
//                                           answer is discarded, and the field
//                                           does not move. Worse than the
//                                           first: the user watched themselves
//                                           choose.
//
// Same treatment as the four other rules this repository writes twice --
// record scope, the tier table, the past-due grace window and the entity-type
// allowlist -- and read out of the LIVE catalogue (pg_get_functiondef) rather
// than the migration text, because a later migration can replace the function
// and what is deployed is what decides.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  ENTITY_TABLE,
  MERGEABLE_COLUMNS,
  MERGE_ENTITY_TYPES,
  type MergeEntityType,
} from "@/lib/crm/dedup";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function mergeableColumns(entityType: string): Promise<string[]> {
  const { rows } = await pool.query<{ cols: string[] }>(
    "select private.dedup_mergeable_columns($1) as cols",
    [entityType],
  );
  return rows[0].cols;
}

describe("the merge's mergeable-column list agrees with the database", () => {
  it("finds the function at all, so this suite cannot pass vacuously", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname in ('dedup_mergeable_columns', 'dedup_entity_table')`,
    );
    expect(rows[0].n).toBe("2");
  });

  for (const entityType of MERGE_ENTITY_TYPES) {
    it(`${entityType}: MERGEABLE_COLUMNS matches private.dedup_mergeable_columns()`, async () => {
      const inSql = (await mergeableColumns(entityType)).slice().sort();
      // Sorted, because the SQL function's order is a migration detail and the
      // TypeScript list's order is a UI one -- it decides the order of the rows
      // on the merge screen. What has to match is the SET.
      expect(
        inSql,
        `private.dedup_mergeable_columns('${entityType}') and MERGEABLE_COLUMNS ` +
          "in lib/crm/dedup.ts disagree. A column in one and not the other is " +
          "either a field the merge moves without asking, or a question the " +
          "screen asks and then discards.",
      ).toEqual([...MERGEABLE_COLUMNS[entityType as MergeEntityType]].sort());
    });

    it(`${entityType}: ENTITY_TABLE matches private.dedup_entity_table()`, async () => {
      const { rows } = await pool.query<{ t: string }>(
        "select private.dedup_entity_table($1) as t",
        [entityType],
      );
      expect(rows[0].t).toBe(ENTITY_TABLE[entityType as MergeEntityType]);
    });

    it(`${entityType}: every mergeable column really exists on the table`, async () => {
      // The half neither list can check about itself. A column dropped in a
      // later migration leaves both copies agreeing with each other and both
      // wrong -- the merge screen renders a row of "Not recorded" and the
      // function's SET list names a column that no longer exists, which is a
      // 42703 at merge time rather than at deploy time.
      const { rows } = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [ENTITY_TABLE[entityType as MergeEntityType]],
      );
      const present = new Set(rows.map((r) => r.column_name));
      for (const column of MERGEABLE_COLUMNS[entityType as MergeEntityType]) {
        expect(
          present.has(column),
          `public.${ENTITY_TABLE[entityType as MergeEntityType]} has no column "${column}"`,
        ).toBe(true);
      }
    });
  }

  it("no mergeable column is one a merge must never move", async () => {
    // THE ALLOWLIST'S WHOLE POINT. organisation_id in a field choice would be a
    // cross-tenant write wearing a merge's clothes; id would be a primary-key
    // rewrite; owner_user_id would move a record between record scopes as a
    // side effect of a merge. Asserted against the SQL side, which is the one
    // that decides.
    const forbidden = [
      "id",
      "organisation_id",
      "owner_user_id",
      "created_at",
      "updated_at",
      "deleted_at",
    ];
    for (const entityType of MERGE_ENTITY_TYPES) {
      const inSql = await mergeableColumns(entityType);
      for (const column of forbidden) {
        expect(
          inSql,
          `private.dedup_mergeable_columns('${entityType}') offers "${column}", ` +
            "which a merge must never take from either record.",
        ).not.toContain(column);
      }
    }
  });
});
