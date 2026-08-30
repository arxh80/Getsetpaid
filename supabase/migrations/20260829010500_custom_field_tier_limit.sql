-- Phase 2 (Core CRM), Task 5b: enforce the custom-field tier limit in the
-- database.
--
-- Additive only. Two new helper functions, one trigger function and one
-- trigger. No existing migration is edited and no policy is replaced (`create
-- or replace policy` does not exist in Postgres -- 42601).
--
-- ===========================================================================
-- WHY THE DATABASE AND NOT A SERVER ACTION
-- ===========================================================================
-- CLAUDE.md § Permissions: "Entitlements are enforced server-side -- hiding UI
-- is not enforcement." 20260828140000's header already made the whole argument
-- for private.crm_write_organisations() and it applies here word for word: the
-- anon key ships in the browser bundle by design, so a POST reaches PostgREST
-- without touching a line of application code, and lib/entitlements/policy.ts
-- is on a path an attacker simply does not use. A Starter organisation POSTing
-- its fortieth contact field would be accepted by any check that lives only in
-- a Server Action.
--
-- ===========================================================================
-- WHY A TRIGGER AND NOT THE INSERT POLICY'S `WITH CHECK`
-- ===========================================================================
-- Both are in the database and both are unbypassable, so the choice is decided
-- by what each one can SEE.
--
--   1. A `WITH CHECK` cannot see OLD. The limit has to gate two transitions,
--      not one: creating a definition, and RESTORING a soft-deleted one --
--      because 20260829010000 makes a soft-deleted definition free its slot
--      (founder decision Q12), which means restore is a slot-consuming write.
--      Expressing "the live count went up" in a WITH CHECK is not possible; it
--      only sees the row as it will be. The nearest expressible rule --
--      "the live count excluding this row is under the limit" -- REFUSES AN
--      ORDINARY LABEL EDIT in an over-limit organisation, which is precisely
--      the state CLAUDE.md says a downgrade must leave editable rather than
--      broken.
--   2. A BEFORE trigger sees OLD and NEW, so it can gate exactly the two
--      transitions that increase the live count and leave every other write
--      alone. An organisation sitting at 40 definitions on Starter can rename
--      them, retype them, remove them and fill in their values; it cannot
--      create a 41st or restore a 41st.
--
-- THE ORDERING TRAP THIS CREATES, AND THE GUARD THAT CLOSES IT. A BEFORE ROW
-- trigger fires BEFORE the RLS `WITH CHECK` is applied. So without a guard,
-- any authenticated user could POST a definition naming ANOTHER organisation's
-- id and learn, from whether they got "limit reached" or a plain 403, whether
-- that organisation is at its custom-field limit. That is a cross-tenant
-- oracle of exactly the kind private.entity_is_visible() exists to prevent. The
-- first statement in the trigger body is therefore: if the caller does not
-- already hold manage_custom_fields in the target organisation, say nothing at
-- all and let the policy refuse the row. Asserted in rls_phase2_crm.sql § U.
--
-- ===========================================================================
-- WHAT IT DELIBERATELY DOES NOT DO
-- ===========================================================================
--   * It does not touch existing rows. A Pro organisation with 40 contact
--     fields that downgrades to Starter keeps all 40, keeps them readable,
--     keeps their VALUES editable, and keeps the definitions editable. Only
--     the two count-increasing transitions close. CLAUDE.md § Subscription
--     tiers: "Downgrading a subscription makes features read-only or limited;
--     it must never silently delete data."
--   * It does not fire for a table owner / superuser. `postgres` matches no
--     row of private.permitted_organisations() (auth.uid() is null), so the
--     guard above returns early and a DBA insert is not gated. That is the
--     same escape RLS itself gives the owner, and the psql suite drives this
--     as `authenticated` with real claims for exactly that reason.
--   * IT DOES NOT SERIALISE. Two concurrent inserts against the last free slot
--     both see the pre-insert count under READ COMMITTED and both commit, so
--     an organisation can end up one over its limit. Measured as a real
--     property rather than argued away: closing it needs SERIALIZABLE or an
--     advisory lock on (organisation_id, entity_type), and the cost of leaving
--     it open is one extra definition in a state THE SYSTEM ALREADY HANDLES
--     CORRECTLY -- being over the limit is the ordinary post-downgrade state,
--     and every read, edit and value write keeps working in it. A lock would
--     buy exactness in a place where exactness is not the property that
--     matters.
--
-- ===========================================================================
-- THE "NO SUBSCRIPTION ROW" ESCAPE IS MIRRORED, NOT REINVENTED
-- ===========================================================================
-- private.crm_write_organisations() reads a missing organisation_subscriptions
-- row as "not yet billed, therefore not yet gated", because
-- create_organisation() writes no subscription row and without that branch the
-- gate would deny every CRM write in the product. The same is true here and
-- harder: Free's custom_field_limit is 0, so reading "no row" as Free would
-- give EVERY organisation that exists today zero custom fields and ship the
-- feature dead.
--
-- lib/crm/custom-fields.ts's customFieldLimit() mirrors this clause for clause
-- -- "no-subscription" is unlimited there too -- and
-- tests/integration/crm/custom-field-limit-matches-db.test.ts drives the
-- DEPLOYED function against the TypeScript one across every status and every
-- side of the grace boundary, the same way past-due-grace-matches-db.test.ts
-- does for the window itself. Phase 7 removes both escapes in one change.

-- ---------------------------------------------------------------------------
-- custom_field_limit(org) -- how many LIVE definitions this organisation may
-- hold per entity type. NULL means UNLIMITED.
--
-- NULL IS OVERLOADED AND THE OVERLOAD IS BOUNDED ON PURPOSE. It means
-- "unlimited" for Pro and for the not-yet-billed escape, and it is also what a
-- nonexistent organisation gets, because the outer query returns no row. That
-- second reading would be fail-OPEN, so no caller may use this function
-- without first establishing that the organisation exists --
-- private.custom_field_slot_available() below does exactly that, in its own
-- first statement, and is the only caller in the schema.
--
-- The status branches mirror private.crm_write_organisations() clause for
-- clause, including the founder's 3-day past_due grace window measured from
-- current_period_end, and including the ALLOWLIST shape: 'cancelled' and any
-- status added later fall to Free rather than being an accidental grant.
-- ---------------------------------------------------------------------------
create or replace function private.custom_field_limit(p_org_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- No subscription row => not yet billed => not yet gated. Phase 7 removes
    -- this branch in the same migration that backfills the rows, HERE AND IN
    -- private.crm_write_organisations(). Both halves, one change.
    when s.organisation_id is null then null
    when s.status = 'active'
      or (
        s.status = 'past_due'
        and pg_catalog.now()
            < s.current_period_end
              + pg_catalog.make_interval(days => private.past_due_grace_days())
      )
      then p.custom_field_limit
    else (
      select f.custom_field_limit
      from public.subscription_plans f
      where f.key = 'free'
    )
  end
  from public.organisations o
  left join public.organisation_subscriptions s on s.organisation_id = o.id
  left join public.subscription_plans p on p.key = s.plan_id
  where o.id = p_org_id;
$$;

comment on function private.custom_field_limit(uuid) is
  'How many LIVE custom field definitions an organisation may hold PER ENTITY TYPE, from its current plan. NULL means unlimited (Pro, and the not-yet-billed escape) -- and, because the outer query returns no row for an unknown organisation, NULL is also what a nonexistent one yields, which would be fail-open. No caller may use this without first establishing the organisation exists; private.custom_field_slot_available() is the only caller and does exactly that. Status branches mirror private.crm_write_organisations() clause for clause, grace window included, and are an ALLOWLIST so a fourth status arrives denied. Free''s 0 is read out of subscription_plans, not hardcoded. lib/crm/custom-fields.ts''s customFieldLimit() is the TypeScript half; tests/integration/crm/custom-field-limit-matches-db.test.ts drives this deployed function against it.';

revoke all on function private.custom_field_limit(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.custom_field_limit(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- custom_field_slot_available(org, entity_type)
--
-- The predicate the trigger asks. Counts LIVE definitions only -- founder
-- decision Q12: a soft-deleted definition frees its slot.
--
-- SECURITY DEFINER, and that is load-bearing rather than habitual: the count
-- has to be the TRUE count. A SECURITY INVOKER count would run under
-- custom_field_definitions_select_view_crm, so a caller who somehow held
-- manage_custom_fields without view_crm would count zero rows and be allowed
-- past the limit. Fail-open through an RLS interaction is the failure mode
-- worth spending a DEFINER on.
-- ---------------------------------------------------------------------------
create or replace function private.custom_field_slot_available(
  p_org_id       uuid,
  p_entity_type  text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_used  integer;
begin
  -- The fail-open branch of custom_field_limit()'s NULL, closed here and
  -- nowhere else. An organisation that does not exist has no plan and gets no
  -- slots; the FK on organisation_id would refuse the row a moment later
  -- anyway, but this function must not be the thing that said yes.
  if not exists (select 1 from public.organisations o where o.id = p_org_id) then
    return false;
  end if;

  v_limit := private.custom_field_limit(p_org_id);
  if v_limit is null then
    return true;
  end if;

  select pg_catalog.count(*)
    into v_used
    from public.custom_field_definitions d
   where d.organisation_id = p_org_id
     and d.entity_type = p_entity_type
     and d.deleted_at is null;

  return v_used < v_limit;
end;
$$;

comment on function private.custom_field_slot_available(uuid, text) is
  'True iff the organisation may gain one more LIVE custom field definition on this entity type. Counts `deleted_at is null` only -- founder decision Q12, 2026-08-29: a soft-deleted definition frees its slot, and the cycling case that permits is a Phase 7 billing item, not a schema restriction. Backed by custom_field_definitions_org_entity_live_idx. SECURITY DEFINER so the count is the true count rather than the caller''s RLS-filtered view of it: an invoker-rights count would be fail-OPEN for a caller who could not read the rows. Establishes that the organisation exists before trusting custom_field_limit()''s NULL, which is otherwise ambiguous between "unlimited" and "no such organisation".';

revoke all on function private.custom_field_slot_available(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.custom_field_slot_available(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The trigger.
--
-- Refuses with 42501 (insufficient_privilege), the same code every other
-- refusal in this schema raises, so PostgREST answers 403 and
-- lib/crm/write.ts's classifyWrite() reads it as `refused` with no new
-- vocabulary. A bespoke SQLSTATE was considered and rejected: PostgREST maps
-- an unrecognised class to 500, which would turn a plan limit into an outage
-- in the client's eyes.
--
-- THE SENTENCE THE USER SEES IS NOT THIS ONE. `REFUSED_MESSAGE` does not name
-- a reason on purpose, so lib/crm/custom-fields.ts pre-checks the slot before
-- inserting and renders the honest sentence; and when the insert is refused
-- anyway (the unserialised race above), it RE-MEASURES the slot rather than
-- guessing, and only then says "limit". This message is the backstop's own
-- message and reaches a log, not a customer.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_custom_field_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- ORACLE GUARD, FIRST. A BEFORE ROW trigger runs before the RLS WITH CHECK,
  -- so without this a stranger could POST a definition naming any organisation
  -- id and read that organisation's limit state out of which refusal came
  -- back. Saying nothing here leaves the policy to answer, and the policy's
  -- answer carries no information about the target.
  if new.organisation_id not in (
    select private.permitted_organisations('manage_custom_fields')
  ) then
    return new;
  end if;

  -- Only the two transitions that INCREASE the live count are gated.
  --
  --   INSERT of a live row      -> gated
  --   INSERT of a deleted row   -> not gated (it consumes no slot)
  --   UPDATE deleted -> live    -> gated (restore; Q12 makes a slot the thing
  --                                being reclaimed, so it is a real spend)
  --   every other UPDATE        -> not gated, which is what keeps an
  --                                over-limit organisation editable after a
  --                                downgrade
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null then
    return new;
  end if;

  if not private.custom_field_slot_available(new.organisation_id, new.entity_type) then
    raise exception
      'custom field limit reached for this organisation on entity_type %', new.entity_type
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.enforce_custom_field_limit() is
  'BEFORE INSERT OR UPDATE on custom_field_definitions: refuses a write that would take the organisation past its plan''s per-entity-type limit. A trigger rather than a WITH CHECK because the rule needs OLD -- restoring a soft-deleted definition is slot-consuming under Q12, and a WITH CHECK expressing "the count went up" is not writable without it; the nearest WITH CHECK rule would also refuse an ordinary label edit in an over-limit organisation, which a downgrade must not do. Its first statement is an oracle guard: a BEFORE ROW trigger fires before the RLS WITH CHECK, so a caller with no manage_custom_fields in the target organisation is passed through silently and refused by the policy, rather than being told whether that organisation is at its limit. Raises 42501 so PostgREST answers 403 and classifyWrite() reads `refused`; the customer-facing sentence comes from lib/crm/custom-fields.ts, which pre-checks and re-measures rather than translating this string.';

revoke all on function private.enforce_custom_field_limit()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_tier_limit on public.custom_field_definitions;
create trigger enforce_tier_limit
  before insert or update on public.custom_field_definitions
  for each row
  execute function private.enforce_custom_field_limit();
