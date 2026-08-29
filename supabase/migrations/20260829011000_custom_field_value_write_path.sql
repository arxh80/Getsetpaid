-- Phase 2 (Core CRM), Task 5c: the custom field VALUE write path.
--
-- Additive only. One new helper, three `alter policy` statements (not `create
-- or replace policy`, which does not exist -- 42601) and one new RPC. No
-- existing migration is edited.
--
-- ===========================================================================
-- 1. A DELETED ENTITY'S CUSTOM FIELDS ARE NOT WRITABLE, AND NOW THE DATABASE
--    SAYS SO
-- ===========================================================================
-- 20260828235000 and 20260829001000 established the rule for the other child
-- tables in as many words: "the DB backs the parent end". contact_companies,
-- artist_representations and venue_rooms all carry `p.deleted_at is null` in
-- their write policies, because `restore has to bring the record back as it
-- was` -- if the children of a deleted record can be edited while it is
-- deleted, restore brings back something else.
--
-- custom_field_values was left out of both, and it is the same shape: a value
-- hangs off exactly one entity row, and the entity page renders it. Without
-- this, deleting a contact and then PATCHing its custom fields through
-- PostgREST is accepted, and restoring the contact brings back a record whose
-- custom fields somebody changed while it was in the bin.
--
-- THE Q5/Q3a EXEMPTION DOES NOT APPLY HERE, which is why this one gets a
-- policy term where `contact_companies.company_id` deliberately does not. That
-- exemption exists for the OTHER end of a join -- a row the caller may
-- legitimately be unable to see, where a `deleted_at` term would collapse
-- "deleted" into "invisible" and refuse a legitimate write. A custom field
-- value has ONE end, and the caller must already be able to WRITE it
-- (entity_is_manageable is right there in the same policy), so there is no
-- invisible-row case to protect. The residual is nil rather than measured.
--
-- SELECT IS UNTOUCHED. A deleted contact's page still renders its custom field
-- values, for the same reason design note (g) keeps the contact itself
-- readable: the restore path needs the record to be visible while it is
-- deleted, and a detail page that renders a record with its fields silently
-- missing is worse than one that renders them read-only.
-- ---------------------------------------------------------------------------
create or replace function private.entity_is_live(
  p_entity_type text,
  p_entity_id   uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then exists (
      select 1 from public.companies e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    else false
  end;
$$;

comment on function private.entity_is_live(text, uuid, uuid) is
  'Polymorphic soft-delete dispatch: true iff p_entity_id resolves to a NOT-soft-deleted row of p_entity_type in p_org_id. Deliberately carries NO permission or record-scope term -- it is ANDed with private.entity_is_manageable(), which carries both, and duplicating them would mean two places to change. Backs the three custom_field_values WRITE policies only; the SELECT policy is untouched, because a deleted entity''s page still has to render its values (design note (g), the restore path). Unknown or NULL p_entity_type returns false; Phase 3 must add an ''event'' branch here at the same time it adds ''event'' to the three CHECK allowlists and to entity_is_visible/entity_is_manageable.';

revoke all on function private.entity_is_live(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.entity_is_live(text, uuid, uuid) to authenticated;

-- The three write policies, restated WHOLE. `alter policy` replaces the clause
-- rather than appending to it, so every existing conjunct is repeated verbatim
-- from 20260828140500 and the new one is the last line. Dropping one of the
-- repeated terms by accident is the failure mode here, and § F/§ U of
-- rls_phase2_crm.sql re-assert all of them rather than only the new one.
alter policy "custom_field_values_insert_via_entity" on public.custom_field_values
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
    and private.entity_is_live(entity_type, entity_id, organisation_id)
  );

alter policy "custom_field_values_update_via_entity" on public.custom_field_values
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
    and private.entity_is_live(entity_type, entity_id, organisation_id)
  )
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('custom_field_value', id, organisation_id)
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
    and private.entity_is_live(entity_type, entity_id, organisation_id)
  );

alter policy "custom_field_values_delete_via_entity" on public.custom_field_values
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
    and private.entity_is_live(entity_type, entity_id, organisation_id)
  );

-- ===========================================================================
-- 2. set_custom_field_values() -- one submit, one statement's worth of atomicity
-- ===========================================================================
-- A custom-fields panel submits every field on the entity at once. Done from
-- the client that is one PostgREST request per field (supabase-js issues one
-- HTTP request per statement), so a form with six fields could half-save: three
-- applied, then a refusal, and no way to put the first three back. The same
-- reasoning 20260828230000 gives for set_contact_primary_company() applies --
-- a transaction is only reachable through a function.
--
-- SECURITY INVOKER (the default, stated for emphasis), so all four
-- custom_field_values policies decide every statement inside it, INCLUDING the
-- entity_is_live term added above. The function adds a workspace term and a
-- definition-liveness term on top; it removes nothing.
--
-- ===========================================================================
-- p_organisation_id IS MANDATORY, AND THERE IS NO OVERLOAD WITHOUT IT
-- ===========================================================================
-- 20260828234500's instruction, followed literally: PostgREST resolves an RPC
-- by ARGUMENT NAME, so a 3-argument variant would be one omitted key away from
-- an unscoped write. There is exactly one signature, it takes the
-- organisation, and it applies it to every statement. RLS answers "may this
-- caller write this row"; the organisation term answers "is this row the one
-- this URL is about", and for a member of two workspaces those diverge.
--
-- ===========================================================================
-- SQL NULL vs JSON null -- the distinction 20260827232512 handed to Task 5
-- ===========================================================================
-- That migration made `value` nullable, said SQL NULL means "not filled in",
-- noted a client can also send jsonb `'null'`, and left keeping them apart to
-- this task. The contract, enforced here:
--
--   * IN THE PAYLOAD, JSON null is a VERB: `{"<field id>": null}` means
--     "clear this field", and it is the only way to clear one. It is a
--     transport instruction and is never stored.
--   * IN THE TABLE, a field with no value HAS NO ROW. This function stores
--     neither SQL NULL nor jsonb 'null' -- clearing deletes, which is what the
--     DELETE grant on this table is for (design note (f): "Clearing a field is
--     a delete").
--   * THE TWO ARE INDISTINGUISHABLE ONCE THEY LEAVE POSTGRES, and that is
--     measured rather than assumed: `select row_to_json(t) from (select
--     null::jsonb as a, 'null'::jsonb as b) t` returns {"a":null,"b":null}, so
--     PostgREST hands supabase-js a JavaScript `null` for both and no
--     application code can tell them apart. An earlier draft of this comment
--     claimed the renderer distinguishes them; it cannot, and saying so would
--     have been a comment asserting behaviour the code does not have.
--
--     What is true, and is the property the brief actually asks for, is that
--     A ROUND TRIP NEVER CONVERTS ONE INTO THE OTHER -- because this function
--     writes NEITHER. Both are pre-existing states reachable only by a direct
--     PostgREST insert; both render as "not recorded" (they mean the same
--     thing to a reader: no usable value); and the next panel save CLEARS
--     whichever it was, by deleting the row, which is the one outcome that is
--     correct for both. Kept apart IN THE DATABASE, where `value is null` and
--     `value = 'null'::jsonb` are different rows: rls_phase2_crm.sql § V
--     plants one of each, runs a save of an unrelated field, and asserts each
--     is still exactly what it was.
--
--     A stored value of the WRONG TYPE (a jsonb object on a text field, a
--     string on a number field) is a different case and IS distinguishable, so
--     lib/crm/custom-fields.ts renders it inert with a visible "needs fixing"
--     state rather than as empty.
--
-- ===========================================================================
-- EVERY REFUSAL RAISES. NOTHING IS SIGNALLED BY A LOW ROW COUNT
-- ===========================================================================
-- lib/crm/write.ts exists because a refused UPDATE is a 204 with a row count
-- of 0 and no error. Inside a function that ambiguity is avoidable, so it is
-- avoided:
--
--   * the upsert is refused by RLS by RAISING 42501 (an INSERT ... ON CONFLICT
--     refused by WITH CHECK, or whose conflicting row fails the UPDATE
--     policy's USING, is an error, not a silent skip);
--   * a field_id that names no LIVE definition of this organisation and entity
--     type is filtered out by the join, which would otherwise be a silent
--     partial save -- so the written count is compared to the requested count
--     and a shortfall raises;
--   * a DELETE refused by its policy matches nothing silently, so the rows
--     that were asked to be cleared are re-read afterwards and a survivor
--     raises.
--
-- So `error is null` means every requested change applied, and the returned
-- integer is informational. The caller (lib/crm/custom-fields.ts) reuses only
-- the error vocabulary, exactly as setPrimaryCompanyAction does, and says so.
-- ---------------------------------------------------------------------------
create or replace function public.set_custom_field_values(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid,
  p_values          jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_wanted   integer;
  v_upserted integer;
  v_deleted  integer;
begin
  if p_values is null or pg_catalog.jsonb_typeof(p_values) <> 'object' then
    raise exception 'p_values must be a jsonb object of field id -> value'
      using errcode = '22023';
  end if;

  -- CLEAR FIRST. The two sets are disjoint by construction (a key is either
  -- null or it is not), so the order does not change the outcome -- it is
  -- fixed only so the statement order is deterministic and the counts below
  -- mean the same thing on every run.
  delete from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type     = p_entity_type
     and v.entity_id       = p_entity_id
     and v.field_id in (
       select (e.key)::uuid
       from pg_catalog.jsonb_each(p_values) e
       where pg_catalog.jsonb_typeof(e.value) = 'null'
     );
  get diagnostics v_deleted = row_count;

  -- A DELETE a policy refuses matches nothing and says nothing. If any row the
  -- caller asked to clear is still readable to them, the clear did not happen
  -- and reporting success would be the exact lie lib/crm/write.ts exists to
  -- prevent.
  if exists (
    select 1
    from public.custom_field_values v
    where v.organisation_id = p_organisation_id
      and v.entity_type     = p_entity_type
      and v.entity_id       = p_entity_id
      and v.field_id in (
        select (e.key)::uuid
        from pg_catalog.jsonb_each(p_values) e
        where pg_catalog.jsonb_typeof(e.value) = 'null'
      )
  ) then
    raise exception 'custom field value not clearable by this caller in this workspace'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)
    into v_wanted
    from pg_catalog.jsonb_each(p_values) e
   where pg_catalog.jsonb_typeof(e.value) <> 'null';

  -- THE DEFINITION MUST BE LIVE, AND OF THIS ORGANISATION AND ENTITY TYPE.
  -- The composite FK already makes the organisation and entity type
  -- structurally impossible to get wrong (20260827232512's whole design), so
  -- what this join adds is the SOFT-DELETE half: a removed field must not
  -- accept new values, or "remove this field" means nothing. Read through the
  -- caller's own client -- this function is SECURITY INVOKER -- so a
  -- definition the caller cannot see is simply not there, which is a refusal
  -- rather than an oracle.
  insert into public.custom_field_values
    (organisation_id, field_id, entity_type, entity_id, value)
  select p_organisation_id, d.id, p_entity_type, p_entity_id, e.value
    from pg_catalog.jsonb_each(p_values) e
    join public.custom_field_definitions d
      on d.id = (e.key)::uuid
     and d.organisation_id = p_organisation_id
     and d.entity_type     = p_entity_type
     and d.deleted_at is null
   where pg_catalog.jsonb_typeof(e.value) <> 'null'
  on conflict (field_id, entity_id) do update
    set value = excluded.value;
  get diagnostics v_upserted = row_count;

  -- A SHORTFALL IS A SILENT PARTIAL SAVE. It means a field_id named no live
  -- definition of this organisation and entity type -- a removed field, a
  -- field of another entity type, or a definition the caller cannot read.
  -- Raising rolls the clears back with it, so the submit is all or nothing.
  if v_upserted <> v_wanted then
    raise exception
      'custom field definition not writable here: % of % values applied', v_upserted, v_wanted
      using errcode = '42501';
  end if;

  return v_upserted + v_deleted;
end;
$$;

comment on function public.set_custom_field_values(uuid, text, uuid, jsonb) is
  'Apply a whole custom-fields panel in one transaction: p_values maps field id -> value, where JSON null means CLEAR (delete the row) and is never stored. SECURITY INVOKER, so all four custom_field_values policies -- including the entity_is_live term this migration adds -- decide every statement; the function adds a workspace term and a definition-liveness term on top and removes nothing. p_organisation_id is mandatory and there is deliberately no overload without it: PostgREST resolves by argument name, so an unscoped variant would be one missing key away (20260828234500). EVERY REFUSAL RAISES -- the upsert by RLS, a shortfall against the requested count, and a survivor of a refused DELETE -- so `error is null` means every requested change applied and the returned integer is informational rather than the signal. SQL NULL and jsonb ''null'' are kept apart by never writing either.';

revoke all on function public.set_custom_field_values(uuid, text, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_custom_field_values(uuid, text, uuid, jsonb)
  to authenticated;
