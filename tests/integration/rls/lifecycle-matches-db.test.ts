// THE BINDING BETWEEN THE TWO HALVES OF THE ORGANISATION LIFECYCLE.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// Phase 7 Task 3 has a half in SQL (20260908030000: the four lifecycle
// columns, their CHECK, private.organisation_retention_days()) and a half in
// TypeScript (lib/admin/lifecycle-contract.ts: ORGANISATION_RETENTION_DAYS,
// OrganisationLifecycleState, lifecycleLabel). The two describe ONE rule, and
// their disagreement fails in two directions, both of them quiet:
//
//   TYPESCRIPT SAYS 60, SQL SAYS 30   the suspended workspace's banner counts
//                                     down to a date thirty days after the one
//                                     the database will actually act on. The
//                                     customer plans around it. Nothing errors.
//   SQL GROWS A STATE TYPESCRIPT      lifecycleLabel()'s switch is exhaustive
//   HAS NEVER HEARD OF                over the union, so a state added only in
//                                     SQL renders as nothing at all -- an
//                                     unlabelled workspace in the operator's
//                                     list and a banner that says a workspace
//                                     is "" .
//
// The repo's answer to that class of problem is the `*-matches-db.test.ts`
// pattern (crm-write-access, past-due-grace, network-access, impersonation),
// and the pattern's rule is the load-bearing part: THE EXPECTATION IS READ OUT
// OF A REAL POSTGRES, never restated as a second literal here. A test
// comparing 60 to a hardcoded 60 would stay green on the day somebody changed
// the migration and forgot the constant, which is the whole drift it exists to
// catch.
//
// A DIRECT POSTGRES CONNECTION, not PostgREST, because the SQL half lives in
// `private` -- which supabase/config.toml does not expose, deliberately.
// Publishing an RPC that returns 60 so a test could reach it would be adding
// API surface to make testing easier.
//
// LOCAL ONLY, same discipline as every other file in tests/integration:
// getLocalSupabaseStatus() refuses anything that is not the loopback stack.
// Nothing here plants a fixture or writes a row -- every query reads the
// catalog or a pure function -- so there is no rollback to do.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "./support/env";
import {
  ORGANISATION_RETENTION_DAYS,
  WOUND_DOWN_STATES,
  isWoundDown,
  lifecycleLabel,
  type OrganisationLifecycleState,
} from "@/lib/admin/lifecycle-contract";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

describe("the 60-day retention window is the same number in TypeScript and in SQL", () => {
  it("private.organisation_retention_days() equals ORGANISATION_RETENTION_DAYS", async () => {
    const { rows } = await pool.query<{ days: number }>(
      "select private.organisation_retention_days() as days",
    );

    expect(rows).toHaveLength(1);
    expect(
      Number(rows[0].days),
      "private.organisation_retention_days() vs ORGANISATION_RETENTION_DAYS",
    ).toBe(ORGANISATION_RETENTION_DAYS);
  });

  // EQUAL CONSTANTS INSIDE UNEQUAL ARITHMETIC WOULD STILL BE DRIFT --
  // past-due-grace-matches-db.test.ts's lesson, applied here. The database
  // stamps `lifecycle_changed_at + N days`; this asserts the interval that
  // actually results, rather than the integer that goes into it.
  it("the stamped interval really is that many days", async () => {
    const { rows } = await pool.query<{ days: number }>(
      `select extract(day from
                (now() + make_interval(days => private.organisation_retention_days()))
                - now())::int as days`,
    );
    expect(Number(rows[0].days)).toBe(ORGANISATION_RETENTION_DAYS);
  });
});

describe("the lifecycle states are the same set in TypeScript and in SQL", () => {
  /** The states the CHECK constraint admits, read out of the catalog. */
  async function statesInDatabase(): Promise<string[]> {
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname = 'organisations_lifecycle_state_known'`,
    );
    expect(rows, "the CHECK constraint exists at all").toHaveLength(1);
    return [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
  }

  it("every state the database admits has a label in TypeScript", async () => {
    const states = await statesInDatabase();
    expect(states.length, "a sanity floor on the parse").toBeGreaterThan(1);

    for (const state of states) {
      const label = lifecycleLabel(state as OrganisationLifecycleState);
      expect(label, `lifecycleLabel(${state})`).toBeTruthy();
      expect(label, `lifecycleLabel(${state}) must not be the raw key`).not.toBe(state);
    }
  });

  it("and TypeScript invents no state the database would reject", async () => {
    const states = await statesInDatabase();
    const inTypeScript = ["active", ...WOUND_DOWN_STATES].sort();
    expect(inTypeScript, "OrganisationLifecycleState vs the CHECK constraint").toEqual(
      states,
    );
  });

  it("isWoundDown() covers exactly the non-active states the database admits", async () => {
    const states = await statesInDatabase();
    expect(
      states.filter((s) => isWoundDown(s as OrganisationLifecycleState)).sort(),
      "isWoundDown() vs the CHECK constraint's non-active states",
    ).toEqual([...WOUND_DOWN_STATES].sort());
  });

  it("and the database still ties 'active' to deleted_at, which is what makes that safe", async () => {
    // THE INVARIANT ITSELF. `deleted_at is not null` is the single predicate
    // thirty-odd permission gates read to mean read-only, and the reason it is
    // safe to leave them all reading one column is that this constraint makes
    // "wound down" and "read-only" the same set of rows. If it were ever
    // dropped, isWoundDown() and the write gates would start answering
    // different questions about the same workspace -- so the assertion is
    // about the constraint existing in the right SHAPE, read out of the
    // catalog rather than restated here.
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname = 'organisations_lifecycle_matches_deleted_at'`,
    );
    expect(rows, "the biconditional CHECK exists").toHaveLength(1);
    const def = rows[0].def.replace(/\s+/g, " ");
    expect(def, "must relate lifecycle_state to deleted_at").toMatch(/lifecycle_state/);
    expect(def).toMatch(/deleted_at IS NULL/i);
    // An equality between the two predicates, not merely a mention of both:
    // `(a = 'active') = (deleted_at IS NULL)` is the biconditional, and a
    // one-directional `a <> 'active' OR deleted_at IS NULL` would not be.
    expect(def, "must be a biconditional, not a one-way implication").toMatch(
      /=\s*\(deleted_at IS NULL\)/i,
    );
  });
});

describe("the sanctioned-path marker is not reachable from a client role", () => {
  // The marker is what stops organisations_update_platform_lifecycle from also
  // permitting a raw, un-audited PATCH. It is only safe because `private` is
  // not an exposed schema -- so this asserts the property the safety rests on,
  // rather than trusting a config file to stay as it is.
  it("private.begin_lifecycle_transition() lives in an unexposed schema", async () => {
    const { rows } = await pool.query<{ nspname: string }>(
      `select n.nspname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'begin_lifecycle_transition'`,
    );
    expect(rows, "the function exists").toHaveLength(1);
    expect(rows[0].nspname, "must not be in `public`, which PostgREST publishes").toBe(
      "private",
    );
  });

  it("the three lifecycle RPCs are SECURITY INVOKER, so the policy is the enforcement", async () => {
    const { rows } = await pool.query<{ proname: string; prosecdef: boolean }>(
      `select p.proname, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('suspend_organisation','delete_organisation','reinstate_organisation')
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "delete_organisation",
      "reinstate_organisation",
      "suspend_organisation",
    ]);
    for (const row of rows) {
      // SECURITY DEFINER here would bypass RLS and make
      // organisations_update_platform_lifecycle dead code -- present, asserted
      // structurally by the psql suite, and never once evaluated on a real
      // transition.
      expect(row.prosecdef, `${row.proname} must be SECURITY INVOKER`).toBe(false);
    }
  });
});
