-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1 -- A CLOSURE BACKUP IS COMPLETE (review C1, I2).
--
-- MEASURED FIRST (supabase/tests/rls_phase8_closure_backup.sql, at 229
-- migrations, before this file): a workspace seeded with rows in all 35
-- tables a workspace export carries, exported by its aal2 Owner while live,
-- then closed through close_my_workspace() and its closure backup read
-- through the same engine, page by page:
--   * close, then build:             financial_entries 3 -> 0,
--     network_links 1 -> 0, network_connection_requests 1 -> 0,
--     impersonation_sessions 1 -> 0; the other 31 tables equal.
--   * close, erase the Owner, build: all 35 tables -> 0 (41 rows -> 0).
-- Those four tables' SELECT policies key on view_finance, view_network and
-- manage_organisation, none of which survives suspension, and deleted_at is
-- set in the very transaction that queues the backup. After an erasure the
-- job's requester is the tombstone, which is a member of nothing.
--
-- THE NARROWEST CHANGE THAT FIXES BOTH:
--   1. private.closure_backup_reads + private.closure_backup_read_admits():
--      a marker ROW (not a GUC -- any session can set a GUC) keyed on the
--      current transaction id, in a table no client role can write.
--   2. private.permitted_organisations() and public.has_permission() -- the
--      mirrored pair rls_phase2_crm.sql § M binds together -- admit the marked
--      organisation as live. private.full_scope_organisations() has no
--      lifecycle term and is unchanged. Outside a marked read both give the
--      old answer, which § M re-proves on every run.
--   3. public.export_read_page() writes the marker around the requester read
--      for a closure_backup job only, deletes it on both paths, and refuses a
--      closure backup whose requester is the tombstone (the belt).
--   4. private.erase_account() refuses while the account has a queued or
--      running closure backup (hint closure_backup_not_built).
-- The backup is still built under the closing Owner's own role, record scope
-- and aal: it carries what a workspace export taken the moment before the
-- closure would have, and no more (a colleague's private note is not in it).
--
-- Every function is rebuilt from its LATEST pg_get_functiondef at 229
-- migrations (standing lesson 4) with only the marked hunks added; CREATE OR
-- REPLACE keeps each one's grants and comment.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create table private.closure_backup_reads (
  xact            xid8 primary key,
  -- Real foreign keys, so neither column is a FK-less identifier the erasure
  -- roll (private.fkless_identifier_columns()) would have to classify -- it
  -- refused every erasure the moment this table first existed without them.
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  export_job_id   uuid not null references public.export_jobs (id) on delete cascade
);
create index closure_backup_reads_organisation_id_idx on private.closure_backup_reads (organisation_id);
create index closure_backup_reads_export_job_id_idx on private.closure_backup_reads (export_job_id);
alter table private.closure_backup_reads enable row level security;
revoke all on private.closure_backup_reads from public, anon, authenticated, service_role;
comment on table private.closure_backup_reads is
  'Task 9c fix round 1 (C1): one row per transaction in which public.export_read_page() is reading a closure_backup job under its requester''s rights. Written and deleted only by that SECURITY DEFINER function; no client or server role holds any privilege on it. Read by private.closure_backup_read_admits(). Empty at rest.';

create function private.closure_backup_read_admits(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.closure_backup_reads r
     where r.xact = pg_catalog.pg_current_xact_id_if_assigned()
       and r.organisation_id = p_organisation_id
  );
$$;
comment on function private.closure_backup_read_admits(uuid) is
  'TRUE only inside public.export_read_page()''s read of a closure_backup job, in the same transaction, for that job''s organisation (Task 9c fix round 1, C1). Lets permitted_organisations()/has_permission() see a closed workspace as live for that one read. A client cannot make it true: the marker is a row in a table no client role can write, keyed on the transaction id.';
revoke all on function private.closure_backup_read_admits(uuid) from public, anon;
-- has_permission() is SECURITY INVOKER, so its caller needs EXECUTE. The
-- answer is about the caller's own transaction and is false for every client.
grant execute on function private.closure_backup_read_admits(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION private.permitted_organisations(p_permission text)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.organisation_id
  from public.organisation_memberships m
  join public.role_permissions rp
    on rp.role_key = m.role
  -- Q6, mirrored from public.has_permission.
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = m.organisation_id
   and (o.deleted_at is null or perm.survives_suspension
        -- 20261025000000 (Task 9c fix round 1, C1): a closure backup's read
        -- sees the workspace as it was before the closure. TRUE only inside
        -- public.export_read_page()'s requester read of a closure_backup job,
        -- in that transaction, for that organisation -- see that function.
        or private.closure_backup_read_admits(o.id))
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    )
  -- PHASE 7 TASK 2, mirrored from has_permission's second disjunct. UNION, not
  -- UNION ALL: a caller cannot be both a member and an impersonator of the
  -- same organisation today (the superuser is not a member of the tenants they
  -- support), but a duplicate id here would be a duplicate row in every
  -- `organisation_id in (select ...)` InitPlan, and dedup is free at this
  -- cardinality.
  union
  select g from private.impersonated_organisations(p_permission) g;
$function$;

CREATE OR REPLACE FUNCTION public.has_permission(p_org_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.organisation_memberships m
    join public.role_permissions rp
      on rp.role_key = m.role
    -- Q6: the catalogue decides whether this key survives suspension.
    join public.permissions perm
      on perm.key = rp.permission_key
    join public.organisations o
      on o.id = m.organisation_id
     and (o.deleted_at is null or perm.survives_suspension
          -- 20261025000000: the mirror of permitted_organisations()'s term.
          or private.closure_backup_read_admits(o.id))
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_org_id
      and m.status = 'active'
      and rp.permission_key = p_permission
      and (
        not private.role_requires_mfa(m.role)
        or private.session_is_aal2()
      )
  )
  -- PHASE 7 TASK 2: the impersonation disjunct. Written as a second EXISTS
  -- rather than `p_org_id in (select ...)` deliberately: `null in (<non-empty
  -- set>)` evaluates to NULL, which would turn has_permission(NULL, ...) from
  -- the documented, fail-closed FALSE into a NULL -- and design note (b) of
  -- 20260826154304 is explicit that a NULL organisation id must never become
  -- anything but a refusal. EXISTS is always boolean.
  or exists (
    select 1
    from private.impersonated_organisations(p_permission) g
    where g = p_org_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.export_read_page(p_job_id uuid, p_table text, p_after text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job     public.export_jobs%rowtype;
  v_cat     record;
  v_subject uuid;
  v_prev    text;
  v_prev_sub  text;
  v_prev_role text;
  v_sql     text;
  v_limit   integer;
  v_max     integer;
  v_rows    jsonb;
begin
  -- (0) SERVER SESSIONS ONLY. This function reads a person's data under that
  -- person's identity; a client session reaching it would be reading as
  -- somebody else by definition. Its own hint, so a test can tell this
  -- refusal from a missing EXECUTE grant's 42501 -- Phase 7 shipped a false
  -- green of exactly that shape.
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'export_read_page: export reads run in the export job, never from a person''s session'
      using errcode = '42501', hint = 'export_reads_are_server_only';
  end if;

  select * into v_job from public.export_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'export_read_page: no such job' using errcode = '22023', hint = 'unknown_export_job';
  end if;
  if v_job.status <> 'running' then
    raise exception 'export_read_page: job % is %, not running', v_job.id, v_job.status
      using errcode = '22023', hint = 'export_job_not_running';
  end if;

  select c.* into v_cat
    from private.export_catalogue() c
   where c.export_kind = v_job.kind and c.table_name = p_table;
  if not found or v_cat.disposition <> 'exported' then
    raise exception 'export_read_page: % is not part of a % export', p_table, v_job.kind
      using errcode = '22023', hint = 'not_an_exported_table';
  end if;

  -- 20261025000000 (Task 9c fix round 1, I2 belt): a closure backup is the
  -- closed workspace as its closing Owner saw it. Read as the TOMBSTONE it
  -- would be built -- successfully -- with every file empty. erase_account()
  -- now waits for a queued or running closure backup, so this is reachable
  -- only if that wait is ever bypassed; it refuses loudly rather than ship an
  -- empty backup with confidence.
  if v_job.closure_backup and v_job.requested_by = private.erased_user_id() then
    raise exception 'export_read_page: closure backup % has no requester left to read as', v_job.id
      using errcode = '55000', hint = 'closure_backup_requester_erased';
  end if;

  -- The subject is the JOB'S, never the caller's: the person for an account
  -- export, the workspace for a workspace one.
  v_subject := case when v_job.kind = 'account' then v_job.requested_by else v_job.organisation_id end;

  select l.page_size into v_max from private.export_limits() l;
  v_limit := least(greatest(coalesce(p_limit, v_max), 1), v_max);

  v_sql := private.export_page_sql(p_table, v_cat.projection, v_cat.scope_columns, v_cat.key_column);

  if v_cat.authorisation = 'elevated' then
    -- Belt and braces: the catalogue already refuses this shape
    -- (private.export_catalogue_is_sound()), and so does this.
    if v_job.kind = 'workspace' then
      raise exception 'export_read_page: a workspace export has no elevated reads'
        using errcode = '42501', hint = 'workspace_export_is_requester_rls';
    end if;
    execute v_sql into v_rows using v_subject, coalesce(p_after, ''), v_limit;
    return v_rows;
  end if;

  -- REQUESTER_RLS. Install the requester's claims -- from the JOB ROW, so
  -- neither the subject nor the assurance level is the caller's to choose --
  -- read through the export_reader-owned function, and put the previous
  -- claims back.
  -- ALL THREE ARE SAVED, AND ALL THREE ARE PUT BACK (20260928002000,
  -- review finding M7). The first cut saved and restored
  -- `request.jwt.claims` and BLANKED the two GoTrue-legacy per-claim GUCs
  -- without ever restoring them -- so the two that were not restored were
  -- exactly the two nothing measured. Nothing in this schema reads them
  -- (auth.uid() reads request.jwt.claims) and the caller is a sessionless
  -- runner, so there was no live consequence; they are blanked because a
  -- stale per-claim GUC left on a transaction is the shape of a bug that
  -- costs an afternoon, and they are restored for the same reason.
  v_prev      := pg_catalog.current_setting('request.jwt.claims', true);
  v_prev_sub  := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_prev_role := pg_catalog.current_setting('request.jwt.claim.role', true);
  perform pg_catalog.set_config('request.jwt.claim.sub',  '', true);
  perform pg_catalog.set_config('request.jwt.claim.role', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub',  v_job.requested_by::text,
      'role', 'authenticated',
      'aal',  v_job.requested_aal)::text,
    true);

  -- 20261025000000 (Task 9c fix round 1, C1): A CLOSURE BACKUP READS THE
  -- WORKSPACE AS IT WAS. close_my_workspace() sets deleted_at in the same
  -- transaction that queues the backup, so by the time this runs every SELECT
  -- policy keyed on a permission that does not survive suspension
  -- (view_finance, view_network, manage_organisation) is dark for the Owner,
  -- and the "full workspace backup" was measured carrying 0 finance lines.
  -- For a closure_backup job ONLY, a marker row naming THIS transaction and
  -- THIS organisation makes permitted_organisations()/has_permission() treat
  -- the workspace as live for the duration of this one read. The requester's
  -- own role, record scope and aal still decide, so the backup carries exactly
  -- what a workspace export taken the moment before the closure would have (a
  -- colleague's private note is still not in it). The marker is a row in a
  -- private table no client role can write, keyed on the transaction id, and
  -- deleted again on both paths. It is not a GUC: any session can set a GUC.
  if v_job.closure_backup then
    insert into private.closure_backup_reads (xact, organisation_id, export_job_id)
    values (pg_catalog.pg_current_xact_id(), v_job.organisation_id, v_job.id)
    on conflict (xact) do update set organisation_id = excluded.organisation_id,
                                     export_job_id   = excluded.export_job_id;
  end if;

  begin
    v_rows := private.export_read_page_as_requester(
      v_sql, v_subject, coalesce(p_after, ''), v_limit);
  exception when others then
    delete from private.closure_backup_reads r where r.xact = pg_catalog.pg_current_xact_id();
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
    raise;
  end;

  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
  delete from private.closure_backup_reads r where r.xact = pg_catalog.pg_current_xact_id();
  return v_rows;
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

  -- (2b) 20261025000000 (Task 9c fix round 1, I2): A CLOSURE BACKUP IS BUILT
  -- AS ITS CLOSING OWNER, SO THE OWNER WAITS FOR IT. The export runner reads a
  -- closure backup under the requester's own rights; erased first, step 5b
  -- re-points it at the tombstone, which is a member of nothing, and the
  -- backup was measured built with all 35 of its files empty. Refused, not
  -- deferred: the whole erasure rolls back and the person asks again.
  if exists (select 1 from public.export_jobs j
              where j.requested_by = p_user_id and j.closure_backup
                and j.status in ('queued', 'running')) then
    raise exception 'erase_account: the backup of a workspace this account closed has not been built yet'
      using errcode = '55000', hint = 'closure_backup_not_built';
  end if;

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
  -- the Owner's closure RPC queued belongs to the closed WORKSPACE (the
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
