// THE TASK-REMINDER NOTICE, AS A PURE BUILDER WITH AN ALLOWLIST.
//
// Founder 2026-09-30, Q157(3)/Q174/Q45; the delivery half is
// lib/email/task-reminder-notifications.ts, the database half 20261016000000.
//
// THE CONTENT RULE: the task's title and due date -- the assignee reads both
// on the task's own page -- and ONE link, to that page. Never the task's
// `detail`, its links, or anyone else's name. Enforced on every render: an
// input key outside TASK_REMINDER_ALLOWLIST, or any URL but the one link,
// throws before anything is sent.
//
// No "server-only" and no I/O: tests/unit/email drives it.

import type { EmailBody } from "@/lib/email/templates";
import { NoticeContentError } from "@/lib/email/requester-templates";
import {
  assertInputAllowlisted,
  assertOnlyLink,
  oneLine,
  origin,
  render,
  slugOrRefuse,
  ukDateTime,
  UUID,
} from "@/lib/email/notice-render";

/** The ONLY keys the reminder's input may carry. */
export const TASK_REMINDER_ALLOWLIST = ["taskId", "title", "dueAt", "organisationSlug", "siteUrl"] as const;

export interface TaskReminderInput {
  readonly taskId: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly organisationSlug: string;
  readonly siteUrl: string;
}

export function buildTaskReminderNotice(input: TaskReminderInput): EmailBody {
  assertInputAllowlisted("taskReminder", TASK_REMINDER_ALLOWLIST, input);
  const slug = slugOrRefuse("taskReminder", input.organisationSlug);
  if (!UUID.test(input.taskId)) throw new NoticeContentError("taskReminder notice refused: not a task id");
  const link = `${origin(input.siteUrl)}/${slug}/tasks/${input.taskId}`;
  // A title that neutralises to nothing (`https://`, `www.`) renders as a
  // placeholder rather than refusing: a refusal here was a poison row (I2).
  const title = oneLine(input.title, 200) || "Untitled task";
  const body = render(
    `Reminder: ${title}`,
    [
      `A reminder was set on this task, which is assigned to you: ${title}.`,
      input.dueAt ? `It is due ${ukDateTime(input.dueAt)}.` : "It has no due date.",
    ],
    link,
    "Open the task",
  );
  assertOnlyLink("taskReminder", body, link);
  return body;
}
