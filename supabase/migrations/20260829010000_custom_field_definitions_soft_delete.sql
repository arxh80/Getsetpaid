-- Phase 2 (Core CRM), Task 5a: give custom_field_definitions a soft delete.
--
-- Additive only. A new column, two indexes and one CHECK backed by a helper
-- function. No existing migration is edited, no policy is replaced (`create or
-- replace policy` does not exist in Postgres -- 42601), and no grant changes.
--
-- ===========================================================================
-- THE DEFECT THIS CLOSES, IN TASK 2'S OWN WORDS
-- ===========================================================================
-- 20260828121000 design note (f) shipped custom_field_definitions with NO
-- DELETE policy and recorded it as an accepted deviation, with the consequence
-- spelled out: the composite FK cascades every value, so a MISTYPED KEY IS
-- PERMANENT until Task 5 adds `deleted_at`. An Owner who types `contct_ref`
-- instead of `contact_ref` has, today, no way to remove it -- not through the
-- UI, not through PostgREST, not at all.
--
-- The fix is the one CLAUDE.md § Non-negotiable rules already names: "Soft-
-- delete operational records rather than hard deletion". `deleted_at` on the
-- definition, set by an ordinary UPDATE through the policy that already
-- exists. NO DELETE POLICY AND NO DELETE GRANT ARE ADDED, deliberately -- the
-- hard delete stays unreachable from every client role, which is what keeps
-- the cascade unreachable too.
--
-- ===========================================================================
-- DECISION 1: THE VALUES SURVIVE, AND SOMETHING CAN STILL REACH THEM
-- ===========================================================================
-- Nothing is hard-deleted, so custom_field_values_definition_fkey never fires
-- and every value row stays exactly where it was. "The data is still there" is
-- only a good answer if something can read it, so:
--
--   * custom_field_definitions_select_view_crm has NO deleted_at term and
--     gains none here. A soft-deleted definition stays readable by anyone with
--     view_crm, which is what lets the entity page render the label and type
--     of a value whose field has been removed. Hiding the definition would
--     leave the value rows readable and unrenderable -- a jsonb blob with no
--     name -- which is strictly worse than not being able to delete at all.
--   * The application renders those values in a separate, read-only
--     "Removed fields" block on the entity page (components/crm/
--     custom-fields-panel.tsx), so the data is visible and is visibly not
--     part of the live form.
--   * Restoring the definition (`deleted_at = null`, the same UPDATE policy)
--     brings the field back with its values still attached, because they never
--     went anywhere.
--
-- ===========================================================================
-- DECISION 2: A SOFT-DELETED DEFINITION FREES ITS TIER SLOT
-- ===========================================================================
-- Founder decision (Q12, 2026-08-29). The count that 20260829010500's limit is
-- measured against is `where deleted_at is null`, so a Starter organisation
-- that removes a mistyped field can immediately create the correctly-spelled
-- one. The alternative -- a typo costing a paid slot forever, with no way to
-- reclaim it short of support -- makes the very defect this migration exists
-- to fix only half fixed.
--
-- THE COST IS REAL AND IS ACCEPTED RATHER THAN DENIED: an organisation can
-- soft-delete five definitions and create five more, holding ten definitions'
-- worth of VALUES while paying for five slots. Nothing here prevents that, and
-- deliberately so -- the alternative is a restriction on removing a field, in
-- a product where removing a field is the operation this migration exists to
-- make possible. It is a billing question, not a schema one, and is recorded
-- as a Phase 7 item in FOLLOW-UPS.md.
--
-- ===========================================================================
-- DECISION 3: THE KEY STAYS RESERVED WHILE THE DEFINITION IS SOFT-DELETED
-- ===========================================================================
-- custom_field_definitions_org_entity_key_unique is (organisation_id,
-- entity_type, key) over ALL rows, and this migration deliberately does NOT
-- make it partial on `deleted_at is null`.
--
-- The tempting change is to free the key too, so `notes` can be re-created
-- after `notes` is removed. It breaks restore: with a live `notes` in place,
-- restoring the soft-deleted `notes` raises 23505 at the moment the user asks
-- for their data back, and the row they are trying to reach is the one holding
-- the values. A reserved key means restore ALWAYS works, which is the property
-- that makes this a soft delete rather than a hard one with a longer fuse.
--
-- So re-creating a removed key is a 23505 with an actionable sentence
-- ("a removed field already uses that name -- restore it, or pick another"),
-- and lib/crm/custom-fields.ts carries that sentence. Measured, not assumed:
-- rls_phase2_crm.sql § U asserts the 23505.

alter table public.custom_field_definitions
  add column deleted_at timestamptz;

comment on column public.custom_field_definitions.deleted_at is
  'Soft delete. Set by an ordinary UPDATE through custom_field_definitions_update_manage_custom_fields; there is no DELETE policy and no DELETE grant on this table, so the hard delete -- and the cascade to custom_field_values it would fire -- stays unreachable from every client role. A soft-deleted definition stays SELECT-able on purpose, so the values it names can still be labelled and rendered; it FREES its tier slot (founder decision Q12, 2026-08-29, see 20260829010500); and it keeps its (organisation_id, entity_type, key) reservation, so restore can never collide with a re-created field of the same name.';

-- The live count the tier limit is measured against, and the live list every
-- entity form renders: `where organisation_id = $1 and entity_type = $2 and
-- deleted_at is null`. The existing unique index leads with the same two
-- columns but covers every row, deleted included, so it answers the uniqueness
-- question and not this one.
create index custom_field_definitions_org_entity_live_idx
  on public.custom_field_definitions (organisation_id, entity_type)
  where deleted_at is null;

-- The mirror, for the "Removed fields" block and the restore path. Partial the
-- other way, matching the three restore-view indexes 20260828180000 added for
-- the entity tables.
create index custom_field_definitions_org_deleted_idx
  on public.custom_field_definitions (organisation_id, entity_type)
  where deleted_at is not null;

-- ===========================================================================
-- THE `options` ELEMENT SHAPE -- the contract 20260827232512 handed to Task 5
-- ===========================================================================
-- That migration pinned `options` to a jsonb ARRAY and said its element shape
-- "is Task 5's contract, not this migration's". This is the contract:
--
--     [{"key": "<identifier>", "label": "<display text>"}, ...]
--
-- with `key` matching the same `^[a-z][a-z0-9_]{0,62}$` shape the definition's
-- own `key` uses (it is stored verbatim in custom_field_values.value and is
-- submitted as a form value, so it is an identifier for the same reasons),
-- `label` non-empty, and keys unique within one definition.
--
-- IT IS ENFORCED HERE RATHER THAN ONLY IN TYPESCRIPT because the anon key
-- ships in the browser: a definition POSTed straight at PostgREST with
-- `options: [1, 2, 3]` would produce a select field the entity form cannot
-- render an input for, in a table the form has no choice but to read. Unlike
-- the tier limit and unlike per-value typed validation, this needs NO subquery
-- against another table -- it is a statement about one column of one row --
-- so it is expressible as a constraint and belongs as one.
--
-- A HELPER FUNCTION, BECAUSE A CHECK CANNOT CONTAIN A SUBQUERY. The natural
-- expression (`not exists (select 1 from jsonb_array_elements(options) ...)`)
-- is rejected outright (0A000). Wrapping it in an IMMUTABLE function is the
-- standard way round that, and it costs one thing worth writing down: Postgres
-- does NOT re-validate existing rows when the function body changes, so
-- CHANGING THIS FUNCTION IS NOT THE SAME AS CHANGING THE CONSTRAINT. A future
-- migration that tightens the rule must also revalidate, or it has only
-- tightened it for new rows.
--
-- In `private`, not `public`: a public function is an RPC endpoint
-- (`/rpc/custom_field_options_valid`), and the suite's own discipline is that
-- helpers are unroutable. Constraint expressions store the function's OID, so
-- the schema-qualified reference keeps working regardless of search_path.
create or replace function private.custom_field_options_valid(p_options jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_options is null
    or (
      pg_catalog.jsonb_typeof(p_options) = 'array'
      -- Every element is {key, label} with an identifier-shaped key and a
      -- non-blank label...
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_options) e
        where pg_catalog.jsonb_typeof(e.value) <> 'object'
           or e.value ->> 'key' is null
           or e.value ->> 'label' is null
           or (e.value ->> 'key') !~ '^[a-z][a-z0-9_]{0,62}$'
           or pg_catalog.btrim(e.value ->> 'label') = ''
      )
      -- ...and no two elements share a key. Two options with the same key are
      -- indistinguishable in a stored value, so a single_select holding that
      -- key resolves to a label non-deterministically.
      and (
        select pg_catalog.count(*) = pg_catalog.count(distinct e.value ->> 'key')
        from pg_catalog.jsonb_array_elements(p_options) e
      )
    );
$$;

comment on function private.custom_field_options_valid(jsonb) is
  'The element shape 20260827232512 left to Task 5: options is a jsonb array of {key, label} objects, key matching ^[a-z][a-z0-9_]{0,62}$ (it is stored verbatim in custom_field_values.value and submitted as a form value), label non-blank, keys unique within the definition. Called from a CHECK constraint, which is why it is a function at all -- a CHECK may not contain a subquery (0A000) and jsonb_array_elements needs one. NOTE: Postgres does not revalidate existing rows when this body changes, so tightening the rule here tightens it for NEW rows only; a migration that means to tighten it for all rows must revalidate the constraint as well.';

revoke all on function private.custom_field_options_valid(jsonb)
  from public, anon, authenticated, service_role;
-- GRANTED BACK TO `authenticated`, and that is not a contradiction of the
-- "private helpers are unroutable" rule -- routability is decided by
-- supabase/config.toml exposing `public` alone, not by an ACL, so this is
-- exactly what private.permitted_organisations() already does. It is granted
-- because a CHECK constraint's expression is evaluated as the INSERTing role:
-- without EXECUTE, every client insert into this table would fail with 42501
-- from the constraint rather than from a policy, which is a refusal nobody
-- could diagnose. Measured on this stack rather than assumed -- see
-- schema_invariants.sql V2, which inserts as `authenticated` and expects a
-- constraint violation, not a privilege one.
grant execute on function private.custom_field_options_valid(jsonb) to authenticated;

alter table public.custom_field_definitions
  add constraint custom_field_definitions_options_element_shape
  check (private.custom_field_options_valid(options));
