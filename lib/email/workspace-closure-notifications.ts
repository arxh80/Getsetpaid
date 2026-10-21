import "server-only";

// THE WORKSPACE-CLOSURE NOTICES -- founder 2026-09-30, Q176/Q178 (changed,
// reversing Q104), through the ONE Brevo sender. Content:
// lib/email/workspace-closure-templates.ts; database half: 20261022001000
// (the two service_role resolvers, the ledger's audit_event_id branch and
// mark_notices_delivered / mark_notices_undeliverable).
//
//   * deliverWorkspaceClosureNotifications -- one email per
//     organisation.closed_by_owner audit row, to SUPPORT_CONTACT_EMAIL (the
//     erasure-failure notice's inbox, the one superuser).
//   * deliverWorkspaceDecisionNotifications -- one email per
//     organisation.closure_reassigned / .closure_deleted audit row, to the
//     remaining active Owners and Admins SNAPSHOTTED ON THAT ROW (the purge
//     cascades memberships, so the live set may be gone). The resolver turns
//     the snapshot's user ids into addresses; nothing here takes an address
//     from anywhere else, and several recipients are Bcc'd (deliverEach, m5).
//
// Delivery, stamping and bounds are lib/email/network-notifications.ts's: the
// existing pg_cron tick, the shared deliverEach loop (30 per tick and the
// shared per-loop budget), a stamp written ONLY after ok:true through
// public.mark_notices_delivered(), a deterministic refusal (builder refused,
// nobody to send to) recorded once as undeliverable, a transient failure left
// for the next tick.
//
// THE SUPPORT INBOX UNSET IS NOT A DETERMINISTIC REFUSAL. It is a deployment
// setting, not a property of the row: nothing is sent and nothing -- not even
// "undeliverable" -- is recorded, so the closures are emailed once it is set
// (inside the resolver's seven-day window). Same as the erasure-failure
// notice.

import {
  deliverEach,
  REQUESTER_NOTICE_LIMIT,
  type NoticeRefusal,
  type Pending,
  type RequesterNoticeResult,
} from "@/lib/email/requester-notifications";
import { supportContactEmail } from "@/lib/email/feedback-notification";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import {
  buildWorkspaceClosedNotice,
  buildWorkspaceDecisionNotice,
  type WorkspaceDecision,
} from "@/lib/email/workspace-closure-templates";

type ClosureNotice = "workspace_closed" | WorkspaceDecision;

function stampOne(notice: ClosureNotice, auditEventId: string) {
  return async () => {
    const service = createServiceClient();
    const { data, error } = await service.rpc("mark_notices_delivered", {
      p_notice: notice,
      p_subject_ids: [auditEventId],
    });
    if (error) return { error: { message: error.message } };
    if (data !== 1) return { error: { message: `stamped ${String(data)} of 1` } };
    return { error: null };
  };
}

function refuseOne(notice: ClosureNotice, auditEventId: string) {
  return async (reason: NoticeRefusal) => {
    const service = createServiceClient();
    const { error } = await service.rpc("mark_notices_undeliverable", {
      p_notice: notice,
      p_subject_ids: [auditEventId],
      p_reason: reason,
    });
    return { error: error ? { message: error.message } : null };
  };
}

interface ClosurePendingRow {
  readonly audit_event_id: string;
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly closed_at: string;
}

export async function deliverWorkspaceClosureNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_workspace_closure_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] workspace-closure notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const pending = (data ?? []) as ClosurePendingRow[];
  if (pending.length === 0) return { outcome: "nothing_pending" };

  const to = supportContactEmail();
  if (!to) {
    console.error(`[email] ${pending.length} workspace closure(s) pending and SUPPORT_CONTACT_EMAIL is not set; nothing sent, nothing recorded.`);
    return { outcome: "delivered", sent: 0, failed: pending.length, deferred: 0 };
  }

  const origin = siteUrl();
  const rows = pending.map((row): Pending => ({
    id: row.audit_event_id,
    to: [to],
    // FOUR FIELDS, by name -- never a spread of the row.
    build: () =>
      buildWorkspaceClosedNotice({
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        closedAt: row.closed_at,
        siteUrl: origin,
      }),
    stamp: stampOne("workspace_closed", row.audit_event_id),
    refuse: refuseOne("workspace_closed", row.audit_event_id),
  }));
  return deliverEach("workspace-closure notice", rows);
}

interface DecisionPendingRow {
  readonly audit_event_id: string;
  readonly notice: WorkspaceDecision;
  readonly emails: string[] | null;
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly decided_at: string;
}

export async function deliverWorkspaceDecisionNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_workspace_decision_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] workspace-decision notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as DecisionPendingRow[]).map((row): Pending => ({
    id: row.audit_event_id,
    // THE SNAPSHOT, and only the snapshot. An empty one (every snapshotted
    // admin since erased) is a terminal no_recipient, recorded by deliverEach.
    to: row.emails ?? [],
    build: () =>
      buildWorkspaceDecisionNotice({
        decision: row.notice,
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        decidedAt: row.decided_at,
        siteUrl: origin,
      }),
    stamp: stampOne(row.notice, row.audit_event_id),
    refuse: refuseOne(row.notice, row.audit_event_id),
  }));
  return deliverEach("workspace-decision notice", rows);
}
