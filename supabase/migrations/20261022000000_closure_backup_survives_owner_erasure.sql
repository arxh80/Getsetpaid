-- PHASE 8 TASK 9c, JOB 2 -- Q206: THE CLOSURE BACKUP SURVIVES THE CLOSING
-- OWNER ERASING THEIR ACCOUNT (founder 2026-09-30, Q176/Q178 changed).
--
-- export_jobs.requested_by is ON DELETE CASCADE, and a closed workspace no
-- longer blocks its last Owner's erasure. So "close, then delete my account"
-- deleted the closure backup's row -- and the erasure runner's purge manifest
-- named the backup's archive for deletion first -- before the founder had
-- decided anything. Three functions, each rebuilt from its LATEST
-- pg_get_functiondef (standing lesson 4) at 225 migrations:
--
--   private.erase_account()          re-points a closure_backup job's
--                                    requested_by at the Q130 tombstone (step
--                                    5b, the Q158 pattern), and its bytes check
--                                    no longer counts the backup's archive
--   public.erasure_purge_manifest()  no longer names a closure backup's archive
--   private.export_jobs_before_update()  admits exactly that one rewrite
--                                    (closure_backup row, to the tombstone,
--                                    under erase_account's marker, nothing
--                                    else moving); every other change to
--                                    requested_by is still export_request_is_immutable
--
-- The tombstone is excluded from every notice resolver by name, so nobody is
-- emailed about the re-pointed row.

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

CREATE OR REPLACE FUNCTION public.erasure_purge_manifest(p_job_id uuid)
 RETURNS TABLE(bucket text, object_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_job public.erasure_jobs%rowtype;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'erasure_purge_manifest: the purge manifest is read by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_runner_is_server_only';
  end if;

  select * into v_job from public.erasure_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'erasure_purge_manifest: no such job' using errcode = '22023', hint = 'unknown_job';
  end if;

  if v_job.kind = 'account' then
    return query
      select 'feedback-screenshots'::text, 'feedback/' || f.id::text
        from public.feedback f
       where f.user_id = v_job.subject_user_id
         and f.screenshot_key is not null
      union all
      select 'exports'::text, e.storage_key
        from public.export_jobs e
       where e.requested_by = v_job.subject_user_id
         and e.storage_key is not null
         -- Q206: a closure backup is the WORKSPACE's archive, not the
         -- requester's; it is re-pointed at the tombstone, never purged here.
         and not e.closure_backup;
  else
    return query
      select 'documents'::text, d.storage_key
        from public.documents d
       where d.organisation_id = v_job.organisation_id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.erase_account(p_user_id uuid, p_job_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tomb    uuid := private.erased_user_id();
  v_counts  jsonb := '{}'::jsonb;
  v_n       bigint;
  v_total   bigint := 0;
  v_rec     record;
  v_org     record;
  v_multi   text;
  v_orgs    uuid[];
  v_left    text;
begin
  -- (0) ---------------------------------------------------------------------
  if p_user_id is null then
    raise exception 'erase_account: a subject is required' using errcode = '22023';
  end if;
  if p_user_id = v_tomb then
    raise exception 'erase_account: the tombstone is not a person and cannot be erased'
      using errcode = '42501', hint = 'tombstone_is_nobody';
  end if;
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'erase_account: refuses to run with session_replication_role = %, because the cascades and the ON DELETE SET NULLs it depends on would not fire',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;
  -- (0b) THE ROLL AND THE CATALOGUE MUST AGREE (fix round 1, C1). A uuid
  -- column no foreign key protects is invisible to steps 7, 8 and 10, so an
  -- unclassified one is a promise this function cannot keep. It refuses here,
  -- before a single row moves, rather than reporting a success that left a
  -- stable identifier behind.
  perform private.assert_fkless_identifier_roll();

  -- (1) IDEMPOTENCE ---------------------------------------------------------
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) Q131, UNDER A LOCK (C2) ---------------------------------------------
  -- The lock comes FIRST and covers every live workspace this person is an
  -- active member of. Without it two erasures of two co-Owners both read a
  -- workspace that still had an Owner in it and both deleted one.
  perform private.account_lock_workspaces(p_user_id);
  perform private.assert_account_is_erasable(p_user_id);

  -- The workspaces to re-assert at 9b, captured while the guard's answer is
  -- still true and before any of them can be purged by 8b.
  select pg_catalog.array_agg(distinct m.organisation_id)
    into v_orgs
    from public.organisation_memberships m
    join public.organisations o on o.id = m.organisation_id
   where m.user_id = p_user_id and m.status = 'active' and o.deleted_at is null;

  -- (3) THE BYTES -----------------------------------------------------------
  select count(*) into v_n
    from storage.objects o
   where (o.bucket_id = 'feedback-screenshots'
          and o.name in (select 'feedback/' || f.id::text
                           from public.feedback f where f.user_id = p_user_id))
      or (o.bucket_id = 'exports'
          and o.name in (select j.storage_key from public.export_jobs j
                          where j.requested_by = p_user_id and j.storage_key is not null
                            and not j.closure_backup));
  if v_n > 0 then
    raise exception 'erase_account: % stored object(s) belonging to this account are still in their buckets', v_n
      using errcode = '55000', hint = 'bytes_not_purged';
  end if;
  v_counts := v_counts || pg_catalog.jsonb_build_object('bytes_purged', true);

  -- (4) PRIVATE NOTES ARE HARD-DELETED --------------------------------------
  delete from public.notes n
   where n.owner_user_id = p_user_id and n.visibility = 'private';
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('notes.private_deleted', v_n);

  select count(*) into v_n from public.notes n
   where n.owner_user_id = p_user_id and n.visibility = 'company';
  v_counts := v_counts || pg_catalog.jsonb_build_object('notes.company_kept', v_n);

  -- (5) THE REGISTER AND ITS NOTES (Q158) -----------------------------------
  update public.data_subject_requests d
     set user_id          = v_tomb,
         user_email       = '[erased]',
         detail           = '[erased]',
         rejection_reason = case when d.rejection_reason is not null then '[erased]' end
   where d.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('data_subject_requests', v_n);

  -- (5b) Q206: A CLOSURE BACKUP SURVIVES ITS REQUESTER. The backup
  -- public.close_my_workspace() queued belongs to the closed WORKSPACE (the
  -- superuser's decision item reads it); its requested_by is re-pointed at
  -- the tombstone rather than cascaded away with auth.users. The marker is
  -- what private.export_jobs_before_update() admits this one rewrite on.
  perform pg_catalog.set_config('app.erasing_account', p_user_id::text, true);
  update public.export_jobs j
     set requested_by = v_tomb
   where j.requested_by = p_user_id and j.closure_backup;
  get diagnostics v_n = row_count;
  perform pg_catalog.set_config('app.erasing_account', '', true);
  v_counts := v_counts || pg_catalog.jsonb_build_object('export_jobs.closure_backups_kept', v_n);

  update public.data_subject_request_notes t
     set author_user_id = v_tomb
   where t.author_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('data_subject_request_notes', v_n);

  -- (6) THE IDENTIFIERS NO FOREIGN KEY PROTECTS -----------------------------
  -- 6a. THE OWNER-ID SNAPSHOTS, RUN FROM THE ROLL RATHER THAN LISTED. Plain
  --     uuid columns with no foreign key, so step 9's delete would leave them
  --     naming a person who no longer exists -- a stable identifier surviving
  --     erasure, which is the one thing pseudonymisation must not produce.
  --     This loop is the C1 fix: the version that listed them named
  --     public.merges and NOT public.merge_candidates, whose two columns
  --     public.screen_for_duplicates() writes on every flagged duplicate, and
  --     no derived assertion in this function could see the omission.
  for v_rec in
    select r.table_name as tbl, r.column_name as col
      from private.fkless_identifier_columns() r
     where r.identifies = 'user' and r.treatment = 'null_on_match'
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = null where %I = $1',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using p_user_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
  end loop;

  -- 6b. THE AUDIT LOG AS A TARGET. `actor_user_id` is handled by the derived
  --     re-point below (it is a foreign key). `target_id` is not a foreign
  --     key at all -- it is polymorphic -- so a row whose TARGET was this
  --     person keeps their id unless it is moved here, and its before/after
  --     payload describes them and is dropped. What happened stays; who it
  --     happened to stops being nameable.
  update public.audit_events a
     set target_id = v_tomb,
         before    = null,
         after     = null
   where a.target_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.targeted', v_n);

  -- 6e. AND THE PAYLOADS OF THE ROWS THIS PERSON WAS THE ACTOR ON (M1).
  --     actor_user_id itself is a foreign key and the derived walk at step 7
  --     re-points it; the payload beside it is not a foreign key, is not a
  --     uuid column, and was left untouched. The page promises that "any
  --     description of the change is dropped" for every entry of theirs, so
  --     it is dropped here -- what happened, when, to what and on which
  --     correlation thread all stay.
  update public.audit_events a
     set before = null,
         after  = null
   where a.actor_user_id = p_user_id
     and (a.before is not null or a.after is not null);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.acted_payloads', v_n);

  -- 6c. INCIDENT ALERT DETAILS. A jsonb blob with no foreign key that carries
  --     subject ids (a rate-limit crossing names the subject it metered). The
  --     whole document is rewritten with the id replaced, which is complete
  --     regardless of where in the shape it sits -- a key-by-key walk would
  --     miss a nested one.
  update public.incident_alerts i
     set details = pg_catalog.replace(i.details::text, p_user_id::text, v_tomb::text)::jsonb
   where i.details::text like '%' || p_user_id::text || '%';
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('incident_alerts.details', v_n);

  -- 6f. THE PAYLOAD VALUES THAT NAME THIS PERSON ON SOMEBODY ELSE'S ROW
  --     (Phase 8 Task 7 fix round 1, C1). 6b clears the rows that TARGET the
  --     person and 6e the rows they ACTED on. Since 20261006000000 a third
  --     shape exists on every workspace: an Admin's `membership.created`
  --     carries the invitee's user_id, a Manager's `task.updated` carries the
  --     colleague the task was reassigned to, a screen's `merge_candidate.*`
  --     carries two owners -- rows whose actor and target are both somebody
  --     or something else. Neither 6b nor 6e can see them.
  --     THE VALUE IS REPLACED, NOT THE PAYLOAD DROPPED: the row is the
  --     workspace's record of what its Admin did, and "an Admin invited the
  --     erased user" is still true and still worth keeping; who the invitee
  --     was is what stops being nameable -- the same tombstone step 7 points
  --     every foreign key at. Whole-document text replace, the 6c shape,
  --     because it is complete regardless of which key, which depth or which
  --     writer put the id there, including writers that do not exist yet.
  --     Case-insensitive, because a payload built by application code is not
  --     guaranteed to have gone through the uuid type's lower-case output.
  update public.audit_events a
     set before = case when a.before is null then null else
                    pg_catalog.regexp_replace(a.before::text, p_user_id::text, v_tomb::text, 'gi')::jsonb end,
         after  = case when a.after is null then null else
                    pg_catalog.regexp_replace(a.after::text, p_user_id::text, v_tomb::text, 'gi')::jsonb end
   where pg_catalog.strpos(pg_catalog.lower(coalesce(a.before::text, '')), p_user_id::text) > 0
      or pg_catalog.strpos(pg_catalog.lower(coalesce(a.after::text, '')), p_user_id::text) > 0;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.payload_values', v_n);

  -- 6d. RATE LIMIT COUNTERS. Enforcement state about a person who will not be
  --     making any more requests. Deleted rather than re-pointed: rolling an
  --     erased account's spent budget onto the tombstone would throttle the
  --     next one (Q110 leaves the general sweep to Task 6; this is the
  --     subject-scoped part of it).
  --     Run from the roll too, with the roll carrying the scope predicate --
  --     `subject_id` is polymorphic and a workspace's counters are not this
  --     person's to delete.
  for v_rec in
    select r.table_name as tbl, r.column_name as col, r.predicate as pred
      from private.fkless_identifier_columns() r
     where r.identifies = 'user' and r.treatment = 'delete_row'
     order by 1, 2
  loop
    execute pg_catalog.format('delete from %s where %I = $1 and (%s)',
                              v_rec.tbl, v_rec.col,
                              coalesce(v_rec.pred, 'true'))
      using p_user_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', ''), v_n);
  end loop;

  -- (7) THE RE-POINT, DERIVED ------------------------------------------------
  -- ASSERT WHAT THE DERIVATION WOULD DROP, first: a COMPOSITE foreign key to
  -- auth.users cannot be re-pointed by the single-column walk below, and would
  -- be skipped silently. There is none today; there must not be one tomorrow
  -- without somebody noticing.
  select pg_catalog.string_agg(con.conname, ', ') into v_multi
    from pg_catalog.pg_constraint con
   where con.contype = 'f'
     and con.confrelid = 'auth.users'::pg_catalog.regclass
     and pg_catalog.array_length(con.conkey, 1) > 1;
  if v_multi is not null then
    raise exception 'erase_account: composite foreign key(s) to auth.users (%) are not handled by the re-point walk', v_multi
      using errcode = '55000', hint = 'composite_fk_to_auth_users';
  end if;

  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and con.confdeltype = 'a'          -- NO ACTION: the ones that BLOCK
       and c.relkind in ('r', 'p')
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = $1 where %I = $2',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using v_tomb, p_user_id;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    if v_n > 0 then
      v_counts := v_counts || pg_catalog.jsonb_build_object(
        pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
    end if;
  end loop;
  v_counts := v_counts || pg_catalog.jsonb_build_object('tombstoned_references', v_total);

  -- (8) ASSERT IT WORKED -----------------------------------------------------
  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and con.confdeltype = 'a'
       and c.relkind in ('r', 'p')
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1', v_rec.tbl, v_rec.col)
      into v_n using p_user_id;
    if v_n > 0 then
      raise exception 'erase_account: %.% still names the account after the re-point (% row(s)) -- a guard refused it',
        v_rec.tbl, v_rec.col, v_n
        using errcode = '55000', hint = 'reference_survived_the_repoint';
    end if;
  end loop;

  -- (8b) Q131'S NARROW CASE --------------------------------------------------
  for v_org in
    select w.organisation_id from private.account_last_owner_workspaces(p_user_id) w
     where w.other_members = 0 and w.is_empty
  loop
    perform private.erase_organisation(v_org.organisation_id, p_job_id, false);
    v_counts := v_counts || pg_catalog.jsonb_build_object('workspace_purged', true);
  end loop;

  -- (9) THE DELETE -----------------------------------------------------------
  delete from auth.users u where u.id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('auth_users', v_n);

  -- (9b) AND THE Q131 INVARIANT ITSELF, AFTER THE DELETE (C2) ----------------
  -- The lock at step 2 is what stops the race; this is what proves it held.
  -- Every live workspace this person was an active member of must still have
  -- an active Owner -- unless 8b took the whole workspace with them, in which
  -- case there is nothing left to strand.
  select pg_catalog.string_agg(o.name, ', ' order by o.name)
    into v_left
    from public.organisations o
   where o.id = any (coalesce(v_orgs, '{}'::uuid[]))
     and o.deleted_at is null
     and not exists (
       select 1 from public.organisation_memberships m
        where m.organisation_id = o.id
          and m.role = 'owner'
          and m.status = 'active');
  if v_left is not null then
    raise exception 'erase_account: % would be left with no owner -- another erasure of a co-owner committed while this one was running', v_left
      using errcode = '55000', hint = 'workspace_left_ownerless';
  end if;

  -- (10) ASSERT AGAIN, OVER EVERY FOREIGN KEY --------------------------------
  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and c.relkind in ('r', 'p')
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1', v_rec.tbl, v_rec.col)
      into v_n using p_user_id;
    if v_n > 0 then
      raise exception 'erase_account: %.% still names the account after the delete (% row(s))',
        v_rec.tbl, v_rec.col, v_n
        using errcode = '55000', hint = 'reference_survived_the_delete';
    end if;
  end loop;

  -- (10b) AND OVER EVERY AUDIT PAYLOAD (C1) -------------------------------
  -- The foreign-key walks above cannot see inside jsonb. This can: after the
  -- delete, so that anything a cascade wrote is inside the measurement too,
  -- not one audit row's before/after may still contain the account's id.
  -- Refusing rolls the whole erasure back, which is the fail-closed direction
  -- -- a success that left the id in a payload is the thing C1 was.
  select count(*) into v_n
    from public.audit_events a
   where pg_catalog.strpos(pg_catalog.lower(coalesce(a.before::text, '')), p_user_id::text) > 0
      or pg_catalog.strpos(pg_catalog.lower(coalesce(a.after::text, '')), p_user_id::text) > 0;
  if v_n > 0 then
    raise exception 'erase_account: % audit payload(s) still contain the account''s id after the scrub', v_n
      using errcode = '55000', hint = 'identifier_survived_in_audit_payload';
  end if;

  -- (11) ONE SUMMARY ROW -----------------------------------------------------
  -- Counts, never content, and the ACTOR IS THE TOMBSTONE because the person
  -- who asked no longer exists. It is written last so that its own
  -- actor_user_id is already a pseudonym rather than something step 7 would
  -- have had to rewrite.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    null, v_tomb, 'account.erased', 'erasure_job',
    p_job_id,
    coalesce(p_job_id, pg_catalog.gen_random_uuid()),
    v_counts);

  return v_counts;
end;
$function$;
