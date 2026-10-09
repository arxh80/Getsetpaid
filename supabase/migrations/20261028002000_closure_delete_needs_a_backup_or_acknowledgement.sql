-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 2 -- A PERMANENT DELETE OF A CLOSED WORKSPACE
-- NEEDS ITS BACKUP, OR AN EXPLICIT ACKNOWLEDGEMENT (re-review N3a).
--
-- A closure backup can FAIL -- reaped to failed after an hour stuck running,
-- or deterministically over the export ceilings (50k rows per table, 500k in
-- total, 40 MiB) -- and nothing re-queues it (Q228). delete_closed_workspace()
-- did not look: the purge it brings forward then took the workspace, its
-- seven-year finance ledger included, with no copy anywhere.
--
-- Now: refused (22023 decision_backup_not_succeeded) unless the latest
-- closure backup is `succeeded`, or the superuser passes
-- p_acknowledge_no_backup = true. The audit row's `after` records
-- backup_status and acknowledged_no_backup (true exactly when the delete
-- went ahead without a succeeded backup, so an acknowledgement passed over a
-- good backup is not recorded as one). /super/closures shows the status and
-- asks for a checkbox when it is not succeeded.
--
-- A new argument with a DEFAULT would be an overload beside the old
-- function, so the two-argument one is DROPPED and the grants re-issued.
-- Rebuilt from the LATEST pg_get_functiondef (20261028000000). ADDITIVE in
-- effect: no previously applied migration is edited.
--
-- N3b (the backup's bytes kept until the purge, not 7 days) was ALREADY
-- BUILT by 20261022000000's export_jobs status stamp: a succeeded
-- closure_backup's expires_at = greatest(now + archive_days,
-- organisations.retention_expires_at), pinned by the closure suite's CB6.
-- ===========================================================================

drop function public.delete_closed_workspace(text, text);

CREATE FUNCTION public.delete_closed_workspace(p_organisation_slug text, p_reason text, p_acknowledge_no_backup boolean DEFAULT false)
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
      'backup_status',        coalesce(v_backup_status, 'none'),
      'acknowledged_no_backup', (v_backup_status is distinct from 'succeeded'),
      'organisation_slug',    v_t.slug,
      'organisation_name',    v_t.name,
      'notify_user_ids',      private.closure_decision_recipients(v_t.id)));

  perform private.end_lifecycle_transition();
  return v_audit;
end;
$function$;

comment on function public.delete_closed_workspace(text, text, boolean) is
  'THE SUPERUSER''S SECOND DECISION ON A CLOSED WORKSPACE (Phase 8 Task 9c job 2; founder 2026-09-30). Platform superuser, at aal2, mandatory reason (<= 500), ONLY while owner_closed, and (since 20261028002000, N3a) only when the latest closure backup SUCCEEDED or p_acknowledge_no_backup is true (else 22023 decision_backup_not_succeeded): moves the workspace to lifecycle_state deleted and makes it due for the EXISTING Q88 purge immediately (lifecycle_changed_at dated one retention period back) -- the next hourly retention run purges its bytes and then calls private.erase_organisation() through sweep_expired_workspaces(). No second deletion engine. Audited as organisation.closure_deleted with the backup job, its status, whether the delete went ahead without a succeeded backup (acknowledged_no_backup), and the remaining active Owners/Admins the notice goes to. Returns the audit row id. Reversible with reinstate_organisation() until the purge runs, while the workspace still has an active Owner (20261028001000, N2).';
revoke all on function public.delete_closed_workspace(text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.delete_closed_workspace(text, text, boolean) to authenticated;
