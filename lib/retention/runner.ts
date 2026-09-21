import "server-only";

// ===========================================================================
// THE RETENTION RUNNER -- the half of the garbage collector that has to live
// outside Postgres, because object bytes do not live in Postgres.
// ===========================================================================
//
// Reached one way only: `POST /api/retention/run`, called by pg_cron through
// pg_net on the same ten-minute tick as everything else (20261003005000),
// and throttled in the database to about once an hour.
//
// THERE IS NO NUDGE. The export and erasure runners are nudged from the
// request that created their job, because somebody is waiting. Nobody is
// waiting for a retention sweep: its periods are measured in years and no
// user action starts one. A nudge would be a second way in with no benefit.
//
// ===========================================================================
// WHAT THIS FILE IS ALLOWED TO DECIDE: NOTHING
// ===========================================================================
// It holds no period, no table list, no ceiling and no rule about what may be
// deleted. `public.run_retention_sweep()` does every row-side sweep in ONE
// database transaction; `public.retention_object_manifest()` decides which
// stored objects go. The keys come from the database and never from here, so
// a bug in this file cannot aim a delete at a bucket prefix Postgres did not
// name -- the erasure runner's rule, and the reason both exist.
//
// ===========================================================================
// THE ORDER, AND WHY IT IS BYTES-FIRST
// ===========================================================================
// Object deletion is not transactional and row deletion is. So the objects go
// FIRST and the rows follow:
//
//   * private.sweep_feedback() refuses to delete a row whose screenshot is
//     still in the bucket, and private.erase_organisation() refuses to purge
//     a workspace while one of its document objects remains. If the rows went
//     first, both would be refusing on every run for ever.
//   * If the sweep then fails, the residue is bytes that are gone and rows
//     that are not -- which is the direction of "the data is deleted", never
//     of "the data is exposed" -- and the next run's row-side sweeps finish
//     the job from the object's absence.
//
// A DRY RUN DELETES NOTHING, including objects. It counts the manifest and
// reports it, so the founder reads what a live run would remove before one
// does.

import { createServiceClient } from "@/lib/supabase/service";
import { createStorageClient } from "@/lib/supabase/storage";

/** At most this many rows per sweep per run, and this many objects per run. */
const ROWS_PER_SWEEP = 500;
const OBJECTS_PER_RUN = 500;

interface RetentionRunRow {
  id: string;
  correlation_id: string;
  mode: "dry" | "live";
  status: "running" | "completed" | "refused" | "failed";
}

export interface RetentionRunnerOutcome {
  readonly outcome: "ok" | "refused" | "failed" | "throttled" | "unavailable";
  readonly runId: string | null;
  readonly mode: "dry" | "live" | null;
  /** Objects actually removed from a bucket (0 on a dry run). */
  readonly objectsRemoved: number;
  /** Objects the manifest named -- what a dry run reports. */
  readonly objectsNamed: number;
  readonly swept: Record<string, number | boolean> | null;
  readonly refused: Record<string, string> | null;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

export async function runRetentionSweep(
  options: { dry?: boolean } = {},
): Promise<RetentionRunnerOutcome> {
  const dry = options.dry === true;
  const empty = {
    runId: null,
    mode: null,
    objectsRemoved: 0,
    objectsNamed: 0,
    swept: null,
    refused: null,
  } as const;

  let supabase: ServiceClient;
  try {
    supabase = createServiceClient();
  } catch (cause) {
    console.error("[retention] no service-role client:", cause);
    return { outcome: "unavailable", ...empty };
  }

  const { data: startData, error: startError } = await supabase.rpc("start_retention_run", {
    p_dry: dry,
  });
  if (startError) {
    console.error("[retention] the run could not be started:", startError.message);
    return { outcome: "unavailable", ...empty };
  }
  const run = startData as unknown as RetentionRunRow | null;
  if (!run) return { outcome: "unavailable", ...empty };

  // THE KILL SWITCH ANSWERED FIRST. The database still wrote a row, so the
  // refusal is visible on /super/health rather than being indistinguishable
  // from a quiet run.
  if (run.status !== "running") {
    return { ...empty, outcome: "refused", runId: run.id, mode: run.mode };
  }

  let objectsNamed = 0;
  let objectsRemoved = 0;

  try {
    const manifest = await readManifest(supabase);
    objectsNamed = manifest.length;
    if (!dry) objectsRemoved = await removeObjects(manifest);

    const { data, error } = await supabase.rpc("run_retention_sweep", {
      p_run_id: run.id,
      p_limit: ROWS_PER_SWEEP,
    });
    if (error) {
      throw Object.assign(new Error(`${error.code ?? "?"}: ${error.message}`), {
        hint: error.hint ?? "",
      });
    }

    const summary = (data ?? {}) as Record<string, unknown>;
    const refused = (summary.refused ?? {}) as Record<string, string>;
    return {
      outcome: "ok",
      runId: run.id,
      mode: run.mode,
      objectsRemoved,
      objectsNamed,
      swept: summary as Record<string, number | boolean>,
      refused,
    };
  } catch (cause) {
    await recordFailure(supabase, run.id, cause);
    return {
      outcome: "failed",
      runId: run.id,
      mode: run.mode,
      objectsRemoved,
      objectsNamed,
      swept: null,
      refused: null,
    };
  }
}

interface ManifestRow {
  bucket: string;
  object_key: string;
  reason: string;
}

async function readManifest(supabase: ServiceClient): Promise<ManifestRow[]> {
  const { data, error } = await supabase.rpc("retention_object_manifest", {
    p_limit: OBJECTS_PER_RUN,
  });
  if (error) throw new Error(`the object manifest could not be read: ${error.message}`);
  const rows = (data ?? []) as ManifestRow[];
  return rows.filter(
    (row) => typeof row.bucket === "string" && typeof row.object_key === "string",
  );
}

/**
 * Delete the named objects, bucket by bucket.
 *
 * `remove` is idempotent: a key with no object behind it is not an error,
 * which is what makes a retry after a failed run safe.
 *
 * A BUCKET THAT FAILS DOES NOT STOP THE OTHERS, which is the opposite of the
 * erasure runner's rule and deliberately so. There, the bytes and the rows
 * are one person's erasure and a partial one is the thing to avoid; here the
 * buckets are unrelated subjects, and a Storage fault on `exports` must not
 * stop a workspace's documents being purged for another month. The failure is
 * thrown at the END, so the run is recorded as failed and the sweep does not
 * run -- the rows stay, which is the safe direction.
 */
async function removeObjects(manifest: ManifestRow[]): Promise<number> {
  if (manifest.length === 0) return 0;

  const byBucket = new Map<string, string[]>();
  for (const row of manifest) {
    const keys = byBucket.get(row.bucket) ?? [];
    keys.push(row.object_key);
    byBucket.set(row.bucket, keys);
  }

  const storage = createStorageClient().storage;
  const failures: string[] = [];
  let removed = 0;
  for (const [bucket, keys] of byBucket) {
    const { error } = await storage.from(bucket).remove(keys);
    if (error) {
      failures.push(`${keys.length} object(s) could not be removed from ${bucket}`);
      continue;
    }
    removed += keys.length;
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return removed;
}

/**
 * Record the failure, in its own transaction, because it has to survive the
 * rollback it describes.
 *
 * THE SENTENCE IS COMPOSED HERE AND THE DATABASE'S MESSAGE IS NOT PASSED
 * THROUGH. A PostgreSQL error message can quote a row value, and
 * public.retention_runs is rendered on /super/health.
 */
async function recordFailure(
  supabase: ServiceClient,
  runId: string,
  cause: unknown,
): Promise<void> {
  console.error(`[retention] run ${runId} failed:`, cause);
  const { error } = await supabase.rpc("fail_retention_run", {
    p_run_id: runId,
    p_reason: failureReason(cause),
  });
  if (error) {
    // The row stays `running`; public.start_retention_run() reaps it on the
    // next run, past the declared stuck_job period. This log is what makes it
    // findable before then.
    console.error(`[retention] run ${runId}: the failure could not be recorded:`, error.message);
  }
}

/** Exported for the unit suite: a refusal becomes a hint, never a message. */
export function failureReason(cause: unknown): string {
  const hint =
    typeof cause === "object" && cause !== null && "hint" in cause
      ? String((cause as { hint?: unknown }).hint ?? "")
      : "";
  if (hint) return hint;
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  // The one shape that arrives as a thrown Error rather than a PostgREST
  // refusal: a Storage removal that failed. Recognised rather than passed
  // through, so no bucket key reaches the column.
  if (text.includes("could not be removed from")) return "storage_remove_failed";
  if (text.includes("object manifest could not be read")) return "manifest_unreadable";
  return "unknown";
}
