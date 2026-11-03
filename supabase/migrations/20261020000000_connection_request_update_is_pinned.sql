-- ===========================================================================
-- A CONNECTION REQUEST'S PARTIES ARE FIXED, ITS ANSWER IS STAMPED, AND ONLY
-- THE RIGHT SIDE MAY GIVE IT.
-- Phase 8 Task 9b fix round 2, re-review finding N1 (Critical) and the m3
-- remainder.
-- ===========================================================================
--
-- THE HOLE, PRE-EXISTING SINCE PHASE 6 AND MEASURED ON THIS STACK BEFORE THE
-- FIX (task-9b-report.md, "Fix round 2"): 20261017000000 made a request BORN
-- pending, but nothing pinned the row's PARTIES through an UPDATE. The two
-- UPDATE policies (20260904003000) are permissive, so PostgreSQL ORs their
-- USING and WITH CHECK clauses INDEPENDENTLY:
--
--   * a SENDER T passes USING through sender_withdraws (OLD from_org = T);
--   * it then rewrites from_* to the target X, to_* to itself, and
--     status = 'accepted', and passes WITH CHECK through recipient_responds
--     (NEW to_org = T, T publishes, status accepted);
--   * the transition guard reads only status (pending -> accepted is legal),
--     not_self holds (X <> T), and responded_iff_terminal holds.
--
-- public.network_connected_profiles keys on an accepted row and the org pair
-- alone, so T then read X's `connections`-level fields with X never asked.
-- A variant needs no fresh row: an existing ACCEPTED T->A row could be
-- swapped into X->T the same way (same-status, so the guard did not look).
-- And because responded_at was the client's, back-dating it eight days put
-- the row outside the seven-day notification window -- silent as well.
--
-- THE FIX, TWO LAYERS:
--
--   (1) THE CHOKEPOINT: a BEFORE UPDATE trigger, bound_update, that every
--       writer but the owner roles passes. In order:
--         (a) PINS: refuses (23514) any change to id, the four
--             organisation/profile columns, requested_by, requested_at and
--             created_at -- a request's parties and its asking are history.
--         (c) BINDS THE TRANSITION TO ITS SIDE: accepted/declined only when
--             OLD to_organisation_id is one the caller holds
--             manage_network_connections in AND that publishes (the same two
--             terms the recipient policy and acceptConnectionRequestAction
--             check); withdrawn only when OLD from_organisation_id is one the
--             caller holds manage_network_connections in (no tier term, as
--             the sender policy and authoriseWithdraw). OLD, not NEW: the
--             policy reads NEW, which is precisely what the forger chose.
--         (b) STAMPS THE ANSWER: on pending -> terminal, responded_at :=
--             now() and responded_by := auth.uid(), refusing a client
--             responded_by naming anyone else (the born_pending shape:
--             requested_at is overwritten, a foreign requested_by refused).
--             With no status change, responded_at/responded_by may not move
--             at all -- an answer, once given, is not re-dated.
--   (2) THE GRANT: authenticated's table-level UPDATE becomes UPDATE on
--       (status, responded_at, responded_by) only, so a PATCH naming a party
--       column is refused (42501) before any row is read. The actions send
--       status alone (lib/network/connections.ts terminal()); responded_* are
--       still granted so a client sending them is stamped over by (1b), not
--       refused, which keeps the trigger -- not the grant -- the layer the
--       psql suite asks about them.
--
-- WHO IS EXEMPT, AND WHY: `postgres` and `supabase_admin` -- migrations,
-- seeds, the test fixtures, every SECURITY DEFINER function owned by postgres
-- (the erasure/anonymise paths), and the ON DELETE SET NULL referential
-- actions on requested_by/responded_by, which PostgreSQL runs as the table
-- owner. Exactly born_pending's exemption. No API request runs as either.
--
-- Named so it sorts FIRST among the BEFORE UPDATE triggers (b < g < s), so a
-- forgery is refused before the transition guard or set_updated_at run.
--
-- ADDITIVE. One new function, one new trigger, a grant narrowed, the
-- transition guard's COMMENT reissued (its "responded_by / responded_at
-- correction" allowance is no longer true). No committed migration edited.
-- ===========================================================================

create or replace function private.connection_request_bound_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  -- (a) THE PARTIES AND THE ASKING ARE FIXED.
  if new.id is distinct from old.id
     or new.from_organisation_id is distinct from old.from_organisation_id
     or new.from_network_profile_id is distinct from old.from_network_profile_id
     or new.to_organisation_id is distinct from old.to_organisation_id
     or new.to_network_profile_id is distinct from old.to_network_profile_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at
     or new.created_at is distinct from old.created_at then
    raise exception
      'network_connection_requests: a request''s organisations, profiles, requester and request time cannot be changed'
      using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    -- (c) THE TRANSITION BELONGS TO ONE SIDE, READ FROM THE STORED ROW.
    if new.status in ('accepted', 'declined') then
      if old.to_organisation_id not in
           (select private.permitted_organisations('manage_network_connections'))
         or old.to_organisation_id not in
           (select private.network_publish_organisations()) then
        raise exception
          'network_connection_requests: only the receiving organisation can % a request',
          case new.status when 'accepted' then 'accept' else 'decline' end
          using errcode = '23514';
      end if;
    elsif new.status = 'withdrawn' then
      if old.from_organisation_id not in
           (select private.permitted_organisations('manage_network_connections')) then
        raise exception
          'network_connection_requests: only the sending organisation can withdraw a request'
          using errcode = '23514';
      end if;
    end if;

    -- (b) THE ANSWER IS STAMPED BY THE DATABASE.
    if new.responded_by is not null
       and new.responded_by is distinct from (select auth.uid()) then
      raise exception
        'network_connection_requests: responded_by is the signed-in user, not a client-chosen one'
        using errcode = '23514';
    end if;
    new.responded_by := (select auth.uid());
    new.responded_at := pg_catalog.now();
  elsif new.responded_at is distinct from old.responded_at
        or new.responded_by is distinct from old.responded_by then
    raise exception
      'network_connection_requests: a response, once given, is not re-dated or re-attributed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function private.connection_request_bound_update() is
  'BEFORE UPDATE on public.network_connection_requests (Phase 8 Task 9b fix round 2, N1 + m3). For every writer except the owner roles postgres/supabase_admin (migrations, seeds, fixtures, postgres-owned definer functions, ON DELETE SET NULL): (a) REFUSES (23514) any change to id, from_/to_organisation_id, from_/to_network_profile_id, requested_by, requested_at, created_at; (c) on a status change, REFUSES accepted/declined unless OLD to_organisation_id is in permitted_organisations(manage_network_connections) and network_publish_organisations(), and withdrawn unless OLD from_organisation_id is in permitted_organisations(manage_network_connections); (b) on a status change STAMPS responded_at := now() and responded_by := auth.uid() (a foreign responded_by is refused), and with no status change REFUSES any responded_at/responded_by edit. Closes the Phase 6 hole where a sender could PATCH its own request into X->T accepted (the two permissive UPDATE policies are ORed clause by clause) and read X''s connections-level fields without X accepting, back-dating responded_at to skip X''s email. SECURITY INVOKER on purpose: current_user must be the calling role for the owner exemption to mean anything.';

revoke all on function private.connection_request_bound_update()
  from public, anon, authenticated, service_role;

drop trigger if exists bound_update on public.network_connection_requests;
create trigger bound_update
  before update on public.network_connection_requests
  for each row
  execute function private.connection_request_bound_update();

-- ---------------------------------------------------------------------------
-- THE GRANT LAYER. Revoking the table-level privilege also revokes any
-- column-level UPDATE; the three answer columns are then granted alone.
-- ---------------------------------------------------------------------------
revoke update on public.network_connection_requests from authenticated;
grant update (status, responded_at, responded_by)
  on public.network_connection_requests to authenticated;

comment on function private.network_request_status_transition_guard() is
  'BEFORE UPDATE guard on public.network_connection_requests: refuses any change of status once it is terminal (accepted/declined/withdrawn), so a stray PATCH cannot un-decline a request or revive a withdrawn one. Raises 23514 (check_violation) to read like the constraint it is. Allows pending->terminal (the only real transition) and same-value UPDATEs. Since 20261020000000 a same-status UPDATE can no longer move responded_at/responded_by (private.connection_request_bound_update refuses it, and stamps both on the transition) nor any party column. DEFENCE IN DEPTH behind the two UPDATE policies'' WITH CHECK clauses, which pin the LANDING value but not the transition -- without this, a recipient could PATCH `declined` straight to `accepted` and satisfy the WITH CHECK, because accepted is a permitted landing value. Modelled on private.guard_document_scan_status (20260902031000).';
