-- ===========================================================================
-- PHASE 8 TASK 9c, JOB 1 -- AN OWNER MAY CLOSE THEIR OWN WORKSPACE
--
-- FOUNDER RULING 2026-09-30 (DECISIONS-QUEUE "FOUNDER ANSWERS -- 2026-09-30"):
-- Q176/Q178 CHANGED, and this REVERSES Q104's "no customer closure". CLAUDE.md
-- already named the shape: "customer-initiated closure, if wanted, is a fourth
-- audited RPC rather than a column write". This is that RPC.
--
-- WHAT THIS MIGRATION DOES (the database half; the superuser decision item,
-- the reassign/delete actions and the emails are job 2, the Owner UI job 3):
--
--   1. A FOURTH lifecycle state, 'owner_closed'. It is wound down, so the
--      invariant organisations_lifecycle_matches_deleted_at FORCES deleted_at
--      to be set with it -- which is THE read-only flag every permission gate
--      reads (20260908030000 header). Closed = read-only for members with NO
--      gate edited: reads survive (view_crm, export_organisation_data are
--      survives_suspension), every write refuses. And because the sync
--      trigger stamps retention_expires_at for every non-active state, the
--      Q88 60-day purge (20261003002000) applies to a closed workspace with
--      nothing added. A separate `closed_at` column was rejected for the
--      reason that header gives at length: thirty gates would have to learn
--      it.
--
--   2. public.close_my_workspace(p_organisation_id, p_confirmation, p_reason)
--      -- SECURITY DEFINER, guard first: a session; aal2 (step-up); an ACTIVE
--      OWNER membership of THAT workspace (a direct membership row, so an
--      impersonating superuser cannot close a customer's workspace); the
--      workspace still active; p_confirmation EXACTLY equal to the
--      workspace's SLUG (unique, ASCII and stable -- a name may be duplicated
--      or carry characters people cannot type; no normalisation); a
--      non-blank reason of at most 500 characters after trimming. The UPDATE
--      runs as the function owner, so the lifecycle guard and
--      organisations_update_manage_organisation are UNCHANGED and still
--      refuse an Owner's direct PATCH of the lifecycle columns. Audited as
--      organisation.closed_by_owner, actor from the session, on one
--      correlation thread with the backup's export_job.requested row.
--
--   3. THE BACKUP. The RPC inserts a public.export_jobs row (kind
--      'workspace', closure_backup = true) in the SAME transaction, through
--      the Task 4 pipeline's own BEFORE INSERT trigger (requester stamped
--      from the session, export_organisation_data checked -- it survives
--      suspension). It is unmetered and exempt from the one-live-workspace-
--      job index (a closure must never be refused, or worse go through
--      without a backup, because an ordinary export was queued). Its archive
--      is kept until the CLOSED WORKSPACE'S own retention_expires_at (never
--      less than the ordinary 7 days). HOW JOB 2 FINDS IT: export_jobs where
--      organisation_id = <org> and closure_backup, latest requested_at; its
--      id is also in the organisation.closed_by_owner audit row's
--      after.backup_export_job_id.
--
-- LESSON 15 (which columns can the browser write, and what pins each):
--   export_jobs.closure_backup -- authenticated holds column-level INSERT on
--   kind and organisation_id only, so the column is not insertable; the
--   BEFORE INSERT trigger refuses it outside close_my_workspace() for every
--   other writer; the BEFORE UPDATE trigger makes it immutable. No client
--   UPDATE grant exists on export_jobs at all. organisations: no new column.
-- ===========================================================================

-- 1. THE STATE ---------------------------------------------------------------
alter table public.organisations
  drop constraint organisations_lifecycle_state_known;
alter table public.organisations
  add constraint organisations_lifecycle_state_known
  check (lifecycle_state in ('active', 'suspended', 'deleted', 'owner_closed'));

comment on constraint organisations_lifecycle_state_known on public.organisations is
  'The four lifecycle states. ''owner_closed'' (Phase 8 Task 9c, 20261021000000; founder 2026-09-30 Q176/Q178, reversing Q104) is the only one an Owner can enter, and only through public.close_my_workspace(). Every non-active state is read-only by construction: organisations_lifecycle_matches_deleted_at forces deleted_at with it, and deleted_at is the flag every permission gate reads.';

-- 2. THE BACKUP MARKER ------------------------------------------------------
alter table public.export_jobs
  add column closure_backup boolean not null default false;

comment on column public.export_jobs.closure_backup is
  'TRUE for the full workspace backup public.close_my_workspace() queues in the same transaction as the closure (Phase 8 Task 9c). Not client-insertable (authenticated holds column-level INSERT on kind and organisation_id only), refused by private.export_jobs_before_insert() outside that RPC, immutable under private.export_jobs_before_update(). Effects: unmetered; exempt from export_jobs_one_live_workspace_job; its archive is kept until the closed workspace''s retention_expires_at (the Q88 clock). The superuser decision flow finds the backup as the latest closure_backup row for the organisation, or by the audit row organisation.closed_by_owner after.backup_export_job_id.';

drop index public.export_jobs_one_live_workspace_job;
create unique index export_jobs_one_live_workspace_job
  on public.export_jobs (organisation_id)
  where kind = 'workspace' and status in ('queued', 'running') and not closure_backup;

-- 3. THE PIPELINE'S TWO TRIGGERS, rebuilt from their LIVE definitions (lesson 4)
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

CREATE OR REPLACE FUNCTION private.export_jobs_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid            uuid := (select auth.uid());
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), '');
  v_server_session boolean;
  v_days           integer;
begin
  -- AN OPEN LIST OF SERVER ROLES, not a closed list of client ones: a role
  -- this schema has never heard of arrives REFUSED rather than admitted by
  -- omission. `none` and the empty string are what current_setting('role')
  -- answers for a plain superuser session that has not `set role`. Neither
  -- leg is bypassable by SECURITY DEFINER: it changes the current USER and
  -- touches neither the JWT claims nor the `role` SETTING, so both still
  -- describe whoever issued the statement.
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  if not v_server_session then
    raise exception 'export_jobs: a job''s progress is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_outcome_is_server_only';
  end if;

  -- THE REQUEST ITSELF IS IMMUTABLE. Who asked, which kind, which workspace
  -- and when: the archive's provenance, and nothing may rewrite it.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind
     or new.organisation_id is distinct from old.organisation_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_aal is distinct from old.requested_aal
     or new.requested_at is distinct from old.requested_at
     or new.closure_backup is distinct from old.closure_backup then
    raise exception 'export_jobs: the request itself is immutable -- only its progress and its outcome may change'
      using errcode = '42501', hint = 'export_request_is_immutable';
  end if;

  -- A CLOSED JOB IS IMMUTABLE. A succeeded archive cannot be re-pointed at
  -- another key, and a failure cannot be quietly turned into a success.
  if old.status in ('succeeded', 'failed') then
    raise exception 'export_jobs: a finished job is not rewritten'
      using errcode = '22023', hint = 'export_job_is_finished';
  end if;

  if not (   (old.status = 'queued'  and new.status in ('running', 'failed'))
          or (old.status = 'running' and new.status in ('succeeded', 'failed'))) then
    raise exception 'export_jobs: a job cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_export_transition';
  end if;

  -- THE STAMPS ARE THE DATABASE'S, so a finished job's times say when it
  -- finished rather than what a runner claimed.
  if new.status = 'running' then
    new.started_at := pg_catalog.now();
  else
    new.started_at := old.started_at;
  end if;

  if new.status in ('succeeded', 'failed') then
    new.completed_at := pg_catalog.now();
  end if;

  if new.status = 'succeeded' then
    select l.archive_days into v_days from private.export_limits() l;
    new.expires_at := pg_catalog.now() + pg_catalog.make_interval(days => v_days);
    -- A CLOSURE BACKUP is kept for as long as the closed workspace itself is
    -- (private.organisation_retention_days(), through retention_expires_at --
    -- the same Q88 clock the 60-day purge reads), never less than an ordinary
    -- archive. greatest() ignores a null, so a workspace reinstated before the
    -- backup finished gets the ordinary window.
    if old.closure_backup then
      new.expires_at := greatest(new.expires_at,
        (select o.retention_expires_at from public.organisations o
          where o.id = old.organisation_id));
    end if;
    new.failure_reason := null;
  else
    new.expires_at := null;
  end if;

  return new;
end;
$function$;

-- 4. THE RPC ------------------------------------------------------------------
create or replace function public.close_my_workspace(
  p_organisation_id uuid, p_confirmation text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_org     record;
  v_corr    uuid := pg_catalog.gen_random_uuid();
  v_reason  text := pg_catalog.btrim(p_reason);
  v_job     uuid;
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
   where id = p_organisation_id;

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
$$;

comment on function public.close_my_workspace(uuid, text, text) is
  'THE FOURTH AUDITED LIFECYCLE RPC (Phase 8 Task 9c; founder 2026-09-30, Q176/Q178 changed, reversing Q104). An ACTIVE OWNER (membership row; an impersonator cannot) of an ACTIVE workspace, at aal2, closes it: p_confirmation must equal the workspace slug exactly, p_reason must be non-blank and at most 500 characters after trimming. Sets lifecycle_state = owner_closed (deleted_at with it, so the workspace is read-only for every member and the Q88 60-day purge clock runs), queues a full workspace backup through the Task 4 export pipeline in the same transaction (export_jobs.closure_backup), and writes organisation.closed_by_owner with the reason and backup_export_job_id, all on one correlation thread. Returns the backup job id. The lifecycle guard and organisations_update_manage_organisation are unchanged: this RPC is the only way an Owner can close.';

revoke all on function public.close_my_workspace(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.close_my_workspace(uuid, text, text) to authenticated;

-- 5. THE AUDIT CATALOGUE: the database copy (private.platform_audit_actions(),
-- 20261005001000) gains organisation.closed_by_owner in the same position as
-- PLATFORM_AUDIT_ACTIONS (lib/admin/audit-actions.ts). Rebuilt from LIVE.
CREATE OR REPLACE FUNCTION private.platform_audit_actions()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
    ('membership.accepted'),
    ('document_uploaded'),
    ('document_downloaded'),
    ('document_deleted'),
    ('document_quarantined'),
    ('network_profile.published'),
    ('network_profile.unpublished'),
    ('network_profile.visibility_changed'),
    ('network_connection.requested'),
    ('network_connection.accepted'),
    ('network_connection.declined'),
    ('network_connection.withdrawn'),
    ('network_connection.updated'),
    ('audit_log.viewed'),
    ('impersonation.requested'),
    ('impersonation.accepted'),
    ('impersonation.declined'),
    ('impersonation.started'),
    ('impersonation.page_viewed'),
    ('impersonation.ended'),
    ('impersonation.expired'),
    ('organisation.suspended'),
    ('organisation.deleted'),
    ('organisation.reinstated'),
    ('organisation.closed_by_owner'),
    ('organisation.billing_override_granted'),
    ('organisation.billing_override_revoked'),
    ('organisation.feature_override_granted'),
    ('organisation.feature_override_revoked'),
    ('platform_health.viewed'),
    ('incident_alert.resolved'),
    ('incident_alert.reopened'),
    ('feedback.submitted'),
    ('feedback.status_changed'),
    ('feedback.screenshot_viewed'),
    ('legal_document.draft_created'),
    ('legal_document.draft_updated'),
    ('legal_document.published'),
    ('legal_document.counsel_review_recorded'),
    ('consent.granted'),
    ('consent.withdrawn'),
    ('data_subject_request.submitted'),
    ('data_subject_request.in_progress'),
    ('data_subject_request.routed'),
    ('data_subject_request.fulfilled'),
    ('data_subject_request.rejected'),
    ('data_subject_request.withdrawn'),
    ('data_subject_request.fulfilment_recorded'),
    ('data_subject_request.note_added'),
    ('data_subject_request.rerouted'),
    ('export_job.requested'),
    ('export_job.downloaded'),
    ('erasure_job.requested'),
    ('account.erased'),
    ('organisation.erased'),
    ('retention_settings.changed'),
    ('retention.swept'),
    ('retention.audit_ceiling_released')
$function$
;
