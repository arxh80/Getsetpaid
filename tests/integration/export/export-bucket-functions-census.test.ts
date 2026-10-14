// =============================================================================
// Q228 TASK 3: EVERY DATABASE FUNCTION THAT NAMES `exports` OBJECTS BY
// `storage_key` IS ON A ROLL, WITH A REASON IT IS RIGHT ABOUT PARTS.
//
// A closure backup's parts 2+ are named by `export_job_parts.storage_key`, not
// by `export_jobs.storage_key`. Any function that decides which `exports`
// objects to keep or delete from `export_jobs` alone is therefore wrong about
// parts in one of two ways: it never deletes them (an expired backup's parts
// outlive it), or -- the critical one, plan Spec correction 2 -- it deletes
// them while the backup is kept, because no export_jobs row names them.
//
// So this census asks the catalogue, not a hand-kept list: every function in
// `public`/`private` whose source carries both `'exports'` and `storage_key`.
// A new one fails here until it is added with a reason, which is the moment
// somebody has to think about parts.
// =============================================================================
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl, max: 2 });

afterAll(async () => {
  await pool.end();
});

/** Each function, why it is right about parts, and the source text that proves it. */
const ROLL: Record<string, { reason: string; mustContain: readonly string[] }> = {
  "public.retention_object_manifest": {
    reason:
      "THE PURGE. It names export_job_parts twice: an expired job's parts 2+ are " +
      "`export_expired`, and a part of a job that has not failed is never an `orphan` " +
      "(20261101001000). Measured in rls_q228_closure_backup_parts.sql QM1-QM5.",
    mustContain: ["export_job_parts"],
  },
  "public.erasure_purge_manifest": {
    reason:
      "An ACCOUNT erasure purges the subject's export archives, excluding closure " +
      "backups (Q206: the workspace's archive, re-pointed at the tombstone, never purged " +
      "here). Parts exist only for closure backups (export_job_parts_guard: " +
      "export_parts_are_closure_only), so no part can be reached. QM6 measures it.",
    mustContain: ["not e.closure_backup"],
  },
  "private.erase_account": {
    reason:
      "Refuses while the subject's account-export objects remain, reading " +
      "export_jobs.storage_key with `not j.closure_backup`: the same Q206 exclusion, " +
      "and parts exist only for closure backups.",
    mustContain: ["not j.closure_backup"],
  },
  "private.export_jobs_before_insert": {
    reason:
      "A FALSE CANDIDATE: `'exports'` is the rate-limit category it meters, and " +
      "`storage_key` appears only as the insert's forced null. It names no object.",
    mustContain: ["v_category := 'exports'", "new.storage_key    := null"],
  },
};

describe("functions that name `exports` objects by storage_key (Q228 Task 3)", () => {
  it("the catalogue's set is exactly the roll, each with a reason", async () => {
    const { rows } = await pool.query<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prosrc like '%''exports''%'
          and p.prosrc like '%storage_key%'
        order by 1`,
    );
    const found = [...new Set(rows.map((r) => r.fn))].sort();
    // DENOMINATOR: the query finds something, and the one function this task
    // exists to fix is in it -- so an empty or broken query cannot pass.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("public.retention_object_manifest");
    expect(found).toEqual(Object.keys(ROLL).sort());
    for (const [fn, { reason }] of Object.entries(ROLL)) {
      expect(reason.length, `${fn} needs a reason`).toBeGreaterThan(60);
    }
  });

  it.each(Object.entries(ROLL))("%s carries the text its reason depends on", async (fn, { mustContain }) => {
    const [schema, name] = fn.split(".");
    const { rows } = await pool.query<{ src: string }>(
      `select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = $2`,
      [schema, name],
    );
    expect(rows.length, `${fn} has exactly one definition`).toBe(1);
    for (const text of mustContain) {
      expect(rows[0].src, `${fn} lost "${text}"`).toContain(text);
    }
  });
});
