-- Phase 8 Task 9a fix round 1, review finding m1: CORRECT THE PROVENANCE IN
-- private.export_catalogue()'s LIVE COMMENT.
--
-- 20261009000000 rebuilt the catalogue for Q167 and said, in both its header
-- ("pg_get_functiondef as left by 20260930007000") and its `comment on
-- function` ("Everything else is as 20260930007000 left it"), that its base
-- was 20260930007000. That is wrong. The latest definition at the time was
-- 20261003010000_retention_tables_meet_the_house_invariants.sql, which added
-- the ACCOUNT `retention_settings` excused row -- and the rebuilt body DOES
-- carry that row, so the function is right and only the provenance is wrong.
--
-- The header of 20261009000000 is a plain `--` comment in a shipped,
-- immutable migration and is left as written; this file and the Task 9a
-- report's "Fix round 1" section are the correction of record for it. The
-- `comment on function` is a live database object, so it is reissued here
-- (standing lesson 5). No body changes; nothing else is touched.

comment on function private.export_catalogue() is
  'WHAT AN EXPORT CONTAINS, one row per (kind, table), re-issued in 20261009000000 (founder 2026-09-30, Q167 CHANGED): the ACCOUNT export''s impersonation_sessions projection now includes the operator''s break-glass `reason` and `superuser_user_id` for every session the requester accepted or declined, and still nothing for a session they did not decide. Everything else is as 20261003010000 left it (this comment corrected in 20261012000000; an earlier version named 20260930007000, which was not the base): every WORKSPACE read is `requester_rls` without exception, four ACCOUNT tables are `elevated` because no client session could read them at all, the ACCOUNT retention_settings row is excused, and every elevated row carries a projection (a rule private.export_catalogue_is_sound() enforces). The catalogue is bound to a foreign-key walk of the live schema in both directions by tests/integration/export/completeness-census.test.ts and rls_phase8_exports.sql section XC, so a table that joins the schema and neither disposition is a red test naming itself.';
