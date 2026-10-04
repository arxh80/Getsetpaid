import "server-only";

// ===========================================================================
// THE EXPORT RUNNER -- the work that happens OUTSIDE the request.
// ===========================================================================
//
// It is reached two ways and both call `runPendingExportJobs()`:
//
//   * the request that created the job nudges it through `after()`, so an
//     export is ready in seconds rather than at the next tick. That is the
//     LATENCY;
//   * `POST /api/exports/run`, called by pg_cron through pg_net every ten
//     minutes (20260927004000). That is the RETRY, for a job whose nudge was
//     lost with the process that owed it.
//
// Both are bounded: at most MAX_JOBS_PER_RUN jobs and a wall-clock budget, so
// neither a request's tail nor a cron tick can run for ever. Whatever is left
// queued is picked up next time.
//
// ===========================================================================
// WHAT THIS FILE IS NOT ALLOWED TO DECIDE
// ===========================================================================
// It holds no list of tables (public.export_plan), no row or byte ceilings
// (private.export_limits), and -- the important one -- NO ACCESS RULES. Every
// row it writes came back from public.export_read_page(), which reads under
// the requester's own RLS for everything in a workspace export and for most
// of an account one. This file cannot widen what an export contains by
// getting a filter wrong, because it writes no filters.
//
// The service-role client's whole reach here is the grants in
// 20260927001000 § 7 and 20260927003000 § 1 -- select on public.export_jobs,
// update on the ten columns a job's outcome consists of, select and a
// two-column update on public.data_subject_requests -- plus four RPCs granted
// to service_role alone. `.from()` against anything else fails at the
// privilege check.

import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createStorageClient } from "@/lib/supabase/storage";
import { sanitiseFilename } from "@/lib/security/file-allowlist";
import {
  EXPORT_BUCKET,
  EXPORT_MANIFEST_VERSION,
  SUPPORT_ACCESS_NOTE,
  exportStorageKey,
  type ExportKind,
  type ExportManifest,
  type ExportWithholding,
  REMAINDER_WITHHELD,
  WITHHOLDING_COPY,
} from "./contract";
import { ExportTooLargeError, ZipWriter } from "./zip";

/** At most this many jobs per invocation, so neither entry point runs long. */
const MAX_JOBS_PER_RUN = 3;
/** And at most this long, whichever comes first. */
const WALL_CLOCK_BUDGET_MS = 60_000;

interface Limits {
  page_size: number;
  max_rows_per_table: number;
  max_total_rows: number;
  max_archive_bytes: number;
  archive_days: number;
}

interface ClaimedJob {
  id: string;
  kind: ExportKind;
  organisation_id: string | null;
  requested_by: string;
  requested_at: string;
}

interface PlanRow {
  table_name: string;
  disposition: "exported" | "excused";
  reason: string | null;
  authorisation: string | null;
  /** The catalogue's declared keyset column — `null` on an excused row. */
  key_column: string | null;
}

export interface RunnerOutcome {
  readonly outcome: "ok" | "unavailable";
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Nudge the runner after the current response has been sent.
 *
 * `after()` rather than a bare floating promise: Next.js keeps the execution
 * context alive for it, and a stalled runner therefore cannot hold the form's
 * response open — the bug the feedback receipt was moved into `after()` to
 * fix. A failure here is logged and nothing more: the job stays `queued` and
 * the pg_cron tick picks it up.
 */
export function nudgeExportRunner(): void {
  after(async () => {
    try {
      await runPendingExportJobs();
    } catch (cause) {
      console.error("[export] the post-response nudge failed:", cause);
    }
  });
}

export async function runPendingExportJobs(): Promise<RunnerOutcome> {
  let supabase: ServiceClient;
  try {
    supabase = createServiceClient();
  } catch (cause) {
    console.error("[export] no service-role client:", cause);
    return { outcome: "unavailable", claimed: 0, succeeded: 0, failed: 0 };
  }

  const startedAt = Date.now();
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  while (claimed < MAX_JOBS_PER_RUN && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
    const { data, error } = await supabase.rpc("claim_export_job");
    if (error) {
      console.error("[export] claim failed:", error.message);
      return { outcome: "unavailable", claimed, succeeded, failed };
    }
    const job = (Array.isArray(data) ? data[0] : data) as ClaimedJob | undefined;
    if (!job) break;

    claimed += 1;
    try {
      await buildAndStore(supabase, job);
      succeeded += 1;
    } catch (cause) {
      failed += 1;
      const reason =
        cause instanceof ExportTooLargeError
          ? cause.message
          : cause instanceof Error
            ? `The export could not be built: ${cause.message}`
            : "The export could not be built.";
      console.error(`[export] job ${job.id} failed:`, cause);
      const { error: failError } = await supabase
        .from("export_jobs")
        .update({ status: "failed", failure_reason: reason.slice(0, 2000) })
        .eq("id", job.id);
      if (failError) {
        // The job is left `running` and will not be retried: the one-live-job
        // index then blocks the subject from starting another, which is a
        // stuck state a person can see on their own page. Loud rather than
        // silent, and Task 6's sweep is where a reaper belongs.
        console.error(`[export] job ${job.id} could not be marked failed:`, failError.message);
      }
    }
  }

  return { outcome: "ok", claimed, succeeded, failed };
}

async function readLimits(supabase: ServiceClient): Promise<Limits> {
  // private.export_limits() is not client-callable, so the runner reads the
  // numbers through the plan's own entry point instead of holding copies:
  // public.export_read_page caps the page itself, and these are for the row
  // and byte ceilings the runner enforces as it writes.
  const { data, error } = await supabase.rpc("export_limits_for_runner");
  if (error) throw new Error(`export limits: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Limits | undefined;
  if (!row) throw new Error("export limits: no row");
  return row;
}

async function buildAndStore(supabase: ServiceClient, job: ClaimedJob): Promise<void> {
  const limits = await readLimits(supabase);
  const zip = new ZipWriter(limits.max_archive_bytes);
  const generatedAt = new Date();

  const { data: planData, error: planError } = await supabase.rpc("export_plan", {
    p_job_id: job.id,
  });
  if (planError) throw new Error(`export plan: ${planError.message}`);
  const plan = (planData ?? []) as PlanRow[];

  const rowCounts: Record<string, number> = {};
  const withheld: ExportWithholding[] = [];
  // RR4. A table with no foreign key has no catalogue row, so the plan loop
  // below can never produce a `withheld` entry for it -- see
  // REMAINDER_WITHHELD's header. These are the ones that hold something about
  // a person and are excluded anyway, and they are stated here so the archive
  // answers for them like every other exclusion.
  for (const entry of REMAINDER_WITHHELD) {
    withheld.push({ what: `public.${entry.table}`, reason: "table_excused", detail: entry.detail });
  }
  const files: { path: string; bytes: number }[] = [];
  let totalRows = 0;

  for (const entry of plan) {
    if (entry.disposition === "excused") {
      withheld.push({
        what: `public.${entry.table_name}`,
        reason: "table_excused",
        detail: entry.reason ?? WITHHOLDING_COPY.table_excused,
      });
      continue;
    }
    if (entry.authorisation === "elevated" && entry.table_name === "audit_events") {
      withheld.push({
        what: "public.audit_events.before / .after",
        reason: "audit_payload_withheld",
        detail: WITHHOLDING_COPY.audit_payload_withheld,
      });
    }

    // KEEP THE ROWS only for the two tables whose FILES are fetched from
    // them. Everything else is serialised straight to bytes as it arrives and
    // never held as objects — see writeTable's header.
    const keepRows =
      (job.kind === "workspace" && entry.table_name === "documents") ||
      (job.kind === "account" && entry.table_name === "feedback");

    // THE KEY COLUMN IS THE CATALOGUE'S, not this file's. It arrives in the
    // plan (20260928003000) because private.export_page_sql() builds the
    // `order by` and the `> $2` predicate from the same declaration, and one
    // fact with two homes is what this runner is built to avoid — it holds no
    // table list and no ceilings for exactly that reason.
    //
    // `typeof`, not `=== null`: an older public.export_plan() that does not
    // SELECT the column at all returns `undefined` here rather than null, and
    // that must fail loudly rather than page once on `row[undefined]` and then
    // raise the cursor-did-not-advance error two screens away.
    if (typeof entry.key_column !== "string" || entry.key_column === "") {
      throw new Error(
        `export plan: public.${entry.table_name} is exported with no key column. private.export_catalogue_is_sound() refuses that shape, so the catalogue and the plan disagree — or public.export_plan() is an older definition that does not return it.`,
      );
    }

    const written = await writeTable(
      supabase,
      zip,
      job.id,
      entry.table_name,
      entry.key_column,
      limits,
      keepRows,
      generatedAt,
    );
    totalRows += written.count;
    if (totalRows > limits.max_total_rows) {
      throw new Error(
        `The export passed its ${limits.max_total_rows}-row ceiling at public.${entry.table_name}. Nothing was truncated: the export failed instead.`,
      );
    }
    rowCounts[entry.table_name] = written.count;

    if (job.kind === "workspace" && entry.table_name === "documents") {
      await addDocumentBytes(zip, written.rows, withheld, files, generatedAt);
    }
    if (job.kind === "account" && entry.table_name === "feedback") {
      await addScreenshotBytes(zip, written.rows, withheld, files, generatedAt);
    }
  }

  const manifest: ExportManifest = {
    schemaVersion: EXPORT_MANIFEST_VERSION,
    kind: job.kind,
    jobId: job.id,
    generatedAt: generatedAt.toISOString(),
    subject: { userId: job.requested_by, organisationId: job.organisation_id },
    rowCounts,
    files,
    withheld,
    notes: [
      job.kind === "workspace"
        ? "Every table in this archive was read with the access rights of the person who asked for it, so anything they cannot see in the product — a colleague's private notes, for example — is not here either."
        : "This archive is about your ACCOUNT. It does not contain the records a workspace keeps: those belong to the business that keeps them, and its Owner or Admin can export them from the workspace's own settings.",
      "Deleted records are included and carry their deleted_at timestamp.",
      "Times are UTC.",
      // Q167 CHANGED (founder 2026-09-30): say what the break-glass columns
      // mean, and only when the plan really exported the table.
      ...(job.kind === "account" &&
      plan.some((p) => p.table_name === "impersonation_sessions" && p.disposition === "exported")
        ? [SUPPORT_ACCESS_NOTE]
        : []),
    ],
  };
  zip.addJson("manifest.json", manifest, generatedAt);

  const archive = zip.finish();
  const key = exportStorageKey(job.id);

  const bucket = createStorageClient().storage.from(EXPORT_BUCKET);
  // upsert, not insert: a job that was claimed, uploaded and then failed to
  // stamp would otherwise leave an object nothing can replace. The key is
  // derived from the job id and a job is claimed once, so there is no other
  // writer to race.
  const { error: uploadError } = await bucket.upload(key, archive, {
    contentType: "application/zip",
    upsert: true,
  });
  if (uploadError) throw new Error(`export upload: ${uploadError.message}`);

  const { error: stampError } = await supabase
    .from("export_jobs")
    .update({
      status: "succeeded",
      storage_key: key,
      byte_size: archive.byteLength,
      row_count: totalRows,
      table_count: Object.keys(rowCounts).length,
      manifest: manifest as unknown as Record<string, unknown>,
    })
    .eq("id", job.id);
  if (stampError) {
    // The bytes are there and the row says `running`. Remove the orphan so a
    // retry is clean, then fail loudly.
    await bucket.remove([key]).catch(() => undefined);
    throw new Error(`export stamp: ${stampError.message}`);
  }

  if (job.kind === "account") {
    await recordFulfilment(supabase, job);
  }
}

/**
 * Write one table's rows into the archive, a page at a time.
 *
 * WHAT IS IN MEMORY AND WHY IT IS BOUNDED. Each page's rows are serialised to
 * JSON bytes as they arrive and the objects are dropped, so no table's rows
 * are ever all held as objects — except for the two tables whose FILES are
 * fetched from them (`documents`, `feedback`), which is what `keepRows` is
 * for, and where the rows are small and the row ceiling applies anyway. The
 * serialised bytes ARE held until the entry is written, and they are declared
 * to the ZipWriter through `hold()`, so they count against the same archive
 * ceiling as everything else: a table whose JSON alone would blow the ceiling
 * fails the job there rather than being discovered after the deflate.
 *
 * PAGINATION IS KEYSET, never OFFSET. The cursor is the last row's key column
 * as TEXT, which is what private.export_page_sql orders on; a page shorter
 * than the page size is the last one; and a cursor that does not advance is a
 * refusal rather than an infinite loop or a quietly short table.
 */
async function writeTable(
  supabase: ServiceClient,
  zip: ZipWriter,
  jobId: string,
  table: string,
  keyColumn: string,
  limits: Limits,
  keepRows: boolean,
  at: Date,
): Promise<{ count: number; rows: Record<string, unknown>[] }> {
  const chunks: Buffer[] = [Buffer.from("[\n", "utf8")];
  let held = chunks[0].length;
  zip.hold(held);

  const kept: Record<string, unknown>[] = [];
  let count = 0;
  let after = "";

  try {
    for (;;) {
      const { data, error } = await supabase.rpc("export_read_page", {
        p_job_id: jobId,
        p_table: table,
        p_after: after,
        p_limit: limits.page_size,
      });
      if (error) throw new Error(`export read ${table}: ${error.message}`);
      const page = (data ?? []) as Record<string, unknown>[];
      if (page.length === 0) break;

      for (const row of page) {
        const piece = Buffer.from(
          `${count === 0 ? "" : ",\n"}${JSON.stringify(row)}`,
          "utf8",
        );
        chunks.push(piece);
        held += piece.length;
        zip.hold(piece.length);
        if (keepRows) kept.push(row);
        count += 1;
      }

      if (count > limits.max_rows_per_table) {
        throw new Error(
          `public.${table} has more than the ${limits.max_rows_per_table}-row ceiling for one table. Nothing was truncated: the export failed instead.`,
        );
      }
      if (page.length < limits.page_size) break;

      const cursor = cursorOf(page[page.length - 1], keyColumn);
      if (cursor === null || cursor === after) {
        throw new Error(`export read ${table}: the page cursor did not advance`);
      }
      after = cursor;
    }

    const tail = Buffer.from("\n]\n", "utf8");
    chunks.push(tail);
    held += tail.length;
    zip.hold(tail.length);
  } catch (cause) {
    zip.releaseHold(held);
    throw cause;
  }

  // Release BEFORE writing: the held bytes and the entry are the same bytes,
  // and counting them twice would fail a job that fits.
  zip.releaseHold(held);
  zip.addEntry(`tables/${table}.json`, Buffer.concat(chunks), at);
  return { count, rows: kept };
}

/**
 * The key column's value, as the pager's cursor type.
 *
 * THE COLUMN IS THE CATALOGUE'S, passed down from `public.export_plan()`.
 * This used to be `row.id ?? row.user_id` — the two key columns the catalogue
 * happens to use today, hard-coded here as well as declared there (review
 * finding M9). A third key column added later paged correctly for the first
 * 500 rows and then raised `the page cursor did not advance`.
 *
 * `private.export_catalogue_is_sound()` guarantees the key column is a real
 * column and that it survives the projection, so the value is always present.
 */
function cursorOf(row: Record<string, unknown>, keyColumn: string): string | null {
  const candidate = row[keyColumn];
  return typeof candidate === "string" ? candidate : null;
}

async function addDocumentBytes(
  zip: ZipWriter,
  rows: Record<string, unknown>[],
  withheld: ExportWithholding[],
  files: { path: string; bytes: number }[],
  at: Date,
): Promise<void> {
  const bucket = createStorageClient().storage.from("documents");
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : null;
    const key = typeof row.storage_key === "string" ? row.storage_key : null;
    const name = typeof row.filename === "string" ? row.filename : "document";
    if (id === null || key === null) continue;

    if (row.scan_status !== "clean") {
      withheld.push({
        what: `documents/${id} (${sanitiseFilename(name)})`,
        reason: "document_not_clean",
        detail: `${WITHHOLDING_COPY.document_not_clean} Scan status: ${String(row.scan_status)}.`,
      });
      continue;
    }

    const bytes = await downloadBytes(bucket, key);
    if (bytes === null) {
      withheld.push({
        what: `documents/${id} (${sanitiseFilename(name)})`,
        reason: "document_not_clean",
        detail:
          "This file's record is included but its bytes could not be read from storage when the archive was built.",
      });
      continue;
    }
    const path = `files/documents/${id}-${sanitiseFilename(name)}`;
    zip.addEntry(path, bytes, at);
    files.push({ path, bytes: bytes.length });
  }
}

async function addScreenshotBytes(
  zip: ZipWriter,
  rows: Record<string, unknown>[],
  withheld: ExportWithholding[],
  files: { path: string; bytes: number }[],
  at: Date,
): Promise<void> {
  const bucket = createStorageClient().storage.from("feedback-screenshots");
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : null;
    const status = row.screenshot_scan_status;
    if (id === null || status === null || status === undefined) continue;

    if (status !== "clean") {
      withheld.push({
        what: `feedback/${id}`,
        reason: "screenshot_not_clean",
        detail: `${WITHHOLDING_COPY.screenshot_not_clean} Scan status: ${String(status)}.`,
      });
      continue;
    }
    // The key is `feedback/{id}` by a database CHECK, so it is derived rather
    // than carried: the catalogue deliberately projects screenshot_key away.
    const bytes = await downloadBytes(bucket, `feedback/${id}`);
    if (bytes === null) continue;
    const path = `files/feedback/${id}`;
    zip.addEntry(path, bytes, at);
    files.push({ path, bytes: bytes.length });
  }
}

type Bucket = ReturnType<ReturnType<typeof createStorageClient>["storage"]["from"]>;

async function downloadBytes(bucket: Bucket, key: string): Promise<Uint8Array | null> {
  const { data, error } = await bucket.download(key);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Wake the data subject register's export seam.
 *
 * THE TWO COLUMNS THE GRANT NAMES, AND NOTHING ELSE. Every other rule is the
 * database's: `private.data_subject_requests_before_update()` refuses a seam
 * write on a closed request, for a kind the request's right does not name, or
 * from any session with a person on it, and stamps
 * `fulfilment_recorded_at` itself — which is why that column is outside the
 * grant.
 *
 * `requested_at <= the job's requested_at` is the brief's rule that the
 * export must have been asked for AFTER the request was: an archive built
 * before someone asked for their data is not an answer to that asking.
 *
 * `access` and `portability` are the two rights whose fulfilment kind is
 * `export`. That mapping lives in `private.dsr_rights()` and is mirrored in
 * `lib/dsr/contract.ts`, which an integration test binds to it — and a drift
 * cannot write a wrong seam anyway, because the trigger refuses a kind the
 * right does not name.
 */
async function recordFulfilment(supabase: ServiceClient, job: ClaimedJob): Promise<void> {
  const { error } = await supabase
    .from("data_subject_requests")
    .update({ fulfilment_kind: "export", fulfilment_reference: job.id })
    .eq("user_id", job.requested_by)
    .eq("subject_scope", "account")
    .in("right_type", ["access", "portability"])
    .in("status", ["open", "in_progress", "routed"])
    .lte("requested_at", job.requested_at);
  if (error) {
    // Not fatal to the export: the archive exists and the person can download
    // it. What it costs is that the operator cannot yet mark the statutory
    // request answered, which is visible on their own queue.
    console.error(`[export] job ${job.id}: the fulfilment seam was not recorded:`, error.message);
  }
}
