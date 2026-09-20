-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 3: THE READ ENGINE.
--
-- ===========================================================================
-- THE ONE IDEA IN THIS FILE: THE JOB READS AS THE REQUESTER
-- ===========================================================================
-- The brief's requirement 4 is that an Owner's workspace export must not
-- contain another member's PRIVATE note. There are two ways to get that:
-- re-implement `notes_select_by_visibility` (and the record-scope term on
-- every CRM table, and the network policies, and whatever a later phase
-- adds) inside the job; or make the job's reads run under the requester's own
-- session so the SHIPPED policies decide. The first is a second copy of the
-- security model that drifts silently. This file does the second.
--
-- HOW. private.export_read_page_as_requester() carries two function-level SET
-- clauses:
--
--     set search_path = ''
--     set role = authenticated
--
-- A function-level SET is saved on entry and RESTORED on exit, which a bare
-- `set_config(..., true)` inside the body is not -- that would leak the role
-- into the rest of the caller's transaction. The outer definer resolves the
-- job, writes the requester's claims into `request.jwt.claims` (which is what
-- auth.uid(), auth.role() and private.session_is_aal2() all read), calls the
-- inner function, and restores the previous claims afterwards.
--
-- THE CLAIMS ARE THE DATABASE'S, NOT A CALLER'S. `sub` and `aal` come from
-- the export_jobs row -- stamped there by the insert trigger from the
-- session that actually asked -- so the runner cannot ask for somebody
-- else's data by passing a different subject, and cannot promote an aal1
-- request to aal2 (which would widen an MFA-required role's permissions and
-- the platform superuser's own reads).
--
-- ===========================================================================
-- THE FOUR ELEVATED READS, AND WHY THEY ARE NOT AN EXCEPTION TO THE ABOVE
-- ===========================================================================
-- `audit_events`, `feedback`, `platform_admins` and `impersonation_sessions`
-- have no client read the requester could use (20260927000000 § 3 says which
-- and why). A requester_rls read of those four would have returned ZERO ROWS
-- and every test about them would have passed -- the invisible denominator
-- this phase keeps tripping over. They are read as the definer instead, and
-- the two rules that make that safe are enforced HERE rather than trusted:
--
--   * the filter is the catalogue's `scope_columns` = the job's subject, and
--     nothing else. There is no "and also" clause a caller can add.
--   * the projection is the catalogue's `projection`, and a null projection
--     is permitted only for a table whose every column is the requester's.
--
-- A workspace export may never use an elevated read at all
-- (private.export_catalogue_is_sound() refuses one, and this function
-- refuses one again at run time).
--
-- ===========================================================================
-- DYNAMIC SQL, AND WHY IT IS NOT STRING-CONCATENATED SQL
-- ===========================================================================
-- Every identifier comes from private.export_catalogue(), an IMMUTABLE
-- function in a schema no client role can reach, and is quoted with
-- format()'s %I. Every VALUE is a real bind parameter ($1/$2/$3). This is the
-- allowlisted-column rule CLAUDE.md states, not an exception to it: the
-- alternative -- a CASE with one branch per table -- would be 39 branches
-- that drift from the catalogue the census checks.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. ONE MORE CATALOGUE INVARIANT, learnt while writing the pager: the KEY
--    COLUMN MUST SURVIVE THE PROJECTION, or a projected table's pages cannot
--    be ordered or resumed and the second page silently repeats the first.
--    private.export_catalogue_is_sound() is re-issued from its LATEST
--    definition (20260927000000 § 4) with that check added.
-- ---------------------------------------------------------------------------

create or replace function private.export_catalogue_is_sound()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.string_agg(problem, '; ' order by problem)
       from (
         select 'unknown export_kind: ' || c.export_kind as problem
           from private.export_catalogue() c where c.export_kind not in ('account','workspace')
         union all
         select 'unknown disposition: ' || c.table_name
           from private.export_catalogue() c where c.disposition not in ('exported','excused')
         union all
         select 'excused without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'excused'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without an authorisation: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.authorisation is null or c.authorisation not in ('requester_rls','elevated'))
         union all
         select 'elevated without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.authorisation = 'elevated'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without scope columns: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.scope_columns is null or pg_catalog.array_length(c.scope_columns, 1) is null)
         union all
         select 'exported without a key column: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported' and c.key_column is null
         union all
         -- NEW IN 20260927002000.
         select 'the key column is projected away: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and c.projection is not null
            and not (c.key_column = any (c.projection))
         union all
         select 'a workspace export table is elevated: ' || c.table_name
           from private.export_catalogue() c
          where c.export_kind = 'workspace' and c.authorisation = 'elevated'
         union all
         select 'no such relation: ' || c.table_name
           from private.export_catalogue() c
          where not exists (select 1 from pg_catalog.pg_class k
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name and k.relkind = 'r')
         union all
         select 'no such column ' || col || ' on ' || c.table_name
           from private.export_catalogue() c
           cross join lateral pg_catalog.unnest(
             coalesce(c.scope_columns, '{}'::text[])
             || coalesce(c.projection, '{}'::text[])
             || (case when c.key_column is null then '{}'::text[] else array[c.key_column] end)) as col
          where not exists (select 1 from pg_catalog.pg_attribute a
                              join pg_catalog.pg_class k on k.oid = a.attrelid
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name
                               and a.attname = col and a.attnum > 0 and not a.attisdropped)
         union all
         select 'duplicate catalogue row: ' || c.export_kind || '.' || c.table_name
           from private.export_catalogue() c
          group by c.export_kind, c.table_name having pg_catalog.count(*) > 1
       ) problems),
    'sound');
$$;

comment on function private.export_catalogue_is_sound() is
  'Answers `sound`, or a semicolon-joined list of everything wrong with private.export_catalogue(): an unknown kind or disposition, an excused row with no reason, an exported row with no authorisation / scope column / key column, a PROJECTION that drops the key column (the pager orders and resumes on it, so a projected-away key makes the second page repeat the first), an ELEVATED row in the workspace export (never permitted -- the whole workspace export runs under the requester''s own RLS), a table or column that does not exist, or a duplicate row. Re-issued in 20260927002000 with the key-column check.';

revoke all on function private.export_catalogue_is_sound() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE PAGE QUERY, built once and used by both authorisations.
--
--    KEYSET, never OFFSET: `key::text > $2 order by key::text`. The cast is
--    what lets one function page a uuid key and a non-uuid one with the same
--    cursor type; the order it imposes is arbitrary but TOTAL and STABLE,
--    which is all a resume needs.
-- ---------------------------------------------------------------------------

create or replace function private.export_page_sql(
  p_table         text,
  p_projection    text[],
  p_scope_columns text[],
  p_key_column    text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cols  text;
  v_scope text;
begin
  if p_scope_columns is null or pg_catalog.array_length(p_scope_columns, 1) is null then
    raise exception 'export_page_sql: % has no scope column', p_table using errcode = '22023';
  end if;

  -- The projection. Every identifier is quoted with %I and every one of them
  -- came out of private.export_catalogue().
  select case
           when p_projection is null then '*'
           else pg_catalog.string_agg(pg_catalog.format('%I', c), ', ')
         end
    into v_cols
    from pg_catalog.unnest(coalesce(p_projection, array['*'])) c;

  -- The subject test: one scope column, or several OR-ed, all bound to $1.
  select pg_catalog.string_agg(pg_catalog.format('%I = $1', c), ' or ')
    into v_scope
    from pg_catalog.unnest(p_scope_columns) c;

  return pg_catalog.format(
    'select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page) order by page.%1$I::text), ''[]''::jsonb)'
    || ' from (select %2$s from public.%3$I where (%4$s) and %1$I::text > $2'
    || ' order by %1$I::text limit $3) page',
    p_key_column, v_cols, p_table, v_scope);
end;
$$;

comment on function private.export_page_sql(text, text[], text[], text) is
  'The one page query both export authorisations run. Identifiers come from private.export_catalogue() and are quoted with format()''s %I; the subject ($1), the cursor ($2) and the page size ($3) are bind parameters. Keyset on key::text -- an arbitrary but total and stable order, which is all a resumable page needs, and which lets one function page a uuid key and any other.';

revoke all on function private.export_page_sql(text, text[], text[], text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE REQUESTER'S OWN READ.
--
--    SECURITY INVOKER, so no definer privilege is in play at all, plus
--    `set role = authenticated`: the body runs as the same role the
--    requester's browser runs as, against the same policies, with
--    auth.uid() answering from the claims the caller installed. The SET is a
--    function-level one so it is RESTORED on exit.
-- ---------------------------------------------------------------------------

create or replace function private.export_read_page_as_requester(
  p_table         text,
  p_projection    text[],
  p_scope_columns text[],
  p_key_column    text,
  p_subject       uuid,
  p_after         text,
  p_limit         integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
set role = authenticated
as $$
declare
  v_rows jsonb;
begin
  execute private.export_page_sql(p_table, p_projection, p_scope_columns, p_key_column)
    into v_rows
    using p_subject, coalesce(p_after, ''), p_limit;
  return v_rows;
end;
$$;

comment on function private.export_read_page_as_requester(text, text[], text[], text, uuid, text, integer) is
  'One page of one table, read AS THE REQUESTER: SECURITY INVOKER with a function-level `set role = authenticated`, so every RLS policy in the schema decides exactly as it would in that person''s browser -- including notes_select_by_visibility, which is what makes "an Owner''s workspace export contains no other member''s private note" true by construction rather than by a rule this file restates. The caller installs the requester''s claims in request.jwt.claims first; auth.uid() and private.session_is_aal2() read them here. The function-level SET is restored on exit, which a set_config() in the body would not be. Granted to no role: the only caller is public.export_read_page().';

revoke all on function private.export_read_page_as_requester(text, text[], text[], text, uuid, text, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. THE ENTRY POINT -- the only thing the runner calls to read anything.
-- ---------------------------------------------------------------------------

create or replace function public.export_read_page(
  p_job_id uuid,
  p_table  text,
  p_after  text,
  p_limit  integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job     public.export_jobs%rowtype;
  v_cat     record;
  v_subject uuid;
  v_prev    text;
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

  -- The subject is the JOB'S, never the caller's: the person for an account
  -- export, the workspace for a workspace one.
  v_subject := case when v_job.kind = 'account' then v_job.requested_by else v_job.organisation_id end;

  select l.page_size into v_max from private.export_limits() l;
  v_limit := least(greatest(coalesce(p_limit, v_max), 1), v_max);

  if v_cat.authorisation = 'elevated' then
    -- Belt and braces: the catalogue already refuses this shape
    -- (private.export_catalogue_is_sound()), and so does this.
    if v_job.kind = 'workspace' then
      raise exception 'export_read_page: a workspace export has no elevated reads'
        using errcode = '42501', hint = 'workspace_export_is_requester_rls';
    end if;
    execute private.export_page_sql(p_table, v_cat.projection, v_cat.scope_columns, v_cat.key_column)
      into v_rows
      using v_subject, coalesce(p_after, ''), v_limit;
    return v_rows;
  end if;

  -- REQUESTER_RLS. Install the requester's claims -- from the JOB ROW, so
  -- neither the subject nor the assurance level is the caller's to choose --
  -- read, and put the previous claims back.
  v_prev := pg_catalog.current_setting('request.jwt.claims', true);
  perform pg_catalog.set_config('request.jwt.claim.sub',  '', true);
  perform pg_catalog.set_config('request.jwt.claim.role', '', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub',  v_job.requested_by::text,
      'role', 'authenticated',
      'aal',  v_job.requested_aal)::text,
    true);

  begin
    v_rows := private.export_read_page_as_requester(
      p_table, v_cat.projection, v_cat.scope_columns, v_cat.key_column,
      v_subject, coalesce(p_after, ''), v_limit);
  exception when others then
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
    raise;
  end;

  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return v_rows;
end;
$$;

comment on function public.export_read_page(uuid, text, text, integer) is
  'ONE PAGE OF ONE TABLE for a running export job (Phase 8 Task 4). Refuses any session with a person on it (42501, hint export_reads_are_server_only -- its own hint, so a missing EXECUTE grant''s 42501 is distinguishable); refuses a job that is not running and a table private.export_catalogue() does not export for that job''s kind; and caps the page at private.export_limits().page_size. A requester_rls table is read through private.export_read_page_as_requester() with the requester''s claims -- subject and assurance level taken from the JOB ROW, never from the caller -- so the shipped RLS policies decide. An elevated table (four, all in the account export, each with no client read at all) is read as the definer, filtered to the catalogue''s scope columns and projected to the catalogue''s columns, and is refused outright for a workspace export. EXECUTE is granted to service_role alone.';

revoke all on function public.export_read_page(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.export_read_page(uuid, text, text, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 5. CLAIMING A JOB.
--
--    An RPC rather than a PATCH because two runners may tick at once (the
--    request's own nudge and the cron safety net) and `for update skip
--    locked` is the only thing that makes "exactly one runner per job" true.
--    Completion and failure are ordinary column-level UPDATEs from the
--    runner's service_role client -- the grant in 20260927001000 § 7 is their
--    whole authorisation, and the BEFORE UPDATE trigger is their guard.
-- ---------------------------------------------------------------------------

create or replace function public.claim_export_job()
returns table (
  id              uuid,
  kind            text,
  organisation_id uuid,
  requested_by    uuid,
  requested_at    timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'claim_export_job: jobs are claimed by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_runner_is_server_only';
  end if;

  select j.id into v_id
    from public.export_jobs j
   where j.status = 'queued'
   order by j.requested_at, j.seq
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  update public.export_jobs j set status = 'running' where j.id = v_id;

  return query
    select j.id, j.kind, j.organisation_id, j.requested_by, j.requested_at
      from public.export_jobs j where j.id = v_id;
end;
$$;

comment on function public.claim_export_job() is
  'Claims the oldest queued export job and moves it to `running`, or returns no row (Phase 8 Task 4). `for update skip locked` is what makes exactly one runner take a job when two tick at once -- the request''s own nudge and the pg_cron safety net. Refuses any session with a person on it (42501, hint export_runner_is_server_only). EXECUTE is granted to service_role alone. It returns no CONTENT: the id, the kind, the workspace, the requester and when they asked -- everything the runner needs and nothing about anybody''s records.';

revoke all on function public.claim_export_job() from public, anon, authenticated;
grant execute on function public.claim_export_job() to service_role;
