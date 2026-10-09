-- PHASE 8 TASK 9c, JOB 2 -- THE SUPERUSER DECIDES A CLOSED WORKSPACE.
--
-- Founder 2026-09-30 (Q176/Q178 changed, reversing Q104): closing a workspace
-- emails the superuser and raises an item on the superuser dashboard; from it
-- the founder either REASSIGNS the workspace to a new Owner or DELETES it
-- permanently. Both are step-up gated, need a reason, are audited and notify
-- the org's remaining Admins. This migration is the database half:
--
--   1. private.notification_deliveries gains audit_event_id and three
--      notices (workspace_closed / _reassigned / _deleted), keyed on the
--      audit row of the event; mark_notices_delivered/_undeliverable rebuilt
--      from LIVE with one more branch (state rule: the audit row exists and
--      is of the notice's action).
--   2. public.reassign_closed_workspace(slug, new_owner, reason) and
--      public.delete_closed_workspace(slug, reason): superuser, aal2, reason,
--      owner_closed only. Delete reuses the Q88 purge (no second engine).
--   3. public.closed_workspaces_awaiting_decision(...): the dashboard list.
--   4. Two service_role queues for the sender on the existing tick.
--   5. The audit catalogue gains organisation.closure_reassigned and
--      organisation.closure_deleted (rebuilt from LIVE).
--
-- If the founder never acts, nothing here touches the closed workspace: the
-- Q88 clock close_my_workspace() started still runs and the hourly sweep
-- still purges it at 60 days.

-- ---------------------------------------------------------------------------
-- 1. THE LEDGER LEARNS THREE NOTICES, keyed on their AUDIT ROW.
--
--    The subject of each is the audit row that recorded the event: one
--    closure = one organisation.closed_by_owner row, one decision = one
--    organisation.closure_reassigned / .closure_deleted row. Keyed on the
--    audit row rather than the organisation because a workspace can be
--    closed, reopened and closed again (each closure is its own email), and
--    because a permanently deleted workspace's row is GONE by the time the
--    tick runs while its audit row survives (organisation_id ON DELETE SET
--    NULL). FK-cascades with the audit row (purged at 30 days; the resolvers'
--    seven-day window is inside that).
-- ---------------------------------------------------------------------------
alter table private.notification_deliveries
  add column audit_event_id uuid references public.audit_events (id) on delete cascade;

alter table private.notification_deliveries
  drop constraint notification_deliveries_notice_check,
  add constraint notification_deliveries_notice_check
    check (notice in ('connection_received', 'connection_accepted', 'connection_declined',
                      'task_reminder',
                      'workspace_closed', 'workspace_reassigned', 'workspace_deleted')),
  drop constraint notification_deliveries_one_subject,
  add constraint notification_deliveries_one_subject check (
    case when notice = 'task_reminder'
           then task_id is not null and request_id is null and audit_event_id is null
         when notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted')
           then audit_event_id is not null and request_id is null and task_id is null
         else request_id is not null and task_id is null and audit_event_id is null end);

create unique index notification_deliveries_audit_event_once
  on private.notification_deliveries (audit_event_id, notice) where audit_event_id is not null;

comment on column private.notification_deliveries.audit_event_id is
  'The subject of the three workspace-closure notices (20261022001000, Task 9c job 2): the organisation.closed_by_owner / organisation.closure_reassigned / organisation.closure_deleted audit row the email is about. ON DELETE CASCADE with that row. Pinned by notification_deliveries_one_subject (exactly one subject column per notice) and notification_deliveries_audit_event_once (written once).';

-- The notice -> audit action map, in one place for both write paths.
create or replace function private.closure_notice_action(p_notice text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_notice
           when 'workspace_closed'     then 'organisation.closed_by_owner'
           when 'workspace_reassigned' then 'organisation.closure_reassigned'
           when 'workspace_deleted'    then 'organisation.closure_deleted'
         end
$$;
revoke all on function private.closure_notice_action(text) from public, anon, authenticated, service_role;

-- 2. THE TWO WRITE PATHS, rebuilt from LIVE with one more branch.
CREATE OR REPLACE FUNCTION public.mark_notices_delivered(p_notice text, p_subject_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_notices_delivered: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id)
    select 'task_reminder', t.id
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id)
    select p_notice, r.id
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  elsif p_notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted') then
    insert into private.notification_deliveries (notice, audit_event_id)
    select p_notice, a.id
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = private.closure_notice_action(p_notice)
    on conflict do nothing;
  else
    raise exception 'mark_notices_delivered: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_notices_undeliverable(p_notice text, p_subject_ids uuid[], p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_notices_undeliverable: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_reason is null or p_reason not in ('content_refused', 'no_recipient') then
    raise exception 'mark_notices_undeliverable: unknown reason %', p_reason
      using errcode = '22023', hint = 'notification_reason_unknown';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id, outcome, reason)
    select 'task_reminder', t.id, 'undeliverable', p_reason
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id, outcome, reason)
    select p_notice, r.id, 'undeliverable', p_reason
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  elsif p_notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted') then
    insert into private.notification_deliveries (notice, audit_event_id, outcome, reason)
    select p_notice, a.id, 'undeliverable', p_reason
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = private.closure_notice_action(p_notice)
    on conflict do nothing;
  else
    raise exception 'mark_notices_undeliverable: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;



-- ---------------------------------------------------------------------------
-- 3. THE SUPERUSER'S TWO DECISIONS.
--
--    SECURITY DEFINER (each writes a membership and the organisation row, and
--    the membership write is not the superuser's to make through RLS), so the
--    gates are in the body, in this order, each with its own hint so a
--    mutation of one is visible on its own:
--      a session                          decision_needs_a_session
--      the platform superuser             decision_needs_superuser
--      aal2 (step-up)                     decision_needs_step_up
--      a reason, trimmed, <= 500          decision_reason_required / _too_long
--      the slug names a workspace         decision_no_such_workspace
--      it is owner_closed, locked         decision_workspace_not_owner_closed
--    The superuser check reads public.platform_admins directly, NOT
--    has_platform_permission(), so aal2 is a separate, separately mutable gate.
-- ---------------------------------------------------------------------------
create or replace function private.closure_decision_target(p_slug text, p_reason text)
returns table (id uuid, slug text, name text, lifecycle_state text, deleted_at timestamptz,
               lifecycle_changed_at timestamptz, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if v_uid is null then
    raise exception 'closure decision: sign in first'
      using errcode = '42501', hint = 'decision_needs_a_session';
  end if;
  if not exists (select 1 from public.platform_admins pa where pa.user_id = v_uid) then
    raise exception 'closure decision: only the platform superuser decides a closed workspace'
      using errcode = '42501', hint = 'decision_needs_superuser';
  end if;
  if not private.session_is_aal2() then
    raise exception 'closure decision: re-authenticate with your second factor first'
      using errcode = '42501', hint = 'decision_needs_step_up';
  end if;
  if v_reason is null or v_reason = '' then
    raise exception 'closure decision: a reason is required'
      using errcode = '22023', hint = 'decision_reason_required';
  end if;
  if pg_catalog.char_length(v_reason) > 500 then
    raise exception 'closure decision: the reason is limited to 500 characters'
      using errcode = '22023', hint = 'decision_reason_too_long';
  end if;

  return query
    select o.id, o.slug, o.name, o.lifecycle_state, o.deleted_at, o.lifecycle_changed_at, v_reason
      from public.organisations o
     where o.slug = pg_catalog.btrim(pg_catalog.lower(p_slug))
       for update;
  if not found then
    raise exception 'closure decision: no workspace with that address'
      using errcode = '22023', hint = 'decision_no_such_workspace';
  end if;
end;
$$;
revoke all on function private.closure_decision_target(text, text) from public, anon, authenticated, service_role;

-- The org's REMAINING active Owners and Admins, as user ids, snapshotted into
-- the decision's audit row: the email resolver reads them from there, so a
-- permanently deleted workspace (whose memberships the purge cascades away)
-- still has its notice addressed. The tombstone is never a recipient.
create or replace function private.closure_decision_recipients(p_organisation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(m.user_id order by m.user_id), '[]'::jsonb)
    from public.organisation_memberships m
   where m.organisation_id = p_organisation_id
     and m.status = 'active'
     and m.role in ('owner', 'admin')
     and m.user_id <> private.erased_user_id()
$$;
revoke all on function private.closure_decision_recipients(uuid) from public, anon, authenticated, service_role;

create or replace function public.reassign_closed_workspace(
  p_organisation_slug text, p_new_owner_user_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_role   text;
  v_backup uuid;
  v_audit  uuid;
begin
  select * into v_t from private.closure_decision_target(p_organisation_slug, p_reason);

  if v_t.lifecycle_state is distinct from 'owner_closed' then
    raise exception 'reassign_closed_workspace: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'decision_workspace_not_owner_closed';
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
  update public.organisations set deleted_at = null where id = v_t.id;

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
$$;

comment on function public.reassign_closed_workspace(text, uuid, text) is
  'THE SUPERUSER''S FIRST DECISION ON A CLOSED WORKSPACE (Phase 8 Task 9c job 2; founder 2026-09-30, Q176/Q178). Platform superuser, at aal2, mandatory reason (<= 500), ONLY while the workspace is owner_closed: makes p_new_owner_user_id -- which must be an ACTIVE member of that workspace -- an Owner and REOPENS it (deleted_at cleared, so lifecycle_state returns to active and the Q88 purge clock is cancelled). Audited as organisation.closure_reassigned (who, their previous role, the reason, the backup job, and the remaining active Owners/Admins the notice goes to). Returns the audit row id. Existing Owners are left as they are (Q208).';
revoke all on function public.reassign_closed_workspace(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reassign_closed_workspace(text, uuid, text) to authenticated;

create or replace function public.delete_closed_workspace(p_organisation_slug text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_t      record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_backup uuid;
  v_audit  uuid;
  v_after  record;
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
   where id = v_t.id;
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
$$;

comment on function public.delete_closed_workspace(text, text) is
  'THE SUPERUSER''S SECOND DECISION ON A CLOSED WORKSPACE (Phase 8 Task 9c job 2; founder 2026-09-30). Platform superuser, at aal2, mandatory reason (<= 500), ONLY while owner_closed: moves the workspace to lifecycle_state deleted and makes it due for the EXISTING Q88 purge immediately (lifecycle_changed_at dated one retention period back, so retention_expires_at is in the past) -- the next hourly retention run purges its bytes and then calls private.erase_organisation() through sweep_expired_workspaces(), exactly as for a workspace whose 60 days ran out. No second deletion engine. Audited as organisation.closure_deleted with the remaining active Owners/Admins the notice goes to (snapshotted, because the purge cascades the memberships). Returns the audit row id. Reversible with reinstate_organisation() until the purge runs.';
revoke all on function public.delete_closed_workspace(text, text) from public, anon, authenticated, service_role;
grant execute on function public.delete_closed_workspace(text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. THE DASHBOARD ITEM: closed workspaces awaiting a decision.
--    Superuser at aal2 only; keyset-paginated on (closed_at, id), at most 50
--    a page; AGGREGATE METADATA ONLY -- name, slug, clocks, an active-member
--    count and the backup job's status. No record content, no member names.
-- ---------------------------------------------------------------------------
create or replace function public.closed_workspaces_awaiting_decision(
  p_after_closed_at timestamptz default null, p_after_id uuid default null, p_limit integer default 25)
returns table (
  organisation_id uuid, slug text, name text, closed_at timestamptz, purge_due_at timestamptz,
  active_members bigint, backup_export_job_id uuid, backup_status text, backup_expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'closed_workspaces_awaiting_decision: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'decision_needs_superuser';
  end if;

  return query
    select o.id, o.slug, o.name, o.lifecycle_changed_at, o.retention_expires_at,
           (select pg_catalog.count(*) from public.organisation_memberships m
             where m.organisation_id = o.id and m.status = 'active'),
           b.id, b.status, b.expires_at
      from public.organisations o
      left join lateral (
        select j.id, j.status, j.expires_at from public.export_jobs j
         where j.organisation_id = o.id and j.closure_backup
         order by j.requested_at desc limit 1) b on true
     where o.lifecycle_state = 'owner_closed'
       and (p_after_closed_at is null
            or (o.lifecycle_changed_at, o.id) > (p_after_closed_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
     order by o.lifecycle_changed_at, o.id
     limit greatest(1, least(coalesce(p_limit, 25), 50));
end;
$$;
comment on function public.closed_workspaces_awaiting_decision(timestamptz, uuid, integer) is
  'The /super "Closed workspaces awaiting decision" list (Task 9c job 2). Platform superuser at aal2 only. Keyset (closed_at, id), at most 50 per page. Aggregate metadata only: name, slug, closed-at, purge-due-at, active member COUNT, and the latest closure backup job''s id/status/expiry -- never record content. There is no superuser download of the backup (Q209): status only.';
revoke all on function public.closed_workspaces_awaiting_decision(timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.closed_workspaces_awaiting_decision(timestamptz, uuid, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. THE EMAIL QUEUES (service_role only, no user argument, <= 30, 7 days).
-- ---------------------------------------------------------------------------
-- To the SUPERUSER (the sender addresses SUPPORT_CONTACT_EMAIL, the erasure-
-- failure notice's inbox): one notice per closure. Content: slug, name and
-- closed-at -- nothing from inside the workspace.
create or replace function public.pending_workspace_closure_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, organisation_slug text, organisation_name text, closed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_workspace_closure_notifications: read by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;
  return query
    select a.id, o.slug, o.name, a.created_at
      from public.audit_events a
      join public.organisations o on o.id = a.organisation_id
     where a.action = 'organisation.closed_by_owner'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and not exists (select 1 from private.notification_deliveries d
                        where d.audit_event_id = a.id and d.notice = 'workspace_closed')
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;
revoke all on function public.pending_workspace_closure_notifications(integer) from public, anon, authenticated;
grant execute on function public.pending_workspace_closure_notifications(integer) to service_role;

-- To the org's remaining active Owners/Admins, as snapshotted on the decision.
-- Content: the decision (reassigned / deleted), slug and name from the
-- decision's own payload (the workspace row may already be purged), decided-at.
-- Never the reason, never who the superuser is, never the new Owner's name.
create or replace function public.pending_workspace_decision_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, notice text, emails text[], organisation_slug text,
               organisation_name text, decided_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_workspace_decision_notifications: read by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;
  return query
    select a.id,
           case a.action when 'organisation.closure_reassigned' then 'workspace_reassigned'
                         else 'workspace_deleted' end,
           (select pg_catalog.array_agg(u.email::text order by u.email)
              from pg_catalog.jsonb_array_elements_text(coalesce(a.after -> 'notify_user_ids', '[]'::jsonb)) r(uid)
              join auth.users u on u.id = r.uid::uuid
             where u.id <> private.erased_user_id() and u.email is not null),
           a.after ->> 'organisation_slug', a.after ->> 'organisation_name', a.created_at
      from public.audit_events a
     where a.action in ('organisation.closure_reassigned', 'organisation.closure_deleted')
       and a.created_at > pg_catalog.now() - interval '7 days'
       and not exists (select 1 from private.notification_deliveries d
                        where d.audit_event_id = a.id
                          and d.notice in ('workspace_reassigned', 'workspace_deleted'))
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;
revoke all on function public.pending_workspace_decision_notifications(integer) from public, anon, authenticated;
grant execute on function public.pending_workspace_decision_notifications(integer) to service_role;

-- 6. THE AUDIT CATALOGUE (database copy), rebuilt from LIVE.
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
    ('organisation.closure_reassigned'),
    ('organisation.closure_deleted'),
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
$function$;
