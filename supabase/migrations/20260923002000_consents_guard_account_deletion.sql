-- ===========================================================================
-- Phase 8 Task 2, fix round 1 (review finding I2):
-- the consent ledger's delete exception must prove the account is going away.
-- ===========================================================================
-- private.consents_guard() (20260923000000 § 6) let any DELETE through at
-- pg_trigger_depth() >= 2, on the reasoning that depth >= 2 is "a foreign
-- key's own cascade -- the auth account being deleted". Depth >= 2 only means
-- "some trigger issued this DELETE". Measured by the review, in a rolled-back
-- transaction: a table whose AFTER INSERT trigger ran `delete from
-- public.consents` emptied the ledger (4 rows -> 0) with both auth users still
-- present. No client-writable table has such a trigger today, but Task 5's
-- erasure work, any later migration, or an operator's ad-hoc trigger would
-- pass that door without anyone noticing.
--
-- THE FIX: a DELETE is allowed only when BOTH hold --
--   * it was issued by a trigger (depth >= 2; a DELETE statement from any
--     role or any function is depth 1 and stays refused), AND
--   * the account the row belongs to no longer exists in auth.users.
-- The ON DELETE CASCADE from auth.users runs after the auth row is gone, so
-- `exists (... where id = old.user_id)` is false there and the cascade passes
-- -- including the self-referencing cascade (a grant's deletion cascading to
-- the withdrawal that names it, depth 3), whose user is also gone. A trigger
-- deleting a LIVE user's rows is refused (42501).
--
-- The function becomes SECURITY DEFINER (owner postgres, empty search_path)
-- so the auth.users lookup answers the same way whichever role's trigger
-- issued the DELETE; before, a trigger running as a role without SELECT on
-- auth.users would have been refused only by a permission error, which is the
-- right outcome for the wrong reason. It reads one boolean and returns; it
-- writes nothing.
--
-- REBUILT FROM ITS LATEST DEFINITION (20260923000000 § 6 -- no later
-- migration replaced it). The UPDATE branch is unchanged. The trigger itself
-- is unchanged (it already calls this function by name).
-- ===========================================================================

create or replace function private.consents_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'consents: the consent ledger is append-only -- record a new event instead'
      using errcode = '42501';
  end if;
  -- DELETE. Depth 1 is a DELETE statement (from any role, or any function).
  -- Depth >= 2 is a trigger's DELETE -- allowed only when it is the cascade
  -- from the account's own deletion, i.e. the account is already gone.
  if pg_catalog.pg_trigger_depth() < 2
     or exists (select 1 from auth.users u where u.id = old.user_id) then
    raise exception 'consents: the consent ledger is append-only -- rows go only with the account they belong to'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function private.consents_guard() is
  'BEFORE UPDATE OR DELETE on public.consents, for EVERY role (postgres included): refuses every UPDATE, and every DELETE except one issued by a trigger (pg_trigger_depth() >= 2) for a row whose auth account no longer exists -- i.e. the ON DELETE CASCADE from auth.users, including the self-referencing withdrawal cascade. A trigger deleting a live account''s rows is refused (fix round 1, review finding I2; 20260923002000). SECURITY DEFINER only so the auth.users lookup does not depend on the invoking role. The deliberate DBA escape hatches (disabling the trigger, session_replication_role = replica) are the only other ways past it. NOTE: deleting an auth account that has ever consented is blocked today by audit_events.actor_user_id (no ON DELETE action) -- Task 5 (erasure) decides that, and Q148 what happens to the ledger.';

revoke all on function private.consents_guard() from public, anon, authenticated, service_role;

comment on table public.consents is
  'The consent ledger (Phase 8 Task 2; PRD §12). ONE ROW PER EVENT -- a grant or a withdrawal -- and no row is ever updated, by any role (private.consents_guard). Attribution is stamped from the session by private.consents_before_insert() for every writer; no client role holds a write privilege, and the one session write path is public.record_consent(), which takes no user argument. policy_slug + policy_version is a real foreign key to the immutable legal_documents version the person was shown. technical_context is bounded to one token naming the wording shown; no IP address and no user agent are stored. Current state of (user, purpose) = the newest row by seq. A row can be deleted only by the ON DELETE CASCADE from its auth account (the guard checks the account is gone, 20260923002000) -- and deleting an account that has ever consented is itself blocked today by audit_events.actor_user_id, so in practice rows are not deleted at all until Task 5 (erasure) decides how an account is removed and whether its consent history is kept (Q148).';
