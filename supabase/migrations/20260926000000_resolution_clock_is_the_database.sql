-- PHASE 8 TASK 3, FIX ROUND 2 -- R1: THE 7-DAY RE-RAISE READ A CLOCK THE
-- RESOLVING OPERATOR COULD SET.
--
-- Q159's re-raise decides on `incident_alerts.resolved_at`
-- (20260925002000:262-267: `a.resolved_at > now() - make_interval(days =>
-- dsr_alert_reraise_days())`). That column is CLIENT-WRITABLE: `authenticated`
-- holds a column-level UPDATE on exactly (resolved_at, resolved_by)
-- (20260919000000), and the only constraint naming it,
-- incident_alerts_resolution_pair, constrains the SHAPE of a resolution and
-- not its TIME. private.incident_alert_resolution_guard() pinned resolved_by
-- to auth.uid() and pinned nothing at all about resolved_at.
--
-- Measured by the scoped re-reviewer as the real aal2 superuser, through the
-- live policy, in a rolled-back transaction: resolve an alert with
-- `resolved_at = '2999-01-01'`, advance 60 days, and the tick writes ZERO --
--
--     status / days overdue / UNRESOLVED alerts / total alerts
--     open   / 75           / 0                 / 1
--
-- which is the ORIGINAL FINDING I3's end state, word for word. The fix round
-- moved the silence behind one extra field rather than removing it.
--
-- And the sharp half needs no crafted request at all: lib/admin/health-actions.ts
-- filled the column with `new Date().toISOString()` -- the OPERATOR'S BROWSER
-- CLOCK. So on the ordinary Resolve press the 7-day snooze was measured
-- against whatever the resolving machine believed the time was, and a laptop
-- days fast silently bought a longer snooze than Q159 specifies.
--
-- The fix is the rule every other stamp in this task already follows: THE
-- STAMP IS THE DATABASE'S. A client resolution's resolved_at is overwritten
-- with now() whatever the caller sent. Nothing an honest operator experiences
-- changes -- their browser was sending approximately now() anyway -- and the
-- crafted case stops existing rather than being detected. The same commit
-- stops the app supplying the column, so the database is not merely
-- correcting a value the app still computes.
--
-- DECISIONS-QUEUE Q162.
--
-- NOT changed here, and deliberately: the SYSTEM resolutions
-- (data_subject_request_closed, alert_writer_recovered) run SECURITY DEFINER
-- as postgres with row security inactive, so they take the guard's early
-- return and keep writing their own now() -- which they already did. The pin
-- is for client sessions, which is where the forgery lived.


-- ---------------------------------------------------------------------------
-- THE GUARD, REBUILT FROM ITS LATEST DEFINITION (20260925002000 § 2) WITH ONE
-- CLAUSE ADDED.
-- ---------------------------------------------------------------------------

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

  -- THE CLOCK IS THE DATABASE'S (fix round 2, R1 / Q162). A person resolving
  -- an alert says THAT they resolved it, never WHEN. The value is overwritten
  -- rather than refused, so the ordinary press keeps working with no round
  -- trip, and so a raw PATCH naming a future date is corrected instead of
  -- erroring -- there is nothing an operator can do to the Q159 re-raise
  -- arithmetic from a client session. resolved_by is null on a REOPEN (both
  -- columns go back to null) and on a SYSTEM resolution (which never reaches
  -- here), so this clause fires on exactly the client resolutions.
  if new.resolved_by is not null then
    new.resolved_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

comment on function private.incident_alert_resolution_guard() is
  'The column gate behind incident_alerts_update_platform: a client update may move resolved_at/resolved_by (resolved_by forced to auth.uid(), resolved_at forced to now()) and nothing else. Everything except the resolution flag is immutable from any client path -- alert content is written once, by the definer writers, and stays what it was. BOTH delivery seams are in the immutable set on purpose: `notified_at` belongs to the operator''s digest sender and `account_notified_at` (Q114) to the account-holder notification. So is `auto_resolved_reason` (Phase 8 Task 3 fix round 1, 20260925002000): only the system says the system resolved something. An alert the system resolved can be neither reopened nor claimed by a person -- incident_alerts_resolution_pair refuses both. SINCE FIX ROUND 2 (20260926000000, R1/Q162) THE RESOLUTION TIME IS THE DATABASE''S: a client resolution''s resolved_at is overwritten with now() whatever the caller sent, because Q159''s 7-day re-raise decides on that column and `authenticated` holds a column-level UPDATE on it -- a resolution dated into the future was a permanent snooze that put an open request back at "0 unresolved alerts, 75 days overdue". System resolutions run with row security inactive and take the early return above, so they keep writing their own now().';
