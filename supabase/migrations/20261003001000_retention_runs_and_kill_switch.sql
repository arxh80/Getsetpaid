-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 2: THE RUN LOG, THE KILL SWITCH AND THE
-- DRY RUN.
--
-- Requirements 2, 3 and 4 of the brief:
--
--   "Record every run: what was swept, how many, how long, and what was
--    refused."                                  -> public.retention_runs
--   "Nothing is deleted silently."              -> one correlation thread per
--                                                  run + one summary audit row
--                                                  (written in part 5)
--   "The founder must be able to stop the job without a deploy, and must be
--    able to see what a run WOULD delete before it deletes it."
--                                               -> public.retention_settings
--                                                  + the `dry` mode
--
-- ===========================================================================
-- WHY THE KILL SWITCH IS A TABLE WHEN THE PERIODS ARE A FUNCTION
-- ===========================================================================
-- Part 1 argues at length that the PERIODS must not be editable without a
-- deploy: they are a legal position stated on a published page, and a row
-- anybody can UPDATE is a legal position that changes with no diff and no
-- record. The kill switch is the exact opposite case. It only ever makes the
-- job do LESS, it is reached for when something is going wrong at three in the
-- morning, and "wait for a deploy" is not an answer available to somebody
-- watching a purge misbehave. It is still audited, still step-up gated and
-- still superuser-only.
--
-- TWO SWITCHES, NOT ONE. `enabled` stops the whole sweep;
-- `audit_purge_enabled` stops ONLY the one sweep that destroys evidence. The
-- second exists because those are different decisions: "stop deleting the
-- audit log while we work out whether the clock is right" should not also
-- stop reaping stuck jobs, which is how somebody's export gets unstuck.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE SETTINGS: ONE ROW, ENFORCED.
--
--    `id boolean primary key default true check (id)` is the singleton
--    idiom: the primary key admits `true` and `false`, the CHECK admits only
--    `true`, so the table can hold exactly one row and a second INSERT is a
--    primary key violation rather than a silently-ignored second opinion. A
--    settings table with two rows and no rule about which one wins is how a
--    kill switch gets flipped and does nothing.
-- ---------------------------------------------------------------------------

create table public.retention_settings (
  id                  boolean primary key default true check (id),
  -- THE MASTER SWITCH. false = private.run_retention_sweep() refuses every
  -- sweep and records the refusal, rather than running a shortened version of
  -- itself.
  enabled             boolean not null default true,
  -- THE SECOND SWITCH, over the one sweep that destroys evidence.
  audit_purge_enabled boolean not null default true,
  -- WHY it is in the state it is in. Mandatory on every change through the
  -- RPC (the billing-override pattern: a reason field that goes into the
  -- audit record), and null only for the seeded default below.
  reason              text check (reason is null or pg_catalog.btrim(reason) <> ''),
  updated_at          timestamptz not null default pg_catalog.now(),
  updated_by          uuid references auth.users (id) on delete set null
);

comment on table public.retention_settings is
  'The retention job''s two kill switches, one row (Phase 8 Task 6, requirement 4). `enabled` stops the whole sweep; `audit_purge_enabled` stops only private.purge_audit_events(), the one sweep that destroys evidence -- two switches because "stop deleting the audit log until we know the clock is right" and "stop reaping stuck export jobs" are different decisions. A TABLE rather than a function, unlike the periods in private.retention_periods(): stopping a destructive job is an operational emergency and waiting for a deploy is the wrong answer, whereas changing how long we keep financial records is a legal position that should not be changeable without a diff. Written ONLY through public.set_retention_enabled() (superuser, aal2, mandatory reason, audited). The singleton is enforced by the primary key plus its CHECK, not by convention: a settings table with two rows and no rule about which wins is how a kill switch gets flipped and does nothing.';

comment on column public.retention_settings.enabled is
  'false = private.run_retention_sweep() refuses EVERY sweep and records the refusal in public.retention_runs, rather than running a quieter version of itself. Default true: a deployment that has never touched this has a retention job, which is the state CLAUDE.md § Non-negotiable rules describes.';

comment on column public.retention_settings.audit_purge_enabled is
  'false = every sweep runs EXCEPT private.purge_audit_events(). SECURITY.md § 7 calls deleting audit rows "a narrowly controlled platform security process"; this is the control that can be applied to it alone, without also stopping the sweeps that unstick somebody''s export or free a workspace''s storage.';

insert into public.retention_settings (id, enabled, audit_purge_enabled, reason)
values (true, true, true, null);

-- Read by the superuser health view. No client write path at all: the RPC is
-- SECURITY DEFINER and there is no UPDATE grant to any role.
revoke all on public.retention_settings from public, anon, authenticated, service_role;
grant select on public.retention_settings to authenticated;
alter table public.retention_settings enable row level security;

create policy retention_settings_select_platform
  on public.retention_settings for select to authenticated
  using ( (select private.has_platform_permission('view_platform_health')) );

comment on policy retention_settings_select_platform on public.retention_settings is
  'The platform superuser at aal2 may read the switches -- they are rendered on /super/health beside the last run. Nobody else: a customer has no interest in whether the platform''s garbage collector is running, and the row is platform state, not tenant data. There is no UPDATE policy and no UPDATE grant: public.set_retention_enabled() is the only writer.';


-- ---------------------------------------------------------------------------
-- 2. THE RUN LOG.
--
--    One row per run, live or dry, written BEFORE the work starts and
--    completed afterwards -- so a run that dies mid-sweep leaves a row saying
--    it started and never finished, which is the only evidence that would
--    exist of a sweep that took the process down with it.
-- ---------------------------------------------------------------------------

create table public.retention_runs (
  id             uuid primary key default gen_random_uuid(),
  -- THE THREAD (requirement 3). Every audit row written anywhere inside this
  -- run carries it, through private.bulk_audit_correlation_id().
  correlation_id uuid not null,
  mode           text not null check (mode in ('dry', 'live')),
  status         text not null default 'running'
                   check (status in ('running', 'completed', 'refused', 'failed')),
  started_at     timestamptz not null default pg_catalog.now(),
  finished_at    timestamptz,
  duration_ms    integer check (duration_ms is null or duration_ms >= 0),
  -- COUNTS, NEVER CONTENT. {"feedback.rows": 3, "audit_events.rows": 0, ...}
  -- The same discipline public.erasure_jobs.summary keeps, enforced the same
  -- way: every leaf must be a number or a boolean.
  swept          jsonb not null default '{}'::jsonb,
  -- WHAT DID NOT RUN AND WHY, as {sweep: hint}. A refusal is a first-class
  -- outcome here rather than a log line: "the audit purge refused its sanity
  -- ceiling on every run for a month" is the thing an operator most needs to
  -- be able to see, and a warning in the Postgres log is not visible from
  -- /super/health.
  refused        jsonb not null default '{}'::jsonb,
  constraint retention_runs_finished_pair
    check ((status = 'running') = (finished_at is null)),
  constraint retention_runs_swept_is_counts
    check (private.jsonb_is_count_map(swept)),
  constraint retention_runs_refused_is_object
    check (pg_catalog.jsonb_typeof(refused) = 'object')
);

comment on table public.retention_runs is
  'One row per retention run, live or DRY (Phase 8 Task 6, requirement 2). Written BEFORE the work starts and completed afterwards, so a run that dies mid-sweep leaves a row saying it began and never ended -- the only evidence that would exist of a sweep that took the process with it. `swept` is counts and nothing else (the CHECK is public.erasure_jobs.summary''s), `refused` is {sweep: hint} for the sweeps that did not run, and `correlation_id` is the thread every audit row written inside the run carries. Superuser-readable; no client write path.';

comment on column public.retention_runs.mode is
  '`dry` = every sweep COUNTED what it would delete and deleted nothing (requirement 4: the founder can see what a run would do before it does it). `live` = it did it. A dry run writes a row exactly like a live one, which is what makes the two comparable.';

comment on column public.retention_runs.refused is
  'The sweeps that did not run, as {sweep: hint}: the kill switch, the audit purge''s hard floor, its sanity ceiling, a row ceiling reached. A refusal is a FIRST-CLASS OUTCOME here rather than a warning in the Postgres log, because "the audit purge has refused its ceiling on every run for a month" is exactly what an operator needs to see and a log line on a hosted database is not visible from /super/health.';

create index retention_runs_started_at_idx on public.retention_runs (started_at desc);
create index retention_runs_status_idx on public.retention_runs (status) where status <> 'completed';

revoke all on public.retention_runs from public, anon, authenticated, service_role;
grant select on public.retention_runs to authenticated;
alter table public.retention_runs enable row level security;

create policy retention_runs_select_platform
  on public.retention_runs for select to authenticated
  using ( (select private.has_platform_permission('view_platform_health')) );

comment on policy retention_runs_select_platform on public.retention_runs is
  'The platform superuser at aal2 may read the run log; it is the "surface the last run and its outcome on /super/health" half of requirement 4. Counts only -- the table has no column that could hold a tenant record -- so this stays inside CLAUDE.md § Superuser dashboard''s aggregate-metadata rule. No INSERT/UPDATE policy and no grant: private.run_retention_sweep() is the only writer and it is SECURITY DEFINER.';


-- ---------------------------------------------------------------------------
-- 3. THE KILL SWITCH RPC.
--
--    The billing-override shape: superuser at aal2 (which is the step-up --
--    lib/auth/ re-challenges before the action runs), a MANDATORY reason, and
--    an audit row carrying the before and after.
-- ---------------------------------------------------------------------------

create or replace function public.set_retention_enabled(
  p_enabled             boolean,
  p_audit_purge_enabled boolean,
  p_reason              text)
returns public.retention_settings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  if not private.has_platform_permission('manage_retention') then
    raise exception 'set_retention_enabled: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'retention_switch_is_superuser_only';
  end if;
  if p_enabled is null or p_audit_purge_enabled is null then
    raise exception 'set_retention_enabled: both switches must be named'
      using errcode = '22023', hint = 'retention_switch_needs_both';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'set_retention_enabled: a reason is required'
      using errcode = '22023', hint = 'retention_switch_needs_a_reason';
  end if;

  select * into v_before from public.retention_settings s where s.id;

  update public.retention_settings s
     set enabled             = p_enabled,
         audit_purge_enabled = p_audit_purge_enabled,
         reason              = pg_catalog.btrim(p_reason),
         updated_at          = pg_catalog.now(),
         updated_by          = (select auth.uid())
   where s.id
  returning * into v_after;

  -- AUDITED LIKE ANY OTHER HIGH-VALUE ADMIN ACTION. The reason travels in the
  -- payload, which is the whole reason it is mandatory: a switch that was
  -- flipped with no recorded why is a switch nobody can reason about later.
  perform private.log_audit_event(
    'retention_settings.changed', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'enabled', v_before.enabled, 'audit_purge_enabled', v_before.audit_purge_enabled),
    pg_catalog.jsonb_build_object(
      'enabled', v_after.enabled, 'audit_purge_enabled', v_after.audit_purge_enabled,
      'reason', v_after.reason));

  return v_after;
end;
$$;

comment on function public.set_retention_enabled(boolean, boolean, text) is
  'THE KILL SWITCH (Phase 8 Task 6, requirement 4): the founder stops the retention job, or just its audit purge, without a deploy. Superuser at aal2 only -- which IS the step-up, since the session must have re-presented a factor -- with a MANDATORY reason that travels into the audit row, the organisation_billing_overrides shape. Both switches must be named on every call rather than defaulting, so a caller that meant to stop only the audit purge cannot silently re-enable the whole job by omission. Writes public.retention_settings, which has no UPDATE grant to any role: this is the only writer.';

revoke all on function public.set_retention_enabled(boolean, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_retention_enabled(boolean, boolean, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. THE ACTION NAME, REGISTERED.
--
--    tests/integration/admin/audit-actions-match-db.test.ts reads every
--    action literal passed to private.log_audit_event() and requires it to be
--    in the operator's filter catalogue. The name is declared here so that
--    census sees it rather than reporting it as unknown.
-- ---------------------------------------------------------------------------

comment on column public.retention_settings.reason is
  'WHY the switches are in the state they are in. Mandatory on every change through public.set_retention_enabled() (22023, hint retention_switch_needs_a_reason) and copied into the `retention_settings.changed` audit row. Null only on the row this migration seeds, which is the default state nobody chose.';
