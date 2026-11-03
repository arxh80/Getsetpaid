// THE BINDING BETWEEN THE RETENTION DECLARATION AND THE ONE NUMBER THAT LEFT
// THE DATABASE.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// Phase 8 Task 6 puts every retention period in ONE declared place --
// private.retention_periods() (20261003000000) -- precisely so that counsel's
// answer to Q133 is a reissue of one function and not a hunt. That only holds
// while nothing restates a period somewhere else.
//
// ONE THING DOES, and it has to: Q135's audit-log viewer default range. The
// viewer applies its lower bound in TypeScript, on a PostgREST query, so it
// cannot call private.retention_period('audit_hot') -- `private` is not an
// exposed schema, deliberately, and publishing an RPC that returns 30 so a
// page could read it would be adding API surface to avoid a test.
//
// So AUDIT_HOT_WINDOW_DAYS is a second copy of one number, and this is the
// binding: the `*-matches-db.test.ts` pattern (crm-write-access,
// past-due-grace, network-access, impersonation, lifecycle -- this is the
// sixth), whose load-bearing rule is that THE EXPECTATION IS READ OUT OF A
// REAL POSTGRES and never restated as a second literal here.
//
// What drift would cost, in each direction, both quiet:
//   TYPESCRIPT SAYS 30, SQL SAYS 7   the founder reads "showing the last 30
//                                    days" over a query bounded at a week
//                                    (or, after this file, the reverse) --
//                                    a sentence on the operator's own audit
//                                    surface that is not true.
//   SQL SAYS 90, TYPESCRIPT SAYS 30  two months of rows the viewer calls
//                                    archived while the product's own
//                                    documentation calls them hot.
//
// IT ALSO ASKS THE DERIVATION FROM OUTSIDE. private.assert_retention_roll()
// is the thing standing between "a later phase added a table" and "a table
// nobody retains"; it runs at step 0 of every sweep, where a failure is a
// failed job at three in the morning. Asking it here means the failure is a
// red test at the moment the table is added, which is when somebody can
// answer it.
//
// LOCAL ONLY, same discipline as every other file in tests/integration.
// Nothing here writes a row.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "./support/env";
import { AUDIT_HOT_WINDOW_DAYS } from "@/lib/admin/audit-log";
import { ORGANISATION_RETENTION_DAYS } from "@/lib/admin/lifecycle-contract";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function periodDays(className: string): Promise<number> {
  const { rows } = await pool.query<{ days: string }>(
    `select extract(epoch from private.retention_period($1)) / 86400 as days`,
    [className],
  );
  return Number(rows[0].days);
}

describe("the retention declaration and its TypeScript copies", () => {
  it("DENOMINATOR: the declaration is there and is not empty", async () => {
    const { rows } = await pool.query<{ n: string; classes: string }>(
      `select count(*)::text as n, string_agg(class, ',' order by class) as classes
         from private.retention_periods()`,
    );
    // Eleven at 190 migrations. A floor rather than an equality, so adding a
    // class is not a failing test -- but a derivation that resolved NOTHING
    // would make every assertion below pass on an empty set, which is this
    // phase's recurring bug and the reason this `it` is first.
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(11);
    for (const required of [
      "audit_hot",
      "audit_total",
      "workspace",
      "feedback",
      "financial",
      "operational",
    ]) {
      expect(rows[0].classes.split(",")).toContain(required);
    }
  });

  it("AUDIT_HOT_WINDOW_DAYS is the database's `audit_hot` period (Q135)", async () => {
    expect(AUDIT_HOT_WINDOW_DAYS).toBe(await periodDays("audit_hot"));
  });

  it("ORGANISATION_RETENTION_DAYS is still the database's `workspace` period", async () => {
    // lifecycle-matches-db.test.ts binds this to
    // private.organisation_retention_days(); this binds it to the
    // DECLARATION that function now derives from, so the rebuild in
    // 20261003000000 § 5 cannot have quietly changed the answer.
    expect(ORGANISATION_RETENTION_DAYS).toBe(await periodDays("workspace"));
  });

  it("the audit purge's hard floor is at least the declared total period", async () => {
    // Stated from outside, because inside the purge it is two comparisons
    // against two sources and a reader should be able to check the result
    // rather than the argument.
    const { rows } = await pool.query<{ ok: boolean }>(
      `select private.retention_period('audit_total') >= private.audit_retention_floor() as ok`,
    );
    expect(rows[0].ok).toBe(true);
  });

  it("the hot window is inside the total period, or 'archived' means nothing", async () => {
    expect(await periodDays("audit_hot")).toBeLessThan(await periodDays("audit_total"));
  });

  it("every table in `public` is classified, asked from outside the job", async () => {
    // The refusal this replaces would otherwise first be seen by a scheduled
    // sweep, at three in the morning, with nobody to answer it.
    await expect(pool.query(`select private.assert_retention_roll()`)).resolves.toBeTruthy();

    const { rows } = await pool.query<{ unclassified: string | null }>(
      `select string_agg(t, ', ' order by t) as unclassified
         from private.unclassified_retention_subjects() t`,
    );
    expect(rows[0].unclassified).toBeNull();
  });

  it("and the roll is exactly the catalogue -- same size, no duplicates", async () => {
    // The catalogue is counted HERE from pg_class, not through
    // private.retention_roll_relations(), so this stays a second opinion on
    // that derivation. Its scope is the roll's own since 20261004005000
    // (review finding m1): ordinary, partitioned AND materialized relations in
    // `public` AND `private`. As first written this counted `public` r/p only,
    // which agreed only while `private` held no table; 20261016000000's
    // private.notification_deliveries (classified `cascades`) was the first,
    // and made the roll one longer than this undercounted catalogue.
    const { rows } = await pool.query<{ tables: string; roll: string; distinct_roll: string }>(
      `select (select count(*)::text from pg_class
                where relnamespace in ('public'::regnamespace, 'private'::regnamespace)
                  and relkind in ('r','p','m')) as tables,
              (select count(*)::text from private.retention_subjects()) as roll,
              (select count(distinct table_name)::text from private.retention_subjects()) as distinct_roll`,
    );
    expect(rows[0].roll).toBe(rows[0].tables);
    expect(rows[0].distinct_roll).toBe(rows[0].roll);
  });
});
