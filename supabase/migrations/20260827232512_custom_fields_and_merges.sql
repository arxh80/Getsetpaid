-- Phase 2 (Core CRM), Task 1c: the custom-fields engine and the merge record.
--
-- Split out from 20260827232510 because these three tables are cross-cutting
-- machinery rather than domain entities: both address entity rows
-- polymorphically, and both therefore have integrity problems the previous
-- migration does not. Keeping them separate keeps that reasoning in one place.
--
-- Same scope rules as 20260827232510: tables, constraints and indexes only,
-- RLS enabled with zero policies, no grants (the ALTER DEFAULT PRIVILEGES
-- baseline in 20260827232507 leaves every table below with an empty ACL).
-- Policies, permission keys and the tier-limit enforcement are Task 2 and
-- Task 5.
--
-- ===========================================================================
-- THE ENTITY-TYPE ALLOWLIST, and why it is repeated rather than shared
-- ===========================================================================
--
-- All three tables carry an `entity_type text` naming which CRM entity a row
-- points at, constrained to the same five values. There is deliberately no
-- shared lookup table and no shared domain:
--
--   * A lookup table would make entity_type an FK, which reads like stronger
--     integrity but is not -- the value set is fixed by the code that resolves
--     each type to a physical table, so making it data-driven means a row can
--     be added that no code path can resolve.
--   * The check constraint's value list is duplicated across three tables.
--     That is the cost, and it is paid on purpose: Phase 3 adds 'event' to all
--     three in one migration, and having to touch three constraints is a
--     feature -- it is the reminder that three code paths also need the new
--     type.
--
-- Values are SINGULAR and match the table name minus its plural: 'company',
-- 'contact', 'agency', 'artist', 'venue'. Phase 3 adds 'event'.
--
-- ===========================================================================
-- POLYMORPHIC ENTITY_ID: WHAT ENFORCES INTEGRITY, GIVEN AN FK CANNOT
-- ===========================================================================
--
-- custom_field_values.entity_id, merges.winner_id and merges.loser_id all
-- name a row in one of five different tables, chosen by entity_type. Postgres
-- has no foreign key that can express "references whichever table this other
-- column names", so these columns are unvalidated uuids: nothing at the
-- database level stops one pointing at a deleted row, a row of the wrong type,
-- or a row in ANOTHER TENANT. That last one is the part that matters.
--
-- Four things carry the load instead, in descending order of how much they can
-- be trusted:
--
--   1. `organisation_id` on every row here, NOT NULL, FK to organisations.
--      Task 2's RLS policies key on it exactly as they do for the entity
--      tables, so a value row is only ever readable or writable within one
--      tenant. This does NOT prove entity_id belongs to that tenant -- it
--      bounds who can see the claim, not whether the claim is true.
--
--   2. A REAL COMPOSITE FOREIGN KEY on custom_field_values, covering the half
--      of the problem that can be covered. See its table comment: the
--      (field_id, organisation_id, entity_type) -> custom_field_definitions
--      constraint makes it structurally impossible for a value row to claim a
--      different organisation or entity type than the definition it is filed
--      under. Only entity_id itself is left unenforced.
--
--   3. Task 2's write policies, which must resolve entity_id against the
--      physical table for entity_type and confirm the resolved row's
--      organisation_id matches -- an EXISTS per entity type, in a helper.
--      Rejecting an unresolvable entity_id is that helper's job.
--
--   4. Task 5's and Task 6's application code. Weakest, listed last, and named
--      here only so nobody mistakes it for the control.
--
-- IF A LATER PHASE FINDS ITSELF WRITING A FIFTH MECHANISM, that is the signal
-- to reconsider the shape -- per-entity value tables (contact_custom_values,
-- venue_custom_values, ...) trade table count for real foreign keys, and are
-- the escape hatch if polymorphism proves to cost more than it saves.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- custom_field_definitions
-- One row per custom field an organisation has defined on an entity type.
-- Tier-gated (CLAUDE.md § Subscription tiers: Free 0, Starter 5 per entity,
-- Pro unlimited) -- ENFORCEMENT IS NOT HERE. There is no per-organisation
-- count constraint in this table, because the limit is not a fixed number: it
-- comes from subscription_plans.custom_field_limit for the organisation's
-- current plan, and NULL there means unlimited. Expressing that as a table
-- constraint means a subquery in a CHECK, which Postgres does not allow and
-- which would in any case be wrong -- a plan downgrade must make existing
-- fields read-only, never retroactively invalid (CLAUDE.md: "Downgrading a
-- subscription ... must never silently delete data"). Task 5 enforces it
-- server-side on the write path.
-- ---------------------------------------------------------------------------
create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  entity_type text not null,
  -- The machine name: a JSON object key in custom_field_values.value's
  -- consumers, a form field name, and a query-string parameter. Constrained to
  -- an identifier shape for the same reason create_organisation() constrains
  -- slugs -- this is user input that becomes an identifier, and 'first name'
  -- or 'fée' as a key is a bug waiting for whichever layer forgets to encode.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- What a human sees. Unconstrained beyond non-empty: it is display text.
  label text not null check (btrim(label) <> ''),
  field_type text not null,
  -- The choices for single_select/multi_select. jsonb array of option objects;
  -- its internal shape is Task 5's contract, not this migration's.
  options jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint custom_field_definitions_entity_type_allowed check (
    entity_type in ('company', 'contact', 'agency', 'artist', 'venue')
  ),
  -- The brief calls this an enum; it is a check constraint, matching
  -- Foundation's register (organisation_memberships.status,
  -- organisation_subscriptions.billing_cycle) rather than introducing a second
  -- style for closed value sets in the same schema.
  constraint custom_field_definitions_field_type_allowed check (
    field_type in (
      'text', 'number', 'date', 'boolean', 'single_select', 'multi_select', 'url'
    )
  ),
  -- Two halves of one rule, split so a violation says which half failed.
  -- A select field with no options renders an empty dropdown that silently
  -- cannot be filled in -- a broken field that looks fine in the definition UI.
  constraint custom_field_definitions_options_required_for_selects check (
    field_type not in ('single_select', 'multi_select') or options is not null
  ),
  constraint custom_field_definitions_options_is_array check (
    options is null or jsonb_typeof(options) = 'array'
  ),

  -- Two keys with the same name on the same entity type in the same
  -- organisation are indistinguishable to every consumer. Integrity, not a
  -- product rule.
  constraint custom_field_definitions_org_entity_key_unique
    unique (organisation_id, entity_type, key),

  -- REDUNDANT ON ITS OWN, and it exists solely to be the target of
  -- custom_field_values' composite foreign key below -- Postgres requires a
  -- unique constraint on exactly the referenced column list. `id` is already
  -- the primary key, so this adds no integrity to THIS table; what it buys is
  -- that a value row cannot claim an organisation or entity type its
  -- definition does not have. See custom_field_values' comment.
  constraint custom_field_definitions_id_org_entity_unique
    unique (id, organisation_id, entity_type)
);

comment on table public.custom_field_definitions is
  'Per-organisation custom field on a CRM entity type. Tier limits (Free 0 / Starter 5 per entity / Pro unlimited) are NOT enforced here -- the limit is a subquery against the organisation''s plan, which a CHECK cannot express, and a downgrade must make existing fields read-only rather than invalid. Task 5 enforces it server-side. custom_field_definitions_id_org_entity_unique is redundant for this table and exists only as the target of custom_field_values'' composite FK.';

comment on column public.custom_field_definitions.entity_type is
  'Which CRM entity this field applies to. Same five-value allowlist as custom_field_values and merges, duplicated on purpose -- Phase 3 adds ''event'' to all three, and having to touch three constraints is the reminder that three code paths change too.';

-- organisation_id is the leading column of
-- custom_field_definitions_org_entity_key_unique, so that FK is already
-- indexed -- no separate index. Same reasoning as Foundation's
-- organisation_memberships note.

-- ---------------------------------------------------------------------------
-- custom_field_values
-- The value of one definition on one entity row.
--
-- `value` is jsonb because the column has to hold whatever field_type says --
-- a string, a number, a date, a boolean, or an array of option keys for
-- multi_select. It is NULLABLE, and null means "not filled in", which is
-- distinct from the JSON null a client could send; Task 5 owns keeping those
-- apart on the way in.
--
-- Typed validation (does this value match its definition's field_type; is a
-- single_select value one of the definition's options) is NOT expressible
-- here without a subquery in a CHECK. Task 5 does it on the write path.
--
-- THE COMPOSITE FOREIGN KEY IS THE POINT OF THIS TABLE'S DESIGN.
--   foreign key (field_id, organisation_id, entity_type)
--     references custom_field_definitions (id, organisation_id, entity_type)
-- rather than the obvious `field_id references custom_field_definitions (id)`.
-- The obvious version permits a row in organisation A to file a value under
-- organisation B's field definition -- the value row's own organisation_id
-- says A, so A's RLS policies happily expose it, while its field_id resolves
-- into B's tenant for the label, the type and the option list. That is a
-- cross-tenant read through a path that looks, from A's side, entirely
-- legitimate. Naming all three columns in the constraint makes it a
-- referential-integrity failure instead of a policy question.
--
-- Both are ON DELETE CASCADE: deleting a definition deletes its values, which
-- is what "remove this custom field" means.
--
-- NO owner_user_id: record scope follows the entity row this value is attached
-- to (see 20260827232510, convention (2)).
-- ---------------------------------------------------------------------------
create table public.custom_field_values (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  field_id uuid not null,
  entity_type text not null,
  -- POLYMORPHIC. No foreign key is possible -- see this migration's header for
  -- the four mechanisms that carry integrity instead, and which of them can
  -- actually be trusted.
  entity_id uuid not null,
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint custom_field_values_entity_type_allowed check (
    entity_type in ('company', 'contact', 'agency', 'artist', 'venue')
  ),

  constraint custom_field_values_definition_fkey
    foreign key (field_id, organisation_id, entity_type)
    references public.custom_field_definitions (id, organisation_id, entity_type)
    on delete cascade,

  -- One value per field per row. A second row for the same pair is not a
  -- second value, it is a lost update waiting to be read non-deterministically.
  constraint custom_field_values_field_entity_unique unique (field_id, entity_id)
);

comment on table public.custom_field_values is
  'One custom field value on one entity row. entity_id is polymorphic and cannot be foreign-keyed -- the migration header lists what enforces integrity instead. The FK to custom_field_definitions is deliberately COMPOSITE on (field_id, organisation_id, entity_type): a plain field_id FK would let organisation A file a value against organisation B''s definition, which A''s own RLS would then happily expose. value is jsonb because its shape depends on the definition''s field_type; typed validation is Task 5''s, on the write path.';

comment on column public.custom_field_values.entity_id is
  'The id of the row in the table named by entity_type. UNVALIDATED at the database level -- no FK can express "references whichever table this other column names". Task 2''s write policy must resolve it against the physical table and confirm the organisation matches.';

create index custom_field_values_organisation_id_idx
  on public.custom_field_values (organisation_id);
-- NO dedicated index for custom_field_values_definition_fkey, and this is the
-- one FK in Phase 2 where "it is a leading column somewhere" needs more than
-- an assertion -- the constraint spans three columns
-- (field_id, organisation_id, entity_type), so a strict FK-coverage audit
-- flags it as uncovered. It was measured rather than argued.
--
-- Against 200 definitions x 150 values, the lookup ON DELETE CASCADE performs
--
--   where field_id = $1 and organisation_id = $2 and entity_type = $3
--
-- plans as a BitmapAnd of custom_field_values_field_entity_unique (on
-- field_id) and custom_field_values_organisation_id_idx -- no sequential scan,
-- with entity_type applied as a heap filter. The two indexes that already
-- exist for other reasons cover it between them. Adding a third,
-- (field_id, organisation_id, entity_type), would duplicate both for a plan
-- that is already index-only on its selective column.
--
-- If a future audit re-flags this, the answer is this measurement, not a new
-- index -- but re-measure rather than trusting the comment if the definition:
-- value ratio changes materially (a tenant with two definitions and a million
-- values would make field_id unselective and change the answer).
--
-- (entity_type, entity_id) is the actual read pattern: "give me every custom
-- value on this contact". Composite and in that order because entity_type is
-- always known when entity_id is, and it keeps the index clustered by type.
create index custom_field_values_entity_idx
  on public.custom_field_values (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- merges
-- One row per completed duplicate merge. CLAUDE.md § Domain entities: "exact
-- matches (email/name) auto-merge; fuzzy matches are flagged for manual
-- review, never auto-merged silently. Every merge is audited."
--
-- THIS TABLE IS NOT THE AUDIT RECORD -- it is the merge's own domain record,
-- holding the field-by-field resolution that audit_events' generic
-- before/after jsonb would flatten. Task 6 writes BOTH: a row here and an
-- audit_events row through private.log_audit_event(). Neither replaces the
-- other.
--
-- APPEND-ONLY, so it follows audit_events' shape rather than the standard
-- column set: there is no `updated_at`, because a completed merge is a
-- historical fact and nothing amends it, and `merged_at` plays the role of
-- `created_at` rather than sitting beside a duplicate of itself.
--
-- Being append-only is not enforced here. Foundation achieves it for
-- audit_events by granting no client UPDATE/DELETE and writing only through a
-- SECURITY DEFINER function; Task 2 should do the same for this table, and
-- that is the note it needs to see.
--
-- NO owner_user_id: this is not a scoped CRM record. `merged_by` is the actor,
-- which is a different thing.
-- ---------------------------------------------------------------------------
create table public.merges (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  entity_type text not null,
  -- POLYMORPHIC, both of them: the row kept and the row merged away, in the
  -- table named by entity_type. No FK is possible, and loser_id is a
  -- particularly clear case of why one would not help even if it were --
  -- the loser is typically soft-deleted or gone by the time anyone reads this
  -- row, and a merge record that vanishes with its loser is not a record.
  winner_id uuid not null,
  loser_id uuid not null,
  -- No ON DELETE clause, matching audit_events.actor_user_id and for the same
  -- reason: a merge is a destructive action and its attribution must survive
  -- the actor's account being removed, so a hard delete of auth.users is
  -- blocked while a merge references it. GDPR erasure therefore has to
  -- anonymise rather than delete, which is Phase 7+ work -- recorded in
  -- FOLLOW-UPS.md alongside the audit_events case so both are handled by one
  -- decision rather than found separately.
  merged_by uuid not null references auth.users (id),
  merged_at timestamptz not null default now(),
  -- Which record each field's surviving value came from, and what the
  -- discarded value was. The reason this table exists rather than only an
  -- audit_events row: "merged B into A" is not enough to undo or explain a
  -- merge six months later, and this is the field-level record that is.
  field_resolution jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_resolution) = 'object'),

  constraint merges_entity_type_allowed check (
    entity_type in ('company', 'contact', 'agency', 'artist', 'venue')
  ),
  -- A record merged into itself is always a bug, and one that would read as a
  -- successful merge in the history.
  constraint merges_distinct_records check (winner_id <> loser_id)
);

comment on table public.merges is
  'Completed duplicate merge, with its field-level resolution. Complements rather than replaces the audit_events row Task 6 must also write -- audit_events'' generic before/after would flatten which field came from which record. Append-only in intent (no updated_at, merged_at is the creation timestamp); Task 2 must enforce that the way Foundation does for audit_events: no client UPDATE/DELETE grant, writes through a privileged function. winner_id/loser_id are polymorphic and unvalidated -- see the migration header.';

comment on column public.merges.merged_by is
  'The actor. Deliberately has NO ON DELETE clause, matching audit_events.actor_user_id: attribution for a destructive action must survive the account being removed, so auth.users hard-deletion is blocked while a merge references it. GDPR erasure must anonymise instead -- Phase 7+, tracked in FOLLOW-UPS.md.';

create index merges_organisation_id_idx
  on public.merges (organisation_id);
create index merges_merged_by_idx
  on public.merges (merged_by);
-- Not FK-backed (polymorphic), but "has this record been merged, and into
-- what?" is the question the merge history exists to answer, and it is asked
-- from both ends: from the winner when showing a record's merge history, and
-- from the loser when a stale link or bookmark resolves to a record that no
-- longer exists and has to redirect.
create index merges_entity_winner_idx
  on public.merges (entity_type, winner_id);
create index merges_entity_loser_idx
  on public.merges (entity_type, loser_id);

-- ===========================================================================
-- Row Level Security -- enabled, with ZERO policies
-- ===========================================================================
-- Same reasoning as 20260827232510: RLS with no policies denies every row, and
-- these tables must not be reachable in the window before Task 2's policies
-- exist. Not forced, for the owner-exemption reason in Foundation's design
-- note (d).
alter table public.custom_field_definitions enable row level security;
alter table public.custom_field_values      enable row level security;
alter table public.merges                   enable row level security;
