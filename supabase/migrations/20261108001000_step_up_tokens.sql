-- ===========================================================================
-- STEP-UP, ENFORCED IN THE DATABASE (Phase 10 Task 6; gap G13, High; Task 2
-- finding F4)
-- ===========================================================================
-- Step-up ("a credential presented in the last five minutes", CLAUDE.md
-- § Session security) was checked only by the server actions, through
-- checkStepUp(). Every gated write is also reachable straight over PostgREST
-- with the same session, so a scripted call skipped it: `POST
-- /rest/v1/export_jobs`, `POST /rest/v1/erasure_jobs` (F4: an irreversible
-- account erasure), `POST /rest/v1/rpc/close_my_workspace` (F4), and every
-- RPC below.
--
-- THE SHAPE (Q163's, generalised; Q171):
--   public.mint_step_up_token(p_purpose)  called by the app's server right
--       after checkStepUp() passes (lib/auth/step-up-gate.ts,
--       mintStepUpToken()). It writes one row to private.step_up_tokens:
--       this user, this purpose, five minutes, unconsumed. It REFUSES unless
--       private.request_is_from_server() is true (Task 5's server request
--       mark), so a browser holding the session cannot mint and then call;
--       that is the property the whole token rests on (coordinator decision 2).
--   private.consume_step_up(p_purpose)    called inside every gated RPC and
--       in the export_jobs / erasure_jobs insert triggers, after every refusal
--       that names the request and before the first write. It marks the
--       caller's oldest fresh, unconsumed token for that purpose consumed, or
--       raises 42501 hint `step_up_required`. A gated call that fails later
--       rolls its consumption back with it, so a refused request never costs
--       the token.
--
-- Not HMAC'd: the token is never handed to anyone. It is a row bound to
-- auth.uid() that only the server-marked mint can write and only the same
-- user's gated call can consume, so there is nothing to forge or replay.
--
-- THE PURPOSES (closed: step_up_tokens_purpose_known), one per family:
--   organisation_lifecycle  suspend_organisation, delete_organisation,
--                           reinstate_organisation
--   closure_decision        reassign_closed_workspace, delete_closed_workspace
--   workspace_close         close_my_workspace (F4)
--   override                grant_billing_override, revoke_billing_override,
--                           grant_feature_override, revoke_feature_override
--   impersonation           request_impersonation, start_impersonation_session
--   retention_settings      set_retention_enabled, release_audit_purge_ceiling
--   legal_document          publish_legal_document,
--                           record_legal_document_counsel_review
--   dsr_rejection           transition_data_subject_request, p_status
--                           'rejected' only (the one step-up move on the page)
--   account_erasure         the erasure_jobs insert, kind 'account' (F4): the
--                           person's own and the operator's on behalf of a
--                           request (start_erasure_for_request inserts there)
--   workspace_export        the export_jobs insert, kind 'workspace', not a
--                           closure backup (close_my_workspace consumed its
--                           own token)
-- An account export, every other DSR move and the retention dry run stay
-- ungated: the app asks no step-up for the first two, and the dry run's write
-- is the server's own service-role call, with no PostgREST path.
-- tests/unit/security/step-up-token-callers.test.ts binds this list to the
-- app's mint calls; rls_phase10_step_up.sql binds it to the function bodies.
--
-- Every rebuilt function is its live pg_get_functiondef on a fresh reset
-- plus the one step-up line; CREATE OR REPLACE keeps each one's grants. Three `Â§` mojibake comments came back as `§`.
--
-- THE TABLE joins the retention roll as `ephemeral`, so private.retention_
-- subjects() is rebuilt at the end from its live definition plus one row.
-- MERGE NOTE: the invoicing branch rebuilds the same roll (20261107000000).
-- Whichever rebuild runs last must carry both sets of rows; if it does not,
-- private.unclassified_retention_subjects() and retention-matches-db go red.
-- ===========================================================================

create table private.step_up_tokens (
  id          uuid primary key default pg_catalog.gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  purpose     text not null
    constraint step_up_tokens_purpose_known check (purpose in (
      'organisation_lifecycle', 'closure_decision', 'workspace_close',
      'override', 'impersonation', 'retention_settings', 'legal_document',
      'dsr_rejection', 'account_erasure', 'workspace_export')),
  created_at  timestamptz not null default pg_catalog.now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
-- The FK's index, and consume's lookup.
create index step_up_tokens_user_purpose on private.step_up_tokens (user_id, purpose);

comment on table private.step_up_tokens is
  'Phase 10 Task 6 (G13): one row per step-up the app''s server recorded for a user, for one gated purpose, valid five minutes and once. Written only by public.mint_step_up_token() (server-marked requests only), consumed only by private.consume_step_up(). No client role holds any privilege on it. Retention: ephemeral -- the next mint deletes every expired row.';

alter table private.step_up_tokens enable row level security;
revoke all on private.step_up_tokens from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE MINT
-- ---------------------------------------------------------------------------
create function public.mint_step_up_token(p_purpose text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  -- THE SERVER, AND ONLY THE SERVER (coordinator decision 2). Without this,
  -- a browser holding the session mints and then calls, and the token proves
  -- nothing. The flag is api_hooks.pre_request()'s, per request.
  if not private.request_is_from_server() then
    raise exception 'mint_step_up_token: only the app''s server can record a step-up'
      using errcode = '42501', hint = 'step_up_mint_needs_the_server';
  end if;
  if v_uid is null then
    raise exception 'mint_step_up_token: sign in first'
      using errcode = '42501', hint = 'step_up_mint_needs_a_session';
  end if;

  -- Housekeeping: the table holds five minutes of rows, never more.
  delete from private.step_up_tokens t where t.expires_at <= pg_catalog.now();

  -- An unknown purpose is refused by step_up_tokens_purpose_known (23514).
  insert into private.step_up_tokens (user_id, purpose, created_at, expires_at)
  values (v_uid, p_purpose, pg_catalog.now(), pg_catalog.now() + interval '5 minutes');
end;
$$;

comment on function public.mint_step_up_token(text) is
  'Phase 10 Task 6 (G13): records that the app''s server saw a fresh step-up for the caller, for one purpose. Refuses 42501 step_up_mint_needs_the_server unless the request carries the server mark (private.request_is_from_server()). Called by lib/auth/step-up-gate.ts mintStepUpToken() right after checkStepUp() passes.';

revoke all on function public.mint_step_up_token(text) from public, anon, service_role;
grant execute on function public.mint_step_up_token(text) to authenticated;

-- ---------------------------------------------------------------------------
-- THE CONSUMPTION
-- ---------------------------------------------------------------------------
create function private.consume_step_up(p_purpose text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- The caller's own, for this purpose, unexpired, unconsumed: the oldest
  -- such row. SKIP LOCKED so two gated calls racing on one token cannot both
  -- take it; the loser finds none and is refused.
  update private.step_up_tokens t
     set consumed_at = pg_catalog.now()
   where t.id = (
     select s.id from private.step_up_tokens s
      where s.user_id = (select auth.uid())
        and s.purpose = p_purpose
        and s.consumed_at is null
        and s.expires_at > pg_catalog.now()
      order by s.created_at
      limit 1
      for update skip locked)
  returning t.id into v_id;

  if v_id is null then
    raise exception 'step-up required: confirm it is you, then try again (%)', p_purpose
      using errcode = '42501', hint = 'step_up_required';
  end if;
end;
$$;

comment on function private.consume_step_up(text) is
  'Phase 10 Task 6 (G13): takes the caller''s oldest fresh, unconsumed step-up token for p_purpose, or raises 42501 hint step_up_required. Called inside every step-up-gated RPC and the export_jobs / erasure_jobs insert triggers; rls_phase10_step_up.sql § SN lists them.';

-- `authenticated` EXECUTEs it because the lifecycle and override RPCs are
-- SECURITY INVOKER. `private` is not an exposed schema, so it is no endpoint,
-- and all it can do is spend the caller's own token.
revoke all on function private.consume_step_up(text) from public, anon, service_role;
grant execute on function private.consume_step_up(text) to authenticated;

-- ---------------------------------------------------------------------------
-- THE GATED FUNCTIONS
-- ---------------------------------------------------------------------------
-- close_my_workspace: live pg_get_functiondef + the step-up line.
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

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('workspace_close');

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

-- reassign_closed_workspace: live pg_get_functiondef + the step-up line.
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
  -- audited, admin-approved impersonation flow (CLAUDE.md § Superuser dashboard).
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

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('closure_decision');

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

-- delete_closed_workspace: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.delete_closed_workspace(p_organisation_slug text, p_reason text, p_acknowledge_no_backup boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_backup uuid;
  v_backup_status text;
  v_audit  uuid;
  v_after  record;
  v_n      integer;
begin
  select * into v_t from private.closure_decision_target(p_organisation_slug, p_reason);

  if v_t.lifecycle_state is distinct from 'owner_closed' then
    raise exception 'delete_closed_workspace: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'decision_workspace_not_owner_closed';
  end if;

  select j.id, j.status into v_backup, v_backup_status
    from public.export_jobs j
   where j.organisation_id = v_t.id and j.closure_backup
   order by j.requested_at desc limit 1;

  -- 20261028002000 (Task 9c fix round 2, N3a): NO PERMANENT DELETE OVER A
  -- MISSING BACKUP UNLESS THE SUPERUSER SAYS SO. A closure backup can fail
  -- (reaped after an hour, or over the export ceilings) and cannot be
  -- re-queued (Q228), and the purge this decision brings forward takes the
  -- seven-year finance ledger with it. So: the latest closure backup must
  -- have SUCCEEDED, or the caller passes p_acknowledge_no_backup = true,
  -- which the audit row records with the status it acknowledged. A queued or
  -- running backup is refused the same way -- wait for it, or acknowledge.
  if v_backup_status is distinct from 'succeeded' and not coalesce(p_acknowledge_no_backup, false) then
    raise exception 'delete_closed_workspace: the closure backup has not succeeded (%); acknowledge deleting without one to proceed',
      coalesce(v_backup_status, 'none')
      using errcode = '22023', hint = 'decision_backup_not_succeeded';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('closure_decision');

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

  -- Q229 (Phase 8 final review A, I2): THE BACKUP OUTLIVES THE DECISION.
  -- The purge this decision brings forward is HELD by
  -- private.closure_backup_owed() until the closing Owner has downloaded the
  -- succeeded closure backup or private.closure_backup_hold() has passed, so
  -- the archive must still be downloadable for that whole hold: raise its
  -- expires_at to at least now() + the hold (a late decision could otherwise
  -- leave it the closure's own 60-day deadline, days away). Through
  -- export_jobs_before_update()'s one marker-gated rewrite, never a bypass.
  if v_backup_status = 'succeeded' then
    perform pg_catalog.set_config('app.closure_backup_hold', v_backup::text, true);
    update public.export_jobs
       set expires_at = pg_catalog.now() + private.closure_backup_hold()
     where id = v_backup
       and expires_at < pg_catalog.now() + private.closure_backup_hold();
    perform pg_catalog.set_config('app.closure_backup_hold', '', true);
  end if;

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
      'backup_status',        coalesce(v_backup_status, 'none'),
      'backup_downloadable_until', (select j.expires_at from public.export_jobs j
                                      where j.id = v_backup and j.status = 'succeeded'),
      'acknowledged_no_backup', (v_backup_status is distinct from 'succeeded'),
      'organisation_slug',    v_t.slug,
      'organisation_name',    v_t.name,
      'notify_user_ids',      private.closure_decision_recipients(v_t.id)));

  perform private.end_lifecycle_transition();
  return v_audit;
end;
$function$;

-- suspend_organisation: live pg_get_functiondef + the step-up line.
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

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('organisation_lifecycle');

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

-- delete_organisation: live pg_get_functiondef + the step-up line.
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

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('organisation_lifecycle');

  perform private.begin_lifecycle_transition(v_corr);

  -- SOFT ONLY. There is no DELETE anywhere in this function and there must
  -- never be one: CLAUDE.md § Superuser dashboard, "soft-delete only... no
  -- immediate hard delete", and § Non-negotiable rules, "never silently delete
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

-- reinstate_organisation: live pg_get_functiondef + the step-up line.
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

  -- 20261028001000 (Task 9c fix round 2, N2): NEVER A LIVE WORKSPACE WITH NO
  -- OWNER (Q131). A workspace deleted by delete_closed_workspace() -- or any
  -- suspended/deleted one -- can have lost its last Owner meanwhile: a
  -- non-live workspace does not block its last Owner's erasure
  -- (account_last_owner_workspaces reads live workspaces only), which is the
  -- point of closing. Reinstating it would make it writable with nobody able
  -- to manage it. The tombstone is not an Owner. The closure path's way back
  -- with a new Owner is reassign_closed_workspace(), before the delete.
  if not private.lifecycle_has_active_owner(v_target.id) then
    raise exception 'reinstate_organisation: that workspace has no active Owner, so reinstating it would leave nobody able to manage it'
      using errcode = '22023', hint = 'reinstate_needs_an_active_owner';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'lifecycle_state', v_target.lifecycle_state,
    'deleted_at',      v_target.deleted_at);

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('organisation_lifecycle');

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

-- grant_billing_override: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.grant_billing_override(p_organisation_slug text, p_override_tier text, p_override_seats integer, p_reason text, p_expires_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('manage_billing') then
    raise exception 'grant_billing_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'grant_billing_override: a reason is required' using errcode = '22023';
  end if;

  if p_override_tier is null and p_override_seats is null then
    raise exception 'grant_billing_override: override at least the tier or the seat count'
      using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= pg_catalog.now() then
    raise exception 'grant_billing_override: expiry must be a date and time in the future'
      using errcode = '22023';
  end if;

  v_org_id := private.organisation_id_for_slug(p_organisation_slug);
  if v_org_id is null then
    raise exception 'grant_billing_override: no organisation with that slug'
      using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('override');

  perform private.begin_override_transition();

  -- At most one ACTIVE billing override per organisation: a second grant
  -- supersedes the first rather than stacking, so "the effective tier" never
  -- has to choose among several live rows.
  update public.organisation_billing_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = 'Superseded by a new billing override.'
  where organisation_id = v_org_id
    and revoked_at is null
    and expires_at > pg_catalog.now();

  insert into public.organisation_billing_overrides
    (organisation_id, override_tier, override_seats, reason, granted_by, expires_at)
  values
    (v_org_id, p_override_tier, p_override_seats, pg_catalog.btrim(p_reason),
     (select auth.uid()), p_expires_at)
  returning id into v_id;

  perform private.log_override_event(
    p_action          => 'organisation.billing_override_granted',
    p_target_type     => 'organisation_billing_override',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object(
      'override_tier',  p_override_tier,
      'override_seats', p_override_seats,
      'reason',         pg_catalog.btrim(p_reason),
      'expires_at',     p_expires_at)
  );

  perform private.end_override_transition();
  return v_id;
end;
$function$;

-- revoke_billing_override: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.revoke_billing_override(p_override_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
begin
  if not private.has_platform_permission('manage_billing') then
    raise exception 'revoke_billing_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'revoke_billing_override: a reason is required' using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('override');

  perform private.begin_override_transition();

  update public.organisation_billing_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = pg_catalog.btrim(p_reason)
  where id = p_override_id
    and revoked_at is null
  returning organisation_id into v_org_id;

  if v_org_id is null then
    raise exception 'revoke_billing_override: no active override with that id'
      using errcode = '22023';
  end if;

  perform private.log_override_event(
    p_action          => 'organisation.billing_override_revoked',
    p_target_type     => 'organisation_billing_override',
    p_organisation_id => v_org_id,
    p_target_id       => p_override_id,
    p_after           => pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
  );

  perform private.end_override_transition();
  return v_org_id;
end;
$function$;

-- grant_feature_override: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.grant_feature_override(p_organisation_slug text, p_flag_key text, p_reason text, p_expires_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('manage_feature_overrides') then
    raise exception 'grant_feature_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'grant_feature_override: a reason is required' using errcode = '22023';
  end if;

  -- Pre-validated here (with a readable message) as well as by the table's
  -- own CHECK constraint (which would otherwise surface as a bare 23514).
  if p_flag_key is null or p_flag_key not in ('early_access_preview') then
    raise exception 'grant_feature_override: unknown flag_key %', p_flag_key
      using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= pg_catalog.now() then
    raise exception 'grant_feature_override: expiry must be a date and time in the future'
      using errcode = '22023';
  end if;

  v_org_id := private.organisation_id_for_slug(p_organisation_slug);
  if v_org_id is null then
    raise exception 'grant_feature_override: no organisation with that slug'
      using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('override');

  perform private.begin_override_transition();

  -- At most one ACTIVE override per (organisation, flag_key).
  update public.organisation_feature_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = 'Superseded by a new feature override.'
  where organisation_id = v_org_id
    and flag_key = p_flag_key
    and revoked_at is null
    and expires_at > pg_catalog.now();

  insert into public.organisation_feature_overrides
    (organisation_id, flag_key, reason, granted_by, expires_at)
  values
    (v_org_id, p_flag_key, pg_catalog.btrim(p_reason), (select auth.uid()), p_expires_at)
  returning id into v_id;

  perform private.log_override_event(
    p_action          => 'organisation.feature_override_granted',
    p_target_type     => 'organisation_feature_override',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object(
      'flag_key',   p_flag_key,
      'reason',     pg_catalog.btrim(p_reason),
      'expires_at', p_expires_at)
  );

  perform private.end_override_transition();
  return v_id;
end;
$function$;

-- revoke_feature_override: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.revoke_feature_override(p_override_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
begin
  if not private.has_platform_permission('manage_feature_overrides') then
    raise exception 'revoke_feature_override: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'revoke_feature_override: a reason is required' using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('override');

  perform private.begin_override_transition();

  update public.organisation_feature_overrides
  set revoked_at     = pg_catalog.now(),
      revoked_by     = (select auth.uid()),
      revoked_reason = pg_catalog.btrim(p_reason)
  where id = p_override_id
    and revoked_at is null
  returning organisation_id into v_org_id;

  if v_org_id is null then
    raise exception 'revoke_feature_override: no active override with that id'
      using errcode = '22023';
  end if;

  perform private.log_override_event(
    p_action          => 'organisation.feature_override_revoked',
    p_target_type     => 'organisation_feature_override',
    p_organisation_id => v_org_id,
    p_target_id       => p_override_id,
    p_after           => pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
  );

  perform private.end_override_transition();
  return v_org_id;
end;
$function$;

-- request_impersonation: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.request_impersonation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('impersonate') then
    raise exception 'request_impersonation: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'request_impersonation: a reason is required'
      using errcode = '22023';
  end if;

  select o.id into v_org_id
  from public.organisations o
  where o.slug = pg_catalog.btrim(pg_catalog.lower(p_organisation_slug));

  if v_org_id is null then
    raise exception 'request_impersonation: no organisation with that slug'
      using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('impersonation');

  insert into public.impersonation_sessions
    (superuser_user_id, target_organisation_id, reason, status)
  values
    ((select auth.uid()), v_org_id, pg_catalog.btrim(p_reason), 'requested')
  returning id into v_id;

  perform private.log_audit_event(
    p_action          => 'impersonation.requested',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_correlation_id  => v_id,
    p_before          => null,
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'requested',
                           'reason', pg_catalog.btrim(p_reason))
  );

  return v_id;
end;
$function$;

-- start_impersonation_session: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.start_impersonation_session(p_session_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org     uuid;
  v_expires timestamptz;
begin
  if not private.has_platform_permission('impersonate') then
    raise exception 'start_impersonation_session: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('impersonation');

  update public.impersonation_sessions
  set status      = 'active',
      started_at  = pg_catalog.now(),
      expires_at  = pg_catalog.now() + private.impersonation_time_box()
  where id = p_session_id
    and superuser_user_id = (select auth.uid())
    and status = 'accepted'
  returning target_organisation_id, expires_at into v_org, v_expires;

  -- THE GUARD IS THE UPDATE'S OWN WHERE CLAUSE. Ownership and state are
  -- checked in the statement that changes the row, not in a SELECT before it,
  -- so there is no window between the check and the write in which another
  -- transaction could move the row.
  if v_org is null then
    raise exception 'start_impersonation_session: no accepted session of yours with that id'
      using errcode = '42501';
  end if;

  perform private.log_audit_event(
    p_action          => 'impersonation.started',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'accepted'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'active',
                           'expires_at', v_expires)
  );

  return v_expires;
end;
$function$;

-- set_retention_enabled: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.set_retention_enabled(p_enabled boolean, p_audit_purge_enabled boolean, p_reason text)
 RETURNS retention_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  if not private.has_platform_permission('manage_retention') then
    raise exception 'set_retention_enabled: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'retention_switch_is_superuser_only';
  end if;
  if p_enabled is null or p_audit_purge_enabled is null then
    raise exception 'set_retention_enabled: both switches must be named'
      using errcode = '22023', hint = 'retention_switch_needs_both';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'set_retention_enabled: a reason is required'
      using errcode = '22023', hint = 'retention_switch_needs_a_reason';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('retention_settings');

  select * into v_before from public.retention_settings s where s.id;

  update public.retention_settings s
     set enabled             = p_enabled,
         audit_purge_enabled = p_audit_purge_enabled,
         reason              = pg_catalog.btrim(p_reason),
         updated_at          = pg_catalog.now(),
         updated_by          = (select auth.uid())
   where s.id
  returning * into v_after;

  -- AUDITED LIKE ANY OTHER HIGH-VALUE ADMIN ACTION. The reason travels in the
  -- payload, which is the whole reason it is mandatory: a switch that was
  -- flipped with no recorded why is a switch nobody can reason about later.
  perform private.log_audit_event(
    'retention_settings.changed', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'enabled', v_before.enabled, 'audit_purge_enabled', v_before.audit_purge_enabled),
    pg_catalog.jsonb_build_object(
      'enabled', v_after.enabled, 'audit_purge_enabled', v_after.audit_purge_enabled,
      'reason', v_after.reason));

  return v_after;
end;
$function$;

-- release_audit_purge_ceiling: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.release_audit_purge_ceiling(p_reason text)
 RETURNS retention_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  -- THE PLATFORM SUPERUSER, AT aal2. private.has_platform_permission() is
  -- both halves: the one platform_admins row AND private.session_is_aal2().
  -- Step-up is "any high-risk admin/superuser function" (CLAUDE.md § Session
  -- security) and this one lets the largest delete in the product proceed.
  if not private.has_platform_permission('manage_retention') then
    raise exception 'release_audit_purge_ceiling: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'audit_ceiling_release_is_superuser_only';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'release_audit_purge_ceiling: a reason is required'
      using errcode = '22023', hint = 'audit_ceiling_release_needs_a_reason';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'release_audit_purge_ceiling: the reason is longer than 500 characters'
      using errcode = '22023', hint = 'audit_ceiling_release_reason_too_long';
  end if;

  -- ONE AT A TIME. The row lock serialises two presses; the check refuses a
  -- second release while one is active rather than extending it.
  select * into v_before from public.retention_settings s where s.id for update;
  if private.audit_ceiling_release_active() then
    raise exception 'release_audit_purge_ceiling: a release is already active until %',
      v_before.audit_ceiling_release_expires_at
      using errcode = '55000', hint = 'audit_ceiling_release_already_active';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('retention_settings');

  update public.retention_settings s
     set audit_ceiling_released_at        = pg_catalog.now(),
         audit_ceiling_release_expires_at = pg_catalog.now() + interval '72 hours',
         audit_ceiling_release_reason     = pg_catalog.btrim(p_reason)
   where s.id
  returning * into v_after;

  perform private.log_audit_event(
    'retention.audit_ceiling_released', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'released_at', v_before.audit_ceiling_released_at,
      'expires_at',  v_before.audit_ceiling_release_expires_at),
    pg_catalog.jsonb_build_object(
      'released_at', v_after.audit_ceiling_released_at,
      'expires_at',  v_after.audit_ceiling_release_expires_at,
      'reason',      v_after.audit_ceiling_release_reason));

  return v_after;
end;
$function$;

-- publish_legal_document: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.publish_legal_document(p_document_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row        public.legal_documents%rowtype;
  v_superseded integer;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'publish_legal_document: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  select * into v_row
    from public.legal_documents d
   where d.id = p_document_id and d.status = 'draft'
   for update;
  if not found then
    raise exception 'publish_legal_document: no draft with that id'
      using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('legal_document');

  -- Supersede FIRST: legal_documents_one_published_per_slug is checked per
  -- statement, so the incumbent has to leave before the draft arrives.
  update public.legal_documents d
     set status = 'superseded', superseded_at = pg_catalog.now()
   where d.slug = v_row.slug and d.status = 'published'
  returning d.version into v_superseded;

  update public.legal_documents d
     set status = 'published',
         published_at = pg_catalog.now(),
         published_by = (select auth.uid())
   where d.id = p_document_id;

  perform private.log_audit_event(
    p_action      => 'legal_document.published',
    p_target_type => 'legal_document',
    p_target_id   => p_document_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', v_row.slug,
      'version', v_row.version,
      'superseded_version', v_superseded,
      'counsel_reviewed', v_row.counsel_reviewed_at is not null)
  );
  return p_document_id;
end;
$function$;

-- record_legal_document_counsel_review: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.record_legal_document_counsel_review(p_document_id uuid, p_reviewer text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.legal_documents%rowtype;
begin
  if not private.has_platform_permission('manage_legal_documents') then
    raise exception 'record_legal_document_counsel_review: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reviewer is null or pg_catalog.btrim(p_reviewer) = '' then
    raise exception 'record_legal_document_counsel_review: name the reviewing counsel'
      using errcode = '22023';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): after every refusal that names the
  -- request, before the first write. See this migration's header.
  perform private.consume_step_up('legal_document');

  update public.legal_documents d
     set counsel_reviewed_at = pg_catalog.now(),
         counsel_reviewer = pg_catalog.btrim(p_reviewer),
         counsel_review_recorded_by = (select auth.uid())
   where d.id = p_document_id
     and d.status in ('draft', 'published')
     and d.counsel_reviewed_at is null
  returning d.* into v_row;
  if not found then
    raise exception 'record_legal_document_counsel_review: no unreviewed draft or current version with that id'
      using errcode = '22023';
  end if;

  perform private.log_audit_event(
    p_action      => 'legal_document.counsel_review_recorded',
    p_target_type => 'legal_document',
    p_target_id   => p_document_id,
    p_after       => pg_catalog.jsonb_build_object(
      'slug', v_row.slug, 'version', v_row.version, 'status', v_row.status)
  );
  return p_document_id;
end;
$function$;

-- transition_data_subject_request: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION public.transition_data_subject_request(p_request_id uuid, p_status text, p_rejection_reason text DEFAULT NULL::text)
 RETURNS TABLE(new_status text, changed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ok integer;
begin
  if not (select private.has_platform_permission('oversee_data_subject_requests')) then
    raise exception 'transition_data_subject_request: not permitted' using errcode = '42501';
  end if;
  if p_status = 'withdrawn' then
    -- Withdrawal is the requester's act and has its own function. The trigger
    -- would refuse it anyway (the operator is not the requester); refusing it
    -- here names the reason.
    raise exception 'transition_data_subject_request: only the requester can withdraw a request'
      using errcode = '42501';
  end if;
  if p_status = 'routed' then
    raise exception 'transition_data_subject_request: routing has its own function, which records the handover'
      using errcode = '22023', hint = 'use_route_data_subject_request';
  end if;

  -- STEP-UP, IN THE DATABASE (G13): a REJECTION only -- the one high-risk
  -- move on the register (lib/dsr/admin-actions.ts asks for step-up there
  -- and nowhere else). Before the first write.
  if p_status = 'rejected' then
    perform private.consume_step_up('dsr_rejection');
  end if;

  update public.data_subject_requests d
     set status = p_status,
         rejection_reason = p_rejection_reason
   where d.id = p_request_id
  returning d.status, pg_catalog.now() into new_status, changed_at;
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    raise exception 'transition_data_subject_request: no request with that id'
      using errcode = '22023', hint = 'unknown_request';
  end if;
  return next;
end;
$function$;

-- export_jobs_before_insert: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION private.export_jobs_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := (select auth.uid());
  v_category text;
  v_scope    text;
  v_subject  uuid;
  v_policy   public.rate_limit_policies%rowtype;
  v_window   timestamptz;
  v_count    integer;
  v_after    integer;
  v_retry    integer;
begin
  -- (1) WHO. An export is the requester's own act: no session, no job. The
  -- register's whole download authorisation rests on requested_by, so a
  -- sessionless writer would be a row nobody owns and everybody's 404.
  if v_uid is null then
    raise exception 'export_jobs: an export can only be started from the requester''s own session'
      using errcode = '42501', hint = 'export_needs_a_session';
  end if;
  new.requested_by := v_uid;
  -- The session's OWN assurance level, not a constant. See the column comment.
  new.requested_aal := case
    when coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2' then 'aal2' else 'aal1' end;

  if new.kind is null or new.kind not in ('account', 'workspace') then
    raise exception 'export_jobs: kind must be account or workspace'
      using errcode = '22023', hint = 'unknown_export_kind';
  end if;

  -- (2) MAY THEY. An account export needs nothing but the session -- it is
  -- the person's own data and the statutory route must not be the only route
  -- (the brief's requirement 5). A WORKSPACE export needs the key, and the
  -- key is checked through private.permitted_organisations(), which is the
  -- same function every policy in the schema uses: active membership, the
  -- role's MFA requirement, and the suspension rule (export_organisation_data
  -- is survives_suspension = true, deliberately).
  if new.kind = 'account' then
    new.organisation_id := null;
  else
    if new.organisation_id is null then
      raise exception 'export_jobs: a workspace export must name the workspace'
        using errcode = '22023', hint = 'export_needs_a_workspace';
    end if;
    if new.organisation_id not in (
         select o from private.permitted_organisations('export_organisation_data') o) then
      raise exception 'export_jobs: you cannot export that workspace'
        using errcode = '42501', hint = 'export_not_permitted';
    end if;
  end if;

  -- (2b) A WORKSPACE-CLOSURE BACKUP (Phase 8 Task 9c, 20261021000000). The
  -- column carries no client INSERT grant (column-level grants: kind and
  -- organisation_id only), so a browser cannot even name it; this is the
  -- second fence, for every other writer. It is admitted ONLY inside
  -- public.close_my_workspace(): the transaction-local marker names THIS
  -- workspace, and the workspace was closed by its Owner IN THIS VERY
  -- TRANSACTION (lifecycle_changed_at is the transaction clock).
  if new.closure_backup is distinct from false then
    if new.kind is distinct from 'workspace'
       or coalesce(pg_catalog.current_setting('app.workspace_closure_backup', true), '')
            is distinct from new.organisation_id::text
       or not exists (
         select 1 from public.organisations o
          where o.id = new.organisation_id
            and o.lifecycle_state = 'owner_closed'
            and o.lifecycle_changed_at = pg_catalog.now()) then
      raise exception 'export_jobs: a closure backup is queued only by close_my_workspace()'
        using errcode = '42501', hint = 'closure_backup_is_the_rpcs';
    end if;
  end if;

  -- (3) THE STATE AND THE CLOCK ARE THE DATABASE'S. Everything a job's own
  -- outcome would write is nulled here, so an insert cannot arrive already
  -- claiming to have succeeded.
  new.status         := 'queued';
  new.requested_at   := pg_catalog.now();
  new.started_at     := null;
  new.completed_at   := null;
  new.expires_at     := null;
  new.storage_key    := null;
  new.byte_size      := null;
  new.row_count      := null;
  new.table_count    := null;
  new.manifest       := null;
  new.failure_reason := null;

  -- A closure backup is NOT metered: closing is a one-shot act an Owner
  -- cannot repeat on a closed workspace, and a backup refused by the export
  -- budget would make the closure refuse with it (or, worse, close with no
  -- backup).
  if new.closure_backup then
    return new;
  end if;

  -- (3b) STEP-UP, IN THE DATABASE (G13): a workspace export is a "large
  -- data export". A closure backup returned above: close_my_workspace()
  -- consumed its own token. Before the meter, so a refused post spends
  -- nothing; a meter refusal rolls the consumption back with it.
  if new.kind = 'workspace' then
    perform private.consume_step_up('workspace_export');
  end if;

  -- (4) THE METER -- after every refusal above, so a malformed or
  -- unauthorised post spends nothing. The consent ledger's and the data
  -- subject register's shape, and enforced HERE rather than in the server
  -- action because public.export_jobs carries a client INSERT grant: a
  -- scripted POST straight to PostgREST is a real path, and two meters on one
  -- click would halve the shipped limit.
  if new.kind = 'account' then
    v_category := 'account_export';
    v_scope    := 'user';
    v_subject  := v_uid;
  else
    v_category := 'exports';
    v_scope    := 'organisation';
    v_subject  := new.organisation_id;
  end if;

  select * into v_policy from public.rate_limit_policies p where p.category = v_category;
  if not found then
    raise exception 'export_jobs: no rate-limit policy for %', v_category using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
    from public.rate_limit_counters c
   where c.category      = v_category
     and c.subject_scope = v_scope
     and c.subject_id    = v_subject
     and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  if v_count >= v_policy.max_requests then
    raise exception 'export_jobs: too many exports (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  select r.request_count into v_after
    from private.record_rate_limit_event(
           v_category, v_scope, v_subject,
           case when v_scope = 'organisation' then v_subject end) r;

  if v_after > v_policy.max_requests then
    raise exception 'export_jobs: too many exports (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  return new;
end;
$function$;

-- erasure_jobs_before_insert: live pg_get_functiondef + the step-up line.
CREATE OR REPLACE FUNCTION private.erasure_jobs_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid       uuid := (select auth.uid());
  v_role      text := coalesce(pg_catalog.current_setting('role', true), '');
  v_on_behalf boolean := false;
  v_policy    public.rate_limit_policies%rowtype;
  v_window    timestamptz;
  v_count     integer;
  v_after     integer;
  v_retry     integer;
begin
  if new.kind is null or new.kind not in ('account', 'workspace') then
    raise exception 'erasure_jobs: kind must be account or workspace'
      using errcode = '22023', hint = 'unknown_erasure_kind';
  end if;

  if new.kind = 'account' then
    if v_uid is null then
      raise exception 'erasure_jobs: an account erasure can only be started from the account''s own session'
        using errcode = '42501', hint = 'erasure_needs_a_session';
    end if;

    -- THE OPERATOR ON BEHALF OF A REQUEST (20260930005000). Admitted only
    -- when the caller holds the oversight permission at aal2 AND the named
    -- subject is the requester of an OPEN account-scope erasure request.
    -- Both are facts about rows; neither can be asserted by a session.
    if new.subject_user_id is not null
       and new.subject_user_id <> v_uid
       and (select private.has_platform_permission('oversee_data_subject_requests'))
       and exists (select 1 from public.data_subject_requests d
                    where d.user_id = new.subject_user_id
                      and d.subject_scope = 'account'
                      and d.right_type = 'erasure'
                      and d.status in ('open', 'in_progress')) then
      v_on_behalf := true;
    end if;

    if not v_on_behalf then
      -- ATTRIBUTION IS NOT THE CALLER'S TO SUPPLY.
      new.subject_user_id := v_uid;
    end if;
    new.requested_by    := v_uid;
    new.organisation_id := null;
    new.requested_aal   := case
      when coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2' then 'aal2' else 'aal1' end;

    if new.subject_user_id = private.erased_user_id() then
      raise exception 'erasure_jobs: the tombstone is not a person and cannot be erased'
        using errcode = '42501', hint = 'tombstone_is_nobody';
    end if;

    -- THE Q131 LAST-OWNER GUARD, asked about the SUBJECT (which is the caller
    -- unless the operator is acting on a request), so the refusal arrives
    -- while somebody is still on a page that can act on it.
    perform private.assert_account_is_erasable(new.subject_user_id);

    -- STEP-UP, IN THE DATABASE (G13, Task 2 F4): an account erasure is
    -- irreversible. The REQUESTER's token (the person, or the operator on
    -- behalf of a request through start_erasure_for_request()). After every
    -- refusal above, before the meter.
    perform private.consume_step_up('account_erasure');
  else
    if not (v_uid is null and v_role in ('postgres', 'service_role', 'none', '')) then
      raise exception 'erasure_jobs: a workspace purge is started by the platform, never from a person''s session'
        using errcode = '42501', hint = 'purge_is_server_only';
    end if;
    if new.organisation_id is null then
      raise exception 'erasure_jobs: a workspace purge must name the workspace'
        using errcode = '22023', hint = 'purge_needs_a_workspace';
    end if;
    new.subject_user_id := null;
    new.requested_by    := null;
    new.requested_aal   := 'aal2';
  end if;

  new.status         := 'queued';
  new.requested_at   := pg_catalog.now();
  new.started_at     := null;
  new.completed_at   := null;
  new.summary        := null;
  new.failure_reason := null;

  -- THE METER IS THE REQUESTER'S BUDGET, not the subject's. An operator
  -- answering ten different people's requests is not spending any of their
  -- budgets, and an account cannot be locked out of its own erasure by
  -- somebody else's attempts.
  if new.kind = 'account' then
    select * into v_policy from public.rate_limit_policies p where p.category = 'account_erasure';
    if not found then
      raise exception 'erasure_jobs: no rate-limit policy for account_erasure' using errcode = '22023';
    end if;

    v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
    v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                  (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                    - pg_catalog.now())))::integer);

    select c.request_count into v_count
      from public.rate_limit_counters c
     where c.category = 'account_erasure' and c.subject_scope = 'user'
       and c.subject_id = v_uid and c.window_start = v_window;
    v_count := coalesce(v_count, 0);

    if v_count >= v_policy.max_requests then
      raise exception 'erasure_jobs: too many erasure attempts (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;

    select r.request_count into v_after
      from private.record_rate_limit_event('account_erasure', 'user', v_uid, null) r;

    if v_after > v_policy.max_requests then
      raise exception 'erasure_jobs: too many erasure attempts (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;
  end if;

  return new;
end;
$function$;


-- ---------------------------------------------------------------------------
-- THE RETENTION ROLL: live definition plus private.step_up_tokens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_subjects()
 RETURNS TABLE(table_name text, treatment text, class text, reason text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are purged by the retention runner from public.retention_object_manifest() (expiry and orphans).'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('export_job_parts',            'cascades', null, 'FK to public.export_jobs, ON DELETE CASCADE: a part row goes with its job. Its OBJECT is named by public.retention_object_manifest() on expiry, and is an orphan once its job is failed or gone.'),
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.'),

    -- ---- the notice ledger (added in 20261016000000) ----------------------
    ('private.notification_deliveries', 'cascades', null,
     'One row per connection-request / task-reminder email accepted by Brevo: a notice name, a subject id and a time -- no address, no content. FKs to public.tasks and public.network_connection_requests, ON DELETE CASCADE: a stamp goes with the row it is about, and both of those go with their workspace.'),

    -- ---- the closure-backup marker (added in 20261027000000) -------------
    ('private.closure_backup_reads', 'ephemeral', null,
     'One row per transaction in which public.export_read_page() is reading a closure_backup job (20261025000000, Task 9c C1): a transaction id, the organisation id and the export job id -- no tenant data. Inserted and deleted inside that one call, on both its success and its failure path, so the table is empty at rest (rls_phase8_closure_backup.sql KA7/KM). Nothing to sweep; the FKs also cascade with the workspace and the job.'),

    -- ---- integrations (tables 20261030000000; classes 20261030003000) ---
    ('integration_connections', 'swept', 'integration_connection_revoked',
     'private.sweep_integration_records(): a REVOKED connection, once its class has run from revocation; its token went when it was revoked. A live one goes with its workspace (erase_organisation step 5c deletes the Vault secrets first) or, person-scoped, with its owner''s account (erase_account step 5c) or membership (the membership trigger revokes it).'),
    ('integration_sync_runs',   'swept', 'integration_sync_run',
     'private.sweep_integration_records(): a FINISHED run, once its class has run. Also goes with its connection (composite FK, ON DELETE CASCADE) and its workspace.'),

    -- ---- the first proof of an address (added in 20261104000000) ---------
    ('private.address_first_proofs', 'cascades', null,
     'One row per account whose email address has been proved (Phase 10 Task 20, Q245): a user id, a time and whether the pre-proof password was kept -- no address, no content. FK to auth.users, ON DELETE CASCADE: it goes with the account, in private.erase_account(), and on no clock of its own.'),

    -- ---- step-up tokens (added in 20261108001000) -------------------------
    ('private.step_up_tokens', 'ephemeral', null,
     'One row per step-up the app''s server recorded (Phase 10 Task 6, G13): a user id, a purpose and three times -- no content. Valid five minutes; public.mint_step_up_token() deletes every expired row on each mint, so the table holds minutes of rows at rest. FK to auth.users, ON DELETE CASCADE: it goes with the account.')
$function$;
