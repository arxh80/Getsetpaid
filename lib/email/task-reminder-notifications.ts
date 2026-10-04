import "server-only";

// THE TASK REMINDER AT reminder_at -- founder 2026-09-30, Q157(3)/Q174/Q45,
// through the ONE Brevo sender. Content: lib/email/task-reminder-template.ts;
// database half: 20261016000000. Delivery, stamping and bounds are exactly
// lib/email/network-notifications.ts's (read its header): the existing
// pg_cron tick (a reminder has no writer at the moment it falls due, only the
// clock), stamp only after ok:true through public.mark_notices_delivered(),
// 30 per tick and a 60-second budget.
//
// THE REMINDER FOLLOWS THE TASK AS IT IS NOW. A task COMPLETED, CANCELLED,
// DELETED or REASSIGNED away from an active member before it falls due is not
// reminded: public.pending_task_reminder_notifications() reads the task's
// current state and current assignee at send time, and the stamp RPC refuses
// a task that is no longer open, live and due. Nothing is stamped for a
// reminder that was not sent -- "never emailed" is the honest record -- so a
// task reopened while its reminder_at is still inside the seven-day window is
// reminded then. One reminder per task: once sent, a later change to
// reminder_at does not re-arm it (Q202). A task with NO assignee is reminded
// to nobody (Q202).

import {
  deliverEach,
  REQUESTER_NOTICE_LIMIT,
  type Pending,
  type RequesterNoticeResult,
} from "@/lib/email/requester-notifications";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import { buildTaskReminderNotice } from "@/lib/email/task-reminder-template";

function stampOne(id: string) {
  return async () => {
    const service = createServiceClient();
    const { data, error } = await service.rpc("mark_notices_delivered", {
      p_notice: "task_reminder",
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

interface TaskReminderPendingRow {
  readonly task_id: string;
  readonly email: string;
  readonly organisation_slug: string;
  readonly title: string;
  readonly due_at: string | null;
}

export async function deliverTaskReminderNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_task_reminder_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] task reminders could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as TaskReminderPendingRow[]).map((row): Pending => ({
    id: row.task_id,
    to: [row.email],
    build: () =>
      buildTaskReminderNotice({
        taskId: row.task_id,
        title: row.title,
        dueAt: row.due_at,
        organisationSlug: row.organisation_slug,
        siteUrl: origin,
      }),
    stamp: stampOne(row.task_id),
  }));
  return deliverEach("task reminder", rows);
}
