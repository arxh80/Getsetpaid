-- Phase 7 Task 5, fix round 1, minor M6: the login hook fails closed BY
-- ACCIDENT rather than by construction.
--
-- `public.hook_password_verification_attempt` looks its policy up with
--
--   select * into v_policy from public.rate_limit_policies p
--    where p.category = 'login_account';
--
-- and, unlike every other lookup in `20260909020000`, carries no `if not
-- found` guard. If that seed row were ever missing, `v_policy.window_seconds`
-- is null, `private.rate_limit_window_start(now(), null)` returns null, the
-- counter lookup matches nothing, `v_count` is 0, the lockout comparison
-- (`0 >= null`) is null and therefore not true, and the function falls through
-- to `private.record_rate_limit_event()` -- which raises 22023 on the unknown
-- category. So it does fail closed, via two accidents in sequence, and a
-- future edit to either of them would turn the missing row into an unmetered
-- sign-in path with nothing to say so.
--
-- The two sibling functions in that migration both carry the explicit check.
-- This one now does too, in the same shape and with the same SQLSTATE, so the
-- behaviour is stated rather than emergent. Nothing else changes: the counting,
-- the lockout, the correct-password rejection (§ RH4, the load-bearing one),
-- the reset on success and the exactly-once alert are byte-for-byte the
-- function that shipped.
--
-- ADDITIVE. No previously applied migration is edited.

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_valid   boolean;
  v_policy  public.rate_limit_policies%rowtype;
  v_window  timestamptz;
  v_count   integer;
begin
  v_user_id := (event->>'user_id')::uuid;
  v_valid   := coalesce((event->>'valid')::boolean, false);

  if v_user_id is null then
    -- A malformed event is GoTrue's bug, not a sign-in; refuse loudly.
    raise exception 'hook_password_verification_attempt: event carries no user_id'
      using errcode = '22023';
  end if;

  select * into v_policy from public.rate_limit_policies p where p.category = 'login_account';
  -- FAIL CLOSED BY CONSTRUCTION, not by two accidents in sequence (fix round 1,
  -- M6). GoTrue surfaces a hook error as a failed login, so raising here means
  -- password sign-in stops working -- which is the correct answer to "the
  -- lockout policy is missing", and the visible one.
  if not found then
    raise exception 'hook_password_verification_attempt: no rate-limit policy for login_account'
      using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  select c.request_count into v_count
  from public.rate_limit_counters c
  where c.category = 'login_account'
    and c.subject_scope = 'account'
    and c.subject_id = v_user_id
    and c.window_start = v_window;
  v_count := coalesce(v_count, 0);

  -- LOCKED OUT: the budget of failed attempts is spent, so THIS attempt is
  -- rejected before its own verdict matters -- a correct password does not
  -- lift a lockout early (or the brute force just continues until it works).
  -- The refused attempt is still counted (pressure telemetry, and the
  -- max+1 crossing inside the core is what files the repeated_login_failures
  -- alert exactly once per window).
  if v_count >= v_policy.max_requests then
    perform private.record_rate_limit_event('login_account', 'account', v_user_id);
    return pg_catalog.jsonb_build_object(
      'decision', 'reject',
      'message',  'Too many failed sign-in attempts. Wait 15 minutes and try again.'
    );
  end if;

  if v_valid then
    -- A successful sign-in clears the slate -- standard lockout semantics.
    -- Without the reset, five typos spread over months would lock the
    -- account, because fixed windows only forget rows the cleanup reaches.
    delete from public.rate_limit_counters c
    where c.category = 'login_account'
      and c.subject_scope = 'account'
      and c.subject_id = v_user_id;
    return pg_catalog.jsonb_build_object('decision', 'continue');
  end if;

  -- A failed attempt inside the budget: count it, let GoTrue return its own
  -- invalid-credentials error.
  perform private.record_rate_limit_event('login_account', 'account', v_user_id);
  return pg_catalog.jsonb_build_object('decision', 'continue');
end;
$$;

comment on function public.hook_password_verification_attempt(jsonb) is
  'Supabase Auth password-verification-attempt hook: SECURITY.md § 5''s "Login ... per account" half, ENFORCED at 5 failed attempts per 15-minute fixed window. Counts failures only, resets on success, rejects every attempt (correct password included) while locked out, and the refused attempt''s own count is what files the exactly-once repeated_login_failures alert. FAILS CLOSED, and since 20260909100000 BY CONSTRUCTION rather than by accident: a missing login_account policy row now raises explicitly (22023) the way the two sibling functions in 20260909020000 always did, instead of relying on null-propagation to reach the same place. Any internal error here fails that one sign-in attempt (GoTrue surfaces a hook error as a failed login), never fails open into an unmetered path. EXECUTE is granted to supabase_auth_admin ONLY; the per-IP half of the Login row stays GoTrue''s own sign_in_sign_ups limit (config.toml:264 -- 30 per 5 min per IP, GoTrue''s granularity, not § 5''s idealised 5/15 -- recorded honestly in SECURITY.md § 5 and queued as Q108). THE COST OF A PER-ACCOUNT LOCKOUT IS AN AVAILABILITY ONE, disclosed in SECURITY.md § 5 and queued as Q114: anyone who knows an email address can keep that account out of PASSWORD sign-in indefinitely by failing five attempts per window. Magic-link and Google SSO are unaffected and are the escape hatch. On HOSTED Supabase this hook must be enabled in the dashboard (SECURITY.md § 15).';

revoke all on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
