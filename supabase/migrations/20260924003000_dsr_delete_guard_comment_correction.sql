-- ===========================================================================
-- Phase 8 Task 3: a comment correction, not a behaviour change.
--
-- `20260924000000`'s comment on private.data_subject_requests_delete_guard()
-- says "whether erasure should keep them, anonymised, is Q157 for Task 5".
-- It is Q158: Q157 was taken by the two proposed NUMBERS that task queued
-- (the 10-per-24-hours submission budget and the 7-day early warning), which
-- `20260924001000` already cites by that number. Two live objects cannot both
-- be right about one question number, and a committed migration is immutable.
--
-- The `20260904007000` / `20260920000000` precedent applies exactly: a
-- `comment on` statement names a live database object, so a later migration
-- can additively reissue it, and that reissue is the correction of record.
-- (Contrast the `20260904002000` case, where the wrong sentence was a plain
-- `--` script comment with no database object behind it and could only be
-- corrected in prose.)
--
-- Nothing about the guard's behaviour changes; the function body is untouched.
-- ===========================================================================

comment on function private.data_subject_requests_delete_guard() is
  'BEFORE DELETE on public.data_subject_requests, for EVERY role including postgres: refuses every delete except one run by a foreign key''s cascade (the auth account being deleted). A request and its outcome are what prove a statutory deadline was met; whether erasure should keep them, anonymised, is **Q158** for Task 5 (the sibling of Q148 for consents). Q157 is a different question -- the two proposed numbers, the 10-per-24-hours submission budget and the 7-day early warning -- and 20260924000000''s original comment cited it here by mistake.';
