-- ===========================================================================
-- PHASE 8 TASK 4, FIX ROUND 1 -- THE READ PUTS BACK EVERY CLAIM IT TOUCHED.
--
-- Task 4 review, finding M7.
--
-- public.export_read_page() installs the requester's claims for the duration
-- of one page read and puts them back afterwards, so a read cannot leave that
-- person's identity on the transaction. It saved and restored
-- `request.jwt.claims` -- and BLANKED `request.jwt.claim.sub` and
-- `request.jwt.claim.role`, the two GoTrue-legacy per-claim GUCs, without
-- ever restoring them.
--
-- There is no live consequence: nothing in this schema reads those two
-- (auth.uid() reads request.jwt.claims), and the only caller is a sessionless
-- runner. What is wrong is that section XP13 asserts only that
-- `request.jwt.claims` does not outlive the read, so the two GUCs that were
-- NOT restored are precisely the two nothing measured -- the invisible
-- denominator this phase keeps meeting. Both halves are fixed together: all
-- three are saved and all three are restored, on the success path and in the
-- exception handler alike, and XP13a/XP13b now measure the other two.
--
-- Rebuilt from its LATEST definition (20260927007000 section 3) with that one
-- change. The refusal, the job lookup, the catalogue lookup, the subject
-- derivation, the page cap, the elevated branch and the requester_rls branch
-- are verbatim.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


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

  begin
    v_rows := private.export_read_page_as_requester(
      v_sql, v_subject, coalesce(p_after, ''), v_limit);
  exception when others then
    perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
    perform pg_catalog.set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
    raise;
  end;

  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform pg_catalog.set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
  return v_rows;
end;
$$;

comment on function public.export_read_page(uuid, text, text, integer) is
  'ONE PAGE OF ONE TABLE for a running export job (Phase 8 Task 4; rebuilt in 20260927007000 with the corrected read-as-the-requester mechanism). Refuses any session with a person on it (42501, hint export_reads_are_server_only -- its own hint, so a missing EXECUTE grant''s 42501 is distinguishable); refuses a job that is not running and a table private.export_catalogue() does not export for that job''s kind; and caps the page at private.export_limits().page_size. A requester_rls table is read through private.export_read_page_as_requester(), owned by `export_reader` -- a member of `authenticated` that owns no table and has no BYPASSRLS -- with the requester''s claims taken from the JOB ROW and never from the caller, so the shipped RLS policies decide. An elevated table (four, all in the account export, each with no client read at all) is read as the definer, filtered to the catalogue''s scope columns and projected to the catalogue''s columns, and is refused outright for a workspace export. ALL THREE claim GUCs it touches -- request.jwt.claims and the two GoTrue-legacy per-claim ones -- are saved before the read and restored after it, on the success path and in the exception handler alike (20260928002000; the first cut restored only the first, so the two that were not restored were the two no assertion measured). EXECUTE is granted to service_role alone.';

revoke all on function public.export_read_page(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.export_read_page(uuid, text, text, integer) to service_role;
