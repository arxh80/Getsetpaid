-- Foundation phase, Task 6: auth-side provisioning + invite acceptance.
--
-- Depends on 20260826154304_permission_engine_and_rls.sql. That migration
-- deliberately left two holes for this one, and named both in its own
-- comments:
--
--   1. public.profiles has NO client-facing INSERT policy, and its comment
--      says "profile rows are provisioned alongside the auth.users row
--      (Task 6)". Nothing provisions them yet -- both the SQL and the JS RLS
--      suites insert them by hand as the Postgres superuser, standing in for
--      a step that did not exist. Section 1 below builds it.
--
--   2. The organisation_memberships UPDATE policy refuses EVERY transition
--      into status='active', including by the invitee themselves. Its own
--      comment says: "FOLLOW-ON, NOT BUILT HERE (Task 6): something has to
--      make the invited -> active transition when an invitee actually
--      accepts. It cannot be this policy ... and it must not be a loosening
--      of it. It needs its own SECURITY DEFINER function, scoped to the
--      caller's OWN membership row, same pattern as create_organisation."
--      Section 2 below is that function. The Task 4 policy is NOT touched.
--
-- WHY A NEW MIGRATION AND NOT AN EDIT TO TASK 4's FILE
--   Task 4's own review noted that editing an already-applied migration in
--   place was only defensible because nothing was deployed. That window is
--   closed: the migration has been applied, reviewed and tested against, and
--   two test suites assert its exact behaviour. Additive migration from here.
--
-- ===========================================================================
-- Design notes -- read before changing anything in this file
-- ===========================================================================
--
-- (a) BOTH functions here are SECURITY DEFINER, and each is justified the
--     same way Task 4's four were:
--
--       private.handle_new_user  -- runs as an AFTER INSERT trigger on
--         auth.users. The inserting role is GoTrue's, not a client role, and
--         public.profiles has no INSERT policy for anybody. DEFINER is the
--         only way the row gets written. It lives in `private` (not exposed
--         through the Data API) and, being a trigger function, is never
--         callable as an RPC by anyone.
--
--       public.accept_invite     -- being a client-callable endpoint IS its
--         purpose, exactly like create_organisation, so it is the second
--         (and only other) DEFINER function in `public`. It has to bypass
--         RLS because the operation it performs -- invited -> active -- is
--         precisely the one the Task 4 UPDATE policy exists to forbid, and
--         because the invitee holds no permission at all in the inviting
--         organisation (they are not a member of it yet).
--
--     Both set `search_path = ''` and schema-qualify every call, both are
--     revoked from public/anon/service_role, and neither trusts any
--     caller-supplied identity: accept_invite anchors on auth.uid() and
--     handle_new_user on the trigger's own NEW row.
--
-- (b) accept_invite TAKES A MEMBERSHIP ID, NOT AN ORGANISATION ID OR AN EMAIL.
--     The id is not a capability. It is used only to LOCATE a row, and the
--     row is then required to satisfy `user_id = auth.uid()` before anything
--     is written -- so knowing (or guessing) another user's membership id
--     buys nothing. Taking an organisation id instead would have been worse,
--     not better: it would need a lookup by (org, auth.uid()) anyway, and it
--     would silently pick a row when a user somehow had more than one, which
--     the unique constraint makes impossible but the code should not assume.
--
-- (c) "NOT YOURS" AND "DOES NOT EXIST" RAISE THE IDENTICAL ERROR.
--     Deliberate, and it is the same rule DESIGN.md § "Error pages" sets for
--     HTTP: "a record that exists but belongs to another organisation must
--     render the identical 404 as a record that doesn't exist at all ...
--     Returning 403 for 'exists, not yours' and 404 for 'doesn't exist' is an
--     enumeration oracle." Two distinguishable errors here would let a signed
--     -in user probe membership ids for existence. One message, one errcode.
--
--     The one case that DOES get its own message is a row the caller owns but
--     whose status is not 'invited' -- there is nothing to leak (they already
--     had to prove ownership to reach it) and "you have already accepted
--     this" is information the user genuinely needs.
--
-- (d) THE ROW IS LOCKED (`for update`) BEFORE IT IS INSPECTED.
--     Without the lock, two concurrent accepts of the same invite can both
--     read status='invited', both pass the check, and both write -- producing
--     two 'membership.accepted' audit events for one acceptance. The UPDATE
--     re-asserts `status = 'invited'` in its own WHERE as a second line of
--     defence, so even if the lock were removed the second writer would
--     affect zero rows and raise rather than double-log.
--
-- (e) WHAT accept_invite DELIBERATELY DOES NOT DO.
--       - It does not create the membership row. Only an admin holding
--         'manage_members' can do that, through the Task 4 INSERT policy,
--         under RLS. Acceptance and invitation stay separate privileges;
--         folding them together would let this function mint memberships.
--       - It does not touch `role`. The role was set by the inviting admin
--         and is not the invitee's to choose.
--       - It does not resurrect a 'revoked' row. Only 'invited' is
--         acceptable; re-inviting a revoked member is an admin action
--         (revoked -> invited is allowed by the Task 4 UPDATE policy).
--       - It has no invite expiry, because organisation_memberships carries
--         no expiry column. The AUTH-side invite link does expire (GoTrue
--         otp_expiry), which bounds the practical window; a membership-level
--         expiry is a deliberate future schema change, not something to fake
--         off invited_at here.

-- ===========================================================================
-- 1. Profile provisioning
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- handle_new_user()
-- AFTER INSERT trigger on auth.users: creates the matching public.profiles
-- row so that every authenticated user has one from the moment they exist.
--
-- ON raw_user_meta_data -- READ THIS BEFORE ADDING A COLUMN HERE.
--   raw_user_meta_data is CLIENT-WRITABLE. It is whatever the browser passed
--   as `options.data` to signUp(), and the user can change it at any time via
--   auth.updateUser(). It is therefore safe for a DISPLAY NAME and unsafe for
--   anything else. It must never carry a role, an organisation id, an
--   entitlement, or any other value an authorisation decision reads -- that is
--   the documented Supabase footgun (user_metadata is user-editable and
--   surfaces in auth.jwt()). Authorisation in this schema comes from
--   organisation_memberships + role_permissions, and nothing here changes that.
--
--   full_name is trimmed, capped at 200 characters, and NULLed when empty, so
--   an over-long or whitespace-only value cannot land in the table.
--
-- ON CONFLICT DO NOTHING: makes the trigger idempotent and keeps it safe
-- alongside any future backfill or a test fixture that provisions its own
-- profile rows. A profile that already exists is never overwritten from
-- auth metadata.
--
-- BLAST RADIUS -- keep this function boring. It runs inside GoTrue's own
-- INSERT transaction, so ANY error it raises fails the whole user creation:
-- signup, invite and OAuth all return an opaque 500 "Database error creating
-- new user". (Confirmed during this task: an early draft qualified NULLIF as
-- `pg_catalog.nullif`, which does not exist, and every signup broke.) Add
-- nothing here that can raise -- no cross-table lookups, no constraints that
-- depend on other rows, no notifications.
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- nullif/coalesce/case are SQL *constructs*, not functions -- there is no
  -- pg_catalog.nullif to qualify, and they cannot be shadowed via search_path,
  -- so bare is both required and safe. btrim/left ARE ordinary functions and
  -- stay qualified. (Task 4's create_organisation makes the same distinction:
  -- bare `coalesce`, qualified `pg_catalog.btrim`.)
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(
      pg_catalog.btrim(
        pg_catalog.left(new.raw_user_meta_data ->> 'full_name', 200)
      ),
      ''
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function private.handle_new_user() is
  'AFTER INSERT trigger on auth.users: provisions the matching public.profiles row (which has no INSERT policy for any client role). full_name is read from raw_user_meta_data, which is CLIENT-WRITABLE -- display only, never an input to any authorisation decision.';

-- No client role gets EXECUTE. Postgres checks EXECUTE on a trigger function
-- at CREATE TRIGGER time (as the migration's own role), not when the trigger
-- fires, so revoking it does not stop the trigger working -- it only stops
-- anyone calling it directly. Same discipline as private.log_audit_event.
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

-- ===========================================================================
-- 2. Invite acceptance
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- accept_invite(membership_id)
-- The single sanctioned path for invited -> active. Flips the caller's OWN
-- pending membership row to 'active', stamps joined_at, and audits it.
--
-- See design notes (b) through (e) above for why it takes a membership id,
-- why "not yours" and "does not exist" are indistinguishable, why the row is
-- locked, and what it deliberately refuses to do.
--
-- Atomic by construction: a function body runs inside the caller's
-- transaction and nothing below catches an exception, so a failure rolls back
-- the membership update and the audit record together.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invite(p_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_role   text;
  v_status text;
begin
  -- Defence in depth: this function bypasses RLS, so it re-checks the one
  -- thing RLS would otherwise have guaranteed.
  if v_actor is null then
    raise exception 'accept_invite: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if p_membership_id is null then
    raise exception 'accept_invite: membership id is required'
      using errcode = '22023';
  end if;

  -- The ownership check lives in the WHERE clause, not in a later IF: the row
  -- is never even read into a variable unless it belongs to the caller. FOR
  -- UPDATE holds it until commit so a concurrent second accept cannot also
  -- observe status='invited' (design note (d)).
  select m.organisation_id, m.role, m.status
    into v_org, v_role, v_status
    from public.organisation_memberships m
   where m.id = p_membership_id
     and m.user_id = v_actor
   for update;

  -- Same error for "no such row" and "that row is not yours" -- see design
  -- note (c). Do not split these apart.
  if not found then
    raise exception 'accept_invite: no pending invitation found'
      using errcode = '42501';
  end if;

  if v_status <> 'invited' then
    raise exception 'accept_invite: invitation is not pending (status is %)', v_status
      using errcode = '22023';
  end if;

  -- Dead code today ('platform_superuser' is not in the roles catalogue, so
  -- the FK on organisation_memberships.role already rejects it) and kept for
  -- the same reason Task 4 kept its copies: it costs nothing and it holds if
  -- that key is ever re-introduced. See Task 4 design note (c).
  if v_role = 'platform_superuser' then
    raise exception 'accept_invite: platform superuser is not an organisation role'
      using errcode = '42501';
  end if;

  -- Joining a soft-deleted tenant would produce an active membership of an
  -- organisation the user can never see (organisations_select_member does not
  -- filter deleted_at, but every product surface does, and a suspended org
  -- must not gain members).
  if exists (
    select 1
      from public.organisations o
     where o.id = v_org
       and o.deleted_at is not null
  ) then
    raise exception 'accept_invite: organisation is no longer active'
      using errcode = '22023';
  end if;

  update public.organisation_memberships m
     set status     = 'active',
         joined_at  = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where m.id      = p_membership_id
     -- Both predicates are re-asserted rather than trusted from the SELECT
     -- above: the UPDATE must be correct on its own terms, not because an
     -- earlier statement in this function happened to check them.
     and m.user_id = v_actor
     and m.status  = 'invited';

  if not found then
    raise exception 'accept_invite: invitation could not be accepted'
      using errcode = '55000';
  end if;

  perform private.log_audit_event(
    p_action          => 'membership.accepted',
    p_target_type     => 'organisation_membership',
    p_organisation_id => v_org,
    p_target_id       => p_membership_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'invited'),
    p_after           => pg_catalog.jsonb_build_object('status', 'active', 'role', v_role)
  );
end;
$$;

comment on function public.accept_invite(uuid) is
  'Flips the CALLER''S OWN pending organisation_memberships row from ''invited'' to ''active'' and stamps joined_at, then audits it as ''membership.accepted''. The only sanctioned path for that transition -- the client-facing UPDATE policy refuses it for everyone including the invitee. Ownership is enforced as user_id = auth.uid() in the lookup itself; a row that does not exist and a row belonging to someone else raise the identical error.';

revoke all on function public.accept_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.accept_invite(uuid) to authenticated;
