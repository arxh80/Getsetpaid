-- ===========================================================================
-- PHASE 8 TASK 6 -- Q179: AN UNSANCTIONED `delete from auth.users` REFUSES
-- INSTEAD OF STRANDING A WORKSPACE.
--
-- Task 5's fix round 2 (N3) left this open and routed it here, with the
-- reason: the fix "makes every fixture, suite and seed that deletes an
-- auth.users row fail unless it sets the marker, which is a change with reach
-- across the whole test estate".
--
-- ===========================================================================
-- THE HOLE, RESTATED AND STILL TRUE
-- ===========================================================================
-- private.membership_keeps_an_owner() (20261001001000) refuses any change
-- that would leave a live workspace with no active Owner, and admits exactly
-- one account-shaped cascade: a DELETE whose auth.users row has ALREADY GONE.
-- Because organisation_memberships.user_id is ON DELETE CASCADE, only an
-- account deletion can satisfy that branch, so it cannot be FALSELY BORROWED
-- by something that is not one -- which is why it was safe to ship.
--
-- What it cannot do is tell private.erase_account()'s deletion, which has
-- asked Q131 under an advisory lock and re-asserts it afterwards, from
--
--   delete from auth.users where id = <the sole Owner>;
--
-- run by `supabase_auth_admin`, by `postgres`, or -- the realistic one -- by
-- an operator clicking Delete on Supabase Studio's Auth page. That leaves
-- `owners 0 / members 1 / crm 1`: a live workspace with records in it,
-- somebody still in it, and nobody who can manage or close it.
--
-- ===========================================================================
-- THE FIX, AND WHY IT IS A DOOR RATHER THAN A WALL
-- ===========================================================================
-- A transaction-local marker, in private.begin_lifecycle_transition()'s
-- shape: private.erase_account() declares itself, the trigger requires the
-- declaration, and an undeclared deletion that WOULD STRAND A WORKSPACE is
-- refused (42501, hint `account_deletion_is_not_sanctioned`) rather than
-- silently allowed.
--
-- THE MARKER NAMES THE SUBJECT, not merely "an erasure is happening". A
-- bare boolean would mean that one declared erasure inside a transaction
-- admitted the deletion of ANY account in that same transaction, which is a
-- weaker rule than the one it replaces.
--
-- IT IS OPENED BY A FUNCTION, NOT BY set_config DIRECTLY, and the function is
-- revoked from every client role and from service_role. So the door exists,
-- it is named, and using it is a deliberate act that appears in a diff --
-- which is the whole difference between this and the click it is there to
-- refuse. A fixture, a seed or a migration that genuinely needs to remove an
-- account out of band calls private.begin_account_deletion() first and says
-- why; one that does not is telling the truth about not having thought about
-- it, and gets the refusal.
--
-- ===========================================================================
-- WHAT IT IS NOT: FORGERY-PROOF FROM A DIRECT DATABASE SESSION
-- ===========================================================================
-- `app.account_being_deleted` is a custom placeholder GUC and therefore
-- PGC_USERSET, exactly like `app.crm_bulk_correlation_id` (Q123) and
-- `app.lifecycle_correlation_id`. A direct psql session can set it in one
-- statement. That is stated rather than implied, and it does not weaken the
-- control for the threat it exists for: the GUC is not reachable over
-- PostgREST (`private` is not an exposed schema and `request.*` is a
-- different namespace), and a Studio Auth-page click does not set GUCs. It
-- turns an ACCIDENT into a refusal; it does not stop somebody who has a
-- database shell and has decided to do this.
--
-- ===========================================================================
-- THE REACH, MEASURED RATHER THAN FEARED
-- ===========================================================================
-- The refusal fires ONLY where the old code would have stranded something:
-- the subject is an ACTIVE OWNER of a LIVE workspace that still has other
-- members or records in it. Every other `delete from auth.users` in the
-- repository -- the disposable accounts in tests/e2e/support/fixtures.ts, the
-- three `auth.admin.deleteUser` teardowns in tests/integration, the psql
-- suites' own throwaway users -- deletes somebody who is not that, and is
-- unaffected. The reach was the thing that made this its own task; the
-- measurement is that the blast radius is exactly the set of deletions that
-- were already leaving damage behind.
--
-- ADDITIVE. private.membership_keeps_an_owner() and
-- private.account_lock_workspaces() are rebuilt from their LATEST
-- definitions (read out of pg_get_functiondef, not out of the migration that
-- created them -- the first draft of this file rebuilt the lock from the
-- Task 5 REPORT and got its return type, its advisory-lock key scheme and a
-- `distinct` wrong; `create or replace` refused the return-type change, which
-- is the one part of that mistake the database catches for you).
-- private.erase_account() itself is NOT rebuilt: it is four hundred lines and
-- rebuilding it to add one call is four hundred lines of opportunity to lose
-- something, which this phase has done twice.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE MARKER: OPEN, READ, CLOSE.
-- ---------------------------------------------------------------------------

create or replace function private.begin_account_deletion(p_user_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'begin_account_deletion: an account is required' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.account_being_deleted', p_user_id::text, true);
end;
$$;

comment on function private.begin_account_deletion(uuid) is
  'DECLARES that the account named is about to be deleted, for the rest of this TRANSACTION (Q179). private.membership_keeps_an_owner() requires the declaration before it will admit the account cascade that takes a workspace''s last Owner with it. private.erase_account() calls it, and so must anything else that genuinely needs to remove an account out of band -- which is the point: the door is named, it is revoked from every client role and from service_role, and walking through it is a deliberate act that shows up in a diff. A Supabase Studio Auth-page Delete click does not set GUCs, which is the accident this refuses. A set_config(is_local) stands to the end of the TRANSACTION whatever SET clauses the call stack carries (measured in 20260908030000), so the declaration outlives the statement that made it; because it names the SUBJECT that licenses nothing but a further deletion of the same, already-deleted account, and private.end_account_deletion() closes it explicitly where a caller wants the door shut.';

create or replace function private.end_account_deletion()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.account_being_deleted', '', true);
end;
$$;

comment on function private.end_account_deletion() is
  'CLOSES what private.begin_account_deletion() opened. The residual it exists for is NARROW and is stated rather than overclaimed: because the marker names the SUBJECT, an open declaration licenses only a further deletion of that same account id, which after the first one is a no-op -- so leaving it open does not admit a second person''s deletion the way a bare boolean would have. What it does buy is a caller that erases two accounts in one transaction, and a test that needs to prove the door shuts as well as that it opens. An is_local GUC stands to the end of the TRANSACTION whatever SET clauses the call stack carries (measured in 20260908030000), so closing it is an explicit act. Needs no guard of its own -- clearing the marker only ever removes capability.';

create or replace function private.account_deletion_is_sanctioned(p_user_id uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare v_raw text;
begin
  v_raw := nullif(pg_catalog.current_setting('app.account_being_deleted', true), '');
  if v_raw is null then
    return false;
  end if;
  return v_raw::uuid = p_user_id;
exception when invalid_text_representation then
  -- A malformed marker is NOT a licence. The narrow handler is deliberate,
  -- 20260908030000's lesson: a blanket `when others` in a predicate that
  -- gates a guard turns coding errors into quiet decisions.
  return false;
end;
$$;

comment on function private.account_deletion_is_sanctioned(uuid) is
  'True when THIS transaction has declared, through private.begin_account_deletion(), that this particular account is being deleted. It names the SUBJECT rather than answering "an erasure is happening": a bare boolean would mean one declared erasure admitted the deletion of any other account in the same transaction, which is weaker than the rule it replaces. A malformed marker is not a licence, and the exception handler is narrow on purpose -- a blanket `when others` in a predicate that gates a guard converts coding errors into quiet permissions.';

revoke all on function private.begin_account_deletion(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.end_account_deletion()
  from public, anon, authenticated, service_role;
revoke all on function private.account_deletion_is_sanctioned(uuid)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE GUARD, REBUILT FROM ITS LATEST DEFINITION (20261001001000 § 3).
--
--    ONE BRANCH CHANGES. The account-cascade exemption stops being "the
--    auth.users row has gone" and becomes "the auth.users row has gone AND
--    this transaction said it was deleting THAT account". An undeclared one
--    that would strand a workspace is refused with its own hint, so a test
--    can tell it from the Q131 refusal beside it and from a missing
--    privilege.
-- ---------------------------------------------------------------------------

create or replace function private.membership_keeps_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  -- Only the loss of an ACTIVE OWNER can leave a workspace ownerless.
  if not (old.role = 'owner' and old.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and new.role = 'owner' and new.status = 'active'
     and new.organisation_id = old.organisation_id
     and new.user_id = old.user_id then
    return new;
  end if;

  -- THE CASCADE THIS IS NOT ABOUT: the workspace itself is being deleted (the
  -- parent row goes first, so it is already absent here).
  select o.name into v_name
    from public.organisations o
   where o.id = old.organisation_id and o.deleted_at is null;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- THE ACCOUNT CASCADE, NOW GATED ON THE DECLARATION (Q179). The row being
  -- gone is still necessary -- organisation_memberships.user_id is ON DELETE
  -- CASCADE, so nothing but an account deletion can reach here -- and it is
  -- no longer sufficient. private.erase_account() declares itself; a direct
  -- `delete from auth.users` and a Studio Auth-page click do not.
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    if private.account_deletion_is_sanctioned(old.user_id) then
      return old;
    end if;
    -- It is only a REFUSAL where it would have been DAMAGE. An undeclared
    -- deletion of somebody who is not the last Owner of a live, non-empty
    -- workspace falls through to the checks below and is admitted exactly as
    -- before.
    if exists (select 1 from public.organisation_memberships m
                where m.organisation_id = old.organisation_id
                  and m.user_id <> old.user_id
                  and m.role = 'owner'
                  and m.status = 'active') then
      return old;
    end if;
    if not exists (select 1 from public.organisation_memberships m
                    where m.organisation_id = old.organisation_id
                      and m.user_id <> old.user_id)
       and private.organisation_is_empty(old.organisation_id) then
      return old;
    end if;
    raise exception 'Deleting this account directly would leave % with no owner. private.erase_account() is the only sanctioned account deletion; it checks this under a lock, transfers what it must and refuses when it cannot.', v_name
      using errcode = '42501', hint = 'account_deletion_is_not_sanctioned';
  end if;

  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id
                and m.role = 'owner'
                and m.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- No other active Owner. An empty workspace with nobody else in it is
  -- allowed to end this way -- there is nothing to strand.
  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id)
     or not private.organisation_is_empty(old.organisation_id) then
    raise exception 'That would leave % with no owner. Make somebody else an owner there first.', v_name
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.membership_keeps_an_owner() is
  'BEFORE UPDATE OR DELETE on public.organisation_memberships (Phase 8 Task 5 fix round 1, I1/Q176). Refuses any change that would leave a LIVE workspace which still has other members or records in it with no active Owner -- demotion, suspension of the Owner''s membership, removal and leaving alike -- with 22023 / last_owner_of_workspace and a sentence naming the workspace. SINCE PHASE 8 TASK 6 (Q179) THE ACCOUNT CASCADE IS GATED ON A DECLARATION, not merely on the outcome: it admits a DELETE whose auth.users row has gone only when THIS TRANSACTION named that account through private.begin_account_deletion(), which private.erase_account() calls and which is revoked from every client role and from service_role. An undeclared account deletion -- `delete from auth.users` by hand, or the Supabase Studio Auth page''s Delete button, the realistic case -- now REFUSES with 42501 / account_deletion_is_not_sanctioned instead of stranding `owners 0 / members 1 / crm 1`. It refuses ONLY where it would previously have done damage: an undeclared deletion of somebody who is not the last active Owner of a live, non-empty workspace is admitted exactly as before, which is why the blast radius is the set of deletions that were already leaving a workspace broken. The marker is a PGC_USERSET GUC and a direct database session can set it (Q123''s admitted limit, restated): this turns an accident into a refusal, it does not stop somebody with a shell who has decided to do it.';


-- ---------------------------------------------------------------------------
-- 3. THE CHOKEPOINT DECLARES ITSELF.
--
--    private.erase_account() is NOT rebuilt here -- it is four hundred lines
--    and rebuilding it from its latest definition to add two calls is four
--    hundred lines of opportunity to lose something (the phase has done that
--    twice). Instead the declaration is made by the one thing that already
--    runs immediately before every `delete from auth.users` it performs: the
--    lock it takes over the subject's workspaces.
--
--    private.account_lock_workspaces() (20261001001000) is called by
--    erase_account() at step 0, after the Q131 guard has decided and under
--    the advisory lock that makes that decision safe -- and by nothing else
--    in the schema (asserted in the psql suite). Declaring there means the
--    marker is set exactly when the chokepoint has done the work that earns
--    it, and never when it has not.
-- ---------------------------------------------------------------------------

create or replace function private.account_lock_workspaces(p_user_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_n   bigint := 0;
begin
  -- THE DECLARATION (Q179). Here rather than in erase_account() itself
  -- because this function is called by the chokepoint and by nothing else,
  -- immediately before the delete, after the guard has decided -- so the
  -- marker cannot be set by a path that has not done the work that earns it.
  perform private.begin_account_deletion(p_user_id);

  for v_org in
    select distinct m.organisation_id
      from public.organisation_memberships m
      join public.organisations o on o.id = m.organisation_id
     where m.user_id = p_user_id
       and m.status = 'active'
       and o.deleted_at is null
     order by 1
  loop
    -- Two keys rather than one hash of a concatenation: the first names the
    -- lock space so this cannot collide with another feature's advisory lock.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('private.erase_account'), pg_catalog.hashtext(v_org::text));
    perform 1 from public.organisation_memberships m
      where m.organisation_id = v_org
      for update;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

comment on function private.account_lock_workspaces(uuid) is
  'Takes an advisory transaction lock per workspace IN ID ORDER (so two concurrent erasures queue instead of deadlocking) plus FOR UPDATE on that workspace''s membership rows (so a concurrent demotion blocks too), over every live workspace the subject is an active member of -- not only the ones that block, because in the C2 race neither co-Owner is the last Owner at the moment they read. Rebuilt in 20261003006000 from its latest definition to add ONE line: it DECLARES the account deletion (Q179, private.begin_account_deletion()), which is what private.membership_keeps_an_owner() now requires before it will admit the cascade that takes a workspace''s last Owner. The declaration lives here rather than in private.erase_account() because this function is called by the chokepoint and by nothing else, immediately before the delete and after the Q131 guard has decided -- so the marker cannot be set by a path that has not done the work that earns it. COST, MEASURED (Task 5 fix round 2, N4): 1.22 ms to take the locks over 5 workspaces and 250 membership rows, held for one erasure transaction (29 ms end to end). Concurrent role changes, revokes and removals in those workspaces block for tens of milliseconds; INSERTs are not blocked, so invitations still work.';

revoke all on function private.account_lock_workspaces(uuid)
  from public, anon, authenticated, service_role;
