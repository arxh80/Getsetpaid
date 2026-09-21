// THE RETENTION RUNNER, AND THE BYTES IT IS SUPPOSED TO REMOVE.
//
// The row side of this task is proved in psql (supabase/tests/
// rls_phase8_retention.sql, 114 assertions). This file exists for the one
// thing psql cannot reach: STORAGE. Object bytes do not live in Postgres, so
// "the document was purged" asserted against a row is not the claim the
// retention policy makes -- the claim is that the FILE IS GONE FROM THE
// BUCKET, and only a Storage download can falsify that.
//
// THE DENOMINATOR RULE, as everywhere else in this phase: every "the object
// is gone" below is preceded by a download of that same key that SUCCEEDS.
// A sweep that purged nothing and a bucket that never held anything are
// indistinguishable from the absence alone. Task 5's erasure runner test is
// the pattern; this is its sibling for the scheduled job.
//
// FOUR THINGS ARE WALKED END TO END:
//   1. an expired soft-deleted document's bytes leave the `documents` bucket
//      and its row is stamped bytes_purged_at (Q52);
//   2. an expired feedback row's screenshot leaves `feedback-screenshots` AND
//      the row goes with it -- in that order, because the sweep refuses to
//      delete a row whose object is still there (Q120);
//   3. an ORPHAN -- an object no row names, past its grace period -- is swept
//      from the bucket, which is requirement 5's "the row is gone and the
//      object delete failed" residue;
//   4. a DRY run removes NOTHING, with the object counted around it.
//
// AND ONE THING IS ASSERTED THAT NO SINGLE SWEEP CAN SEE: a document inside
// its retention period, in the same bucket, in the same workspace, is still
// downloadable afterwards. A runner that removed every object in the bucket
// would pass every assertion above.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;

let runRetentionSweep: typeof import("@/lib/retention/runner").runRetentionSweep;
let createStorageClient: typeof import("@/lib/supabase/storage").createStorageClient;

/** A 1x1 PNG, and a few bytes of "PDF". Neither is art; both are objects. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7bd1c0000000049454e44ae426082",
  "hex",
);
const PDF = Buffer.from("%PDF-1.4\n% retention probe\n", "utf8");

const EXPIRED_DOC = "11111111-1111-4111-8111-000000000001";
const LIVE_DOC = "11111111-1111-4111-8111-000000000002";
const FEEDBACK_ID = "11111111-1111-4111-8111-000000000003";
const ORPHAN_KEY = "11111111-1111-4111-8111-00000000000f/orphan-probe";

let expiredDocKey = "";
let liveDocKey = "";
let screenshotKey = "";

async function objectExists(bucket: string, key: string): Promise<boolean> {
  const { data, error } = await createStorageClient().storage.from(bucket).download(key);
  if (error) return false;
  return (data?.size ?? 0) > 0;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  ({ runRetentionSweep } = await import("@/lib/retention/runner"));
  ({ createStorageClient } = await import("@/lib/supabase/storage"));

  fx = await createFixtures();
  pool = fx._pool;
}, 120_000);

afterAll(async () => {
  if (!fx) return;
  const storage = createStorageClient().storage;
  await storage.from("documents").remove([expiredDocKey, liveDocKey].filter(Boolean));
  await storage.from("feedback-screenshots").remove([screenshotKey].filter(Boolean));
  await storage.from("documents").remove([ORPHAN_KEY]);
  await pool.query(`delete from public.audit_events where action = 'retention.swept'`);
  await pool.query(`delete from public.retention_runs`);
  await pool.query(`delete from public.feedback where id = $1`, [FEEDBACK_ID]);
  await pool.query(`delete from public.documents where id = any($1::uuid[])`, [
    [EXPIRED_DOC, LIVE_DOC],
  ]);
  await destroyFixtures(fx);
});

describe("the retention runner removes bytes from the buckets, and only the right ones", () => {
  it("purges an expired document's file, a purged feedback screenshot and an orphan, and leaves a live file alone", async () => {
    const storage = createStorageClient().storage;
    const orgId = fx.orgA.id;
    expiredDocKey = `${orgId}/${EXPIRED_DOC}`;
    liveDocKey = `${orgId}/${LIVE_DOC}`;
    screenshotKey = `feedback/${FEEDBACK_ID}`;

    // ---- (a) TWO DOCUMENTS, both soft-deleted, one past its two years and
    //          one a day inside them. Same bucket, same workspace, same
    //          everything but the date -- which is what makes the survivor
    //          mean something.
    for (const [id, key] of [
      [EXPIRED_DOC, expiredDocKey],
      [LIVE_DOC, liveDocKey],
    ] as const) {
      const up = await storage.from("documents").upload(key, PDF, {
        contentType: "application/pdf",
        upsert: true,
      });
      expect(up.error, `the ${id} fixture object could not be stored: ${up.error?.message}`).toBeNull();
    }
    await pool.query(
      `insert into public.documents
         (id, organisation_id, filename, storage_key, mime_type, size_bytes,
          scan_status, scanned_at, deleted_at)
       values
         ($1, $3, 'expired.pdf', $4, 'application/pdf', $6, 'clean', now(),
          now() - interval '2 years' - interval '1 day'),
         ($2, $3, 'live.pdf',    $5, 'application/pdf', $6, 'clean', now(),
          now() - interval '2 years' + interval '1 day')`,
      [EXPIRED_DOC, LIVE_DOC, orgId, expiredDocKey, liveDocKey, PDF.length],
    );

    // ---- (b) AN EXPIRED FEEDBACK ROW WITH A REAL SCREENSHOT BEHIND IT.
    const shot = await storage.from("feedback-screenshots").upload(screenshotKey, PNG, {
      contentType: "image/png",
      upsert: true,
    });
    expect(shot.error, `the screenshot fixture failed: ${shot.error?.message}`).toBeNull();
    await pool.query(
      `insert into public.feedback
         (id, user_id, category, message, route, screenshot_key, screenshot_mime,
          screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at, created_at)
       values ($1, $2, 'bug', 'retention probe', '/probe', $3, 'image/png', $4,
               'clean', now(), now() - interval '2 years' - interval '1 day')`,
      [FEEDBACK_ID, fx.activeByRole.marketing.userId, screenshotKey, PNG.length],
    );

    // ---- (c) AN ORPHAN: an object no row names at all, backdated past the
    //          one-day grace period. This is the residue requirement 5 names
    //          -- a row delete whose object delete failed -- and nothing but
    //          the orphan half of the manifest can ever reach it.
    const orphan = await storage.from("documents").upload(ORPHAN_KEY, PDF, {
      contentType: "application/pdf",
      upsert: true,
    });
    expect(orphan.error, `the orphan fixture failed: ${orphan.error?.message}`).toBeNull();
    await pool.query(
      `update storage.objects set created_at = now() - interval '2 days'
        where bucket_id = 'documents' and name = $1`,
      [ORPHAN_KEY],
    );

    // ---- THE DENOMINATOR. Every one of the four is DOWNLOADABLE first.
    expect(await objectExists("documents", expiredDocKey), "the expired document's bytes").toBe(true);
    expect(await objectExists("documents", liveDocKey), "the live document's bytes").toBe(true);
    expect(await objectExists("feedback-screenshots", screenshotKey), "the screenshot").toBe(true);
    expect(await objectExists("documents", ORPHAN_KEY), "the orphan").toBe(true);

    // ---- THE DRY RUN REMOVES NOTHING, and says how much it would have.
    const dry = await runRetentionSweep({ dry: true });
    expect(dry.outcome, "the dry run did not complete").toBe("ok");
    expect(dry.objectsNamed, "the dry run should have named at least three objects").toBeGreaterThanOrEqual(3);
    expect(dry.objectsRemoved, "A DRY RUN REMOVED BYTES").toBe(0);
    expect(await objectExists("documents", expiredDocKey), "the dry run deleted a document").toBe(true);
    expect(await objectExists("feedback-screenshots", screenshotKey), "the dry run deleted a screenshot").toBe(true);
    expect(await objectExists("documents", ORPHAN_KEY), "the dry run deleted an orphan").toBe(true);

    // ---- THE BYTES-FIRST GATE, ASKED DIRECTLY AND BEFORE THE RUNNER TOUCHES
    //      THE BUCKET. private.sweep_feedback() must DEFER a row whose
    //      screenshot is still stored -- deleting it there would leave an
    //      untracked image of somebody's screen that only the orphan sweep
    //      would find, a day later.
    //
    //      THIS ASSERTION EXISTS BECAUSE A MUTATION FOUND NOTHING. Removing
    //      the gate's `not exists (... storage.objects ...)` term reddened
    //      ZERO assertions in the 116-assertion psql suite, and zero here --
    //      psql cannot plant a storage object it is able to remove again
    //      (`storage.protect_delete()` refuses a direct DELETE and `postgres`
    //      is not the owner of that table, so the trigger cannot be disabled
    //      for one statement either, and `session_replication_role = replica`
    //      is forbidden in this feature). This file is the only place the
    //      rule can be asked at all.
    const deferred = await pool.query<{ r: Record<string, number> }>(
      `select private.sweep_feedback(false, 500) as r`,
    );
    expect(
      deferred.rows[0].r["feedback.waiting_on_bytes"],
      "the sweep did not notice that the screenshot is still stored",
    ).toBe(1);
    expect(
      deferred.rows[0].r["feedback.rows"],
      "THE FEEDBACK ROW WAS DELETED WHILE ITS SCREENSHOT WAS STILL IN THE BUCKET",
    ).toBe(0);
    const stillThere = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.feedback where id = $1`,
      [FEEDBACK_ID],
    );
    expect(stillThere.rows[0].n, "the deferred row did not survive its own sweep").toBe("1");

    // ---- THE LIVE RUN.
    const live = await runRetentionSweep();
    expect(live.outcome, `the live run failed: ${JSON.stringify(live.refused)}`).toBe("ok");
    expect(live.refused, "a sweep refused during the live run").toEqual({});

    // ---- THE ASSERTIONS THAT ARE THE POINT: bytes, not rows.
    expect(
      await objectExists("documents", expiredDocKey),
      "THE EXPIRED DOCUMENT'S BYTES ARE STILL IN THE BUCKET",
    ).toBe(false);
    expect(
      await objectExists("feedback-screenshots", screenshotKey),
      "THE EXPIRED SCREENSHOT'S BYTES ARE STILL IN THE BUCKET",
    ).toBe(false);
    expect(
      await objectExists("documents", ORPHAN_KEY),
      "THE ORPHANED OBJECT IS STILL IN THE BUCKET",
    ).toBe(false);

    // ---- AND THE SURVIVOR. A runner that emptied the bucket would have
    //      passed all three assertions above.
    expect(
      await objectExists("documents", liveDocKey),
      "A DOCUMENT INSIDE ITS RETENTION PERIOD WAS DELETED",
    ).toBe(true);

    // ---- The rows follow the bytes, in that order.
    const docs = await pool.query<{ id: string; purged: string | null }>(
      `select id, bytes_purged_at as purged from public.documents where id = any($1::uuid[]) order by id`,
      [[EXPIRED_DOC, LIVE_DOC]],
    );
    expect(docs.rows[0].purged, "the expired document was not stamped").not.toBeNull();
    expect(docs.rows[1].purged, "the LIVE document was stamped").toBeNull();

    const feedback = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.feedback where id = $1`,
      [FEEDBACK_ID],
    );
    expect(feedback.rows[0].n, "the expired feedback row survived its own screenshot").toBe("0");

    // ---- AND THE RUN RECORDED ITSELF, with a summary audit row on its thread.
    const runs = await pool.query<{ mode: string; status: string; corr: string }>(
      `select mode, status, correlation_id as corr from public.retention_runs order by started_at`,
    );
    expect(runs.rows.map((r) => `${r.mode}/${r.status}`)).toEqual([
      "dry/completed",
      "live/completed",
    ]);
    const audit = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.audit_events a
        where a.action = 'retention.swept'
          and a.correlation_id = any($1::uuid[])`,
      [runs.rows.map((r) => r.corr)],
    );
    expect(audit.rows[0].n, "each run should write exactly one summary row, on its own thread").toBe("2");
  }, 180_000);
});
