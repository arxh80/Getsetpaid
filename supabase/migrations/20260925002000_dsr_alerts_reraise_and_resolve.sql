-- ===========================================================================
-- PHASE 8 TASK 3, FIX ROUND 1 (review findings I3, M1, M3; ruling Q159) --
-- AN OVERDUE REQUEST COULD GO QUIET WHILE IT WAS STILL OPEN.
--
-- 20260924001000 guaranteed "exactly once per request per stage" with a
-- unique index on (alert_type, details->>'request_id') that had no
-- `resolved_at is null` term, and its writer had no re-raise rule. So a
-- `dsr_overdue` alert was the only proactive signal a request would EVER get,
-- and it was a row the operator can flag resolved from /super/health with no
-- check that the request it names has been closed. Measured by the review: one
-- Resolve click, sixty more days simulated, and an open request sat 75 days
-- overdue with ZERO unresolved alerts and nothing more ever to be emailed. The
-- task's requirement -- "an overdue open request must surface without anyone
-- looking for it" -- held only until the first click.
--
-- Q159 (coordinator's ruling, working default; the founder may overturn):
--
--   1. THE UNIQUENESS IS AMONG UNRESOLVED ALERTS ONLY. Never two open alerts
--      for one request and stage -- still structural, still a unique index
--      rather than a racy `not exists`.
--   2. A STILL-OPEN OVERDUE REQUEST WHOSE ALERT WAS RESOLVED IS RAISED AGAIN,
--      private.dsr_alert_reraise_days() = 7 days after that resolution -- the
--      same number as the lead time, and at most one alert per open overdue
--      request per week, which is the volume the law asks for (Q117's "triage,
--      not volume" is about noise; this is the opposite of noise). Resolving a
--      `dsr_overdue` alert is therefore a one-week SNOOZE, not a dismissal.
--      A new row, so the existing digest emails it again (its `notified_at` is
--      null). The early warning is NOT re-raised: it is one stage of at most
--      seven days, and the overdue alert takes over at the deadline.
--   3. CLOSING A REQUEST RESOLVES ITS OPEN ALERTS (M1), attributed to the
--      SYSTEM and not to a person. Before this, a fulfilled request left its
--      `approaching` and `overdue` alerts open -- the noise that trains an
--      operator to resolve DSR alerts by reflex, which is the way into the hole
--      above.
--
-- "ATTRIBUTED TO THE SYSTEM" NEEDED A COLUMN. incident_alerts_resolution_pair
-- said resolved_at and resolved_by are both null or both set, so a resolution
-- with no resolver was unrepresentable, and writing the closing person's id
-- into resolved_by would say THEY resolved an alert they never saw (a
-- requester withdrawing their own request closes it). `auto_resolved_reason`
-- names the system event instead, and the CHECK becomes: open = all three
-- null; resolved = a timestamp and EXACTLY ONE of a person or a reason. A
-- WIDENING: every row the old CHECK accepted, the new one accepts. No client
-- holds a write of the new column (the column-level UPDATE grant is
-- resolved_at, resolved_by -- 20260919000000), so a person can neither claim a
-- system resolution nor reopen one: both fail the CHECK.
--
-- M3 -- THE RAISER AND THE DIGEST SHARED ONE IMPLICIT TRANSACTION. pg_cron
-- runs a multi-statement command as one simple query, so an exception in
-- private.raise_dsr_deadline_alerts() would also have stopped Phase 7's
-- digest and the lockout notices, on that tick and every tick until somebody
-- noticed. The job now runs ONE function, private.run_incident_alert_tick(),
-- which runs the raiser inside its own subtransaction and ALWAYS reaches the
-- digest. A raiser failure is not swallowed: it writes a
-- `dsr_alert_writer_failed` alert (exactly one while unresolved), which the
-- digest that still runs then emails -- the failure of the thing that watches
-- the deadline surfaces without anyone looking for it, which is the whole
-- requirement applied to itself. When the raiser next succeeds, that alert is
-- resolved by the system.
--
-- REBUILT FROM THEIR LATEST DEFINITIONS: private.raise_dsr_deadline_alerts()
-- (20260924001000 § 3) and private.audit_incident_alert_resolution()
-- (20260909080000). Still exactly one pg_cron job.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. ONE MORE ALERT TYPE (a widening, under the name 20260924001000 gave it)
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
                        'dsr_alert_writer_failed'));

comment on constraint incident_alerts_alert_type_known on public.incident_alerts is
  'The closed list of incident alert types. Phase 7 Task 5 shipped the first three unnamed; Phase 8 Task 3 added the two data-subject-request deadline alerts and named the constraint; fix round 1 (20260925002000) added dsr_alert_writer_failed -- the alert the cron tick writes when the deadline-alert writer itself throws, so that failure is emailed rather than silent. Mirrored by lib/admin/health.ts''s INCIDENT_ALERT_TYPE_LABELS, which the psql suite binds to this list.';


-- ---------------------------------------------------------------------------
-- 2. A RESOLUTION WITH NO PERSON BEHIND IT
-- ---------------------------------------------------------------------------

alter table public.incident_alerts
  add column auto_resolved_reason text;

alter table public.incident_alerts
  add constraint incident_alerts_auto_resolved_reason_known
  check (auto_resolved_reason is null
         or auto_resolved_reason in ('data_subject_request_closed',
                                     'alert_writer_recovered'));

alter table public.incident_alerts
  drop constraint incident_alerts_resolution_pair;

alter table public.incident_alerts
  add constraint incident_alerts_resolution_pair
  check (
    (resolved_at is null and resolved_by is null and auto_resolved_reason is null)
    or
    (resolved_at is not null and num_nonnulls(resolved_by, auto_resolved_reason) = 1)
  );

comment on column public.incident_alerts.auto_resolved_reason is
  'Set when the SYSTEM resolved the alert rather than a person (Phase 8 Task 3 fix round 1, Q159/M1): data_subject_request_closed -- the request the alert names reached fulfilled, rejected or withdrawn, so there is no deadline left to miss; alert_writer_recovered -- the deadline-alert writer ran cleanly again after a dsr_alert_writer_failed. resolved_by is then NULL: nobody is named as having resolved an alert they never saw. No client role holds a write of this column.';

comment on constraint incident_alerts_resolution_pair on public.incident_alerts is
  'An OPEN alert has no resolution at all; a RESOLVED one has a timestamp and EXACTLY ONE of a person (resolved_by) or a system reason (auto_resolved_reason). Widened in fix round 1 (20260925002000) from Phase 7''s "resolved_at and resolved_by both or neither": every row that passed still passes. Because clients can write only resolved_at and resolved_by, this is also what stops a person claiming a system resolution (two non-nulls) or reopening one (a reason with no timestamp).';


-- THE CLIENT COLUMN GATE, REISSUED -- auto_resolved_reason joins the immutable
-- set. No client holds a privilege on the column (the UPDATE grant is
-- column-level: resolved_at, resolved_by -- 20260919000000), so this is the
-- second gate and not the first: the house's two-gate shape, kept so that a
-- future widening of that grant cannot let an operator's browser mark its own
-- resolution as the system's. Body copied from its LATEST definition
-- (20260916001000 § 2) with one clause added.
create or replace function private.incident_alert_resolution_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not pg_catalog.row_security_active('public.incident_alerts'::pg_catalog.regclass) then
    return new;
  end if;

  if new.alert_type          is distinct from old.alert_type
     or new.organisation_id     is distinct from old.organisation_id
     or new.summary             is distinct from old.summary
     or new.details             is distinct from old.details
     or new.created_at          is distinct from old.created_at
     or new.notified_at         is distinct from old.notified_at
     or new.account_notified_at is distinct from old.account_notified_at
     or new.auto_resolved_reason is distinct from old.auto_resolved_reason
     or new.id                  is distinct from old.id then
    raise exception 'incident_alerts: only the resolution flag (resolved_at, resolved_by) is client-writable'
      using errcode = '42501';
  end if;

  if new.resolved_at is not null and new.resolved_by is distinct from (select auth.uid()) then
    raise exception 'incident_alerts: resolved_by must be the resolving caller'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.incident_alert_resolution_guard() is
  'The column gate behind incident_alerts_update_platform: a client update may move resolved_at/resolved_by (resolved_by forced to auth.uid()) and nothing else. Everything except the resolution flag is immutable from any client path -- alert content is written once, by the definer writers, and stays what it was. BOTH delivery seams are in the immutable set on purpose: `notified_at` belongs to the operator''s digest sender and `account_notified_at` (Q114) to the account-holder notification. So is `auto_resolved_reason` (Phase 8 Task 3 fix round 1, 20260925002000): only the system says the system resolved something. An alert the system resolved can be neither reopened nor claimed by a person -- incident_alerts_resolution_pair refuses both.';


-- ---------------------------------------------------------------------------
-- 3. UNIQUE AMONG THE UNRESOLVED, AND A LOOKUP INDEX FOR THE HISTORY
-- ---------------------------------------------------------------------------

drop index public.incident_alerts_dsr_stage_once_idx;

create unique index incident_alerts_dsr_stage_open_once_idx
  on public.incident_alerts (alert_type, ((details ->> 'request_id')))
  where alert_type in ('dsr_deadline_approaching', 'dsr_overdue')
    and resolved_at is null;

-- The writer asks "has this request had an alert of this stage, and when was
-- the last one resolved" -- resolved rows included, which the unique index
-- above deliberately does not cover.
create index incident_alerts_dsr_request_idx
  on public.incident_alerts (((details ->> 'request_id')), alert_type, resolved_at)
  where alert_type in ('dsr_deadline_approaching', 'dsr_overdue');

create unique index incident_alerts_writer_failed_open_once_idx
  on public.incident_alerts (alert_type)
  where alert_type = 'dsr_alert_writer_failed'
    and resolved_at is null;


-- ---------------------------------------------------------------------------
-- 4. HOW LONG A RESOLVED OVERDUE ALERT STAYS QUIET
-- ---------------------------------------------------------------------------

create or replace function private.dsr_alert_reraise_days()
returns integer
language sql
immutable
set search_path = ''
as $$ select 7 $$;

comment on function private.dsr_alert_reraise_days() is
  'How many days after a dsr_overdue alert is RESOLVED the writer raises another, if the request it names is still open: 7 (Q159). Resolving an overdue alert is a one-week snooze, never a dismissal -- the only thing that silences it for good is closing the request. The same number as private.dsr_alert_lead_days(): one alert per open overdue request per week at most. In one place, read by lib/dsr/contract.ts.';

revoke all on function private.dsr_alert_reraise_days() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. THE WRITER, REBUILT FROM ITS LATEST DEFINITION (20260924001000 § 3)
-- ---------------------------------------------------------------------------

create or replace function private.raise_dsr_deadline_alerts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_written integer := 0;
  v_rows    integer;
begin
  -- OVERDUE FIRST. A request that is already past its deadline gets the loud
  -- alert even if it never got the quiet one.
  --
  -- RAISED when the request has no UNRESOLVED overdue alert and none that was
  -- resolved inside the last private.dsr_alert_reraise_days() -- so the first
  -- one fires the moment the deadline passes, and a resolved one comes back a
  -- week later for as long as the request stays open (Q159). `on conflict do
  -- nothing` lands on incident_alerts_dsr_stage_open_once_idx, which is what
  -- makes two racing ticks write one row rather than two.
  insert into public.incident_alerts (alert_type, organisation_id, summary, details)
  select
    'dsr_overdue',
    -- Deliberately NULL even for a routed request. /super/health's
    -- "attributed to a workspace" filter means "this alert is about that
    -- workspace's traffic"; a DSR is the platform's own obligation, and the
    -- routed workspace is in `details` where it belongs.
    null,
    pg_catalog.format(
      'Data subject request %s (%s, %s) is OVERDUE by %s: the 30-day statutory deadline passed on %s.%s',
      d.id, d.right_type, d.subject_scope,
      case when x.days_overdue = 1 then '1 day' else x.days_overdue || ' days' end,
      pg_catalog.to_char(d.due_by, 'YYYY-MM-DD'),
      case when x.earlier > 0
           then ' Raised AGAIN: an earlier alert was resolved and the request is still open.'
           else '' end),
    pg_catalog.jsonb_build_object(
      'request_id',    d.id,
      'right_type',    d.right_type,
      'subject_scope', d.subject_scope,
      'status',        d.status,
      'due_by',        d.due_by,
      'days_overdue',  x.days_overdue,
      'earlier_alerts', x.earlier,
      'routed_to_organisation_id', d.routed_to_organisation_id)
    from public.data_subject_requests d
   cross join lateral (
     select greatest(0, pg_catalog.floor(extract(epoch from (pg_catalog.now() - d.due_by)) / 86400)::integer)
              as days_overdue,
            (select count(*)::integer from public.incident_alerts e
              where e.alert_type = 'dsr_overdue'
                and e.details ->> 'request_id' = d.id::text) as earlier
   ) x
   where d.status in ('open', 'in_progress', 'routed')
     and d.due_by <= pg_catalog.now()
     and not exists (
           select 1 from public.incident_alerts a
            where a.alert_type = 'dsr_overdue'
              and a.details ->> 'request_id' = d.id::text
              and (a.resolved_at is null
                   or a.resolved_at > pg_catalog.now()
                        - pg_catalog.make_interval(days => private.dsr_alert_reraise_days())))
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_written := v_written + v_rows;

  -- THE EARLY WARNING. Once per request, ever, resolved or not: it is one
  -- stage of at most seven days and the overdue alert takes over at the
  -- deadline, so re-raising it would only be the noise Q117 ruled against.
  insert into public.incident_alerts (alert_type, organisation_id, summary, details)
  select
    'dsr_deadline_approaching',
    null,
    pg_catalog.format(
      'Data subject request %s (%s, %s) is due on %s -- %s days left of the 30-day statutory deadline.',
      d.id, d.right_type, d.subject_scope,
      pg_catalog.to_char(d.due_by, 'YYYY-MM-DD'),
      greatest(0, pg_catalog.ceil(extract(epoch from (d.due_by - pg_catalog.now())) / 86400)::integer)),
    pg_catalog.jsonb_build_object(
      'request_id',    d.id,
      'right_type',    d.right_type,
      'subject_scope', d.subject_scope,
      'status',        d.status,
      'due_by',        d.due_by,
      'lead_days',     private.dsr_alert_lead_days(),
      'routed_to_organisation_id', d.routed_to_organisation_id)
    from public.data_subject_requests d
   where d.status in ('open', 'in_progress', 'routed')
     and d.due_by > pg_catalog.now()
     and d.due_by <= pg_catalog.now()
         + pg_catalog.make_interval(days => private.dsr_alert_lead_days())
     and not exists (
           select 1 from public.incident_alerts a
            where a.alert_type = 'dsr_deadline_approaching'
              and a.details ->> 'request_id' = d.id::text)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_written := v_written + v_rows;

  return v_written;
end;
$$;

comment on function private.raise_dsr_deadline_alerts() is
  'Writes public.incident_alerts rows for data subject requests whose 30-day deadline has passed (dsr_overdue) or is within private.dsr_alert_lead_days() (dsr_deadline_approaching). Runs from the ONE pg_cron job, inside private.run_incident_alert_tick(), immediately before the digest that delivers it. A CLOSED request raises nothing. NEVER TWO UNRESOLVED alerts for one request and stage (the partial unique index incident_alerts_dsr_stage_open_once_idx, not a racy `not exists`). AN OVERDUE ALERT THAT WAS RESOLVED COMES BACK private.dsr_alert_reraise_days() after its resolution for as long as the request is still open (fix round 1, Q159: as shipped it fired once, ever, and one Resolve click silenced an open request for good); the summary then says how many days overdue and that it was raised again. The early warning is written once per request. Summary and details carry identifiers, enums, counts and timestamps only. Returns how many rows it wrote. SECURITY DEFINER, granted to no client role.';

revoke all on function private.raise_dsr_deadline_alerts() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. CLOSING A REQUEST RESOLVES ITS OPEN ALERTS (M1)
-- ---------------------------------------------------------------------------

create or replace function private.dsr_resolve_alerts_on_close()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.incident_alerts a
     set resolved_at          = pg_catalog.now(),
         auto_resolved_reason = 'data_subject_request_closed'
   where a.alert_type in ('dsr_deadline_approaching', 'dsr_overdue')
     and a.details ->> 'request_id' = new.id::text
     and a.resolved_at is null;
  return null;
end;
$$;

comment on function private.dsr_resolve_alerts_on_close() is
  'AFTER UPDATE on public.data_subject_requests, when the status becomes fulfilled, rejected or withdrawn: resolves that request''s open deadline alerts with auto_resolved_reason = data_subject_request_closed and NO resolved_by (fix round 1, M1/Q159). A closed request has no deadline left to miss, and an alert that outlives its request is the noise that teaches an operator to resolve DSR alerts without reading them. Attributed to the system: the person whose action closed the request -- who may be the requester, withdrawing -- never saw the alert and is not named on it; the closing transition''s own audit row is the record of who closed what.';

revoke all on function private.dsr_resolve_alerts_on_close() from public, anon, authenticated, service_role;

create trigger data_subject_requests_alerts_on_close
  after update on public.data_subject_requests
  for each row
  when (old.status is distinct from new.status
        and new.status in ('fulfilled', 'rejected', 'withdrawn'))
  execute function private.dsr_resolve_alerts_on_close();


-- A SYSTEM RESOLUTION IS NOT A PERSON'S ACTION, so it writes no
-- incident_alert.resolved row. The trigger's existing exemption is "no
-- auth.uid()", which a cron tick satisfies and a closing transition does not:
-- without this line the operator -- or the REQUESTER, withdrawing -- would be
-- audited as having resolved an alert. Rebuilt from 20260909080000.
create or replace function private.audit_incident_alert_resolution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- NOT A CLIENT ACTION (see the header): a migration, a seed, a fixture or a
  -- cascade has no auth.uid() to attribute, and log_audit_event refuses to
  -- write an unattributable row. row_security_active() is the WRONG test here
  -- because this function is SECURITY DEFINER and would therefore skip for
  -- everybody.
  if (select auth.uid()) is null then
    return null;
  end if;

  -- NOR IS A SYSTEM RESOLUTION (20260925002000): the alert was closed because
  -- the thing it warned about ended, inside somebody's transaction but not by
  -- their hand. That event's own audit row is the record.
  if new.auto_resolved_reason is not null then
    return null;
  end if;

  perform private.log_audit_event(
    p_action      => case when new.resolved_at is null
                          then 'incident_alert.reopened'
                          else 'incident_alert.resolved' end,
    p_target_type => 'incident_alert',
    -- The alert's own organisation, when it has one. A user-scoped crossing
    -- has none (20260909050000, finding I1), and a null here is the same
    -- "platform-scoped, not a tenant's" fact `platform_health.viewed` records.
    p_organisation_id => new.organisation_id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object(
                           'resolved_at', old.resolved_at,
                           'resolved_by', old.resolved_by),
    p_after           => pg_catalog.jsonb_build_object(
                           'alert_type',  new.alert_type,
                           'resolved_at', new.resolved_at,
                           'resolved_by', new.resolved_by)
  );
  return null;
end;
$$;

comment on function private.audit_incident_alert_resolution() is
  'Writes incident_alert.resolved / incident_alert.reopened into public.audit_events for every client resolve or reopen (Phase 7 fix round 1, review finding I4). A TRIGGER rather than a call in resolveIncidentAlertAction, because the table carries a client UPDATE grant and a permissive superuser UPDATE policy -- a raw PATCH is a real resolve path no call site could cover. `before` carries the resolution that was removed. Exempts callers with no auth.uid() -- a migration, a seed, a cascade, a fixture, the cron tick -- deliberately NOT by row_security_active(): this function is SECURITY DEFINER, so that is false for every caller. ALSO exempts a SYSTEM resolution (auto_resolved_reason set; Phase 8 Task 3 fix round 1, 20260925002000): a data subject request closing resolves its own deadline alerts inside the closing person''s transaction, and auditing that as THEIR resolution would name somebody -- possibly the requester -- for an alert they never saw.';

revoke all on function private.audit_incident_alert_resolution()
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. ONE TICK, TWO INDEPENDENT HALVES (M3)
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
  'What the ONE pg_cron job runs every ten minutes (fix round 1, M3): private.raise_dsr_deadline_alerts() inside its own subtransaction, then private.deliver_incident_alerts() UNCONDITIONALLY. 20260924001000 ran them as two statements of one cron command, which pg_cron executes as one implicit transaction -- an exception in the raiser would have stopped Phase 7''s digest and the lockout notices on that tick and every tick after. A raiser failure is not swallowed: it writes one dsr_alert_writer_failed alert (unique while unresolved; SQLSTATE only, never the message), which the digest that still runs emails; the next clean run resolves it as alert_writer_recovered. SECURITY DEFINER, granted to no client role.';

revoke all on function private.run_incident_alert_tick() from public, anon, authenticated, service_role;

-- cron.schedule() is upsert-by-name: the same one job, re-pointed again.
select cron.schedule(
  'incident-alert-delivery',
  '*/10 * * * *',
  $job$select private.run_incident_alert_tick()$job$
);

comment on extension pg_cron is
  'The product''s ONE scheduler, added in Phase 7 Task 6c for founder ruling Q118 and re-pointed in Phase 8 Task 3 (and again in its fix round 1). Everything else in this schema deliberately uses read-time expiry instead (billing/feature overrides, the suspended-workspace directory clock, the feedback retention window) -- a schedule is here only because an email cannot be sent at read time, and because a deadline that nobody looks at is a deadline that is missed. Still exactly one job: `incident-alert-delivery`, every 10 minutes, running private.run_incident_alert_tick() -- which runs private.raise_dsr_deadline_alerts() (the DSR deadline alerts) in its own subtransaction and then private.deliver_incident_alerts() (one digest of every unnotified alert) whether or not the first half succeeded.';
