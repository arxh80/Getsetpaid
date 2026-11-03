-- ===========================================================================
-- PHASE 8 TASK 3 -- DATA SUBJECT REQUESTS: INTAKE, TRACKING AND THE
-- FULFILMENT WORKFLOW.
--
-- CLAUDE.md § Legal and regulatory compliance: "Data subject request
-- (export/erasure) target: 30 days, matching the ICO statutory maximum. Build
-- the DSR workflow to hit this deadline, not just aim for it informally."
-- PRD §11 names `Data subject request` as a domain entity; PRD §12's Data
-- Subject Rights page lists the six rights this table's `right_type` carries.
--
-- ===========================================================================
-- WHAT THIS IS, AND WHAT IT IS NOT
-- ===========================================================================
-- It is the REQUEST: who asked, which right, what they said, what state it is
-- in, when it is due and what happened. It is NOT the machinery that produces
-- an export (Task 4) or performs an erasure (Task 5). The seam those tasks
-- plug into is section 7 below -- three columns and one deliberately dormant
-- predicate -- so that the day a job exists, marking an account-level access
-- or erasure request `fulfilled` without that job having run becomes
-- impossible in the database rather than by convention.
--
-- ===========================================================================
-- THE CONTROLLER / PROCESSOR SPLIT (Q132) IS A COLUMN, NOT A CONVENTION
-- ===========================================================================
-- GetSetPaid is the CONTROLLER of account data (the login, the profile,
-- workspace memberships, feedback, the audit trail) and a PROCESSOR for the
-- CRM records a customer workspace holds ABOUT a person (a contact, an
-- artist). Those are different legal obligations with different answers, so
-- `subject_scope` is on the row from the moment it is created:
--
--   'account'           -- we are the controller; we fulfil it ourselves.
--   'workspace_records' -- a customer workspace is the controller; we ROUTE
--                          it to that workspace's Owner and record which
--                          workspace and when (`routed_to_organisation_id`,
--                          `routed_at`). We do not answer it on their behalf.
--
-- The workspace is named by the OPERATOR when routing, never by the
-- requester: a person who is a contact in a promoter's workspace is normally
-- not a member of it, cannot see its id, and often does not know its name --
-- they describe it in `detail` and the operator identifies it. That also
-- removes the question "may a requester name a workspace they have no
-- relationship with", by removing the input.
--
-- ===========================================================================
-- IDENTITY VERIFICATION: THE SESSION IS THE VERIFICATION, AND THERE IS NO
-- OTHER INTAKE
-- ===========================================================================
-- A request can only be made from a signed-in account and is attributed to
-- that account by the BEFORE INSERT trigger, with no user argument anywhere
-- in the write path -- so "is this really them" is answered by the same
-- authentication that protects everything else the account can reach. This
-- product accepts NO other intake: there is no unauthenticated DSR form and
-- no operator-filed request, deliberately, because either would put identity
-- verification in an operator's hands with no evidence trail. A person with
-- no account (or one who cannot sign in) is told on /legal/data-subject-rights
-- to email the contact address, and that is handled as correspondence outside
-- this table. Should that ever change, the operator's verification steps have
-- to be written down first; SECURITY.md § 8 carries the statement.
--
-- ===========================================================================
-- THE FREE TEXT NEVER REACHES THE AUDIT LOG
-- ===========================================================================
-- `detail` and `rejection_reason` are untrusted input. `audit_events` is
-- readable by the platform superuser ACROSS EVERY TENANT (SECURITY.md § 7),
-- so no audit payload here carries either -- every payload is identifiers,
-- enums and timestamps, the same discipline the CRM write audit and the
-- consent audit keep. `rejection_reason` is shown BACK to the requester, so
-- the operator's field hint warns them (the Q103 precedent, established for
-- `organisations.lifecycle_reason`).
--
-- ADDITIVE. New objects only.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE SIX RIGHTS, AND WHAT FULFILLING EACH ONE WILL TAKE
-- ---------------------------------------------------------------------------
-- PRD §12's Data Subject Rights page lists exactly these six. The second
-- column is the SEAM: which later task's job must have run before an
-- account-scope request of that right can be marked fulfilled.

create or replace function private.dsr_rights()
returns table (right_type text, fulfilment_kind text)
language sql
immutable
set search_path = ''
as $$
  values ('access'::text,        'export'::text),
         ('portability',         'export'),
         ('erasure',             'erasure'),
         ('rectification',       null),
         ('restriction',         null),
         ('objection',           null);
$$;

comment on function private.dsr_rights() is
  'THE closed list of rights a data subject request may exercise (Phase 8 Task 3; PRD §12 Data Subject Rights): access, rectification, erasure, restriction, objection, portability. fulfilment_kind names the machinery a later task must have run before an ACCOUNT-SCOPE request of that right can be marked fulfilled -- ''export'' (Task 4) for access and portability, ''erasure'' (Task 5) for erasure, null for the three an operator answers by hand. Mirrored by lib/dsr/contract.ts and asserted equal by tests/integration/legal/catalogue-bindings-match-db.test.ts.';

revoke all on function private.dsr_rights() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE 30-DAY CLOCK, IN ONE PLACE
-- ---------------------------------------------------------------------------

create or replace function private.dsr_response_days()
returns integer
language sql
immutable
set search_path = ''
as $$ select 30 $$;

comment on function private.dsr_response_days() is
  'The statutory response window for a data subject request: 30 days (ICO maximum; CLAUDE.md § Decisions log, "GDPR DSR turnaround target: 30 days"). ONE place, read by lib/dsr/contract.ts and bound to public.data_subject_requests.due_by''s generated expression by the psql suite. UK GDPR permits an extension of up to two further months for a complex request; that is a conversation with the requester, not a column -- extending the clock silently is exactly what "cannot be quietly missed" forbids.';

revoke all on function private.dsr_response_days() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE TABLE
-- ---------------------------------------------------------------------------

create table public.data_subject_requests (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,

  -- WHO. Stamped from the session by the BEFORE INSERT trigger; there is no
  -- user argument in any write path, so it cannot be forged.
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- The address the request was made from, snapshotted: the account may later
  -- change its email, and "we acted on a request from this address" is part of
  -- the evidence. Stamped by the trigger from auth.users, never supplied.
  user_email   text not null,

  right_type    text not null,
  subject_scope text not null,

  -- UNTRUSTED INPUT. What the person wrote. Never audited, never rendered as
  -- HTML, bounded so a form post cannot be an ingestion channel.
  detail       text not null,

  status       text not null default 'open',

  requested_at timestamptz not null default pg_catalog.now(),

  -- THE DATABASE COMPUTES THE DEADLINE, AND NOBODY CAN WRITE IT.
  -- A GENERATED column rather than a trigger-stamped one: a trigger can be
  -- disabled, a generated column cannot be written even by `postgres`
  -- (428C9). The 30 is inlined rather than called because a generated
  -- expression must be immutable and may not call a user function; the psql
  -- suite binds it to private.dsr_response_days().
  --
  -- THE DETOUR THROUGH UTC IS NOT DECORATION. `timestamptz + interval` is
  -- only STABLE (it consults the session TimeZone for DST), and a generated
  -- expression must be IMMUTABLE. `timezone('UTC', ts)` names its zone, so it
  -- and the `timestamp + interval` inside it both are -- and the arithmetic
  -- is thirty 86,400-second days rather than "the same wall-clock time thirty
  -- days later", which is the right reading of a statutory deadline anyway.
  due_by       timestamptz generated always as
                 (((requested_at at time zone 'UTC') + interval '30 days')
                    at time zone 'UTC') stored,

  -- Terminal stamps. Each is set by the transition trigger, never by a caller.
  fulfilled_at timestamptz,
  rejected_at  timestamptz,
  withdrawn_at timestamptz,

  -- UNTRUSTED INPUT, SHOWN BACK TO THE REQUESTER (Q103 precedent).
  rejection_reason text,

  -- The processor half (Q132): which workspace it was handed to, and when.
  routed_at                 timestamptz,
  routed_to_organisation_id uuid references public.organisations (id) on delete set null,

  -- THE TASK 4 / TASK 5 SEAM. See section 7.
  fulfilment_kind        text,
  fulfilment_reference   uuid,
  fulfilment_recorded_at timestamptz,

  constraint data_subject_requests_seq_unique unique (seq),

  constraint data_subject_requests_right_known
    check (right_type in ('access', 'rectification', 'erasure',
                          'restriction', 'objection', 'portability')),
  constraint data_subject_requests_scope_known
    check (subject_scope in ('account', 'workspace_records')),
  constraint data_subject_requests_status_known
    check (status in ('open', 'in_progress', 'routed',
                      'fulfilled', 'rejected', 'withdrawn')),

  constraint data_subject_requests_detail_length
    check (pg_catalog.length(detail) between 1 and 4000),
  constraint data_subject_requests_rejection_reason_length
    check (rejection_reason is null
           or pg_catalog.length(rejection_reason) between 1 and 2000),

  -- Each terminal state has its own stamp, and only that stamp.
  constraint data_subject_requests_fulfilled_stamp
    check ((status = 'fulfilled') = (fulfilled_at is not null)),
  constraint data_subject_requests_rejected_stamp
    check ((status = 'rejected') = (rejected_at is not null)),
  constraint data_subject_requests_withdrawn_stamp
    check ((status = 'withdrawn') = (withdrawn_at is not null)),
  -- A rejection says why. An unexplained refusal of a statutory right is not
  -- a thing this product can record.
  constraint data_subject_requests_rejection_has_reason
    check ((status = 'rejected') = (rejection_reason is not null)),

  -- Routing: both halves or neither, and only ever for a processor request.
  constraint data_subject_requests_routing_pair
    check ((routed_at is null) = (routed_to_organisation_id is null)),
  constraint data_subject_requests_routing_is_processor_only
    check (routed_at is null or subject_scope = 'workspace_records'),
  constraint data_subject_requests_routed_status_has_routing
    check (status <> 'routed' or routed_at is not null),

  -- The seam's three columns move together or not at all.
  constraint data_subject_requests_fulfilment_triple
    check (num_nonnulls(fulfilment_kind, fulfilment_reference, fulfilment_recorded_at) in (0, 3)),
  constraint data_subject_requests_fulfilment_kind_known
    check (fulfilment_kind is null or fulfilment_kind in ('export', 'erasure'))
);

comment on table public.data_subject_requests is
  'Data subject requests (Phase 8 Task 3; PRD §11/§12, CLAUDE.md § Legal and regulatory compliance). One row per request: the account that made it (stamped from the session -- no write path takes a user argument), which of the six rights, whether GetSetPaid is the controller (subject_scope = account) or a processor for a customer workspace (workspace_records, Q132), the person''s own words, the state, and a due_by the DATABASE computes as requested_at + 30 days in a GENERATED column no role can write. Every state change goes through private.data_subject_requests_before_update(), which is the transition table, the who-may-do-it check and the stamper; nothing is enforced only in the app. detail and rejection_reason are untrusted free text and never reach audit_events. Operator working notes live in public.data_subject_request_notes, a table the requester has no read of at all (Q103: a column on a readable row is readable).';

comment on column public.data_subject_requests.due_by is
  'requested_at + 30 days, computed by the database (ICO statutory maximum; CLAUDE.md § Decisions log). GENERATED ALWAYS, so an INSERT or UPDATE naming it is 428C9 for every role including postgres -- the deadline is not something a client, an operator or a repair script can move.';
comment on column public.data_subject_requests.detail is
  'What the requester wrote, verbatim. UNTRUSTED: rendered as inert text, never as HTML, never copied into an audit payload (audit_events is superuser-readable across tenants), bounded to 4000 characters.';
comment on column public.data_subject_requests.rejection_reason is
  'Why the operator refused, shown BACK to the requester. Untrusted operator free text -- the form hint says the requester will read it, the Q103 precedent from organisations.lifecycle_reason. Never audited.';
comment on column public.data_subject_requests.routed_to_organisation_id is
  'Q132: for a workspace_records request, the customer workspace that is the controller and whose Owner the request was handed to. Set by the OPERATOR when routing, never by the requester -- a person who is a contact in a workspace is normally not a member of it and cannot name it.';
comment on column public.data_subject_requests.fulfilment_kind is
  'The Task 4 / Task 5 seam. Written ONLY by a server-side job (the trigger refuses it from any path where row security is active), together with fulfilment_reference and fulfilment_recorded_at. See private.dsr_fulfilment_jobs_ready().';

create index data_subject_requests_user_seq_idx
  on public.data_subject_requests (user_id, seq desc);
-- The operator's queue: oldest-due first, open requests only.
create index data_subject_requests_open_due_idx
  on public.data_subject_requests (due_by, id)
  where status in ('open', 'in_progress', 'routed');
create index data_subject_requests_due_by_idx
  on public.data_subject_requests (due_by, id);
create index data_subject_requests_routed_org_idx
  on public.data_subject_requests (routed_to_organisation_id);


-- ---------------------------------------------------------------------------
-- 4. GRANTS AND RLS
-- ---------------------------------------------------------------------------
-- SELECT only, for both audiences. Every write is an RPC over the triggers
-- below -- the shape public.consents established: no client write grant means
-- no raw PostgREST write to reason about, and the trigger is the one
-- chokepoint every writer passes.

revoke all on public.data_subject_requests from public, anon, authenticated, service_role;
grant select on public.data_subject_requests to authenticated;

alter table public.data_subject_requests enable row level security;

create policy data_subject_requests_select_own
  on public.data_subject_requests for select to authenticated
  using (user_id = (select auth.uid()));

comment on policy data_subject_requests_select_own on public.data_subject_requests is
  'PERMITS: a signed-in person to read their OWN requests -- the status, the due date, the outcome and, if it was refused, the reason. Q103 was applied to the column list rather than assumed: every column of this table is one the requester is entitled to see. The operator''s working notes are NOT on this row; they are in public.data_subject_request_notes, which is a different table with a different policy. DOES NOT PERMIT: reading anybody else''s request, or any write.';

create policy data_subject_requests_select_platform
  on public.data_subject_requests for select to authenticated
  using ((select private.has_platform_permission('oversee_data_subject_requests')));

comment on policy data_subject_requests_select_platform on public.data_subject_requests is
  'PERMITS: the platform superuser (allowlisted, aal2) to read every request -- the queue at /super/data-requests. METADATA AND THE REQUESTER''S OWN WORDS ONLY: this table holds no tenant CRM record content, so CLAUDE.md § Superuser dashboard''s "never shows record content" rule holds without a column-level narrowing. DOES NOT PERMIT: any write -- every transition is an RPC.';


-- ---------------------------------------------------------------------------
-- 5. OPERATOR NOTES -- A SEPARATE TABLE, BECAUSE RLS FILTERS ROWS
-- ---------------------------------------------------------------------------
-- Q103, stated as the standing rule it now is: a column on a row somebody can
-- read IS readable by them, and a policy cannot hide it. So "internal notes
-- the requester cannot read" cannot be a column on data_subject_requests. It
-- is its own table, with one superuser SELECT policy and nothing else.

create table public.data_subject_request_notes (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.data_subject_requests (id) on delete cascade,
  author_user_id uuid not null references auth.users (id),
  body           text not null,
  created_at     timestamptz not null default pg_catalog.now(),

  constraint data_subject_request_notes_body_length
    check (pg_catalog.length(body) between 1 and 4000)
);

comment on table public.data_subject_request_notes is
  'The operator''s working notes on a data subject request (Phase 8 Task 3). A SEPARATE TABLE on purpose: RLS filters rows and not columns (Q103), so a "private" column on public.data_subject_requests would be readable by the requester through PostgREST whatever any page chose to render. The only policy is the aal2 platform superuser''s SELECT; writes go through public.add_data_subject_request_note(). Never shown to the requester, and its body never reaches audit_events.';

create index data_subject_request_notes_request_idx
  on public.data_subject_request_notes (request_id, created_at desc);
create index data_subject_request_notes_author_idx
  on public.data_subject_request_notes (author_user_id);

revoke all on public.data_subject_request_notes from public, anon, authenticated, service_role;
grant select on public.data_subject_request_notes to authenticated;

alter table public.data_subject_request_notes enable row level security;

create policy data_subject_request_notes_select_platform
  on public.data_subject_request_notes for select to authenticated
  using ((select private.has_platform_permission('oversee_data_subject_requests')));

comment on policy data_subject_request_notes_select_platform on public.data_subject_request_notes is
  'The ONLY policy on this table: the allowlisted aal2 platform superuser reads operator notes. There is deliberately no own-rows policy -- the requester is not the author and must never read these. The table grant is to `authenticated` because the superuser''s own PostgREST session authenticates as that role; the policy is what makes it a superuser-only read, and rls_phase8_data_subject_requests.sql § DN asserts that the requester reads ZERO rows of the notes on their own request while the superuser reads them.';


-- ---------------------------------------------------------------------------
-- 6. THE METER'S POLICY ROW
-- ---------------------------------------------------------------------------
-- WHY 10 A DAY IS SAFE, and why the window is a day rather than an hour. A
-- DSR form is a spam vector (free text, operator-read, deadline-bearing), but
-- refusing a genuine request is a statutory failure, so the number has to sit
-- well above any honest burst. Six rights x two scopes = twelve distinct
-- honest requests a person could conceivably make, and nobody makes twelve in
-- a day: ten covers filing several rights, mistyping one and re-filing it,
-- and changing their mind. A refusal names the seconds until the window
-- lifts, and /legal/data-subject-rights gives the email address as the route
-- that is never rate limited -- so the limit can never be the reason a
-- statutory request goes unmade. Withdrawals are metered nowhere: the consent
-- ledger's rule that undoing must never be harder than doing.
insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('data_subject_request', 'user', 10, 86400,
        'Data subject requests submitted per user per 24 hours (Phase 8 Task 3). Enforced at the insert by private.data_subject_requests_before_insert(); withdrawals are never metered.');


-- ---------------------------------------------------------------------------
-- 7. THE FULFILMENT SEAM -- DESIGNED NOW, ENFORCED WHEN THE JOB EXISTS
-- ---------------------------------------------------------------------------
-- This task's brief: "make it impossible to mark an access or erasure request
-- fulfilled without the corresponding job having actually run, once those
-- jobs exist (design the constraint now; enforce it in the task that ships
-- the job)."
--
-- The constraint is written and live in
-- private.data_subject_requests_before_update() below. What is dormant is
-- this ONE predicate: while it answers false, an operator may close an
-- account-scope access request by hand, because by hand is the only way there
-- is. Task 4 and Task 5 each re-issue it (create or replace, one line) when
-- their job lands, and the constraint starts biting with no other change
-- anywhere. A one-function diff is what makes it reviewable -- and § DF of
-- the psql suite flips it inside a rolled-back transaction, so the rule is
-- asserted NOW rather than trusted to be written correctly later.

create or replace function private.dsr_fulfilment_jobs_ready()
returns boolean
language sql
immutable
set search_path = ''
as $$ select false $$;

comment on function private.dsr_fulfilment_jobs_ready() is
  'FALSE until Phase 8 Task 4 (account export) and Task 5 (account erasure) ship. While it is false, an account-scope access/portability/erasure request may be marked fulfilled by hand -- there is no job to have run. When a task re-issues this as `select true`, private.data_subject_requests_before_update() starts refusing (22023, hint fulfilment_not_recorded) any such transition whose fulfilment_kind / fulfilment_reference / fulfilment_recorded_at are still null. The dormancy is the point: the rule is written, reviewed and asserted now (rls_phase8_data_subject_requests.sql § DF), so shipping the job is a one-line change rather than a new guard nobody remembers to write.';

revoke all on function private.dsr_fulfilment_jobs_ready() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 8. THE CHOKEPOINT: BEFORE INSERT
-- ---------------------------------------------------------------------------

create or replace function private.data_subject_requests_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_email  text;
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
  v_after  integer;
  v_retry  integer;
begin
  -- (1) WHO. A data subject request is the data subject's own act, and the
  -- session IS the identity verification (see the header). No session, no
  -- request -- the consent ledger's posture, not feedback's "a sessionless
  -- writer is a fixture" one: a fixture that could file a request for anybody
  -- could start a statutory clock in somebody else's name.
  if v_uid is null then
    raise exception 'data_subject_requests: a request can only be made from the requester''s own session'
      using errcode = '42501';
  end if;
  new.user_id := v_uid;

  select u.email into v_email from auth.users u where u.id = v_uid;
  if v_email is null or pg_catalog.btrim(v_email) = '' then
    raise exception 'data_subject_requests: the requesting account has no email address'
      using errcode = '22023', hint = 'no_account_email';
  end if;
  new.user_email := v_email;

  -- (2) WHAT. Closed vocabularies, read from the catalogue rather than left
  -- to the CHECK, so the error names the input instead of a constraint.
  if not exists (select 1 from private.dsr_rights() r where r.right_type = new.right_type) then
    raise exception 'data_subject_requests: % is not one of the six rights', new.right_type
      using errcode = '22023', hint = 'unknown_right';
  end if;
  if new.subject_scope is null or new.subject_scope not in ('account', 'workspace_records') then
    raise exception 'data_subject_requests: subject_scope must be account or workspace_records'
      using errcode = '22023', hint = 'unknown_scope';
  end if;

  -- (3) THE STATE AND THE CLOCK ARE THE DATABASE'S. A new request is always
  -- open and always requested now, so the generated 30-day due_by can be
  -- neither back-dated nor pushed out.
  new.status       := 'open';
  new.requested_at := pg_catalog.now();
  new.fulfilled_at := null;
  new.rejected_at  := null;
  new.withdrawn_at := null;
  new.rejection_reason := null;
  new.routed_at    := null;
  new.routed_to_organisation_id := null;
  new.fulfilment_kind        := null;
  new.fulfilment_reference   := null;
  new.fulfilment_recorded_at := null;

  -- (4) THE METER -- submissions only, after every refusal above, so a
  -- malformed post spends nothing. The consent ledger's shape.
  select * into v_policy from public.rate_limit_policies p where p.category = 'data_subject_request';
  if not found then
    raise exception 'data_subject_requests: no rate-limit policy for data_subject_request' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
    from public.rate_limit_counters c
   where c.category      = 'data_subject_request'
     and c.subject_scope = 'user'
     and c.subject_id    = v_uid
     and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  if v_count >= v_policy.max_requests then
    raise exception 'data_subject_requests: too many requests (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  select r.request_count into v_after
    from private.record_rate_limit_event('data_subject_request', 'user', v_uid, null) r;

  if v_after > v_policy.max_requests then
    raise exception 'data_subject_requests: too many requests (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  if v_after = v_policy.max_requests then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'rate_limit_tripped',
      null,
      pg_catalog.format(
        'Rate limit reached: data_subject_request (limit %s per %s seconds).',
        v_policy.max_requests, v_policy.window_seconds),
      pg_catalog.jsonb_build_object(
        'category',        'data_subject_request',
        'subject_scope',   'user',
        'subject_id',      v_uid,
        'window_start',    v_window,
        'max_requests',    v_policy.max_requests,
        'window_seconds',  v_policy.window_seconds,
        'counts_refusals', false
      )
    );
  end if;

  return new;
end;
$$;

comment on function private.data_subject_requests_before_insert() is
  'BEFORE INSERT on public.data_subject_requests, for EVERY writer: refuses a sessionless write (42501); stamps user_id and user_email from the session (no write path takes either, so attribution is non-forgeable by construction); refuses a right or a scope outside the catalogue (22023 unknown_right / unknown_scope); forces status=open and requested_at=now() so the 30-day generated due_by cannot be back- or forward-dated; nulls every outcome column; and meters submissions at 10 per 24 hours per user (PT429, remaining seconds in HINT, crossing alert at the last accepted submission). Withdrawals are metered nowhere.';

revoke all on function private.data_subject_requests_before_insert() from public, anon, authenticated, service_role;

create trigger data_subject_requests_before_insert
  before insert on public.data_subject_requests
  for each row execute function private.data_subject_requests_before_insert();


-- ---------------------------------------------------------------------------
-- 9. THE TRANSITION TABLE, IN THE DATABASE
-- ---------------------------------------------------------------------------
-- CLAUDE.md's own warning about events.status is why this exists: eight
-- status values with "no transition rules, no state machine and no derived
-- behaviour" are labels on a column. A statutory deadline is not a label, so
-- this one is a real machine, and it lives at the chokepoint every writer
-- passes rather than in a server action.

create or replace function private.dsr_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_from, p_to) in (
    ('open',        'in_progress'),
    ('open',        'routed'),
    ('open',        'fulfilled'),
    ('open',        'rejected'),
    ('open',        'withdrawn'),
    ('in_progress', 'routed'),
    ('in_progress', 'fulfilled'),
    ('in_progress', 'rejected'),
    ('in_progress', 'withdrawn'),
    ('routed',      'fulfilled'),
    ('routed',      'rejected'),
    ('routed',      'withdrawn')
  );
$$;

comment on function private.dsr_transition_allowed(text, text) is
  'THE transition table for public.data_subject_requests.status. open -> in_progress | routed | fulfilled | rejected | withdrawn; in_progress -> routed | fulfilled | rejected | withdrawn; routed -> fulfilled | rejected | withdrawn. fulfilled, rejected and withdrawn are TERMINAL -- a closed request is answered by filing a new one, so the record of what was answered and when is never rewritten. A no-op (from = to) is not a transition and is refused too. Mirrored by lib/dsr/contract.ts and asserted equal to it by tests/integration/legal/catalogue-bindings-match-db.test.ts.';

revoke all on function private.dsr_transition_allowed(text, text) from public, anon, authenticated, service_role;


create or replace function private.data_subject_requests_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_is_owner   boolean := v_uid is not null and old.user_id = v_uid;
  v_operator   boolean := (select private.has_platform_permission('oversee_data_subject_requests'));
  v_required   text;
  v_seam_moved boolean;
begin
  -- (0) THE SEAM. fulfilment_* is writable only from a path where row
  -- security is not active -- `postgres` or `service_role`, which is where
  -- Task 4's export job and Task 5's erasure job will run. No client session
  -- can ever declare that a job ran.
  v_seam_moved :=
       new.fulfilment_kind        is distinct from old.fulfilment_kind
    or new.fulfilment_reference   is distinct from old.fulfilment_reference
    or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at;
  if v_seam_moved and pg_catalog.row_security_active('public.data_subject_requests'::pg_catalog.regclass) then
    raise exception 'data_subject_requests: the fulfilment record is written by the server-side job, not by a client'
      using errcode = '42501';
  end if;

  -- (1) WHAT NEVER MOVES. The request itself is evidence: who asked, which
  -- right, in what words, when, and by when it is due.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.user_id is distinct from old.user_id
     or new.user_email is distinct from old.user_email
     or new.right_type is distinct from old.right_type
     or new.subject_scope is distinct from old.subject_scope
     or new.detail is distinct from old.detail
     or new.requested_at is distinct from old.requested_at then
    raise exception 'data_subject_requests: the request itself is immutable -- only its state and its outcome may change'
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    -- A seam-only write (the job recording its outcome) changes no state.
    if v_seam_moved then
      return new;
    end if;
    raise exception 'data_subject_requests: % is not a transition', old.status
      using errcode = '22023', hint = 'not_a_transition';
  end if;

  -- (2) MAY THIS STATUS FOLLOW THAT ONE.
  if not private.dsr_transition_allowed(old.status, new.status) then
    raise exception 'data_subject_requests: a request cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_transition';
  end if;

  -- (3) WHO. Withdrawal is the requester's and only the requester's; every
  -- other transition is the operator's and only the operator's. One check,
  -- not two guards, so neither can ever be given the other's power by
  -- accident.
  if new.status = 'withdrawn' then
    if not v_is_owner then
      raise exception 'data_subject_requests: only the person who made a request may withdraw it'
        using errcode = '42501';
    end if;
  elsif not v_operator then
    raise exception 'data_subject_requests: only the platform operator may progress a request'
      using errcode = '42501';
  end if;

  -- (4) THE STAMPS ARE THE DATABASE'S, so a closed request's timestamp says
  -- when it was closed rather than what a caller claimed.
  new.fulfilled_at := case when new.status = 'fulfilled' then pg_catalog.now() end;
  new.rejected_at  := case when new.status = 'rejected'  then pg_catalog.now() end;
  new.withdrawn_at := case when new.status = 'withdrawn' then pg_catalog.now() end;

  if new.status <> 'rejected' then
    new.rejection_reason := null;
  elsif new.rejection_reason is null or pg_catalog.btrim(new.rejection_reason) = '' then
    raise exception 'data_subject_requests: a refusal must say why -- the requester is shown this'
      using errcode = '22023', hint = 'rejection_needs_reason';
  else
    new.rejection_reason := pg_catalog.btrim(new.rejection_reason);
  end if;

  -- (5) ROUTING (Q132). Only a processor-scope request can be routed, only to
  -- a workspace that exists, and the routing stamp is the database's.
  if new.status = 'routed' then
    if old.subject_scope <> 'workspace_records' then
      raise exception 'data_subject_requests: only a request about a workspace''s own records can be routed to that workspace'
        using errcode = '22023', hint = 'not_a_processor_request';
    end if;
    if new.routed_to_organisation_id is null then
      raise exception 'data_subject_requests: routing must name the workspace it goes to'
        using errcode = '22023', hint = 'routing_needs_workspace';
    end if;
    new.routed_at := pg_catalog.now();
  else
    -- Routing already recorded stays recorded: a request that was routed and
    -- is later closed keeps the evidence that it was routed, and to whom.
    new.routed_at := old.routed_at;
    new.routed_to_organisation_id := old.routed_to_organisation_id;
  end if;

  -- (6) THE SEAM'S CONSTRAINT -- dormant until the jobs exist (section 7).
  if new.status = 'fulfilled' and old.subject_scope = 'account' then
    select r.fulfilment_kind into v_required
      from private.dsr_rights() r where r.right_type = old.right_type;
    if v_required is not null
       and private.dsr_fulfilment_jobs_ready()
       and (new.fulfilment_kind is distinct from v_required
            or new.fulfilment_recorded_at is null) then
      raise exception 'data_subject_requests: a % request cannot be marked fulfilled until the % has actually run',
        old.right_type, v_required
        using errcode = '22023', hint = 'fulfilment_not_recorded';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.data_subject_requests_before_update() is
  'BEFORE UPDATE on public.data_subject_requests, for EVERY writer -- the transition table, the who-may-do-it check and the stamper in one chokepoint. Refuses: any change to the request itself (id, seq, user, email, right, scope, detail, requested_at -- 42501); a client write of the fulfilment seam (42501); a status that does not follow (22023 illegal_transition) and a non-transition (not_a_transition); a withdrawal by anyone but the requester, and any other transition by anyone but the aal2 platform superuser (42501); a rejection with no reason (22023 rejection_needs_reason); routing a request that is not workspace-scope (not_a_processor_request) or that names no workspace (routing_needs_workspace). Stamps fulfilled_at / rejected_at / withdrawn_at / routed_at from the database clock. And carries the Task 4/5 constraint (22023 fulfilment_not_recorded), dormant while private.dsr_fulfilment_jobs_ready() is false.';

revoke all on function private.data_subject_requests_before_update() from public, anon, authenticated, service_role;

create trigger data_subject_requests_before_update
  before update on public.data_subject_requests
  for each row execute function private.data_subject_requests_before_update();


-- ---------------------------------------------------------------------------
-- 10. NOTHING IS DELETED, AND NOTHING IS TRUNCATED
-- ---------------------------------------------------------------------------

create or replace function private.data_subject_requests_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Depth 1 is a DELETE statement from any role; depth >= 2 is a foreign
  -- key's own cascade -- the auth account being deleted (the consent ledger's
  -- rule, 20260923000000 / 20260923002000).
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception 'data_subject_requests: a request is the evidence that it was answered -- it goes only with the account it belongs to'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function private.data_subject_requests_delete_guard() is
  'BEFORE DELETE on public.data_subject_requests, for EVERY role including postgres: refuses every delete except one run by a foreign key''s cascade (the auth account being deleted). A request and its outcome are what prove a statutory deadline was met; whether erasure should keep them, anonymised, is Q157 for Task 5 (the sibling of Q148 for consents).';

revoke all on function private.data_subject_requests_delete_guard() from public, anon, authenticated, service_role;

create trigger data_subject_requests_delete_guard
  before delete on public.data_subject_requests
  for each row execute function private.data_subject_requests_delete_guard();

create or replace function private.data_subject_requests_truncate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'data_subject_requests: the request register cannot be truncated'
    using errcode = '42501';
end;
$$;

comment on function private.data_subject_requests_truncate_guard() is
  'BEFORE TRUNCATE (statement level) on public.data_subject_requests and public.data_subject_request_notes, for every role: refuses. Row triggers do not fire for TRUNCATE -- the gap 20260922003000 closed for legal_documents and 20260923000000 for consents.';

revoke all on function private.data_subject_requests_truncate_guard() from public, anon, authenticated, service_role;

create trigger data_subject_requests_truncate_guard
  before truncate on public.data_subject_requests
  for each statement execute function private.data_subject_requests_truncate_guard();

create trigger data_subject_request_notes_truncate_guard
  before truncate on public.data_subject_request_notes
  for each statement execute function private.data_subject_requests_truncate_guard();

create or replace function private.data_subject_request_notes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'data_subject_request_notes: a note is append-only -- add another'
      using errcode = '42501';
  end if;
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception 'data_subject_request_notes: a note goes only with the request it belongs to'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function private.data_subject_request_notes_guard() is
  'BEFORE UPDATE OR DELETE on public.data_subject_request_notes, for every role: refuses every update, and every delete except a foreign key''s cascade (the request going, and so the account).';

revoke all on function private.data_subject_request_notes_guard() from public, anon, authenticated, service_role;

create trigger data_subject_request_notes_guard
  before update or delete on public.data_subject_request_notes
  for each row execute function private.data_subject_request_notes_guard();


-- ---------------------------------------------------------------------------
-- 11. AUDIT -- IDENTIFIERS, ENUMS AND TIMESTAMPS ONLY
-- ---------------------------------------------------------------------------
-- NOT `detail`. NOT `rejection_reason`. NOT a note's body. audit_events is
-- read by the platform superuser across every tenant, and a DSR's free text
-- is the most sensitive thing on these two tables.

create or replace function private.audit_dsr_submitted()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.log_audit_event(
    p_action      => 'data_subject_request.submitted',
    p_target_type => 'data_subject_request',
    p_target_id   => new.id,
    p_after       => pg_catalog.jsonb_build_object(
                       'right_type',    new.right_type,
                       'subject_scope', new.subject_scope,
                       'status',        new.status,
                       'requested_at',  new.requested_at,
                       'due_by',        new.due_by,
                       'detail_length', pg_catalog.length(new.detail))
  );
  return null;
end;
$$;

comment on function private.audit_dsr_submitted() is
  'AFTER INSERT on public.data_subject_requests: writes data_subject_request.submitted with the right, the scope, the state, both clock values and the LENGTH of what was written -- never the text. No organisation: a request is account-level even when it is about a workspace''s records, because the workspace is not known until the operator routes it.';

revoke all on function private.audit_dsr_submitted() from public, anon, authenticated, service_role;

create trigger data_subject_requests_audit_submitted
  after insert on public.data_subject_requests
  for each row execute function private.audit_dsr_submitted();


create or replace function private.audit_dsr_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    -- A seam-only write (Task 4/5's job recording its outcome).
    perform private.log_audit_event(
      p_action      => 'data_subject_request.fulfilment_recorded',
      p_target_type => 'data_subject_request',
      p_target_id   => new.id,
      p_after       => pg_catalog.jsonb_build_object(
                         'fulfilment_kind',      new.fulfilment_kind,
                         'fulfilment_reference', new.fulfilment_reference)
    );
    return null;
  end if;

  perform private.log_audit_event(
    p_action          => 'data_subject_request.' || new.status,
    p_target_type     => 'data_subject_request',
    p_organisation_id => new.routed_to_organisation_id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object('status', old.status),
    p_after           => pg_catalog.jsonb_build_object(
                           'status',        new.status,
                           'right_type',    new.right_type,
                           'subject_scope', new.subject_scope,
                           'due_by',        new.due_by,
                           'routed_to_organisation_id', new.routed_to_organisation_id,
                           'reason_length',
                             case when new.rejection_reason is null then null
                                  else pg_catalog.length(new.rejection_reason) end,
                           'on_time',
                             case when new.status in ('fulfilled', 'rejected')
                                  then pg_catalog.now() <= new.due_by end)
  );
  return null;
end;
$$;

comment on function private.audit_dsr_transition() is
  'AFTER UPDATE on public.data_subject_requests: one row per transition, action data_subject_request.<new status>, carrying the old and new state, the right, the scope, the deadline, the workspace a routing named, the LENGTH of any rejection reason and -- for a closing transition -- whether it happened inside the 30 days. NEVER the reason''s text and never the request''s detail (audit_events is superuser-readable across tenants). A seam-only write logs data_subject_request.fulfilment_recorded instead. p_organisation_id is set for a routed request, so the workspace''s own audit filter shows that it was asked.';

revoke all on function private.audit_dsr_transition() from public, anon, authenticated, service_role;

create trigger data_subject_requests_audit_transition
  after update on public.data_subject_requests
  for each row execute function private.audit_dsr_transition();


create or replace function private.audit_dsr_note()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.log_audit_event(
    p_action      => 'data_subject_request.note_added',
    p_target_type => 'data_subject_request',
    p_target_id   => new.request_id,
    p_after       => pg_catalog.jsonb_build_object(
                       'note_id',     new.id,
                       'body_length', pg_catalog.length(new.body))
  );
  return null;
end;
$$;

comment on function private.audit_dsr_note() is
  'AFTER INSERT on public.data_subject_request_notes: records that a note was added to a request, its id and its length. Never its body -- the note exists precisely because it is not for the requester, and audit_events is read cross-tenant.';

revoke all on function private.audit_dsr_note() from public, anon, authenticated, service_role;

create trigger data_subject_request_notes_audit
  after insert on public.data_subject_request_notes
  for each row execute function private.audit_dsr_note();


-- ---------------------------------------------------------------------------
-- 12. THE WRITE PATHS
-- ---------------------------------------------------------------------------
-- Four RPCs, all SECURITY DEFINER and all thin: everything that matters is
-- decided by the two triggers above, which is what makes a direct psql write,
-- a repair script and a server action behave identically.

create or replace function public.submit_data_subject_request(
  p_right_type    text,
  p_subject_scope text,
  p_detail        text
)
returns table (
  request_id   uuid,
  submitted_at timestamptz,
  due_by       timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'submit_data_subject_request: no session' using errcode = '42501';
  end if;
  if p_detail is null or pg_catalog.btrim(p_detail) = '' then
    raise exception 'submit_data_subject_request: say what you are asking for'
      using errcode = '22023', hint = 'detail_required';
  end if;

  insert into public.data_subject_requests as d (right_type, subject_scope, detail, user_id, user_email)
  values (p_right_type, p_subject_scope, pg_catalog.btrim(p_detail),
          -- Placeholders: the BEFORE INSERT trigger stamps both from the
          -- session before the row exists. There is deliberately no user
          -- argument to this function for anyone to supply.
          '00000000-0000-0000-0000-000000000000'::uuid, '')
  returning d.id, d.requested_at, d.due_by
       into request_id, submitted_at, due_by;
  return next;
end;
$$;

comment on function public.submit_data_subject_request(text, text, text) is
  'The ONLY session write path that creates a data subject request. Takes no user argument -- private.data_subject_requests_before_insert() stamps the requester and their email from the session, so the two placeholder values passed here are overwritten before the row exists. Returns the id, the submission time and the database-computed 30-day deadline. Errors: 42501 no session; 22023 with hint detail_required / unknown_right / unknown_scope / no_account_email; PT429 with the remaining seconds in hint (10 per 24 hours).';

revoke all on function public.submit_data_subject_request(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.submit_data_subject_request(text, text, text) to authenticated;


create or replace function public.withdraw_data_subject_request(p_request_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ok  integer;
begin
  if v_uid is null then
    raise exception 'withdraw_data_subject_request: no session' using errcode = '42501';
  end if;
  -- The WHERE clause is a convenience (a clear 22023 rather than the
  -- trigger's 42501 for somebody else's id); the trigger is the enforcement,
  -- and it refuses a withdrawal by anyone but the requester whatever reaches
  -- it.
  update public.data_subject_requests
     set status = 'withdrawn'
   where id = p_request_id
     and user_id = v_uid
     and status in ('open', 'in_progress', 'routed');
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    raise exception 'withdraw_data_subject_request: no open request of yours with that id'
      using errcode = '22023', hint = 'not_withdrawable';
  end if;
  return true;
end;
$$;

comment on function public.withdraw_data_subject_request(uuid) is
  'The requester withdraws their OWN open request (open, in_progress or routed). Never metered -- withdrawing must never be harder than asking. 22023 not_withdrawable when the id is not theirs or the request is already closed; the BEFORE UPDATE trigger refuses a withdrawal by anyone but the requester regardless of how the update is issued.';

revoke all on function public.withdraw_data_subject_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_data_subject_request(uuid) to authenticated;


create or replace function public.transition_data_subject_request(
  p_request_id               uuid,
  p_status                   text,
  p_rejection_reason         text default null,
  p_route_to_organisation_id uuid default null
)
returns table (new_status text, changed_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ok integer;
begin
  if not (select private.has_platform_permission('oversee_data_subject_requests')) then
    raise exception 'transition_data_subject_request: not permitted' using errcode = '42501';
  end if;
  if p_status = 'withdrawn' then
    -- Withdrawal is the requester's act and has its own function. The trigger
    -- would refuse it anyway (the operator is not the requester); refusing it
    -- here names the reason.
    raise exception 'transition_data_subject_request: only the requester can withdraw a request'
      using errcode = '42501';
  end if;

  update public.data_subject_requests d
     set status = p_status,
         rejection_reason = p_rejection_reason,
         routed_to_organisation_id =
           case when p_status = 'routed' then p_route_to_organisation_id
                else d.routed_to_organisation_id end
   where d.id = p_request_id
  returning d.status, pg_catalog.now() into new_status, changed_at;
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    raise exception 'transition_data_subject_request: no request with that id'
      using errcode = '22023', hint = 'unknown_request';
  end if;
  return next;
end;
$$;

comment on function public.transition_data_subject_request(uuid, text, text, uuid) is
  'The operator moves a request through its states. Guarded on has_platform_permission(''oversee_data_subject_requests'') -- allowlisted platform superuser at aal2 -- and again by private.data_subject_requests_before_update(), which is where the transition table, the stamps and the rejection/routing rules live. Withdrawal is refused here by name: it is the requester''s act (public.withdraw_data_subject_request). Errors: 42501 not permitted; 22023 with hint unknown_request / illegal_transition / rejection_needs_reason / not_a_processor_request / routing_needs_workspace / fulfilment_not_recorded.';

revoke all on function public.transition_data_subject_request(uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.transition_data_subject_request(uuid, text, text, uuid) to authenticated;


create or replace function public.add_data_subject_request_note(
  p_request_id uuid,
  p_body       text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  if not (select private.has_platform_permission('oversee_data_subject_requests')) then
    raise exception 'add_data_subject_request_note: not permitted' using errcode = '42501';
  end if;
  if p_body is null or pg_catalog.btrim(p_body) = '' then
    raise exception 'add_data_subject_request_note: an empty note is not a note'
      using errcode = '22023', hint = 'body_required';
  end if;
  if not exists (select 1 from public.data_subject_requests d where d.id = p_request_id) then
    raise exception 'add_data_subject_request_note: no request with that id'
      using errcode = '22023', hint = 'unknown_request';
  end if;
  insert into public.data_subject_request_notes (request_id, author_user_id, body)
  values (p_request_id, v_uid, pg_catalog.btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.add_data_subject_request_note(uuid, text) is
  'The operator adds a working note to a request. Superuser-at-aal2 only, author stamped from the session. The note lands in public.data_subject_request_notes, which the requester holds no read of at all (Q103), and only its length is audited.';

revoke all on function public.add_data_subject_request_note(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.add_data_subject_request_note(uuid, text) to authenticated;
