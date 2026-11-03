-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- M2 (and C1's workspace half): THE WORKSPACE
-- PURGE WRITES ITS OWN SUMMARY ROW, AND RUNS THE SAME ROLL.
--
-- M2. Requirement 3 asks for "one summary audit row saying what was erased,
-- in counts". private.erase_account() writes one; private.erase_organisation()
-- wrote NONE -- a workspace purge left only the `erasure_job.requested` row
-- from the insert trigger and the erasure_jobs.summary column, neither of
-- which is the audit log. Task 6 is its caller and would have inherited the
-- gap. The row is the account erasure's exactly: counts, never content, actor
-- = the tombstone (the workspace's own people are not the actor of the
-- platform's purge, and by the time it runs there may be none of them left).
--
-- C1's workspace half. The same roll the account erasure runs
-- (private.fkless_identifier_columns(), 20261001000000) carries one
-- `organisation`-bearing column -- public.feedback.support_access_organisation_id,
-- a snapshot of the workspace a superuser was inside, with no foreign key --
-- and one scoped `delete_row` for a workspace's rate-limit counters. Neither
-- was touched by the purge, so a purged workspace's id survived in both. The
-- roll is asserted here too, so a new unclassified column refuses a purge
-- exactly as it refuses an erasure.
--
-- ADDITIVE. private.erase_organisation() is rebuilt from its LATEST
-- definition (20260930002000 section 4).
-- ===========================================================================

create or replace function private.erase_organisation(
  p_organisation_id uuid,
  p_job_id          uuid default null,
  p_require_closed  boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counts   jsonb := '{}'::jsonb;
  v_org      public.organisations%rowtype;
  v_type     text;
  v_n        bigint;
  v_total    bigint := 0;
  v_left     text;
  v_orphans  bigint;
  v_rec      record;
begin
  if p_organisation_id is null then
    raise exception 'erase_organisation: a workspace is required' using errcode = '22023';
  end if;

  -- (0) NEVER UNDER `replica`. See the header. This is the control; the
  -- sentence in the brief is not.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'erase_organisation: refuses to run with session_replication_role = %, because the ON DELETE SET NULL that keeps a routed data subject request readable would not fire',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- (0b) THE ROLL AND THE CATALOGUE MUST AGREE (fix round 1, C1). The same
  -- assertion the account erasure makes, for the same reason: a uuid column
  -- no foreign key protects is invisible to step 7's walk.
  perform private.assert_fkless_identifier_roll();

  -- (1) IDEMPOTENCE. Running it twice is not an error.
  select * into v_org from public.organisations o where o.id = p_organisation_id;
  if not found then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) A LIVE WORKSPACE IS NOT PURGED. Task 6's 60-day clock decides WHEN a
  -- closed workspace goes; this decides that an OPEN one never does. The one
  -- caller that passes false is Q131's empty-and-ownerless case, which checks
  -- emptiness itself.
  if p_require_closed and v_org.deleted_at is null then
    raise exception 'erase_organisation: a live workspace is not purged -- close it first'
      using errcode = '22023', hint = 'workspace_is_live';
  end if;

  -- (3) THE BYTES FIRST, ALWAYS. Q52: soft-deleting a document keeps its
  -- bytes, so the rows are NOT what makes a file unreachable. If the runner's
  -- storage sweep has not finished, this refuses -- deleting the rows now
  -- would leave objects in the bucket that nothing in the database names.
  select count(*) into v_n
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name like p_organisation_id::text || '/%';
  if v_n > 0 then
    raise exception 'erase_organisation: % document object(s) are still in the bucket', v_n
      using errcode = '55000', hint = 'bytes_not_purged';
  end if;

  -- (4) TRAP: THE POLYMORPHIC TABLE, SWEPT BEFORE ITS ENTITIES, FOR EVERY
  -- TYPE THE LIVE CHECK ALLOWS (seven, not the brief's six).
  for v_type in select t from private.custom_field_entity_types() t loop
    v_n := private.sweep_custom_field_values(p_organisation_id, v_type, null);
    v_total := v_total + v_n;
    v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values.' || v_type, v_n);
  end loop;
  v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values', v_total);

  -- (5) TRAP: THE DISCARDED RECORD'S VALUES, VERBATIM. merges.field_resolution
  -- holds what the losing contact/company/artist actually said -- email,
  -- phone, address. Scrubbed before the delete rather than left to the
  -- cascade, so a backup taken in between already has nothing in it. The
  -- owner-id snapshots beside it have no foreign key and go with it.
  update public.merges m
     set field_resolution = '{}'::jsonb,
         winner_owner_user_id = null,
         loser_owner_user_id  = null
   where m.organisation_id = p_organisation_id
     and (m.field_resolution <> '{}'::jsonb
          or m.winner_owner_user_id is not null
          or m.loser_owner_user_id is not null);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('merges.field_resolution', v_n);

  -- (5b) THE WORKSPACE-BEARING COLUMNS NO FOREIGN KEY PROTECTS, RUN FROM THE
  -- ROLL (fix round 1). public.feedback.support_access_organisation_id names
  -- the workspace a superuser was inside; the counters name a workspace that
  -- will not be asking for anything else. Neither is reachable by step 7's
  -- pg_constraint walk, so neither was touched before.
  for v_rec in
    select r.table_name as tbl, r.column_name as col
      from private.fkless_identifier_columns() r
     where r.identifies = 'organisation' and r.treatment = 'null_on_match'
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = null where %I = $1',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using p_organisation_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
  end loop;
  for v_rec in
    select r.table_name as tbl, r.column_name as col, r.predicate as pred
      from private.fkless_identifier_columns() r
     where r.identifies = 'organisation' and r.treatment = 'delete_row'
     order by 1, 2
  loop
    execute pg_catalog.format('delete from %s where %I = $1 and (%s)',
                              v_rec.tbl, v_rec.col, coalesce(v_rec.pred, 'true'))
      using p_organisation_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.purged', v_n);
  end loop;

  -- (6) THE DELETE. Every cascade runs, at `origin`, paying for the
  -- referential integrity that keeps a routed request readable.
  delete from public.organisations o where o.id = p_organisation_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('organisations', v_n);

  -- (7) ASSERT WHAT IS LEFT, DERIVED. Every foreign key in the database that
  -- points at public.organisations is asked directly whether it still names
  -- this workspace. A cascade that did not run -- because a later migration
  -- shipped a NO ACTION reference, or because somebody reached for `replica`
  -- despite (0) -- is a hard failure and the whole transaction rolls back.
  for v_type in
    select con.conrelid::pg_catalog.regclass::text || '|' || a.attname
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'public.organisations'::pg_catalog.regclass
       and c.relkind in ('r', 'p')
       and pg_catalog.array_length(con.conkey, 1) = 1
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1',
                              pg_catalog.split_part(v_type, '|', 1),
                              pg_catalog.split_part(v_type, '|', 2))
      into v_n using p_organisation_id;
    if v_n > 0 then
      raise exception 'erase_organisation: % still names the workspace after the delete (% row(s))',
        pg_catalog.replace(v_type, '|', '.'), v_n
        using errcode = '55000', hint = 'reference_survived_the_purge';
    end if;
  end loop;

  -- (8) AND THE ORPHAN CENSUS FOR THE ONE TABLE NO FOREIGN KEY PROTECTS.
  select count(*) into v_orphans
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id;
  if v_orphans > 0 then
    raise exception 'erase_organisation: % custom field value(s) survived', v_orphans
      using errcode = '55000', hint = 'custom_field_values_orphaned';
  end if;

  if p_job_id is not null then
    v_counts := v_counts || pg_catalog.jsonb_build_object('workspace_purged', true);
  end if;

  -- (9) ONE SUMMARY ROW (M2). Counts, never content, and the ACTOR IS THE
  -- TOMBSTONE -- the platform purges a workspace and the workspace's own
  -- people are not the actor of it; by the time Task 6's clock runs there
  -- may be none of them left. organisation_id is NULL because the workspace
  -- it would name has just been deleted (the column is a foreign key), which
  -- is why the id travels in the payload instead.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    null, private.erased_user_id(), 'organisation.erased', 'organisation',
    p_organisation_id,
    coalesce(p_job_id, pg_catalog.gen_random_uuid()),
    v_counts || pg_catalog.jsonb_build_object('organisation_id', p_organisation_id));

  return v_counts;
end;
$$;

comment on function private.erase_organisation(uuid, uuid, boolean) is
  'THE WORKSPACE PURGE PRIMITIVE (Phase 8 Task 5), which Task 6''s 60-day clock calls rather than reimplementing. One transaction, all-or-nothing, idempotent (a workspace that is already gone returns {"already_erased": true} rather than raising). It REFUSES to run unless session_replication_role is `origin` (55000, hint replication_role_must_be_origin) -- the shortcut a bulk purge reaches for, and the one that would delete an organisation WITHOUT running data_subject_requests.routed_to_organisation_id''s ON DELETE SET NULL and leave the routing evidence pointing at nothing. It refuses a LIVE workspace unless the caller says otherwise (Q131''s empty-and-ownerless case is the only one that does), refuses while any document byte is still in the bucket (Q52 -- the rows are not what makes a file unreachable), sweeps the polymorphic custom_field_values for all SEVEN live entity types before the cascade reaches them, scrubs merges.field_resolution and its two FK-less owner-id snapshots, and then ASSERTS, by walking pg_constraint, that not one foreign key anywhere still names the workspace. SINCE FIX ROUND 1 it also runs the `organisation`-bearing half of private.fkless_identifier_columns() -- the columns no foreign key protects and no walk can see -- refuses when the catalogue has grown one the roll does not classify, and writes ONE SUMMARY AUDIT ROW of counts (`organisation.erased`, actor = the tombstone), which requirement 3 asked for and the first cut did not write at all (M2).';

revoke all on function private.erase_organisation(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
