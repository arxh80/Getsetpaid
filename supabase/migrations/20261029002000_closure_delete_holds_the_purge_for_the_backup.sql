-- ===========================================================================
-- PHASE 8 FINAL REVIEW A, I2 -- A SUPERUSER DELETE OF A CLOSED WORKSPACE NO
-- LONGER DESTROYS ITS CLOSURE BACKUP WITHIN THE HOUR (Q229, built as the
-- recommended default, controller 2026-10-05, PENDING FOUNDER).
--
-- Mechanism: delete_closed_workspace() dates lifecycle_changed_at one
-- retention period back, so the next hourly retention run's
-- sweep_expired_workspaces() calls erase_organisation();
-- export_jobs.organisation_id ... on delete cascade (20260927001000:82)
-- takes the succeeded closure_backup row with it, the archive becomes an
-- orphan and the orphan sweep deletes it. The closing Owner -- the only
-- person who may download it (Q226) -- loses it, often before the decision
-- email arrives.
--
-- Rule: the purge of a workspace deleted through delete_closed_workspace()
-- is HELD until its latest closure backup has been downloaded by its
-- requester (an export_job.downloaded audit row whose actor is the job's
-- requested_by) OR private.closure_backup_hold() (30 days) after the
-- decision, whichever first; and that backup's expires_at is raised to at
-- least decision + the hold, so it stays downloadable for all of it.
--
-- What is NOT changed, by construction of private.closure_backup_owed():
--   * an undecided closure (lifecycle_state owner_closed) purges on the Q88
--     60-day clock -- the predicate keys on lifecycle_state 'deleted';
--   * reassign_closed_workspace() is untouched (the workspace reopens; there
--     is no purge to hold);
--   * a Phase 7 delete_organisation() of a once-closed, reopened workspace:
--     its old closure backup expired before that purge falls due (its
--     expires_at is the earlier closure's deadline, Q211), so the predicate's
--     expires_at > now() is false and nothing is held;
--   * a closing Owner who erased (Q206: requested_by re-pointed at the
--     tombstone) can never produce a download row, so the purge waits the
--     full hold and then runs -- bounded, never un-purgeable;
--   * nothing else: the hold is bounded by retention_expires_at > now() -
--     the hold, and the decision dates retention_expires_at to the decision.
--     A held workspace's document bytes are still purged on schedule (the
--     backup lives in the exports bucket, not documents).
-- Functions rebuilt from their LATEST pg_get_functiondef (export_jobs_
-- before_update from 20261022000000, delete_closed_workspace from
-- 20261028002000, sweep_expired_workspaces from 20261003002000).
-- ===========================================================================

create function private.closure_backup_hold()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

comment on function private.closure_backup_hold() is
  'Q229 (Phase 8 final review A, I2; controller 2026-10-05, pending founder): how long after a superuser deletes a closed workspace its purge may be HELD for the closing Owner to download the closure backup -- 30 days. One place, read by private.closure_backup_owed() and public.delete_closed_workspace() (which raises the backup''s expires_at to at least now() + this).';

revoke all on function private.closure_backup_hold() from public, anon, authenticated, service_role;

create function private.closure_backup_owed(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organisations o
      join lateral (
        select j.id, j.status, j.requested_by, j.expires_at
          from public.export_jobs j
         where j.organisation_id = o.id and j.closure_backup
         order by j.requested_at desc
         limit 1) b on true
     where o.id = p_organisation_id
       and o.lifecycle_state = 'deleted'
       and o.retention_expires_at is not null
       and o.retention_expires_at > pg_catalog.now() - private.closure_backup_hold()
       and b.status = 'succeeded'
       and b.expires_at is not null
       and b.expires_at > pg_catalog.now()
       and not exists (
         select 1 from public.audit_events a
          where a.organisation_id = o.id
            and a.action = 'export_job.downloaded'
            and a.target_type = 'export_job'
            and a.target_id = b.id
            and a.actor_user_id = b.requested_by));
$$;

comment on function private.closure_backup_owed(uuid) is
  'Q229 (Phase 8 final review A, I2; controller 2026-10-05, pending founder): TRUE while a workspace the superuser deleted through delete_closed_workspace() still owes its closing Owner the closure backup -- lifecycle_state deleted, its LATEST closure_backup job succeeded and unexpired, no export_job.downloaded audit row for that job by its requester, and the decision (retention_expires_at, which the decision dates to now) less than private.closure_backup_hold() ago. private.sweep_expired_workspaces() skips such a workspace in BOTH loops (in the WHERE, so a held workspace never takes a slot of the run''s limit) and reports it as organisations.held_for_backup. Bounded by construction: never past the hold, never for an owner_closed (undecided) workspace, never for a backup that has expired.';

revoke all on function private.closure_backup_owed(uuid) from public, anon, authenticated, service_role;

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

  -- Q229 (Phase 8 final review A, I2): THE ONE PERMITTED REWRITE OF A
  -- FINISHED JOB. When the superuser deletes a closed workspace,
  -- the decision RPC (delete_closed_workspace) RAISES its succeeded closure backup's
  -- expires_at to at least the decision + private.closure_backup_hold(), so
  -- the closing Owner can still download it while the purge is held for it.
  -- Admitted only (a) for a succeeded closure_backup row, (b) while that RPC
  -- has named THIS job in its transaction-local marker, (c) upwards, and
  -- (d) when nothing else on the row moves. It is checked before the
  -- server-session leg because the decision runs in the superuser's session.
  if old.closure_backup
     and old.status = 'succeeded'
     and pg_catalog.current_setting('app.closure_backup_hold', true) = old.id::text
     and new.expires_at > old.expires_at
     and (pg_catalog.to_jsonb(new) - 'expires_at') = (pg_catalog.to_jsonb(old) - 'expires_at') then
    return new;
  end if;

  if not v_server_session then
    raise exception 'export_jobs: a job''s progress is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_outcome_is_server_only';
  end if;

  -- Q206 (Task 9c job 2): THE ONE PERMITTED REWRITE OF requested_by. A
  -- workspace's CLOSURE BACKUP outlives the Owner who closed it: when
  -- private.erase_account() erases that Owner it re-points the backup's
  -- requester at the Q130 tombstone instead of letting ON DELETE CASCADE take
  -- the row. Admitted only (a) for a closure_backup row, (b) to the tombstone,
  -- (c) while erase_account has named THIS requester in its transaction-local
  -- marker, and (d) when nothing else on the row moves -- finished or not.
  if old.closure_backup
     and new.requested_by = private.erased_user_id()
     and old.requested_by is distinct from new.requested_by
     and pg_catalog.current_setting('app.erasing_account', true) = old.requested_by::text
     and (pg_catalog.to_jsonb(new) - 'requested_by') = (pg_catalog.to_jsonb(old) - 'requested_by') then
    return new;
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

CREATE OR REPLACE FUNCTION private.sweep_expired_workspaces(p_dry boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id      uuid;
  v_n       bigint := 0;
  v_blocked bigint := 0;
  v_bytes   bigint;
  v_held    bigint;
begin
  -- Q229: a closure-deleted workspace whose backup is still owed to its
  -- closing Owner is HELD and counted -- never purged, never a slot.
  select pg_catalog.count(*) into v_held
    from public.organisations o
   where o.deleted_at is not null
     and o.retention_expires_at is not null
     and o.retention_expires_at < pg_catalog.now()
     and private.closure_backup_owed(o.id);

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.organisations o
             where o.deleted_at is not null
               and o.retention_expires_at is not null
               and o.retention_expires_at < pg_catalog.now()
               and not private.closure_backup_owed(o.id)
             order by o.retention_expires_at
             limit p_limit) t;
    return pg_catalog.jsonb_build_object(
      'organisations.purged', v_n, 'organisations.capped', v_n >= p_limit,
      'organisations.held_for_backup', v_held);
  end if;

  for v_id in
    select o.id from public.organisations o
     where o.deleted_at is not null
       and o.retention_expires_at is not null
       and o.retention_expires_at < pg_catalog.now()
       and not private.closure_backup_owed(o.id)
     order by o.retention_expires_at
     limit p_limit
  loop
    -- The primitive refuses while any byte is still in the bucket, and that
    -- refusal would abort the whole run. Asked here first so a workspace
    -- whose objects the runner has not reached yet is COUNTED as blocked and
    -- left for the next run, rather than taking every other sweep down with
    -- it.
    select pg_catalog.count(*) into v_bytes
      from storage.objects s
     where s.bucket_id = 'documents'
       and s.name like v_id::text || '/%';
    if v_bytes > 0 then
      v_blocked := v_blocked + 1;
      continue;
    end if;

    perform private.erase_organisation(v_id, null, true);
    v_n := v_n + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organisations.purged', v_n,
    'organisations.capped', v_n >= p_limit,
    'organisations.waiting_on_bytes', v_blocked,
    'organisations.held_for_backup', v_held);
end;
$function$;

comment on function private.export_jobs_before_update() is
  'BEFORE UPDATE on public.export_jobs, for EVERY writer. Admits the write ONLY from a server session -- auth.uid() null AND the session role setting one of postgres/service_role/none/"" -- and refuses everything else (42501, hint export_outcome_is_server_only, its own hint so a test can tell it from a missing grant). Reissued in 20260928000000 with that leg INVERTED from the closed list of client roles it shipped with in 20260927001000: a client role added by a later phase now arrives refused by omission rather than admitted by it. Refuses a change to the request itself (export_request_is_immutable), a write to a finished job (export_job_is_finished) and a transition that is not queued->running->succeeded/failed (illegal_export_transition). Stamps started_at, completed_at and expires_at (completed_at + private.export_limits().archive_days; a closure backup never less than its workspace''s retention_expires_at) from the database clock. TWO marker-gated exceptions: Q206, erase_account() re-pointing a closure backup''s requested_by at the tombstone; and Q229 (20261029002000), delete_closed_workspace() RAISING a succeeded closure backup''s expires_at, nothing else on the row moving, while app.closure_backup_hold names that job.';

comment on function public.delete_closed_workspace(text, text, boolean) is
  'THE SUPERUSER''S SECOND DECISION ON A CLOSED WORKSPACE (Phase 8 Task 9c job 2; founder 2026-09-30). Platform superuser, at aal2, mandatory reason (<= 500), ONLY while owner_closed, and (since 20261028002000, N3a) only when the latest closure backup SUCCEEDED or p_acknowledge_no_backup is true (else 22023 decision_backup_not_succeeded): moves the workspace to lifecycle_state deleted and makes it due for the EXISTING Q88 purge immediately (lifecycle_changed_at dated one retention period back) -- the next hourly retention run purges its bytes and then calls private.erase_organisation() through sweep_expired_workspaces(). No second deletion engine. SINCE 20261029002000 (Q229, final review A I2, pending founder): that purge is HELD (private.closure_backup_owed()) until the closing Owner downloads the succeeded closure backup or private.closure_backup_hold() (30 days) passes, and the backup''s expires_at is raised to at least now() + the hold so it stays downloadable throughout. Audited as organisation.closure_deleted with the backup job, its status, backup_downloadable_until, whether the delete went ahead without a succeeded backup (acknowledged_no_backup), and the remaining active Owners/Admins the notice goes to. Returns the audit row id. Reversible with reinstate_organisation() until the purge runs, while the workspace still has an active Owner (20261028001000, N2).';

comment on function private.sweep_expired_workspaces(boolean, integer) is
  'Q88/Q92/Q102, the 60-day hard purge -- THE FIRST CALLER private.erase_organisation() has ever had. It decides WHICH workspaces and WHEN and nothing else: there is no second erasure here and there must never be one, because the primitive carries the `replica` refusal, the polymorphic sweep, the merges.field_resolution scrub, the FK-less identifier roll, the derived post-delete assertion and the summary audit row. Reinstatement inside the window needs no special case at all: private.organisation_lifecycle_sync() clears retention_expires_at the moment deleted_at is cleared, so a reinstated workspace has no deadline for this query to find -- the rule is "while it is closed", not "59 days yes, 60 days no". Closing an already-suspended workspace restarts the clock by the same trigger. A workspace whose document bytes the runner has not reached yet is counted as `waiting_on_bytes` and left: the primitive would refuse, and that refusal would abort every other sweep in the run. SINCE 20261029002000 (Q229): a workspace for which private.closure_backup_owed() is true -- deleted by the superuser''s closure decision, its closure backup not yet downloaded by the closing Owner, less than 30 days after the decision -- is excluded from both loops and counted as `held_for_backup`.';

-- ---------------------------------------------------------------------------
-- THE CLOCK ROLL learns the one date column the hold reads.
-- private.closure_backup_owed() is reachable from sweep_expired_workspaces(),
-- so the fixed-point clock derivation (20261005003000) finds
-- export_jobs.requested_at in it and REFUSES the retention job until the
-- column is classified (measured: rls_phase8_retention.sql RK26 named it).
-- Rebuilt from the LATEST pg_get_functiondef, one row added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_clock_columns()
 RETURNS TABLE(schema_name text, table_name text, column_name text, role text, guard text, note text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    ('public', 'audit_events', 'created_at', 'clock', null,
     'audit_total. No client role holds INSERT or UPDATE on the table; rows are written by definer functions and triggers.'),

    ('public', 'documents', 'deleted_at', 'clock',
     'trigger:private.guard_document_retention_columns',
     'operational / financial. THE COLUMN REVIEW FINDING C1 WAS ABOUT. A client holds UPDATE on it because soft-delete and restore are its own writes; the guard overwrites a null -> value transition with now() and refuses a re-date (20261004000000). Not in the INSERT grant.'),
    ('public', 'documents', 'retention_class', 'clock',
     'trigger:private.guard_document_retention_columns',
     'THE PERIOD HALF OF THE SAME CLOCK (fix round 2, I-N1 / Q186): which of operational / financial applies, frozen by the guard when deleted_at is set, cleared on restore, immutable otherwise for every writer. No client grant at all; derived onto this roll as the column the sweep hands to retention_period().'),
    ('public', 'documents', 'bytes_purged_at', 'clock', null,
     'The record that the sweep ran, and the term that takes a document OUT of every future sweep. No client grant at all since 20261004000000; the guard refuses it too if one is ever added.'),
    ('public', 'documents', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s. No client grant since 20261004000000 either.'),

    ('public', 'erasure_jobs', 'completed_at', 'clock', null,
     'erasure_job_failed. No client write path: the table''s outcome columns are server-only (20260930001000).'),
    ('public', 'erasure_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_jobs', 'completed_at', 'clock', null,
     'Written by the reaper, read by nothing as a cutoff; classified `clock` rather than excused because no client can write it and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'requested_at', 'clock', null,
     'Q229 (20261029002000): private.closure_backup_owed() reads it to pick a workspace''s LATEST closure backup, the one whose download releases the held purge -- an ordering, not a cutoff, classified `clock` rather than excused because no client can write it (the request is immutable under export_jobs_before_update(), and authenticated''s INSERT grant is column-level, without it) and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    ('public', 'merge_candidates', 'deleted_at', 'not_a_clock', null,
     'A false candidate the fixed-point walk (m-N1) reaches through private.erase_account(): that function''s `deleted_at` is organisations'', read as a filter on which workspaces are live, never as a cutoff. No client role holds UPDATE on merge_candidates.deleted_at.'),
    ('public', 'notes', 'deleted_at', 'not_a_clock', null,
     'A false candidate reached the same way: erase_account() hard-deletes a private note by ownership, not by age. A client holds UPDATE on notes.deleted_at (soft-delete/restore are its own writes), which is harmless because nothing judges a note on it.'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC, with the hint organisation_lifecycle_is_the_rpcs (m-N2) so the probe can tell it from organisations_update_manage_organisation''s WITH CHECK, which carries `deleted_at is null` and refuses the same write with the same SQLSTATE -- a second layer, not the named one.'),
    ('public', 'organisations', 'retention_expires_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace. RECOMPUTED on every write by the sync trigger from lifecycle_changed_at, and nulled whenever the workspace is live -- so a written value never survives the statement that wrote it.'),
    ('public', 'organisations', 'lifecycle_changed_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace -- THE REAL CLOCK, and one the derivation cannot reach: no retention function names it, the sync trigger computes retention_expires_at from it. Nulled on a live workspace; on a closed one it is writable only by a session the UPDATE policies admit, which is the audited lifecycle RPCs and nobody else.'),
    ('public', 'organisations', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s.'),

    ('public', 'rate_limit_counters', 'window_start', 'clock', null,
     'rate_limit_counter. No client role can write or read a counter (20260909020000).'),

    ('public', 'retention_settings', 'audit_ceiling_released_at', 'clock', null,
     'The start of an audit-purge ceiling release (Q184, founder 2026-09-30, 20261010000000), read by private.audit_ceiling_release_active() -- not a cutoff for any row, but it decides whether rail 3 applies, so it is classified as a clock rather than excused. No client role holds INSERT or UPDATE on retention_settings (RC4); written only by public.release_audit_purge_ceiling(), with now().'),
    ('public', 'retention_settings', 'audit_ceiling_release_expires_at', 'clock', null,
     'The end of that release: released_at + 72 hours, held by the CHECK retention_settings_audit_ceiling_release_shape and re-checked by the reader. Same writer, same absence of any client grant.'),

    ('storage', 'objects', 'created_at', 'clock',
     'no_permissive_policy,policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies; the six named here are the INSERT and UPDATE halves of that fence. THE LAYER THAT ACTUALLY REFUSES TODAY IS DEFAULT DENY -- no permissive policy admits a client role at all (m-N2) -- so `no_permissive_policy` is named first: adding one is a forgeable_retention_clock refusal, and the restrictive six are the layer behind it. The probe measures their composite.')
$function$;
