-- ===========================================================================
-- PHASE 7 TASK 6c -- FOUNDER RULING Q118: THE INCIDENT-ALERT CLOCK LIVES IN
-- THE DATABASE (pg_cron + pg_net), NOT IN AN EXTERNAL/VERCEL CRON.
--
-- Task 5 built `public.incident_alerts.notified_at`; Task 6 wired
-- lib/email/incident-alerts.ts to send ONE Brevo digest of every unnotified
-- alert and stamp only after a successful send, behind
-- `POST /api/incident-alerts/deliver` (bearer secret, 404 when unset). NOTHING
-- CALLED IT, so an alert was a row on /super/health and never an email. The
-- founder chose the database as the owner of the clock. This migration is that
-- clock.
--
-- ===========================================================================
-- WHERE THE BEARER SECRET LIVES, AND WHY IT IS NOT IN THIS FILE
-- ===========================================================================
-- The job must present `Authorization: Bearer <INCIDENT_ALERT_DELIVERY_SECRET>`
-- -- the same value the Next.js route compares in constant time. A migration is
-- committed source, so the secret cannot be in it, cannot be a default
-- argument, and cannot be a seeded settings row.
--
-- THE CHOICE: SUPABASE VAULT (`vault.decrypted_secrets`), read at job time by
-- the SECURITY DEFINER function below. Considered and rejected:
--   * a custom GUC (`alter database ... set app.incident_bearer = ...`) --
--     readable by `current_setting()` from ANY session, including a client one
--     through a definer function, and it lands in pg_settings/pg_db_role_setting
--     in plaintext.
--   * a settings TABLE with an RLS policy -- RLS does not bind BYPASSRLS roles
--     and the value would still be plaintext in a heap and in every backup;
--     Vault at least encrypts at rest and keeps the plaintext out of dumps.
--   * baking it into the cron command string -- `cron.job.command` is a
--     plaintext, superuser-readable column, and the command is echoed in
--     pg_stat_activity on every tick.
--
-- SO: the secret (and the app's origin) are created ONCE PER ENVIRONMENT, by
-- hand, out of band, and never by this repository:
--
--     select vault.create_secret(
--       'https://app.example.com/api/incident-alerts/deliver',
--       'incident_alert_delivery_url',
--       'Where private.deliver_incident_alerts() POSTs (Q118).');
--     select vault.create_secret(
--       '<the same value as INCIDENT_ALERT_DELIVERY_SECRET>',
--       'incident_alert_delivery_secret',
--       'Bearer presented to /api/incident-alerts/deliver (Q118).');
--
-- SECURITY.md § 15 carries this as a pre-launch checklist item beside the four
-- environment values it pairs with.
--
-- ===========================================================================
-- LOCAL DEV IS A REAL NO-OP, NOT A FAKE SEND
-- ===========================================================================
-- The job IS registered locally -- it has to be, or "the schedule and command
-- are what we think they are" would be untestable -- but with no Vault entries
-- private.deliver_incident_alerts() returns before it builds a request. It
-- does not guess a localhost URL, it does not invent a secret, and it does not
-- call net.http_post with an empty bearer (which the route would answer 404 to
-- anyway, quietly turning a misconfiguration into a heartbeat that looks
-- healthy). No Vault entries = no HTTP, every ten minutes, silently and
-- correctly. `npx supabase db reset --local` therefore leaves a clock that
-- ticks and does nothing, which is exactly the local truth.
--
-- ===========================================================================
-- CADENCE: EVERY TEN MINUTES, AND THE DOUBLE-SEND THAT BUYS
-- ===========================================================================
-- Ten minutes is the queue entry's assumption and it is kept. An incident
-- alert is a Sev2/Sev3 signal in SECURITY.md § 12's table (the Sev1 path is a
-- human noticing, not an inbox), so a worst case of ten minutes' latency is
-- well inside the 24-hour response target, while a one-minute tick would
-- multiply pg_net rows and Brevo calls by ten for no response-time that
-- matters.
--
-- TWO OVERLAPPING RUNS CAN DOUBLE-*SEND* ONE DIGEST AND CANNOT DOUBLE-*STAMP*
-- IT. The sender stamps `where notified_at is null`, so the second stamp
-- matches nothing; both emails go out. That is accepted, and it is written
-- here so nobody "fixes" it with a claim-before-send: claiming would stamp
-- `notified_at` on a row NOTHING HAS EMAILED YET, and a crashed run would then
-- leave alerts marked delivered that never were. A duplicate email is the
-- honest failure; a silent undelivered alert is the dishonest one. (At ten
-- minutes, with a 15-second HTTP timeout below and a bounded 200-row digest,
-- overlap needs the route to hang for ten minutes, which the sender's own
-- 10-second Brevo timeout rules out.)
--
-- A FAILED SEND IS NOT A FAILED CLOCK. If Brevo, the route or the network is
-- down, the sender stamps nothing, the rows stay `notified_at is null`, and
-- the NEXT TICK picks up exactly the same set. Retry is the schedule; there is
-- no backoff, no dead-letter and no retry counter, because the work is
-- idempotent at the row level and the alert stays visible on /super/health the
-- whole time.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE TWO EXTENSIONS.
--
--    pg_cron lands in pg_catalog (its own default; the JOB API is the `cron`
--    schema either way) and pg_net in `extensions`, the Supabase convention.
--    Both are in this stack's shared_preload_libraries already, locally and on
--    hosted Supabase, so `create extension` is the whole of the install.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;


-- ---------------------------------------------------------------------------
-- 2. WHAT THE JOB RUNS.
--
--    SECURITY DEFINER because `vault.decrypted_secrets` is postgres-only and
--    must stay that way; granted to NO client role, so the only caller is the
--    cron job itself (and a DBA at a psql prompt).
-- ---------------------------------------------------------------------------

create or replace function private.deliver_incident_alerts()
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
  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'incident_alert_delivery_url';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'incident_alert_delivery_secret';

  -- UNCONFIGURED = NO-OP. Local dev, CI and any environment whose Vault has
  -- not been seeded reach this branch on every tick and do nothing at all.
  -- The length test mirrors the route's own `>= 32` rule, so a secret too
  -- short to be accepted there is never presented from here either.
  if v_url is null or pg_catalog.btrim(v_url) = ''
     or v_secret is null or pg_catalog.length(pg_catalog.btrim(v_secret)) < 32 then
    return;
  end if;

  -- Fire and forget: pg_net queues the request and a background worker makes
  -- it, so this returns immediately and the cron tick never blocks on Brevo.
  -- The RESPONSE is not read -- there is nothing this function could do with a
  -- failure that the next tick does not already do (the rows stay unstamped),
  -- and net._http_response keeps the status for a human who wants to look.
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

comment on function private.deliver_incident_alerts() is
  'THE INCIDENT-ALERT CLOCK''S BODY (founder ruling Q118). Runs from pg_cron every 10 minutes and POSTs /api/incident-alerts/deliver with the bearer, so the Task 6 sender empties `incident_alerts where notified_at is null` into one Brevo digest. The URL and the bearer come from Supabase Vault (`incident_alert_delivery_url` / `incident_alert_delivery_secret`), created by hand once per environment and NEVER by a migration -- with either missing this function returns without building a request, which is what local dev and CI do on every tick. SECURITY DEFINER for the Vault read; granted to no client role. Failure needs no handling: the sender stamps nothing on a failed send, so the next tick retries the identical set.';

revoke all on function private.deliver_incident_alerts() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE SCHEDULE.
--
--    cron.schedule() is upsert-by-name, so re-running this migration (or a
--    later one re-issuing the same name) re-points the job rather than
--    creating a second one.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'incident-alert-delivery',
  '*/10 * * * *',
  $job$select private.deliver_incident_alerts()$job$
);

comment on extension pg_cron is
  'The product''s ONE scheduler, added in Phase 7 Task 6c for founder ruling Q118. Everything else in this schema deliberately uses read-time expiry instead (billing/feature overrides, the suspended-workspace directory clock, the feedback retention window) -- a schedule is here only because an email cannot be sent at read time. Exactly one job: `incident-alert-delivery`, every 10 minutes, running private.deliver_incident_alerts().';
