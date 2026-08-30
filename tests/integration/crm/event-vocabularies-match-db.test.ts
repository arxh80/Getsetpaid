// THE TWO EVENT VOCABULARIES, WRITTEN TWICE, BOUND HERE.
//
// `events_status_check` and `events_event_type_check`
// (supabase/migrations/20260901000000_events_and_lineup.sql) are the
// enforcement. `EVENT_STATUSES` and `EVENT_TYPES` in lib/crm/event-status.ts
// are the copy the create/edit form's <select> and the `?status=` filter read,
// because a request cannot consult a CHECK constraint.
//
// WHAT DRIFT COSTS, in each direction:
//
//   a value in SQL and not in TypeScript   a row the database holds happily
//                                          that no form can produce and no
//                                          filter can select -- invisible
//                                          until a support ticket.
//   a value in TypeScript and not in SQL   a <select> option that raises
//                                          23514 on submit. The user picked a
//                                          legal-looking value and got an
//                                          error with no field attached.
//
// READ OUT OF THE LIVE CATALOGUE (pg_get_constraintdef), not out of the
// migration text: a later migration can drop and re-add a constraint, and what
// is deployed is what decides. Same treatment, and the same reasoning, as
// tests/integration/crm/custom-field-entity-types-match-db.test.ts and
// tests/integration/entitlements/tiers-match-db.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { EVENT_STATUSES, EVENT_TYPES } from "@/lib/crm/event-status";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * The quoted literals in a CHECK definition, in the order they appear.
 *
 * `pg_get_constraintdef` renders an `in (...)` allowlist as
 *   CHECK ((status = ANY (ARRAY['draft'::text, 'planned'::text, ...])))
 * so the values are exactly the single-quoted runs, with the `text` casts
 * filtered out. Deliberately blunt: if the rendering ever changes shape this
 * fails loudly rather than matching nothing and passing.
 */
function literals(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((value) => value !== "text");
}

async function constraintDef(conname: string): Promise<string | null> {
  const { rows } = await pool.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'events'
        and c.conname = $1`,
    [conname],
  );
  return rows.length === 1 ? rows[0].def : null;
}

const CASES = [
  {
    conname: "events_status_check",
    constant: "EVENT_STATUSES",
    values: EVENT_STATUSES as readonly string[],
  },
  {
    conname: "events_event_type_check",
    constant: "EVENT_TYPES",
    values: EVENT_TYPES as readonly string[],
  },
] as const;

describe("the event vocabularies agree with their CHECK constraints", () => {
  it("finds both constraints on public.events, so this cannot pass vacuously", async () => {
    // The names are Postgres' own, generated from `<table>_<column>_check` for
    // the inline column CHECKs. Asserted as a set rather than looked up one at
    // a time, so a constraint that was renamed (or attached to the wrong
    // table) fails here rather than making the two comparisons below silently
    // skip.
    const { rows } = await pool.query<{ conname: string }>(
      `select c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'events'
          and c.conname = any($1::text[])`,
      [CASES.map((c) => c.conname)],
    );
    expect(rows.map((r) => r.conname).sort()).toEqual(
      CASES.map((c) => c.conname).sort(),
    );
  });

  for (const { conname, constant, values } of CASES) {
    it(`${conname} lists exactly ${constant}`, async () => {
      const def = await constraintDef(conname);
      expect(def, `${conname} not found on public.events`).not.toBeNull();

      // Sorted, because the constraint's order is a migration detail and the
      // TypeScript tuple's order is a UI one -- it decides the order of the
      // <select> options. What has to match is the SET.
      expect(
        literals(def as string).sort(),
        `${conname} and ${constant} in lib/crm/event-status.ts disagree. A ` +
          "value in only one of them is either a row no form can create or a " +
          "form option that raises 23514 on submit.",
      ).toEqual([...values].sort());
    });
  }

  it("the CHECK definitions really contain literals, not zero of them", async () => {
    // NON-VACUITY. `literals()` returning [] for both would make the two
    // assertions above compare [] against [] only if the TypeScript tuples
    // were also empty -- but a THIRD failure mode passes them: a rendering
    // change that produces no quoted runs at all would make both sides []
    // ONLY if the constants were emptied in the same change. This asserts the
    // SQL side is non-empty on its own terms, which is the half the
    // comparison cannot check about itself.
    for (const { conname } of CASES) {
      const def = await constraintDef(conname);
      expect(literals(def as string).length, conname).toBeGreaterThan(1);
    }
  });

  it("every status and type is actually insertable, and nothing else is", async () => {
    // THE BEHAVIOURAL HALF. The comparisons above are about TEXT: they would
    // both pass against a CHECK whose rendering listed the right values while
    // the constraint expression did something else (a `<>` instead of a `=`, a
    // second ANDed clause). This drives the constraint.
    //
    // Everything happens inside one transaction that is rolled back, and as
    // `postgres`, so no policy is in play -- the claim under test is the
    // CONSTRAINT, which binds every writer regardless of role.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into public.organisations (id, name, slug)
         values ('ee110000-0000-0000-0000-0000000000e1', 'Vocab Org', 'vocab-org')`,
      );

      for (const status of EVENT_STATUSES) {
        await expect(
          client.query(
            `insert into public.events (organisation_id, name, starts_at, status)
             values ('ee110000-0000-0000-0000-0000000000e1', $1, now(), $2)`,
            [`Status ${status}`, status],
          ),
          `status '${status}' is in EVENT_STATUSES but events_status_check refuses it`,
        ).resolves.toBeDefined();
      }

      for (const type of EVENT_TYPES) {
        await expect(
          client.query(
            `insert into public.events (organisation_id, name, starts_at, event_type)
             values ('ee110000-0000-0000-0000-0000000000e1', $1, now(), $2)`,
            [`Type ${type}`, type],
          ),
          `event_type '${type}' is in EVENT_TYPES but events_event_type_check refuses it`,
        ).resolves.toBeDefined();
      }

      // The paired negative. Without it every assertion above is satisfied by
      // a CHECK that was dropped: a table with no constraint accepts all eight
      // statuses AND accepts 'not_a_status'.
      await expect(
        client.query(
          `insert into public.events (organisation_id, name, starts_at, status)
           values ('ee110000-0000-0000-0000-0000000000e1', 'Bad', now(), 'not_a_status')`,
        ),
        "events_status_check accepted a value outside EVENT_STATUSES -- the " +
          "constraint is gone, and the comparisons above are vacuous",
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback");
      await client.query("begin");
      await client.query(
        `insert into public.organisations (id, name, slug)
         values ('ee110000-0000-0000-0000-0000000000e2', 'Vocab Org 2', 'vocab-org-2')`,
      );
      await expect(
        client.query(
          `insert into public.events (organisation_id, name, starts_at, event_type)
           values ('ee110000-0000-0000-0000-0000000000e2', 'Bad', now(), 'not_a_type')`,
        ),
        "events_event_type_check accepted a value outside EVENT_TYPES",
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
