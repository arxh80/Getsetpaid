-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 7: WHAT THE RUNNER IS TOLD TO DO.
--
-- The runner holds NO list of tables. It asks for one, per job, and the
-- answer comes from private.export_catalogue() -- the same function the
-- completeness census checks against the live catalogue. A list in
-- TypeScript would be a second place for the answer to live and the census
-- would not be able to see it.
--
-- The EXCUSED rows come back too, with their reasons, because the manifest
-- has to say what is not in the archive and why. An export that quietly
-- leaves something out is the failure a statutory access response cannot
-- have.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function public.export_plan(p_job_id uuid)
returns table (
  table_name    text,
  disposition   text,
  reason        text,
  authorisation text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job public.export_jobs%rowtype;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'export_plan: the plan is read by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_runner_is_server_only';
  end if;

  select * into v_job from public.export_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'export_plan: no such job' using errcode = '22023', hint = 'unknown_export_job';
  end if;

  return query
    select c.table_name, c.disposition, c.reason, c.authorisation
      from private.export_catalogue() c
     where c.export_kind = v_job.kind
     order by c.disposition, c.table_name;
end;
$$;

comment on function public.export_plan(uuid) is
  'The table list for one export job, exported rows and excused rows alike, straight out of private.export_catalogue() (Phase 8 Task 4). The runner holds no list of its own: a list in TypeScript would be a second place for the answer to live and tests/integration/export/completeness-census.test.ts could not see it. The excused rows travel with their reasons because manifest.json has to say what is NOT in the archive and why. Refuses any session with a person on it; EXECUTE is granted to service_role alone.';

revoke all on function public.export_plan(uuid) from public, anon, authenticated;
grant execute on function public.export_plan(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- THE CEILINGS, FOR THE RUNNER.
--
-- private.export_limits() is the declaration and no client role can reach it.
-- The runner enforces the row and byte ceilings as it writes -- the database
-- cannot, because "this archive is 41 MiB" is not a fact about any row -- so
-- it has to be able to ASK. It asks rather than holding copies:
-- lib/export/contract.ts mirrors the numbers for the UI's copy alone, and a
-- drift there changes what a page SAYS and never what the job DOES.
-- ---------------------------------------------------------------------------

create or replace function public.export_limits_for_runner()
returns table (
  page_size          integer,
  max_rows_per_table bigint,
  max_total_rows     bigint,
  max_archive_bytes  bigint,
  archive_days       integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'export_limits_for_runner: read by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_runner_is_server_only';
  end if;
  return query select l.page_size, l.max_rows_per_table, l.max_total_rows,
                      l.max_archive_bytes, l.archive_days
                 from private.export_limits() l;
end;
$$;

comment on function public.export_limits_for_runner() is
  'private.export_limits() for the export runner, which enforces the row and byte ceilings as it writes because the database cannot ("this archive is 41 MiB" is not a fact about any row). The runner ASKS rather than holding copies; lib/export/contract.ts mirrors the numbers for page copy alone, so a drift there changes what a page says and never what a job does. Refuses any session with a person on it; EXECUTE is granted to service_role alone.';

revoke all on function public.export_limits_for_runner() from public, anon, authenticated;
grant execute on function public.export_limits_for_runner() to service_role;
