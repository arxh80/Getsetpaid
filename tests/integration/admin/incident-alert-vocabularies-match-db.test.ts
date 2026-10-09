// THE INCIDENT-ALERT VOCABULARIES, WRITTEN IN SQL AND MIRRORED IN TYPESCRIPT,
// BOUND HERE.
//
// FIX ROUND 2, RE-REVIEW FINDING M-R6. `task-3-report.md` claimed the psql
// suite "binds [lib/admin/health.ts's label] to the table's CHECK list". It
// did not, and nothing else did: the only assertion touching that constraint
// is DG13 in `rls_phase8_data_subject_requests.sql`, which reads
// `pg_get_constraintdef` and checks three names are PRESENT -- a subset test,
// in SQL, that cannot see TypeScript at all. A claimed binding that does not
// exist is worse than none, because the next person adds an alert type and
// trusts a guard that was never built. So the claim is now true.
//
// WHAT DRIFT COSTS, in each direction:
//
//   a type in SQL and not in TypeScript    an alert the database writes that
//                                          /super/health renders as its RAW
//                                          enum key, with no entry in the
//                                          "Alert type" filter -- so the
//                                          operator cannot narrow to the one
//                                          class of alert they came for. This
//                                          is exactly what would have happened
//                                          when 20260925002000 added the three
//                                          DSR types, had the same commit not
//                                          happened to add the labels too.
//   a type in TypeScript and not in SQL    a filter option that can never
//                                          match a row, because no writer can
//                                          produce that value.
//
// The same holds for the RESOLUTION REASONS (20260925002000, fix round 2's
// M-R7): those labels are what tell an operator a snooze from a closure, and
// a reason added without one reads "resolved automatically" with no detail.
//
// READ OUT OF THE LIVE CATALOGUE (pg_get_constraintdef), not out of the
// migration text: both constraints have already been dropped and re-added
// once, and what is deployed is what decides. Same treatment, and the same
// reasoning, as tests/integration/crm/event-vocabularies-match-db.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  INCIDENT_ALERT_AUTO_RESOLUTION_LABELS,
  INCIDENT_ALERT_TYPE_LABELS,
} from "@/lib/admin/health";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * The quoted literals in a CHECK definition, in the order they appear.
 *
 * `pg_get_constraintdef` renders an `in (...)` allowlist as
 *   CHECK ((alert_type = ANY (ARRAY['rate_limit_tripped'::text, ...])))
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
        and t.relname = 'incident_alerts'
        and c.conname = $1`,
    [conname],
  );
  return rows.length === 1 ? rows[0].def : null;
}

describe("the incident-alert vocabularies agree with their CHECK constraints", () => {
  it("DENOMINATOR: both constraints exist on public.incident_alerts, so nothing below can pass vacuously", async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `select c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'incident_alerts'
          and c.contype = 'c'
          and c.conname in ('incident_alerts_alert_type_known',
                            'incident_alerts_auto_resolved_reason_known')
        order by c.conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "incident_alerts_alert_type_known",
      "incident_alerts_auto_resolved_reason_known",
    ]);
  });

  it("INCIDENT_ALERT_TYPE_LABELS has a label for every alert type the table accepts, and no others", async () => {
    const def = await constraintDef("incident_alerts_alert_type_known");
    expect(def, "incident_alerts_alert_type_known is missing").not.toBeNull();
    expect(
      literals(def!).sort(),
      "every alert type the database writes needs an operator-facing label in " +
        "lib/admin/health.ts, or /super/health renders its raw enum key and the " +
        '"Alert type" filter cannot reach it',
    ).toEqual(Object.keys(INCIDENT_ALERT_TYPE_LABELS).sort());
  });

  it("INCIDENT_ALERT_AUTO_RESOLUTION_LABELS has a label for every system resolution reason the table accepts, and no others", async () => {
    const def = await constraintDef(
      "incident_alerts_auto_resolved_reason_known",
    );
    expect(
      def,
      "incident_alerts_auto_resolved_reason_known is missing",
    ).not.toBeNull();
    expect(
      literals(def!).sort(),
      "a system resolution reason with no label reads as the bare " +
        '"resolved automatically" on /super/health, which is the M-R7 defect ' +
        "the labels exist to fix",
    ).toEqual(Object.keys(INCIDENT_ALERT_AUTO_RESOLUTION_LABELS).sort());
  });
});
