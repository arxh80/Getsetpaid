-- Phase 7 Task 2: BREAK-GLASS IMPERSONATION.
--
-- CLAUDE.md § Superuser dashboard: "Break-glass only: the superuser requests
-- impersonation, the org's admin must accept the request, and the session is
-- time-boxed and fully audited (actor, org, reason, start/end). No silent or
-- unilateral impersonation." And, one paragraph up: "No direct tenant-data
-- access outside impersonation." This flow is therefore the ONLY sanctioned
-- deep-access path in the product, which makes everything below the crown
-- jewels rather than another feature migration.
--
-- ===========================================================================
-- THE SHAPE, IN ONE PARAGRAPH
-- ===========================================================================
-- One table (`public.impersonation_sessions`) with NO client write policies at
-- all. Five SECURITY DEFINER RPCs in `public` carry the whole state machine,
-- each with its own authorisation guard and its own audit write, in one
-- transaction. Two SELECT policies let the two parties SEE the row. The GRANT
-- -- the thing that actually makes tenant data legible to the superuser -- is
-- NOT a membership row: it is one new set-returning helper,
-- private.impersonated_organisations(), wired into the three functions that
-- already decide every org-scoped read in the product.
--
-- ===========================================================================
-- WHY NOT MINT A MEMBERSHIP ROW (the brief forbids it, and here is the why)
-- ===========================================================================
-- A synthetic `organisation_memberships` row with role='read_only' would have
-- worked on day one and be indistinguishable from a real member for ever
-- after. Every count of "who is in this workspace", every members page, every
-- audit reader, and every future feature that reasons over memberships would
-- have silently absorbed a support session as a colleague -- and the row would
-- outlive the time-box unless something remembered to delete it, which is the
-- failure mode ("a forgotten grant becomes permanent") CLAUDE.md's own
-- per-org-feature-override rule ("mandatory expiry date") exists to prevent.
-- Deriving the grant from the session row means the time-box IS the grant: at
-- expires_at the set-returning helper simply stops returning the organisation,
-- with nothing to clean up and nothing to forget.
--
-- ===========================================================================
-- BOTH HALVES OF THE PERMISSION RULE MOVE TOGETHER
-- ===========================================================================
-- 20260828210000 established the discipline this migration inherits: ONE rule,
-- TWO representations (public.has_permission / private.permitted_organisations),
-- changed in the same diff and asserted equal by the mirror test. This task
-- adds a THIRD site -- private.full_scope_organisations() -- because record
-- scope is a separate narrower that would otherwise reduce impersonation to a
-- blank workspace (see § 4 below). All three delegate to the SAME helper, so
-- there is one body to read and no chance of the three drifting.
--
-- The TypeScript half is bound to this file by
-- tests/integration/rls/impersonation-matches-db.test.ts, following the
-- repo's `*-matches-db.test.ts` pattern: an impersonation grant that exists
-- only in TypeScript is a spoofable UI, and one that exists only in SQL never
-- renders.
--
-- ===========================================================================
-- ADDITIVE ONLY
-- ===========================================================================
-- `create or replace function` throughout; no applied migration is edited.
-- The three permission functions are REPLACED in full below, with their
-- existing bodies reproduced character-for-character apart from the one new
-- disjunct, so a diff of this file against 20260828210000 shows exactly what
-- changed.


-- ===========================================================================
-- 1. THE TABLE
-- ===========================================================================
create table public.impersonation_sessions (
  id                     uuid primary key default gen_random_uuid(),

  -- The REAL actor, always. Never overwritten, never nullable: an
  -- impersonation record whose subject cannot be named is worthless.
  superuser_user_id      uuid not null references auth.users (id),
  target_organisation_id uuid not null references public.organisations (id)
                           on delete cascade,

  -- MANDATORY, NON-EMPTY. CLAUDE.md requires a reason on every high-risk
  -- superuser function; the CHECK is what makes "mandatory" true of a raw
  -- INSERT and not merely of the form.
  reason                 text not null,

  status                 text not null default 'requested',

  requested_at           timestamptz not null default now(),
  -- The org admin who ACCEPTED. The brief's schema sketch names this column;
  -- decline gets its own pair rather than overloading this one, so no reader
  -- ever has to check `status` to know what `admin_accepted_by` means.
  admin_accepted_by      uuid references auth.users (id),
  accepted_at            timestamptz,
  declined_by            uuid references auth.users (id),
  declined_at            timestamptz,

  started_at             timestamptz,
  -- THE TIME-BOX, MATERIALISED. Set once, at start, from
  -- private.impersonation_time_box(). Every grant reads THIS column against
  -- now() -- never `status` -- which is what makes an expired session grant
  -- nothing even while the UI still shows it as active.
  expires_at             timestamptz,
  ended_at               timestamptz,

  constraint impersonation_sessions_reason_present
    check (btrim(reason) <> '' and char_length(reason) <= 500),

  constraint impersonation_sessions_status_vocabulary
    check (status in ('requested','accepted','declined','active','ended','expired')),

  -- The accept/decline pairs move together or not at all.
  constraint impersonation_sessions_accepted_pair
    check ((admin_accepted_by is null) = (accepted_at is null)),
  constraint impersonation_sessions_declined_pair
    check ((declined_by is null) = (declined_at is null)),

  -- ONE CHECK FOR THE WHOLE STATE MACHINE. Written as a CASE over `status` so
  -- every state's field expectations are on one screen and an unlisted status
  -- is rejected by the `else false` -- the same fail-closed direction
  -- public.permissions.survives_suspension's DEFAULT FALSE takes.
  constraint impersonation_sessions_status_fields check (
    case status
      when 'requested' then accepted_at is null and declined_at is null
                        and started_at is null and expires_at is null
                        and ended_at is null
      when 'declined'  then declined_at is not null and accepted_at is null
                        and started_at is null and expires_at is null
                        and ended_at is null
      when 'accepted'  then accepted_at is not null and declined_at is null
                        and started_at is null and expires_at is null
                        and ended_at is null
      when 'active'    then accepted_at is not null and started_at is not null
                        and expires_at is not null and ended_at is null
      when 'ended'     then accepted_at is not null and started_at is not null
                        and expires_at is not null and ended_at is not null
      when 'expired'   then accepted_at is not null and started_at is not null
                        and expires_at is not null and ended_at is not null
      else false
    end
  )
);

comment on table public.impersonation_sessions is
  'Break-glass impersonation (CLAUDE.md § Superuser dashboard). One row per request, carrying the whole lifecycle: requested -> accepted|declined -> active -> ended|expired. NO CLIENT WRITE POLICY EXISTS ON THIS TABLE -- every transition goes through one of the five SECURITY DEFINER RPCs in this migration, each of which audits itself in the same transaction. THE GRANT IS DERIVED FROM THIS ROW, NOT FROM A MEMBERSHIP: private.impersonated_organisations() reads status = ''active'' AND expires_at > now(), so the 60-minute time-box IS the grant and there is nothing to revoke or clean up when it lapses. Two SELECT policies: the superuser sees their own rows, the target organisation''s manage_organisation holders see rows for their organisation, nobody else sees anything.';

comment on column public.impersonation_sessions.superuser_user_id is
  'The REAL actor -- the platform superuser who asked. Never rewritten. Every audit row this flow writes carries the same id as actor_user_id (private.log_audit_event forces actor to auth.uid()), so "who was really doing this" is answerable from the audit trail alone, without this table.';

comment on column public.impersonation_sessions.reason is
  'Why. Mandatory and non-empty by CHECK, capped at 500 characters. Copied verbatim into the `after` payload of the request audit row, so the reason survives even if this row is later purged by the retention job.';

comment on column public.impersonation_sessions.status is
  'requested -> accepted | declined; accepted -> active; active -> ended (explicit early end) | expired (the clock ran out and something observed it). NOT THE ENFORCEMENT ON ITS OWN: a session whose clock has run out still reads ''active'' until an explicit end call moves it, and grants nothing throughout, because every grant ALSO requires expires_at > now(). Anything that gates on status without the clock is a bug.';

comment on column public.impersonation_sessions.expires_at is
  'THE TIME-BOX. Set once, at start, to now() + private.impersonation_time_box() (60 minutes, DECISIONS-QUEUE Q95). Read by private.impersonated_organisations() on every single permission evaluation, which is what makes expiry server-side and immediate rather than a sweep job the UI could outrun.';

comment on constraint impersonation_sessions_status_fields on public.impersonation_sessions is
  'The state machine, as a CHECK. Each status names exactly which timestamps must and must not be set; an unlisted status falls through to `else false` and is rejected. This is what stops a hand-written UPDATE from producing an ''active'' row with no expires_at -- which would be a session with no time-box, i.e. the one shape this whole feature exists to prevent.';

-- CLAUDE.md § Non-negotiable rules: index every foreign key.
create index impersonation_sessions_superuser_user_id_idx
  on public.impersonation_sessions (superuser_user_id);
create index impersonation_sessions_target_organisation_id_idx
  on public.impersonation_sessions (target_organisation_id);
create index impersonation_sessions_admin_accepted_by_idx
  on public.impersonation_sessions (admin_accepted_by);
create index impersonation_sessions_declined_by_idx
  on public.impersonation_sessions (declined_by);

-- THE HOT PATH. private.impersonated_organisations() runs on EVERY permission
-- evaluation for a superuser session (three call sites, several times per
-- render), filtering on (superuser_user_id, status, expires_at). This partial
-- index is deliberately over the LIVE statuses only: the table's long tail is
-- terminal rows nobody's permission check ever looks at.
create index impersonation_sessions_live_idx
  on public.impersonation_sessions (superuser_user_id, target_organisation_id)
  where status in ('requested','accepted','active');

comment on index public.impersonation_sessions_live_idx is
  'Serves both the grant lookup (private.impersonated_organisations, on every permission evaluation for a superuser session) and the duplicate-request guard below. PARTIAL over the three live statuses on purpose: terminal rows accumulate for the retention window and no permission check ever reads one.';

-- ONE LIVE REQUEST PER (SUPERUSER, ORGANISATION). A second request while one
-- is still requested/accepted/active is a 23505, not a silently duplicated
-- consent -- the same "a live pair blocks a second one" shape
-- network_connection_requests_live_pair uses, and for the same reason: two
-- pending consents against one organisation makes "did they agree" ambiguous.
-- Terminal rows (declined/ended/expired) do NOT block: a support engagement
-- that ended must be re-requestable, with a fresh reason and a fresh accept.
create unique index impersonation_sessions_live_pair
  on public.impersonation_sessions (superuser_user_id, target_organisation_id)
  where status in ('requested','accepted','active');

comment on index public.impersonation_sessions_live_pair is
  'At most one LIVE (requested/accepted/active) session per superuser per organisation. Terminal rows are excluded, so a finished engagement is re-requestable -- each re-request needing its own reason and its own admin acceptance, which is the point: consent is per session, never standing.';

alter table public.impersonation_sessions enable row level security;


-- ===========================================================================
-- 2. THE TIME-BOX, IN ONE PLACE
--
-- DECISIONS-QUEUE Q95 (queued with this default, proceeding): 60 minutes.
-- A function rather than a literal because THREE things need to agree on it --
-- the start RPC that stamps expires_at, the UI that renders "session ends
-- at...", and the test that asserts the two agree -- and a literal repeated in
-- three languages is the drift the permission-catalogue migration's own header
-- argues against at length.
-- ===========================================================================
create or replace function private.impersonation_time_box()
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select interval '60 minutes';
$$;

comment on function private.impersonation_time_box() is
  'The impersonation time-box: 60 minutes (DECISIONS-QUEUE Q95, default taken 2026-09-08). Read by public.start_impersonation_session() when it stamps expires_at, and asserted against the TypeScript constant IMPERSONATION_TIME_BOX_MINUTES by tests/integration/rls/impersonation-matches-db.test.ts. Changing the number here changes it everywhere the database is concerned; the binding test is what makes the app agree rather than quietly disagreeing.';

revoke all on function private.impersonation_time_box() from public, anon, authenticated, service_role;
grant execute on function private.impersonation_time_box() to authenticated;


-- ===========================================================================
-- 3. THE GRANT
--
-- ===========================================================================
-- WHY THIS IS SECURITY DEFINER AND NOT AN INLINE SUBQUERY
-- ===========================================================================
-- public.has_permission() is SECURITY INVOKER, so if it read
-- impersonation_sessions directly it would read it UNDER RLS -- and the
-- SELECT policy on that table calls private.permitted_organisations(), which
-- is has_permission's own mirror. That is a policy on a table being evaluated
-- from inside the function the policy calls: not necessarily 42P17, but a
-- cycle a reader has to trace to be sure of, on the hottest predicate in the
-- product. A DEFINER helper reads with RLS off, so the cycle cannot form at
-- all, and the three call sites below all get the identical body.
--
-- ===========================================================================
-- WHAT IT GRANTS: THE `read_only` ROLE'S KEY SET, AND NOTHING ELSE
-- ===========================================================================
-- DECISIONS-QUEUE Q96 (queued with this default, proceeding): impersonation is
-- READ-ONLY at MVP. Rather than list the read keys here -- a literal that
-- would silently miss the next `view_*` key a phase adds -- this joins
-- public.role_permissions for role_key = 'read_only', which IS the product's
-- own definition of "a member who may look and not touch" (today: view_crm and
-- view_network; 20260828120000 and 20260904002000). A future write key
-- accidentally granted to read_only would widen this, which is exactly why
-- rls_phase7_impersonation.sql § IP asserts the read_only key set contains no
-- `manage_` key, as a standing guard rather than a comment.
--
-- Three further conditions, each load-bearing:
--   * has_platform_permission -- the caller must STILL be on the allowlist AND
--     still at aal2. Removing an account from public.platform_admins, or a
--     session dropping below aal2, kills every live impersonation instantly,
--     with no row to update.
--   * expires_at > now() -- THE TIME-BOX, evaluated per permission check.
--   * the Q6 suspension join, mirrored character-for-character from
--     has_permission: a suspended organisation grants only keys marked
--     survives_suspension, for the impersonator exactly as for a member.
-- ===========================================================================
create or replace function private.impersonated_organisations(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.target_organisation_id
  from public.impersonation_sessions s
  join public.role_permissions rp
    on rp.role_key = 'read_only'
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = s.target_organisation_id
   and (o.deleted_at is null or perm.survives_suspension)
  where s.superuser_user_id = (select auth.uid())
    and s.status = 'active'
    and s.expires_at > pg_catalog.now()
    and rp.permission_key = p_permission
    and private.has_platform_permission('impersonate');
$$;

comment on function private.impersonated_organisations(text) is
  'THE IMPERSONATION GRANT. Every organisation in which auth.uid() currently holds p_permission BY VIRTUE OF A LIVE IMPERSONATION SESSION rather than a membership. Four conditions, all required: an impersonation_sessions row for this caller with status = ''active'' AND expires_at > now() (the 60-minute time-box, evaluated on every permission check rather than swept); the caller still holding has_platform_permission (so de-allowlisting or dropping below aal2 kills the session instantly); p_permission being one the `read_only` role grants (Q96 -- the read-only envelope, read out of role_permissions rather than hardcoded, so it cannot drift from the product''s own definition of Read Only); and the Q6 suspension rule, mirrored from has_permission. Called from public.has_permission(), private.permitted_organisations() and private.full_scope_organisations() -- one body, three call sites, so the rule cannot be half-applied.';

revoke all on function private.impersonated_organisations(text) from public, anon, authenticated, service_role;
grant execute on function private.impersonated_organisations(text) to authenticated;


-- ===========================================================================
-- 4. THE THREE FUNCTIONS THAT CONSUME IT
--
-- (a) public.has_permission        -- the per-organisation question
-- (b) private.permitted_organisations -- its set form (the InitPlan shape)
-- (c) private.full_scope_organisations -- RECORD SCOPE
--
-- (c) IS NOT AN AFTERTHOUGHT AND IS THE ONE THAT NEEDS EXPLAINING.
-- `read_only` is a RECORD-SCOPED role (20260828120500: full_scope_organisations
-- excludes standard_user and read_only), which means a Read Only MEMBER sees
-- only rows they own. An impersonating superuser owns nothing in the target
-- organisation, so applying record scope literally would give them a workspace
-- rendering every list as empty -- a feature that is inert by construction,
-- and an e2e "tenant data visible" step that could never pass.
--
-- So the envelope is: THE read_only ROLE'S PERMISSION KEYS, AT FULL RECORD
-- SCOPE. Queued as DECISIONS-QUEUE Q97 with this default, proceeding. The
-- alternative readings were considered and rejected:
--   * literal read_only including record scope -> a blank screen; the feature
--     does not exist.
--   * a wider key set (e.g. manage_*) -> multiplies the attack surface of the
--     product's most dangerous feature for zero support value today (Q96).
-- Full scope grants NOTHING on its own -- 20260828120500's own header says so
-- ("it narrows a permission that permitted_organisations() has already
-- granted") -- so this line cannot widen anything the key set did not already
-- permit, and the key set is reads.
-- ===========================================================================

create or replace function public.has_permission(p_org_id uuid, p_permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    join public.role_permissions rp
      on rp.role_key = m.role
    -- Q6: the catalogue decides whether this key survives suspension.
    join public.permissions perm
      on perm.key = rp.permission_key
    join public.organisations o
      on o.id = m.organisation_id
     and (o.deleted_at is null or perm.survives_suspension)
    where m.user_id = (select auth.uid())
      and m.organisation_id = p_org_id
      and m.status = 'active'
      and rp.permission_key = p_permission
      and (
        not private.role_requires_mfa(m.role)
        or private.session_is_aal2()
      )
  )
  -- PHASE 7 TASK 2: the impersonation disjunct. Written as a second EXISTS
  -- rather than `p_org_id in (select ...)` deliberately: `null in (<non-empty
  -- set>)` evaluates to NULL, which would turn has_permission(NULL, ...) from
  -- the documented, fail-closed FALSE into a NULL -- and design note (b) of
  -- 20260826154304 is explicit that a NULL organisation id must never become
  -- anything but a refusal. EXISTS is always boolean.
  or exists (
    select 1
    from private.impersonated_organisations(p_permission) g
    where g = p_org_id
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Organisation-scoped permission check for auth.uid(). TRUE when EITHER of two things holds. (1) MEMBERSHIP: an active membership of p_org_id whose role grants p_permission, at aal2 if the role requires MFA, subject to the Q6 suspension rule (a soft-deleted organisation grants only keys with public.permissions.survives_suspension). (2) IMPERSONATION (Phase 7 Task 2): a LIVE, UNEXPIRED, admin-accepted impersonation session over p_org_id held by this caller, granting exactly the key set the `read_only` role holds -- see private.impersonated_organisations(), which carries all four of that branch''s conditions. Returns false (never raises, never NULL) for every negative case, including a NULL p_org_id: NULL is not overloaded to mean "platform level", use has_platform_permission() for that. The whole body is mirrored in private.permitted_organisations(); rls_phase2_crm.sql § M asserts the two agree, including against a suspended organisation, and rls_phase7_impersonation.sql § IM re-asserts it with an impersonation session live.';

revoke all on function public.has_permission(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.has_permission(uuid, text) to authenticated;

create or replace function private.permitted_organisations(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  join public.role_permissions rp
    on rp.role_key = m.role
  -- Q6, mirrored from public.has_permission.
  join public.permissions perm
    on perm.key = rp.permission_key
  join public.organisations o
    on o.id = m.organisation_id
   and (o.deleted_at is null or perm.survives_suspension)
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and rp.permission_key = p_permission
    and (
      not private.role_requires_mfa(m.role)
      or private.session_is_aal2()
    )
  -- PHASE 7 TASK 2, mirrored from has_permission's second disjunct. UNION, not
  -- UNION ALL: a caller cannot be both a member and an impersonator of the
  -- same organisation today (the superuser is not a member of the tenants they
  -- support), but a duplicate id here would be a duplicate row in every
  -- `organisation_id in (select ...)` InitPlan, and dedup is free at this
  -- cardinality.
  union
  select g from private.impersonated_organisations(p_permission) g;
$$;

comment on function private.permitted_organisations(text) is
  'Set form of public.has_permission(): every organisation in which auth.uid() currently holds p_permission, by MEMBERSHIP (including the aal2/MFA condition and the Q6 suspension rule) or by a LIVE IMPERSONATION SESSION (Phase 7 Task 2 -- private.impersonated_organisations(), the read_only key set, time-boxed and admin-accepted). Exists so a policy can say `organisation_id in (select ...)`, which the planner hoists into a per-statement InitPlan -- measured at 5210 ms -> 23 ms on a 50k-row paginated list versus the per-row form. It restates has_permission''s body; rls_phase2_crm.sql § M asserts the two agree for every user x organisation x permission, live AND suspended, and rls_phase7_impersonation.sql § IM re-runs that mirror with an impersonation session active. Change one, change all three (full_scope_organisations too).';

revoke all on function private.permitted_organisations(text) from public, anon, authenticated, service_role;
grant execute on function private.permitted_organisations(text) to authenticated;

create or replace function private.full_scope_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and m.role not in ('standard_user', 'read_only')
  -- PHASE 7 TASK 2 / DECISIONS-QUEUE Q97. See § 4's header: `read_only` is a
  -- record-scoped role, an impersonator owns no rows in the target tenant, so
  -- literal record scope would render every list empty and make the feature
  -- inert. 'view_crm' is the probe key rather than a bare "is there a live
  -- session" check so that this line inherits EVERY condition of the grant --
  -- the time-box, the allowlist, aal2, and the Q6 suspension rule -- instead
  -- of restating a weaker subset of them here.
  union
  select g from private.impersonated_organisations('view_crm') g;
$$;

comment on function private.full_scope_organisations() is
  'Record scope (DECISIONS-QUEUE Q3), set form: the organisations where auth.uid() sees every row rather than only their own. Two sources. (1) MEMBERSHIP in a role that is not record-scoped -- standard_user and read_only are the record-scoped roles, written as a constant rather than as a column on public.roles so the rule is not client-readable reference data. (2) A LIVE IMPERSONATION SESSION (Phase 7 Task 2, DECISIONS-QUEUE Q97): an impersonating superuser owns no rows in the target tenant, so applying read_only''s record scope literally would render every list empty and make the feature inert -- the envelope is the read_only KEY SET at FULL record scope, not the read_only role in full. Probed with ''view_crm'' so it inherits every condition of private.impersonated_organisations() (time-box, allowlist, aal2, Q6 suspension) rather than restating a weaker subset. Always used as `org_id in (select ...) or owner_user_id = (select auth.uid())`. GRANTS NOTHING ON ITS OWN -- it narrows a permission that permitted_organisations() has already granted, which is why widening it here cannot widen what an impersonator may do: their key set is reads.';

revoke all on function private.full_scope_organisations() from public, anon, authenticated, service_role;
grant execute on function private.full_scope_organisations() to authenticated;


-- ===========================================================================
-- 5. READ POLICIES
--
-- Two on impersonation_sessions, one on organisations. NO INSERT/UPDATE/DELETE
-- POLICY EXISTS ANYWHERE IN THIS MIGRATION -- every write is an RPC in § 6.
-- ===========================================================================
create policy impersonation_sessions_select_superuser
  on public.impersonation_sessions
  for select
  to authenticated
  using (
    superuser_user_id = (select auth.uid())
    and private.has_platform_permission('impersonate')
  );

comment on policy impersonation_sessions_select_superuser on public.impersonation_sessions is
  'PERMITS: the platform superuser reading their OWN impersonation sessions, at aal2. DOES NOT PERMIT: reading another superuser''s rows (there is one superuser at MVP, but the predicate is per-row rather than "am I a superuser", so a second allowlisted account would not inherit the first''s history); reading anything below aal2. The has_platform_permission term is not redundant with the id comparison: it is what makes an aal1 session -- a stolen password with no factor -- read nothing at all.';

create policy impersonation_sessions_select_target_admin
  on public.impersonation_sessions
  for select
  to authenticated
  using (
    target_organisation_id in (select private.permitted_organisations('manage_organisation'))
  );

comment on policy impersonation_sessions_select_target_admin on public.impersonation_sessions is
  'PERMITS: a manage_organisation holder (Owner/Admin, at aal2 -- both roles are MFA-required) reading impersonation requests AGAINST THEIR OWN organisation, which is how the accept/decline surface is populated. DOES NOT PERMIT: reading another organisation''s requests -- the same tenant boundary every other policy enforces, here over a table whose rows name a superuser rather than a member. NOTE THE SUSPENSION CONSEQUENCE, which is deliberate and measured (rls_phase7_impersonation.sql § IS): manage_organisation has survives_suspension = false, so a SUSPENDED organisation''s admins can neither see nor accept an impersonation request. That follows DECISIONS-QUEUE consequence P7 (suspension is not self-serviceable) rather than contradicting it, and is recorded as DECISIONS-QUEUE Q98.';

-- The organisation ROW itself. Without this the superuser resolves an org slug
-- to nothing and every impersonated route 404s at the segment boundary --
-- lib/auth/index.ts's getCurrentOrg() reads public.organisations through the
-- caller's own RLS by design, and organisations_select_member is membership-only.
--
-- The helper is created FIRST: a policy body is parsed and its functions
-- resolved at CREATE POLICY time, so declaring it after would fail 42883.
create or replace function private.impersonation_counterparty_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.target_organisation_id
  from public.impersonation_sessions s
  where s.superuser_user_id = (select auth.uid())
    and private.has_platform_permission('impersonate');
$$;

comment on function private.impersonation_counterparty_organisations() is
  'Every organisation the calling superuser has an impersonation session row against, at ANY status. Backs organisations_select_impersonation_counterparty. A DEFINER helper rather than an inline subquery in the policy: an inline subquery would read impersonation_sessions under RLS from inside a policy on organisations, whose own SELECT policy calls permitted_organisations, which reads organisations -- a three-table cycle a reader has to trace to rule out. This reads with RLS off and cannot form one.';

revoke all on function private.impersonation_counterparty_organisations() from public, anon, authenticated, service_role;
grant execute on function private.impersonation_counterparty_organisations() to authenticated;

create policy organisations_select_impersonation_counterparty
  on public.organisations
  for select
  to authenticated
  using (id in (select private.impersonation_counterparty_organisations()));

comment on policy organisations_select_impersonation_counterparty on public.organisations is
  'PERMITS: the platform superuser reading the organisations row (id, name, slug, deleted_at, timestamps -- metadata only, no tenant record content) of any organisation they have an impersonation session row against, at aal2. Needed because lib/auth/index.ts''s getCurrentOrg() resolves the URL slug through the caller''s own RLS, so without it every impersonated route would 404 at the segment boundary even with the permission grant in place. DELIBERATELY WIDER THAN THE ACTIVE-SESSION GRANT: it covers requested and terminal rows too, so the superuser''s own /super/impersonation list can name the organisations it is showing. That is not a disclosure -- naming the organisation is how they requested it -- and it is metadata, which CLAUDE.md § Superuser dashboard permits the dashboard to show ("only aggregate metadata"), unlike record content, which no policy in this migration touches.';

-- 20260827232507 set "new tables arrive with no grants", so this is the whole
-- ACL: SELECT only, for authenticated, filtered by the two policies above.
-- NO INSERT/UPDATE/DELETE GRANT TO ANY CLIENT ROLE -- the RPCs in § 6 are
-- SECURITY DEFINER and write as the owner, so the table needs no write grant
-- for the flow to work, and having none means a raw PostgREST write is a 42501
-- before RLS is even consulted.
revoke all on table public.impersonation_sessions from public, anon, authenticated, service_role;
grant select on table public.impersonation_sessions to authenticated;


-- ===========================================================================
-- 6. THE STATE MACHINE -- five RPCs, each guarded, each self-auditing
--
-- SHAPE COPIED FROM 20260908010000 / 20260902031000: a `private` writer with
-- no guard beyond input validation, and a `public` thin RPC carrying the
-- authorisation check -- except that here the guard and the write are so
-- tightly coupled (each transition's precondition IS its authorisation) that
-- splitting them would produce five pairs of one-line functions. So each RPC
-- below is a single `public` SECURITY DEFINER function whose FIRST statement
-- is its guard, raising 42501 before touching a row.
--
-- ===========================================================================
-- CORRELATION: THE SESSION ID IS THE CORRELATING KEY
-- ===========================================================================
-- private.log_audit_event() mints a fresh correlation_id per call unless one
-- is supplied. Every audit row this flow writes supplies the SESSION ID as
-- p_correlation_id, so `select * from audit_events where correlation_id = <the
-- session id> order by created_at` is the complete, ordered story of one
-- impersonation -- request, accept or decline, start, every page reached, end
-- or expiry -- with no join and no separate index. target_id carries the same
-- value, which is redundant on purpose: correlation_id is the thread,
-- target_id is what the row is ABOUT, and the audit viewer filters on
-- different ones of those.
--
-- Every row also carries organisation_id = the TARGET organisation and
-- actor_user_id = the REAL superuser (log_audit_event forces the latter and
-- refuses to let a caller attribute a row to anyone else). So the audit log
-- viewer's organisation filter surfaces an impersonation to whoever is looking
-- at that tenant's events, which is the point.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- request_impersonation(slug, reason) -> session id
--
-- Takes the org SLUG, not an id: the superuser has no directory of ids and
-- resolving one by hand is how a support engineer ends up requesting access to
-- the wrong tenant. The resolution happens INSIDE the definer, so it does not
-- depend on the caller being able to read public.organisations first (which,
-- before the first session row exists, they cannot -- § 5's policy is keyed on
-- exactly the row this call creates).
--
-- A NONEXISTENT SLUG AND A REAL ONE ARE NOT DISTINGUISHABLE... deliberately
-- NOT, here. This is the one place in the product where they are: the caller
-- is the platform superuser at aal2, the whole feature is "reach a named
-- tenant", and a 22023 "no organisation with that slug" is operationally
-- necessary (otherwise a typo produces a request nobody can accept and no
-- explanation). The tenant-isolation rule DESIGN.md states is about one tenant
-- learning another's slugs; it is not about the platform operator.
-- ---------------------------------------------------------------------------
create or replace function public.request_impersonation(
  p_organisation_slug text,
  p_reason            text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_id     uuid;
begin
  if not private.has_platform_permission('impersonate') then
    raise exception 'request_impersonation: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'request_impersonation: a reason is required'
      using errcode = '22023';
  end if;

  select o.id into v_org_id
  from public.organisations o
  where o.slug = pg_catalog.btrim(pg_catalog.lower(p_organisation_slug));

  if v_org_id is null then
    raise exception 'request_impersonation: no organisation with that slug'
      using errcode = '22023';
  end if;

  insert into public.impersonation_sessions
    (superuser_user_id, target_organisation_id, reason, status)
  values
    ((select auth.uid()), v_org_id, pg_catalog.btrim(p_reason), 'requested')
  returning id into v_id;

  perform private.log_audit_event(
    p_action          => 'impersonation.requested',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org_id,
    p_target_id       => v_id,
    p_correlation_id  => v_id,
    p_before          => null,
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'requested',
                           'reason', pg_catalog.btrim(p_reason))
  );

  return v_id;
end;
$$;

comment on function public.request_impersonation(text, text) is
  'Step 1 of the break-glass flow: the platform superuser asks one organisation''s admins for support access, with a mandatory reason. Raises 42501 for any caller who is not the superuser at aal2 (so a non-superuser mints no row and learns nothing), 22023 for an empty reason or an unknown slug, and 23505 when a live (requested/accepted/active) session against that organisation already stands. ACCEPTANCE IS NOT IMPLIED AND NO ACCESS IS GRANTED HERE -- the row is created at status ''requested'', which private.impersonated_organisations() ignores. Audits ''impersonation.requested'' with the new session id as BOTH target_id and correlation_id: that id is the thread every later event in this session hangs off.';

revoke all on function public.request_impersonation(text, text) from public, anon, service_role;
grant execute on function public.request_impersonation(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- accept_impersonation_request(session id)
--
-- THE CONSENT. The one gate that makes this break-glass rather than a back
-- door. It requires manage_organisation in the TARGET organisation, which is
-- Owner/Admin only and (both being MFA-required roles) implies aal2.
--
-- ACCEPTANCE DOES NOT START THE SESSION. Task brief, and it matters: the org
-- admin agrees that support MAY look, and the superuser then decides when,
-- which is what keeps `started_at`/`expires_at` an accurate record of when
-- someone was actually inside rather than of when a form was submitted.
-- ---------------------------------------------------------------------------
create or replace function public.accept_impersonation_request(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select s.target_organisation_id into v_org
  from public.impersonation_sessions s
  where s.id = p_session_id and s.status = 'requested';

  -- ONE REFUSAL FOR "no such row", "not yours" AND "already answered". The
  -- lookup above runs with RLS off (definer), so it finds rows in every
  -- tenant; the permission check below is what confines the caller to their
  -- own. Collapsing the three cases means a foreign admin probing session ids
  -- cannot tell a real id in another tenant from a fabricated one.
  if v_org is null or not public.has_permission(v_org, 'manage_organisation') then
    raise exception 'accept_impersonation_request: no pending request you may answer'
      using errcode = '42501';
  end if;

  update public.impersonation_sessions
  set status            = 'accepted',
      admin_accepted_by = (select auth.uid()),
      accepted_at       = pg_catalog.now()
  where id = p_session_id and status = 'requested';

  perform private.log_audit_event(
    p_action          => 'impersonation.accepted',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'requested'),
    p_after           => pg_catalog.jsonb_build_object('status', 'accepted')
  );
end;
$$;

comment on function public.accept_impersonation_request(uuid) is
  'Step 2a: an Owner/Admin of the TARGET organisation consents. Requires manage_organisation in that organisation (Owner/Admin only, both MFA-required, so aal2 is implied); every other caller gets one 42501 that does not distinguish "no such session" from "another tenant''s session" from "already answered". ACCEPTING GRANTS NO ACCESS BY ITSELF: private.impersonated_organisations() reads status = ''active'', and only public.start_impersonation_session() sets that. Audits ''impersonation.accepted'' on the session''s correlation thread, with the real actor (the accepting admin) as actor_user_id. CONSEQUENCE, DELIBERATE (DECISIONS-QUEUE Q98): manage_organisation has survives_suspension = false, so a SUSPENDED organisation cannot accept -- consistent with consequence P7 (suspension is not self-serviceable), and measured rather than assumed in rls_phase7_impersonation.sql § IS.';

revoke all on function public.accept_impersonation_request(uuid) from public, anon, service_role;
grant execute on function public.accept_impersonation_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- decline_impersonation_request(session id)
--
-- Terminal, and the row stays: a declined request is part of the record, not
-- something to delete. It stops blocking the live pair (the partial unique
-- index excludes terminal statuses), so support can ask again with a better
-- reason -- the same shape the founder's 2026-09-07 Q79 ruling gave connection
-- requests, and for the same reason: a permanent block is a denial-of-support
-- vector, and the anti-harassment argument does not apply between a customer
-- and their own vendor.
-- ---------------------------------------------------------------------------
create or replace function public.decline_impersonation_request(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select s.target_organisation_id into v_org
  from public.impersonation_sessions s
  where s.id = p_session_id and s.status = 'requested';

  if v_org is null or not public.has_permission(v_org, 'manage_organisation') then
    raise exception 'decline_impersonation_request: no pending request you may answer'
      using errcode = '42501';
  end if;

  update public.impersonation_sessions
  set status      = 'declined',
      declined_by = (select auth.uid()),
      declined_at = pg_catalog.now()
  where id = p_session_id and status = 'requested';

  perform private.log_audit_event(
    p_action          => 'impersonation.declined',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'requested'),
    p_after           => pg_catalog.jsonb_build_object('status', 'declined')
  );
end;
$$;

comment on function public.decline_impersonation_request(uuid) is
  'Step 2b: the target organisation refuses. Same guard, same single 42501, same correlation thread as accept. The row is TERMINAL and is kept -- a decline is part of the record -- but it no longer blocks the live-pair unique index, so support may ask again with a fresh reason and a fresh consent. Grants nothing, ever: ''declined'' is not a status private.impersonated_organisations() looks at.';

revoke all on function public.decline_impersonation_request(uuid) from public, anon, service_role;
grant execute on function public.decline_impersonation_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- start_impersonation_session(session id) -> expires_at
--
-- The only function that produces a grant. Stamps the time-box from
-- private.impersonation_time_box() rather than from a literal, and returns
-- expires_at so the UI's "session ends at ..." is the DATABASE's answer rather
-- than a clock the browser computed for itself.
-- ---------------------------------------------------------------------------
create or replace function public.start_impersonation_session(p_session_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_expires timestamptz;
begin
  if not private.has_platform_permission('impersonate') then
    raise exception 'start_impersonation_session: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  update public.impersonation_sessions
  set status      = 'active',
      started_at  = pg_catalog.now(),
      expires_at  = pg_catalog.now() + private.impersonation_time_box()
  where id = p_session_id
    and superuser_user_id = (select auth.uid())
    and status = 'accepted'
  returning target_organisation_id, expires_at into v_org, v_expires;

  -- THE GUARD IS THE UPDATE'S OWN WHERE CLAUSE. Ownership and state are
  -- checked in the statement that changes the row, not in a SELECT before it,
  -- so there is no window between the check and the write in which another
  -- transaction could move the row.
  if v_org is null then
    raise exception 'start_impersonation_session: no accepted session of yours with that id'
      using errcode = '42501';
  end if;

  perform private.log_audit_event(
    p_action          => 'impersonation.started',
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'accepted'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', 'active',
                           'expires_at', v_expires)
  );

  return v_expires;
end;
$$;

comment on function public.start_impersonation_session(uuid) is
  'Step 3: the superuser opens the accepted window. THE ONLY FUNCTION THAT PRODUCES A GRANT -- it sets status = ''active'' and stamps expires_at = now() + private.impersonation_time_box() (60 minutes, Q95). Ownership and current state are enforced by the UPDATE''s own WHERE clause rather than by a preceding SELECT, so there is no check-then-write window; a session that is not yours, not accepted, or already started raises one 42501 that does not say which. Returns expires_at so the banner''s "session ends at" is the database''s answer, not the browser''s arithmetic. Audits ''impersonation.started'' on the session''s correlation thread.';

revoke all on function public.start_impersonation_session(uuid) from public, anon, service_role;
grant execute on function public.start_impersonation_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- end_impersonation_session(session id) -> the terminal status
--
-- EITHER PARTY MAY END IT. The superuser closing their own window is the
-- ordinary case; the target organisation's admin revoking consent mid-session
-- is the one that matters, and costs one extra disjunct. A customer who can
-- grant access and not withdraw it has not really consented.
--
-- IT ALSO RECORDS EXPIRY. If the clock has already run out, the terminal
-- status is 'expired' and the audit action is 'impersonation.expired' -- the
-- honest record of what happened, rather than backdating it as a deliberate
-- end. Note that this is BOOKKEEPING, NOT ENFORCEMENT: the session stopped
-- granting anything at expires_at whether or not anyone ever calls this.
-- ---------------------------------------------------------------------------
create or replace function public.end_impersonation_session(p_session_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_expires timestamptz;
  v_by_role text;
  v_status  text;
begin
  select s.target_organisation_id, s.expires_at into v_org, v_expires
  from public.impersonation_sessions s
  where s.id = p_session_id and s.status = 'active';

  if v_org is null then
    raise exception 'end_impersonation_session: no active session with that id'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.impersonation_sessions s
    where s.id = p_session_id
      and s.superuser_user_id = (select auth.uid())
  ) and private.has_platform_permission('impersonate') then
    v_by_role := 'superuser';
  elsif public.has_permission(v_org, 'manage_organisation') then
    v_by_role := 'organisation_admin';
  else
    raise exception 'end_impersonation_session: you may not end that session'
      using errcode = '42501';
  end if;

  v_status := case when v_expires <= pg_catalog.now() then 'expired' else 'ended' end;

  update public.impersonation_sessions
  set status   = v_status,
      ended_at = pg_catalog.now()
  where id = p_session_id and status = 'active';

  perform private.log_audit_event(
    p_action          => 'impersonation.' || v_status,
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'active'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', v_status,
                           'ended_by', v_by_role)
  );

  return v_status;
end;
$$;

comment on function public.end_impersonation_session(uuid) is
  'Step 4: close the window. EITHER PARTY MAY CALL IT -- the superuser who holds the session, or a manage_organisation holder in the target organisation revoking consent mid-session (a customer who can grant access but not withdraw it has not really consented). Anyone else gets 42501. Writes ''ended'' when the clock was still running and ''expired'' when it had already lapsed, and audits ''impersonation.ended'' / ''impersonation.expired'' accordingly, with `after.ended_by` naming which party did it. THE EXPIRY BRANCH IS BOOKKEEPING, NOT ENFORCEMENT: private.impersonated_organisations() stopped returning the organisation at expires_at whether or not this is ever called, which is why no sweep job is owed.';

revoke all on function public.end_impersonation_session(uuid) from public, anon, service_role;
grant execute on function public.end_impersonation_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- audit_impersonated_page_view(org id, route)
--
-- CLAUDE.md § Non-negotiable rules: "Superuser access audits itself" -- and
-- this task's brief: "every impersonated page access (route only, no
-- content)". THE ROUTE, AND NOTHING ELSE. There is no parameter here that
-- could carry a record's name, a search term or a row id, and the guard means
-- a caller with no live session cannot mint a row at all.
--
-- Route only, and truncated: a path can carry a record UUID in a segment,
-- which is an identifier of a tenant row rather than its content, and which
-- the audit trail is entitled to (the whole point is to know WHERE support
-- looked). A query string could carry a search term, so the app strips it
-- before calling -- and 500 characters is the ceiling regardless.
-- ---------------------------------------------------------------------------
create or replace function public.audit_impersonated_page_view(
  p_organisation_id uuid,
  p_route           text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  -- THE GUARD IS THE GRANT ITSELF. Not a separate predicate that could drift:
  -- if this caller does not have a live, unexpired, accepted session over
  -- p_organisation_id, private.impersonated_organisations() does not return
  -- it, and there is nothing to audit because nothing was reachable.
  if p_organisation_id is null
     or p_organisation_id not in (select private.impersonated_organisations('view_crm'))
  then
    raise exception 'audit_impersonated_page_view: no live impersonation session over that organisation'
      using errcode = '42501';
  end if;

  select s.id into v_session
  from public.impersonation_sessions s
  where s.superuser_user_id = (select auth.uid())
    and s.target_organisation_id = p_organisation_id
    and s.status = 'active'
    and s.expires_at > pg_catalog.now();

  return private.log_audit_event(
    p_action          => 'impersonation.page_viewed',
    p_target_type     => 'impersonation_session',
    p_organisation_id => p_organisation_id,
    p_target_id       => v_session,
    p_correlation_id  => v_session,
    p_before          => null,
    p_after           => pg_catalog.jsonb_build_object(
                           'route', pg_catalog.left(pg_catalog.btrim(coalesce(p_route, '')), 500))
  );
end;
$$;

comment on function public.audit_impersonated_page_view(uuid, text) is
  'Records that an impersonating superuser reached one route of the target organisation. ROUTE ONLY, NEVER CONTENT -- the signature has no parameter that could carry a record name, a search term or a result count, and the app strips the query string before calling (a path segment''s record id is deliberately kept: knowing WHERE support looked is the whole point). Guarded by the GRANT ITSELF rather than by a second predicate that could drift from it: a caller with no live, unexpired, accepted session over p_organisation_id raises 42501 and mints no row -- so this RPC, though reachable by any authenticated caller with the anon key like every other RPC, is worth nothing to anyone but a superuser mid-session. Shares the session''s correlation_id, so the page trail reads in order alongside the request/accept/start/end events.';

revoke all on function public.audit_impersonated_page_view(uuid, text) from public, anon, service_role;
grant execute on function public.audit_impersonated_page_view(uuid, text) to authenticated;
