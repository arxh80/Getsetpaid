-- Phase 7 Task 5, fix round 1, review finding I2: the 10/hour connection-request
-- budget was enforced in the APPLICATION ONLY, and the table it protects
-- carries a client INSERT grant and a permissive INSERT policy.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- `public.network_connection_requests` grants INSERT to `authenticated` and
-- `network_connection_requests_insert_manage_connections` permits the row.
-- The only meter was `consumeRateLimit()` inside
-- `sendConnectionRequestAction`. So the exact actor Q79's mitigation targets --
-- a user who legitimately holds `manage_network_connections` in a publishing
-- workspace -- could `POST /rest/v1/network_connection_requests` with the anon
-- key and a session JWT, unlimited, and never touch the application. The
-- casual clicker was metered; the scripted one was not, and no
-- `rate_limit_tripped` alert was written either, so the "first operator-visible
-- signal of network harassment" was silent for precisely the harasser worth
-- detecting.
--
-- The task-5 report defended this with the PostgREST read-only-transaction
-- argument. That argument is SOUND FOR A GET and FALSE FOR A POST: PostgREST
-- runs writes in a read-write transaction (the report proves it itself -- "the
-- identical POST succeeds"), so a BEFORE INSERT trigger CAN meter this path.
-- Q86's no-SECURITY-DEFINER-search-function constraint is not engaged: nothing
-- here reshapes a read path.
--
-- ===========================================================================
-- ONE METER, NOT TWO -- AND WHY THE APP-SIDE CALL IS REMOVED IN THE SAME COMMIT
-- ===========================================================================
-- If both the action and this trigger spent the budget, one click would cost
-- two units and the shipped limit would silently become 5/hour. So the meter
-- MOVES rather than doubling: `sendConnectionRequestAction` no longer calls
-- `consumeRateLimit`, and this trigger is the single enforcement point for
-- every writer -- the app's own form, a stripped-form post, and a raw
-- PostgREST INSERT alike.
--
-- ===========================================================================
-- THE PRE-CHECK, AND WHY IT IS NOT THE SAME SHAPE AS THE APP PATH
-- ===========================================================================
-- 20260909020000's header explains at length why the limiter core RETURNS a
-- verdict instead of raising: a RAISE rolls back its own transaction, so a
-- raising limiter un-counts every refusal and un-writes its own alert. A
-- trigger has no choice -- refusing an INSERT means raising -- so this function
-- is arranged so that the refusal has NOTHING to roll back:
--
--   1. READ the current window's count. If the budget is already spent, raise
--      immediately, having written nothing. The counter stays exactly at the
--      limit, so the refusal is repeatable and correct, and no alert row is
--      lost to a rollback because none was attempted.
--   2. Otherwise increment through the shared core. A concurrent pair that
--      both passed step 1 can push the count one past the limit; the
--      post-check catches that and raises, and the rollback of THAT
--      increment restores the counter -- which is why the two checks are not
--      redundant.
--   3. File the crossing alert at the LAST ACCEPTED request (count = max)
--      rather than at max + 1. The core's own max+1 alert can never fire on
--      this path, because the count never commits above max. Exactly once per
--      window either way: only one request in a window can observe count = max.
--
-- The cost, stated rather than hidden: this category's counter does NOT
-- measure pressure past the limit the way every other category's does. An
-- abuser who keeps posting after being refused adds nothing to the count, so
-- "11" means "hit the ceiling", not "tried 4,000 times". Queued as Q115 with a
-- recommended default; the alternative (counting refusals) needs a write that
-- survives a rejected INSERT, which Postgres has no mechanism for short of the
-- dblink autonomous-transaction hack 20260909020000 already rejected as worse
-- than the exposure.
--
-- ===========================================================================
-- METERED AFTER AUTHORISATION, LIKE THE APP PATH WAS
-- ===========================================================================
-- A BEFORE INSERT trigger runs BEFORE the policy's WITH CHECK is evaluated. So
-- an unauthorised caller naming a victim workspace in `from_organisation_id`
-- would burn the VICTIM's budget on rows the policy was about to reject --
-- a denial of service through the limiter, the same hole
-- `consume_rate_limit`'s membership check closes for org-scoped budgets, and
-- the same class as fix round 1's I1. So the trigger re-tests the two
-- ACTOR-level terms of `network_connection_requests_insert_manage_connections`
-- (permission and publishing plan) and, if either fails, spends nothing and
-- returns -- leaving the policy to do the refusing, which it still does. The
-- profile-ownership terms are deliberately not re-tested: they are about the
-- ROW, not the actor, and a member who holds the permission spending their own
-- workspace's budget on a malformed pair is spending their own budget, exactly
-- as the app path did.
--
-- ===========================================================================
-- THE REFUSAL IS 429-SHAPED, NOT AN OPAQUE 500
-- ===========================================================================
-- The exception is raised with SQLSTATE `PT429`, PostgREST's documented
-- "return this HTTP status" escape -- so a direct REST caller gets a real 429
-- and `sendConnectionRequestAction` gets a code it can distinguish from the
-- 42501 (unreachable profile) and 23505 (a live request already stands) it
-- already handles. The remaining seconds in the window ride in `hint`, which
-- PostgREST and supabase-js both surface, so the app can render a human
-- duration without re-deriving the window arithmetic.
--
-- ===========================================================================
-- WHY THE FIXTURE EXEMPTION IS auth.uid(), NOT row_security_active()
-- ===========================================================================
-- Every guard trigger in this schema exempts `postgres`/`service_role` with
-- `if not row_security_active(...)`, and every one of them is SECURITY
-- INVOKER, which is what makes that test mean "the caller has RLS applied to
-- them". This function must be SECURITY DEFINER -- the limiter core is granted
-- to no client role -- so inside it the current user is the owner and
-- `row_security_active()` is false for EVERY caller, browsers included. The
-- test here is therefore `auth.uid() is null`, the one
-- `private.audit_crm_row()` and `private.audit_network_row()` already use for
-- the same reason: a migration, a seed or a fixture is not a client action.
--
-- ADDITIVE. No previously applied migration is edited; the INSERT policy, the
-- grants and the four existing triggers are untouched.

create or replace function private.meter_connection_request()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
  v_after  integer;
  v_retry  integer;
begin
  -- NOT A CLIENT SEND: a migration, a seed or a test fixture inserting as
  -- `postgres` has no session, spends nobody's budget and is not what this
  -- meters. The test is `auth.uid() is null`, the one
  -- private.audit_crm_row()/private.audit_network_row() use, and deliberately
  -- NOT row_security_active(): this function is SECURITY DEFINER (the limiter
  -- core is granted to no client role), so row_security_active() inside it is
  -- evaluated as the owner and is false for EVERY caller -- copying the
  -- invoker-side guard pattern here would make the meter a no-op.
  if (select auth.uid()) is null then
    return new;
  end if;

  select * into v_policy
  from public.rate_limit_policies p
  where p.category = 'network_connection_request';
  if not found then
    -- FAIL CLOSED. A missing policy row is a broken deployment, not a licence
    -- to send without a budget.
    raise exception 'meter_connection_request: no rate-limit policy for network_connection_request'
      using errcode = '22023';
  end if;

  -- METER AFTER AUTHORISATION (see the header). If the actor could not have
  -- sent this anyway, the policy refuses it and no budget is spent.
  if new.from_organisation_id is null
     or new.from_organisation_id not in (
          select private.permitted_organisations('manage_network_connections'))
     or new.from_organisation_id not in (
          select private.network_publish_organisations()) then
    return new;
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  -- `greatest` is a parser construct, not a pg_catalog function, so it is
  -- deliberately unqualified even under `search_path = ''` -- the same way
  -- 20260909020000's core writes it.
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
  from public.rate_limit_counters c
  where c.category      = 'network_connection_request'
    and c.subject_scope = 'organisation'
    and c.subject_id    = new.from_organisation_id
    and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  -- (1) THE BUDGET IS ALREADY SPENT. Nothing written, so nothing is lost to
  -- the rollback this raise causes.
  if v_count >= v_policy.max_requests then
    raise exception 'network_connection_requests: this workspace has reached its connection-request limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (2) COUNT IT.
  select r.request_count into v_after
  from private.record_rate_limit_event(
         'network_connection_request', 'organisation',
         new.from_organisation_id, new.from_organisation_id) r;

  -- (2b) THE RACE. Two callers can both pass (1) at count = max - 1. The
  -- second one's own increment is what this rolls back.
  if v_after > v_policy.max_requests then
    raise exception 'network_connection_requests: this workspace has reached its connection-request limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (3) THE CROSSING ALERT, at the last accepted request. See the header for
  -- why it cannot be the core's own max+1 write on this path.
  if v_after = v_policy.max_requests then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'rate_limit_tripped',
      new.from_organisation_id,
      pg_catalog.format(
        'Rate limit reached: network_connection_request (limit %s per %s seconds).',
        v_policy.max_requests, v_policy.window_seconds),
      pg_catalog.jsonb_build_object(
        'category',       'network_connection_request',
        'subject_scope',  'organisation',
        'subject_id',     new.from_organisation_id,
        'window_start',   v_window,
        'max_requests',   v_policy.max_requests,
        'window_seconds', v_policy.window_seconds,
        -- Distinguishes this path's semantics from every other category's:
        -- the count stops at the limit here, so it is not a pressure figure.
        'counts_refusals', false
      )
    );
  end if;

  return new;
end;
$$;

comment on function private.meter_connection_request() is
  'Q79/Q112''s 10-per-hour-per-organisation connection-request budget, enforced AT THE WRITE so it holds for every writer -- the app''s form, a stripped-form post and a raw PostgREST INSERT alike (fix round 1, review finding I2: the app-side meter was bypassable by a direct INSERT, and PostgREST''s read-only-GET argument does not apply to a POST). Reads the current window before writing so a refusal has nothing to roll back, raises PT429 (a real HTTP 429 through PostgREST) with the remaining seconds in `hint`, and files the crossing alert at the LAST ACCEPTED request because a refused INSERT cannot commit one. Spends nothing when the caller could not have sent the row anyway, so a stranger cannot burn a victim workspace''s budget through a row the policy is about to reject. Does NOT count past the limit, unlike every other category (Q115).';

create trigger meter_connection_request
  before insert on public.network_connection_requests
  for each row execute function private.meter_connection_request();
