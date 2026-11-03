-- Phase 8 Task 9c job 1 mutant, from the LIVE pg_get_functiondef at 225 migrations.
-- the mandatory reason is not checked.
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
  if false then
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
$function$;
