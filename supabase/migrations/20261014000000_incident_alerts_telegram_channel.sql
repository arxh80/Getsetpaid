-- PHASE 8 TASK 9b, JOB 1 -- TELEGRAM AS A SECOND INCIDENT-ALERT CHANNEL.
--
-- Founder 2026-09-30, Q111: incident alerts go by email, a dashboard
-- notification and a Telegram bot (`@getsetpaid_bot`); Telegram replaces SMS.
-- A message carries the alert type, counts and a /super/health link ONLY.
--
-- THE CHANNEL GETS ITS OWN STAMP, AND THAT IS THE WHOLE OF THIS MIGRATION.
-- `notified_at` means "the operator's email digest carried this row". If the
-- Telegram send stamped that column too, a Telegram success would silence an
-- email that never went, and a Telegram failure could not be retried without
-- re-sending the email. So -- exactly as `account_notified_at` did for the
-- account-holder notice (20260916001000, Q114) -- the second channel is a
-- second column:
--
--   * lib/email/incident-alerts.ts's Telegram half reads
--     `where telegram_notified_at is null`, sends ONE counts-only message, and
--     stamps this column ONLY after Telegram answered ok:true;
--   * the email half never reads or writes it, and the Telegram half never
--     reads or writes `notified_at`. Each channel is re-sendable on its own.
--
-- WHO MAY MOVE IT. `service_role` -- the sender -- gets UPDATE on this ONE
-- column. `authenticated` gets nothing: since 20260919000000 its UPDATE is
-- column-level on (resolved_at, resolved_by), so a new column is outside the
-- grant and fails closed with 42501 by construction. The resolution guard is
-- reissued below with the column in its immutable set anyway -- defence in
-- depth, the same two independent controls the other two seams have.
--
-- BACKLOG ON FIRST DEPLOY, STATED RATHER THAN HIDDEN. Every existing row
-- starts `telegram_notified_at is null`, so the first configured run sends a
-- counts-only message covering up to 200 historical alerts per tick until the
-- backlog drains. No backfill: stamping rows "delivered" that no Telegram
-- message carried is the dishonest direction for a delivery stamp, and the
-- message carries no personal data whatever it counts.

-- ---------------------------------------------------------------------------
-- 1. THE THIRD SEAM COLUMN.
-- ---------------------------------------------------------------------------

alter table public.incident_alerts
  add column telegram_notified_at timestamptz;

comment on column public.incident_alerts.telegram_notified_at is
  'THE TELEGRAM SEAM (founder 2026-09-30, Q111), the `notified_at` twin and deliberately NOT the same column: that one means "the operator''s email digest carried this row", this one means "a Telegram alert message counted this row". Null = not yet counted; lib/email/incident-alerts.ts sends one counts-only message (alert type, count, /super/health link -- no personal data, no tenant content, no ids) and stamps this ONLY on ok:true, so a failed send leaves it null and the next cron tick retries. Independent of the email stamp in both directions. Writable by service_role alone (column-level grant); a client session can never move it -- outside authenticated''s column grant, and in private.incident_alert_resolution_guard()''s immutable set.';

grant update (telegram_notified_at) on public.incident_alerts to service_role;

-- The Telegram half reads `where telegram_notified_at is null order by
-- created_at, id`; partial, so it indexes only the work that is left.
create index incident_alerts_telegram_pending_idx
  on public.incident_alerts (created_at, id)
  where telegram_notified_at is null;


-- ---------------------------------------------------------------------------
-- 2. THE GUARD, REBUILT FROM ITS LATEST DEFINITION (20260926000000) WITH
--    telegram_notified_at ADDED TO THE IMMUTABLE SET. Nothing else changes.
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
     or new.telegram_notified_at is distinct from old.telegram_notified_at
     or new.auto_resolved_reason is distinct from old.auto_resolved_reason
     or new.id                  is distinct from old.id then
    raise exception 'incident_alerts: only the resolution flag (resolved_at, resolved_by) is client-writable'
      using errcode = '42501';
  end if;

  if new.resolved_at is not null and new.resolved_by is distinct from (select auth.uid()) then
    raise exception 'incident_alerts: resolved_by must be the resolving caller'
      using errcode = '42501';
  end if;

  -- THE CLOCK IS THE DATABASE'S (20260926000000, R1 / Q162).
  if new.resolved_by is not null then
    new.resolved_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

comment on function private.incident_alert_resolution_guard() is
  'The column gate behind incident_alerts_update_platform: a client update may move resolved_at/resolved_by (resolved_by forced to auth.uid(), resolved_at forced to now()) and nothing else. Everything except the resolution flag is immutable from any client path -- alert content is written once, by the definer writers, and stays what it was. ALL THREE delivery seams are in the immutable set on purpose: `notified_at` belongs to the operator''s email digest, `account_notified_at` (Q114) to the account-holder notification and `telegram_notified_at` (Q111, 20261014000000) to the Telegram alert channel -- an alert must not be silenceable from a browser without the message going out. So is `auto_resolved_reason` (Phase 8 Task 3 fix round 1, 20260925002000): only the system says the system resolved something. An alert the system resolved can be neither reopened nor claimed by a person -- incident_alerts_resolution_pair refuses both. SINCE 20260926000000 (R1/Q162) THE RESOLUTION TIME IS THE DATABASE''S: a client resolution''s resolved_at is overwritten with now() whatever the caller sent. System resolutions run with row security inactive and take the early return above, so they keep writing their own now().';


-- ---------------------------------------------------------------------------
-- 3. THE CLOCK'S COMMENT, REISSUED: the route it calls now has a third
--    delivery, and the overlap arithmetic in the shipped comment
--    (20260917000000) is ten seconds short of true.
-- ---------------------------------------------------------------------------

comment on function private.deliver_incident_alerts() is
  'THE INCIDENT-ALERT CLOCK''S BODY (founder ruling Q118). Runs from pg_cron every 10 minutes and POSTs /api/incident-alerts/deliver with the bearer. That route runs THREE independent deliveries, each with its own stamp: the operator''s email digest (`notified_at`), the counts-only Telegram alert (`telegram_notified_at`, Q111, 20261014000000) and the per-account lockout email (`account_notified_at`, Q114). The URL and the bearer come from Supabase Vault (`incident_alert_delivery_url` / `incident_alert_delivery_secret`), created by hand once per environment and NEVER by a migration -- with either missing this function returns without building a request, which is what local dev and CI do on every tick. SECURITY DEFINER for the Vault read; granted to no client role. Failure needs no handling: each sender stamps nothing on a failed send, so the next tick retries the identical set for that channel alone. OVERLAP is ruled out in the ROUTE: one 10-second Brevo call for the digest, one 10-second Telegram call, and the lockout loop capped at 30 accounts and a 120-second wall-clock budget, so the worst case is ~150 s against a 600 s cadence. An advisory lock HERE would not help -- net.http_post is fire-and-forget, so this function returns before the route runs.';
