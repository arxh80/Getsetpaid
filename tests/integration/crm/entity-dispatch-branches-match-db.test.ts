// THE CENSUS OF EVERY POLYMORPHIC `case p_entity_type` DISPATCH IN `private`.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// FOLLOW-UPS.md § "Phase 3 -- events" says "'event' is missing from three
// entity_type allowlists AND from two policy helpers -- that is five places,
// not three." Both halves of that sentence were found BY HAND, once, and both
// were wrong on the low side. Measured out of the catalogue in Phase 3 Task 1:
// there are FOUR entity_type CHECK constraints, not three, and SIX dispatch
// functions, not two.
//
// Every one of them ends in `else false` (or, for the two dedup helpers, in a
// NULL). So an entity type with no branch is not an error -- it is a silent
// "no". That is the right failure direction and the worst possible discovery
// mechanism: it presents as an RLS bug months later, and the tempting fix
// (loosening a policy) reopens the cross-tenant hole the dispatch exists to
// close (SECURITY.md § 10).
//
// This test is what makes the omission red on the day it happens, and it is
// deliberately stronger than the assertion it replaced in
// custom-field-entity-types-match-db.test.ts in three ways:
//
//   1. IT ENUMERATES THE FUNCTIONS FROM THE CATALOGUE. The old one named three
//      functions in a literal and could not see the other three.
//   2. IT ASSERTS THE EXACT ARM SET, not "contains". Two of the six must NOT
//      have an 'event' arm -- see EXPECTED below -- and "contains" cannot
//      express that.
//   3. IT ASSERTS THAT WHAT IT FOUND EQUALS WHAT IT EXPECTS. A seventh
//      dispatch added by a later phase fails this test instead of being
//      skipped by it. That is the non-vacuity control, and without it the
//      whole file passes against a database in which the functions were
//      renamed.
//
// READ THROUGH pg_get_functiondef, NOT THE MIGRATION TEXT. Four of these six
// have been replaced by a later migration than the one that created them
// (entity_is_live by 20260829011000, entity_org_unchanged by 20260828140000,
// three of them again by 20260901001000), so the file that first defined a
// function is not what is deployed.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * The arm set each dispatch must carry, exactly.
 *
 * ORDER IS NOT ASSERTED -- both sides are sorted before comparison, because a
 * `case` arm's position is a readability choice and the set is the contract.
 */
const EXPECTED: Record<string, readonly string[]> = {
  entity_is_visible: [
    "company",
    "contact",
    "agency",
    "artist",
    "venue",
    "event",
  ],

  // NO 'event' YET, AND THAT IS AN INTERVAL RATHER THAN A DECISION.
  //
  // The event arm of this function needs the permission key `manage_events`,
  // which Phase 3 Task 2's migration 20260901010000 seeds. A key absent from
  // public.permissions is absent from the join inside
  // private.permitted_organisations(), so the branch would fail closed and
  // "work" -- but a test asserting it would be asserting a coincidence rather
  // than a control. 20260901001000's header § (d) records the split.
  //
  // PHASE 3 TASK 2 ADDS "event" TO THIS LINE, in the same commit as the
  // migration that seeds the key and adds the arm. If this line still has five
  // values after 20260901010000 has been applied, the arm was forgotten.
  entity_is_manageable: ["company", "contact", "agency", "artist", "venue"],

  entity_is_live: ["company", "contact", "agency", "artist", "venue", "event"],

  // TWELVE. This one is NOT keyed on CRM entity types alone -- 20260828140000
  // (IMP-3) added the five child/join tables that carry an UPDATE policy,
  // named after the TABLE rather than after an entity type, plus
  // custom_field_definition for organisation configuration. FOLLOW-UPS.md and
  // the Task 1 brief both listed seven; the live catalogue said eleven before
  // this phase and says twelve after.
  //
  // `event_lineup` is NOT here: it has no UPDATE policy until Phase 3 Task 2,
  // and 20260901010000 adds the arm and the policy together for the same
  // reason entity_is_manageable's event arm waits.
  entity_org_unchanged: [
    "company",
    "contact",
    "agency",
    "artist",
    "venue",
    "event",
    "custom_field_definition",
    "contact_company",
    "artist_representation",
    "artist_fee",
    "venue_room",
    "custom_field_value",
  ],

  // DELIBERATELY WITHOUT 'event' -- events are not mergeable in Phase 3.
  //
  // 20260829020000's DECISION 1 makes a name a FUZZY signal only; a recurring
  // club night shares its name with every previous instalment BY DESIGN; and
  // public.events has no email column, so `exact_email` -- the only branch
  // that can ever auto-merge -- is unreachable for events by construction.
  // Widening `merges` without a reachable merge path would ship a permission
  // the product can never exercise.
  //
  // See 20260901001000's header § (c), the comments on
  // merges_entity_type_allowed and private.dedup_entity_table() in the
  // database, and FOLLOW-UPS.md § "Phase 3 -- events". CHANGING EITHER OF
  // THESE TWO LINES IS A PRODUCT DECISION, not a fix for a red test.
  dedup_entity_table: ["company", "contact", "agency", "artist", "venue"],
  dedup_mergeable_columns: ["company", "contact", "agency", "artist", "venue"],
};

/**
 * Every `when '<literal>' then` arm in a function definition, in order.
 *
 * Matches on the `when '...' then` shape rather than on every quoted run,
 * because these bodies also contain quoted permission keys
 * (`permitted_organisations('view_crm')`) and quoted table names, and a blunt
 * literal scrape would collect those too.
 */
function arms(definition: string): string[] {
  return [...definition.matchAll(/when\s+'([^']*)'\s+then/gi)].map((m) => m[1]);
}

async function dispatches(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ proname: string; def: string }>(
    `select p.proname, pg_get_functiondef(p.oid) as def
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private'
        and p.prokind = 'f'
        and pg_get_functiondef(p.oid) like '%case p_entity_type%'`,
  );
  return new Map(rows.map((r) => [r.proname, r.def]));
}

describe("every polymorphic entity_type dispatch has exactly the arms it should", () => {
  it("the set of dispatches in `private` is exactly the set expected", async () => {
    // THE NON-VACUITY CONTROL, and the reason this file is a census rather
    // than a list of assertions. A seventh dispatch added by a later phase --
    // or one of these six renamed, or its `case p_entity_type` reshaped so the
    // catalogue query stops matching it -- fails HERE, loudly, rather than
    // being quietly skipped by the per-function assertions below.
    const found = [...(await dispatches()).keys()].sort();
    expect(
      found,
      "A `case p_entity_type` dispatch in `private` is missing from, or " +
        "absent from, EXPECTED in this file. Every one of these functions " +
        "ends in `else false`, so an entity type with no branch is a silent " +
        "no -- add the new function here with its intended arm set before " +
        "shipping it.",
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  it("finds six of them, so a catalogue query that matched nothing is red", async () => {
    // Belt and braces on the assertion above: `toEqual([] , [])` cannot happen
    // while EXPECTED is non-empty, but a future edit that empties EXPECTED
    // would make this file pass against a database with no dispatches at all.
    expect((await dispatches()).size).toBe(6);
  });

  for (const [proname, expected] of Object.entries(EXPECTED)) {
    it(`private.${proname}() carries exactly its expected arms`, async () => {
      const def = (await dispatches()).get(proname);
      expect(def, `private.${proname}() not found in the catalogue`).toBeDefined();

      expect(
        arms(def as string).sort(),
        `private.${proname}()'s \`when '<type>' then\` arms and this file's ` +
          "EXPECTED disagree. A MISSING arm means every value of that type is " +
          "silently unreachable (the function ends in `else false`). An EXTRA " +
          "arm on dedup_entity_table or dedup_mergeable_columns means events " +
          "became mergeable, which is a product decision -- see " +
          "20260901001000's header § (c).",
      ).toEqual([...expected].sort());
    });
  }

  it("the two dedup helpers really refuse 'event' at runtime, not just in text", async () => {
    // THE BEHAVIOURAL HALF of the refusal. The arm comparison above is about
    // the function's SOURCE; this asks the deployed function.
    //
    // THE TWO FALL BACK DIFFERENTLY, WHICH WAS MEASURED HERE RATHER THAN
    // ASSUMED -- the first draft of this assertion expected NULL from both and
    // was wrong about the second. dedup_entity_table's `else` is NULL, which
    // makes format() produce NULL and the dynamic statement in
    // private.duplicate_probe() / public.merge_records() fail rather than
    // execute something. dedup_mergeable_columns' `else` is
    // `array[]::text[]` -- an EMPTY array, not NULL -- so a merge of an
    // unknown type would build an empty SET list rather than a NULL one. It
    // never gets that far, because the table name is NULL first, but the
    // difference is real and is asserted as it is rather than as it ought to
    // be.
    const { rows } = await pool.query<{ tbl: string | null; cols: string[] | null }>(
      `select private.dedup_entity_table('event') as tbl,
              private.dedup_mergeable_columns('event') as cols`,
    );
    expect(rows[0].tbl).toBeNull();
    expect(rows[0].cols).toEqual([]);
  });

  it("...and the paired positive control: 'contact' still resolves", async () => {
    // Without this the assertion above passes against two functions that
    // return NULL for everything -- which would break every merge in the
    // product and look, from there, exactly the same.
    const { rows } = await pool.query<{ tbl: string; cols: string[] }>(
      `select private.dedup_entity_table('contact') as tbl,
              private.dedup_mergeable_columns('contact') as cols`,
    );
    expect(rows[0].tbl).toBe("contacts");
    expect(rows[0].cols.length).toBeGreaterThan(0);
  });

  it("entity_is_live and entity_org_unchanged answer for a real event row", async () => {
    // THE BEHAVIOURAL HALF of the widening. The arm comparison proves the text
    // is there; this proves the branch resolves against public.events rather
    // than against a copy-pasted `public.venues`, which would leave the arm
    // present and the answer wrong.
    //
    // TWO OF THE THREE WIDENED FUNCTIONS, NOT ALL THREE, AND THE OMISSION IS
    // DELIBERATE: private.entity_is_visible() carries a permission term
    // (`view_crm`) and a record-scope term, both of which read auth.uid(),
    // which is NULL for `postgres`. Driven from here it would answer false for
    // every entity type including the five that have worked since Phase 2, so
    // a `false` would prove nothing about the event arm. That function is
    // exercised through a real session in supabase/tests/rls_phase2_crm.sql
    // § E, and Phase 3 Task 2 -- which ships the policies that call it with
    // 'event' -- owns adding the event case there.
    //
    // Everything below runs as `postgres` inside a rolled-back transaction.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into public.organisations (id, name, slug)
         values ('ee220000-0000-0000-0000-0000000000e1', 'Dispatch Org', 'dispatch-org')`,
      );
      await client.query(
        `insert into public.events (id, organisation_id, name, starts_at)
         values ('ee330000-0000-0000-0000-0000000000e1',
                 'ee220000-0000-0000-0000-0000000000e1', 'Dispatch Event', now())`,
      );

      const live = await client.query<{ ok: boolean }>(
        `select private.entity_is_live(
           'event', 'ee330000-0000-0000-0000-0000000000e1',
           'ee220000-0000-0000-0000-0000000000e1') as ok`,
      );
      expect(live.rows[0].ok).toBe(true);

      // Soft-delete it: entity_is_live must flip, which proves the branch is
      // reading THIS table's deleted_at and not returning a constant.
      await client.query(
        `update public.events set deleted_at = now()
          where id = 'ee330000-0000-0000-0000-0000000000e1'`,
      );
      const dead = await client.query<{ ok: boolean }>(
        `select private.entity_is_live(
           'event', 'ee330000-0000-0000-0000-0000000000e1',
           'ee220000-0000-0000-0000-0000000000e1') as ok`,
      );
      expect(dead.rows[0].ok).toBe(false);

      // entity_org_unchanged does not consult deleted_at, and must still say
      // yes for the right organisation and no for a different one.
      const unchanged = await client.query<{ same: boolean; other: boolean }>(
        `select private.entity_org_unchanged(
                  'event', 'ee330000-0000-0000-0000-0000000000e1',
                  'ee220000-0000-0000-0000-0000000000e1') as same,
                private.entity_org_unchanged(
                  'event', 'ee330000-0000-0000-0000-0000000000e1',
                  '00000000-0000-0000-0000-000000000000') as other`,
      );
      expect(unchanged.rows[0].same).toBe(true);
      expect(unchanged.rows[0].other).toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
