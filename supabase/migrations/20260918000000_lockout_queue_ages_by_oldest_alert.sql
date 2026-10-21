-- ===========================================================================
-- PHASE 7 TASK 6c -- FIX ROUND 2, REVIEW FINDING N3: THE ACCOUNT UNDER ACTIVE
-- ATTACK MUST NOT SORT TO THE BACK OF THE NOTIFICATION QUEUE.
--
-- Fix round 1 bounded the lockout-notification run (30 accounts per tick,
-- 20260917000000's header explains why a pg_net advisory lock cannot do the
-- job). The bound is right. Its interaction with this function's ORDERING was
-- not, and the two together invert founder ruling Q114's whole intent.
--
-- ===========================================================================
-- THE DEFECT, PRECISELY
-- ===========================================================================
-- The function shipped `order by pg_catalog.max(a.created_at)` -- each
-- account's MOST RECENT unnotified alert, ascending. An account that is still
-- being hammered re-crosses its 15-minute lockout window every 15 minutes, and
-- each crossing writes a fresh alert. Its `max(created_at)` therefore ADVANCES
-- while it waits, and it sorts BEHIND every account whose attack has paused.
--
-- With a spray keeping the per-tick cap full, the accounts still under attack
-- are the ones deferred on every tick -- and they are exactly the accounts the
-- notification exists for. Not permanent starvation (the timestamp stops
-- advancing when the attack stops), but starvation for precisely as long as
-- the attack lasts, which is the window in which the email is worth anything.
--
-- ===========================================================================
-- THE FIX, AND WHY IT IS STARVATION-PROOF BY CONSTRUCTION
-- ===========================================================================
-- `order by pg_catalog.min(a.created_at)` -- each account's OLDEST STILL-
-- UNNOTIFIED alert. That value can only ever move in one direction for a
-- waiting account: it cannot advance, because new alerts are newer than the
-- minimum and the minimum is only cleared by the stamp that means the email
-- WENT. So an account that waits ages monotonically towards the front of the
-- queue however hard it is being hammered, and the longest-waiting account is
-- always the next one served. That is a property of the ordering rather than
-- of a counter someone has to maintain.
--
-- NOTHING ELSE CHANGES. `latest_at` stays `max(created_at)` -- the email names
-- the MOST RECENT lockout window, which is what the copy quotes and what the
-- account holder cares about. The ordering decides who is served; the payload
-- is untouched. Body is otherwise copied verbatim from its LATEST definition,
-- 20260916001000 § 3; one line differs.
--
-- Proven in supabase/tests/rls_phase7_rate_limits.sql § RD28-RD31, against a
-- SATURATED queue rather than by reading the clause: two pending accounts, one
-- still under attack and one quiet, and a queue with room for one. Under the
-- old ordering the quiet account is served and the hammered one is deferred;
-- under this one the hammered account is served. The queue's capacity IS
-- `p_limit` (lib/email/lockout-notification.ts clamps it to 30), so saturating
-- it through that parameter exercises the same cap-plus-ordering interaction
-- the 30-account case does, without needing thirty real auth.users rows.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

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
  -- THE OLDEST UNNOTIFIED ALERT, NOT THE NEWEST (fix round 2, N3). See the
  -- header: max() advances while an account waits under a continuing attack,
  -- so it sorted the victim behind everyone else on every capped tick. min()
  -- cannot advance while an account waits, so waiting always earns priority.
  order by pg_catalog.min(a.created_at)
  -- `least`/`greatest` are PARSER CONSTRUCTS, not functions -- unqualified on
  -- purpose under search_path = '' (the 20260911000000 precedent, and the
  -- thing tests/unit/security/pg-catalog-constructs.test.ts exists to catch).
  limit least(greatest(p_limit, 1), 500);
$$;

comment on function public.pending_lockout_notifications(integer) is
  'What lib/email/lockout-notification.ts asks for, and the ONLY path by which the account-holder notification learns an address (founder ruling Q114). One row PER ACCOUNT -- the alert ids are aggregated -- so a backlog of lockout windows is one email and one stamp, not several. ORDERED BY THE OLDEST UNNOTIFIED ALERT per account (fix round 2, review finding N3): the previous ordering, by the most RECENT alert, advanced while an account waited and therefore pushed the account still under active attack behind every quieter one on each capped tick -- the inverse of what Q114 is for. min() cannot advance while an account waits, so the longest-waiting account is always served next and the per-tick cap cannot starve anyone. `latest_at` is still max(), because the email names the most recent lockout window. Takes no user argument: it cannot be asked for a chosen person''s address, only for the accounts that currently have an unnotified `repeated_login_failures` alert. SECURITY DEFINER for the auth.users join; EXECUTE granted to service_role ALONE (no session role can call it, and no policy exposes auth.users to one). Returns nothing about the attempts themselves beyond when the last one crossed -- never an IP, never a password, never a token.';

-- The grant is unchanged and re-stated so `create or replace` cannot silently
-- drift it: service_role alone, nobody else, ever.
revoke all on function public.pending_lockout_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.pending_lockout_notifications(integer) to service_role;
