// THE ERASURE RUNNER, AND THE BYTES IT IS SUPPOSED TO REMOVE.
//
// lib/erasure/runner.ts is the ONE part of this feature that runs outside the
// database transaction, and until fix round 1 nothing in the repository
// exercised it at any level: it appeared under tests/ only in two censuses,
// the psql suite deletes the storage object ITSELF under
// `session_replication_role = replica`, and the e2e's disposable account has
// no feedback, no screenshot and no export -- so `purgeBytes()` had only ever
// taken its `rows.length === 0 -> return` branch and no test anywhere had
// watched a byte leave a bucket (review finding I4; the brief asked for
// exactly this: "document bytes are gone from the bucket -- check Storage,
// not just the row").
//
// THE DENOMINATOR RULE, as everywhere else in this phase: every "the object
// is gone" below is preceded by a download of that same key that SUCCEEDS.
// An erasure that purged nothing and a bucket that never held anything are
// indistinguishable from the absence alone.
//
// Two paths are walked end to end:
//   1. the SUCCESS path -- a person with a feedback screenshot and a real
//      export archive is erased, and both objects leave their buckets;
//   2. the FAILURE path -- an erasure the database refuses (Q131) is recorded
//      `failed` by recordFailure() with the sentence failureSentence() maps
//      that refusal to, which is the only thing the person is ever shown
//      about it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";
import { mintStepUp } from "../rls/support/step-up";

let fx: RlsFixtures;
let pool: Pool;

// Imported lazily, AFTER the environment is set: both read their keys at call
// time, and this mirrors tests/integration/export/runner.test.ts.
let runPendingErasureJobs: typeof import("@/lib/erasure/runner").runPendingErasureJobs;
let runPendingExportJobs: typeof import("@/lib/export/runner").runPendingExportJobs;
let createStorageClient: typeof import("@/lib/supabase/storage").createStorageClient;

/** A 1x1 PNG. The feedback trigger wants an object behind the key, not art. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7bd1c0000000049454e44ae426082",
  "hex",
);

let subjectId = "";
let screenshotKey = "";
let exportKey = "";

async function objectExists(bucket: string, key: string): Promise<boolean> {
  const { data, error } = await createStorageClient().storage.from(bucket).download(key);
  if (error) return false;
  return (data?.size ?? 0) >= 0;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  ({ runPendingErasureJobs } = await import("@/lib/erasure/runner"));
  ({ runPendingExportJobs } = await import("@/lib/export/runner"));
  ({ createStorageClient } = await import("@/lib/supabase/storage"));

  fx = await createFixtures();
  pool = fx._pool;
}, 120_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

describe("the erasure runner removes the account's bytes from their buckets", () => {
  it("purges a feedback screenshot and an export archive, and only then deletes the rows", async () => {
    // THE SUBJECT: a marketing user of org A. Not an owner of anything, so
    // Q131 has nothing to say about them -- the refusal is the second test.
    const persona = fx.activeByRole.marketing;
    subjectId = persona.userId;

    // ---- a feedback screenshot: the object FIRST, because the insert
    // trigger refuses a declared screenshot with no bytes behind it --------
    const feedbackId = crypto.randomUUID();
    screenshotKey = `feedback/${feedbackId}`;
    const up = await createStorageClient()
      .storage.from("feedback-screenshots")
      .upload(screenshotKey, PNG, { contentType: "image/png", upsert: true });
    expect(up.error?.message).toBeUndefined();

    const feedback = await persona.client.from("feedback").insert({
      id: feedbackId,
      organisation_id: fx.orgA.id,
      category: "bug",
      message: "erasure runner fixture",
      route: "/",
      screenshot_key: screenshotKey,
      screenshot_mime: "image/png",
      screenshot_size_bytes: PNG.length,
      screenshot_scan_status: "clean",
      screenshot_scanned_at: new Date().toISOString(),
    } as never);
    expect(feedback.error?.message, "POSITIVE CONTROL: the feedback row").toBeUndefined();

    // ---- a REAL export archive, built by the real export runner ----------
    {
      const { data, error } = await persona.client
        .from("export_jobs")
        .insert({ kind: "account" } as never)
        .select("id");
      expect(error?.message, "POSITIVE CONTROL: the export job").toBeUndefined();
      const jobId = ((data ?? []) as { id: string }[])[0].id;
      await runPendingExportJobs();
      const { rows } = await pool.query<{ storage_key: string | null; status: string }>(
        `select storage_key, status from public.export_jobs where id = $1`,
        [jobId],
      );
      expect(rows[0].status, "the export job built an archive").toBe("succeeded");
      exportKey = rows[0].storage_key ?? "";
      expect(exportKey).not.toBe("");
    }

    // ---- THE DENOMINATOR: both objects are really in their buckets -------
    expect(await objectExists("feedback-screenshots", screenshotKey)).toBe(true);
    expect(await objectExists("exports", exportKey)).toBe(true);

    // ---- the erasure, asked for the way a person asks for it -------------
    await mintStepUp(persona.client, "account_erasure");
    const asked = await persona.client
      .from("erasure_jobs")
      .insert({ kind: "account" } as never)
      .select("id");
    expect(asked.error?.message, "POSITIVE CONTROL: the erasure job").toBeUndefined();
    const erasureJobId = ((asked.data ?? []) as { id: string }[])[0].id;

    const outcome = await runPendingErasureJobs();
    expect(outcome.outcome).toBe("ok");
    expect(outcome.claimed).toBe(1);
    expect(outcome.succeeded, "the job succeeded").toBe(1);
    expect(outcome.failed).toBe(0);

    const { rows: jobRows } = await pool.query<{
      status: string;
      failure_reason: string | null;
      summary: Record<string, unknown> | null;
      subject_user_id: string | null;
    }>(
      `select status, failure_reason, summary, subject_user_id
         from public.erasure_jobs where id = $1`,
      [erasureJobId],
    );
    expect(jobRows[0].status, jobRows[0].failure_reason ?? "").toBe("succeeded");
    // The job's own record of the deletion is counts, and it stops naming the
    // person it was about -- subject_user_id is ON DELETE SET NULL.
    expect(jobRows[0].summary).not.toBeNull();
    expect(jobRows[0].summary?.["auth_users"]).toBe(1);
    expect(jobRows[0].subject_user_id).toBeNull();

    // ---- the rows are gone ----------------------------------------------
    const { rows: userRows } = await pool.query(`select 1 from auth.users where id = $1`, [
      subjectId,
    ]);
    expect(userRows.length).toBe(0);
    const { rows: feedbackRows } = await pool.query(
      `select 1 from public.feedback where id = $1`,
      [feedbackId],
    );
    expect(feedbackRows.length).toBe(0);

    // ---- AND THE BYTES ARE GONE FROM STORAGE, which is the point ---------
    expect(
      await objectExists("feedback-screenshots", screenshotKey),
      "the screenshot is still in its bucket",
    ).toBe(false);
    expect(await objectExists("exports", exportKey), "the archive is still in its bucket").toBe(
      false,
    );

    // A second run finds nothing to do: the claim loop stops, it does not spin.
    const again = await runPendingErasureJobs();
    expect(again.claimed).toBe(0);
  }, 180_000);

  it("records a refused erasure as failed, with the sentence the person is shown", async () => {
    // The job is asked for while nothing blocks it, and the workspace that
    // blocks it is created AFTERWARDS -- which is exactly the case the
    // chokepoint exists for: the insert's guard and the erasure's guard are
    // the same question asked at two different moments.
    const persona = fx.activeByRole.booker;
    await mintStepUp(persona.client, "account_erasure");
    const asked = await persona.client
      .from("erasure_jobs")
      .insert({ kind: "account" } as never)
      .select("id");
    expect(asked.error?.message, "POSITIVE CONTROL: the erasure job").toBeUndefined();
    const jobId = ((asked.data ?? []) as { id: string }[])[0].id;

    const { rows: orgRows } = await pool.query<{ id: string }>(
      `insert into public.organisations (name, slug)
       values ('Erasure Runner Blocked', 'erasure-runner-blocked-' || substr(gen_random_uuid()::text, 1, 8))
       returning id`,
    );
    const orgId = orgRows[0].id;
    await pool.query(
      `insert into public.organisation_memberships (organisation_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [orgId, persona.userId],
    );
    await pool.query(
      `insert into public.contacts (organisation_id, name) values ($1, 'Runner blocker')`,
      [orgId],
    );

    const outcome = await runPendingErasureJobs();
    expect(outcome.claimed).toBe(1);
    expect(outcome.succeeded).toBe(0);
    expect(outcome.failed).toBe(1);

    const { rows } = await pool.query<{ status: string; failure_reason: string | null }>(
      `select status, failure_reason from public.erasure_jobs where id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe("failed");
    // THE RUNNER'S SENTENCE, not the database's message: a PostgreSQL error
    // can quote a row value, and this column is read by the person whose
    // account it is. The mapping itself is unit-tested in
    // tests/unit/erasure/failure-sentence.test.ts.
    expect(rows[0].failure_reason).toContain("Nothing was deleted");
    expect(rows[0].failure_reason).toContain("last owner");
    // And it is the runner's, not a leaked message: the database's sentence
    // NAMES the workspace and this one does not.
    expect(rows[0].failure_reason).not.toContain("Erasure Runner Blocked");

    // Nothing was erased: the account is still there.
    const { rows: userRows } = await pool.query(`select 1 from auth.users where id = $1`, [
      persona.userId,
    ]);
    expect(userRows.length).toBe(1);

    // Put the workspace back so teardown is not left with an extra org.
    await pool.query(`delete from public.contacts where organisation_id = $1`, [orgId]);
    await pool.query(`delete from public.organisations where id = $1`, [orgId]);
  }, 120_000);
});
