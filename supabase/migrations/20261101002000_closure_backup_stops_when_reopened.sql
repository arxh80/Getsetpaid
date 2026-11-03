-- ===========================================================================
-- Q228 FINAL REVIEW I1 (Q242) -- A CLOSURE BACKUP STOPS WHEN ITS WORKSPACE IS
-- REOPENED, OR WHEN THE PERSON WHO CLOSED IT IS NO LONGER ONE OF ITS OWNERS.
--
-- Before Q228 a closure backup was one claim, a few seconds long. Since Q228
-- it is built one part per claim, and the runner does at most three claims a
-- run, so a large backup takes hours. Nothing re-checked the workspace between
-- claims. Two consequences, found by the final review:
--   * reassign_closed_workspace() / reinstate_organisation() reopen the
--     workspace (deleted_at = null). The parts built after that read a LIVE
--     workspace, so the backup mixes moments;
--   * if the closer then lost the Owner role, every later page came back
--     filtered to nothing under their RLS, with no error, and the job would be
--     stamped succeeded with an index that says "Together they are the whole
--     backup".
--
-- The fix is in the one place every part's reads pass through:
-- public.export_read_page(). For a closure_backup job it now refuses unless
-- the workspace is still closed ('owner_closed', or 'deleted' after the
-- superuser's delete) and the requester is still an active Owner of it. The
-- runner fails the job on the refusal and removes every part it had stored
-- (lib/export/runner.ts), so no partial backup is ever presented as a backup.
-- Founder question Q242 records the alternative (keep building).
--
-- Rebuilt from its LATEST definition (20261025000000:156, identical to the
-- live pg_get_functiondef at 249 migrations) with only the marked hunk added,
-- after the tombstone belt so that refusal keeps its own hint (ck KT1).
-- CREATE OR REPLACE keeps the grants and the comment.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

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

  -- 20261101002000 (Q228 final review I1, Q242): A CLOSURE BACKUP STOPS
  -- WHEN ITS WORKSPACE IS REOPENED, OR ITS CLOSER IS NO LONGER AN OWNER.
  -- Since Q228 a closure backup is built one part per claim, so a large one
  -- takes hours, and the superuser may decide the workspace in the meantime.
  -- Parts built after public.reassign_closed_workspace() (or
  -- public.reinstate_organisation()) would read a LIVE workspace that its
  -- members are editing, and the backup would no longer describe one state.
  -- If the closer then lost their Owner role, every later read would come
  -- back filtered to nothing, with no error, and the job would still be
  -- stamped succeeded. Both are refused here, on every page, so the runner
  -- fails the job by name and removes the parts it had stored. 'deleted' is
  -- still closed: the superuser's delete keeps the backup owed (Q229).
  if v_job.closure_backup then
    if not exists (select 1 from public.organisations o
                    where o.id = v_job.organisation_id
                      and o.lifecycle_state in ('owner_closed', 'deleted')) then
      raise exception 'export_read_page: the workspace of closure backup % was reopened while the backup was being built', v_job.id
        using errcode = '55000', hint = 'closure_backup_workspace_reopened';
    end if;
    if not exists (select 1 from public.organisation_memberships m
                    where m.organisation_id = v_job.organisation_id
                      and m.user_id = v_job.requested_by
                      and m.status = 'active'
                      and m.role = 'owner') then
      raise exception 'export_read_page: the person who closed the workspace of closure backup % is no longer one of its Owners', v_job.id
        using errcode = '55000', hint = 'closure_backup_requester_not_owner';
    end if;
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
