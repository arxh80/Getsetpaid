-- Phase 2 (Core CRM), Task 5 fix round 1: close I-1 -- the tier limit could be
-- multiplied by re-typing definitions instead of creating them.
--
-- Additive only. One new helper, one `alter policy`, and one corrected
-- `comment on function`. No existing migration file is edited, and no policy is
-- replaced (`create or replace policy` does not exist -- 42601).
--
-- ===========================================================================
-- WHAT WAS WRONG, AND HOW IT WAS MEASURED
-- ===========================================================================
-- private.enforce_custom_field_limit() (20260829010500) returns early on every
-- UPDATE of a live row:
--
--     if new.deleted_at is not null then return new; end if;
--     if tg_op = 'UPDATE' and old.deleted_at is null then return new; end if;
--
-- That was written to keep an over-limit organisation editable after a
-- downgrade, which it does. It also lets an UPDATE change `entity_type`, and
-- an entity_type change DOES increase the target type's live count -- so the
-- gate had a hole exactly where its own comment claimed there was none.
--
-- Reproduced on this stack as an ordinary `authenticated` caller with real
-- claims, one Starter organisation, before this migration:
--
--     five 'contact' definitions   INSERT 0 5   (legal)
--     five 'venue'   definitions   INSERT 0 5   (legal -- the limit is per type)
--     update ... set entity_type='contact' where entity_type='venue'
--                                  UPDATE 5
--     select entity_type, count(*) ... -> contact | 10
--
-- Ten live contact definitions on a plan whose limit is five, through the anon
-- key that ships in the browser, without a single INSERT. Generalises to 25.
--
-- ===========================================================================
-- THE FIX IS IMMUTABILITY, NOT A SECOND COUNT, AND THAT IS THE DECISION
-- ===========================================================================
-- Two fixes were available.
--
--   (a) COUNT ON THE RE-TYPE TOO: add `or new.entity_type is distinct from
--       old.entity_type` to the trigger's gate, so a re-type is charged against
--       the target type's allowance.
--   (b) MAKE `entity_type` IMMUTABLE, so the transition does not exist.
--
-- (b) is chosen, because `entity_type` is part of a definition's IDENTITY
-- rather than one of its attributes, and three things in the schema already say
-- so:
--
--   * custom_field_definitions_id_org_entity_unique is
--     (id, organisation_id, entity_type), and it exists for exactly one reason
--     -- to be the target of custom_field_values' composite foreign key.
--     20260827232512's header: naming all three columns is what stops a value
--     row claiming an organisation or entity type its definition does not have.
--     A column that is half of an FK target is not an attribute you edit.
--   * That FK carries `on delete cascade` and NO `on update` action, so a
--     re-type of a definition that HAS values is already refused
--     (schema_invariants C3 measures the organisation_id half of the same
--     constraint). The hole was only ever open for a definition with no values
--     yet -- which is precisely the one an attacker creates on purpose.
--   * `key` uniqueness is scoped per (organisation_id, entity_type), so a
--     re-type can also collide, producing a 23505 on an operation the product
--     never offers.
--
-- And the product does not offer it: lib/crm/custom-field-actions.ts's
-- updateCustomFieldAction writes `label`, `field_type` and `options` and never
-- `entity_type` -- it uses it as a scope predicate (`.eq("entity_type", ...)`),
-- not as a value. So nothing legitimate regresses.
--
-- (a) would have kept a transition alive that has no caller, no UI, no defined
-- behaviour for its `key` collisions and no way to carry its values across.
-- Fixing the count without fixing the concept leaves a re-type legal for a Pro
-- organisation, where the limit is NULL and the count check does nothing at
-- all. (b) closes it for every tier.
--
-- ===========================================================================
-- IT IS A POLICY TERM, NOT A THIRD BRANCH IN THE TRIGGER
-- ===========================================================================
-- Same mechanism `organisation_id` immutability already uses on this exact
-- policy: private.entity_org_unchanged('custom_field_definition', id,
-- organisation_id), added by 20260828140500 for the tenant-transfer case. One
-- rule, one place, one shape -- and a reader who finds the organisation term
-- finds this one beside it.
--
-- Putting it in the trigger instead would ALSO change the message: the trigger
-- fires BEFORE the RLS WITH CHECK, so an at-limit re-type would report "custom
-- field limit reached" and an under-limit one would report a policy refusal --
-- two different sentences for one operation that is simply not allowed, chosen
-- by how full the target bucket is. The policy gives it one answer.
--
-- BOTH WERE NOT DONE. Belt-and-braces here would be the trigger answering first
-- with the wrong sentence, which is worse than either control alone.
-- ---------------------------------------------------------------------------
create or replace function private.custom_field_definition_type_unchanged(
  p_id          uuid,
  p_entity_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.custom_field_definitions d
    where d.id = p_id
      and d.entity_type = p_entity_type
  );
$$;

comment on function private.custom_field_definition_type_unchanged(uuid, text) is
  'UPDATE guard: true iff the definition stored under p_id (read on the statement-start snapshot, STABLE) still has entity_type = p_entity_type. Called from WITH CHECK with the NEW values, so it pins entity_type immutable through the client UPDATE policy. Closes I-1: the tier limit trigger returns early on every UPDATE of a live row, so before this a caller could create five definitions on each of the five entity types and PATCH all 25 into one type -- 25 live definitions on a plan whose limit is 5, measured on this stack, no INSERT involved. entity_type is part of a definition''s identity rather than an attribute: it is half of custom_field_definitions_id_org_entity_unique, which exists solely as the target of custom_field_values'' composite FK, and that FK has no ON UPDATE action so a re-type of a definition that HAS values was already refused. Deliberately NOT a second count in the trigger -- see 20260829012000''s header for why immutability beats charging the re-type. Fail-closed if p_id names no row. Mirrors private.entity_org_unchanged''s shape, which pins organisation_id on the same policy.';

revoke all on function private.custom_field_definition_type_unchanged(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.custom_field_definition_type_unchanged(uuid, text)
  to authenticated;

-- The policy, restated WHOLE. `alter policy` replaces the clause rather than
-- appending to it, so every conjunct from 20260828140500 is repeated verbatim
-- and the new one is the last line. Dropping one of the repeated terms by
-- accident is the failure mode here; rls_phase2_crm.sql § U re-asserts the
-- permission term (U16, V16) and the entitlement term (U18) as well as the new
-- one, so a silently shortened clause is red.
alter policy "custom_field_definitions_update_manage_custom_fields"
  on public.custom_field_definitions
  using (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('custom_field_definition', id, organisation_id)
    and private.custom_field_definition_type_unchanged(id, entity_type)
  );

-- ===========================================================================
-- THE TRIGGER'S OWN COMMENT WAS FALSE, AND THIS CORRECTS IT
-- ===========================================================================
-- 20260829010500's catalogue comment said the trigger "gates exactly the two
-- transitions that increase the live count and leaves every other write alone",
-- and its inline comment listed "every other UPDATE -> not gated". An
-- entity_type change was a third count-increasing transition and was not
-- gated, so both sentences were claims about behaviour the code did not have --
-- the defect class the Task 4 addendum names, and the second instance of it in
-- this task (see 20260829011500 for the first).
--
-- The trigger is NOT changed. What makes those sentences true is the policy
-- term above, which removes the third transition rather than gating it. The
-- comment now says that, and names where to look.
comment on function private.enforce_custom_field_limit() is
  'BEFORE INSERT OR UPDATE on custom_field_definitions: refuses a write that would take the organisation past its plan''s per-entity-type limit. It gates TWO transitions -- an INSERT of a live row, and an UPDATE restoring a soft-deleted one (slot-consuming under founder decision Q12) -- and returns early on every other UPDATE, which is what keeps an over-limit organisation editable after a downgrade. THAT IS ONLY SUFFICIENT BECAUSE entity_type IS IMMUTABLE: a re-type would be a third count-increasing transition, and 20260829012000 removes it at the UPDATE policy (private.custom_field_definition_type_unchanged) rather than charging it here. This comment previously claimed the trigger gated every count-increasing transition; it did not, and re-typing 25 definitions into one bucket on a 5-field plan was measured before the fix. A trigger rather than a WITH CHECK because the restore case needs OLD, and because the nearest WITH CHECK rule would refuse an ordinary label edit in an over-limit organisation. Its first statement is an oracle guard: a BEFORE ROW trigger fires before the RLS WITH CHECK, so a caller with no manage_custom_fields in the target organisation is passed through silently and refused by the policy rather than being told whether that organisation is at its limit. Raises 42501 so PostgREST answers 403 and classifyWrite() reads `refused`.';
