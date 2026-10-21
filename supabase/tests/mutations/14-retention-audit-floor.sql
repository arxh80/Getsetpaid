-- PHASE 8 TASK 8 MUTANT 14-retention-audit-floor
-- guard:  private.purge_audit_events
-- change: the one-year hard floor is not checked
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.purge_audit_events(p_dry boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_period    interval;
  v_floor     interval;
  v_cut       timestamptz;
  v_before    bigint;
  v_after     bigint;
  v_candidates bigint;
  v_n         bigint;
  v_share     numeric;
  v_min_rows  bigint;
  v_enabled   boolean;
begin
  -- (0) NEVER UNDER `replica`. The house control, and here for the reason
  -- private.erase_organisation() carries it: `replica` is the standard advice
  -- for making a large delete fast, this is the largest delete in the
  -- product, and a delete that does not fire its triggers is a delete nobody
  -- can reason about afterwards.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'purge_audit_events: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- RAIL 2 -- THE KILL SWITCH, asked before anything is counted.
  select s.audit_purge_enabled into v_enabled from public.retention_settings s where s.id;
  if v_enabled is distinct from true then
    return pg_catalog.jsonb_build_object('audit_events.refused', true,
                                         'audit_events.refused_because', 'audit_purge_disabled');
  end if;

  v_period := private.retention_period('audit_total');
  v_floor  := private.audit_retention_floor();

  -- RAIL 1 -- THE HARD FLOOR, compared against BOTH the function and this
  -- function's own literal. Two comparisons rather than one because a single
  -- one would be lowered by editing private.audit_retention_floor() alone,
  -- which is a one-line migration that does not look like what it is.
  if false then
    raise exception 'purge_audit_events: the declared audit retention period (%) is below the hard floor (%)',
      v_period, greatest(v_floor, interval '1 year')
      using errcode = '55000', hint = 'audit_retention_below_floor';
  end if;

  v_cut := pg_catalog.now() - v_period;

  -- RAIL 5 -- THE COUNT BEFORE. In the same transaction as the delete, so
  -- the arithmetic in the run log is a fact about one moment and not two.
  select pg_catalog.count(*) into v_before from public.audit_events;
  select pg_catalog.count(*) into v_candidates
    from public.audit_events a where a.created_at < v_cut;

  -- RAIL 3 -- THE SANITY CEILING.
  select c.max_share, c.min_rows into v_share, v_min_rows
    from private.audit_purge_ceiling() c;
  if v_candidates > v_min_rows and v_candidates > 1000
     and v_before > 0
     and (v_candidates::numeric / v_before::numeric) > least(v_share, 0.20) then
    raise exception 'purge_audit_events: % of % audit rows -- % per cent -- is past the sanity ceiling',
      v_candidates, v_before,
      pg_catalog.round(100.0 * v_candidates::numeric / v_before::numeric, 1)
      using errcode = '55000', hint = 'audit_purge_over_ceiling';
  end if;

  if p_dry then
    -- The same query the delete uses, bounded the same way. A dry run that
    -- reports a different number from the live run that follows it is a bug,
    -- not a rounding difference.
    select pg_catalog.count(*) into v_n
      from (select 1 from public.audit_events a
             where a.created_at < v_cut
             order by a.created_at
             limit p_limit) t;
    v_after := v_before;
  else
    -- RAIL 4 -- BOUNDED AND RESUMABLE. Oldest first: a backlog drains in
    -- order, and a run that hits the ceiling leaves the NEWER remainder
    -- rather than skipping an arbitrary slice for ever.
    with doomed as (
      select a.id from public.audit_events a
       where a.created_at < v_cut
       order by a.created_at
       limit p_limit)
    delete from public.audit_events a using doomed d where a.id = d.id;
    get diagnostics v_n = row_count;
    select pg_catalog.count(*) into v_after from public.audit_events;
  end if;

  return pg_catalog.jsonb_build_object(
    'audit_events.rows',          v_n,
    'audit_events.capped',        v_n >= p_limit,
    'audit_events.total_before',  v_before,
    'audit_events.total_after',   v_after,
    'audit_events.candidates',    v_candidates);
end;
$function$;
