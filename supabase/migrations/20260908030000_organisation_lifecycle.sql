-- Phase 7 (Superuser dashboard), Task 3: ORGANISATION LIFECYCLE --
-- suspend / reinstate / soft-delete, as a superuser operation with a reason,
-- a retention clock and a way back.
--
-- CLAUDE.md § Superuser dashboard: "Suspend/reinstate and delete are
-- soft-delete only, require step-up re-auth, and notify the org's admin.
-- Deletion follows the standard retention/soft-delete policy -- no immediate
-- hard delete."
--
-- FOUNDER RULING Q88 (2026-09-07), implemented here verbatim: suspension keeps
-- the organisation's NETWORK PRESENCE until the end of the current
-- subscription period, RETAINS DATA for 60 days, and allows REACTIVATION
-- within that window. The network half is 20260908031000, the migration beside
-- this one; the state, the clocks and the reversibility are here.
--
-- ===========================================================================
-- THE DECISION THIS MIGRATION IS ACTUALLY ABOUT: ONE READ-ONLY FLAG, TWO
-- LIFECYCLE STATES -- AND WHY NOT A SEPARATE `suspended_at` COLUMN
-- ===========================================================================
-- The task brief's own suggestion was `suspended_at` for suspend and
-- `deleted_at` for delete. That is the honest NAMING and it is the wrong
-- MECHANISM, for one reason that outweighs the naming:
--
--   `organisations.deleted_at is not null` is, today, the single predicate the
--   entire permission system reads to mean "this workspace is read-only".
--
-- It is read in public.has_permission() and private.permitted_organisations()
-- (the catalogue join, `o.deleted_at is null or perm.survives_suspension`,
-- 20260828210000), in private.organisation_is_live() (the second gate on the
-- four Foundation write policies, 20260828220000), in
-- private.crm_write_organisations() (the second gate on the 25 CRM write
-- policies), in private.custom_field_limit(),
-- private.finance_module_organisations(),
-- private.network_publish_organisations(), in public.accept_invite(), and in
-- organisations_update_manage_organisation's own USING clause. Thirty-odd
-- gates, one column.
--
-- A NEW `suspended_at` column that ALSO has to mean read-only would have to be
-- taught to every one of them, in the same change, or a suspended organisation
-- would keep writing. And every gate added by a later phase would have to
-- remember BOTH columns -- with the failure mode being silent (a wound-down
-- workspace still writing), which is the exact failure mode
-- public.permissions.survives_suspension's `DEFAULT FALSE` was designed to
-- make impossible.
--
-- So `deleted_at` stays what it already is: THE read-only flag, set for every
-- non-active lifecycle state. What this migration adds is the DISCRIMINATOR
-- the product was missing -- WHICH kind of wound-down state a workspace is in,
-- when it started, why, and when the door closes:
--
--   lifecycle_state       'active' | 'suspended' | 'deleted'
--   lifecycle_changed_at  when the current non-active state began
--   lifecycle_reason      the operator's reason, mandatory for a transition
--   retention_expires_at  lifecycle_changed_at + private.organisation_retention_days()
--
-- and one invariant, enforced twice, that makes the arrangement safe:
--
--   lifecycle_state = 'active'  <=>  deleted_at is null
--
-- A trigger NORMALISES it (so a path that predates this migration -- an Owner
-- soft-deleting their own workspace through
-- organisations_update_manage_organisation's deliberately un-gated WITH CHECK,
-- or a DBA -- lands in a coherent state rather than an error), and a CHECK
-- constraint ASSERTS it (so the trigger being dropped is loud). The
-- consequence that matters: a future lifecycle state CANNOT be added without
-- setting deleted_at, and therefore cannot be added without being read-only.
-- The blast radius of a new state is zero gates instead of thirty.
--
-- What is lost by not having a literal `suspended_at`: `deleted_at` is set for
-- a merely-suspended workspace, so the column name reads as a lie. It was
-- already reading as one -- 20260828210000 is titled "READ-ONLY SUSPENSION"
-- and sets nothing but `deleted_at`, components/org/suspended-banner.tsx reads
-- `deleted_at` and says "suspended", and CLAUDE.md's own § Superuser dashboard
-- has been describing `deleted_at` as suspension since Phase 2. This migration
-- does not introduce that; it is the first one to write down what the column
-- actually means, in a comment that travels in the database.
--
-- ===========================================================================
-- P7 AND P11a/P11b ARE UNTOUCHED
-- ===========================================================================
-- FOLLOW-UPS.md § "Phase 7 -- superuser dashboard", "Ship the superuser
-- REINSTATE path in the same change as the suspend button" is explicit about
-- the shape, and it is followed exactly: a NEW PERMISSIVE POLICY for the
-- superuser (permissive policies OR together). This migration does NOT relax
-- organisations_update_manage_organisation, and does NOT open
-- `manage_organisation` in public.permissions -- either would hand
-- self-service un-suspension to every Owner, which is DECISIONS-QUEUE
-- consequence P7 and the thing the whole control exists to prevent.
-- rls_phase2_crm.sql P7/P7a/P7b and P11a-P11f go on passing unchanged;
-- rls_phase7_lifecycle.sql § LP attacks the new policy from the Owner, the
-- foreign Admin and a non-superuser at aal2, and § LR proves it opens for the
-- superuser and only inside a sanctioned transition.
--
-- ===========================================================================
-- WHY THE THREE RPCs ARE SECURITY *INVOKER*
-- ===========================================================================
-- Every other privileged RPC in this schema is SECURITY DEFINER with its guard
-- as its first statement. These three are not, deliberately: a DEFINER
-- function owned by postgres bypasses RLS, which would make the new permissive
-- policy this task was asked to add DEAD CODE -- present, asserted by a
-- structural test, and never once evaluated on a real transition. A policy
-- nothing exercises is a policy nobody notices breaking.
--
-- So the UPDATE runs as the caller and the policy IS the enforcement. The two
-- things an invoker cannot do -- write an audit row (private.log_audit_event
-- is granted to no client role) and count rows in a tenant it cannot read --
-- are done by private.log_organisation_lifecycle_event(), a DEFINER helper
-- that carries the same superuser guard and is granted to `authenticated`.
-- That is the "thin public entry point, private writer" shape 20260908010000
-- and 20260902031000 already use.
--
-- ===========================================================================
-- THE SANCTIONED-PATH MARKER, AND WHY THE POLICY IS NOT JUST
-- has_platform_permission()
-- ===========================================================================
-- A plain `using (has_platform_permission(...))` policy would also permit a
-- direct `PATCH /rest/v1/organisations?id=eq.<x>` from the superuser's own
-- browser -- an un-audited, un-reasoned lifecycle change, which contradicts
-- this task's own constraint ("every lifecycle transition audited with
-- reason") and CLAUDE.md's "Superuser access audits itself".
--
-- So the policy carries a second term: private.lifecycle_transition_in_progress(),
-- which reads a GUC that only private.begin_lifecycle_transition() sets.
-- `private` is not exposed to PostgREST (supabase/config.toml), so no client
-- can reach the setter at all; each RPC closes the marker again as its last
-- statement (private.end_lifecycle_transition() -- read that function's header
-- before assuming a SET clause would have done it for you); and an is_local
-- GUC cannot outlive the transaction in any case.
-- The net effect: the ONLY way to move the column is through one of the three
-- RPCs below, each of which mints a correlation id, writes the audit row and
-- carries a mandatory reason.
--
-- It is NOT a security boundary against a hostile superuser (nothing in this
-- schema is -- they are on public.platform_admins). It is what makes "audited
-- with reason" structurally true rather than conventionally true.
--
-- ===========================================================================
-- MIGRATION DISCIPLINE
-- ===========================================================================
-- Additive only. No previously applied migration is edited (DECISIONS-QUEUE
-- § Q9: `supabase db push` skips a version the remote already records).
-- `create or replace function` throughout; `alter policy` for the one policy
-- that changes; `create or replace policy` DOES NOT EXIST in Postgres (42601).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE RETENTION CONSTANT, in one place
--
-- Founder ruling Q88: 60 days. Modelled on private.past_due_grace_days()
-- (20260828150000) -- a function rather than a literal, so the number appears
-- once in the schema and the TypeScript copy can be BOUND to it by a test
-- instead of hoped at (tests/integration/rls/lifecycle-matches-db.test.ts, the
-- fourth instance of the pattern past-due-grace-matches-db.test.ts names).
--
-- CLAUDE.md § Legal: the exact per-record-type retention periods still need
-- sign-off from UK legal counsel. This is the founder's working number for the
-- ORGANISATION-level window and changing it is a one-line migration.
-- ---------------------------------------------------------------------------
create or replace function private.organisation_retention_days()
returns integer
language sql
immutable
set search_path = ''
as $$ select 60 $$;

comment on function private.organisation_retention_days() is
  'The organisation wind-down retention window in days. FOUNDER RULING Q88 (2026-09-07): a suspended or deleted organisation retains its data for 60 days and may be reactivated within that window. Lives in a function rather than as a literal for the same reason private.past_due_grace_days() does -- the number exists in TypeScript too (ORGANISATION_RETENTION_DAYS, lib/admin/lifecycle-contract.ts) and a constant in two languages with nothing binding them is how this gets broken in six months; tests/integration/rls/lifecycle-matches-db.test.ts is the binding. IMMUTABLE so it can appear in a generated expression or an index predicate later. NOT legal advice: CLAUDE.md § Legal and regulatory compliance still owes a counsel review of every retention period.';

revoke all on function private.organisation_retention_days() from public, anon, authenticated, service_role;
grant execute on function private.organisation_retention_days() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE STATE COLUMNS
--
-- All four are nullable-or-defaulted so this migration cannot fail on an
-- existing row, and the backfill in § 3 puts the existing soft-deleted
-- organisations into a coherent state before § 5 adds the CHECK.
-- ---------------------------------------------------------------------------
alter table public.organisations
  add column lifecycle_state      text not null default 'active',
  add column lifecycle_changed_at timestamptz,
  add column lifecycle_reason     text,
  add column retention_expires_at timestamptz;

alter table public.organisations
  add constraint organisations_lifecycle_state_known
  check (lifecycle_state in ('active', 'suspended', 'deleted'));

comment on column public.organisations.lifecycle_state is
  'WHICH kind of wound-down state this workspace is in: ''active'', ''suspended'' or ''deleted''. THE READ-ONLY FLAG IS STILL deleted_at, NOT THIS COLUMN -- every permission gate in the schema reads deleted_at (public.has_permission''s catalogue join, private.organisation_is_live(), private.crm_write_organisations(), private.custom_field_limit(), private.finance_module_organisations(), private.network_publish_organisations(), public.accept_invite()), and 20260908030000''s header explains at length why teaching all of them a second column would be the more dangerous design. This column is the DISCRIMINATOR beside it, and the invariant `lifecycle_state = ''active'' <=> deleted_at is null` is enforced twice: normalised by private.organisation_lifecycle_sync() (so a path that predates this migration lands coherent) and asserted by organisations_lifecycle_matches_deleted_at (so dropping the trigger is loud). CONSEQUENCE, WHICH IS THE POINT: a lifecycle state added by a later phase cannot exist without deleted_at set, and therefore cannot exist without being read-only.';

comment on column public.organisations.lifecycle_changed_at is
  'When the CURRENT non-active lifecycle state began; null iff lifecycle_state = ''active''. Re-stamped when one non-active state becomes another (suspended -> deleted), which restarts the retention clock -- the customer-favourable direction, and CLAUDE.md''s "never silently delete data" resolves the ambiguity that way. Not the same as deleted_at, which the trigger keeps in step but which an Owner''s own self-suspension may have set first.';

comment on column public.organisations.lifecycle_reason is
  'The operator''s reason for the current lifecycle state, mandatory on every transition (the three RPCs raise 22023 for an empty one) and copied into the audit record. Null iff lifecycle_state = ''active'' -- reinstating clears it, because the reason for a state that has ended is history and lives in public.audit_events, which is append-only; leaving a stale suspension reason on a live workspace would put it in front of the customer''s own admins on the next suspension banner.';

comment on column public.organisations.retention_expires_at is
  'The end of the 60-day wind-down window (FOUNDER RULING Q88): lifecycle_changed_at + private.organisation_retention_days(). Null iff lifecycle_state = ''active''. WHAT IT DOES TODAY: it is the outer bound on network presence (private.organisation_network_presence_active(), 20260908031000) and the deadline the customer''s own suspended-workspace banner counts down to. WHAT IT DOES NOT DO: delete anything. The hard purge is Phase 8+ machinery and does not exist; past this timestamp the workspace is wound down and invisible to the network, and its rows are still all there.';


-- ---------------------------------------------------------------------------
-- 3. BACKFILL -- every organisation that is ALREADY soft-deleted is SUSPENDED
--
-- Reading them as 'suspended' rather than 'deleted' is the conservative
-- direction in both senses: it is what they actually are (every soft-delete
-- the product can currently produce is an Owner self-suspension or a test
-- fixture -- there has never been a delete path), and 'suspended' is the state
-- with the weaker consequences, so a wrong guess here under-punishes.
--
-- lifecycle_changed_at is taken from deleted_at, so the retention clock is
-- measured from when the workspace actually went read-only rather than from
-- the moment this migration ran.
-- ---------------------------------------------------------------------------
update public.organisations
set lifecycle_state      = 'suspended',
    lifecycle_changed_at = deleted_at,
    lifecycle_reason     = 'Backfilled by 20260908030000: this workspace was already soft-deleted before the organisation-lifecycle states existed. No operator reason was recorded at the time.',
    retention_expires_at = deleted_at
                           + pg_catalog.make_interval(days => private.organisation_retention_days())
where deleted_at is not null;


-- ---------------------------------------------------------------------------
-- 4. THE INVARIANT, HALF ONE: the trigger that NORMALISES
--
-- BEFORE INSERT OR UPDATE, so it sees the row on its way in and can fix it
-- rather than reject it. That matters for exactly one existing path:
-- organisations_update_manage_organisation's WITH CHECK is deliberately NOT
-- gated on deleted_at (20260828220000 § 2: "suspending is a door you can walk
-- through, un-suspending is not"), so an aal2 Owner can still soft-delete
-- their own workspace with a bare PATCH that knows nothing about lifecycle
-- columns. Under a CHECK alone that PATCH would start failing with 23514 --
-- a behaviour change this task has no mandate to make. The trigger turns it
-- into a well-formed suspension instead.
--
-- It normalises in BOTH directions, and the clearing direction is what makes
-- reinstatement safe: whoever clears deleted_at -- the RPC below, or a DBA at
-- 3am -- gets the lifecycle columns cleared with it, so no live workspace can
-- carry a stale retention deadline or a stale suspension reason.
--
-- NOT SECURITY DEFINER: it reads no table and writes no row but the one being
-- modified, so it needs no privilege of its own.
-- ---------------------------------------------------------------------------
create or replace function private.organisation_lifecycle_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is null then
    -- LIVE. Every lifecycle column is cleared, whatever the writer supplied:
    -- an active workspace with a retention deadline on it is a contradiction
    -- the rest of the product would have to keep re-deriving its way out of.
    new.lifecycle_state      := 'active';
    new.lifecycle_changed_at := null;
    new.lifecycle_reason     := null;
    new.retention_expires_at := null;
    return new;
  end if;

  -- WOUND DOWN. A writer that named a state keeps it (the three RPCs do); a
  -- writer that did not -- the Owner's bare self-suspension PATCH, a DBA --
  -- gets 'suspended', the weaker of the two states.
  if new.lifecycle_state is null or new.lifecycle_state = 'active' then
    new.lifecycle_state := 'suspended';
  end if;

  -- The clock is stamped when the state ARRIVES or CHANGES, and left alone
  -- otherwise -- so an ordinary UPDATE of an unrelated column (a rename by a
  -- superuser, updated_at ticking) does not silently extend a retention
  -- window that is already running.
  if tg_op = 'INSERT'
     or old.deleted_at is null
     or old.lifecycle_state is distinct from new.lifecycle_state
  then
    new.lifecycle_changed_at := pg_catalog.now();
  else
    new.lifecycle_changed_at := coalesce(
      new.lifecycle_changed_at, old.lifecycle_changed_at, pg_catalog.now());
  end if;

  new.retention_expires_at := new.lifecycle_changed_at
    + pg_catalog.make_interval(days => private.organisation_retention_days());

  return new;
end;
$$;

comment on function private.organisation_lifecycle_sync() is
  'Keeps public.organisations.lifecycle_state / lifecycle_changed_at / retention_expires_at in step with deleted_at, which remains THE read-only flag every permission gate in the schema reads. NORMALISES RATHER THAN REJECTS, for one specific path: organisations_update_manage_organisation''s WITH CHECK is deliberately not gated on deleted_at (20260828220000), so an aal2 Owner can still soft-delete their own workspace with a bare PATCH that names no lifecycle column -- under a CHECK alone that would newly fail with 23514, and this trigger turns it into a well-formed suspension instead. Clearing deleted_at clears every lifecycle column, which is what stops a reinstated workspace carrying a stale retention deadline. The clock is re-stamped only when the state arrives or changes, so an unrelated UPDATE cannot silently extend a running retention window. The CHECK constraint organisations_lifecycle_matches_deleted_at asserts the invariant this function maintains, so dropping this trigger is loud rather than silent.';

drop trigger if exists organisation_lifecycle_sync on public.organisations;
create trigger organisation_lifecycle_sync
  before insert or update on public.organisations
  for each row execute function private.organisation_lifecycle_sync();


-- ---------------------------------------------------------------------------
-- 5. THE INVARIANT, HALF TWO: the CHECK that ASSERTS
--
-- Added AFTER the backfill and AFTER the trigger, so it validates a table that
-- is already coherent. It is the half that survives the trigger being dropped
-- by a later migration that did not read this file.
-- ---------------------------------------------------------------------------
alter table public.organisations
  add constraint organisations_lifecycle_matches_deleted_at
  check (
    (lifecycle_state = 'active') = (deleted_at is null)
    and (lifecycle_state = 'active') = (lifecycle_changed_at is null)
    and (lifecycle_state = 'active') = (retention_expires_at is null)
  );

comment on constraint organisations_lifecycle_matches_deleted_at on public.organisations is
  'THE INVARIANT THE WHOLE LIFECYCLE DESIGN RESTS ON: lifecycle_state = ''active'' if and only if deleted_at is null (and the two clock columns are null exactly when it is). deleted_at is the single predicate every permission gate in the schema reads to mean "read-only" -- the catalogue join in public.has_permission(), private.organisation_is_live(), private.crm_write_organisations(), private.custom_field_limit(), private.finance_module_organisations(), private.network_publish_organisations(), public.accept_invite() -- so this constraint is what guarantees a NEW lifecycle state cannot be added without being read-only, without any of those thirty-odd gates being edited. private.organisation_lifecycle_sync() normalises rows into compliance; this is the assertion beside it, so dropping that trigger fails loudly here instead of quietly admitting an active-but-deleted row.';


-- ---------------------------------------------------------------------------
-- 6. THE CORRELATION MECHANISM
--
-- FOLLOW-UPS.md § "Phase 7 -- superuser dashboard", last entry: "Either thread
-- one correlation id through the deletion path or suppress row-level audit
-- inside the bulk operation and write a single summary row... it is the path
-- superuser organisation deletion and GDPR erasure both take, and erasure
-- carries a 30-day statutory clock."
--
-- THIS IS THE THREADING ANSWER, and it is deliberately the general one rather
-- than something the lifecycle RPCs do for themselves:
--
--   private.log_audit_event() already coalesces a null p_correlation_id to a
--   FRESH uuid per call. That single line is why a cascade would produce N
--   unrelated threads. It now coalesces through a transaction-local GUC first,
--   so any operation that declares itself with begin_lifecycle_transition()
--   gets every audit row written anywhere in that transaction -- by an RPC, by
--   a trigger, by a trigger somebody adds in 2027 -- on ONE thread, with no
--   call site changed and nothing to remember.
--
-- The trailing gen_random_uuid() is untouched, so an audit write outside a
-- declared operation behaves exactly as it did.
--
-- WHY NOT SUPPRESSION. The other option in that entry -- write nothing
-- per-child and one summary row -- discards evidence to save space, in the
-- table whose whole purpose is evidence, and it is unrecoverable: a summary
-- saying "1,412 rows" cannot answer "was contact X among them". Threading
-- keeps both, and the summary row (§ 8) is written ANYWAY, so the reader who
-- wants one number gets one number and the reader who wants the detail can
-- still have it. THE VOLUME ANSWER FOR A REAL HARD PURGE IS THEREFORE
-- THREADING + SUMMARY, AND THAT IS THE PATTERN PHASE 8's PURGE AND THE DSR
-- ERASURE MUST REUSE: call begin_lifecycle_transition() once, do the work,
-- write one summary row naming the counts. If a purge is ever large enough
-- that per-row rows are genuinely intolerable, the place to add suppression is
-- this function -- one more branch on the same GUC -- not thirty call sites.
-- ---------------------------------------------------------------------------
create or replace function private.bulk_audit_correlation_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare v_raw text;
begin
  -- NULLIF and COALESCE are SQL CONSTRUCTS, not functions, so they cannot be
  -- schema-qualified -- `pg_catalog.nullif(...)` is a "function does not
  -- exist" error, not a safer spelling of the same thing. Both are immune to
  -- search_path in any case, which is why the unqualified form is correct here
  -- and everywhere else in this file.
  v_raw := nullif(
    pg_catalog.current_setting('app.lifecycle_correlation_id', true), '');
  if v_raw is null then
    return null;
  end if;
  return v_raw::uuid;
exception when invalid_text_representation then
  -- A malformed value must never take down an audit write. There is no path
  -- by which a client can set this GUC (it is not in PostgREST's request.*
  -- namespace and `private` is not an exposed schema), so reaching this means
  -- our own code wrote a non-uuid, and the safe answer is "no thread" rather
  -- than "no audit row".
  --
  -- NARROW ON PURPOSE. The first cut caught `when others`, and it swallowed a
  -- real bug for an hour: the pg_catalog.nullif above raised 42883, this
  -- handler turned it into "no transition in progress", and the new UPDATE
  -- policy silently refused every transition. A blanket handler in a predicate
  -- that gates a policy converts coding errors into quiet denials.
  return null;
end;
$$;

comment on function private.bulk_audit_correlation_id() is
  'The correlation id of the multi-row operation currently in progress, or null. Reads the TRANSACTION-LOCAL GUC app.lifecycle_correlation_id, which only private.begin_lifecycle_transition() sets. private.log_audit_event() consults it before minting a fresh id, which is what puts every audit row written anywhere in one declared operation -- by an RPC, by a trigger, by a trigger added later -- on a single thread with no call site changed. Returns null on a malformed value rather than raising: an audit write must never fail because of this.';

revoke all on function private.bulk_audit_correlation_id() from public, anon, authenticated, service_role;

-- ===========================================================================
-- THE MARKER IS OPENED AND CLOSED EXPLICITLY, BECAUSE NOTHING ELSE CLOSES IT
-- ===========================================================================
-- MEASURED, NOT ASSUMED, AND THE FIRST GUESS WAS WRONG. The first cut relied
-- on a function's `SET search_path` clause to scope the marker to one RPC
-- call, on the theory that a SET clause gives the function its own GUC nest
-- level and unwinds every change made inside it. It does not: a SET clause
-- saves and restores ONLY THE VARIABLES IT NAMES, so a
-- `set_config(..., is_local => true)` performed anywhere inside stands until
-- the end of the TRANSACTION, whatever SET clauses the call stack carries.
-- Probed directly against this database before this comment was written.
--
-- The consequence, had it been left: after the superuser called any lifecycle
-- RPC, every later statement IN THE SAME TRANSACTION would still satisfy
-- organisations_update_platform_lifecycle -- so a raw, un-audited UPDATE would
-- go through, which is the exact hole this marker exists to close. (Over
-- PostgREST each request is its own transaction, so the leak was invisible
-- from the application and visible immediately from psql. It was.)
--
-- So the door is closed by hand: private.end_lifecycle_transition(), called by
-- each RPC as its last statement. The transaction boundary is the backstop --
-- an is_local setting cannot survive a commit or an abort, so a transition
-- that raises leaves no marker behind either.
-- ---------------------------------------------------------------------------
create or replace function private.begin_lifecycle_transition(p_correlation_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'begin_lifecycle_transition: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;
  if p_correlation_id is null then
    raise exception 'begin_lifecycle_transition: a correlation id is required'
      using errcode = '22023';
  end if;
  perform pg_catalog.set_config(
    'app.lifecycle_correlation_id', p_correlation_id::text, true);
end;
$$;

comment on function private.begin_lifecycle_transition(uuid) is
  'OPENS one organisation-lifecycle operation, under one correlation id. Two effects: private.log_audit_event() threads every row it writes onto that id, and private.lifecycle_transition_in_progress() starts returning true, which is the second term of organisations_update_platform_lifecycle. THAT SECOND EFFECT IS WHY IT LIVES IN `private`: it is the marker that distinguishes "the superuser called suspend_organisation()" from "the superuser sent a raw PATCH to /rest/v1/organisations", and only the first carries a reason and an audit row. `private` is not exposed to PostgREST, so no client can reach it at all. MUST BE PAIRED WITH private.end_lifecycle_transition(): a set_config(is_local) stands until the end of the TRANSACTION regardless of any SET clause on the call stack (measured -- a SET clause restores only the variables it names), so without the explicit close the door would stay open for every later statement in the same transaction.';

revoke all on function private.begin_lifecycle_transition(uuid) from public, anon, service_role;
grant execute on function private.begin_lifecycle_transition(uuid) to authenticated;

create or replace function private.end_lifecycle_transition()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.lifecycle_correlation_id', '', true);
end;
$$;

comment on function private.end_lifecycle_transition() is
  'CLOSES the operation private.begin_lifecycle_transition() opened, by clearing the marker GUC. Called as the last statement of each of the three lifecycle RPCs. It is not optional and it is not tidiness: an is_local GUC stands to the end of the TRANSACTION whatever SET clauses the call stack carries, so without this the superuser''s next statement in the same transaction -- a raw UPDATE of public.organisations, say -- would still satisfy organisations_update_platform_lifecycle. Needs no guard of its own: clearing the marker only ever removes capability.';

revoke all on function private.end_lifecycle_transition() from public, anon, service_role;
grant execute on function private.end_lifecycle_transition() to authenticated;

-- SECURITY DEFINER because it calls private.bulk_audit_correlation_id(), which
-- is granted to no client role -- and it must be callable by `authenticated`,
-- because organisations_update_platform_lifecycle names it and a policy is
-- evaluated as the caller.
create or replace function private.lifecycle_transition_in_progress()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select private.bulk_audit_correlation_id() is not null $$;

comment on function private.lifecycle_transition_in_progress() is
  'True iff private.begin_lifecycle_transition() has been called in this transaction. The second term of organisations_update_platform_lifecycle: it is what stops the superuser''s new UPDATE policy from also permitting a raw, un-audited, un-reasoned PATCH of public.organisations from a browser. Not a security boundary against a hostile superuser -- nothing in this schema is, they are on public.platform_admins -- it is what makes "every lifecycle transition is audited with a reason" structurally true rather than conventionally true.';

revoke all on function private.lifecycle_transition_in_progress() from public, anon, authenticated, service_role;
grant execute on function private.lifecycle_transition_in_progress() to authenticated;

-- The one-line change that does the threading. Everything else about this
-- function -- the forced actor, the two validations, the grants -- is byte for
-- byte 20260826154304's.
create or replace function private.log_audit_event(
  p_action          text,
  p_target_type     text,
  p_organisation_id uuid  default null,
  p_target_id       uuid  default null,
  p_correlation_id  uuid  default null,
  p_before          jsonb default null,
  p_after           jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_actor is null then
    raise exception 'log_audit_event: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if p_action is null or pg_catalog.btrim(p_action) = '' then
    raise exception 'log_audit_event: action is required' using errcode = '22023';
  end if;

  if p_target_type is null or pg_catalog.btrim(p_target_type) = '' then
    raise exception 'log_audit_event: target_type is required' using errcode = '22023';
  end if;

  insert into public.audit_events (
    organisation_id, actor_user_id, action, target_type,
    target_id, correlation_id, before, after
  )
  values (
    p_organisation_id,
    v_actor,
    p_action,
    p_target_type,
    p_target_id,
    -- THE THREE-STEP COALESCE (Phase 7 Task 3). An explicit id from the caller
    -- wins (the impersonation RPCs pass the session id); otherwise the
    -- declared bulk operation's thread, if one is running; otherwise, exactly
    -- as before, a fresh id per row.
    coalesce(
      p_correlation_id,
      private.bulk_audit_correlation_id(),
      pg_catalog.gen_random_uuid()),
    p_before,
    p_after
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb) is
  'Sole write path into public.audit_events (which has no INSERT policy). actor_user_id is forced to auth.uid() and cannot be supplied by the caller. EXECUTE is intentionally granted to no client role -- callers are other SECURITY DEFINER functions. SINCE PHASE 7 TASK 3 (20260908030000) the correlation id resolves in three steps rather than two: an explicit p_correlation_id wins, then the transaction-local thread private.begin_lifecycle_transition() declares, then -- unchanged -- a fresh uuid per call. That middle step is FOLLOW-UPS.md''s answer to "the organisation-delete cascade emits one audit row per child with its own correlation_id": an operation declares itself once and every row written anywhere inside it, by any trigger, joins one thread with no call site edited. Phase 8''s hard purge and the DSR erasure reuse this rather than inventing their own.';

revoke all on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. THE TWO SUPERUSER POLICIES ON public.organisations
--
-- SELECT FIRST, AND IT IS NOT OPTIONAL. 20260826154304's own comment on
-- organisation_subscriptions_select_platform_billing spells out the trap:
-- "Postgres applies SELECT policies to an UPDATE's row-matching as well.
-- Without it, the superuser write policies are half-working in a dangerous way
-- -- a targeted UPDATE ... WHERE id = <an org the superuser is not a member
-- of> silently matches 0 rows". The superuser is a member of nothing
-- (rls_phase7_impersonation.sql § IF2 asserts it), so without the SELECT
-- policy every reinstate would report success and change nothing.
--
-- WHAT THE SELECT POLICY DISCLOSES, weighed rather than assumed: the
-- organisations table holds id, name, slug, timestamps and the lifecycle
-- columns. No tenant record content of any kind. CLAUDE.md § Superuser
-- dashboard permits exactly this ("only aggregate metadata (seat count,
-- storage used, record counts)") and forbids record content, which this row
-- does not contain. It is also strictly narrower than what the operator can
-- already reach: organisation_subscriptions_select_platform_billing has given
-- the superuser every organisation's plan, seat count and billing status since
-- Foundation, keyed on organisation_id.
-- ---------------------------------------------------------------------------
create policy organisations_select_platform_lifecycle
  on public.organisations for select to authenticated
  using ( (select private.has_platform_permission('manage_organisation_lifecycle')) );

comment on policy organisations_select_platform_lifecycle on public.organisations is
  'PERMITS: the platform superuser, at aal2, to read every organisation row -- id, name, slug, timestamps and the lifecycle columns. DOES NOT PERMIT: any tenant record content, which is not in this table (CLAUDE.md § Superuser dashboard: metadata yes, record content only through an accepted impersonation session). IT IS ALSO A PREREQUISITE FOR THE WRITE, not a convenience: Postgres applies SELECT policies to an UPDATE''s row-matching, and the superuser is a member of no organisation, so without this every reinstate would match zero rows and report success -- the exact "fails when aimed, succeeds when unaimed" failure organisation_subscriptions_select_platform_billing was added to avoid. Third permissive SELECT policy on this table, OR-ed with organisations_select_member and organisations_select_impersonation_counterparty.';

-- ---------------------------------------------------------------------------
-- THE UPDATE POLICY -- the REINSTATE path FOLLOW-UPS.md asked for.
--
-- NEW AND PERMISSIVE. Permissive policies OR together, so the unconditional
-- `deleted_at is null` that 20260828220000 added to
-- organisations_update_manage_organisation is untouched and still closes the
-- Owner's path -- P7, P11a and P11b go on passing exactly as written. Nothing
-- here relaxes that policy and nothing here opens `manage_organisation` in
-- public.permissions; either would hand self-service un-suspension to every
-- Owner, which is the one outcome the whole control exists to prevent.
--
-- USING has no deleted_at term AT ALL, which is the entire point: this is the
-- only policy in the schema that can match a soft-deleted organisation row for
-- an UPDATE, and therefore the only way `deleted_at` can ever be cleared.
--
-- WITH CHECK carries the same two terms so a lifecycle transition cannot be
-- used to smuggle in a rename of some other organisation mid-transaction.
-- ---------------------------------------------------------------------------
create policy organisations_update_platform_lifecycle
  on public.organisations for update to authenticated
  using (
    (select private.has_platform_permission('manage_organisation_lifecycle'))
    and (select private.lifecycle_transition_in_progress())
  )
  with check (
    (select private.has_platform_permission('manage_organisation_lifecycle'))
    and (select private.lifecycle_transition_in_progress())
  );

comment on policy organisations_update_platform_lifecycle on public.organisations is
  'THE SUPERUSER REINSTATE/SUSPEND/DELETE PATH, and the only policy in the schema whose USING clause can match a SOFT-DELETED organisation row -- so the only way deleted_at can ever be cleared. FOLLOW-UPS.md § "Phase 7 -- superuser dashboard" specified exactly this shape: a NEW permissive policy (permissive policies OR together), NOT a relaxation of organisations_update_manage_organisation and NOT opening manage_organisation in public.permissions, either of which would hand self-service un-suspension to every Owner (DECISIONS-QUEUE consequence P7). rls_phase2_crm.sql P7/P7a/P7b and P11a-P11f are unaffected and still pass. TWO TERMS, BOTH REQUIRED: has_platform_permission (aal2 + on public.platform_admins) says WHO; private.lifecycle_transition_in_progress() says THROUGH WHAT -- it is true only inside a transaction that called private.begin_lifecycle_transition(), which only public.suspend_organisation / delete_organisation / reinstate_organisation do, so a raw PATCH from the superuser''s own browser matches nothing and every transition that reaches the column carries a reason and an audit row.';


-- ---------------------------------------------------------------------------
-- 8. THE AUDIT WRITER + SUMMARY -- the DEFINER half of the invoker RPCs
--
-- It does the two things a SECURITY INVOKER function cannot: call
-- private.log_audit_event() (granted to no client role) and COUNT rows in a
-- tenant the superuser cannot read.
--
-- THE COUNTS ARE THE SUMMARY ROW. FOLLOW-UPS.md wanted "a single summary row"
-- instead of per-child audit spam; this is it, and it is the shape a hard
-- purge should copy -- what the transition touched, as numbers, with the
-- clocks it started. Numbers only: no name, no email, no record id. That
-- keeps the row inside CLAUDE.md § Superuser dashboard's "aggregate metadata,
-- never record content", and it keeps public.audit_events free of tenant
-- content the way rls_phase7_impersonation.sql § IA already asserts for the
-- impersonation rows.
-- ---------------------------------------------------------------------------
create or replace function private.log_organisation_lifecycle_event(
  p_organisation_id uuid,
  p_action          text,
  p_correlation_id  uuid,
  p_before          jsonb,
  p_reason          text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     record;
  v_members bigint;
  v_profiles bigint;
  v_period_end timestamptz;
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'log_organisation_lifecycle_event: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_action not in ('organisation.suspended',
                      'organisation.deleted',
                      'organisation.reinstated') then
    raise exception 'log_organisation_lifecycle_event: unknown lifecycle action %', p_action
      using errcode = '22023';
  end if;

  select o.lifecycle_state, o.lifecycle_changed_at, o.retention_expires_at
    into v_org
  from public.organisations o
  where o.id = p_organisation_id;

  select pg_catalog.count(*) into v_members
  from public.organisation_memberships m
  where m.organisation_id = p_organisation_id and m.status = 'active';

  select pg_catalog.count(*) into v_profiles
  from public.network_profiles np
  where np.organisation_id = p_organisation_id
    and np.status = 'published'
    and np.deleted_at is null;

  select s.current_period_end into v_period_end
  from public.organisation_subscriptions s
  where s.organisation_id = p_organisation_id;

  return private.log_audit_event(
    p_action          => p_action,
    p_target_type     => 'organisation',
    p_organisation_id => p_organisation_id,
    p_target_id       => p_organisation_id,
    p_correlation_id  => p_correlation_id,
    p_before          => p_before,
    p_after           => pg_catalog.jsonb_build_object(
      'lifecycle_state',       v_org.lifecycle_state,
      'lifecycle_changed_at',  v_org.lifecycle_changed_at,
      'retention_expires_at',  v_org.retention_expires_at,
      'reason',                p_reason,
      -- THE SUMMARY. Counts, never rows.
      'active_members',        v_members,
      'published_profiles',    v_profiles,
      'network_presence_until', v_period_end)
  );
end;
$$;

comment on function private.log_organisation_lifecycle_event(uuid, text, uuid, jsonb, text) is
  'Writes THE ONE SUMMARY AUDIT ROW for an organisation lifecycle transition, and is the SECURITY DEFINER half of the three SECURITY INVOKER RPCs -- it does the two things they cannot: reach private.log_audit_event() (granted to no client role) and count rows in a tenant the superuser has no read of. THE `after` PAYLOAD IS THE SUMMARY FOLLOW-UPS.md ASKED FOR: the new state, both clocks, the operator''s reason, and COUNTS of what the transition touched (active members, published profiles) plus the subscription period end that governs network presence. Counts only -- no name, no email, no record id -- so the row stays inside CLAUDE.md § Superuser dashboard''s "aggregate metadata, never record content". Guarded on has_platform_permission and restricted to three known actions, which is what makes granting EXECUTE to `authenticated` safe: an ordinary user calling it gets 42501 and mints nothing.';

revoke all on function private.log_organisation_lifecycle_event(uuid, text, uuid, jsonb, text) from public, anon, service_role;
grant execute on function private.log_organisation_lifecycle_event(uuid, text, uuid, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. THE THREE RPCs
--
-- SECURITY INVOKER (see the header). Each one:
--   1. validates the reason -- mandatory, CLAUDE.md § Superuser dashboard
--      ("a mandatory reason field (goes into the audit record)");
--   2. resolves the SLUG, not an id, for the same reason
--      public.request_impersonation() does: the operator has no directory of
--      uuids and resolving one by hand is how support suspends the wrong
--      tenant;
--   3. declares the transaction (mints the correlation id, opens the policy);
--   4. UPDATEs -- through organisations_update_platform_lifecycle, which is
--      the enforcement;
--   5. audits the transition with a summary.
--
-- Step 4 checks the row count and raises if it moved nothing, so a refusal is
-- a refusal rather than a 204 that changed nothing -- the exact failure mode
-- lib/auth/index.ts's own header documents at length for suspended CRM writes.
-- ---------------------------------------------------------------------------
create or replace function private.lifecycle_target(p_slug text, p_reason text)
returns table (id uuid, lifecycle_state text, deleted_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'organisation lifecycle: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'organisation lifecycle: a reason is required'
      using errcode = '22023';
  end if;

  -- Reads through organisations_select_platform_lifecycle (this function is
  -- SECURITY INVOKER, so the caller's own policies apply) -- the same policy
  -- the UPDATE's row-matching will use, so "found here, refused there" cannot
  -- happen.
  return query
    select o.id, o.lifecycle_state, o.deleted_at
    from public.organisations o
    where o.slug = pg_catalog.btrim(pg_catalog.lower(p_slug));

  -- FOUND after RETURN QUERY is true iff it returned at least one row.
  if not found then
    raise exception 'organisation lifecycle: no organisation with that slug'
      using errcode = '22023';
  end if;
end;
$$;

comment on function private.lifecycle_target(text, text) is
  'The three lifecycle RPCs'' shared preamble: superuser guard, mandatory reason, slug -> row. SECURITY INVOKER and STABLE, so the lookup runs under the caller''s own organisations_select_platform_lifecycle policy -- the same policy the UPDATE beside it will use for row-matching, which is what stops "resolved here, matched nothing there". Takes the SLUG rather than an id for public.request_impersonation()''s reason: the operator has no directory of uuids, and hand-resolving one is how support suspends the wrong tenant. A nonexistent slug is a distinguishable 22023, deliberately and for the same reason it is there: this caller is the platform operator, and a typo that produced a silent no-op would be worse.';

revoke all on function private.lifecycle_target(text, text) from public, anon, authenticated, service_role;
grant execute on function private.lifecycle_target(text, text) to authenticated;


create or replace function public.suspend_organisation(
  p_organisation_slug text,
  p_reason            text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  if v_target.lifecycle_state = 'suspended' then
    raise exception 'suspend_organisation: that workspace is already suspended'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'suspended',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'suspend_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.suspended', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$$;

comment on function public.suspend_organisation(text, text) is
  'Suspends one workspace: it becomes READ-ONLY (deleted_at is set, so every write gate in the schema closes and only view_crm survives -- founder decision Q6), its 60-day retention clock starts, and it keeps its network presence until the end of its current subscription period (FOUNDER RULING Q88; enforced in private.organisation_network_presence_active(), 20260908031000). Superuser only, at aal2, with a MANDATORY REASON that goes into the audit record; the application adds step-up re-authentication on top (lib/admin/lifecycle.ts). SECURITY INVOKER on purpose: the UPDATE goes through organisations_update_platform_lifecycle, so that policy is the enforcement rather than dead code beside a definer that bypasses it. RAISES rather than returning quietly when the update matches nothing (42501), so a refusal is never a success that changed no rows. Reversible with public.reinstate_organisation() for as long as the workspace exists -- nothing is destroyed here or ever by this function.';

revoke all on function public.suspend_organisation(text, text) from public, anon, service_role;
grant execute on function public.suspend_organisation(text, text) to authenticated;


create or replace function public.delete_organisation(
  p_organisation_slug text,
  p_reason            text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  if v_target.lifecycle_state = 'deleted' then
    raise exception 'delete_organisation: that workspace is already deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  -- SOFT ONLY. There is no DELETE anywhere in this function and there must
  -- never be one: CLAUDE.md § Superuser dashboard, "soft-delete only... no
  -- immediate hard delete", and § Non-negotiable rules, "never silently delete
  -- data". The retention clock re-stamps here (private.organisation_lifecycle_
  -- sync sees the state change), which EXTENDS a suspended workspace's window
  -- rather than shortening it -- the customer-favourable reading of an
  -- ambiguity Q88 does not resolve. Queued as DECISIONS-QUEUE Q102.
  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'deleted',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'delete_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.deleted', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$$;

comment on function public.delete_organisation(text, text) is
  'Deletes one workspace -- SOFT-DELETE ONLY, and there is no hard-delete path anywhere in this product (CLAUDE.md § Superuser dashboard: "no immediate hard delete"). It sets deleted_at (read-only, exactly as suspension does -- the permission engine reads that one column), moves lifecycle_state to ''deleted'', re-stamps the 60-day retention clock, and REMOVES NETWORK PRESENCE AT ONCE rather than at period end (DECISIONS-QUEUE Q101: Q88''s "keep presence until the paid period ends" is a ruling about SUSPENSION, and a workspace the operator has deleted is not a workspace waiting out a billing period). Fully reversible with public.reinstate_organisation() -- the state is the whole of the deletion, and every row is still there. Superuser only, at aal2, mandatory reason, one summary audit row. The hard purge past the retention deadline is Phase 8+ machinery and does not exist yet.';

revoke all on function public.delete_organisation(text, text) from public, anon, service_role;
grant execute on function public.delete_organisation(text, text) to authenticated;


create or replace function public.reinstate_organisation(
  p_organisation_slug text,
  p_reason            text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  if v_target.lifecycle_state = 'active' then
    raise exception 'reinstate_organisation: that workspace is not suspended or deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'lifecycle_state', v_target.lifecycle_state,
    'deleted_at',      v_target.deleted_at);

  perform private.begin_lifecycle_transition(v_corr);

  -- Clearing deleted_at is the whole reinstatement: every gate in the schema
  -- reads that column, so the workspace becomes writable again the instant
  -- this commits. private.organisation_lifecycle_sync() clears the three
  -- lifecycle columns with it, so no live workspace carries a stale retention
  -- deadline or a stale suspension reason.
  --
  -- NOTE THE ABSENCE OF ANY WINDOW CHECK. Reinstatement is deliberately
  -- possible past retention_expires_at too: the 60 days is when the workspace
  -- stops being VISIBLE and becomes eligible for a future purge, not a
  -- deadline after which the operator is locked out of their own undo. A
  -- one-way door with a clock on it is the failure mode this whole task
  -- exists to avoid.
  update public.organisations
  set deleted_at = null
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'reinstate_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.reinstated', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$$;

comment on function public.reinstate_organisation(text, text) is
  'THE WAY BACK -- the path FOLLOW-UPS.md § "Phase 7 -- superuser dashboard" insisted must ship in the same change as the suspend button, because shipping suspend without it is a one-way door. Clears deleted_at (which is the whole of it: every permission gate in the schema reads that column, so the workspace is writable again on commit) and private.organisation_lifecycle_sync() clears the lifecycle columns with it, so nothing live carries a stale retention deadline. Works from ''suspended'' AND from ''deleted'', and DELIBERATELY HAS NO WINDOW CHECK: reinstating past retention_expires_at is still allowed, because that timestamp is when a workspace stops being visible and becomes eligible for a future purge, not a deadline that locks the operator out of their own undo. Superuser only, at aal2, mandatory reason, one summary audit row, and the UPDATE runs through organisations_update_platform_lifecycle -- the new permissive policy, which is the ONLY policy in the schema whose USING clause matches a soft-deleted organisation row. An Owner still cannot do this (consequence P7): public.permissions.manage_organisation is unchanged at survives_suspension = false and organisations_update_manage_organisation still carries its own unconditional deleted_at gate.';

revoke all on function public.reinstate_organisation(text, text) from public, anon, service_role;
grant execute on function public.reinstate_organisation(text, text) to authenticated;
