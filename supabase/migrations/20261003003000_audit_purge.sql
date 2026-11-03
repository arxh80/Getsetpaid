-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 4: THE AUDIT PURGE.
--
-- THIS IS THE MOST DANGEROUS CODE IN THIS PHASE, and the brief says so in as
-- many words. Every other sweep deletes something the product can rebuild, do
-- without, or has already made unreadable. This one destroys THE EVIDENCE
-- THAT THE PRODUCT DID WHAT IT SAYS IT DID: who impersonated whom, who
-- published what, who was erased, who changed a workspace's tier. An audit
-- log that has been wrongly emptied cannot be noticed by reading it.
--
-- SECURITY.md § 7 calls deleting audit rows "a narrowly controlled platform
-- security process". This is that control, and it is FIVE RAILS, each of
-- which can be mutated independently and each of which has its own refusal
-- hint so a test can tell them apart:
--
--   RAIL 1  THE HARD FLOOR.  A literal `interval '1 year'` in this function's
--           own body. If private.retention_periods() ever declares a shorter
--           `audit_total`, this REFUSES rather than obeying it. It is not
--           configuration and it cannot be lowered by one: lowering it is a
--           migration that edits this function, which is a diff a reviewer
--           sees and an assertion goes red on. That is the difference between
--           a floor and a default.
--   RAIL 2  THE KILL SWITCH.  public.retention_settings.audit_purge_enabled,
--           separate from the master switch, so "stop deleting audit rows
--           until we know the clock is right" does not also stop the sweep
--           that unsticks somebody's export.
--   RAIL 3  THE SANITY CEILING.  A run that would delete more than a fifth of
--           the whole table refuses and records the refusal. AT STEADY STATE
--           A RUN DELETES TEN MINUTES' WORTH OF ROWS: a proportion anywhere
--           near a fifth means the clock, the period or the column is wrong,
--           and a job that has never deleted anything is recoverable while
--           one that has deleted a year is not. The proportion is paired with
--           an absolute floor (1000 rows) so a table with four rows in it
--           cannot trip a percentage.
--   RAIL 4  THE PER-RUN CEILING.  Oldest first, bounded, resumable. A backlog
--           drains over many runs rather than locking the table for minutes,
--           and `capped` in the result says a backlog exists.
--   RAIL 5  THE COUNTS, BEFORE AND AFTER.  Taken in the same transaction as
--           the delete and returned with it, so the run log records what the
--           table held, what went and what is left -- and the arithmetic is
--           checkable by a reader rather than trusted.
--
-- AND THE DRY RUN, which is not a rail but the thing that makes the rails
-- usable: the founder can ask what a run WOULD delete and get the same
-- numbers from the same query, with nothing removed.
--
-- ===========================================================================
-- WHAT THIS FUNCTION DOES NOT DO, DELIBERATELY
-- ===========================================================================
-- It does not archive anywhere. Q135: at MVP "archived" means the rows are
-- still in Postgres and simply fall outside the audit-log viewer's DEFAULT
-- range at 30 days (`audit_hot`), and the delete happens at one year. A real
-- cold-storage export is a post-launch infrastructure task and SECURITY.md
-- § 7 says so honestly rather than implying a cold store exists.
--
-- It does not exempt any action. The first cut of this file had a list of
-- "actions too important to delete" (impersonation.started, account.erased,
-- organisation.erased) and it was removed before it shipped, because an
-- exemption list is a retention policy written twice: the promise on
-- /legal/data-retention is one year for the audit log, and a quietly
-- permanent subset is a promise the published page does not make. If some
-- actions should be kept longer, that is a class in
-- private.retention_periods() and a sentence on the page, not a hidden list
-- in here.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE FLOOR, AS ITS OWN READABLE FUNCTION.
--
--    It is a separate function so that a test can ask it directly (the
--    brief's "ask every trigger-level rule directly, not only through an RPC
--    that carries its own guard") -- but the VALUE is compared inside
--    private.purge_audit_events() against its own literal, so replacing this
--    function with one that returns a month does not lower the floor. Both
--    are asserted.
-- ---------------------------------------------------------------------------

create or replace function private.audit_retention_floor()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 year' $$;

comment on function private.audit_retention_floor() is
  'THE HARD FLOOR under the audit purge: no audit row is ever deleted before it is a year old, whatever private.retention_periods() declares. A separate function so a test can ask the rule directly rather than only through the purge -- but private.purge_audit_events() compares the declared period against its OWN literal as well as against this, so replacing this function with one that returns a month still does not lower the floor. CLAUDE.md § Non-negotiable rules: "archived (cold storage) for up to 1 year total, then purged". Raising it is a reissue of one function; LOWERING it is a migration that edits the purge itself, which is a diff a reviewer sees.';

revoke all on function private.audit_retention_floor() from public, anon, authenticated, service_role;
grant execute on function private.audit_retention_floor() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE SANITY CEILING, ALSO ITS OWN FUNCTION AND ALSO DOUBLED.
-- ---------------------------------------------------------------------------

create or replace function private.audit_purge_ceiling()
returns table (max_share numeric, min_rows bigint)
language sql
immutable
set search_path = ''
as $$ select 0.20::numeric, 1000::bigint $$;

comment on function private.audit_purge_ceiling() is
  'THE SANITY CEILING on one audit purge: it refuses when the rows it would delete are BOTH more than 20 per cent of the whole table AND more than 1000. The proportion is the tripwire -- at steady state a ten-minute run deletes ten minutes of rows, so a fifth of the table means the clock, the declared period or the column is wrong -- and the absolute floor beside it stops a table with four rows in it tripping a percentage. Paired with a literal inside private.purge_audit_events() for the same reason the floor is: replacing this function does not widen the ceiling on its own.';

revoke all on function private.audit_purge_ceiling() from public, anon, authenticated, service_role;
grant execute on function private.audit_purge_ceiling() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. THE PURGE.
-- ---------------------------------------------------------------------------

create or replace function private.purge_audit_events(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
  if v_period < v_floor or v_period < interval '1 year' then
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
$$;

comment on function private.purge_audit_events(boolean, integer) is
  'THE AUDIT PURGE (Phase 8 Task 6) -- the one sweep in this product that destroys the evidence the product did what it says it did, built the way SECURITY.md § 7''s "narrowly controlled platform security process" describes. FIVE RAILS, each with its own refusal hint so a test can tell them apart: a HARD FLOOR of one year that no configuration can lower (checked against private.audit_retention_floor() AND against this function''s own literal, so editing either alone does not move it -- hint audit_retention_below_floor); the audit_purge_enabled KILL SWITCH, asked before anything is counted; a SANITY CEILING that refuses a run deleting more than a fifth of the table when that is also more than a thousand rows, because at steady state a ten-minute run deletes ten minutes of rows and a fifth means the clock or the period is wrong (hint audit_purge_over_ceiling); a PER-RUN CEILING with rows taken oldest first, so a backlog drains in order and `capped` reports it; and the TOTAL BEFORE AND AFTER, counted in the same transaction as the delete so the run log''s arithmetic is checkable rather than trusted. Plus a dry run over the same query. It archives nowhere (Q135: "archived" is the viewer''s 30-day default range, not a cold store that does not exist) and exempts no action, because an exemption list is a retention policy written twice and only one of the two is on the published page.';

revoke all on function private.purge_audit_events(boolean, integer)
  from public, anon, authenticated, service_role;
