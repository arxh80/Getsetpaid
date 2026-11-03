-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 2 -- LIFECYCLE TRANSITIONS LOCK THE ROW AND
-- RE-CHECK THE STATE THEY DECIDED ON (re-review N1).
--
-- private.lifecycle_target() read the organisation WITHOUT a lock and the
-- Phase 7 UPDATEs matched on id only. So: the superuser clicks Suspend/Delete
-- on an ACTIVE workspace; in the same instant its Owner commits
-- close_my_workspace(); the superuser's UPDATE waits for the row lock,
-- re-evaluates `where id = ...` on the new row version, and overwrites
-- owner_closed -- I1(b) again (discriminator lost, item gone from
-- /super/closures, 60-day clock re-stamped, nobody told).
--
-- Two independent gates, each pinned on its own (a mutant removing one leaves
-- the race closed by the other, so a behavioural probe alone could not see it):
--   (1) LOCK. lifecycle_target() returns the state read FOR UPDATE by the new
--       private.lifecycle_lock() (and is now VOLATILE), so the
--       state the caller checks is the one it overwrites. close_my_workspace()
--       and private.closure_decision_target() already lock.
--   (2) RE-CHECK. Every UPDATE that moves lifecycle_state -- suspend, delete,
--       reinstate, close_my_workspace, reassign_closed_workspace,
--       delete_closed_workspace -- carries the state it was decided on in its
--       WHERE and refuses 40001 lifecycle_changed_concurrently on zero rows.
-- Measured by supabase/tests/lifecycle_concurrency_probe.sh (two sessions,
-- run by run-rls-tests.sh) and the closure suite's CL9-CL12.
--
-- Rebuilt from the LATEST pg_get_functiondef of each at 235 migrations
-- (standing lesson 4); CREATE OR REPLACE keeps grants and comments.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.lifecycle_lock(p_organisation_id uuid)
returns table (id uuid, lifecycle_state text, deleted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- The same guard as lifecycle_target(): only the aal2 platform superuser may
  -- take a row lock on an organisation through this (otherwise it is a lever
  -- for any session to stall another tenant's writes).
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'organisation lifecycle: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;
  return query
    select o.id, o.lifecycle_state, o.deleted_at
      from public.organisations o
     where o.id = p_organisation_id
       for update;
end;
$$;
comment on function private.lifecycle_lock(uuid) is
  'Task 9c fix round 2 (N1, 20261028000000): the row lock behind private.lifecycle_target(). SECURITY DEFINER because a FOR UPDATE under the caller''s own policies would apply organisations_update_platform_lifecycle, which admits a row only inside begin_lifecycle_transition(). Guarded by the same aal2 platform-superuser check, so no other session can use it to stall a tenant. Returns the row''s CURRENT (post-lock) lifecycle_state and deleted_at.';
revoke all on function private.lifecycle_lock(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lifecycle_lock(uuid) to authenticated;

CREATE OR REPLACE FUNCTION private.lifecycle_target(p_slug text, p_reason text)
 RETURNS TABLE(id uuid, lifecycle_state text, deleted_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO ''
AS $function$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'organisation lifecycle: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'organisation lifecycle: a reason is required'
      using errcode = '22023';
  end if;

  -- Reads through organisations_select_platform_lifecycle (this function is
  -- SECURITY INVOKER, so the caller's own policies apply) -- the same policy
  -- the UPDATE's row-matching will use, so "found here, refused there" cannot
  -- happen.
  --
  -- 20261028000000 (Task 9c fix round 2, N1): LOCK THE ROW YOU DECIDE ON.
  -- Unlocked, a superuser's suspend/delete read 'active', the Owner's
  -- close_my_workspace() committed owner_closed, and the UPDATE (matching on
  -- id) then overwrote it. The slug still resolves under the caller's own
  -- SELECT policy; the state RETURNED is read by private.lifecycle_lock()
  -- under FOR UPDATE, so it is the state the caller's UPDATE overwrites.
  -- (A FOR UPDATE here would apply organisations_update_platform_lifecycle,
  -- which admits a row only inside begin_lifecycle_transition() -- it would
  -- match nothing. VOLATILE because a STABLE body would keep reading the
  -- statement's pre-lock snapshot.)
  return query
    select l.id, l.lifecycle_state, l.deleted_at
    from public.organisations o
    cross join lateral private.lifecycle_lock(o.id) l
    where o.slug = pg_catalog.btrim(pg_catalog.lower(p_slug));

  -- FOUND after RETURN QUERY is true iff it returned at least one row.
  if not found then
    raise exception 'organisation lifecycle: no organisation with that slug'
      using errcode = '22023';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.suspend_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'suspend_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'suspended' then
    raise exception 'suspend_organisation: that workspace is already suspended'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'suspended',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id
    and lifecycle_state = v_target.lifecycle_state;
  get diagnostics n = row_count;

  if n = 0 then
    -- 20261028000000 (N1): the UPDATE re-checks the state it was decided on.
    -- Zero rows with the row still there and in ANOTHER state means it moved
    -- under us: refuse distinguishably, write nothing.
    if exists (select 1 from public.organisations o
                where o.id = v_target.id
                  and o.lifecycle_state is distinct from v_target.lifecycle_state) then
      raise exception 'suspend_organisation: that workspace changed while this ran; reload and decide again'
        using errcode = '40001', hint = 'lifecycle_changed_concurrently';
    end if;
    raise exception 'suspend_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.suspended', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'delete_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'deleted' then
    raise exception 'delete_organisation: that workspace is already deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  -- SOFT ONLY. There is no DELETE anywhere in this function and there must
  -- never be one: CLAUDE.md Â§ Superuser dashboard, "soft-delete only... no
  -- immediate hard delete", and Â§ Non-negotiable rules, "never silently delete
  -- data". The retention clock re-stamps here (private.organisation_lifecycle_
  -- sync sees the state change), which EXTENDS a suspended workspace's window
  -- rather than shortening it -- the customer-favourable reading of an
  -- ambiguity Q88 does not resolve. Queued as DECISIONS-QUEUE Q102.
  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'deleted',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id
    and lifecycle_state = v_target.lifecycle_state;
  get diagnostics n = row_count;

  if n = 0 then
    -- 20261028000000 (N1): the UPDATE re-checks the state it was decided on.
    -- Zero rows with the row still there and in ANOTHER state means it moved
    -- under us: refuse distinguishably, write nothing.
    if exists (select 1 from public.organisations o
                where o.id = v_target.id
                  and o.lifecycle_state is distinct from v_target.lifecycle_state) then
      raise exception 'delete_organisation: that workspace changed while this ran; reload and decide again'
        using errcode = '40001', hint = 'lifecycle_changed_concurrently';
    end if;
    raise exception 'delete_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.deleted', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reinstate_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'reinstate_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'active' then
    raise exception 'reinstate_organisation: that workspace is not suspended or deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'lifecycle_state', v_target.lifecycle_state,
    'deleted_at',      v_target.deleted_at);

  perform private.begin_lifecycle_transition(v_corr);

  -- Clearing deleted_at is the whole reinstatement: every gate in the schema
  -- reads that column, so the workspace becomes writable again the instant
  -- this commits. private.organisation_lifecycle_sync() clears the three
  -- lifecycle columns with it, so no live workspace carries a stale retention
  -- deadline or a stale suspension reason.
  --
  -- NOTE THE ABSENCE OF ANY WINDOW CHECK. Reinstatement is deliberately
  -- possible past retention_expires_at too: the 60 days is when the workspace
  -- stops being VISIBLE and becomes eligible for a future purge, not a
  -- deadline after which the operator is locked out of their own undo. A
  -- one-way door with a clock on it is the failure mode this whole task
  -- exists to avoid.
  update public.organisations
  set deleted_at = null
  where id = v_target.id
    and lifecycle_state = v_target.lifecycle_state;
  get diagnostics n = row_count;

  if n = 0 then
    -- 20261028000000 (N1): the UPDATE re-checks the state it was decided on.
    -- Zero rows with the row still there and in ANOTHER state means it moved
    -- under us: refuse distinguishably, write nothing.
    if exists (select 1 from public.organisations o
                where o.id = v_target.id
                  and o.lifecycle_state is distinct from v_target.lifecycle_state) then
      raise exception 'reinstate_organisation: that workspace changed while this ran; reload and decide again'
        using errcode = '40001', hint = 'lifecycle_changed_concurrently';
    end if;
    raise exception 'reinstate_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.reinstated', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.close_my_workspace(p_organisation_id uuid, p_confirmation text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := (select auth.uid());
  v_org     record;
  v_corr    uuid := pg_catalog.gen_random_uuid();
  v_reason  text := pg_catalog.btrim(p_reason);
  v_job     uuid;
  v_n       integer;
  v_members bigint;
  v_after   record;
begin
  -- (1) A SESSION.
  if v_uid is null then
    raise exception 'close_my_workspace: sign in first'
      using errcode = '42501', hint = 'close_needs_a_session';
  end if;

  -- (2) STEP-UP. aal2, from the session's own JWT, before anything is read.
  if not private.session_is_aal2() then
    raise exception 'close_my_workspace: re-authenticate with your second factor first'
      using errcode = '42501', hint = 'close_needs_step_up';
  end if;

  -- (3) AN ACTIVE OWNER OF THIS WORKSPACE -- a membership row, never an
  -- impersonation grant. The workspace row is locked so two closes (or a
  -- close racing a superuser transition) serialise.
  select o.id, o.slug, o.lifecycle_state, o.deleted_at into v_org
    from public.organisations o
   where o.id = p_organisation_id
     for update;

  if not found or not exists (
       select 1 from public.organisation_memberships m
        where m.organisation_id = p_organisation_id
          and m.user_id = v_uid
          and m.role = 'owner'
          and m.status = 'active') then
    raise exception 'close_my_workspace: only an Owner of this workspace can close it'
      using errcode = '42501', hint = 'close_needs_an_owner';
  end if;

  if v_org.deleted_at is not null then
    raise exception 'close_my_workspace: this workspace is not active'
      using errcode = '22023', hint = 'workspace_not_active';
  end if;

  -- (4) THE TYPED CONFIRMATION: the slug, exactly.
  if p_confirmation is distinct from v_org.slug then
    raise exception 'close_my_workspace: type the workspace address to confirm'
      using errcode = '22023', hint = 'close_confirmation_mismatch';
  end if;

  -- (5) THE REASON: mandatory, bounded.
  if v_reason is null or v_reason = '' then
    raise exception 'close_my_workspace: a reason is required'
      using errcode = '22023', hint = 'close_reason_required';
  end if;
  if pg_catalog.char_length(v_reason) > 500 then
    raise exception 'close_my_workspace: the reason is limited to 500 characters'
      using errcode = '22023', hint = 'close_reason_too_long';
  end if;

  -- ONE THREAD: every audit row below (this one and the backup's
  -- export_job.requested) carries v_corr.
  perform pg_catalog.set_config('app.lifecycle_correlation_id', v_corr::text, true);

  update public.organisations
     set deleted_at       = pg_catalog.now(),
         lifecycle_state  = 'owner_closed',
         lifecycle_reason = v_reason
   where id = p_organisation_id
     -- 20261028000000 (N1): re-check the state step (3) read under its lock.
     and deleted_at is null
     and lifecycle_state = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'close_my_workspace: this workspace changed while closing; reload and try again'
      using errcode = '40001', hint = 'lifecycle_changed_concurrently';
  end if;

  -- THE BACKUP, through the Task 4 pipeline, in this transaction.
  perform pg_catalog.set_config('app.workspace_closure_backup', p_organisation_id::text, true);
  insert into public.export_jobs (kind, organisation_id, closure_backup)
  values ('workspace', p_organisation_id, true)
  returning id into v_job;
  perform pg_catalog.set_config('app.workspace_closure_backup', '', true);

  select o.lifecycle_changed_at, o.retention_expires_at into v_after
    from public.organisations o where o.id = p_organisation_id;
  select pg_catalog.count(*) into v_members
    from public.organisation_memberships m
   where m.organisation_id = p_organisation_id and m.status = 'active';

  perform private.log_audit_event(
    p_action          => 'organisation.closed_by_owner',
    p_target_type     => 'organisation',
    p_organisation_id => p_organisation_id,
    p_target_id       => p_organisation_id,
    p_correlation_id  => v_corr,
    p_before          => pg_catalog.jsonb_build_object('lifecycle_state', v_org.lifecycle_state),
    p_after           => pg_catalog.jsonb_build_object(
      'lifecycle_state',      'owner_closed',
      'lifecycle_changed_at', v_after.lifecycle_changed_at,
      'retention_expires_at', v_after.retention_expires_at,
      'reason',               v_reason,
      'backup_export_job_id', v_job,
      'active_members',       v_members));

  -- CLOSE THE DOOR (private.end_lifecycle_transition()'s header).
  perform private.end_lifecycle_transition();

  return v_job;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reassign_closed_workspace(p_organisation_slug text, p_new_owner_user_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_role   text;
  v_backup uuid;
  v_audit  uuid;
  v_n      integer;
begin
  select * into v_t from private.closure_decision_target(p_organisation_slug, p_reason);

  if v_t.lifecycle_state is distinct from 'owner_closed' then
    raise exception 'reassign_closed_workspace: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'decision_workspace_not_owner_closed';
  end if;

  -- 20261027001000 (Task 9c fix round 1b, Q222 / review m2): NEVER THE
  -- PLATFORM SUPERUSER. The decision is the superuser's; making themselves the
  -- Owner of a customer's workspace would be tenant-data access outside the
  -- audited, admin-approved impersonation flow (CLAUDE.md Â§ Superuser dashboard).
  if exists (select 1 from public.platform_admins pa where pa.user_id = p_new_owner_user_id) then
    raise exception 'reassign_closed_workspace: the platform superuser cannot be made the Owner of a closed workspace'
      using errcode = '22023', hint = 'new_owner_is_platform_superuser';
  end if;

  -- THE NEW OWNER IS AN EXISTING ACTIVE MEMBER -- never an outsider, never an
  -- invited or revoked row, never the tombstone.
  select m.role into v_role
    from public.organisation_memberships m
   where m.organisation_id = v_t.id
     and m.user_id = p_new_owner_user_id
     and m.status = 'active'
     and p_new_owner_user_id <> private.erased_user_id();
  if not found then
    raise exception 'reassign_closed_workspace: the new Owner must be an active member of this workspace'
      using errcode = '22023', hint = 'new_owner_must_be_active_member';
  end if;

  select j.id into v_backup
    from public.export_jobs j
   where j.organisation_id = v_t.id and j.closure_backup
   order by j.requested_at desc limit 1;

  perform private.begin_lifecycle_transition(v_corr);

  if v_role <> 'owner' then
    update public.organisation_memberships m
       set role = 'owner'
     where m.organisation_id = v_t.id and m.user_id = p_new_owner_user_id;
  end if;

  -- REOPEN. Clearing deleted_at is the whole of it: private.organisation_
  -- lifecycle_sync() returns the state to active and clears the reason and
  -- BOTH clocks, so the 60-day purge no longer selects it.
  update public.organisations set deleted_at = null
   where id = v_t.id
     -- 20261028000000 (N1): re-check the state the decision was taken on.
     and lifecycle_state = 'owner_closed';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'reassign_closed_workspace: that workspace changed while this ran; reload and decide again'
      using errcode = '40001', hint = 'lifecycle_changed_concurrently';
  end if;

  v_audit := private.log_audit_event(
    p_action          => 'organisation.closure_reassigned',
    p_target_type     => 'organisation',
    p_organisation_id => v_t.id,
    p_target_id       => v_t.id,
    p_correlation_id  => v_corr,
    p_before          => pg_catalog.jsonb_build_object(
      'lifecycle_state', v_t.lifecycle_state, 'deleted_at', v_t.deleted_at,
      'new_owner_previous_role', v_role),
    p_after           => pg_catalog.jsonb_build_object(
      'lifecycle_state',      'active',
      'reason',               v_t.reason,
      'new_owner_user_id',    p_new_owner_user_id,
      'backup_export_job_id', v_backup,
      'organisation_slug',    v_t.slug,
      'organisation_name',    v_t.name,
      'notify_user_ids',      private.closure_decision_recipients(v_t.id)));

  perform private.end_lifecycle_transition();
  return v_audit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_closed_workspace(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_backup uuid;
  v_audit  uuid;
  v_after  record;
  v_n      integer;
begin
  select * into v_t from private.closure_decision_target(p_organisation_slug, p_reason);

  if v_t.lifecycle_state is distinct from 'owner_closed' then
    raise exception 'delete_closed_workspace: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'decision_workspace_not_owner_closed';
  end if;

  select j.id into v_backup
    from public.export_jobs j
   where j.organisation_id = v_t.id and j.closure_backup
   order by j.requested_at desc limit 1;

  perform private.begin_lifecycle_transition(v_corr);

  -- NO SECOND DELETION ENGINE. The decision moves the workspace to
  -- lifecycle_state 'deleted' (network presence ends at once, Q101) and makes
  -- it due for the EXISTING Q88 purge now, by dating its lifecycle clock one
  -- retention period back: private.organisation_lifecycle_sync() derives
  -- retention_expires_at from lifecycle_changed_at and keeps a writer's value
  -- when the state does not change. The hourly retention run then does what
  -- it does for every expired workspace -- the document bytes first, then
  -- private.erase_organisation() through sweep_expired_workspaces(). The
  -- decision's real time is the audit row's.
  update public.organisations
     set lifecycle_state = 'deleted', lifecycle_reason = v_t.reason
   where id = v_t.id
     -- 20261028000000 (N1): re-check the state the decision was taken on.
     and lifecycle_state = 'owner_closed';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'delete_closed_workspace: that workspace changed while this ran; reload and decide again'
      using errcode = '40001', hint = 'lifecycle_changed_concurrently';
  end if;
  update public.organisations
     set lifecycle_changed_at = pg_catalog.now()
           - pg_catalog.make_interval(days => private.organisation_retention_days())
           - interval '1 second'
   where id = v_t.id;

  select o.retention_expires_at into v_after from public.organisations o where o.id = v_t.id;

  v_audit := private.log_audit_event(
    p_action          => 'organisation.closure_deleted',
    p_target_type     => 'organisation',
    p_organisation_id => v_t.id,
    p_target_id       => v_t.id,
    p_correlation_id  => v_corr,
    p_before          => pg_catalog.jsonb_build_object(
      'lifecycle_state', v_t.lifecycle_state, 'lifecycle_changed_at', v_t.lifecycle_changed_at),
    p_after           => pg_catalog.jsonb_build_object(
      'lifecycle_state',      'deleted',
      'reason',               v_t.reason,
      'purge_due_at',         v_after.retention_expires_at,
      'backup_export_job_id', v_backup,
      'organisation_slug',    v_t.slug,
      'organisation_name',    v_t.name,
      'notify_user_ids',      private.closure_decision_recipients(v_t.id)));

  perform private.end_lifecycle_transition();
  return v_audit;
end;
$function$;

comment on function private.lifecycle_target(text, text) is
  'The three Phase 7 lifecycle RPCs'' shared preamble: superuser guard, mandatory reason, slug -> row, LOCKED (the state is read FOR UPDATE by private.lifecycle_lock(), and this is VOLATILE, since 20261028000000, Task 9c fix round 2 N1) so the state each caller checks is the state it overwrites -- an unlocked read let a superuser suspend/delete overwrite an owner_closed committed between the read and the UPDATE. Each caller''s UPDATE also re-checks lifecycle_state = the state read here and refuses 40001 lifecycle_changed_concurrently on zero rows. SECURITY INVOKER, so the lookup runs under the caller''s own organisations_select_platform_lifecycle policy -- the same policy the UPDATE beside it will use for row-matching. Takes the SLUG rather than an id: the operator has no directory of uuids. A nonexistent slug is a distinguishable 22023.';
