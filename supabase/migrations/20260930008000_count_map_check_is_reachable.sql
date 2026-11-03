-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, FIX: A CHECK CONSTRAINT IS EVALUATED AS THE
-- WRITING ROLE, AND ITS FUNCTION WAS REVOKED FROM EVERY CLIENT ROLE.
--
-- MEASURED, by the erasure suite's first real run against a reset database:
--
--   set role authenticated;
--   insert into public.erasure_jobs (kind) values ('account');
--   ERROR:  permission denied for function jsonb_is_count_map
--
-- `erasure_jobs_summary_is_counts` calls private.jsonb_is_count_map(), and
-- 20260930001000 § 2 revoked EXECUTE on that function from public, anon,
-- authenticated and service_role -- the house rule for a `private` helper,
-- applied here to the one kind of function it must not be applied to. A CHECK
-- constraint is evaluated with the privileges of the role performing the
-- write, not the table owner's, so the revoke made public.erasure_jobs
-- UNWRITABLE BY EVERY CLIENT ROLE. Nobody could ask for their account to be
-- deleted at all.
--
-- It would not have been caught by reading, by lint, by tsc or by any test
-- that writes as `postgres` -- which is most of them, and is exactly why the
-- suite drives the insert from a real `authenticated` session instead.
--
-- THE GRANT IS SAFE, and narrowly so: the function takes a jsonb VALUE and
-- returns a boolean about its shape. It reads no table, touches no catalogue,
-- is IMMUTABLE and PARALLEL SAFE, and discloses nothing the caller did not
-- already hand it. `service_role` is included because the runner writes the
-- summary; `anon` is not, because nothing anonymous may write this table and
-- a grant with no consumer is a standing reachable function.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

grant execute on function private.jsonb_is_count_map(jsonb) to authenticated, service_role;

comment on function private.jsonb_is_count_map(jsonb) is
  'True when a jsonb value is a FLAT object of non-negative integers, plus the three boolean flags public.erasure_jobs.summary is allowed to carry. It is a function rather than an inline CHECK because a CHECK may not contain a subquery, and the rule is a walk over every value. IT IS EXECUTABLE BY `authenticated` AND `service_role` (20260930008000) AND MUST STAY SO: a CHECK constraint is evaluated with the privileges of the role performing the write, so revoking it -- the house rule for a `private` helper -- made public.erasure_jobs unwritable by every client role and nobody could ask for their account to be deleted. It reads no table, is IMMUTABLE and PARALLEL SAFE, and discloses nothing about anything the caller did not pass in.';
