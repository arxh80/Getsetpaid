-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 2 -- RE-REVIEW FINDING I-N1; Q186 AT ITS
-- RECOMMENDED DEFAULT.
--
-- THE PERIOD HALF OF THE DOCUMENT CLOCK WAS STILL TENANT-WRITABLE.
--
-- Fix round 1 (20261004000000) pinned the TIMESTAMP half of the clock:
-- public.documents.deleted_at is the database's. But a document is judged on
-- two things -- WHEN its clock started and WHICH PERIOD applies, 7 years
-- (`financial`) or 2 (`operational`) -- and the period was computed AT SWEEP
-- TIME by private.document_retention_class(), from whether the document's
-- event carries a financial entry:
--
--     exists (select 1 from public.document_links l
--               join public.financial_entries f on f.event_id = l.entity_id ...
--
-- public.financial_entries.event_id is client-writable, table-wide, with no
-- guard, and lib/crm/finance.ts sends it on every edit from a HIDDEN FORM
-- FIELD. Reproduced by the re-review as an aal2 Owner of their own Pro
-- workspace: a document on a money event, deleted three years ago, read
-- `financial / 0` (not sweepable); one
--
--     update public.financial_entries set event_id = <another event> ...
--
-- and it read `operational / 1` -- sweepable that hour. Bounded (never below
-- two years from a database-written stamp, one tenant's own file, a finance
-- write needed) but it was THE ONLY LEVER A TENANT HAD LEFT for the permanent
-- destruction of a file, and /legal/data-retention v6 promises there is none.
--
-- WHY THE CLOCK DERIVATION COULD NOT SEE IT -- two limits fix round 1 did
-- not state, stated now in private.retention_clock_candidates()'s comment
-- and in SECURITY.md § 8:
--   1. it followed ONE HOP -- the manifest and what retention_sweep_body()
--      calls directly; document_retention_class() is at depth two;
--   2. it asked about DATE/TIMESTAMP columns only -- a uuid that decides
--      which period applies is not a candidate by type.
-- (Fix round 2's m-N1 migration widens the walk; this one closes the hole.)
--
-- THE FIX: FREEZE THE CLASS WHEN THE CLOCK STARTS, IN BOTH DIRECTIONS (Q186).
--
--   * public.documents.retention_class -- `financial` or `operational`, NULL
--     on a live document (a CHECK holds `(deleted_at is null) =
--     (retention_class is null)` for every writer).
--   * private.guard_document_retention_columns(), rebuilt from its latest
--     definition (20261004000000), stamps it from document_retention_class()
--     on the null -> value deleted_at transition -- FOR EVERY WRITER, because
--     the class is derived and never supplied -- clears it on restore, and
--     refuses any other change to it, `postgres` included (the storage_key
--     rule: nothing in the product rewrites a frozen class, and a bug in a
--     migration should not be able to either). A session writer supplying one
--     on INSERT is refused as `document_is_born_live`, the existing hint.
--   * The column is outside every client grant: 20261004000000 made the
--     grants column-level, so a NEW column is unwritable by omission.
--     rls_phase8_retention.sql § RK-N1 asks the trigger directly with the
--     grant switched back on, the RK18 shape.
--   * private.sweep_document_bytes() and public.retention_object_manifest(),
--     rebuilt from their latest definitions (20261003002000, 20261004002000),
--     read d.retention_class and NEVER recompute it. The live derivation
--     document_retention_class() stays, for the stamp and for anyone asking
--     what a document WOULD be classed as today; it is no longer a cutoff.
--   * private.retention_clock_candidates() gains a second arm: THE COLUMN A
--     SWEEP HANDS TO private.retention_period() is a candidate whatever its
--     type, so the frozen class is DERIVED onto the roll rather than named by
--     hand -- and a sweep that goes back to `retention_period(
--     document_retention_class(d.id))` names no column and leaves the roll
--     entry unread, which § RK-N1w asserts.
--   * private.retention_clock_columns() classifies it: a clock, guarded by
--     the same trigger, no client grant.
--
-- WHAT THIS CHANGES FOR A WORKSPACE, stated because a page promises it: a
-- document is judged on the class it had at the moment it was deleted. Money
-- moved off the event afterwards does not shorten the period; money arriving
-- afterwards does not lengthen it. The honest way to change a deleted
-- document's period is to restore it and delete it again, which re-freezes
-- what is true then -- and both of those are the person's own audited
-- writes. Whether /legal/data-retention should say "judged when it was
-- deleted" in so many words is Q187 (the sentence it carries is not false in
-- the direction that matters, and a version is not published to change
-- nothing).
--
-- EXISTING DELETED DOCUMENTS are backfilled from the live derivation as this
-- migration runs -- before the CHECK, and before the guard learns to refuse a
-- class written outside the transition.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE COLUMN, AND THE BACKFILL (before the guard that will refuse it).
-- ---------------------------------------------------------------------------

alter table public.documents
  add column retention_class text
  constraint documents_retention_class_vocabulary
  check (retention_class in ('financial', 'operational'));

comment on column public.documents.retention_class is
  'THE PERIOD HALF OF THE DOCUMENT RETENTION CLOCK, FROZEN AT SOFT-DELETE (Phase 8 Task 6 fix round 2, re-review finding I-N1; Q186). `financial` (7 years) or `operational` (2), stamped by private.guard_document_retention_columns() from private.document_retention_class() at the moment deleted_at goes from null to a value, cleared on restore, NULL on every live document, and otherwise immutable for every writer. The sweep and the manifest read THIS and never recompute it: before it existed, moving a financial entry off the document''s event -- a tenant write from a hidden form field -- took a seven-year document to the two-year period at sweep time. Outside every client grant.';

update public.documents
   set retention_class = private.document_retention_class(id)
 where deleted_at is not null
   and retention_class is null;

alter table public.documents
  add constraint documents_retention_class_iff_deleted
  check ((deleted_at is null) = (retention_class is null));

comment on constraint documents_retention_class_iff_deleted on public.documents is
  'A deleted document always carries its frozen retention class and a live one never does, for every writer (Phase 8 Task 6 fix round 2, I-N1). It is what makes a soft-delete that failed to freeze a class -- a neutered guard -- a refused write rather than a document judged on a class computed later.';


-- ---------------------------------------------------------------------------
-- 2. THE GUARD, REBUILT FROM ITS LATEST DEFINITION (20261004000000).
--    Two things added -- the freeze on the deleted_at transitions (for every
--    writer) and the refusal of any other write to retention_class (for every
--    writer) -- and the rest byte-for-byte.
-- ---------------------------------------------------------------------------

create or replace function private.guard_document_retention_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- FOR EVERY WRITER. Nothing in the product rewrites a storage key, and the
  -- key is what the retention runner is handed to delete.
  if tg_op = 'UPDATE' and new.storage_key is distinct from old.storage_key then
    raise exception 'documents.storage_key is immutable after insert'
      using errcode = '42501', hint = 'document_storage_key_is_immutable';
  end if;

  -- FOR EVERY WRITER: the frozen class is written by the two deleted_at
  -- transitions below and by nothing else (fix round 2, I-N1).
  if tg_op = 'UPDATE'
     and new.retention_class is distinct from old.retention_class
     and new.deleted_at is not distinct from old.deleted_at then
    raise exception 'documents.retention_class is frozen at deletion; restore the document and delete it again'
      using errcode = '42501', hint = 'document_retention_class_is_frozen_at_deletion';
  end if;

  if not pg_catalog.row_security_active('public.documents'::pg_catalog.regclass) then
    -- A non-session writer (`postgres`, the sweep): the freeze still applies,
    -- because the class is derived and never supplied. A fixture born deleted
    -- is classed at birth; a re-date keeps the class it froze.
    if tg_op = 'INSERT' then
      new.retention_class := case when new.deleted_at is null then null
                                  else private.document_retention_class(new.id) end;
    elsif new.deleted_at is distinct from old.deleted_at then
      new.retention_class := case when new.deleted_at is null then null
                                  when old.deleted_at is null then private.document_retention_class(new.id)
                                  else old.retention_class end;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.bytes_purged_at is not null
       or new.retention_class is not null then
      raise exception 'documents: a document is created live and unpurged'
        using errcode = '42501', hint = 'document_is_born_live';
    end if;
    return new;
  end if;

  if new.bytes_purged_at is distinct from old.bytes_purged_at then
    raise exception 'documents.bytes_purged_at is written by the retention sweep alone'
      using errcode = '42501', hint = 'document_bytes_purged_at_is_the_sweeps';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is null then
      -- THE CLOCK IS THE DATABASE'S. Overwritten rather than refused, so the
      -- ordinary press keeps working with no round trip.
      new.deleted_at := pg_catalog.now();
      -- AND SO IS THE PERIOD: frozen now, from what is true now, whatever the
      -- session supplied (fix round 2, I-N1 / Q186).
      new.retention_class := private.document_retention_class(new.id);
    elsif new.deleted_at is not null then
      raise exception 'documents.deleted_at cannot be re-dated; restore the document and delete it again'
        using errcode = '42501', hint = 'document_deleted_at_is_the_databases_clock';
    else
      -- old not null -> new null is a RESTORE, and the CHECK above is what
      -- refuses it for a document whose bytes are already gone. The freeze
      -- goes with the clock.
      new.retention_class := null;
    end if;
  end if;

  return new;
end;
$$;

comment on function private.guard_document_retention_columns() is
  'THE DOCUMENT RETENTION CLOCK IS THE DATABASE''S -- BOTH HALVES (Phase 8 Task 6 fix round 1 C1, fix round 2 I-N1). BEFORE INSERT OR UPDATE on public.documents. FOR EVERY WRITER: storage_key is immutable after insert; retention_class is written only by the two deleted_at transitions -- stamped from private.document_retention_class() when deleted_at goes null -> value, cleared when it goes value -> null -- and any other write to it is refused, `postgres` included. For a session writer (any role RLS applies to -- an open list, so a client role added later arrives guarded): a document is born live, unpurged and unclassed; deleted_at going from null to a value is OVERWRITTEN with now(), so the Delete press keeps working and a PATCH naming a date eight years ago is corrected rather than obeyed; re-dating an already-deleted document is refused; bytes_purged_at is not writable at all. SECURITY INVOKER on purpose: row_security_active() inside a definer answers for the owner. private.sweep_document_bytes() runs as the table''s owner and is unaffected. The column-level grants make most of this unreachable from a client; the trigger is what holds if a later grant widens them, and rls_phase8_retention.sql § RK18/RK19 and § RK-N1 ask it directly with the grant switched back on.';


-- ---------------------------------------------------------------------------
-- 3. THE SWEEP AND THE MANIFEST, REBUILT FROM THEIR LATEST DEFINITIONS.
--    One term changed in each, three times in the sweep and once in the
--    manifest's expired_documents arm:
--        private.retention_period(private.document_retention_class(d.id))
--     -> private.retention_period(d.retention_class)
--    Everything else is byte-identical, generated from pg_get_functiondef().
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.sweep_document_bytes(p_dry boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n bigint; v_waiting bigint;
begin
  -- Expired, bytes still present: the runner's work, not this function's.
  select pg_catalog.count(*) into v_waiting
    from public.documents d
    join storage.objects s on s.bucket_id = 'documents' and s.name = d.storage_key
   where d.deleted_at is not null
     and d.bytes_purged_at is null
     and d.deleted_at < pg_catalog.now()
         - private.retention_period(d.retention_class);

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.documents d
             where d.deleted_at is not null
               and d.bytes_purged_at is null
               and d.deleted_at < pg_catalog.now()
                   - private.retention_period(d.retention_class)
               and not exists (select 1 from storage.objects s
                                where s.bucket_id = 'documents' and s.name = d.storage_key)
             order by d.deleted_at
             limit p_limit) t;
  else
    with done as (
      select d.id from public.documents d
       where d.deleted_at is not null
         and d.bytes_purged_at is null
         and d.deleted_at < pg_catalog.now()
             - private.retention_period(d.retention_class)
         and not exists (select 1 from storage.objects s
                          where s.bucket_id = 'documents' and s.name = d.storage_key)
       order by d.deleted_at
       limit p_limit)
    update public.documents d
       set bytes_purged_at = pg_catalog.now()
      from done
     where d.id = done.id;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'documents.bytes_purged', v_n,
    'documents.capped', v_n >= p_limit,
    'documents.waiting_on_bytes', v_waiting);
end;
$function$;

comment on function private.sweep_document_bytes(boolean, integer) is
  'Q52, the ROW side: stamps public.documents.bytes_purged_at on every soft-deleted, expired document whose object is already gone from the bucket. EXPIRED MEANS: deleted_at is older than private.retention_period(d.retention_class) -- THE CLASS FROZEN AT DELETION, never recomputed here (Phase 8 Task 6 fix round 2, re-review finding I-N1: recomputing it at sweep time let a tenant move a financial entry off the document''s event and take a seven-year document to the two-year period). The OBJECT side is the runner''s, from public.retention_object_manifest(). Splitting it this way is what handles requirement 5''s harder direction -- the object deleted and the row not updated, because the run died in between -- WITHOUT a two-phase commit nobody can have: the stamp is derived from the object''s absence, so the next run finishes what the last one started. `waiting_on_bytes` counts expired documents whose file is still there, which is the number that says whether the storage half is keeping up.';

revoke all on function private.sweep_document_bytes(boolean, integer)
  from public, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.retention_object_manifest(p_run_id uuid, p_limit integer DEFAULT 500)
 RETURNS TABLE(bucket text, object_key text, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_status  text;
  v_enabled boolean;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'retention_object_manifest: the retention runner is server-only'
      using errcode = '42501', hint = 'retention_runner_is_server_only';
  end if;

  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'retention_object_manifest: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- NO RUNNING RUN, NO KEYS.
  select r.status into v_status from public.retention_runs r where r.id = p_run_id;
  if not found then
    raise exception 'retention_object_manifest: no such run'
      using errcode = '22023', hint = 'unknown_retention_run';
  end if;
  if v_status <> 'running' then
    raise exception 'retention_object_manifest: run % is %', p_run_id, v_status
      using errcode = '22023', hint = 'retention_run_is_not_running';
  end if;

  -- THE KILL SWITCH, AGAIN: it can be thrown between the start and this call,
  -- and "stop" should mean stop before the next object, not after this run.
  select s.enabled into v_enabled from public.retention_settings s where s.id;
  if v_enabled is distinct from true then
    raise exception 'retention_object_manifest: the retention job is switched off'
      using errcode = '55000', hint = 'retention_disabled';
  end if;

  -- AND THE TWO STRUCTURAL ASSERTIONS, IN THE SAME CALL THAT PRODUCES THE
  -- KEYS. This is the gate that holds whatever the runner does.
  perform private.assert_retention_roll();
  perform private.assert_retention_clocks();

  return query
    with expired_documents as (
      -- (a) A soft-deleted document whose FROZEN class has run out -- the
      --     class stamped when it was deleted, never recomputed here (fix
      --     round 2, I-N1).
      select 'documents'::text as bucket, d.storage_key as object_key,
             'document_expired'::text as reason, d.deleted_at as age
        from public.documents d
       where d.deleted_at is not null
         and d.bytes_purged_at is null
         and d.deleted_at < pg_catalog.now()
             - private.retention_period(d.retention_class)
    ),
    doomed_workspaces as (
      -- (b) EVERY document of a workspace whose 60 days are up, whatever its
      --     own class. The workspace is about to be hard-purged and
      --     private.erase_organisation() REFUSES to run while a single byte of
      --     it is still in the bucket -- so if these were not here, the
      --     workspace purge would refuse for ever and nothing would say why.
      select 'documents'::text, d.storage_key, 'workspace_purge'::text, o.retention_expires_at
        from public.documents d
        join public.organisations o on o.id = d.organisation_id
       where o.deleted_at is not null
         and o.retention_expires_at is not null
         and o.retention_expires_at < pg_catalog.now()
    ),
    expired_feedback as (
      -- (c) An expired feedback row's screenshot (Q120).
      select 'feedback-screenshots'::text, f.screenshot_key, 'feedback_expired'::text, f.created_at
        from public.feedback f
       where f.screenshot_key is not null
         and f.created_at < private.feedback_retention_cutoff()
    ),
    expired_exports as (
      -- (d) An export archive past its own expires_at. Task 4 enforced that
      --     expiry at READ time only -- public.record_export_download() refuses
      --     an expired job -- and nothing ever deleted the zip, so every export
      --     anyone has ever taken is still sitting in the bucket. Measured, not
      --     assumed: there is no other caller of storage.remove() for this
      --     bucket anywhere in the repository.
      select 'exports'::text, j.storage_key, 'export_expired'::text, j.expires_at
        from public.export_jobs j
       where j.storage_key is not null
         and j.expires_at is not null
         and j.expires_at < pg_catalog.now()
    ),
    candidates as (
      select * from expired_documents
      union all select * from doomed_workspaces
      union all select * from expired_feedback
      union all select * from expired_exports
    ),
    present as (
      -- ONLY WHAT IS ACTUALLY THERE. The join is what makes a second run over
      -- the same subject a no-op with no bookkeeping column to get out of step.
      select c.bucket, c.object_key, c.reason, c.age
        from candidates c
        join storage.objects s on s.bucket_id = c.bucket and s.name = c.object_key
    ),
    orphans as (
      -- (e) THE ORPHAN HALF (requirement 5): an object no row names at all,
      --     older than the grace period. This is the residue of a row delete
      --     whose object delete failed, and of any other way the two can come
      --     apart.
      select s.bucket_id::text as bucket, s.name as object_key,
             'orphan'::text as reason, s.created_at as age
        from storage.objects s
       where s.bucket_id in ('documents', 'feedback-screenshots', 'exports')
         and s.created_at < pg_catalog.now() - private.retention_period('storage_orphan')
         and not exists (select 1 from public.documents d where d.storage_key = s.name
                          and s.bucket_id = 'documents')
         and not exists (select 1 from public.feedback f where f.screenshot_key = s.name
                          and s.bucket_id = 'feedback-screenshots')
         and not exists (select 1 from public.export_jobs j where j.storage_key = s.name
                          and s.bucket_id = 'exports')
    )
    select bucket, object_key, reason
      from (select * from present union all select * from orphans) all_rows
     -- OLDEST FIRST, so a run that hits the ceiling leaves the newer remainder
     -- for the next one rather than skipping an arbitrary slice for ever.
     order by age, object_key
     limit greatest(coalesce(p_limit, 500), 0);
end;
$function$;

comment on function public.retention_object_manifest(uuid, integer) is
  'WHAT THE RETENTION RUNNER DELETES FROM THE BUCKETS, derived in the database (Phase 8 Task 6) -- AND, SINCE 20261004002000 (review finding C2), NOTHING AT ALL FOR A RUN THAT WOULD REFUSE. It takes the run id: no `running` run, no keys. It re-asserts `replica`, the kill switch, private.assert_retention_roll() and private.assert_retention_clocks() in the same call that produces the keys, so no ordering of runner calls and no runner bug obtains an object key from a database that would refuse the run. (The runner used to delete objects BEFORE step 0 was ever asked; the reviewer measured a run recorded `failed` whose file was already gone.) The erasure runner''s rule, for the same reason: the keys come from here and never from TypeScript, so a bug in the runner cannot aim a delete at a prefix the database did not name. Five sources -- an expired document''s bytes (Q52; expired against the class FROZEN when it was deleted, documents.retention_class, never recomputed -- fix round 2, I-N1), every document of a workspace whose 60 days are up (because private.erase_organisation() refuses to run while one byte remains), an expired feedback row''s screenshot (Q120), an export archive past its own expires_at, and ORPHANS in all three buckets: objects no row names, older than the storage_orphan grace period. It lists only objects that EXIST, which is what makes the storage half idempotent with no bookkeeping column, and it returns them OLDEST FIRST under a ceiling, so a capped run leaves a remainder rather than skipping a slice. service_role only.';

revoke all on function public.retention_object_manifest(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.retention_object_manifest(uuid, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 4. THE DERIVATION GAINS THE PERIOD-SELECTOR ARM, and STATES ITS LIMITS.
--    Rebuilt from 20261004001000; the first arm is byte-identical.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_candidates()
returns table (schema_name text, table_name text, column_name text, read_by text)
language sql
stable
set search_path = ''
as $$
  with retention_functions as (
    select p.proname::text as fn, p.prosrc
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname = 'retention_object_manifest'
    union
    select p.proname::text, p.prosrc
      from pg_catalog.pg_proc b
      cross join lateral pg_catalog.regexp_matches(b.prosrc, 'private\.([a-z_0-9]+)\s*\(', 'g') m
      join pg_catalog.pg_proc p
        on p.pronamespace = 'private'::pg_catalog.regnamespace and p.proname = m[1]
     where b.pronamespace = 'private'::pg_catalog.regnamespace
       and b.proname = 'retention_sweep_body'
  ),
  named_tables as (
    select distinct f.fn, f.prosrc, k.oid as relid, m[1] as sch, m[2] as tbl
      from retention_functions f
      cross join lateral pg_catalog.regexp_matches(f.prosrc, '(public|storage)\.([a-z_0-9]+)', 'g') m
      join pg_catalog.pg_namespace n on n.nspname = m[1]
      join pg_catalog.pg_class k
        on k.relnamespace = n.oid and k.relname = m[2] and k.relkind in ('r', 'p', 'm')
  ),
  -- ARM 1: every date/timestamp column of a named table whose NAME the
  -- function's source carries -- WHEN a clock started.
  timestamp_columns as (
    select t.sch, t.tbl, a.attname::text as col, t.fn
      from named_tables t
      join pg_catalog.pg_attribute a
        on a.attrelid = t.relid and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('timestamptz'::pg_catalog.regtype, 'timestamp'::pg_catalog.regtype,
                          'date'::pg_catalog.regtype)
     where t.prosrc ~ ('\m' || a.attname::text || '\M')
  ),
  -- ARM 2 (fix round 2, I-N1): every column of a named table that the source
  -- HANDS TO private.retention_period() -- WHICH PERIOD applies -- whatever
  -- its type. `retention_period(d.retention_class)` names the column;
  -- `retention_period(private.document_retention_class(d.id))` names none,
  -- which is the point: a selector reached through a function is invisible
  -- here, and that is why the class is frozen into a column.
  selector_columns as (
    select t.sch, t.tbl, a.attname::text as col, t.fn
      from named_tables t
      cross join lateral pg_catalog.regexp_matches(
        t.prosrc, 'retention_period\(\s*[a-z_0-9]+\.([a-z_0-9]+)\s*\)', 'g') m
      join pg_catalog.pg_attribute a
        on a.attrelid = t.relid and a.attnum > 0 and not a.attisdropped
       and a.attname::text = m[1]
  )
  select c.sch, c.tbl, c.col,
         pg_catalog.string_agg(distinct c.fn, ',' order by c.fn)
    from (select * from timestamp_columns union all select * from selector_columns) c
   group by c.sch, c.tbl, c.col
   order by 1, 2, 3
$$;

comment on function private.retention_clock_candidates() is
  'THE DERIVATION behind private.assert_retention_clocks() (Phase 8 Task 6 fix round 1, C1; fix round 2, I-N1). Two arms over the tables a retention function''s own source names, where "a retention function" is public.retention_object_manifest() plus every private function private.retention_sweep_body() calls -- so a new sweep is in the set by construction, because a sweep not called from there does not run. ARM 1: every date/timestamp column whose name the source carries (WHEN a clock started). ARM 2: every column the source hands to private.retention_period(), whatever its type (WHICH PERIOD applies) -- documents.retention_class, the class frozen at deletion. OVER-APPROXIMATES ON PURPOSE: a column NAME is matched, so a false candidate costs one roll entry saying why it is not a clock, and a missed one costs a forgeable deletion. STATED LIMITS, each measured: (1) it follows ONE HOP -- the manifest and the sweep body''s direct callees -- so a clock read through a helper function, a wrapper, or a view is invisible (the re-review''s I-N1: private.document_retention_class() at depth two read financial_entries.event_id, a tenant-writable uuid); (2) it sees date/timestamp columns and the DIRECT column argument of retention_period() only -- a selector reached through a function call, a clock in a jsonb field or an epoch/text column is not a candidate by type; (3) it names tables in `public` and `storage` only; (4) it cannot see a clock a TRIGGER computes from another column (organisations.lifecycle_changed_at; the roll names it by hand). Fix round 2''s m-N1 migration widens (1) and (3).';


-- ---------------------------------------------------------------------------
-- 5. THE ROLL, REBUILT FROM 20261004001000: one entry added, beside the
--    timestamp half it belongs to.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_columns()
returns table (schema_name text, table_name text, column_name text, role text, guard text, note text)
language sql
immutable
set search_path = ''
as $$
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
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC; organisations_update_manage_organisation also carries `deleted_at is null` in USING, so a closed workspace admits no tenant UPDATE at all.'),
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

    ('storage', 'objects', 'created_at', 'clock',
     'policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies instead; the six named here are the INSERT and UPDATE halves of that fence.')
$$;

comment on function private.retention_clock_columns() is
  'THE ROLL of every column a retention cutoff reads (Phase 8 Task 6 fix round 1, review finding C1 generalised; fix round 2, I-N1). Each candidate private.retention_clock_candidates() derives is a `clock` or `not_a_clock` with the reason; a `clock` any client role can INSERT or UPDATE must name a guard that really exists, and private.assert_retention_clocks() REFUSES THE JOB otherwise. It also names the one clock the derivation cannot reach (organisations.lifecycle_changed_at, which a trigger turns into retention_expires_at). Since fix round 2 it carries the PERIOD half of the document clock beside the timestamp half: documents.retention_class, frozen at deletion by the same guard. That a guard actually pins the value is behaviour, and is asserted by a probe per client-writable clock in rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_candidates() from public, anon, authenticated, service_role;
revoke all on function private.retention_clock_columns() from public, anon, authenticated, service_role;
