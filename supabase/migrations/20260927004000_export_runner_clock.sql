-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 5: THE CLOCK THAT MAKES A QUEUED JOB RUN
-- EVEN IF NOTHING NUDGED IT.
--
-- ===========================================================================
-- TWO TRIGGERS, ONE RUNNER, AND WHICH IS WHICH
-- ===========================================================================
-- An export is wanted in seconds, not in up to ten minutes. So the request
-- that creates the job ALSO nudges the runner, in the same server process,
-- after the response has been sent (`after()` from next/server -- the
-- feedback receipt's pattern, which exists because a stalled send used to
-- hold a dialog open). That nudge is the LATENCY.
--
-- The nudge is not a guarantee: a process that dies between the insert and
-- the nudge leaves a job queued for ever, which is a person waiting for a
-- statutory response with nothing happening. So pg_cron is the RETRY, on the
-- clock the product already has. There is still exactly one scheduler and
-- exactly one job -- `incident-alert-delivery`, every 10 minutes -- and this
-- migration folds a third half into the function that job runs, exactly as
-- Phase 8 Task 3 folded the deadline-alert writer into it rather than
-- scheduling a second job. supabase/tests/rls_phase7_rate_limits.sql § RD3
-- and rls_phase8_data_subject_requests.sql § DG14 both assert
-- `count(*) = 1`, and both stay true.
--
-- THE JOB'S NAME IS NOW WRONG AND IS KEPT ANYWAY. `incident-alert-delivery`
-- and `private.run_incident_alert_tick()` describe one of the three things
-- they now do. Renaming either would mean editing an applied migration's
-- effect and breaking the two suites that pin the command string verbatim --
-- which is a worse trade than a name with a comment on it. The comment is
-- reissued below and says what the tick really does.
--
-- LOCAL DEV IS A REAL NO-OP, not a fake send: with no Vault entries
-- private.deliver_export_jobs() returns before it builds a request, exactly
-- as private.deliver_incident_alerts() does. Locally the nudge is therefore
-- the whole mechanism, and that is the local truth rather than a pretend
-- one.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE POST. The digest's twin, with its own Vault names -- a different
--    route, a different secret, so leaking one does not hand over the other.
--
--    Created ONCE PER ENVIRONMENT, by hand, never by this repository:
--
--      select vault.create_secret(
--        'https://app.example.com/api/exports/run',
--        'export_runner_url',
--        'Where private.deliver_export_jobs() POSTs (Phase 8 Task 4).');
--      select vault.create_secret(
--        '<the same value as EXPORT_RUNNER_SECRET>',
--        'export_runner_secret',
--        'Bearer presented to /api/exports/run.');
--
--    SECURITY.md § 15 carries this beside the incident-alert pair.
-- ---------------------------------------------------------------------------

create or replace function private.deliver_export_jobs()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Nothing queued, nothing to wake. Cheap, and it keeps an idle deployment
  -- from making 144 pointless HTTP requests a day.
  if not exists (select 1 from public.export_jobs j where j.status = 'queued') then
    return;
  end if;

  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'export_runner_url';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'export_runner_secret';

  -- UNCONFIGURED = NO-OP, the digest's rule. The length test mirrors the
  -- route's own `>= 32`, so a secret too short to be accepted there is never
  -- presented from here.
  if v_url is null or pg_catalog.btrim(v_url) = ''
     or v_secret is null or pg_catalog.length(pg_catalog.btrim(v_secret)) < 32 then
    return;
  end if;

  -- Fire and forget. The response is not read: there is nothing this
  -- function could do with a failure that the next tick does not already do
  -- (the job stays queued), and net._http_response keeps the status for a
  -- human who wants to look.
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

comment on function private.deliver_export_jobs() is
  'THE EXPORT RUNNER''S RETRY (Phase 8 Task 4). Runs from the SAME pg_cron tick as the incident digest -- the product still has one scheduler and one job -- and POSTs /api/exports/run with a bearer read from Supabase Vault (export_runner_url / export_runner_secret, created by hand once per environment and NEVER by a migration). Returns immediately when nothing is queued, and returns before building a request when the Vault entries are missing, which is what local dev and CI do on every tick. The request that creates a job also nudges the runner in-process after its response, so this is the retry rather than the normal path: a queued job whose nudge was lost is picked up within ten minutes instead of never. SECURITY DEFINER for the Vault read; granted to no client role.';

revoke all on function private.deliver_export_jobs() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE TICK, REBUILT FROM ITS LATEST DEFINITION (20260925002000).
--
--    The export half goes FIRST and in its own subtransaction, for the same
--    reason the deadline-alert writer does: a failure there must not stop the
--    digest, which is how an operator finds out about anything at all. It
--    cannot itself raise an alert about its own failure the way the deadline
--    writer does -- deliver_export_jobs() only queues an HTTP request and
--    an unreachable route is not a database fault -- so its failure is a
--    warning in the Postgres log and the jobs simply stay queued and visible
--    on the requester's own page.
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
end;
$$;

comment on function private.run_incident_alert_tick() is
  'WHAT THE PRODUCT''S ONE CRON JOB RUNS, every 10 minutes. THREE halves now, and the job''s name describes only the last of them (renaming it would edit an applied migration''s effect and break the two suites that pin the command string verbatim -- a worse trade than a name with this comment on it): (0) private.deliver_export_jobs(), the export runner''s RETRY, in its own subtransaction -- the request that starts a job nudges the runner itself, so this only catches a job whose nudge was lost; (1) private.raise_dsr_deadline_alerts(), in its own subtransaction, with its own failure recorded as a dsr_alert_writer_failed alert and auto-resolved when it recovers; (2) private.deliver_incident_alerts(), always reached, which is how any of it reaches a human. Each earlier half is isolated so it cannot take the digest down with it.';

revoke all on function private.run_incident_alert_tick() from public, anon, authenticated, service_role;
