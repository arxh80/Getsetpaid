-- Phase 6 (Network), Task 1 fix round 1: review finding I4.
--
-- ===========================================================================
-- THE FINDING: A REQUIRED PARAMETER NO SANCTIONED READ PATH CAN PRODUCE
-- ===========================================================================
-- public.network_connection_requests.to_organisation_id is NOT NULL, and
-- lib/network/connections.ts's sendConnectionRequestAction required it from the
-- form. The reviewer established that NOTHING CAN SUPPLY IT:
--
--   * the only sanctioned way to find a foreign profile is
--     public.network_directory, which DELIBERATELY does not project
--     organisation_id -- a discovery result identifies a PROFILE, never a
--     tenant (20260904004000);
--   * selecting it from public.network_profiles for a foreign organisation is
--     explicitly forbidden by network_profiles_select_published_directory's own
--     comment (20260904003000): "application code must NEVER select from this
--     table for a foreign organisation".
--
-- So the send-from-directory flow Task 4 inherits had no legal source for the
-- value. Task 1's report called this redundancy; it is a dead end, and
-- Constraint 19 ("specify wiring, not existence") makes it Task 1's to close.
--
-- ===========================================================================
-- THE FIX: DERIVE IT IN THE DATABASE, FROM THE PROFILE THE CALLER PICKED
-- ===========================================================================
-- A BEFORE INSERT trigger fills to_organisation_id from
-- to_network_profile_id WHEN THE CALLER OMITS IT. The client now sends only
-- the two profile ids and its own organisation, which is exactly what the
-- directory hands it.
--
-- ORDERING, MEASURED ON THIS STACK RATHER THAN ASSUMED (Constraint 13). A
-- synthetic table in a rolled-back transaction, with a NOT NULL column, a
-- BEFORE INSERT trigger filling it, and an RLS policy whose WITH CHECK passes
-- ONLY for the trigger-filled value:
--
--     insert into t_probe (id, other) values (1, 'x');   -- INSERT 0 1
--
-- It succeeded. So a BEFORE ROW INSERT trigger runs BEFORE both the NOT NULL
-- constraint and the RLS WITH CHECK, and the policy sees the DERIVED value.
-- That is what makes this fix possible at all: the column can stay NOT NULL,
-- and the policy's second inline `exists` still runs against a real value.
--
-- ===========================================================================
-- WHY "WHEN OMITTED" AND NOT "ALWAYS OVERWRITE"
-- ===========================================================================
-- Overwriting unconditionally would be structurally stronger in one sense --
-- there would be nothing to forge -- and it would DESTROY AN ASSERTION THAT
-- CURRENTLY MEANS SOMETHING. rls_phase6_network.sql NR3 plants a request whose
-- to_organisation_id does not match its to_network_profile_id and expects
-- 42501: that is the policy's term (ii) doing the work that makes the column
-- unforgeable for ANY writer, including one that never loads this application.
-- An unconditional overwrite would turn that forged insert into a silent
-- success with a corrected value, and NR3 would have to be deleted.
--
-- So: omitted -> derived (the application path, and now the only path the
-- application uses); supplied -> left alone and CHECKED BY THE POLICY (the
-- direct-PostgREST path, where a mismatch is still a loud refusal). Both halves
-- keep their guard, and the parameter stops being required.
--
-- ===========================================================================
-- SECURITY DEFINER, AND WHAT IT DOES AND DOES NOT DISCLOSE
-- ===========================================================================
-- The lookup runs as the owner, so it resolves a profile the CALLER may not be
-- able to read -- a draft, or a soft-deleted one. That is deliberate and it
-- discloses nothing: the derived value is written into a row that
-- network_connection_requests_insert_manage_connections then REFUSES (42501),
-- because its second `exists` requires the target profile to be published and
-- live. A SECURITY INVOKER lookup would leave the column NULL for that case and
-- raise 23502, which is a worse error for the same refusal.
--
-- WHAT THE CALLER LEARNS EITHER WAY: a connection request row NAMES BOTH
-- ORGANISATIONS, and its SELECT policy lets either side read it. That is
-- inherent to Q83's bi-tenant design and predates this change -- a recipient
-- has to know who is asking, and a sender has to know who they asked. This
-- trigger does not widen that; it removes the requirement that the CLIENT
-- source the value before the row exists.
--
-- ADDITIVE. One new function, one new trigger. No table, policy or grant is
-- changed, and no shipped migration is edited.

create or replace function private.fill_connection_request_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.to_organisation_id is null then
    select p.organisation_id into new.to_organisation_id
      from public.network_profiles p
     where p.id = new.to_network_profile_id;
  end if;
  return new;
end;
$$;

comment on function private.fill_connection_request_recipient() is
  'BEFORE INSERT on public.network_connection_requests: derives to_organisation_id from to_network_profile_id WHEN THE CALLER OMITS IT. Review finding I4 -- the column is NOT NULL and no sanctioned read path can produce it: public.network_directory deliberately does not project organisation_id, and selecting it from public.network_profiles for a foreign organisation is forbidden by that table''s directory policy. MEASURED on this stack: a BEFORE ROW INSERT trigger runs before both the NOT NULL constraint and the RLS WITH CHECK, so the column stays NOT NULL and the insert policy sees the DERIVED value. FILLS ONLY WHEN NULL, deliberately: an unconditional overwrite would turn a FORGED to_organisation_id into a silent success and delete the assertion (rls_phase6_network.sql NR3) that proves the policy''s second inline `exists` makes the column unforgeable for every writer. SECURITY DEFINER so a draft or soft-deleted profile still resolves -- which discloses nothing, because the insert policy then refuses that row with 42501; a SECURITY INVOKER lookup would leave NULL and raise a less legible 23502. A request row names both organisations and either side may read it: that is Q83''s bi-tenant design and predates this trigger.';

revoke all on function private.fill_connection_request_recipient()
  from public, anon, authenticated, service_role;

-- FIRES BEFORE THE EXISTING guard_status_transition TRIGGER IS RELEVANT: that
-- one is BEFORE UPDATE, this is BEFORE INSERT, so they never both run on a
-- statement. Named for what it does, one statement per trigger, matching the
-- 20260828141000 pattern.
drop trigger if exists fill_recipient_organisation on public.network_connection_requests;
create trigger fill_recipient_organisation
  before insert on public.network_connection_requests
  for each row
  execute function private.fill_connection_request_recipient();
