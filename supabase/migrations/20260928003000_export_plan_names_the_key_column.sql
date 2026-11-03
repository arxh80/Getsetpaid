-- ===========================================================================
-- PHASE 8 TASK 4, FIX ROUND 1 -- THE PLAN NAMES THE KEY COLUMN.
--
-- Task 4 review, finding M9.
--
-- private.export_catalogue() declares a `key_column` per exported table, and
-- private.export_page_sql() builds both the `order by` and the `> $2` keyset
-- predicate from it. The RUNNER'S cursor did not read it:
-- lib/export/runner.ts's `cursorOf()` was `row.id ?? row.user_id` -- the two
-- key columns the catalogue happens to use today, hard-coded in a second
-- place.
--
-- One fact, two homes, which is the thing this feature's own design rejects
-- everywhere else: the runner deliberately holds no table list and no
-- ceilings, precisely so that the completeness census can see them. A third
-- key column added later would page correctly for the first 500 rows and then
-- raise `the page cursor did not advance` -- loud rather than silent, which is
-- why this was Minor, but it is a failure that need not exist.
--
-- So the plan carries it. public.export_plan() is what the runner asks for
-- the table list, and it is already reading the catalogue row; returning one
-- more column is the whole fix, and the runner's cursor becomes
-- `row[plan.key_column]`.
--
-- DROP THEN CREATE, not `create or replace`: Postgres refuses to replace a
-- set-returning function whose OUT columns change. The drop is safe and is
-- not a gap -- migrations run in one transaction, EXECUTE is re-granted to
-- service_role alone below, and no client role ever held it.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

drop function if exists public.export_plan(uuid);

create function public.export_plan(p_job_id uuid)
returns table (
  table_name    text,
  disposition   text,
  reason        text,
  authorisation text,
  key_column    text
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
    select c.table_name, c.disposition, c.reason, c.authorisation, c.key_column
      from private.export_catalogue() c
     where c.export_kind = v_job.kind
     order by c.disposition, c.table_name;
end;
$$;

comment on function public.export_plan(uuid) is
  'The table list for one export job, exported rows and excused rows alike, straight out of private.export_catalogue() (Phase 8 Task 4). The runner holds no list of its own: a list in TypeScript would be a second place for the answer to live and tests/integration/export/completeness-census.test.ts could not see it. The excused rows travel with their reasons because manifest.json has to say what is NOT in the archive and why. KEY_COLUMN travels with each exported row since 20260928003000 (review finding M9): the pager orders and resumes on the catalogue''s declared key, and the runner''s cursor used to re-derive it as `row.id ?? row.user_id` -- the same fact in two homes, and a third key column added later would have paged one page and then raised. Refuses any session with a person on it; EXECUTE is granted to service_role alone.';

revoke all on function public.export_plan(uuid) from public, anon, authenticated;
grant execute on function public.export_plan(uuid) to service_role;
