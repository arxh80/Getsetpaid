-- ===========================================================================
-- A PER-ACCOUNT PASSWORD BUDGET THE APP SPENDS BEFORE GoTrue (Phase 10 Task 8;
-- gap G4, High)
-- ===========================================================================
-- SECURITY.md § 5's "Login: 5 attempts / 15 min, per account" is enforced by
-- public.hook_password_verification_attempt, GoTrue's password-verification
-- hook. The hosted Supabase organisation's plan refuses that hook ("402:
-- HOOK_PASSWORD_VERIFICATION_ATTEMPT cannot be configured for this
-- organization", PR #32's Preview check), so in production the only bound
-- would be GoTrue's per-IP 30 per 5 minutes. Founder action F8 (a plan that
-- permits the hook) stays the primary control; this is the fallback, built
-- anyway as defence in depth.
--
-- THE SHAPE: public.meter_password_sign_in(p_email, p_outcome), called by
-- lib/auth/login-budget.ts from signInAction and from the step-up password
-- path, with the service-role client:
--   'attempt'    BEFORE GoTrue. False when the budget is spent: the app then
--                refuses without calling GoTrue. The refused attempt is
--                counted, and its count reaching max+1 files the alert (the
--                hook's own semantics, so a correct password does not lift a
--                lockout early).
--   'failed'     after GoTrue refused the credentials: one counted failure.
--   'succeeded'  after GoTrue accepted them: the slate is cleared.
--
-- A NEW CATEGORY, login_email, NOT login_account. Locally (and on hosted
-- once F8 is bought) the hook counts the same failures under login_account by
-- user id. Spending login_account from the app as well would count every
-- failure twice and lock an account after two wrong passwords. Two budgets of
-- the same size count the same attempts once each, and the app's refuses the
-- sixth before the hook ever sees it.
--
-- THE KEY: the normalised email (trimmed, lower-cased), resolved to the
-- password account's id when one exists, otherwise the first 16 bytes of its
-- SHA-256. The account id rather than the hash for a real account because
-- the crossing's repeated_login_failures alert must name the account:
-- public.pending_lockout_notifications() joins details->>'subject_id' to
-- auth.users, and that is how the account holder is told (Q114). An address
-- with no account still has a budget, so a refusal says nothing about
-- whether the account exists. No address is stored: the counter holds a uuid.
--
-- WHO MAY CALL IT: service_role only, and it refuses a person's session
-- (20261104000000's guard), so the existing refusal stands: no browser, signed
-- in or not, can spend or clear anybody's budget over PostgREST.
-- public.consume_rate_limit() still refuses every 'account' category (42501).
--
-- WHAT IT DOES NOT BOUND: a password sign-in sent straight to GoTrue
-- (/auth/v1/token?grant_type=password with the anon key) never meets the app.
-- That path stays bounded by the hook where it is enabled (F8), and by
-- GoTrue's per-IP sign_in_sign_ups otherwise (SECURITY.md § 5).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('login_email', 'account', 5, 900,
        'Failed password sign-in attempts per normalised email address, spent by the app BEFORE GoTrue (lib/auth/login-budget.ts; Phase 10 Task 8, G4 fallback). The same 5 per 15 minutes as login_account, counted separately so the hook and the app never count one failure twice.');


-- ---------------------------------------------------------------------------
-- THE LIMITER CORE, rebuilt from 20260909020000 with ONE change: a login_email
-- crossing files repeated_login_failures, like login_account's, so the
-- operator's health counts and the account holder's notice (Q114) see an
-- app-side lockout. The logic is otherwise the shipped function's (some
-- inline comments are shortened; 20260909020000 keeps the long ones).
-- ---------------------------------------------------------------------------
create or replace function private.record_rate_limit_event(
  p_category        text,
  p_subject_scope   text,
  p_subject_id      uuid,
  p_organisation_id uuid default null
)
returns table (allowed boolean, retry_after_seconds integer, request_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
begin
  select * into v_policy from public.rate_limit_policies p where p.category = p_category;
  if not found then
    raise exception 'record_rate_limit_event: unknown rate-limit category %', p_category
      using errcode = '22023';
  end if;
  if v_policy.subject_scope <> p_subject_scope then
    raise exception 'record_rate_limit_event: category % is %-scoped, not %-scoped',
      p_category, v_policy.subject_scope, p_subject_scope
      using errcode = '22023';
  end if;
  if p_subject_id is null then
    raise exception 'record_rate_limit_event: a subject is required' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);

  -- OPPORTUNISTIC CLEANUP, the no-scheduler pattern: this subject's dead
  -- windows go when the subject next shows up. Bounded by the PK index.
  delete from public.rate_limit_counters c
  where c.category = p_category
    and c.subject_scope = p_subject_scope
    and c.subject_id = p_subject_id
    and c.window_start < v_window;

  -- THE ATOMIC INCREMENT. ON CONFLICT serialises concurrent callers on the
  -- row (tests/integration/rls/rate-limits.test.ts).
  insert into public.rate_limit_counters as c
    (category, subject_scope, subject_id, window_start, request_count)
  values
    (p_category, p_subject_scope, p_subject_id, v_window, 1)
  on conflict (category, subject_scope, subject_id, window_start)
  do update set request_count = c.request_count + 1,
                updated_at    = pg_catalog.now()
  returning c.request_count into v_count;

  -- THE EXACTLY-ONCE CROSSING WRITE. Both login budgets file the login alert
  -- (Phase 10 Task 8 added login_email).
  if v_count = v_policy.max_requests + 1 then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      case when p_category in ('login_account', 'login_email')
           then 'repeated_login_failures'
           else 'rate_limit_tripped' end,
      p_organisation_id,
      case when p_category in ('login_account', 'login_email')
           then pg_catalog.format(
             'Repeated failed sign-in attempts on one account (limit %s per %s seconds).',
             v_policy.max_requests, v_policy.window_seconds)
           else pg_catalog.format(
             'Rate limit exceeded: %s (limit %s per %s seconds).',
             p_category, v_policy.max_requests, v_policy.window_seconds) end,
      pg_catalog.jsonb_build_object(
        'category',       p_category,
        'subject_scope',  p_subject_scope,
        'subject_id',     p_subject_id,
        'window_start',   v_window,
        'max_requests',   v_policy.max_requests,
        'window_seconds', v_policy.window_seconds
      )
    );
  end if;

  return query select
    v_count <= v_policy.max_requests,
    greatest(0, pg_catalog.ceil(extract(epoch from
      (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
        - pg_catalog.now())))::integer),
    v_count;
end;
$$;

comment on function private.record_rate_limit_event(text, text, uuid, uuid) is
  'THE limiter core: one call = one counted request against one subject''s fixed-window budget, returning (allowed, retry_after_seconds, request_count). Counts refusals too, and NEVER raises on one -- a raise would roll back the refusal''s own increment and the alert-at-crossing insert (20260909020000''s header). CONCURRENCY: the ON CONFLICT upsert serialises simultaneous callers on the counter row, so N callers receive N DISTINCT counts -- measured in tests/integration/rls/rate-limits.test.ts. The crossing (count = max+1) files exactly one alert: repeated_login_failures for login_account and login_email (the latter since 20261108002000), rate_limit_tripped for every other category. SECURITY DEFINER with NO client grant: reachable only through public.consume_rate_limit() (session-scoped, guarded), public.hook_password_verification_attempt() (GoTrue''s hook), public.meter_password_sign_in() (service_role, the app''s pre-GoTrue login budget) and the BEFORE INSERT budget triggers. Raises 22023 only for caller bugs: an unknown category, a scope mismatch, a null subject.';

revoke all on function private.record_rate_limit_event(text, text, uuid, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- THE APP'S ENTRY POINT.
-- ---------------------------------------------------------------------------
create function public.meter_password_sign_in(p_email text, p_outcome text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email   text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_policy  public.rate_limit_policies%rowtype;
  v_subject uuid;
  v_count   integer;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'meter_password_sign_in: spent by the app''s server, never from a person''s session'
      using errcode = '42501', hint = 'login_budget_is_server_only';
  end if;
  if v_email is null or v_email = '' or p_outcome is null
     or p_outcome not in ('attempt', 'failed', 'succeeded') then
    raise exception 'meter_password_sign_in: an email and an outcome of attempt, failed or succeeded are required'
      using errcode = '22023', hint = 'login_budget_bad_call';
  end if;

  -- FAIL CLOSED on a missing policy row, as the hook does (20260909100000).
  select * into v_policy from public.rate_limit_policies p where p.category = 'login_email';
  if not found then
    raise exception 'meter_password_sign_in: no rate-limit policy for login_email'
      using errcode = '22023';
  end if;

  -- shortcut: lower(email) is not indexed, so this scans auth.users per call;
  -- fine at MVP size, upgrade to an expression index if sign-in latency shows it.
  select u.id into v_subject
    from auth.users u
   where pg_catalog.lower(u.email) = v_email
     and not u.is_sso_user
   order by u.created_at
   limit 1;
  v_subject := coalesce(v_subject,
    pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_email, 'UTF8')), 'hex'), 32)::uuid);

  if p_outcome = 'succeeded' then
    delete from public.rate_limit_counters c
     where c.category = 'login_email' and c.subject_scope = 'account' and c.subject_id = v_subject;
    return true;
  end if;

  if p_outcome = 'failed' then
    perform private.record_rate_limit_event('login_email', 'account', v_subject);
    return true;
  end if;

  -- 'attempt': refused once the window holds max failures. The refusal is
  -- counted too, and the first one (count max+1) files the alert.
  select c.request_count into v_count
    from public.rate_limit_counters c
   where c.category = 'login_email'
     and c.subject_scope = 'account'
     and c.subject_id = v_subject
     and c.window_start = private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  if coalesce(v_count, 0) >= v_policy.max_requests then
    perform private.record_rate_limit_event('login_email', 'account', v_subject);
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.meter_password_sign_in(text, text) from public, anon, authenticated;
grant execute on function public.meter_password_sign_in(text, text) to service_role;

comment on function public.meter_password_sign_in(text, text) is
  'Phase 10 Task 8 (G4 fallback): the app''s per-account password budget, spent BEFORE GoTrue by lib/auth/login-budget.ts (signInAction and the step-up password path). p_outcome attempt -> false once 5 failures sit in the 15-minute window (the refusal is counted, and count max+1 files repeated_login_failures); failed -> one counted failure; succeeded -> the counter is cleared. Category login_email, keyed on the normalised email: the password account''s id when one exists (so the alert reaches the account holder, Q114), else the first 16 bytes of the address''s SHA-256. service_role only; refuses any session (42501 login_budget_is_server_only). A direct GoTrue password grant bypasses it; the hook (F8) or GoTrue''s per-IP limit bounds that path.';
