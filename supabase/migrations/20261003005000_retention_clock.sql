-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 6: THE FIFTH HALF OF THE ONE TICK.
--
-- Task 4's clock migration and Task 5's, for a fifth half of the same tick.
-- There is still EXACTLY ONE scheduler and ONE job -- `incident-alert-delivery`
-- every 10 minutes -- whose command string three suites pin verbatim and
-- which is NOT touched here. `cron.schedule()` is not called at all by this
-- migration: there is nothing to re-point, because the job already runs
-- private.run_incident_alert_tick() and this adds a subtransaction to it.
--
-- THE JOB'S NAME NOW DESCRIBES ONE OF FIVE THINGS. It is kept anyway, for the
-- reason 20260927004000 first wrote down: renaming it would break the suites
-- that pin the command string, which is a worse trade than a name with a
-- comment on it.
--
-- ===========================================================================
-- WHY A RETENTION SWEEP IS THE ONE HALF THAT SHOULD NOT RUN EVERY TICK
-- ===========================================================================
-- The other four halves are latency-sensitive: a queued erasure, a queued
-- export, a deadline alert and an undelivered digest all get WORSE the longer
-- they wait. A retention sweep does not. Nothing is owed to anybody by three
-- in the afternoon rather than three in the morning, the periods are measured
-- in years, and the sweep is the most expensive of the five -- it counts two
-- whole tables and may delete from eight.
--
-- So this half is THROTTLED IN THE DATABASE rather than scheduled separately:
-- it returns immediately unless the last run began more than an hour ago.
-- A SECOND CRON ENTRY WOULD HAVE BEEN THE OBVIOUS ANSWER AND IT IS THE WRONG
-- ONE -- the product has one scheduler on purpose, and "there is only one
-- clock" is a property worth more than a cheaper predicate.
--
-- The throttle reads public.retention_runs, which is the same row the run
-- writes, so it needs no state of its own and cannot get out of step with
-- what actually happened.
--
-- LOCAL DEV IS A REAL NO-OP: with no Vault entries the function returns
-- before it builds a request, exactly as the other three posters do.
--
-- private.run_incident_alert_tick() is rebuilt from its LATEST definition
-- (20260924001000 as amended by 20260925002000, 20260927004000 and
-- 20260930006000). The only change is the new subtransaction.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. HOW OFTEN. One declared place, like every other period in this task.
-- ---------------------------------------------------------------------------

create or replace function private.retention_sweep_interval()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 hour' $$;

comment on function private.retention_sweep_interval() is
  'How often the retention sweep actually runs, inside the ten-minute tick that carries it: at most once an hour. It is a THROTTLE and not a schedule, because the product has exactly one pg_cron job and a second one would buy a cheaper predicate at the cost of the only property that makes the clock reasonable about -- there is one. The other four halves of the tick are latency-sensitive (a queued erasure, a queued export, a deadline alert, an undelivered digest all get worse the longer they wait); a retention sweep is not, its periods are measured in years, and it is the most expensive of the five.';

revoke all on function private.retention_sweep_interval() from public, anon, authenticated, service_role;
grant execute on function private.retention_sweep_interval() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE POST. Its own Vault names -- a fourth pair, a fourth route, a fourth
--    secret, for the reason the erasure runner's header gives: leaking one
--    must not hand over the others, and this is the one that DELETES THE
--    AUDIT LOG.
--
--    Created ONCE PER ENVIRONMENT, by hand, never by this repository:
--
--      select vault.create_secret(
--        'https://app.example.com/api/retention/run',
--        'retention_runner_url',
--        'Where private.deliver_retention_sweep() POSTs (Phase 8 Task 6).');
--      select vault.create_secret(
--        '<the same value as RETENTION_RUNNER_SECRET>',
--        'retention_runner_secret',
--        'Bearer presented to /api/retention/run.');
--
--    SECURITY.md § 15 carries this beside the other three pairs.
-- ---------------------------------------------------------------------------

create or replace function private.deliver_retention_sweep()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_last   timestamptz;
begin
  -- THE THROTTLE. Reads the run log itself, so there is no second piece of
  -- state to get out of step with what happened.
  select pg_catalog.max(r.started_at) into v_last from public.retention_runs r;
  if v_last is not null and v_last > pg_catalog.now() - private.retention_sweep_interval() then
    return;
  end if;

  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'retention_runner_url';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'retention_runner_secret';

  -- UNCONFIGURED = NO-OP, the digest's rule. The length test mirrors the
  -- route's own `>= 32`, so a secret too short to be accepted there is never
  -- presented from here.
  if v_url is null or pg_catalog.btrim(v_url) = ''
     or v_secret is null or pg_catalog.length(pg_catalog.btrim(v_secret)) < 32 then
    return;
  end if;

  perform net.http_post(
    url                  := pg_catalog.btrim(v_url),
    body                 := '{}'::jsonb,
    headers              := pg_catalog.jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || pg_catalog.btrim(v_secret)),
    timeout_milliseconds := 15000
  );
end;
$$;

comment on function private.deliver_retention_sweep() is
  'Wakes the retention runner over HTTP, from the one pg_cron tick (Phase 8 Task 6). THROTTLED rather than scheduled: it returns immediately unless the last run in public.retention_runs began more than private.retention_sweep_interval() ago, so the sweep runs about hourly inside a ten-minute tick without a second cron entry. Returns without building a request when its two Vault secrets are absent or the secret is shorter than the route will accept -- so an unconfigured deployment (every local one) has a clock that ticks and posts nothing rather than a faked send. Fire and forget: the response is not read, because the next tick already does the only thing a failure would call for. Its own URL and secret, separate from the digest''s, the export runner''s and the erasure runner''s: this is the one that DELETES THE AUDIT LOG.';

revoke all on function private.deliver_retention_sweep() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE TICK, REBUILT FROM ITS LATEST DEFINITION. One more subtransaction.
--
--    IT GOES LAST, AND THAT IS THE ONLY ORDERING DECISION HERE. The four
--    existing halves are unchanged and in their existing order. The retention
--    sweep is the least urgent and the most expensive, and putting it after
--    the digest means a sweep that throws cannot delay an email that was
--    already ready to go -- which the subtransaction alone would not fully
--    achieve, since a slow sweep delays whatever follows it.
-- ---------------------------------------------------------------------------

create or replace function private.run_incident_alert_tick()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  -- HALF MINUS ONE (Phase 8 Task 5), in its own subtransaction.
  begin
    perform private.deliver_erasure_jobs();
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    raise warning 'run_incident_alert_tick: the erasure runner could not be woken (%)', v_state;
  end;

  -- HALF ZERO (Phase 8 Task 4), in its own subtransaction.
  begin
    perform private.deliver_export_jobs();
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    raise warning 'run_incident_alert_tick: the export runner could not be woken (%)', v_state;
  end;

  -- HALF ONE, in its own subtransaction: whatever it throws is rolled back to
  -- here and cannot take the digest with it.
  begin
    perform private.raise_dsr_deadline_alerts();

    -- It ran. If an earlier tick recorded that it could not, that is over.
    update public.incident_alerts a
       set resolved_at          = pg_catalog.now(),
           auto_resolved_reason = 'alert_writer_recovered'
     where a.alert_type = 'dsr_alert_writer_failed'
       and a.resolved_at is null;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    -- NOT SWALLOWED: one alert while it stays broken, emailed by the digest
    -- below. The SQLSTATE only -- an error MESSAGE can quote row values, and
    -- nothing a requester wrote may reach this table.
    begin
      insert into public.incident_alerts (alert_type, organisation_id, summary, details)
      values (
        'dsr_alert_writer_failed',
        null,
        pg_catalog.format(
          'The data-subject-request deadline alert writer FAILED (SQLSTATE %s). Overdue and nearly-due requests are NOT being alerted or emailed until this is fixed -- check /super/data-requests by hand.',
          v_state),
        pg_catalog.jsonb_build_object(
          'function', 'private.raise_dsr_deadline_alerts',
          'sqlstate', v_state))
      on conflict do nothing;
    exception when others then
      raise warning 'run_incident_alert_tick: the deadline alert writer failed (%) and the failure could not be recorded', v_state;
    end;
  end;

  -- HALF TWO, always reached.
  perform private.deliver_incident_alerts();

  -- HALF THREE (Phase 8 Task 6), LAST and in its own subtransaction. The
  -- least urgent and the most expensive of the five, and after the digest so
  -- that a slow sweep cannot delay an email that was already ready to send.
  begin
    perform private.deliver_retention_sweep();
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    raise warning 'run_incident_alert_tick: the retention sweep could not be woken (%)', v_state;
  end;
end;
$$;

comment on function private.run_incident_alert_tick() is
  'The ONE scheduled tick (pg_cron job `incident-alert-delivery`, every 10 minutes), rebuilt in 20261003005000 from its latest definition. It now does FIVE things, each but the digest in its own subtransaction so none can take another down: wake the erasure runner (Task 5), wake the export runner (Task 4), write the data-subject-request deadline alerts (Task 3), deliver the incident-alert digest plus the account lockout notices (Phase 7 Task 6/6c), and wake the RETENTION SWEEP (Phase 8 Task 6) -- which is itself throttled to about hourly by private.deliver_retention_sweep(), because it is the one half that gains nothing from running every ten minutes and costs the most when it does. The job''s NAME still describes one of the five and is kept anyway: renaming it would break the suites that pin the command string verbatim, which is a worse trade than a name with a comment on it. The command string is untouched by this migration, and cron.schedule() is not called by it at all.';
