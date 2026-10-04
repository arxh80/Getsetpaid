-- PHASE 8 TASK 9b, JOB 3 -- A LIVE COMMENT MADE FALSE BY 20261016000000.
--
-- public.tasks.reminder_at's column comment (20260902000000) says "STORED
-- ONLY. There is no reminder delivery mechanism at MVP (Q45) -- no scheduler,
-- no notifier, no worker." Since 20261016000000 (founder 2026-09-30,
-- Q157(3)/Q174/Q45) there is: the existing pg_cron tick emails the assignee.
-- Standing lesson 5: a committed migration is immutable, so the comment is
-- REISSUED here rather than edited there. Comment only; nothing else moves.
--
-- A correction of record for 20261016000000's `--` header, which is not a live
-- object and so cannot be reissued: it cites the PRD as "§ 6/§ 9"; the
-- sections are "Network requirements" (connection requests) and § 6.6 (a
-- task's "owner" and "reminder").

comment on column public.tasks.reminder_at is
  'WHEN THE ASSIGNEE IS EMAILED (since 20261016000000; founder 2026-09-30, Q157(3)/Q174/Q45). Constrained <= due_at. Once it has passed, the existing pg_cron tick (POST /api/incident-alerts/deliver, lib/email/task-reminder-notifications.ts) emails the task''s CURRENT assignee (owner_user_id) while they are an active member of the workspace, with the title, the due date and one link to the task -- never `detail`. Not sent for a task that is done, cancelled or deleted when it falls due, nor for one with no assignee (Q202); not sent more than seven days late. Sent once per task, recorded in private.notification_deliveries only after Brevo accepted it (ok:true). Replaces 20260902000000''s "STORED ONLY" comment.';
