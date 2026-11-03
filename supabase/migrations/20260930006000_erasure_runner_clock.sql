-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 7: THE CLOCK THAT MAKES A QUEUED ERASURE
-- RUN EVEN IF NOTHING NUDGED IT.
--
-- Task 4's clock migration, for a fourth half of the same tick. Everything it
-- says applies here: the request that creates the job nudges the runner
-- in-process (the LATENCY); pg_cron is the RETRY; there is still exactly ONE
-- scheduler and ONE job, `incident-alert-delivery` every 10 minutes, whose
-- command string two suites pin verbatim and which is NOT touched here.
--
-- WHY A QUEUED ERASURE THAT NEVER RUNS IS WORSE THAN A QUEUED EXPORT THAT
-- NEVER RUNS: an export nobody builds is a statutory response that is late. A
-- deletion nobody performs is a person who has been TOLD their account is
-- being deleted, watching a page that says so, with their data entirely
-- intact and no further action available to them -- the one live job index
-- means they cannot even ask again. So the retry matters more here, and it is
-- the same one line.
--
-- LOCAL DEV IS A REAL NO-OP: with no Vault entries the function returns
-- before it builds a request. Locally the nudge is the whole mechanism.
--
-- private.run_incident_alert_tick() is rebuilt from its LATEST definition
-- (20260924001000 as amended by 20260927004000). The only change is the new
-- subtransaction.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE POST. Its own Vault names -- a different route and a different
--    secret from the digest's and the export runner's, so leaking one does
--    not hand over the others, and this is the one that runs DELETIONS.
--
--    Created ONCE PER ENVIRONMENT, by hand, never by this repository:
--
--      select vault.create_secret(
--        'https://app.example.com/api/erasure/run',
--        'erasure_runner_url',
--        'Where private.deliver_erasure_jobs() POSTs (Phase 8 Task 5).');
--      select vault.create_secret(
--        '<the same value as ERASURE_RUNNER_SECRET>',
--        'erasure_runner_secret',
--        'Bearer presented to /api/erasure/run.');
--
--    SECURITY.md § 15 carries this beside the other two pairs.
-- ---------------------------------------------------------------------------

create or replace function private.deliver_erasure_jobs()
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
  if not exists (select 1 from public.erasure_jobs j where j.status = 'queued') then
    return;
  end if;

  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'erasure_runner_url';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'erasure_runner_secret';

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

comment on function private.deliver_erasure_jobs() is
  'Wakes the erasure runner over HTTP, from the one pg_cron tick. Returns immediately when nothing is queued, and returns without building a request when its two Vault secrets are absent or the secret is shorter than the route will accept -- so an unconfigured deployment (every local one) has a clock that ticks and posts nothing, rather than a faked send. Fire and forget: the response is not read, because the next tick already does the only thing a failure would call for (the job is still queued). Its own URL and secret, separate from the digest''s and the export runner''s: this is the one that makes DELETIONS happen sooner.';

revoke all on function private.deliver_erasure_jobs() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE TICK, REBUILT FROM ITS LATEST DEFINITION. One more subtransaction,
--    ahead of the rest for the same reason half zero is: it is the cheapest
--    and the most time-sensitive, and whatever it throws is rolled back to
--    here and cannot take the digest with it.
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
end;
$$;

comment on function private.run_incident_alert_tick() is
  'The ONE scheduled tick (pg_cron job `incident-alert-delivery`, every 10 minutes), rebuilt in 20260930006000 from its latest definition. It now does FOUR things, in four subtransactions so none can take another down: wake the erasure runner (Task 5), wake the export runner (Task 4), write the data-subject-request deadline alerts (Task 3) and deliver the incident-alert digest plus the account lockout notices (Task 6/6c). The job''s NAME still describes one of the four and is kept anyway: renaming it would break the two suites that pin the command string verbatim, which is a worse trade than a name with a comment on it. The command string is untouched by this migration.';
