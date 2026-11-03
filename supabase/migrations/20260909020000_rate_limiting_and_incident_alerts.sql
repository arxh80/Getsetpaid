-- Phase 7 Task 5: rate-limiting infrastructure + incident alerts + the
-- platform-health read surface.
--
-- SECURITY.md § 5 is the requirement this migration exists to make true. Its
-- table has carried a "SPECIFIED AND NOT IMPLEMENTED" disclosure since
-- Phase 6; this migration ships the mechanism, and the same commit rewrites
-- that section to say, per row, what is now ENFORCED, what is DETECTED, and
-- what is MECHANISM-ONLY awaiting its endpoint.
--
-- ===========================================================================
-- ONE MECHANISM, ONE CONFIG TABLE, AND WHERE ENFORCEMENT ACTUALLY SITS
-- ===========================================================================
-- public.rate_limit_policies is THE one place a limit's value lives (the
-- brief: "config lives in one place, not scattered literals") -- seeded below
-- with SECURITY.md § 5's numbers verbatim. Nothing in TypeScript holds a
-- limit; the app calls public.consume_rate_limit() and obeys the verdict, so
-- the two halves cannot drift the way a mirrored constant could.
--
-- Enforcement is APP-SIDE (the application refuses the request when the
-- verdict says so), with the counter, the window arithmetic and the verdict
-- all DB-SIDE in this migration. That split is a MEASURED decision, not a
-- default:
--
--   PostgREST executes every GET in a READ-ONLY transaction. Measured on
--   this stack (2026-09-09): a volatile function reached via
--   `GET /rest/v1/rpc/...` fails with SQLSTATE 25006 "cannot execute INSERT
--   in a read-only transaction"; the identical POST succeeds. A rate
--   limiter must WRITE (the increment IS the mechanism), so no policy term,
--   view, or pre-request hook evaluated inside a PostgREST GET can meter it.
--   The only DB-side shapes that could are (a) replacing the directory
--   views with a POST RPC -- rebuilding the search path, which Q86 forbids
--   and the N2 pg_depend lock exists to prevent -- or (b) an
--   autonomous-transaction hack (dblink, one extra connection per request),
--   which turns the mitigation into a connection-exhaustion DoS worse than
--   the thing it mitigates.
--
-- So `GET /rest/v1/network_directory` with the anon key + a session JWT,
-- issued WITHOUT touching the Next.js app, remains unmetered -- named as a
-- residual in SECURITY.md § 5 and § 10 and queued (DECISIONS-QUEUE Q107)
-- with a recommended closure (deny the direct-REST path for the two
-- directory views outright at Phase 10, via a server-held header checked in
-- pgrst.db_pre_request -- a DENY needs no write, so the read-only
-- transaction does not block it), rather than silently accepted.
--
-- The LOGIN row is the exception to "app-side": GoTrue owns those endpoints,
-- and Supabase's password-verification-attempt AUTH HOOK
-- (public.hook_password_verification_attempt below, wired in config.toml) is
-- a real DB-side enforcement point GoTrue itself calls on every password
-- check -- so the per-account half of the Login row is ENFORCED, riding the
-- same counter table as everything else.
--
-- ===========================================================================
-- FIXED WINDOWS, COUNTING REFUSALS, AND WHY THE VERDICT NEVER RAISES
-- ===========================================================================
-- Windows are FIXED (date_bin from the epoch), not sliding: one row per
-- (category, subject, window), incremented atomically by an ON CONFLICT
-- upsert. The known cost -- a burst straddling a boundary can reach 2x the
-- limit across 2x the window -- is accepted and documented in SECURITY.md
-- § 5; a sliding window needs per-request timestamps or token-bucket state,
-- which is more machinery than "basic counts only at MVP" warrants.
--
-- request_count DELIBERATELY KEEPS COUNTING past the limit (a refused
-- request increments too). Two reasons: the count then measures PRESSURE,
-- not just permitted traffic (an operator reading 4,000 in a 30-limit window
-- knows something a clamped 31 hides); and the alert-at-crossing write
-- (request_count = max + 1, exactly once per window) only works if the
-- crossing request's increment COMMITS -- which is why
-- private.record_rate_limit_event() returns a verdict rather than raising.
-- A RAISE rolls back its own transaction's writes, so a raising limiter
-- un-counts every refusal and un-writes its own alert. The app layer
-- (lib/security/rate-limit.ts) turns the verdict into a 429-shaped refusal;
-- the auth hook turns it into a GoTrue rejection.
--
-- ===========================================================================
-- INCIDENT ALERTS: ROWS FIRST, DELIVERY LATER (Q91)
-- ===========================================================================
-- public.incident_alerts is platform-scoped (no tenant RLS path), readable
-- by the platform superuser only, written only from inside the SECURITY
-- DEFINER writers here. Three trigger conditions at MVP, per CLAUDE.md
-- § Superuser dashboard's examples: repeated failed logins (the auth hook's
-- crossing), a malware-scan quarantine hit (the documents trigger), and a
-- rate-limit trip (any category's crossing). `notified_at` is the EMAIL
-- SEAM: null means "not yet delivered"; Task 6 folds in the Brevo sender
-- (the `email-setup` branch, Q91) and stamps it -- no schema change needed
-- then, and no second email path built now. SMS is out (no vendor chosen --
-- queued). Not a full alerting platform: a simple resolved flag, no dedup
-- windows beyond the natural once-per-window crossing, no escalation.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE POLICY TABLE -- SECURITY.md § 5's values, verbatim, seeded once.
-- ---------------------------------------------------------------------------

create table public.rate_limit_policies (
  category        text primary key,
  -- Who a budget belongs to. 'user' = auth.uid() of a signed-in session;
  -- 'organisation' = a tenant-wide budget (exports); 'account' = an auth
  -- account identified WITHOUT a session (the login hook -- the attempts
  -- being counted are precisely the ones that produced no session).
  subject_scope   text not null check (subject_scope in ('user', 'organisation', 'account')),
  max_requests    integer not null check (max_requests > 0),
  window_seconds  integer not null check (window_seconds > 0),
  description     text not null
);

comment on table public.rate_limit_policies is
  'THE one place a rate limit''s value lives (SECURITY.md § 5, verbatim -- supabase/tests/rls_phase7_rate_limits.sql asserts the seeded values against that table row by row). Consumed by private.record_rate_limit_event(); nothing in TypeScript mirrors these numbers, so the app and the database cannot drift. Change a limit by UPDATE in an additive migration, never by editing an application constant.';

insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description) values
  -- SECURITY.md § 5 "Login: 5 attempts / 15 min, per account". Counted as
  -- FAILED attempts, reset by a successful sign-in -- the only reading that
  -- does not lock out a legitimate user who signs in often, and the standard
  -- lockout semantics. ENFORCED by public.hook_password_verification_attempt.
  ('login_account',     'account',      5,   900, 'Failed password sign-in attempts per auth account. Enforced by the password-verification auth hook.'),
  -- SECURITY.md § 5 "Password recovery / verification: 3 / hour, per
  -- account". MECHANISM ONLY: GoTrue owns the recovery endpoints and exposes
  -- no per-account hook for them, so nothing consumes this row yet
  -- (DECISIONS-QUEUE Q109 -- the send-email hook Task 6 wires for Brevo is
  -- the natural future enforcement point).
  ('password_recovery', 'account',      3,  3600, 'Password recovery requests per auth account. Mechanism only -- no enforcement point exists until the send-email hook lands (Q109).'),
  -- SECURITY.md § 5 "Search: 60 requests / min, per user". Consumed by
  -- lib/list/query.ts whenever a list request carries a search term -- the
  -- one chokepoint all twenty searchColumn paths (FOLLOW-UPS § "Opened by
  -- Task 8") flow through, the command palette included.
  ('search',            'user',        60,    60, 'Search-carrying list requests per user, across every CRM list and the command palette.'),
  -- SECURITY.md § 5 "Exports: 5 / hour, per organisation". MECHANISM ONLY:
  -- no export endpoint exists yet; the budget row and the org-scoped consume
  -- path are ready for the endpoint when it ships.
  ('exports',           'organisation', 5,  3600, 'Data exports per organisation. Mechanism only -- no export endpoint exists yet.'),
  -- SECURITY.md § 5 "Network discovery: 30 requests / min, per user" -- THE
  -- NAMED ENDPOINT (FOLLOW-UPS:3408-3419): every lib/list/query.ts read of
  -- public.network_directory (the app''s /[orgSlug]/network directory page
  -- and the link-picker search), deliberately its own budget and NEVER folded
  -- into ''search'', because its unit cost is O(platform-wide published
  -- rows), not O(tenant).
  ('network_discovery', 'user',        30,    60, 'Network-directory reads per user (the named O(platform) path). Never folded into the generic search budget.'),
  -- SECURITY.md § 5 / CLAUDE.md § In-app feedback "10 submissions / hour per
  -- user". MECHANISM ONLY until Task 6 ships the feedback endpoint, which
  -- calls consume_rate_limit(''feedback'') and nothing else.
  ('feedback',          'user',        10,  3600, 'In-app feedback submissions per user. Task 6 is the consumer.');

revoke all on public.rate_limit_policies from public, anon, authenticated, service_role;
grant select on public.rate_limit_policies to authenticated;
alter table public.rate_limit_policies enable row level security;

create policy rate_limit_policies_select_platform
  on public.rate_limit_policies for select to authenticated
  using ( (select private.has_platform_permission('view_platform_health')) );

comment on policy rate_limit_policies_select_platform on public.rate_limit_policies is
  'The platform superuser (at aal2) may read the limit configuration -- the health view states which budgets exist. Nobody else needs it: an ordinary caller learns a limit the way HTTP intends, by being refused with a retry hint. No INSERT/UPDATE/DELETE policy for any role -- values change by migration.';


-- ---------------------------------------------------------------------------
-- 2. THE COUNTERS -- one row per (category, subject, fixed window).
-- ---------------------------------------------------------------------------

create table public.rate_limit_counters (
  category       text not null references public.rate_limit_policies (category),
  subject_scope  text not null check (subject_scope in ('user', 'organisation', 'account')),
  -- A user id, an organisation id, or an auth account id, per subject_scope.
  -- DELIBERATELY NOT a foreign key: an 'account' subject is auth.users (a
  -- schema this table should not reference -- house rule since the
  -- foundation), and a counter row must never block a user/org deletion.
  subject_id     uuid not null,
  window_start   timestamptz not null,
  request_count  integer not null default 1 check (request_count >= 1),
  updated_at     timestamptz not null default pg_catalog.now(),
  primary key (category, subject_scope, subject_id, window_start)
);

comment on table public.rate_limit_counters is
  'Fixed-window request counters (SECURITY.md § 5). One row per (category, subject, window); private.record_rate_limit_event() increments atomically via ON CONFLICT and keeps counting past the limit (the overshoot measures pressure, and the exactly-once alert-at-crossing write depends on the refused increment committing). Stale windows for a subject are deleted opportunistically on that subject''s next consume -- no scheduler (the house pattern); a global sweep of subjects that never return joins the Phase 8 retention job (Q110). Superuser-readable for the health view; no client role can write it -- every write path is a SECURITY DEFINER function in 20260909020000.';

-- category is the PK's leading column; no separate index needed for the FK.

revoke all on public.rate_limit_counters from public, anon, authenticated, service_role;
grant select on public.rate_limit_counters to authenticated;
alter table public.rate_limit_counters enable row level security;

create policy rate_limit_counters_select_platform
  on public.rate_limit_counters for select to authenticated
  using ( (select private.has_platform_permission('view_platform_health')) );

comment on policy rate_limit_counters_select_platform on public.rate_limit_counters is
  'The platform superuser (at aal2) may read every counter -- the abuse half of the health view. A counter row is an identifier plus a number (no record content), so this stays inside CLAUDE.md § Superuser dashboard''s "aggregate metadata, never record content". Nobody else can read it: a user''s own counter values are deliberately not disclosed beyond the retry hint a refusal carries.';


-- ---------------------------------------------------------------------------
-- 3. INCIDENT ALERTS -- platform-scoped rows, superuser-read, resolve-only
--    writes from a client. The email seam for Task 6 (Q91) is `notified_at`.
-- ---------------------------------------------------------------------------

create table public.incident_alerts (
  id               uuid primary key default gen_random_uuid(),
  alert_type       text not null check (alert_type in
                     ('rate_limit_tripped', 'repeated_login_failures', 'upload_quarantined')),
  -- Nullable: a login-failure alert has no organisation context (the subject
  -- is an auth account, which may belong to several workspaces or none).
  organisation_id  uuid references public.organisations (id) on delete cascade,
  -- A fixed, template-built sentence. NEVER user-entered content, a filename,
  -- a search term or a record field -- the same allowlist-of-identifiers
  -- discipline audit_events payloads keep (SECURITY.md § 7), because this
  -- table is read on a platform surface.
  summary          text not null,
  -- Identifiers and numbers only: category, subject ids, window bounds,
  -- limits, a document id. Same discipline as summary.
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default pg_catalog.now(),
  resolved_at      timestamptz,
  resolved_by      uuid references auth.users (id),
  -- THE TASK 6 SEAM (Q91): null = "no email has been sent for this alert".
  -- The Brevo fold-in reads unnotified rows, sends, and stamps this -- no
  -- schema change, and no second email sender built here.
  notified_at      timestamptz,
  constraint incident_alerts_resolution_pair
    check ((resolved_at is null) = (resolved_by is null))
);

comment on table public.incident_alerts is
  'Trigger-based incident alerts (CLAUDE.md § Superuser dashboard): a rate-limit trip (any category''s exactly-once crossing write), repeated failed sign-ins on one account (the auth hook''s crossing), and a malware-scan quarantine hit (the documents trigger). Platform-scoped and superuser-read; shown on /super/health. Written only from inside the SECURITY DEFINER functions/triggers of 20260909020000 -- no client INSERT path. The only client write is the superuser''s resolve/un-resolve (a simple flag, deliberately: no dedup windows, no escalation, no ack workflow). notified_at is the Task 6 email seam (Q91) -- null means undelivered; the Brevo fold-in stamps it. summary/details carry identifiers and counts only, never record content or user-entered text, so the no-direct-tenant-data rule holds on the surface that renders them.';

create index incident_alerts_open_idx
  on public.incident_alerts (created_at desc)
  where resolved_at is null;
create index incident_alerts_created_at_idx
  on public.incident_alerts (created_at desc);
create index incident_alerts_organisation_id_idx
  on public.incident_alerts (organisation_id);
create index incident_alerts_resolved_by_idx
  on public.incident_alerts (resolved_by);

revoke all on public.incident_alerts from public, anon, authenticated, service_role;
grant select, update on public.incident_alerts to authenticated;
alter table public.incident_alerts enable row level security;

create policy incident_alerts_select_platform
  on public.incident_alerts for select to authenticated
  using ( (select private.has_platform_permission('view_platform_health')) );

create policy incident_alerts_update_platform
  on public.incident_alerts for update to authenticated
  using      ( (select private.has_platform_permission('view_platform_health')) )
  with check ( (select private.has_platform_permission('view_platform_health')) );

comment on policy incident_alerts_update_platform on public.incident_alerts is
  'The resolve/un-resolve flag, superuser only. WHICH columns an update may touch is not a policy''s to say (RLS filters rows, not columns), so private.incident_alert_resolution_guard() is the column gate: resolved_at/resolved_by move together and nothing else moves at all. Resolution is deliberately NOT step-up-gated and NOT audited: it is operator bookkeeping on platform metadata, not a high-risk action on a tenant (contrast every lifecycle/override RPC), and the row itself records who resolved it and when.';

-- No INSERT policy for any role: writers are the SECURITY DEFINER functions
-- below. No DELETE policy: an alert is evidence; resolving is the lifecycle.

create or replace function private.incident_alert_resolution_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The same rolbypassrls exemption every guard trigger in this schema
  -- carries (20260908040000, 20260909000000): migrations, DBA repair and
  -- test fixtures seeded as `postgres`/`service_role` pass; nothing
  -- reachable through PostgREST does.
  if not pg_catalog.row_security_active('public.incident_alerts'::pg_catalog.regclass) then
    return new;
  end if;

  if new.alert_type       is distinct from old.alert_type
     or new.organisation_id is distinct from old.organisation_id
     or new.summary        is distinct from old.summary
     or new.details        is distinct from old.details
     or new.created_at     is distinct from old.created_at
     or new.notified_at    is distinct from old.notified_at
     or new.id             is distinct from old.id then
    raise exception 'incident_alerts: only the resolution flag (resolved_at, resolved_by) is client-writable'
      using errcode = '42501';
  end if;

  -- Resolving stamps the RESOLVER's own identity -- an operator cannot file
  -- a resolution under someone else's id.
  if new.resolved_at is not null and new.resolved_by is distinct from (select auth.uid()) then
    raise exception 'incident_alerts: resolved_by must be the resolving caller'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.incident_alert_resolution_guard() is
  'The column gate behind incident_alerts_update_platform: a client update may move resolved_at/resolved_by (together, per the table CHECK; resolved_by forced to auth.uid()) and nothing else. Everything except the resolution flag is immutable from any client path -- alert content is written once, by the definer writers, and stays what it was. notified_at is in the immutable set ON PURPOSE: it belongs to the delivery seam (Task 6''s sender, running server-side), not to the operator''s browser.';

create trigger incident_alerts_resolution_guard
  before update on public.incident_alerts
  for each row execute function private.incident_alert_resolution_guard();


-- ---------------------------------------------------------------------------
-- 4. THE WINDOW ARITHMETIC -- one function, used by every consumer, tested
--    at the boundary by the psql suite.
-- ---------------------------------------------------------------------------

create or replace function private.rate_limit_window_start(p_at timestamptz, p_window_seconds integer)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.date_bin(
    pg_catalog.make_interval(secs => p_window_seconds),
    p_at,
    'epoch'::timestamptz
  );
$$;

comment on function private.rate_limit_window_start(timestamptz, integer) is
  'Fixed-window arithmetic: the epoch-aligned bin p_at falls into. IMMUTABLE and separate from the consume path so the boundary behaviour is testable in isolation (rls_phase7_rate_limits.sql § RW): two instants inside one bin share a window_start; one microsecond across the boundary starts a new one. Epoch-aligned rather than first-request-aligned, so a window''s start is a pure function of the clock -- no per-subject anchor row to race over.';

revoke all on function private.rate_limit_window_start(timestamptz, integer) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. THE CORE: count one request, return the verdict, write the alert at the
--    exactly-once crossing. Never raises on a refusal (see the header).
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
  -- row: two simultaneous requests get counts n and n+1, never both n
  -- (tests/integration/rls/rate-limits.test.ts fires ten in parallel and
  -- asserts the final count is exactly ten).
  insert into public.rate_limit_counters as c
    (category, subject_scope, subject_id, window_start, request_count)
  values
    (p_category, p_subject_scope, p_subject_id, v_window, 1)
  on conflict (category, subject_scope, subject_id, window_start)
  do update set request_count = c.request_count + 1,
                updated_at    = pg_catalog.now()
  returning c.request_count into v_count;

  -- THE EXACTLY-ONCE CROSSING WRITE: the first refused request in a window
  -- (and only that one) files the alert. Login failures get their own
  -- alert_type -- CLAUDE.md § Superuser dashboard names "repeated failed
  -- logins" as its own trigger condition, and the health view counts the two
  -- separately.
  if v_count = v_policy.max_requests + 1 then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      case when p_category = 'login_account'
           then 'repeated_login_failures'
           else 'rate_limit_tripped' end,
      p_organisation_id,
      case when p_category = 'login_account'
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
  'THE limiter core: one call = one counted request against one subject''s fixed-window budget, returning (allowed, retry_after_seconds, request_count). Counts refusals too, and NEVER raises on one -- a raise would roll back the refusal''s own increment and the alert-at-crossing insert (this migration''s header). SECURITY DEFINER with NO client grant: reachable only through public.consume_rate_limit() (session-scoped, guarded) and public.hook_password_verification_attempt() (GoTrue''s hook). Raises 22023 only for caller bugs: an unknown category, a scope mismatch, a null subject.';

revoke all on function private.record_rate_limit_event(text, text, uuid, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. THE SESSION-FACING WRAPPER -- what the application calls.
-- ---------------------------------------------------------------------------

create or replace function public.consume_rate_limit(
  p_category        text,
  p_organisation_id uuid default null
)
returns table (allowed boolean, retry_after_seconds integer, request_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope   text;
  v_subject uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'consume_rate_limit: no session' using errcode = '28000';
  end if;

  select p.subject_scope into v_scope
  from public.rate_limit_policies p where p.category = p_category;
  if not found then
    raise exception 'consume_rate_limit: unknown rate-limit category %', p_category
      using errcode = '22023';
  end if;

  if v_scope = 'account' then
    -- Account-scoped budgets (login, recovery) belong to the auth layer's
    -- own hooks -- letting a session burn them would let a signed-in
    -- attacker lock an account they already control into looking attacked.
    raise exception 'consume_rate_limit: category % is not consumable from a client session', p_category
      using errcode = '42501';
  elsif v_scope = 'organisation' then
    if p_organisation_id is null then
      raise exception 'consume_rate_limit: category % needs an organisation', p_category
        using errcode = '22023';
    end if;
    -- Membership required: an organisation's budget is burnable only by its
    -- own members, or any authenticated stranger could exhaust another
    -- tenant's export allowance -- a denial of service through the limiter.
    if not private.is_active_member(p_organisation_id) then
      raise exception 'consume_rate_limit: not a member of that organisation'
        using errcode = '42501';
    end if;
    v_subject := p_organisation_id;
  else
    v_subject := (select auth.uid());
  end if;

  return query select * from private.record_rate_limit_event(
    p_category, v_scope, v_subject, p_organisation_id);
end;
$$;

comment on function public.consume_rate_limit(text, uuid) is
  'The application''s one rate-limiting call (lib/security/rate-limit.ts): counts this request against the caller''s own budget for p_category and returns the verdict. User-scoped categories bind to auth.uid(); organisation-scoped ones require p_organisation_id plus active membership (so a stranger cannot burn another tenant''s budget); account-scoped ones refuse (42501 -- they belong to the auth hooks). Returns a verdict rather than raising a 429-alike, deliberately: the refusal must COMMIT its own increment and possible alert row (see 20260909020000''s header), and the app shapes the 429. Callable directly over PostgREST -- a caller doing so can only spend their own budget faster.';

revoke all on function public.consume_rate_limit(text, uuid) from public, anon, service_role;
grant execute on function public.consume_rate_limit(text, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. THE LOGIN HOOK -- GoTrue's password-verification-attempt hook, the
--    per-account half of SECURITY.md § 5's Login row, ENFORCED.
--
--    Wired by config.toml [auth.hook.password_verification_attempt] locally;
--    on hosted Supabase the hook must be enabled in the dashboard -- added
--    to SECURITY.md § 15's pre-launch checklist, because a hook that is not
--    enabled is a limit that does not exist.
-- ---------------------------------------------------------------------------

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
  'Supabase Auth password-verification-attempt hook: SECURITY.md § 5''s "Login ... per account" half, ENFORCED at 5 failed attempts per 15-minute fixed window. Counts failures only, resets on success, rejects every attempt (correct password included) while locked out, and the refused attempt''s own count is what files the exactly-once repeated_login_failures alert. FAILS CLOSED: any internal error here fails that one sign-in attempt (GoTrue surfaces a hook error as a failed login), never fails open into an unmetered path -- the same direction every gate in this schema fails. EXECUTE is granted to supabase_auth_admin ONLY; the per-IP half of the Login row stays GoTrue''s own sign_in_sign_ups limit (config.toml:264 -- 30 per 5 min per IP, GoTrue''s granularity, not § 5''s idealised 5/15 -- recorded honestly in SECURITY.md § 5 and queued as Q108). On HOSTED Supabase this hook must be enabled in the dashboard (SECURITY.md § 15).';

revoke all on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;


-- ---------------------------------------------------------------------------
-- 8. THE QUARANTINE ALERT -- a malware-scan hit files an incident row, by
--    trigger, so no upload path (present or future) can forget to.
-- ---------------------------------------------------------------------------

create or replace function private.document_quarantine_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.incident_alerts (alert_type, organisation_id, summary, details)
  values (
    'upload_quarantined',
    new.organisation_id,
    'A file upload was quarantined by the malware scanner.',
    -- The document id only. NO filename: filenames are user-entered content
    -- and this table renders on a platform surface -- the same reasoning
    -- 20260902031000 gives for the document audit rows.
    pg_catalog.jsonb_build_object('document_id', new.id)
  );
  return new;
end;
$$;

comment on function private.document_quarantine_alert() is
  'Files an upload_quarantined incident alert whenever a document reaches scan_status=''quarantined''. A TRIGGER rather than app code, deliberately: the scan verdict is written by the server''s scan pipeline today, but the alert must hold for every path that ever sets the status -- the same reasoning the CRM hard-delete audit gives for being a trigger. SECURITY DEFINER because the writer (service_role today) holds no grant on incident_alerts and should not: alert-writing is this function''s job alone. Identifiers only in details -- never the filename.';

-- Two triggers rather than one: an INSERT trigger's WHEN clause cannot
-- reference OLD, and the UPDATE side must fire only on the TRANSITION into
-- quarantine (the scan-status guard makes the verdict terminal, but a
-- non-transition UPDATE of another column would otherwise re-fire it).
create trigger documents_quarantine_alert_on_insert
  after insert on public.documents
  for each row
  when (new.scan_status = 'quarantined')
  execute function private.document_quarantine_alert();

create trigger documents_quarantine_alert_on_update
  after update on public.documents
  for each row
  when (old.scan_status is distinct from new.scan_status
        and new.scan_status = 'quarantined')
  execute function private.document_quarantine_alert();


-- ---------------------------------------------------------------------------
-- 9. THE PLATFORM HEALTH SNAPSHOT -- aggregates only, live queries, no
--    snapshot table, self-auditing.
-- ---------------------------------------------------------------------------

create or replace function public.platform_health_snapshot()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.has_platform_permission('view_platform_health') then
    raise exception 'platform_health_snapshot: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  -- SUPERUSER ACCESS AUDITS ITSELF (CLAUDE.md § Non-negotiable rules) --
  -- the same discipline as audit_log.viewed (20260908010000). This RPC is a
  -- definer function, so it reaches private.log_audit_event directly; the
  -- payload is empty because the snapshot takes no parameters and returns no
  -- record content worth restating.
  perform private.log_audit_event(
    p_action          => 'platform_health.viewed',
    p_target_type     => 'platform_health',
    p_organisation_id => null,
    p_target_id       => null,
    p_after           => '{}'::jsonb
  );

  -- LIVE QUERIES, ON DEMAND -- CLAUDE.md § Superuser dashboard: "queried
  -- on-demand/daily from Postgres directly -- no separate metrics/
  -- observability pipeline". Every number below is an aggregate: counts,
  -- sums, and (for storage) organisation names -- the same disclosure
  -- /super/organisations already makes -- never a record, a filename, or a
  -- user-entered field.
  select pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),

    'organisations', (
      select pg_catalog.jsonb_build_object(
        'active',      count(*) filter (where o.lifecycle_state = 'active'),
        'suspended',   count(*) filter (where o.lifecycle_state = 'suspended'),
        'deleted',     count(*) filter (where o.lifecycle_state = 'deleted'),
        'total',       count(*),
        'created_7d',  count(*) filter (where o.created_at >= pg_catalog.now() - interval '7 days'),
        'created_30d', count(*) filter (where o.created_at >= pg_catalog.now() - interval '30 days')
      )
      from public.organisations o
    ),

    'users', (
      select pg_catalog.jsonb_build_object(
        'total',       count(*),
        'created_7d',  count(*) filter (where u.created_at >= pg_catalog.now() - interval '7 days'),
        'created_30d', count(*) filter (where u.created_at >= pg_catalog.now() - interval '30 days')
      )
      from auth.users u
      where u.deleted_at is null
    ),

    'memberships_active', (
      select count(*) from public.organisation_memberships m where m.status = 'active'
    ),

    -- DECLARED seats, not billed truth: Phase 7 Task A's backfill stamped
    -- seat_count = 1 and current_period_end = migration + 30 days onto every
    -- pre-existing organisation (ledger minor M2), and nothing reconciles
    -- these against a payment processor yet. The UI carries this caveat in
    -- as many words -- presenting the number as more than it is would be the
    -- health view's own version of an unimplemented control listed as live.
    'subscriptions', (
      select pg_catalog.jsonb_build_object(
        'declared_seats', coalesce(sum(s.seat_count), 0),
        'past_period_end', count(*) filter (where s.current_period_end < pg_catalog.now()),
        'by_plan', (
          select coalesce(pg_catalog.jsonb_object_agg(q.plan_id, q.n), '{}'::jsonb)
          from (
            select s2.plan_id, count(*) as n
            from public.organisation_subscriptions s2
            group by s2.plan_id
          ) q
        )
      )
      from public.organisation_subscriptions s
    ),

    'storage', (
      select pg_catalog.jsonb_build_object(
        'total_bytes', coalesce(sum(d.size_bytes), 0),
        'documents',   count(*)
      )
      from public.documents d
      where d.deleted_at is null
    ),

    'storage_top_organisations', (
      select coalesce(pg_catalog.jsonb_agg(t), '[]'::jsonb)
      from (
        select o.name, o.slug,
               sum(d.size_bytes)::bigint as bytes,
               count(*)::integer          as documents
        from public.documents d
        join public.organisations o on o.id = d.organisation_id
        where d.deleted_at is null
        group by o.id, o.name, o.slug
        order by sum(d.size_bytes) desc
        limit 10
      ) t
    ),

    'abuse', (
      select pg_catalog.jsonb_build_object(
        'rate_limit_trips_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'rate_limit_tripped'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'repeated_login_failures_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'repeated_login_failures'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'quarantined_uploads_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'upload_quarantined'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'quarantined_documents_total', (
          select count(*) from public.documents d
          where d.scan_status = 'quarantined' and d.deleted_at is null),
        'open_alerts', (
          select count(*) from public.incident_alerts a where a.resolved_at is null)
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.platform_health_snapshot() is
  'The /super/health read: platform aggregates (org/user/membership counts, declared seats with the Task A M2 backfill caveat stated in the UI, storage totals and top-10 orgs by bytes, abuse counters from incident_alerts), queried LIVE with no snapshot table -- CLAUDE.md § Superuser dashboard''s "basic counts only ... no separate metrics pipeline". Guarded on has_platform_permission(''view_platform_health'') (42501 otherwise), and SELF-AUDITING: every call writes a platform_health.viewed audit row before reading anything, the audit_log.viewed discipline. Aggregates and organisation names only -- the same disclosure /super/organisations makes -- never record content. VOLATILE (it writes the audit row), so it is not callable via GET; the app calls it via POST like every RPC.';

revoke all on function public.platform_health_snapshot() from public, anon, service_role;
grant execute on function public.platform_health_snapshot() to authenticated;
