-- ===========================================================================
-- PHASE 8 TASK 3, FIX ROUND 1 -- THE REGISTER'S INTEGRITY.
--
-- Closes review findings I1, I4, I5 and the database half of I7/Q160 on
-- public.data_subject_requests (20260924000000). One migration because they
-- are one function: private.data_subject_requests_before_update() is the
-- chokepoint every one of them lives in, and it is rebuilt here ONCE, from its
-- LATEST definition (20260924000000 § 9 -- no later migration replaced it).
--
-- ===========================================================================
-- I1 -- THE FULFILMENT-SEAM GUARD WAS DEAD CODE
-- ===========================================================================
-- It read `row_security_active('public.data_subject_requests')`. The trigger
-- function is SECURITY DEFINER owned by postgres, and row_security_active()
-- answers for the CURRENT user -- inside a definer function that is the
-- owner, a superuser -- so it was false for every caller and the branch could
-- never raise. (private.audit_incident_alert_resolution(), 20260909080000,
-- says exactly this about itself: "row_security_active() is the WRONG test
-- here because this function is SECURITY DEFINER".) The only thing between a
-- client and the seam was the absent UPDATE grant, and the assertion that was
-- meant to prove the guard (DF9) was answered by that missing grant.
--
-- THE REPLACEMENT DECIDES ON THE SESSION, which SECURITY DEFINER does not
-- change. A seam write is refused when EITHER signal of a client session is
-- present:
--
--   * `auth.uid()` is not null -- a person's JWT claims are on the session.
--     PostgREST sets them for every client request, and they are still there
--     inside any definer function that request calls;
--   * the session's `role` setting is `authenticated` or `anon`. SET ROLE is
--     what PostgREST does with the JWT's role claim, and -- measured -- a
--     SECURITY DEFINER function switches the current USER but leaves the
--     `role` SETTING alone, so `current_setting('role')` inside this trigger
--     is still the caller's. A client role cannot SET ROLE to anything else.
--
-- What remains is a session with no person on it: `postgres` (pg_cron, a
-- migration, a DBA) or `service_role` calling a definer function from a
-- server route. That is where Task 4's export job runs (pg_cron + pg_net + a
-- secret-authenticated server route, the Phase 7 digest's pattern) and where
-- Task 5's erasure must record its outcome from.
--
-- WHY NOT THE OTHER HOUSE PATTERNS. `session_user` is `authenticator` for
-- every PostgREST request, service_role's included, so it cannot tell the
-- job from a client. A SECURITY INVOKER trigger with row_security_active()
-- (private.incident_alert_resolution_guard's shape) answers "is the STATEMENT
-- issued by a role that bypasses RLS", which a client reaches through any
-- definer RPC that one day forwards a seam column. A transaction-local marker
-- set by "the job's function" is a custom setting, and a custom setting is
-- writable by anyone who can run SQL. The session is the one thing a client
-- cannot change about itself.
--
-- The refusal carries its OWN hint (`fulfilment_seam_is_server_only`) so the
-- suite can tell this guard from a missing grant: both are 42501, and Phase 7
-- shipped a false green of exactly that shape.
--
-- ALSO FOUND WHILE FIXING IT, and worse than the dead guard: the seam could
-- not be written by the path it was designed for AT ALL. The AFTER UPDATE
-- audit trigger called private.log_audit_event() for a seam-only write, and
-- log_audit_event refuses a sessionless caller (28000 --
-- audit_events.actor_user_id is NOT NULL and there is no system actor). So the
-- only caller who COULD write the seam was one with a person's session --
-- precisely the caller the guard exists to refuse. Measured on 144
-- migrations: a sessionless postgres seam write ->
-- `ERROR: log_audit_event: no authenticated user`. Section 6 fixes the audit
-- trigger.
--
-- ===========================================================================
-- I5 -- ONE DORMANT PREDICATE GUARDED TWO JOBS
-- ===========================================================================
-- private.dsr_fulfilment_jobs_ready() was a single boolean for both `export`
-- and `erasure`: the day Task 4 flipped it, every account ERASURE request
-- would have become impossible to close as fulfilled until Task 5 shipped.
-- It is replaced by private.dsr_fulfilment_job_ready(p_kind), one line per
-- job, and the old function is DROPPED rather than left behind -- a function
-- whose comment says "re-issue me" and which nothing reads is a trap for the
-- task that has to find the right one.
--
-- The seam-only write also used to `return new` before every later rule, so
-- as postgres the reviewer wrote routed_at + an organisation onto an `open`
-- row and moved a closed row's fulfilled_at back ten years. A seam-only write
-- now moves ONLY the seam (anything else: 42501
-- seam_write_moves_only_the_seam), only on a request that is still open
-- (22023 request_is_closed), only for an account-scope request whose right
-- names that job (22023 fulfilment_kind_mismatch), and
-- `fulfilment_recorded_at` is the database's clock like every other stamp on
-- this row. A CLOSED ROW IS IMMUTABLE, stamps included, for every role.
--
-- THE ERASURE HALF UNDER Q158 (changed in this round from "cascade" to "keep
-- the register row, anonymised"). The order is: the erasure job runs from a
-- server-side session, anonymises the requester's register rows, records the
-- seam (`erasure`) on the still-open erasure request, and the operator then
-- marks it fulfilled -- a row that survives the account, so there IS a row to
-- mark. Nothing here assumes the row goes with the account: the user_id
-- foreign key stops cascading (section 2) and 20260925001000 closes the
-- delete guard. What Task 5 must re-issue is listed in that migration's
-- header.
--
-- ===========================================================================
-- I4 -- `ON DELETE SET NULL` THAT COULD NEVER EXECUTE
-- ===========================================================================
-- routed_to_organisation_id ... ON DELETE SET NULL is an UPDATE of one column
-- with the status unchanged, which the trigger refused as `not_a_transition`,
-- and which the routing_pair CHECK would have refused if it had not. So Task
-- 6's organisation purge (Q88) would have been blocked by any workspace that
-- was ever routed a request. Now: the trigger admits exactly that update --
-- only that column, only to null, only when the organisation it named NO
-- LONGER EXISTS (the consent ledger's rule, 20260923002000: prove the parent
-- is gone rather than trust pg_trigger_depth) -- and the CHECK is replaced by
-- one that lets `routed_at` outlive the organisation. The evidence that the
-- request WAS routed survives the purge: `routed_at`, and
-- `routed_to_organisation_name`, a snapshot taken at routing time.
--
-- ===========================================================================
-- I7 / Q160 -- THE DATABASE HALF
-- ===========================================================================
--   * `routed_to_organisation_name`: what the requester is shown (they hold no
--     read of public.organisations for a workspace they do not belong to, and
--     they are owed knowing who holds their data) and what survives a purge.
--   * A WRONG WORKSPACE IS CORRECTABLE: the operator may re-route a `routed`
--     request to a different workspace. It is not a status transition (the
--     transition table still has no X -> X pair), it is audited as
--     data_subject_request.rerouted with both workspaces, and it re-stamps
--     routed_at.
--   * A ROUTING RECORDS ITS HANDOVER. Nothing in this product tells the
--     workspace (Q45: no notification subsystem), so `routed` means "the
--     operator says they wrote to the workspace's Owner". A DEFERRED
--     constraint trigger refuses, at commit, a routing or re-routing with no
--     operator note written in the same transaction -- for every writer, not
--     only the RPC -- and public.route_data_subject_request() writes both
--     atomically.
--
-- ADDITIVE in the house sense (no committed migration is edited), with three
-- deliberate removals, each replaced in this file: the dead predicate, the
-- routing_pair CHECK, and the four-argument transition RPC (its fourth
-- argument was the workspace; routing has its own function now).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE NAME SNAPSHOT, AND THE CHECKS THAT LET ROUTING EVIDENCE OUTLIVE THE
--    WORKSPACE
-- ---------------------------------------------------------------------------

alter table public.data_subject_requests
  add column routed_to_organisation_name text;

comment on column public.data_subject_requests.routed_to_organisation_name is
  'The routed workspace''s NAME, snapshotted by the transition trigger at routing time (Phase 8 Task 3 fix round 1, I4/I7/Q160). Two readers: the REQUESTER, who holds no read of public.organisations for a workspace they do not belong to and is owed knowing which business was asked; and the register itself after that workspace is purged, when routed_to_organisation_id has been nulled by its foreign key and this and routed_at are the surviving evidence that the request was routed, and to whom. Never supplied by a caller.';

-- Backfill any row routed before this column existed. The BEFORE UPDATE
-- trigger refuses an update that is not a transition, so it is disabled for
-- exactly this statement (the owner's escape hatch 20260924000000's own suite
-- uses for its back-dated fixtures), together with the transition audit -- a
-- backfill is not an event.
alter table public.data_subject_requests disable trigger data_subject_requests_before_update;
alter table public.data_subject_requests disable trigger data_subject_requests_audit_transition;
update public.data_subject_requests d
   set routed_to_organisation_name =
         coalesce((select o.name from public.organisations o where o.id = d.routed_to_organisation_id),
                  '(a workspace that no longer exists)')
 where d.routed_at is not null;
alter table public.data_subject_requests enable trigger data_subject_requests_before_update;
alter table public.data_subject_requests enable trigger data_subject_requests_audit_transition;

alter table public.data_subject_requests
  drop constraint data_subject_requests_routing_pair;

alter table public.data_subject_requests
  add constraint data_subject_requests_routing_names_a_routed_request
    check (routed_to_organisation_id is null or routed_at is not null),
  add constraint data_subject_requests_routing_name_pair
    check ((routed_at is null) = (routed_to_organisation_name is null)),
  add constraint data_subject_requests_routing_name_length
    check (routed_to_organisation_name is null
           or pg_catalog.length(routed_to_organisation_name) between 1 and 500);

comment on constraint data_subject_requests_routing_names_a_routed_request on public.data_subject_requests is
  'A workspace id implies a routing stamp -- but NOT the reverse (fix round 1, I4). 20260924000000 shipped `(routed_at is null) = (routed_to_organisation_id is null)`, which made the column''s own ON DELETE SET NULL unexecutable: nulling the id of a purged workspace left routed_at behind and failed the CHECK. routed_at and routed_to_organisation_name are the evidence that outlives the workspace.';


-- ---------------------------------------------------------------------------
-- 2. THE REGISTER NO LONGER GOES WITH THE ACCOUNT (Q158, as changed)
-- ---------------------------------------------------------------------------
-- ON DELETE CASCADE said "an erased account's requests are deleted with it".
-- Under Q158's new working default the register row is KEPT, anonymised, so
-- the honest declaration is no action at all: deleting an auth account that
-- still owns a register row is refused (23503) until Task 5's erasure has
-- re-pointed those rows at Q130's tombstone -- the same treatment as the
-- other no-ON-DELETE references in phase-8-inventory.md.

alter table public.data_subject_requests
  drop constraint data_subject_requests_user_id_fkey;

alter table public.data_subject_requests
  add constraint data_subject_requests_user_id_fkey
    foreign key (user_id) references auth.users (id);

comment on constraint data_subject_requests_user_id_fkey on public.data_subject_requests is
  'NO ON DELETE ACTION, deliberately (Phase 8 Task 3 fix round 1; Q158 as changed). A request and its outcome are the evidence that a statutory deadline was met, so the row does not go with the account: Task 5''s erasure re-points it at Q130''s tombstone user and clears user_email, detail and rejection_reason BEFORE the auth row is deleted. Until it has, deleting the account is refused (23503) rather than silently taking the register with it. 20260924000000 shipped this as ON DELETE CASCADE.';


-- ---------------------------------------------------------------------------
-- 3. ONE PREDICATE PER JOB (I5a)
-- ---------------------------------------------------------------------------

create or replace function private.dsr_fulfilment_job_ready(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
           when 'export'  then false  -- Phase 8 Task 4 re-issues this function with `true` HERE
           when 'erasure' then false  -- Phase 8 Task 5 re-issues this function with `true` HERE
           else false
         end
$$;

comment on function private.dsr_fulfilment_job_ready(text) is
  'Has the job that fulfils this kind of request shipped? `export` (access, portability) is Phase 8 Task 4; `erasure` is Task 5. BOTH FALSE today. While a kind is false, an account-scope request of a right that names it may be marked fulfilled by hand -- there is no job to have run. When a task re-issues this function with its own line `true`, private.data_subject_requests_before_update() starts refusing (22023, hint fulfilment_not_recorded) such a transition unless the seam (fulfilment_kind / fulfilment_reference / fulfilment_recorded_at) was recorded by a server-side session first. ONE LINE PER JOB so that waking the export constraint does not make every erasure request unfulfillable (review finding I5a: 20260924000000 shipped a single boolean for both). rls_phase8_data_subject_requests.sql § DF flips each line alone inside a rolled-back transaction and asserts the refusal, the OTHER kind''s freedom, and that a recorded seam IS admitted.';

revoke all on function private.dsr_fulfilment_job_ready(text) from public, anon, authenticated, service_role;

drop function private.dsr_fulfilment_jobs_ready();


-- ---------------------------------------------------------------------------
-- 4. BEFORE INSERT, REBUILT FROM ITS LATEST DEFINITION (20260924000000 § 8)
-- ---------------------------------------------------------------------------
-- One added line: a new request has no routing name either. Everything else
-- is the shipped function.

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
  new.routed_to_organisation_id   := null;
  new.routed_to_organisation_name := null;
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
  'BEFORE INSERT on public.data_subject_requests, for EVERY writer: refuses a sessionless write (42501); stamps user_id and user_email from the session (no write path takes either, so attribution is non-forgeable by construction); refuses a right or a scope outside the catalogue (22023 unknown_right / unknown_scope); forces status=open and requested_at=now() so the 30-day generated due_by cannot be back- or forward-dated; nulls every outcome column, the routing name snapshot included (fix round 1, 20260925000000); and meters submissions at 10 per 24 hours per user (PT429, remaining seconds in HINT, crossing alert at the last accepted submission). Withdrawals are metered nowhere.';


-- ---------------------------------------------------------------------------
-- 5. THE CHOKEPOINT, REBUILT FROM ITS LATEST DEFINITION (20260924000000 § 9)
-- ---------------------------------------------------------------------------

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
  -- THE SESSION, NOT THE DEFINER. SECURITY DEFINER switches the current USER
  -- to this function's owner; it does not touch the JWT claims and it does
  -- not touch the `role` SETTING (measured), so both still describe whoever
  -- issued the statement that fired this trigger.
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), '');
  v_client_session boolean;
  v_required   text;
  v_name       text;
  v_seam_moved boolean;
  v_rest_moved boolean;
begin
  v_client_session := v_uid is not null or v_session_role in ('authenticated', 'anon');

  v_seam_moved :=
       new.fulfilment_kind        is distinct from old.fulfilment_kind
    or new.fulfilment_reference   is distinct from old.fulfilment_reference
    or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at;

  -- Every mutable column that is neither the status, the seam nor the routed
  -- workspace's id: what a seam-only write and the foreign key's own nulling
  -- must each leave exactly as it was.
  v_rest_moved :=
       new.fulfilled_at     is distinct from old.fulfilled_at
    or new.rejected_at      is distinct from old.rejected_at
    or new.withdrawn_at     is distinct from old.withdrawn_at
    or new.rejection_reason is distinct from old.rejection_reason
    or new.routed_at        is distinct from old.routed_at
    or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name;

  -- (0) THE SEAM IS NOT A CLIENT'S TO WRITE. fulfilment_* says "a job ran",
  -- and no session with a person on it may say that -- not through a grant
  -- that does not exist today, not through a definer RPC that one day
  -- forwards the column, not as the operator. Its own hint, so a test can
  -- tell this refusal from a missing grant's 42501.
  if v_seam_moved and v_client_session then
    raise exception 'data_subject_requests: the fulfilment record is written by the server-side job, never from a person''s session'
      using errcode = '42501', hint = 'fulfilment_seam_is_server_only';
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
    -- THREE writes change no state, and each is admitted ONLY in its own exact
    -- shape. None of them returns before the row's invariants: that was I5(d).

    -- (1a) THE FOREIGN KEY'S OWN NULLING (I4). ON DELETE SET NULL from
    -- public.organisations is an UPDATE of this one column. Admitted only when
    -- nothing else moves AND the workspace it named no longer exists -- the
    -- consent ledger's rule (20260923002000): prove the parent is gone rather
    -- than trust that "a trigger issued this" means "the cascade issued this".
    if old.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is null
       and not v_seam_moved
       and not v_rest_moved
       and pg_catalog.pg_trigger_depth() >= 2
       and not exists (select 1 from public.organisations o
                        where o.id = old.routed_to_organisation_id) then
      return new;
    end if;

    -- (1b) THE JOB RECORDING ITS OUTCOME. Only the seam, only on a request
    -- that is still open, only the kind that request's right names.
    if v_seam_moved then
      if v_rest_moved
         or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
        raise exception 'data_subject_requests: recording a fulfilment changes the fulfilment record and nothing else'
          using errcode = '42501', hint = 'seam_write_moves_only_the_seam';
      end if;
      if old.status in ('fulfilled', 'rejected', 'withdrawn') then
        raise exception 'data_subject_requests: a closed request is not rewritten, its fulfilment record included'
          using errcode = '22023', hint = 'request_is_closed';
      end if;
      select r.fulfilment_kind into v_required
        from private.dsr_rights() r where r.right_type = old.right_type;
      if old.subject_scope <> 'account'
         or v_required is null
         or new.fulfilment_kind is distinct from v_required
         or new.fulfilment_reference is null then
        raise exception 'data_subject_requests: a % request about % is not fulfilled by %',
          old.right_type, old.subject_scope, coalesce(new.fulfilment_kind, 'nothing')
          using errcode = '22023', hint = 'fulfilment_kind_mismatch';
      end if;
      -- The stamp is the database's, like every other stamp on this row.
      new.fulfilment_recorded_at := pg_catalog.now();
      return new;
    end if;

    -- (1c) A WRONG WORKSPACE IS CORRECTABLE (Q160c). Not a status transition
    -- -- the transition table has no X -> X pair and keeps none -- but the
    -- operator's, audited as its own action, and stamped afresh.
    if old.status = 'routed'
       and new.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
      if not v_operator then
        raise exception 'data_subject_requests: only the platform operator may progress a request'
          using errcode = '42501';
      end if;
      select o.name into v_name from public.organisations o
       where o.id = new.routed_to_organisation_id;
      if not found then
        raise exception 'data_subject_requests: there is no such workspace to route to'
          using errcode = '22023', hint = 'unknown_workspace';
      end if;
      new.fulfilled_at     := old.fulfilled_at;
      new.rejected_at      := old.rejected_at;
      new.withdrawn_at     := old.withdrawn_at;
      new.rejection_reason := old.rejection_reason;
      new.routed_at        := pg_catalog.now();
      new.routed_to_organisation_name := v_name;
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
  -- a workspace that exists, and the routing stamp and the name snapshot are
  -- the database's.
  if new.status = 'routed' then
    if old.subject_scope <> 'workspace_records' then
      raise exception 'data_subject_requests: only a request about a workspace''s own records can be routed to that workspace'
        using errcode = '22023', hint = 'not_a_processor_request';
    end if;
    if new.routed_to_organisation_id is null then
      raise exception 'data_subject_requests: routing must name the workspace it goes to'
        using errcode = '22023', hint = 'routing_needs_workspace';
    end if;
    select o.name into v_name from public.organisations o
     where o.id = new.routed_to_organisation_id;
    if not found then
      raise exception 'data_subject_requests: there is no such workspace to route to'
        using errcode = '22023', hint = 'unknown_workspace';
    end if;
    new.routed_at := pg_catalog.now();
    new.routed_to_organisation_name := v_name;
  else
    -- Routing already recorded stays recorded: a request that was routed and
    -- is later closed keeps the evidence that it was routed, and to whom.
    new.routed_at := old.routed_at;
    new.routed_to_organisation_id   := old.routed_to_organisation_id;
    new.routed_to_organisation_name := old.routed_to_organisation_name;
  end if;

  -- (6) THE SEAM'S CONSTRAINT -- dormant PER JOB until that job exists
  -- (section 3). A transition always comes from a person's session, and (0)
  -- refuses a seam write from one, so new.fulfilment_* here is what a
  -- server-side session recorded earlier, or nothing.
  if new.status = 'fulfilled' and old.subject_scope = 'account' then
    select r.fulfilment_kind into v_required
      from private.dsr_rights() r where r.right_type = old.right_type;
    if v_required is not null
       and private.dsr_fulfilment_job_ready(v_required)
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
  'BEFORE UPDATE on public.data_subject_requests, for EVERY writer -- the transition table, the who-may-do-it check and the stamper in one chokepoint (rebuilt in fix round 1, 20260925000000, from 20260924000000 § 9). Refuses: a write of the fulfilment seam from any session with a PERSON on it -- auth.uid() not null, or the session role setting authenticated/anon, neither of which SECURITY DEFINER changes (42501, hint fulfilment_seam_is_server_only; the shipped guard read row_security_active() inside a definer function and could never fire); any change to the request itself (id, seq, user, email, right, scope, detail, requested_at -- 42501); a status that does not follow (22023 illegal_transition); a withdrawal by anyone but the requester, and any other transition by anyone but the aal2 platform superuser (42501); a rejection with no reason (rejection_needs_reason); routing a request that is not workspace-scope (not_a_processor_request), that names no workspace (routing_needs_workspace) or one that does not exist (unknown_workspace). With the status UNCHANGED it admits exactly three writes and refuses everything else as not_a_transition: the routed-workspace foreign key''s own ON DELETE SET NULL (that column only, the workspace provably gone); a seam-only write (nothing but the seam -- seam_write_moves_only_the_seam; an open request only -- request_is_closed; the kind its right names on an account-scope request -- fulfilment_kind_mismatch; fulfilment_recorded_at stamped here); and the operator re-routing a routed request to a different workspace (Q160). A CLOSED ROW IS IMMUTABLE, stamps included. Stamps fulfilled_at / rejected_at / withdrawn_at / routed_at / routed_to_organisation_name from the database. Carries the Task 4/5 constraint (22023 fulfilment_not_recorded), dormant per job while private.dsr_fulfilment_job_ready(kind) is false.';

comment on column public.data_subject_requests.fulfilment_kind is
  'The Task 4 / Task 5 seam. Written ONLY from a session with no person on it -- postgres, or service_role through a definer function -- together with fulfilment_reference; fulfilment_recorded_at is stamped by the trigger. private.data_subject_requests_before_update() refuses it from any client session (42501 fulfilment_seam_is_server_only), on a closed request, and for a kind the request''s right does not name. See private.dsr_fulfilment_job_ready(text). (Reissued in fix round 1: the 20260924000000 text described a row_security_active() guard that could never fire.)';


-- ---------------------------------------------------------------------------
-- 6. AUDIT, REBUILT FROM ITS LATEST DEFINITION (20260924000000 § 11)
-- ---------------------------------------------------------------------------
-- Three changes:
--   * A SEAM-ONLY WRITE IS NO LONGER SENT TO log_audit_event(). It comes from
--     a session with no person on it (section 5 guarantees that), and
--     log_audit_event refuses an unattributable row (28000) -- which, as
--     shipped, made the seam unwritable by the only caller allowed to write
--     it. There is no system actor in this product
--     (audit_events.actor_user_id is NOT NULL), so the house answer applies
--     -- the one private.audit_incident_alert_resolution() gives for the same
--     situation: no person acted, so no person is named. The record is not
--     lost: the seam is on the row, stamped by the database and immutable
--     once the request closes; the job that wrote it audits its own run (Task
--     4's export job, Task 5's erasure summary row); and the closing
--     transition's audit row now carries the fulfilment kind and reference
--     the operator relied on.
--   * The foreign key's own nulling (section 5, 1a) is likewise not a
--     person's action and writes nothing.
--   * A re-route is its own action, data_subject_request.rerouted, carrying
--     both workspaces.

create or replace function private.audit_dsr_transition()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    if old.status = 'routed'
       and new.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
      perform private.log_audit_event(
        p_action          => 'data_subject_request.rerouted',
        p_target_type     => 'data_subject_request',
        p_organisation_id => new.routed_to_organisation_id,
        p_target_id       => new.id,
        p_before          => pg_catalog.jsonb_build_object(
                               'routed_to_organisation_id', old.routed_to_organisation_id,
                               'routed_at',                 old.routed_at),
        p_after           => pg_catalog.jsonb_build_object(
                               'status',                    new.status,
                               'right_type',                new.right_type,
                               'subject_scope',             new.subject_scope,
                               'due_by',                    new.due_by,
                               'routed_to_organisation_id', new.routed_to_organisation_id,
                               'routed_at',                 new.routed_at)
      );
    end if;
    -- A seam-only write and the foreign key's nulling: no person acted.
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
                                  then pg_catalog.now() <= new.due_by end,
                           'fulfilment_kind',
                             case when new.status = 'fulfilled' then new.fulfilment_kind end,
                           'fulfilment_reference',
                             case when new.status = 'fulfilled' then new.fulfilment_reference end)
  );
  return null;
end;
$$;

comment on function private.audit_dsr_transition() is
  'AFTER UPDATE on public.data_subject_requests: one row per transition, action data_subject_request.<new status>, carrying the old and new state, the right, the scope, the deadline, the workspace a routing named, the LENGTH of any rejection reason, for a closing transition whether it happened inside the 30 days, and for `fulfilled` the fulfilment kind and reference the operator relied on. A re-route (status unchanged, a different workspace) is data_subject_request.rerouted with both workspaces. NEVER the reason''s text, never the request''s detail and never the workspace''s name (audit_events is superuser-readable across tenants). A SEAM-ONLY WRITE AND THE FOREIGN KEY''S NULLING WRITE NOTHING: neither is a person''s action, there is no system actor, and log_audit_event refuses an unattributable row -- as shipped (20260924000000) that refusal made the seam unwritable by the only session allowed to write it. p_organisation_id is set for a routed request, so the workspace''s own audit filter shows that it was asked.';


-- ---------------------------------------------------------------------------
-- 7. A ROUTING RECORDS ITS HANDOVER (Q160a) -- FOR EVERY WRITER
-- ---------------------------------------------------------------------------
-- DEFERRED to commit, because the note is a row in another table written
-- after the routing in the same transaction. A routing, or a re-routing, with
-- no operator note written in that transaction does not commit.

create or replace function private.dsr_routing_needs_handover_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.data_subject_request_notes n
                  where n.request_id = new.id
                    and n.created_at >= new.routed_at) then
    raise exception 'data_subject_requests: passing a request to a workspace must record how the workspace was told -- nothing in this product tells it'
      using errcode = '22023', hint = 'routing_needs_handover_note';
  end if;
  return null;
end;
$$;

comment on function private.dsr_routing_needs_handover_note() is
  'DEFERRED constraint trigger on public.data_subject_requests (fix round 1, I7/Q160a): a routing or re-routing must be accompanied, in the same transaction, by an operator note on that request (created_at >= routed_at; both are the transaction clock). Nothing in this product notifies the routed workspace (Q45), so `routed` means "the operator says they wrote to its Owner" and the note is the record of how. At the chokepoint, for every writer: a direct UPDATE is refused at commit exactly as the RPC would be. 22023, hint routing_needs_handover_note.';

revoke all on function private.dsr_routing_needs_handover_note() from public, anon, authenticated, service_role;

create constraint trigger data_subject_requests_routing_handover_note
  after update on public.data_subject_requests
  deferrable initially deferred
  for each row
  when (new.routed_at is not null and new.routed_at is distinct from old.routed_at)
  execute function private.dsr_routing_needs_handover_note();


-- ---------------------------------------------------------------------------
-- 8. THE WRITE PATHS
-- ---------------------------------------------------------------------------
-- Routing leaves transition_data_subject_request(): it needs a workspace AND
-- a handover note, it is also how a re-route is made, and a fourth and fifth
-- optional argument on a function that mostly ignores them is how a caller
-- ends up routing with neither. The four-argument function is dropped and
-- re-created with three, from its LATEST definition (20260924000000 § 12).

drop function public.transition_data_subject_request(uuid, text, text, uuid);

create or replace function public.transition_data_subject_request(
  p_request_id       uuid,
  p_status           text,
  p_rejection_reason text default null
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
  if p_status = 'routed' then
    raise exception 'transition_data_subject_request: routing has its own function, which records the handover'
      using errcode = '22023', hint = 'use_route_data_subject_request';
  end if;

  update public.data_subject_requests d
     set status = p_status,
         rejection_reason = p_rejection_reason
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

comment on function public.transition_data_subject_request(uuid, text, text) is
  'The operator moves a request to in_progress, fulfilled or rejected. Guarded on has_platform_permission(''oversee_data_subject_requests'') -- allowlisted platform superuser at aal2 -- and again by private.data_subject_requests_before_update(), which is where the transition table, the stamps and the rejection rule live. Refuses by name the two states that are not its to set: `withdrawn` (the requester''s act, public.withdraw_data_subject_request; 42501) and `routed` (public.route_data_subject_request, which records the handover; 22023 use_route_data_subject_request). Errors: 42501 not permitted; 22023 with hint unknown_request / illegal_transition / not_a_transition / rejection_needs_reason / fulfilment_not_recorded. (Fix round 1 replaced the four-argument signature 20260924000000 shipped.)';

revoke all on function public.transition_data_subject_request(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.transition_data_subject_request(uuid, text, text) to authenticated;


create or replace function public.route_data_subject_request(
  p_request_id      uuid,
  p_organisation_id uuid,
  p_handover_note   text
)
returns table (new_status text, changed_at timestamptz, organisation_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ok  integer;
begin
  if not (select private.has_platform_permission('oversee_data_subject_requests')) then
    raise exception 'route_data_subject_request: not permitted' using errcode = '42501';
  end if;
  if p_organisation_id is null then
    raise exception 'route_data_subject_request: routing must name the workspace it goes to'
      using errcode = '22023', hint = 'routing_needs_workspace';
  end if;
  if p_handover_note is null or pg_catalog.btrim(p_handover_note) = '' then
    raise exception 'route_data_subject_request: say how the workspace was told -- nothing in this product tells it'
      using errcode = '22023', hint = 'handover_note_required';
  end if;

  -- One statement for a first routing AND a re-routing: setting status to
  -- `routed` on a routed row leaves the status unchanged, which the trigger
  -- reads as a re-route when the workspace differs and as not_a_transition
  -- when it does not.
  update public.data_subject_requests d
     set status = 'routed',
         routed_to_organisation_id = p_organisation_id
   where d.id = p_request_id
  returning d.status, pg_catalog.now(), d.routed_to_organisation_name
       into new_status, changed_at, organisation_name;
  get diagnostics v_ok = row_count;
  if v_ok = 0 then
    raise exception 'route_data_subject_request: no request with that id'
      using errcode = '22023', hint = 'unknown_request';
  end if;

  insert into public.data_subject_request_notes (request_id, author_user_id, body)
  values (p_request_id, v_uid, pg_catalog.btrim(p_handover_note));

  return next;
end;
$$;

comment on function public.route_data_subject_request(uuid, uuid, text) is
  'The operator records that a workspace_records request was passed to the customer workspace that is its controller (Q132) -- or CORRECTS that record by naming a different workspace for a request already routed (Q160c). NOTHING IS SENT TO ANYBODY: there is no workspace-side inbox and no notification subsystem (Q45), so the handover itself is an email the operator writes by hand, and p_handover_note -- required, written to public.data_subject_request_notes in the same transaction -- is the record of it (Q160a; the deferred constraint trigger refuses a routing without one from any writer). Superuser-at-aal2 only. Returns the workspace NAME the trigger snapshotted. Errors: 42501 not permitted; 22023 with hint routing_needs_workspace / handover_note_required / unknown_request / unknown_workspace / not_a_processor_request / illegal_transition / not_a_transition (the same workspace again). THE DAY ROUTING NOTIFIES A WORKSPACE IN-PRODUCT it becomes a disclosure of a named person''s privacy request to a third party and must go behind step-up (Q160).';

revoke all on function public.route_data_subject_request(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.route_data_subject_request(uuid, uuid, text) to authenticated;
