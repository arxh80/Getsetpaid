-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDINGS m5 AND m6 (AND Q182).
--
-- m5 -- A REFUSED RUN TOLD NOBODY.
--
-- A refusal was a column on public.retention_runs, rendered on /super/health,
-- and nothing else. The reviewer's worked example is the audit purge's sanity
-- ceiling: it compares EVERY row past the cutoff against the table, but each
-- run deletes at most 500, so once a deployment holds 1,200 rows past a year
-- in a 5,000-row table the purge refuses on every run for ever and the audit
-- log grows without bound -- visible only to somebody who opens that page and
-- reads that column. Since this round's C2 the same is true of a STRUCTURAL
-- refusal: a table nobody classified, or a clock a client can write, now stops
-- the whole job (correctly) and would have stopped it silently.
--
-- Q182 asked whether a refused run should raise an incident alert, recommended
-- "yes, but not for a switch somebody chose to turn off", and was not built
-- because of a dedup question: once per run, hourly, is 24 alerts a day for
-- one broken sweep. THE DEDUP ANSWER ALREADY EXISTS IN THIS SCHEMA --
-- incident_alerts_writer_failed_open_once_idx, a partial unique index over
-- the UNRESOLVED alerts of one type (20260925002000). Same shape here, keyed
-- on (sweep, reason): ONE open alert per distinct fault, however many runs
-- repeat it, re-raised only after somebody resolves it and it happens again.
--
-- THE RAISER IS A TRIGGER ON THE RUN LOG, not a line in three functions. A
-- refusal reaches public.retention_runs from public.start_retention_run()
-- (the whole run refused), public.run_retention_sweep() (one sweep refused)
-- and public.fail_retention_run() (the run failed) -- plus the reaper. The run
-- log is the chokepoint all four pass (standing lesson 6), so a fifth writer
-- is covered on the day it is written.
--
--   * LIVE runs only. A preview is the founder looking; the live run an hour
--     either side of it will say the same thing, to the inbox.
--   * NOT `retention_disabled` and NOT `retention_run_in_progress`: the first
--     is a state somebody chose (and public.set_retention_enabled() already
--     audits the choice with its reason), the second is an overlap and not a
--     fault. A sweep-level `audit_purge_disabled` never reaches `refused` at
--     all -- it is reported in `swept`.
--   * COUNTS AND CODES, NEVER CONTENT. `refused` holds hints and SQLSTATEs
--     written by this product's own functions; the one free-text path
--     (fail_retention_run's p_reason) is composed by the runner from a closed
--     vocabulary, and anything that does not look like a code is recorded as
--     `unknown` rather than passed through to an operator surface.
--   * IT CLEARS ITSELF. The next LIVE run that COMPLETES resolves every open
--     alert whose (sweep, reason) it did not repeat, as the SYSTEM
--     (`retention_run_recovered`), the alert_writer_recovered precedent -- so
--     an alert that is still open is a fault that is still happening.
--
-- WHAT THE OPERATOR DOES NEXT is in SECURITY.md § 8 ("When a retention run
-- refuses"), per reason. For the ceiling specifically: the alert's details
-- carry the candidate and total row counts, so "is this a backlog or a wrong
-- clock?" can be answered from the alert; a genuine backlog is released by
-- reissuing private.audit_purge_ceiling() in a reviewed migration and
-- restoring it afterwards. A no-deploy, time-boxed, audited release is Q184.
--
-- m6 -- A PREVIEW POSTPONED THE LIVE RUN IT WAS PREVIEWING.
--
-- private.deliver_retention_sweep() throttled on max(started_at) over EVERY
-- run, `dry` included, and the /super/health "Preview the next run" button
-- writes a `dry` row. Pressing it postponed the next real sweep by up to an
-- hour; pressing it every half hour postponed it indefinitely. A preview must
-- not move the live job's clock. The throttle is now a function of its own,
-- private.retention_sweep_is_due(), so that it can be ASKED (the poster's
-- only observable effect is an HTTP request an unconfigured stack never
-- makes), and it counts LIVE runs only -- and not a live run that was refused
-- because a preview happened to be in flight (I2), which would be the same
-- defect arriving by the other door.
--
-- REBUILT FROM ITS LATEST DEFINITION: private.deliver_retention_sweep()
-- (20261003005000). Still exactly one pg_cron job, untouched.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE VOCABULARY (two widenings, under the names 20260924001000 and
--    20260925002000 gave them). lib/admin/health.ts mirrors both and
--    tests/integration/admin/incident-alert-vocabularies-match-db.test.ts
--    binds them.
-- ---------------------------------------------------------------------------

alter table public.incident_alerts
  drop constraint incident_alerts_alert_type_known;

alter table public.incident_alerts
  add constraint incident_alerts_alert_type_known
  check (alert_type in ('rate_limit_tripped',
                        'repeated_login_failures',
                        'upload_quarantined',
                        'dsr_deadline_approaching',
                        'dsr_overdue',
                        'dsr_alert_writer_failed',
                        'retention_run_refused'));

comment on constraint incident_alerts_alert_type_known on public.incident_alerts is
  'The closed list of incident alert types. Phase 7 Task 5 shipped the first three unnamed; Phase 8 Task 3 added the two data-subject-request deadline alerts and named the constraint; its fix round 1 (20260925002000) added dsr_alert_writer_failed; Phase 8 Task 6 fix round 1 (20261004004000, Q182) added retention_run_refused -- a LIVE retention run that refused or failed for any reason but a switch somebody chose, so that "the audit purge has refused its ceiling every hour for a month" is emailed rather than visible only to somebody who looks. Mirrored by lib/admin/health.ts''s INCIDENT_ALERT_TYPE_LABELS, which tests/integration/admin/incident-alert-vocabularies-match-db.test.ts binds to this list.';

alter table public.incident_alerts
  drop constraint incident_alerts_auto_resolved_reason_known;

alter table public.incident_alerts
  add constraint incident_alerts_auto_resolved_reason_known
  check (auto_resolved_reason is null
         or auto_resolved_reason in ('data_subject_request_closed',
                                     'alert_writer_recovered',
                                     'retention_run_recovered'));

comment on column public.incident_alerts.auto_resolved_reason is
  'Set when the SYSTEM resolved the alert rather than a person (Phase 8 Task 3 fix round 1, Q159/M1): data_subject_request_closed -- the request the alert names reached fulfilled, rejected or withdrawn, so there is no deadline left to miss; alert_writer_recovered -- the deadline-alert writer ran cleanly again after a dsr_alert_writer_failed; retention_run_recovered (20261004004000) -- a later LIVE retention run completed without repeating the refusal a retention_run_refused alert names. resolved_by is then NULL: nobody is named as having resolved an alert they never saw. No client role holds a write of this column.';

-- ONE OPEN ALERT PER DISTINCT FAULT. This index is the whole of Q182's dedup
-- answer: an hourly job refusing the same way 24 times a day files one alert.
create unique index incident_alerts_retention_refused_open_once_idx
  on public.incident_alerts ((details ->> 'sweep'), (details ->> 'reason'))
  where alert_type = 'retention_run_refused'
    and resolved_at is null;


-- ---------------------------------------------------------------------------
-- 2. THE RAISER.
-- ---------------------------------------------------------------------------

create or replace function private.retention_run_raises_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key        text;
  v_reason     text;
  v_details    jsonb;
  v_candidates bigint;
  v_total      bigint;
begin
  if new.mode <> 'live' or new.status = 'running' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return null;
  end if;

  for v_key, v_reason in
    select e.key, e.value from pg_catalog.jsonb_each_text(new.refused) e
  loop
    -- A STATE SOMEBODY CHOSE, AND AN OVERLAP. Neither is a fault.
    continue when v_reason in ('retention_disabled', 'retention_run_in_progress');

    -- CODES ONLY. Anything that does not look like a hint or a SQLSTATE is
    -- recorded as `unknown` rather than shown to an operator.
    if v_reason is null or v_reason !~ '^[A-Za-z0-9_]{1,80}$' then v_reason := 'unknown'; end if;
    if v_key is null or v_key !~ '^[a-z0-9_*]{1,40}$' then v_key := 'unknown'; end if;

    v_details := pg_catalog.jsonb_build_object(
      'sweep', v_key, 'reason', v_reason, 'run_id', new.id, 'run_status', new.status);

    -- THE CEILING'S TWO NUMBERS, so "backlog or wrong clock?" is answerable
    -- from the alert. Counts, never content.
    if v_reason = 'audit_purge_over_ceiling' then
      select pg_catalog.count(*) filter (
               where a.created_at < pg_catalog.now() - private.retention_period('audit_total')),
             pg_catalog.count(*)
        into v_candidates, v_total
        from public.audit_events a;
      v_details := v_details || pg_catalog.jsonb_build_object(
        'audit_rows_past_period', v_candidates, 'audit_rows_total', v_total);
    end if;

    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'retention_run_refused', null,
      'The retention job ' || case when new.status = 'failed' then 'FAILED' else 'REFUSED' end
        || ' (' || case when v_key = '*' then 'the whole run' else v_key end || ': ' || v_reason
        || '). What it refused was NOT deleted, and it will keep refusing until this is fixed.',
      v_details)
    on conflict do nothing;
  end loop;

  -- IT CLEARS ITSELF: a completed live run resolves every open alert whose
  -- fault it did not repeat.
  if new.status = 'completed' then
    update public.incident_alerts a
       set resolved_at = pg_catalog.now(),
           auto_resolved_reason = 'retention_run_recovered'
     where a.alert_type = 'retention_run_refused'
       and a.resolved_at is null
       and not (new.refused ? (a.details ->> 'sweep')
                and new.refused ->> (a.details ->> 'sweep') = a.details ->> 'reason');
  end if;

  return null;
end;
$$;

comment on function private.retention_run_raises_alert() is
  'Q182 / review finding m5 (Phase 8 Task 6 fix round 1): files a `retention_run_refused` incident alert when a LIVE retention run finishes `refused` or `failed`, or `completed` with a sweep in its `refused` map -- so a refusal is emailed by the existing digest rather than visible only on /super/health. AN AFTER TRIGGER ON THE RUN LOG, because a refusal reaches that table from four writers (start, sweep, fail, the reaper) and the table is the chokepoint they all pass. Not for `retention_disabled` (a state somebody chose, already audited with its reason) or `retention_run_in_progress` (an overlap). ONE OPEN ALERT PER (sweep, reason): incident_alerts_retention_refused_open_once_idx, so an hourly job refusing the same way all day files one. Codes and counts only -- anything in `refused` that does not look like a hint or a SQLSTATE is recorded as `unknown`. For audit_purge_over_ceiling the details carry the two row counts. A later live run that COMPLETES resolves every open alert whose fault it did not repeat, as the system (`retention_run_recovered`). SECURITY.md § 8 says what the operator does next, per reason.';

revoke all on function private.retention_run_raises_alert() from public, anon, authenticated, service_role;

create trigger retention_runs_raise_alert
  after insert or update of status, refused on public.retention_runs
  for each row execute function private.retention_run_raises_alert();


-- ---------------------------------------------------------------------------
-- 3. m6: THE THROTTLE, AS A QUESTION THAT CAN BE ASKED.
-- ---------------------------------------------------------------------------

create or replace function private.retention_sweep_is_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.retention_runs r
     where r.mode = 'live'
       and coalesce(r.refused ->> '*', '') <> 'retention_run_in_progress'
       and r.started_at > pg_catalog.now() - private.retention_sweep_interval())
$$;

comment on function private.retention_sweep_is_due() is
  'THE RETENTION THROTTLE (review finding m6): true unless a LIVE run began inside the last private.retention_sweep_interval(). As shipped the throttle read max(started_at) over EVERY run, so the /super/health preview button -- which writes a `dry` row -- postponed the next real sweep by up to an hour, and pressed every half hour postponed it indefinitely. A PREVIEW MUST NOT MOVE THE LIVE JOB''S CLOCK. A live run refused as `retention_run_in_progress` does not count either: that is a cron wake that collided with a preview, and counting it would be the same defect by the other door. Every other live outcome counts, a refusal included -- a job that is switched off should write one refused row an hour, not one every ten minutes. A function of its own so it can be ASKED: the poster''s only other observable effect is an HTTP request an unconfigured stack never makes.';

revoke all on function private.retention_sweep_is_due() from public, anon, authenticated, service_role;


create or replace function private.deliver_retention_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- THE THROTTLE. Reads the run log itself, so there is no second piece of
  -- state to get out of step with what happened -- LIVE runs only (m6).
  if not private.retention_sweep_is_due() then
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
  'Wakes the retention runner over HTTP, from the one pg_cron tick (Phase 8 Task 6). THROTTLED rather than scheduled: it returns immediately unless private.retention_sweep_is_due() -- no LIVE run began inside the last private.retention_sweep_interval() -- so the sweep runs about hourly inside a ten-minute tick without a second cron entry. CORRECTED in 20261004004000 (review finding m6): the throttle used to read every run, so a dry-run PREVIEW from /super/health reset it and postponed the live run it was previewing. Returns without building a request when its two Vault secrets are absent or the secret is shorter than the route will accept -- so an unconfigured deployment (every local one) has a clock that ticks and posts nothing rather than a faked send. Fire and forget: the response is not read, because the next tick already does the only thing a failure would call for. Its own URL and secret, separate from the digest''s, the export runner''s and the erasure runner''s: this is the one that DELETES THE AUDIT LOG.';

revoke all on function private.deliver_retention_sweep() from public, anon, authenticated, service_role;
