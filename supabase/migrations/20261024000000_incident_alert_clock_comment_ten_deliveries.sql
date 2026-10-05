-- Phase 8 Task 9c job 3b (Q213): reissue the live comment on
-- private.deliver_incident_alerts().
--
-- Job 2b (TypeScript only) added the two workspace-closure deliveries to
-- /api/incident-alerts/deliver -- the superuser's "a workspace was closed by
-- its Owner" notice and the remaining admins' "the superuser decided" notice
-- -- and, to keep the route inside its 600 s cadence, cut
-- REQUESTER_NOTICE_BUDGET_MS from 60 s to 45 s (Q204). The comment
-- 20261016000000 left on the function still said EIGHT deliveries and
-- ~440 s, which is now false on both counts (standing lesson 8: docs drift is
-- a finding).
--
-- A `comment on` statement only (standing lesson 5): the function body is
-- unchanged, so it is not rebuilt.

comment on function private.deliver_incident_alerts() is
  'THE INCIDENT-ALERT CLOCK''S BODY (founder ruling Q118). Runs from pg_cron every 10 minutes and POSTs /api/incident-alerts/deliver with the bearer. That route runs TEN independent deliveries, each with its own stamp: the operator''s email digest (`notified_at`), the counts-only Telegram alert (`telegram_notified_at`, Q111, 20261014000000), the per-account lockout email (`account_notified_at`, Q114), the requester''s DSR received/closed notices (`data_subject_requests.received_notified_at` / `closed_notified_at`), the requester''s export-ready notice (`export_jobs.ready_notified_at`) and the superuser''s erasure-failure notice (`erasure_jobs.failure_notified_at`) since 20261015000000, the connection-request received/accepted/declined notices and the task reminder since 20261016000000, and since 20261022001000 the superuser''s workspace-closed notice and the remaining Owners/Admins'' closure-decision notice (both rows in private.notification_deliveries, keyed on audit_event_id) -- all founder 2026-09-30, Q157(3)/Q174/Q45/Q176/Q178. The URL and the bearer come from Supabase Vault (`incident_alert_delivery_url` / `incident_alert_delivery_secret`), created by hand once per environment and NEVER by a migration -- with either missing this function returns without building a request, which is what local dev and CI do on every tick. SECURITY DEFINER for the Vault read; granted to no client role. Failure needs no handling: each sender stamps nothing on a failed send, so the next tick retries the identical set for that channel alone. OVERLAP is ruled out in the ROUTE: one 10-second Brevo call for the digest, one 10-second Telegram call, the lockout loop capped at 30 accounts and a 120-second budget (~130 s), one 10-second call for the erasure-failure notice, and six notice loops (DSR, export-ready, connection request, task reminder, workspace closed, closure decision) each capped at 30 rows and a 45-second budget (REQUESTER_NOTICE_BUDGET_MS, Q204; ~55 s each with one in-flight 10-second send), so the worst case is ~490 s against a 600 s cadence. An advisory lock HERE would not help -- net.http_post is fire-and-forget, so this function returns before the route runs.';
