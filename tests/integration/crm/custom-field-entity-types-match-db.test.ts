// THE FOURTH COPY OF THE ENTITY-TYPE LIST, AND THE TRIPWIRE THAT FINDS IT.
//
// 20260827232512's header is explicit that the five-value allowlist is
// duplicated across three CHECK constraints -- custom_field_definitions,
// custom_field_values and merges -- rather than shared, and why:
//
//     "Phase 3 adds 'event' to all three, and having to touch three
//      constraints is the reminder that three code paths change too."
//
// Task 5 adds a FOURTH copy, in TypeScript: CUSTOM_FIELD_ENTITY_TYPES in
// lib/crm/custom-fields.ts, which the definition editor's tab strip and the
// `?entity=` validation both read. It exists because neither can consult a
// CHECK constraint at request time.
//
// THIS FILE IS HOW A PHASE 3 DEVELOPER FINDS IT. Adding 'event' to the three
// constraints and not to the TypeScript list turns this red naming the file;
// adding it to the TypeScript list and not to the constraints turns it red the
// other way. Nobody has to have read a comment.
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

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/** The three constraints the migration header names, and nothing else. */
const CONSTRAINTS = [
  "custom_field_definitions_entity_type_allowed",
  "custom_field_values_entity_type_allowed",
  "merges_entity_type_allowed",
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

describe("the entity-type allowlist agrees across all four copies", () => {
  it("finds all three constraints at all, so this cannot pass vacuously", async () => {
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

  for (const conname of CONSTRAINTS) {
    it(`${conname} lists exactly CUSTOM_FIELD_ENTITY_TYPES`, async () => {
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
        `${conname} and CUSTOM_FIELD_ENTITY_TYPES in lib/crm/custom-fields.ts ` +
          "disagree. Phase 3 adds 'event' to THREE constraints and to that " +
          "TypeScript list -- this is the fourth copy the migration header " +
          "warns about.",
      ).toEqual([...CUSTOM_FIELD_ENTITY_TYPES].sort());
    });
  }

  it("the polymorphic dispatch functions have a branch for every type", async () => {
    // A fifth place the list is effectively written down, and the one whose
    // omission is SILENT: private.entity_is_visible / entity_is_manageable /
    // entity_is_live end in `else false`, so an entity type with no branch
    // makes every value of that type unreadable and unwritable rather than
    // erroring. 20260828120500's comment says exactly this and asks Phase 3 to
    // edit the file; this is what makes forgetting it red.
    const { rows } = await pool.query<{ proname: string; src: string }>(
      `select p.proname, p.prosrc as src
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname in ('entity_is_visible', 'entity_is_manageable', 'entity_is_live')`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
      "entity_is_live",
      "entity_is_manageable",
      "entity_is_visible",
    ]);
    for (const row of rows) {
      for (const type of CUSTOM_FIELD_ENTITY_TYPES) {
        expect(
          row.src,
          `private.${row.proname}() has no branch for '${type}', so every ` +
            `${type} custom field value is silently unreachable (else false).`,
        ).toContain(`when '${type}'`);
      }
    }
  });
});
