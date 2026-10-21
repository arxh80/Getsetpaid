-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 8: THE READ-AS-THE-REQUESTER MECHANISM,
-- CORRECTED. 20260927002000's VERSION COULD NOT RUN AT ALL.
--
-- ===========================================================================
-- WHAT WAS WRONG, MEASURED
-- ===========================================================================
-- private.export_read_page_as_requester() carried a function-level
-- `set role = authenticated`, on the reasoning that a function-level SET is
-- restored on exit where a set_config() in the body is not. It is -- but
-- Postgres refuses to apply it at all when the caller is a SECURITY DEFINER
-- function, which public.export_read_page() is:
--
--     ERROR:  cannot set parameter "role" within security-definer function
--
-- Measured on the live catalogue, from the psql suite's § XP, which is the
-- only reason it was found: every assertion about what an export CONTAINS
-- answered `denied(42501)`, including the ones asserting that a colleague's
-- private note is ABSENT. An "absent" that is really "the engine cannot run"
-- is the invisible denominator this phase keeps shipping, and it is why § XP
-- asserts the POSITIVE first -- XP2 (the Owner's own private note IS there)
-- went red in the same run.
--
-- ===========================================================================
-- THE FIX: A ROLE THAT IS SUBJECT TO RLS, NOT A ROLE SWITCH
-- ===========================================================================
-- The requirement was never "SET ROLE"; it was "make the read be decided by
-- the same policies the requester's browser meets". Three things make that
-- true of a SECURITY DEFINER function, and none of them needs SET ROLE:
--
--   1. its owner must NOT own the tables (or RLS is skipped for the owner);
--   2. its owner must NOT have BYPASSRLS (which `postgres` and
--      `service_role` both effectively do here);
--   3. its owner must be a MEMBER of `authenticated`, because every policy
--      in this schema is written `to authenticated`, and a policy applies to
--      any role that pg_has_role(..., 'MEMBER') of the named one.
--
-- So: a new role, `export_reader` -- NOLOGIN, INHERIT, no attributes, owning
-- exactly one function and nothing else. Inside that function current_user is
-- `export_reader`, RLS is enforced, and auth.uid() answers from the claims
-- the caller installed. The policies decide, exactly as before; only the
-- mechanism by which they are reached has changed.
--
-- WHAT `export_reader` CAN DO, stated rather than implied: everything
-- `authenticated` can, through inheritance -- which is the point, and which
-- is bounded by the fact that NOTHING CAN LOG IN AS IT and nothing can
-- execute the one function it owns. `revoke all ... from public` on that
-- function is re-issued below, so its only caller is public.export_read_page(),
-- which is itself granted to service_role alone and refuses any session with
-- a person on it.
--
-- WHY THE SQL IS PASSED IN RATHER THAN BUILT INSIDE. The inner function used
-- to call private.export_page_sql(), which would have meant granting
-- `export_reader` USAGE on the `private` schema -- a widening with no other
-- purpose. The outer definer (postgres) builds the statement from
-- private.export_catalogue() and hands it over, so export_reader needs
-- nothing from `private` at all. The text is not a caller's: every identifier
-- in it came from the catalogue and was quoted with format()'s %I, and the
-- function is unreachable from any session.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE ROLE.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'export_reader') then
    create role export_reader nologin inherit;
  end if;
end
$$;

comment on role export_reader is
  'Owns exactly one function: private.export_read_page_as_requester() (Phase 8 Task 4). NOLOGIN, INHERIT, no attributes, and a MEMBER of `authenticated` -- which is what makes every `to authenticated` row policy in this schema apply inside that function, so an export reads exactly what the requester''s own browser would. It owns no table, so RLS is never skipped for it, and it has no BYPASSRLS. Nothing can log in as it and nothing can execute the function it owns but public.export_read_page(), which is granted to service_role alone.';

grant authenticated to export_reader;

-- AND `postgres` MUST BE A MEMBER OF IT, or `alter function ... owner to`
-- below is refused: on Supabase the migration role is `postgres`, which is
-- NOT a superuser (that is `supabase_admin`), and a non-superuser may only
-- give away ownership to a role it belongs to. Membership grants postgres
-- nothing it did not already have -- export_reader is attributeless and owns
-- one function.
grant export_reader to postgres;


-- ---------------------------------------------------------------------------
-- 2. THE INNER READ, REBUILT FROM ITS LATEST DEFINITION (20260927002000 § 3).
--    No `set role`; the OWNER is the mechanism now. It takes the statement
--    rather than building it.
-- ---------------------------------------------------------------------------

drop function if exists private.export_read_page_as_requester(text, text[], text[], text, uuid, text, integer);

create or replace function private.export_read_page_as_requester(
  p_sql     text,
  p_subject uuid,
  p_after   text,
  p_limit   integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  execute p_sql into v_rows using p_subject, coalesce(p_after, ''), p_limit;
  return v_rows;
end;
$$;

-- OWNERSHIP IS GIVEN AND THE DOOR IS CLOSED BEHIND IT. `alter function ...
-- owner to` requires the NEW owner to hold CREATE on the function's schema,
-- so CREATE is granted for exactly that statement and revoked immediately;
-- ownership survives, and export_reader is left with no reach into `private`
-- at all. USAGE is not needed either: schema usage is checked against the
-- CALLER (postgres, through the outer definer), never against the owner, and
-- the inner function's own search_path is empty with every name qualified.
grant usage, create on schema private to export_reader;
alter function private.export_read_page_as_requester(text, uuid, text, integer)
  owner to export_reader;
revoke create, usage on schema private from export_reader;

comment on function private.export_read_page_as_requester(text, uuid, text, integer) is
  'One page of one table, read AS THE REQUESTER. SECURITY DEFINER owned by `export_reader`, which is a member of `authenticated`, owns no table and has no BYPASSRLS -- so every row policy in the schema decides here exactly as it would in that person''s browser, including notes_select_by_visibility, which is what makes "an Owner''s workspace export contains no other member''s private note" true by construction rather than by a rule this file restates. The caller installs the requester''s claims in request.jwt.claims first; auth.uid() and private.session_is_aal2() read them here. The statement is built by the caller from private.export_catalogue() (every identifier %I-quoted, every value a bind parameter) so that export_reader needs no reach into the `private` schema. Granted to no role: the only caller is public.export_read_page(). Replaces the 20260927002000 version, whose function-level `set role = authenticated` Postgres refuses to apply inside a SECURITY DEFINER caller -- measured, and caught by § XP''s positive control rather than by its security assertions.';

-- NO CLIENT ROLE, AND ONE CALLER. Revoking from `public` removes the default
-- grant every function is created with; the single explicit grant is to
-- `postgres`, which is what public.export_read_page() runs as. Without it the
-- outer definer cannot call the inner one at all -- measured, and the reason
-- this line is explicit rather than implied by ownership.
revoke all on function private.export_read_page_as_requester(text, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.export_read_page_as_requester(text, uuid, text, integer)
  to postgres;


-- ---------------------------------------------------------------------------
-- 3. THE ENTRY POINT, REBUILT FROM ITS LATEST DEFINITION (20260927002000 § 4).
--    One change: it builds the statement and passes it down.
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
      v_sql, v_subject, coalesce(p_after, ''), v_limit);
  exception when others then
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
    raise;
  end;

  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return v_rows;
end;
$$;

comment on function public.export_read_page(uuid, text, text, integer) is
  'ONE PAGE OF ONE TABLE for a running export job (Phase 8 Task 4; rebuilt in 20260927007000 with the corrected read-as-the-requester mechanism). Refuses any session with a person on it (42501, hint export_reads_are_server_only -- its own hint, so a missing EXECUTE grant''s 42501 is distinguishable); refuses a job that is not running and a table private.export_catalogue() does not export for that job''s kind; and caps the page at private.export_limits().page_size. A requester_rls table is read through private.export_read_page_as_requester(), owned by `export_reader` -- a member of `authenticated` that owns no table and has no BYPASSRLS -- with the requester''s claims taken from the JOB ROW and never from the caller, so the shipped RLS policies decide. An elevated table (four, all in the account export, each with no client read at all) is read as the definer, filtered to the catalogue''s scope columns and projected to the catalogue''s columns, and is refused outright for a workspace export. EXECUTE is granted to service_role alone.';

revoke all on function public.export_read_page(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.export_read_page(uuid, text, text, integer) to service_role;
