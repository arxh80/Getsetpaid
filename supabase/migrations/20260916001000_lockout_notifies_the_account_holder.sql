-- ===========================================================================
-- PHASE 7 TASK 6c -- FOUNDER RULING Q114: THE PER-ACCOUNT LOCKOUT MUST EMAIL
-- THE ACCOUNT HOLDER.
--
-- Task 5 shipped the lockout (5 failed password attempts / 15 min, enforced in
-- GoTrue's password-verification hook) with NO notification, and SECURITY.md
-- § 5 disclosed the cost honestly: anyone who knows an email address can keep
-- that account out of password sign-in indefinitely, with magic link and
-- Google SSO as the escape hatch. The founder wants the account holder told.
--
-- The `repeated_login_failures` alert row already exists -- written exactly
-- once per lockout window by private.record_rate_limit_event()'s crossing
-- write -- so this is a delivery seam, not new machinery.
--
-- ===========================================================================
-- A SECOND SEAM COLUMN, NOT A SECOND USE OF `notified_at`
-- ===========================================================================
-- `notified_at` means "the OPERATOR's digest carried this row". This
-- notification goes to a completely different person, on a different schedule
-- of failure: Brevo can accept the digest and refuse the account mail, or the
-- other way round. Folding both into one column would mean either stamping a
-- delivery that did not happen or re-sending a digest because an unrelated
-- email failed. So `account_notified_at` is its own column with its own
-- retry, and the two seams cannot interfere.
--
-- BOTH SEAMS ARE IMMUTABLE FROM A CLIENT SESSION. The resolution guard is
-- reissued below with `account_notified_at` in its immutable set, for the same
-- reason `notified_at` is there: an operator's browser must not be able to
-- suppress a notification without one being sent.
--
-- ===========================================================================
-- THE CAP IS STRUCTURAL, AND WHAT AN ATTACKER CAN STILL CAUSE
-- ===========================================================================
-- The brief's abuse is real and unavoidable in kind: the notification is
-- reachable by failing someone's login, so an attacker who knows an address
-- can now generate MAIL to that person as well as lock them out. Three things
-- bound it, and none of them is a per-send counter bolted on afterwards:
--
--   1. ONE ALERT PER LOCKOUT WINDOW. The alert is written only at
--      `request_count = max_requests + 1` -- the crossing, exactly once per
--      fixed 15-minute window. Attempts 7, 8 ... 10,000 in that window write
--      no further row, so they can produce no further email. The ceiling is
--      therefore 4 emails/hour/account however hard the account is hammered,
--      and it is a property of the counter rather than of this code.
--   2. ONE EMAIL PER ACCOUNT PER DELIVERY RUN. public.pending_lockout_
--      notifications() below GROUPS BY account, so a backlog (the clock down
--      for an hour, four windows crossed) is one email naming the most recent
--      window, not four.
--   3. NO ADDRESS IS EVER DISCLOSED. The recipient is resolved inside this
--      SECURITY DEFINER function from `auth.users`, keyed by the alert's own
--      `details->>'subject_id'` -- an id the hook put there, never anything a
--      request supplied. The sender never learns an address it was not given
--      and never emails anyone but the account itself; the attempt details go
--      to nobody else at all, and no password, token or attempted credential
--      is read, stored or logged anywhere on this path.
--
-- WHAT REMAINS: ~4 emails/hour to one address the attacker already knows,
-- saying truthfully that someone is failing to sign in. SECURITY.md § 5
-- states it rather than implying it is closed.
--
-- ===========================================================================
-- WHY THE RECIPIENT LOOKUP IS A DEFINER FUNCTION AND NOT `auth.admin` IN TS
-- ===========================================================================
-- lib/supabase/service.ts is deliberately "the two notification tables and one
-- stamped column each", policed by a source census. Reaching for
-- `auth.admin.getUserById()` there would widen that client to the whole GoTrue
-- Admin API for one email address. Instead this function is the chokepoint:
-- granted to `service_role` ONLY, it returns exactly (account, address, the
-- alert ids to stamp) for alerts that are pending, and nothing else. The
-- sender cannot ask it for an arbitrary user's address, because it takes no
-- user as an argument.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE SECOND SEAM COLUMN.
-- ---------------------------------------------------------------------------

alter table public.incident_alerts
  add column account_notified_at timestamptz;

comment on column public.incident_alerts.account_notified_at is
  'THE ACCOUNT-HOLDER SEAM (founder ruling Q114), the `notified_at` twin and deliberately NOT the same column: that one means "the operator''s digest carried this row", this one means "the person whose account it is has been told". Only ever set on `repeated_login_failures` rows. Null = not yet told; lib/email/lockout-notification.ts sends through the one Brevo sender and stamps this ONLY on ok:true, so a failed send leaves it null and the next cron tick retries. A client session can never move it -- private.incident_alert_resolution_guard() keeps it in the immutable set beside notified_at, so an operator cannot suppress a customer''s security notification.';

-- The sender stamps it; the operator's browser may not (the guard below).
grant update (account_notified_at) on public.incident_alerts to service_role;

-- The delivery query reads `where alert_type = ... and account_notified_at is
-- null`; partial, so it indexes only the work that is left.
create index incident_alerts_account_pending_idx
  on public.incident_alerts (created_at)
  where alert_type = 'repeated_login_failures' and account_notified_at is null;


-- ---------------------------------------------------------------------------
-- 2. THE GUARD, REISSUED -- account_notified_at joins the immutable set.
--    Body copied from 20260909020000 § 3 with one clause added; the
--    resolution branch and the rolbypassrls exemption are unchanged.
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
  'The column gate behind incident_alerts_update_platform: a client update may move resolved_at/resolved_by (together, per the table CHECK; resolved_by forced to auth.uid()) and nothing else. Everything except the resolution flag is immutable from any client path -- alert content is written once, by the definer writers, and stays what it was. BOTH delivery seams are in the immutable set on purpose: `notified_at` belongs to the operator''s digest sender and `account_notified_at` (Q114) to the account-holder notification, and neither belongs to the operator''s browser -- an alert must not be silenceable without the mail going out.';


-- ---------------------------------------------------------------------------
-- 3. WHAT THE SENDER ASKS FOR. One row per ACCOUNT, not per alert.
-- ---------------------------------------------------------------------------

create or replace function public.pending_lockout_notifications(p_limit integer default 100)
returns table (
  account_user_id uuid,
  email           text,
  alert_ids       uuid[],
  latest_at       timestamptz,
  max_requests    integer,
  window_seconds  integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    u.email::text,
    pg_catalog.array_agg(a.id order by a.created_at),
    pg_catalog.max(a.created_at),
    -- The policy numbers the copy quotes ("5 failed attempts", "15 minutes")
    -- come from the ALERT, which the limiter wrote from
    -- public.rate_limit_policies -- so the email cannot describe a lockout the
    -- database is not enforcing, even if § 5's numbers change by UPDATE.
    pg_catalog.max((a.details->>'max_requests')::integer),
    pg_catalog.max((a.details->>'window_seconds')::integer)
  from public.incident_alerts a
  join auth.users u
    on u.id = (a.details->>'subject_id')::uuid
  where a.alert_type = 'repeated_login_failures'
    and a.account_notified_at is null
    -- The hook always writes a uuid here; the shape test means a malformed
    -- row can never make the cast raise and take the whole run down with it.
    and a.details->>'subject_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and a.details->>'max_requests'   ~ '^[0-9]+$'
    and a.details->>'window_seconds' ~ '^[0-9]+$'
    and u.email is not null
    and u.email <> ''
  group by u.id, u.email
  order by pg_catalog.max(a.created_at)
  -- `least`/`greatest` are PARSER CONSTRUCTS, not functions -- unqualified on
  -- purpose under search_path = '' (the 20260911000000 precedent, and the
  -- thing tests/unit/security/pg-catalog-constructs.test.ts exists to catch).
  limit least(greatest(p_limit, 1), 500);
$$;

comment on function public.pending_lockout_notifications(integer) is
  'What lib/email/lockout-notification.ts asks for, and the ONLY path by which the account-holder notification learns an address (founder ruling Q114). One row PER ACCOUNT -- the alert ids are aggregated -- so a backlog of lockout windows is one email and one stamp, not several. Takes no user argument: it cannot be asked for a chosen person''s address, only for the accounts that currently have an unnotified `repeated_login_failures` alert. SECURITY DEFINER for the auth.users join; EXECUTE granted to service_role ALONE (no session role can call it, and no policy exposes auth.users to one). Returns nothing about the attempts themselves beyond when the last one crossed -- never an IP, never a password, never a token.';

revoke all on function public.pending_lockout_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.pending_lockout_notifications(integer) to service_role;
