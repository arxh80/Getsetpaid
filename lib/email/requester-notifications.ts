import "server-only";

// THE DSR, EXPORT-READY AND ERASURE-FAILURE NOTICES -- founder 2026-09-30,
// Q157(3)/Q174/Q45: "build all notification emails", through the ONE Brevo
// sender (lib/email/send.ts). Content: lib/email/requester-templates.ts.
//
// ===========================================================================
// DELIVERY: THE EXISTING TICK, FOR ALL FOUR -- AND WHY NOT THE WRITE PATH
// ===========================================================================
// Every one of these is triggered by a state change the DATABASE makes, most
// of them from no person's session at all: a request is closed by the
// operator OR by the erasure job's own transaction (20261001006000); an
// export succeeds inside the export runner; an erasure fails in
// public.fail_erasure_job(). A synchronous send would have to be bolted onto
// four writers, two of them sessionless, and would still need a retry for the
// send that failed -- which is exactly what a `*_notified_at is null` read on
// the existing pg_cron tick IS. "DSR received" is the one with a person's
// request behind it, and it rides the tick too: the submission must never
// wait on (or fail with) Brevo, and one path per notice is one thing to test.
// The cost is latency: up to one 10-minute tick.
//
// ===========================================================================
// STAMP ONLY AFTER ok:true
// ===========================================================================
// The incident digest's contract, unchanged: a row's stamp is written ONLY
// after sendEmail() answered ok:true for that row's message; a failed send
// stamps nothing and the next tick sends it again. The stamp is the last
// statement for each row. The database refuses a stamp from any session, a
// second stamp, a cleared stamp, a stamp that moves anything else and a stamp
// on a row in the wrong state (private.notification_stamp_guard(),
// 20261015000000) -- so even a bug here cannot silence a notice from a
// browser, or un-send one.
//
// RECIPIENTS ARE THE DATABASE'S: public.pending_dsr_notifications() and
// public.pending_export_ready_notifications() resolve auth.users.email through
// the row's own user column, granted to service_role alone, with no user
// argument. Nothing here takes an address from anywhere else, and nothing
// here logs one -- a failed send logs the ROW id.
//
// ===========================================================================
// BOUNDED, BECAUSE THE TICK IS SHARED (the lockout notice's M1 lesson)
// ===========================================================================
// The DSR and export loops are sequential, each send carrying Brevo's 10 s
// timeout, so each is capped at 30 rows AND a 60-second wall-clock budget
// checked BEFORE each send (~70 s worst case each). With the digest (10 s),
// Telegram (10 s), the lockout loop (~130 s) and the erasure-failure notice
// (one 10 s call), the route's worst case is ~300 s against the 600 s cadence
// (20261015000000 reissues the clock function's comment with that number).
// Deferred rows are not lost: nothing is stamped for them.

import { sendEmail, type SendEmailResult } from "@/lib/email/send";
import { supportContactEmail } from "@/lib/email/feedback-notification";
import {
  buildDsrClosedNotice,
  buildDsrReceivedNotice,
  buildErasureFailureNotice,
  buildExportReadyNotice,
} from "@/lib/email/requester-templates";
import type { EmailBody } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";

export const REQUESTER_NOTICE_LIMIT = 30;
export const REQUESTER_NOTICE_BUDGET_MS = 60_000;
export const ERASURE_FAILURE_NOTICE_LIMIT = 200;

export type RequesterNoticeResult =
  | { readonly outcome: "nothing_pending" }
  | {
      readonly outcome: "delivered";
      readonly sent: number;
      readonly failed: number;
      readonly deferred: number;
    }
  | { readonly outcome: "unavailable"; readonly error: string };

export type ErasureFailureNoticeResult =
  | { readonly outcome: "nothing_pending" }
  | { readonly outcome: "sent"; readonly count: number }
  | { readonly outcome: "failed"; readonly count: number; readonly error: string }
  | { readonly outcome: "unavailable"; readonly error: string };

export interface Pending {
  /** For the log line and the stamp -- never an address. */
  readonly id: string;
  /** One or more recipients of ONE message (job 3's connection notices go to a workspace's owners and admins together). */
  readonly to: readonly string[];
  readonly build: () => EmailBody;
  readonly stamp: () => Promise<{ error: { message: string } | null }>;
  /**
   * Records a DETERMINISTIC refusal (the builder refused, or there is nobody
   * to send to) as terminal, so the row leaves its queue instead of being
   * offered on every tick for seven days (Task 9b review I2). Present on the
   * ledger-backed queues (connection requests, task reminders); a queue
   * without it (the DSR and export notices, whose content is the database's
   * own enums and dates) keeps the old retry behaviour for a refusal.
   */
  readonly refuse?: (reason: NoticeRefusal) => Promise<{ error: { message: string } | null }>;
}

export type NoticeRefusal = "content_refused" | "no_recipient";

async function recordRefusal(label: string, row: Pending, reason: NoticeRefusal): Promise<void> {
  if (!row.refuse) return;
  const { error } = await row.refuse(reason);
  if (error) {
    console.error(`[email] ${label} ${row.id}: refusal (${reason}) not recorded; it will be offered again:`, error.message);
  } else {
    console.error(`[email] ${label} ${row.id}: recorded undeliverable (${reason}); it leaves the queue`);
  }
}

/** The bounded, stamp-after-ok loop every per-row notice shares (job 3 reuses it). */
export async function deliverEach(label: string, rows: readonly Pending[]): Promise<RequesterNoticeResult> {
  if (rows.length === 0) return { outcome: "nothing_pending" };
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  const startedAt = Date.now();

  for (const [index, row] of rows.entries()) {
    if (Date.now() - startedAt >= REQUESTER_NOTICE_BUDGET_MS) {
      deferred = rows.length - index;
      console.error(`[email] ${label}: wall-clock budget spent with ${deferred} unsent; nothing stamped for them, the next tick retries`);
      break;
    }

    if (row.to.length === 0) {
      failed += 1;
      console.error(`[email] ${label} ${row.id}: no recipient, nothing sent, nothing stamped`);
      await recordRefusal(label, row, "no_recipient");
      continue;
    }

    let body: EmailBody;
    try {
      body = row.build();
    } catch (err) {
      failed += 1;
      console.error(`[email] ${label} ${row.id}: content refused, nothing sent, nothing stamped:`, err instanceof Error ? err.message : String(err));
      // Deterministic: the same row would refuse on every tick. Terminal.
      await recordRefusal(label, row, "content_refused");
      continue;
    }

    let result: SendEmailResult;
    try {
      result = await sendEmail({ to: row.to.map((email) => ({ email })), subject: body.subject, html: body.html, text: body.text });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.name : "unknown error" };
    }
    if (!result.ok) {
      failed += 1;
      console.error(`[email] ${label} ${row.id} failed; nothing stamped, re-sendable:`, result.error);
      continue;
    }

    // THE STAMP -- last, for this row only, only after ok:true.
    const { error: stampError } = await row.stamp();
    if (stampError) {
      failed += 1;
      console.error(`[email] ${label} ${row.id} sent but not stamped; the next run will re-send:`, stampError.message);
      continue;
    }
    sent += 1;
  }

  return { outcome: "delivered", sent, failed, deferred };
}

interface DsrPendingRow {
  readonly request_id: string;
  readonly notice: "received" | "closed";
  readonly email: string;
  readonly reference: number;
  readonly right_type: string;
  readonly status: string;
  readonly due_by: string;
}

export async function deliverDsrNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_dsr_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] DSR notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as DsrPendingRow[]).map((row): Pending => {
    const column = row.notice === "received" ? "received_notified_at" : "closed_notified_at";
    return {
      id: `${row.notice}:${row.request_id}`,
      to: [row.email],
      build: () =>
        row.notice === "received"
          ? buildDsrReceivedNotice({ reference: row.reference, rightType: row.right_type, dueBy: row.due_by, siteUrl: origin })
          : buildDsrClosedNotice({ reference: row.reference, rightType: row.right_type, status: row.status, siteUrl: origin }),
      stamp: async () =>
        service
          .from("data_subject_requests")
          .update({ [column]: new Date().toISOString() })
          .eq("id", row.request_id)
          .is(column, null),
    };
  });
  return deliverEach("DSR notice", rows);
}

interface ExportPendingRow {
  readonly job_id: string;
  readonly email: string;
  readonly kind: "account" | "workspace";
  readonly organisation_slug: string | null;
  readonly expires_at: string;
}

export async function deliverExportReadyNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_export_ready_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] export-ready notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as ExportPendingRow[]).map((row): Pending => ({
    id: row.job_id,
    to: [row.email],
    // FOUR FIELDS, by name. The archive key and any URL are not in the row
    // the resolver returns, and would be refused by the builder if they were.
    build: () =>
      buildExportReadyNotice({
        kind: row.kind,
        organisationSlug: row.organisation_slug,
        expiresAt: row.expires_at,
        siteUrl: origin,
      }),
    stamp: async () =>
      service
        .from("export_jobs")
        .update({ ready_notified_at: new Date().toISOString() })
        .eq("id", row.job_id)
        .is("ready_notified_at", null),
  }));
  return deliverEach("export-ready notice", rows);
}

/**
 * ONE email to the superuser covering every failed erasure nobody has been
 * told about -- a count and a /super link, nothing else. Reads `id` only.
 */
export async function deliverErasureFailureNotifications(
  limit: number = ERASURE_FAILURE_NOTICE_LIMIT,
): Promise<ErasureFailureNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("erasure_jobs")
    .select("id")
    .eq("status", "failed")
    .is("failure_notified_at", null)
    .order("completed_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, ERASURE_FAILURE_NOTICE_LIMIT)));
  if (error) {
    console.error("[email] erasure-failure notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const ids = (data ?? []).map((row) => row.id as string);
  if (ids.length === 0) return { outcome: "nothing_pending" };

  const to = supportContactEmail();
  if (!to) {
    const message = "SUPPORT_CONTACT_EMAIL is not set";
    console.error(`[email] ${ids.length} erasure failure(s) pending and ${message}; nothing sent, nothing stamped.`);
    return { outcome: "failed", count: ids.length, error: message };
  }

  let body: EmailBody;
  try {
    body = buildErasureFailureNotice({ count: ids.length, siteUrl: siteUrl() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", count: ids.length, error: message };
  }

  const result = await sendEmail({ to: [{ email: to }], subject: body.subject, html: body.html, text: body.text });
  if (!result.ok) {
    console.error(`[email] erasure-failure notice (${ids.length} job(s)) failed; nothing stamped, re-sendable:`, result.error);
    return { outcome: "failed", count: ids.length, error: result.error };
  }

  // THE STAMP -- last, only the ids this email counted, only after ok:true.
  const { error: stampError } = await service.rpc("mark_erasure_failures_notified", { p_job_ids: ids });
  if (stampError) {
    console.error("[email] erasure-failure notice sent but not stamped; the next run will re-send:", stampError.message);
    return { outcome: "failed", count: ids.length, error: stampError.message };
  }
  return { outcome: "sent", count: ids.length };
}
