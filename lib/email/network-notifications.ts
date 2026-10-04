import "server-only";

// THE CONNECTION-REQUEST NOTICES (received / accepted / declined) -- founder 2026-09-30,
// Q157(3)/Q174/Q45: "build all notification emails", through the ONE Brevo
// sender (lib/email/send.ts). Content: lib/email/network-notice-templates.ts. The task reminder rides
// the same machinery in lib/email/task-reminder-notifications.ts.
// Database half: 20261016000000.
//
// ===========================================================================
// DELIVERY: THE EXISTING TICK, NOT THE WRITE PATH
// ===========================================================================
// A connection request is sent, accepted and declined by a person in a server
// action, so a synchronous send WAS possible for those three -- and was
// rejected: the action must never wait on (or fail with) Brevo, a send from
// the action would still need a retry for the send that failed, and the
// write path is not the only writer (network_connection_requests carries a
// client INSERT/UPDATE grant -- a request POSTed straight to PostgREST would
// never be announced). A `not yet in private.notification_deliveries` read on
// the pg_cron tick covers every writer and retries by construction. A task
// reminder has no writer at all at the moment it falls due -- only the clock
// -- so it can only be the tick. One path for all four. The cost is latency:
// up to one 10-minute tick after the event (or after reminder_at).
//
// ===========================================================================
// STAMP ONLY AFTER ok:true, AND THE REMINDER FOLLOWS THE TASK AS IT IS NOW
// ===========================================================================
// deliverEach (shared with the DSR/export notices) stamps a notice ONLY after
// sendEmail() answered ok:true, as the last statement for that notice; a
// failed send stamps nothing and the next tick sends it again. The stamp is
// public.mark_notices_delivered() -- service_role only, refusing every
// session -- and it stamps ONLY a subject still in the state its email is
// about, so a stamp can never be written ahead of its event.
//
// A reminder for a task that was COMPLETED, CANCELLED, DELETED or REASSIGNED
// away from a member before it fell due is not sent: the resolver reads the
// task's current state and current assignee at send time. Nothing is stamped
// for it either -- "never emailed" is the honest record -- and if the task is
// reopened while its reminder_at is still inside the seven-day window, the
// reminder is owed again (Q202).
//
// RECIPIENTS ARE THE DATABASE'S: public.pending_connection_request_notifications()
// and public.pending_task_reminder_notifications() resolve every address
// through an ACTIVE membership, service_role only, no user argument. Nothing
// here takes an address from anywhere else, and nothing here logs one.
//
// ===========================================================================
// BOUNDED, BECAUSE THE TICK IS SHARED
// ===========================================================================
// Each loop: 30 notices and a 60-second wall-clock budget checked BEFORE each
// send (~70 s worst case each, REQUESTER_NOTICE_BUDGET_MS and _LIMIT). The
// route's worst case becomes ~440 s against the 600 s cadence (20261016000000
// reissues the clock function's comment with that number).

import {
  deliverEach,
  REQUESTER_NOTICE_LIMIT,
  type Pending,
  type RequesterNoticeResult,
} from "@/lib/email/requester-notifications";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import {
  buildConnectionAcceptedNotice,
  buildConnectionDeclinedNotice,
  buildConnectionReceivedNotice,
} from "@/lib/email/network-notice-templates";

export type ConnectionNotice = "connection_received" | "connection_accepted" | "connection_declined";

interface ConnectionPendingRow {
  readonly request_id: string;
  readonly notice: ConnectionNotice;
  readonly emails: string[] | null;
  readonly organisation_slug: string;
  readonly counterparty_name: string | null;
}

const CONNECTION_BUILDERS = {
  connection_received: buildConnectionReceivedNotice,
  connection_accepted: buildConnectionAcceptedNotice,
  connection_declined: buildConnectionDeclinedNotice,
} as const;

function stampOne(notice: ConnectionNotice, id: string) {
  return async () => {
    const service = createServiceClient();
    const { data, error } = await service.rpc("mark_notices_delivered", {
      p_notice: notice,
      p_subject_ids: [id],
    });
    if (error) return { error: { message: error.message } };
    // 0 = the subject left the state its email is about between the read and
    // the stamp. Reported as a failure so it is visible; the resolver will not
    // offer it again, so it is not re-sent.
    if (data !== 1) return { error: { message: `stamped ${String(data)} of 1 (the subject's state changed)` } };
    return { error: null };
  };
}

export async function deliverConnectionRequestNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_connection_request_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] connection-request notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as ConnectionPendingRow[]).map((row): Pending => ({
    id: `${row.notice}:${row.request_id}`,
    to: row.emails ?? [],
    // THREE FIELDS, by name -- never a spread of the row.
    build: () =>
      CONNECTION_BUILDERS[row.notice]({
        counterpartyName: row.counterparty_name,
        organisationSlug: row.organisation_slug,
        siteUrl: origin,
      }),
    stamp: stampOne(row.notice, row.request_id),
  }));
  return deliverEach("connection-request notice", rows);
}
