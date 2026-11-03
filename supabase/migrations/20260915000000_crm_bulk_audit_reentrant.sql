-- Phase 7 Task 6b, fix round 1 (review finding M1): the CRM bulk-audit thread
-- is RE-ENTRANT, and the correlation id is no longer caller-supplied.
--
-- ===========================================================================
-- THE DEFECT, REPRODUCED BEFORE IT WAS FIXED
-- ===========================================================================
-- 20260912001000 shipped begin_crm_bulk_audit(uuid) as an unconditional SET
-- and end_crm_bulk_audit() as an unconditional CLEAR: no save, no restore, no
-- depth counter. Composing two of the four wrappers therefore SPLIT one
-- action into three threads rather than joining it into one. The review
-- measured it directly (probe P6): a function that opened a thread, updated a
-- contact, called public.set_contact_primary_company() and updated the contact
-- again produced
--
--   contact.updated          aaaaaaaa-...-0001   <- the declared thread
--   contact.updated          158c0edb-...        <- a FRESH uuid: thread lost
--   contact_company.updated  70063c76-...        <- the inner wrapper's own
--   contact_company.updated  70063c76-...
--
-- -- three correlation ids for one operation, with no error and no test red.
-- That is exactly the "un-correlated spray" 20260912001000's own header says
-- it exists to prevent: the inner wrapper's end() cleared the marker, so every
-- row written after it minted a fresh id.
--
-- Nothing on this branch composes two wrappers today (merge_records_unthreaded
-- writes custom_field_values directly rather than through
-- set_custom_field_values), so this was latent rather than live. Q122 --
-- extending the audit to the Phase 3-6 tables -- is where composition begins,
-- which is why it is fixed now rather than left as a comment.
--
-- ===========================================================================
-- THE FIX: begin() REPORTS WHETHER IT OPENED, end() CLOSES ONLY ITS OWN
-- ===========================================================================
-- private.begin_crm_bulk_audit() now returns a boolean: true when it opened a
-- thread (the caller owns it and must close it), false when one was ALREADY
-- open (the caller joins it and changes nothing). private.end_crm_bulk_audit()
-- takes that flag and clears the marker only when it is true. An inner wrapper
-- therefore joins its caller's thread and leaves it standing; the outermost
-- caller closes it. The alternative shape -- save the incoming marker and
-- restore it on end -- is equivalent here and was rejected only because a
-- boolean the caller must hold makes the pairing visible at every call site,
-- where a silent restore hides it.
--
-- One correlation id per OPERATION is the property this restores, and it is
-- now asserted rather than assumed: rls_phase7_crm_audit.sql § CB5 runs an
-- outer thread that calls a wrapper mid-way and requires EVERY row of the
-- whole operation to share ONE id (it reads 1; the code above this migration
-- produces 3).
--
-- ===========================================================================
-- THE ID IS NO LONGER THE CALLER'S TO CHOOSE (the same finding's second half)
-- ===========================================================================
-- begin_crm_bulk_audit is granted to `authenticated`, and that grant is
-- STRUCTURALLY REQUIRED: its callers are the four SECURITY INVOKER wrappers,
-- whose bodies run as the caller, so the caller must hold EXECUTE on
-- everything they call. Making the wrappers SECURITY DEFINER to drop the grant
-- would defeat their whole point -- the body must meet the caller's RLS. So
-- the grant stays.
--
-- What the grant allowed, though, was a member calling it from a direct
-- database session with an id of their choosing -- including one belonging to
-- somebody else's operation, which would splice their own writes into another
-- actor's thread. Unreachable over PostgREST (`private` is not in the exposed
-- schema list; the runner's HTTP block proves 404) and no privilege either way
-- (CA6e: no policy reads this GUC), so it was a forensic-integrity wrinkle
-- rather than an access-control one -- but it cost nothing to close: the
-- parameter is GONE. begin_crm_bulk_audit() takes no argument and mints its
-- own uuid, so the worst a direct caller can now do is open a fresh random
-- thread of their own, which is what an ordinary write does anyway. The
-- one-argument form is dropped rather than left beside it, because leaving it
-- would leave the vector.
--
-- ===========================================================================
-- WHY DROP AND CREATE RATHER THAN CREATE OR REPLACE
-- ===========================================================================
-- Both functions change their return type (void -> boolean) or their
-- signature, and `create or replace function` cannot do either. The four
-- wrappers DO keep their signatures and return types, so they are replaced in
-- place and their grants survive untouched; begin/end are dropped, recreated
-- and re-granted explicitly below. Migrations are additive: 20260912001000 is
-- immutable and still the file that explains the mechanism.

-- ---------------------------------------------------------------------------
-- 1. THE RE-ENTRANT THREAD
-- ---------------------------------------------------------------------------
drop function if exists private.begin_crm_bulk_audit(uuid);

create function private.begin_crm_bulk_audit()
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare v_open text;
begin
  v_open := pg_catalog.nullif(
    pg_catalog.current_setting('app.crm_bulk_correlation_id', true), '');

  if v_open is not null then
    -- A thread is already open. JOIN it: do not overwrite the marker, and
    -- tell the caller it does not own it, so its end() leaves it standing.
    return false;
  end if;

  perform pg_catalog.set_config(
    'app.crm_bulk_correlation_id', pg_catalog.gen_random_uuid()::text, true);
  return true;
end;
$$;

comment on function private.begin_crm_bulk_audit() is
  'OPENS one multi-row CRM operation under one correlation id, so every audit row written inside it -- by the INSERT/UPDATE/DELETE triggers on the CRM tables, by private.record_merge(), by anything added later -- joins one thread. RE-ENTRANT since Phase 7 Task 6b fix round 1 (review M1): returns true when it opened the thread (the caller owns it and must pass that true to private.end_crm_bulk_audit), and false when a thread was ALREADY open, in which case it changes nothing and the caller joins the thread it found. Composing two wrappers therefore yields ONE correlation id, not three. TAKES NO ARGUMENT: the id is minted here rather than supplied, so a member calling this from a direct database session cannot attach their writes to another actor''s thread. Granted to authenticated because its callers are the SECURITY INVOKER wrappers public.merge_records / set_contact_primary_company / set_artist_primary_representation / set_custom_field_values, whose bodies run as the caller -- that grant is structural, not optional. Unroutable itself because `private` is not exposed to PostgREST. Not a permission gate and read by no policy.';

revoke all on function private.begin_crm_bulk_audit() from public, anon, service_role;
grant execute on function private.begin_crm_bulk_audit() to authenticated;

drop function if exists private.end_crm_bulk_audit();

create function private.end_crm_bulk_audit(p_opened boolean default true)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  -- Close ONLY a thread this caller opened. A nested caller passes false and
  -- leaves its parent's thread standing; without this the inner wrapper closed
  -- the outer operation's thread and every later row minted a fresh id (M1).
  if pg_catalog.coalesce(p_opened, false) then
    perform pg_catalog.set_config('app.crm_bulk_correlation_id', '', true);
  end if;
end;
$$;

comment on function private.end_crm_bulk_audit(boolean) is
  'CLOSES the operation private.begin_crm_bulk_audit() opened, and ONLY if this caller is the one that opened it: pass back the boolean begin returned. Called as the last statement of each wrapper; an is_local GUC otherwise stands to the end of the transaction whatever SET clauses the call stack carries (measured in 20260908030000). The parameter defaults to true so a bare end_crm_bulk_audit() still closes, which is what a single, un-nested caller means.';

revoke all on function private.end_crm_bulk_audit(boolean) from public, anon, service_role;
grant execute on function private.end_crm_bulk_audit(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE FOUR WRAPPERS, REPLACED IN PLACE: hold the flag, pass it back.
-- Signatures and return types are unchanged, so grants and the moved
-- *_unthreaded bodies are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.merge_records(
  p_organisation_id      uuid,
  p_entity_type          text,
  p_winner_id            uuid,
  p_loser_id             uuid,
  p_field_choices        jsonb default '{}'::jsonb,
  p_custom_field_choices jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id     uuid;
  v_opened boolean;
begin
  v_opened := private.begin_crm_bulk_audit();
  v_id := private.merge_records_unthreaded(
    p_organisation_id, p_entity_type, p_winner_id, p_loser_id,
    p_field_choices, p_custom_field_choices);
  perform private.end_crm_bulk_audit(v_opened);
  return v_id;
end;
$$;

create or replace function public.set_contact_primary_company(
  p_contact_id      uuid,
  p_company_id      uuid,
  p_organisation_id uuid
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n      integer;
  v_opened boolean;
begin
  v_opened := private.begin_crm_bulk_audit();
  v_n := private.set_contact_primary_company_unthreaded(
    p_contact_id, p_company_id, p_organisation_id);
  perform private.end_crm_bulk_audit(v_opened);
  return v_n;
end;
$$;

create or replace function public.set_artist_primary_representation(
  p_artist_id         uuid,
  p_representation_id uuid,
  p_organisation_id   uuid
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n      integer;
  v_opened boolean;
begin
  v_opened := private.begin_crm_bulk_audit();
  v_n := private.set_artist_primary_representation_unthreaded(
    p_artist_id, p_representation_id, p_organisation_id);
  perform private.end_crm_bulk_audit(v_opened);
  return v_n;
end;
$$;

create or replace function public.set_custom_field_values(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid,
  p_values          jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n      integer;
  v_opened boolean;
begin
  v_opened := private.begin_crm_bulk_audit();
  v_n := private.set_custom_field_values_unthreaded(
    p_organisation_id, p_entity_type, p_entity_id, p_values);
  perform private.end_crm_bulk_audit(v_opened);
  return v_n;
end;
$$;
