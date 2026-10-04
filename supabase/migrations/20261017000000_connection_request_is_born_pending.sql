-- ===========================================================================
-- A CONNECTION REQUEST IS BORN PENDING, AND ITS SENDER AND CLOCK ARE STAMPED.
-- Phase 8 Task 9b fix round 1, review finding C1 (Critical) and minor m3.
-- ===========================================================================
--
-- THE HOLE, PRE-EXISTING SINCE PHASE 6 AND MEASURED ON THIS STACK BEFORE THE
-- FIX: a sender holding manage_network_connections could INSERT a
-- public.network_connection_requests row whose status was already
-- `accepted`. Nothing refused it:
--
--   * network_connection_requests_insert_manage_connections (20260904003000)
--     had no status term in its WITH CHECK;
--   * the only status guard, private.network_request_status_transition_guard,
--     is BEFORE UPDATE, so it never sees an INSERT;
--   * the two existing BEFORE INSERT triggers (fill_recipient_organisation,
--     meter_connection_request) never read status;
--   * the CHECK network_connection_requests_responded_iff_terminal is
--     satisfied by a forger who also sends responded_at.
--
-- public.network_connected_profiles keys on `status = 'accepted'` alone, so
-- the forged row resolved the TARGET organisation's `connections`-level
-- fields for the sender without the target ever being asked -- the exact
-- thing CLAUDE.md § The private/network split says "never unlocks until both
-- sides accept". Task 9b's notification job made it SILENT as well: the
-- target is emailed only about a `pending` row, so a row born `accepted`
-- skipped the one signal the target would otherwise get.
--
-- The same INSERT also let the client choose requested_by (any colleague)
-- and requested_at (back-dated past the seven-day notification window, so
-- even an honest pending row could be sent without the email) -- minor m3.
--
-- THE FIX, TWO LAYERS, EACH ASSERTED ON ITS OWN (rls_phase6_network.sql § NP):
--
--   (1) THE CHOKEPOINT: a BEFORE INSERT trigger, born_pending, that every
--       non-owner writer passes -- authenticated, service_role, anything
--       added later. It REFUSES (23514) a status other than pending, a
--       non-null responded_at or responded_by, and a requested_by naming
--       anyone but the session's own user; then it STAMPS requested_by from
--       auth.uid() and requested_at from now(). Named so it sorts first
--       among the BEFORE INSERT triggers (b < f < m), so a forged row is
--       refused before the meter spends budget on it.
--   (2) THE POLICY: the INSERT WITH CHECK gains
--       `status = 'pending' and responded_at is null and responded_by is null`,
--       so the RLS layer states the rule too. Behind the trigger it is
--       defence in depth: a BEFORE ROW trigger runs before WITH CHECK
--       (measured in 20260904006000), so with both present the trigger's
--       23514 is what the caller sees, and the policy's 42501 appears only
--       if the trigger is gone.
--
-- WHO IS EXEMPT, AND WHY: `postgres` and `supabase_admin`, i.e. migrations,
-- seeds and the test fixtures, which plant accepted, declined and back-dated
-- rows directly (tests/e2e/support/fixtures.ts, the psql suites, the email
-- integration tests) to build the world a test then measures. Those are not
-- API roles: no PostgREST request runs as either. No SECURITY DEFINER
-- function inserts into this table today; one that did would run as its
-- owner and be exempt, so a future one must stamp the row itself.
--
-- ADDITIVE. One new function, one new trigger, one ALTER POLICY rebuilt from
-- the LIVE definition (pg_get_expr on this stack, unchanged since
-- 20260904003000). No committed migration is edited.
-- ===========================================================================

create or replace function private.connection_request_born_pending()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if new.status is distinct from 'pending' then
    raise exception
      'network_connection_requests: a request is created pending (tried %); only the recipient can accept it',
      new.status
      using errcode = '23514';
  end if;

  if new.responded_at is not null or new.responded_by is not null then
    raise exception
      'network_connection_requests: a new request has no response yet (responded_at and responded_by must be null)'
      using errcode = '23514';
  end if;

  if new.requested_by is not null
     and new.requested_by is distinct from (select auth.uid()) then
    raise exception
      'network_connection_requests: requested_by is the signed-in user, not a client-chosen one'
      using errcode = '23514';
  end if;

  new.requested_by := (select auth.uid());
  new.requested_at := pg_catalog.now();
  return new;
end;
$$;

comment on function private.connection_request_born_pending() is
  'BEFORE INSERT on public.network_connection_requests (Phase 8 Task 9b fix round 1, C1 + m3). For every writer except the owner roles postgres/supabase_admin (migrations, seeds, test fixtures): REFUSES with 23514 a status other than pending, a non-null responded_at/responded_by, or a requested_by other than auth.uid(); then STAMPS requested_by := auth.uid() and requested_at := now(). Closes the Phase 6 hole where a sender could INSERT a request already accepted and so read the target''s connections-level fields through public.network_connected_profiles without the target accepting -- and, since Task 9b, without the target being emailed. SECURITY INVOKER on purpose: current_user must be the calling role for the owner exemption to mean anything. The INSERT policy carries the same status/responded terms as a second layer.';

revoke all on function private.connection_request_born_pending()
  from public, anon, authenticated, service_role;

drop trigger if exists born_pending on public.network_connection_requests;
create trigger born_pending
  before insert on public.network_connection_requests
  for each row
  execute function private.connection_request_born_pending();

-- ---------------------------------------------------------------------------
-- THE POLICY LAYER. The live WITH CHECK, verbatim, plus one line.
-- ---------------------------------------------------------------------------
alter policy "network_connection_requests_insert_manage_connections"
  on public.network_connection_requests
  with check (
    status = 'pending'
    and responded_at is null
    and responded_by is null
    and from_organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and from_organisation_id in (select private.network_publish_organisations())
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_connection_requests.from_network_profile_id
        and p.organisation_id = network_connection_requests.from_organisation_id
        and p.status = 'published'
        and p.deleted_at is null
    )
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_connection_requests.to_network_profile_id
        and p.organisation_id = network_connection_requests.to_organisation_id
        and p.status = 'published'
        and p.deleted_at is null
    )
  );

comment on policy "network_connection_requests_insert_manage_connections" on public.network_connection_requests is
  'PERMITS: sending a connection request FROM one of your own published, live profiles (Q78) TO another organisation''s published, live profile, when the caller holds manage_network_connections at aal2 in the sending organisation AND that organisation''s plan permits network_publish -- and ONLY AS A PENDING REQUEST WITH NO RESPONSE (status = pending, responded_at and responded_by null; Phase 8 Task 9b fix round 1, C1). DOES NOT PERMIT: a request born accepted, declined or withdrawn -- before 20261017000000 a sender could INSERT status=accepted and read the target''s connections-level fields without consent; private.connection_request_born_pending refuses that first (23514), this clause again (42501); a FREE-tier organisation sending at all (42501, Q76/N7); sending from an organisation the caller is not in; sending from a DRAFT profile, or one belonging to somebody else; FORGING to_organisation_id (the second inline exists: the named to_network_profile_id must really belong to the named to_organisation_id). Sending to YOURSELF is refused by network_connection_requests_not_self (23514). A repeat send while a pending/accepted request stands is 23505 from network_connection_requests_live_pair (Q79 as changed 2026-09-07). requested_by and requested_at are stamped by the trigger, not taken from the client.';
