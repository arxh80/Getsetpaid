// THE ENTITY-TYPE ALLOWLIST, AND THE TRIPWIRE THAT BINDS EVERY COPY OF IT.
//
// 20260827232512's header said the five-value allowlist was duplicated across
// three CHECK constraints -- custom_field_definitions, custom_field_values and
// merges -- rather than shared, and predicted:
//
//     "Phase 3 adds 'event' to all three, and having to touch three
//      constraints is the reminder that three code paths change too."
//
// PHASE 3 TASK 1 SPLIT THEM INTO TWO GROUPS INSTEAD, and this file is now what
// keeps the split honest. 20260901001000 added 'event' to the two CUSTOM FIELD
// constraints and DELIBERATELY left the two MERGE ones --
// merges_entity_type_allowed and merge_candidates_entity_type_allowed, the
// fourth copy that header did not know about -- at five, because events are
// not dedup-screened and not mergeable at MVP. So there are two TypeScript
// mirrors now: CUSTOM_FIELD_ENTITY_TYPES (six) and MERGE_ENTITY_TYPES (five),
// and each group of constraints is asserted against its own.
//
// Getting either wrong turns this red naming the file, in both directions.
// Nobody has to have read a comment.
//
// READ OUT OF THE LIVE CATALOGUE (pg_get_constraintdef), not out of the
// migration text: a later migration could drop and re-add a constraint, and
// what is deployed is what decides. Same reasoning as
// tests/integration/entitlements/tiers-match-db.test.ts reading
// subscription_plans rather than restating the seed.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { CUSTOM_FIELD_ENTITY_TYPES } from "@/lib/crm/custom-fields";
import { MERGE_ENTITY_TYPES } from "@/lib/crm/dedup";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * Every entity_type allowlist in `public`, split by which TypeScript list it
 * mirrors. FOUR, not the three 20260827232512 and FOLLOW-UPS.md name:
 * merge_candidates_entity_type_allowed was measured out of pg_constraint in
 * Phase 3 Task 1 and had never been written down anywhere.
 */
const CUSTOM_FIELD_CONSTRAINTS = [
  "custom_field_definitions_entity_type_allowed",
  "custom_field_values_entity_type_allowed",
] as const;

const MERGE_CONSTRAINTS = [
  "merges_entity_type_allowed",
  "merge_candidates_entity_type_allowed",
] as const;

const CONSTRAINTS = [
  ...CUSTOM_FIELD_CONSTRAINTS,
  ...MERGE_CONSTRAINTS,
] as const;

/**
 * The quoted literals in a CHECK definition, in the order they appear.
 *
 * `pg_get_constraintdef` renders the allowlist as
 *   CHECK ((entity_type = ANY (ARRAY['company'::text, 'contact'::text, ...])))
 * so the values are exactly the single-quoted runs. Deliberately blunt: if the
 * rendering ever changes shape, this test fails loudly rather than matching
 * nothing and passing.
 */
function literals(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe("the entity-type allowlist agrees across every copy", () => {
  it("finds all four constraints at all, so this cannot pass vacuously", async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `select c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and c.conname = any($1::text[])`,
      [CONSTRAINTS],
    );
    expect(rows.map((r) => r.conname).sort()).toEqual([...CONSTRAINTS].sort());
  });

  const GROUPS = [
    {
      label: "CUSTOM_FIELD_ENTITY_TYPES in lib/crm/custom-fields.ts",
      constraints: CUSTOM_FIELD_CONSTRAINTS,
      list: CUSTOM_FIELD_ENTITY_TYPES as readonly string[],
    },
    {
      label: "MERGE_ENTITY_TYPES in lib/crm/dedup.ts",
      constraints: MERGE_CONSTRAINTS,
      list: MERGE_ENTITY_TYPES as readonly string[],
    },
  ] as const;

  it("the two lists really do differ, or this file asserts one thing twice", () => {
    // THE CONTROL FOR THE SPLIT ITSELF. Before Phase 3 Task 1 these were the
    // same object, and every assertion below would pass against a codebase
    // that had quietly re-aliased them -- including one that widened `merges`
    // to six, which is the product decision 20260901001000 § (c) refuses.
    expect([...CUSTOM_FIELD_ENTITY_TYPES].sort()).not.toEqual(
      [...MERGE_ENTITY_TYPES].sort(),
    );
    expect(CUSTOM_FIELD_ENTITY_TYPES).toContain("event");
    expect(MERGE_ENTITY_TYPES).not.toContain("event");
  });

  for (const group of GROUPS) {
    for (const conname of group.constraints) {
      it(`${conname} lists exactly ${group.label.split(" ")[0]}`, async () => {
        const { rows } = await pool.query<{ def: string }>(
          `select pg_get_constraintdef(c.oid) as def
             from pg_constraint c
             join pg_class t on t.oid = c.conrelid
             join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'public' and c.conname = $1`,
          [conname],
        );
        expect(rows, `${conname} not found`).toHaveLength(1);

        // Sorted, because the constraint's order is a migration detail and the
        // TypeScript list's order is a UI one (it decides the tab strip). What
        // has to match is the SET.
        const inSql = literals(rows[0].def)
          .filter((value) => value !== "text")
          .sort();
        expect(
          inSql,
          `${conname} and ${group.label} disagree. The custom-field pair ` +
            "carries six values and the merge pair carries five; they stopped " +
            "being one list in 20260901001000, because events are not " +
            "mergeable at MVP. Widening the merge pair is a PRODUCT decision, " +
            "not a fix for this failure.",
        ).toEqual([...group.list].sort());
      });
    }
  }

  // THE DISPATCH CHECK THAT USED TO LIVE HERE MOVED, AND WAS WIDENED.
  //
  // It asserted that entity_is_visible / entity_is_manageable / entity_is_live
  // each carry a `when '<type>'` arm for every CUSTOM_FIELD_ENTITY_TYPES
  // value. Phase 3 Task 1 replaced it with
  // tests/integration/crm/entity-dispatch-branches-match-db.test.ts, which is
  // strictly stronger in three ways it needs to be:
  //
  //   * it enumerates ALL SIX `case p_entity_type` dispatches out of the
  //     catalogue rather than the three named here -- entity_org_unchanged,
  //     dedup_entity_table and dedup_mergeable_columns were invisible to this
  //     assertion, and the first of those carries twelve arms;
  //   * it asserts the EXACT arm set per function, so a branch that must NOT
  //     be there (an 'event' arm in dedup_entity_table, which would make
  //     events mergeable in contradiction of 20260901001000 § (c)) is red too;
  //   * it asserts that the set of dispatches it FOUND equals the set it
  //     expects, so a seventh one added by a later phase fails rather than
  //     being silently skipped.
  //
  // It could not be extended in place: `entity_is_manageable` does not get its
  // 'event' arm until Phase 3 Task 2 seeds `manage_events`, and a loop over
  // CUSTOM_FIELD_ENTITY_TYPES has no way to express a one-task interval. The
  // census file does, in one commented line.
});
