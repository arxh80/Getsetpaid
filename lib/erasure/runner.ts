import "server-only";

// ===========================================================================
// THE ERASURE RUNNER -- the work that happens OUTSIDE the request.
// ===========================================================================
//
// Reached two ways, both calling `runPendingErasureJobs()`:
//
//   * the request that created the job nudges it through `after()`, so an
//     account is gone in seconds rather than at the next tick;
//   * `POST /api/erasure/run`, called by pg_cron through pg_net on the same
//     ten-minute tick as everything else (20260930006000). That is the RETRY,
//     for a job whose nudge was lost with the process that owed it.
//
// ===========================================================================
// WHAT THIS FILE IS ALLOWED TO DECIDE: ALMOST NOTHING
// ===========================================================================
// It holds no ordering, no list of tables, no guard and no rule about who may
// erase what. `public.run_erasure_job()` does the whole sequence in ONE
// database transaction, which is what makes the erasure all-or-nothing: four
// PostgREST calls would be four transactions, and a runner that deleted the
// notes and then failed to re-point the audit log would have produced exactly
// the partial erasure the brief forbids.
//
// The ONE thing that genuinely has to happen out here is Storage. Object
// bytes do not live in Postgres, so they are deleted through the Storage API
// FIRST, and the database function REFUSES to delete a row while any of them
// is still in its bucket. If the transaction then rolls back, the residue is
// missing bytes for a person who asked to be erased -- an outcome in the
// direction of erasure and never in the direction of exposure -- and the
// retry deletes them again (a delete of an absent object is a no-op) and
// re-runs the transaction.

import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createStorageClient } from "@/lib/supabase/storage";

/** At most this many jobs per invocation, so neither entry point runs long. */
const MAX_JOBS_PER_RUN = 3;
/** And at most this long, whichever comes first. */
const WALL_CLOCK_BUDGET_MS = 60_000;

interface ClaimedJob {
  id: string;
  kind: "account" | "workspace";
  subject_user_id: string | null;
  organisation_id: string | null;
  requested_at: string;
}

export interface ErasureRunnerOutcome {
  readonly outcome: "ok" | "unavailable";
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Nudge the runner after the current response has been sent.
 *
 * `after()` rather than a bare floating promise, the export runner's reason:
 * Next.js keeps the execution context alive for it, and a stalled runner
 * cannot hold the form's response open. A failure here is logged and nothing
 * more -- the job stays `queued` and the pg_cron tick picks it up.
 */
export function nudgeErasureRunner(): void {
  after(async () => {
    try {
      await runPendingErasureJobs();
    } catch (cause) {
      console.error("[erasure] the post-response nudge failed:", cause);
    }
  });
}

export async function runPendingErasureJobs(): Promise<ErasureRunnerOutcome> {
  let supabase: ServiceClient;
  try {
    supabase = createServiceClient();
  } catch (cause) {
    console.error("[erasure] no service-role client:", cause);
    return { outcome: "unavailable", claimed: 0, succeeded: 0, failed: 0 };
  }

  const startedAt = Date.now();
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  while (claimed < MAX_JOBS_PER_RUN && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
    const job = await claimNext(supabase);
    if (job === null) break;
    claimed += 1;

    try {
      await purgeBytes(supabase, job);
      const { error } = await supabase.rpc("run_erasure_job", { p_job_id: job.id });
      // THE HINT TRAVELS WITH THE THROW. It used to be dropped here --
      // `new Error(code + message)` keeps neither the hint nor anything
      // failureSentence() switches on -- so EVERY refusal from the chokepoint,
      // the Q131 one included, was recorded as the generic "could not be
      // completed ... will be retried" sentence, which is also wrong: a last
      // owner's erasure is not retried into succeeding, it is waiting for them
      // to do something. Found by this file's own integration test, which did
      // not exist before fix round 1 (review finding I4).
      if (error) {
        throw Object.assign(new Error(`${error.code ?? "?"}: ${error.message}`), {
          hint: error.hint ?? "",
        });
      }
      succeeded += 1;
    } catch (cause) {
      failed += 1;
      await recordFailure(supabase, job, cause);
    }
  }

  return { outcome: "ok", claimed, succeeded, failed };
}

async function claimNext(supabase: ServiceClient): Promise<ClaimedJob | null> {
  const { data, error } = await supabase.rpc("claim_erasure_job");
  if (error) {
    console.error("[erasure] a job could not be claimed:", error.message);
    return null;
  }
  const rows = (data ?? []) as ClaimedJob[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Delete the job's stored objects, bucket by bucket.
 *
 * THE KEYS COME FROM THE DATABASE, never from this file: the manifest RPC
 * derives them from the job row, so nothing here chooses what to delete and a
 * bug in this file cannot aim the sweep at another subject's bucket prefix.
 *
 * It THROWS on a Storage failure rather than continuing, because the database
 * function is about to refuse anyway ("bytes_not_purged") and the failure
 * message from here is the one that says which bucket.
 */
async function purgeBytes(supabase: ServiceClient, job: ClaimedJob): Promise<void> {
  const { data, error } = await supabase.rpc("erasure_purge_manifest", { p_job_id: job.id });
  if (error) throw new Error(`the purge manifest could not be read: ${error.message}`);

  const rows = (data ?? []) as { bucket: string; object_key: string }[];
  if (rows.length === 0) return;

  const byBucket = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row.bucket !== "string" || typeof row.object_key !== "string") continue;
    const keys = byBucket.get(row.bucket) ?? [];
    keys.push(row.object_key);
    byBucket.set(row.bucket, keys);
  }

  const storage = createStorageClient().storage;
  for (const [bucket, keys] of byBucket) {
    // `remove` is idempotent: a key with no object behind it is not an error,
    // which is what makes a retry after a rolled-back transaction safe.
    const { error: removeError } = await storage.from(bucket).remove(keys);
    if (removeError) {
      throw new Error(`${keys.length} object(s) could not be removed from ${bucket}: ${removeError.message}`);
    }
  }
}

/**
 * Record the failure -- in its own transaction, because it has to survive the
 * rollback it is describing.
 *
 * THE SENTENCE IS THE RUNNER'S, NOT THE DATABASE'S MESSAGE VERBATIM. A
 * PostgreSQL error message can quote a row value (`detail` on a unique
 * violation names the conflicting key), and `erasure_jobs.failure_reason` is
 * read by the person whose account it is and by the operator. So the hint and
 * the SQLSTATE travel and the message does not.
 */
async function recordFailure(
  supabase: ServiceClient,
  job: ClaimedJob,
  cause: unknown,
): Promise<void> {
  const reason = failureSentence(cause);
  console.error(`[erasure] job ${job.id} failed:`, cause);
  const { error } = await supabase.rpc("fail_erasure_job", {
    p_job_id: job.id,
    p_reason: reason,
  });
  if (error) {
    // The job stays `running` and the one-live-job index blocks the subject's
    // next attempt. Q166 is the reaper that belongs in Task 6's sweep; this
    // log is what makes it findable in the meantime.
    console.error(`[erasure] job ${job.id}: the failure could not be recorded:`, error.message);
  }
}

/** Exported for the unit suite: the mapping from a refusal to a sentence. */
export function failureSentence(cause: unknown): string {
  const hint =
    typeof cause === "object" && cause !== null && "hint" in cause
      ? String((cause as { hint?: unknown }).hint ?? "")
      : hintFromMessage(cause);

  switch (hint) {
    case "last_owner_of_workspace":
      return "Nothing was deleted: this account is the last owner of a workspace that still has other members or records in it. Transfer ownership, or close the workspace, and ask again.";
    case "workspace_has_no_owner":
      // N2/Q178: the same guard, for somebody who is NOT an owner of the
      // workspace it names. The sentence above would send them to two doors
      // that are both locked -- there is nobody for them to promote, and no
      // member-facing route to close a workspace exists at all.
      return "Nothing was deleted: this account is the last member of a workspace that has no owner, and only support can close it. Contact support, ask them to close the workspace, and ask again.";
    case "bytes_not_purged":
      return "Nothing was deleted: some stored files could not be removed first, and deleting the records while the files remain would leave them unreachable rather than gone. This will be retried.";
    case "replication_role_must_be_origin":
      return "Nothing was deleted: the database session was not in a state where deleting safely was possible.";
    case "reference_survived_the_repoint":
    case "reference_survived_the_delete":
    // `reference_survived_the_purge` and `custom_field_values_orphaned` are
    // private.erase_organisation()'s own post-checks, and an ACCOUNT erasure
    // reaches them through step 8b (Q131's narrow case purges the subject's
    // empty solo workspace). The first is the literal twin of
    // `reference_survived_the_delete` and was falling through to "It will be
    // retried" -- the precise wrong sentence finding I4 was raised about,
    // surviving in a narrower form (fix round 2, N5).
    case "reference_survived_the_purge":
    case "custom_field_values_orphaned":
      return "Nothing was deleted: a check that every trace of the account had been anonymised did not pass, so the whole deletion was rolled back. This needs a person to look at it.";
    case "unknown_custom_field_entity_type":
      return "Nothing was deleted: the database has grown a kind of record this deletion does not know how to remove. This needs a person to look at it.";
    case "workspace_is_live":
      return "Nothing was deleted: a workspace this deletion had to remove is still open, and only a closed workspace can be removed. This needs a person to look at it.";
    case "unknown_job":
    case "job_is_not_running":
      return "Nothing was deleted: the record of this deletion had already moved on by the time it ran, so nothing was attempted. This needs a person to look at it.";
    case "erasure_runner_is_server_only":
      return "Nothing was deleted: the deletion was attempted from somewhere that is not allowed to run one. This needs a person to look at it.";
    case "tombstone_is_nobody":
      return "Nothing was deleted: the account named is the shared anonymous identity that deleted accounts are re-pointed at, and it is not a person. This needs a person to look at it.";
    case "composite_fk_to_auth_users":
    case "unclassified_fkless_identifier":
    case "array_identifier_needs_a_named_step":
      // Both mean the same thing to the person reading it: the schema has
      // grown something this deletion cannot promise anything about, so it
      // refused rather than leaving an identifier behind (fix round 1, C1).
      return "Nothing was deleted: the database has grown a reference this deletion does not know how to anonymise. This needs a person to look at it.";
    case "workspace_left_ownerless":
      // C2: the loser of a race between two co-owners' erasures. The retry is
      // real -- by then the workspace has one owner and the Q131 sentence
      // above is what they will be told.
      return "Nothing was deleted: somebody else's deletion finished first and this one would have left a workspace with no owner. Nothing has changed, and this will be tried again.";
    default:
      return "Nothing was deleted: the deletion could not be completed. It will be retried, and nothing has changed in the meantime.";
  }
}

/**
 * PostgREST hands a hint back on the error object, but a thrown Error (the
 * Storage path, and the rethrow above) carries only a message. Recognising
 * our own hint inside it keeps the two paths on one sentence table rather
 * than two.
 */
function hintFromMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  if (text.includes("could not be removed from")) return "bytes_not_purged";
  return "";
}
