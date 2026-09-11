-- Phase 7 Task 6, fix round 1, review finding M2: the sender's SELECT on
-- public.feedback is narrowed to the two columns it actually reads.
--
-- 20260911000000 § 2 granted `service_role` whole-table SELECT on feedback
-- "the exact split 20260909070000 gave service_role on incident_alerts". That
-- split was copied, not derived: the incident-alert sender genuinely READS
-- rows (it builds a digest from summary/type/created_at), so it needs a
-- table read. The feedback sender never reads a row. lib/email/
-- feedback-notification.ts does exactly one write --
--   update feedback set notified_at = now() where id = $1 and notified_at is null
-- -- and an UPDATE's row-matching needs SELECT on the columns in its WHERE
-- clause: `id` and `notified_at`. Nothing else.
--
-- WHY IT MATTERS: service_role is BYPASSRLS. Policies do not bind it, so the
-- 2-year retention term (a policy term) did not either, and the whole-table
-- grant handed the sender's client a read of `message`, `user_email`,
-- `route` and `user_agent` across every workspace and past retention.
-- lib/supabase/service.ts and CLAUDE.md describe that client's reach as
-- "bounded by the two column-narrow grants"; on this table the SELECT half
-- was not narrow. Now it is, and rls_phase7_feedback.sql FP6 asserts the
-- column list rather than the table privilege.
--
-- ADDITIVE (a revoke followed by a narrower grant; no applied migration is
-- edited). The UPDATE (notified_at) grant is untouched.
-- ===========================================================================

revoke select on public.feedback from service_role;
grant select (id, notified_at) on public.feedback to service_role;
