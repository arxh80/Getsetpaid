-- ===========================================================================
-- PHASE 8 TASK 3 -- THE DEADLINE CANNOT BE SILENTLY MISSED.
--
-- A 30-day statutory clock that only exists on a page nobody is looking at is
-- a clock that is missed. This migration makes an approaching or blown
-- deadline arrive at the operator WITHOUT anyone going to look.
--
-- ===========================================================================
-- NO SECOND SENDER, NO SECOND CLOCK
-- ===========================================================================
-- Phase 7 Task 5 built `public.incident_alerts` and Task 6/6c built the one
-- thing that delivers it: `pg_cron` job `incident-alert-delivery`, every ten
-- minutes, calling private.deliver_incident_alerts(), which POSTs
-- /api/incident-alerts/deliver, which sends ONE Brevo digest of every
-- unnotified alert and stamps `notified_at`. So this task adds:
--
--   * two alert TYPES (`dsr_deadline_approaching`, `dsr_overdue`) -- which is
--     all it takes for them to appear on /super/health, be filterable there,
--     be resolvable there, and be delivered by the existing digest;
--   * one function that decides when to write them;
--   * and NOT a new job. `cron.schedule()` is upsert-by-name, so the existing
--     job is RE-POINTED at a command that raises the alerts and then delivers
--     them, in that order. One scheduler, one job, still (the comment on the
--     pg_cron extension says "exactly one job" and stays true), and the
--     ordering means an alert raised on a tick is delivered on the SAME tick
--     rather than ten minutes later.
--
-- ===========================================================================
-- EXACTLY ONCE PER REQUEST PER STAGE, STRUCTURALLY
-- ===========================================================================
-- A cron job that ran every ten minutes and wrote "this is overdue" every
-- time would produce 144 alerts a day per request and drown the feed the
-- product's own SECURITY.md § 5 already calls floodable. The guarantee is a
-- UNIQUE INDEX on (alert_type, details->>'request_id') restricted to these
-- two types -- not a `not exists` check, which is a race between two ticks --
-- so the insert is `on conflict do nothing` and a second write is impossible
-- rather than merely unlikely.
--
-- ===========================================================================
-- WHY SEVEN DAYS AHEAD
-- ===========================================================================
-- The early warning fires when a request has SEVEN DAYS left. That is a full
-- working week: long enough to do the work (an export or an erasure is hours,
-- not days), long enough to go back to the requester for clarification and
-- get an answer, and long enough that a single operator on holiday for a long
-- weekend still returns to it in time. Shorter and the warning arrives too
-- late to act on; much longer and it fires while the request is still
-- ordinary work, which trains the reader to ignore it. It is a proposed
-- number, like the rate limits SECURITY.md § 5 proposes: Q157 carries it.
--
-- ADDITIVE. The one non-additive-looking statement is dropping and re-adding
-- `incident_alerts`'s alert_type CHECK -- a WIDENING (every value it accepted
-- it still accepts), which is the only way to add a value to a CHECK
-- constraint, and it is re-added under an explicit name so the next widening
-- does not have to guess the generated one.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. TWO MORE ALERT TYPES
-- ---------------------------------------------------------------------------

alter table public.incident_alerts
  drop constraint incident_alerts_alert_type_check;

alter table public.incident_alerts
  add constraint incident_alerts_alert_type_known
  check (alert_type in ('rate_limit_tripped',
                        'repeated_login_failures',
                        'upload_quarantined',
                        'dsr_deadline_approaching',
                        'dsr_overdue'));

comment on constraint incident_alerts_alert_type_known on public.incident_alerts is
  'The closed list of incident alert types. Phase 7 Task 5 shipped the first three unnamed (incident_alerts_alert_type_check); Phase 8 Task 3 widened it to carry the two data-subject-request deadline alerts and gave it a name, so a later widening does not have to guess a generated constraint name. Mirrored by lib/admin/health.ts''s INCIDENT_ALERT_TYPE_LABELS, which the psql suite binds to this list.';

-- EXACTLY ONCE PER REQUEST PER STAGE. `details->>'request_id'` is written by
-- private.raise_dsr_deadline_alerts() alone; no other writer sets it, and the
-- partial predicate keeps this index off every other alert type.
create unique index incident_alerts_dsr_stage_once_idx
  on public.incident_alerts (alert_type, ((details ->> 'request_id')))
  where alert_type in ('dsr_deadline_approaching', 'dsr_overdue');


-- ---------------------------------------------------------------------------
-- 2. HOW FAR AHEAD THE EARLY WARNING FIRES
-- ---------------------------------------------------------------------------

create or replace function private.dsr_alert_lead_days()
returns integer
language sql
immutable
set search_path = ''
as $$ select 7 $$;

comment on function private.dsr_alert_lead_days() is
  'How many days before its 30-day deadline an open data subject request raises dsr_deadline_approaching: 7. A full working week -- enough to do the work, enough to go back to the requester and get an answer, and enough that a long weekend does not eat the margin. Shorter arrives too late to act on; much longer fires while the request is still ordinary work and trains the reader to ignore it. A proposed number (Q157), in one place, read by lib/dsr/contract.ts.';

revoke all on function private.dsr_alert_lead_days() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE WRITER
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER and granted to no client role: the only callers are the
-- cron job and a DBA. It writes nothing for a request that is closed --
-- fulfilled, rejected or withdrawn requests have no deadline left to miss --
-- and nothing a second time, because of the unique index.
--
-- SUMMARY AND DETAILS CARRY IDENTIFIERS ONLY. `public.data_subject_requests`
-- holds two free-text columns and neither appears here: incident_alerts is a
-- platform surface, and Phase 7's own rule (the quarantine alert records a
-- document id and never the filename) applies unchanged.

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
  -- alert even if it never got the quiet one (the platform could have been
  -- down for a week, or the request could have been filed with less than
  -- seven days of margin -- it cannot, today, but nothing should depend on
  -- that).
  insert into public.incident_alerts (alert_type, organisation_id, summary, details)
  select
    'dsr_overdue',
    -- Deliberately NULL even for a routed request. /super/health's
    -- "attributed to a workspace" filter means "this alert is about that
    -- workspace's traffic"; a DSR is the platform's own obligation, and the
    -- routed workspace is in `details` where it belongs.
    null,
    pg_catalog.format(
      'Data subject request %s (%s, %s) is OVERDUE: the 30-day statutory deadline passed on %s.',
      d.id, d.right_type, d.subject_scope, pg_catalog.to_char(d.due_by, 'YYYY-MM-DD')),
    pg_catalog.jsonb_build_object(
      'request_id',    d.id,
      'right_type',    d.right_type,
      'subject_scope', d.subject_scope,
      'status',        d.status,
      'due_by',        d.due_by,
      'routed_to_organisation_id', d.routed_to_organisation_id)
    from public.data_subject_requests d
   where d.status in ('open', 'in_progress', 'routed')
     and d.due_by <= pg_catalog.now()
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_written := v_written + v_rows;

  -- THE EARLY WARNING.
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
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_written := v_written + v_rows;

  return v_written;
end;
$$;

comment on function private.raise_dsr_deadline_alerts() is
  'Writes public.incident_alerts rows for data subject requests whose 30-day deadline has passed (dsr_overdue) or is within private.dsr_alert_lead_days() (dsr_deadline_approaching). Runs from the ONE pg_cron job, immediately before the digest that delivers it, so an alert raised on a tick is emailed on the same tick. A CLOSED request (fulfilled, rejected, withdrawn) raises nothing -- there is no deadline left to miss -- and a request already alerted at a stage raises nothing more, guaranteed by the partial unique index incident_alerts_dsr_stage_once_idx rather than by a racy `not exists`. Summary and details carry identifiers, enums and timestamps only: the request''s detail and any rejection reason are free text and never leave the DSR tables. Returns how many rows it wrote. SECURITY DEFINER, granted to no client role.';

revoke all on function private.raise_dsr_deadline_alerts() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. THE SAME ONE JOB, RE-POINTED
-- ---------------------------------------------------------------------------
-- cron.schedule() is upsert-by-name: this replaces the command of the
-- existing `incident-alert-delivery` job rather than adding a second job.
-- Local dev is unchanged and still a real no-op on the delivery half (no
-- Vault entries), while the raise half does real work with no configuration
-- at all -- which is why the alert ROWS can be asserted locally and the email
-- cannot.

select cron.schedule(
  'incident-alert-delivery',
  '*/10 * * * *',
  $job$select private.raise_dsr_deadline_alerts(); select private.deliver_incident_alerts()$job$
);

comment on extension pg_cron is
  'The product''s ONE scheduler, added in Phase 7 Task 6c for founder ruling Q118 and re-pointed in Phase 8 Task 3. Everything else in this schema deliberately uses read-time expiry instead (billing/feature overrides, the suspended-workspace directory clock, the feedback retention window) -- a schedule is here only because an email cannot be sent at read time, and because a deadline that nobody looks at is a deadline that is missed. Still exactly one job: `incident-alert-delivery`, every 10 minutes, running private.raise_dsr_deadline_alerts() (which writes the DSR deadline alerts) and then private.deliver_incident_alerts() (which delivers every unnotified alert, those included, in one digest).';
