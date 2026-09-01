-- Phase 5 (Finance), Task 1a: public.financial_entries.
--
-- Scope note, mirroring 20260901000000's Task 1a/2a/2b split exactly: this
-- migration creates the TABLE, its CONSTRAINTS, INDEXES, GRANTS and one
-- updated_at trigger, and adds the `'financial_entry'` arm to
-- private.entity_org_unchanged(). It creates NO policies, NO permission keys
-- and NO entitlement helper. Those are Task 1b/1c/1d (20260903001000,
-- 20260903002000, 20260903003000), which depend on the table created here.
--
-- RLS IS ENABLED AT THE BOTTOM OF THIS FILE, with zero policies. RLS with no
-- policies denies every row to every non-owner role, which is the correct
-- intermediate state (CLAUDE.md § Non-negotiable rules: RLS on "before the
-- application can reach it"). This is the same deliberate interval events and
-- the operations tables opened.
--
-- MEASURED CONSEQUENCE, stated so a reviewer does not have to discover it:
-- between this migration and 20260903003000, schema_invariants.sql D4, D5 and
-- D11b FAIL -- a grant with no policy behind it reaches no rows, which is the
-- safe direction. The three counts already carry the post-Task-1d numbers
-- (0, 0 and 41); a reviewer checks they went GREEN, not that they were
-- silenced.
--
-- ===========================================================================
-- CONVENTIONS -- inherited from 20260901000000, restated only where this file
-- makes a choice that file did not
-- ===========================================================================
--
-- (1) TENANCY. financial_entries carries `organisation_id` NOT NULL with an
--     ON DELETE CASCADE FK to public.organisations, and every reference to a
--     parent row is a TENANT-SCOPED COMPOSITE foreign key
--     (parent_id, organisation_id) -> parent (id, organisation_id) (Constraint
--     4; SECURITY.md § 10). So a finance line cannot reference another
--     tenant's event, contact or artist.
--
-- (2) NO owner_user_id. Finance scope is ROLE-BASED, not owner-record-based:
--     the roles that hold view_finance/manage_finance (finance, owner, admin)
--     are all full-scope, so there is no record-scope disjunction on any
--     financial_entries policy and no owner column for one to read. This is
--     why the list sort-covering index below includes `event_id` rather than
--     the `owner_user_id` the five Phase 2 lists include -- there is no owner
--     column to cover. Stated again on that index and in
--     lib/crm/finance-list.ts's SortOption.backedBy comment, or the deviation
--     reads as an omission.
--
-- (3) VALUE DOMAINS ARE CHECK CONSTRAINTS, NOT ENUM TYPES (20260901000000
--     note (3)). `category` and `status` are closed value sets enforced by a
--     CHECK; lib/crm/finance-category.ts is the request-side mirror.
--
-- (4) SOFT DELETE. `deleted_at timestamptz`, per CLAUDE.md § Non-negotiable
--     rules. NO DELETE GRANT: soft delete is the only delete, and it is an
--     UPDATE of `deleted_at`.
--
-- (5) MONEY. `amount_minor bigint`, not integer: a festival's gross exceeds
--     the int4 ceiling (~£21m), so bigint is the honest width. `currency`
--     defaults to 'GBP' and is CHECK-pinned to 'GBP' -- the GBP pin is the MVP
--     gate (CLAUDE.md § Non-functional targets: "GBP only at MVP"), and the
--     multi-currency migration later drops the CHECK without a schema change
--     (the column and minor-units storage are already here). Q63/Q66.
--
-- (6) TIMESTAMPS. UTC (`timestamptz`), `updated_at` maintained by a trigger
--     added BY HAND at the bottom (20260901000000 note (5)). THE TRIGGER IS
--     NAMED `set_updated_at`, not `financial_entries_set_updated_at`:
--     rls_phase2_crm.sql L5 asserts every table with an `updated_at` column
--     has a non-internal trigger of exactly that name. `occurred_on` is a
--     `date`, not a timestamp -- a finance line is filed against a day (PRD
--     "date"), and it is NOT NULL so it can be the list's default sort key
--     (Constraint 9; a nullable sort column makes keyset ordering non-total).

-- ---------------------------------------------------------------------------
-- financial_entries
-- A budget or actual money line on an event -- a fee, a cost or an income line.
-- PRD § 6.7 (event finance). MVP scope is budget & actuals only (CLAUDE.md
-- § Scope discipline): fee/cost/income lines per event, no invoicing, no P&L.
--
-- Tenant-private, like every other table in this schema; nothing here is
-- joined into a network discovery path (CLAUDE.md § The private/network split).
-- Finance is the product's most restricted surface: writes require Pro-tier
-- AND the Finance role (or Owner/Admin) AND aal2, all three server-side, and
-- the three gates land in 20260903001000-003000.
-- ---------------------------------------------------------------------------
create table public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,

  -- NOT NULL (Q68): a finance line exists to price an event, so it always
  -- names one. The composite FK below cascades -- deleting an event removes
  -- its finance lines, because they cannot outlive the event they price.
  event_id uuid not null,

  -- Q58 / tension (b): fee (what the act is paid), cost (what the show costs)
  -- and income (what the show takes). A closed set; lib/crm/finance-category.ts
  -- is the mirror, bound to this CHECK by Task 4's vocabulary test.
  category text not null
    check (category in ('fee','cost','income')),

  -- Q59: `budgeted` is the plan, `actual` is what happened. MVP finance is
  -- exactly these two columns of a budget-vs-actuals sheet. `budgeted` is the
  -- default -- a line is a plan until it is reconciled.
  status text not null default 'budgeted'
    check (status in ('budgeted','actual')),

  -- Q63. bigint (see header note 5). Non-negative: a cost and an income are
  -- distinguished by `category`, not by the sign of the amount, so a negative
  -- amount is a data error rather than a refund. Stored in minor units (pence).
  amount_minor bigint not null check (amount_minor >= 0),

  -- Q66. The GBP pin is the MVP gate (see header note 5), dropped by the
  -- multi-currency migration later.
  currency text not null default 'GBP' check (currency = 'GBP'),

  -- PRD "date". NOT NULL so it can be the list's default sort key (Constraint
  -- 9); a line with no date agreed is filed against today (default) and
  -- editable, which is honest, rather than a NULL that sorts arbitrarily.
  occurred_on date not null default current_date,

  -- Optional free-text label, e.g. "Headliner fee".
  description text,

  -- Q61: both nullable, both the composite tenant-scoped set-null form below.
  -- A finance line MAY name the supplier contact it pays or the artist it is a
  -- fee for; deleting that contact/artist leaves the line intact but unlinked.
  supplier_contact_id uuid,
  artist_id uuid,

  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.financial_entries is
  'A budget or actual money line on an event (PRD § 6.7): a fee, cost or income line. MVP finance is budget & actuals only (CLAUDE.md § Scope discipline). Tenant-private; never joined into a network discovery path. Soft-deleted, never hard-deleted, and there is no DELETE grant. Finance is the most restricted write surface in the product: a write requires Pro-tier (finance_module) AND manage_finance AND aal2, enforced by three independent terms across the policies in 20260903003000. NO owner_user_id -- finance scope is role-based, not record-based.';

comment on column public.financial_entries.amount_minor is
  'Minor units (pence). bigint, not integer: a festival gross exceeds the int4 ceiling (~£21m). Non-negative -- a cost and an income are told apart by `category`, not by sign.';

comment on column public.financial_entries.occurred_on is
  'NOT NULL because it is the finance list''s default sort column, and a nullable sort column makes keyset ordering non-total. A line with no date agreed defaults to today and is editable.';

comment on column public.financial_entries.currency is
  'GBP-pinned at MVP (CLAUDE.md § Non-functional targets). The column and minor-units storage are already multi-currency-shaped; the multi-currency migration later drops this CHECK without a schema change.';

-- ---------------------------------------------------------------------------
-- The unique constraint future child FKs point at, and the three composite
-- tenant-scoped FKs.
--
-- financial_entries_id_org_unique is redundant on its own (id is the primary
-- key) and exists only as a future child-FK target -- harmless now, the same
-- trade events_id_org_unique makes.
--
-- The COLUMN LIST on the two set-null FKs is LOAD-BEARING, not stylistic
-- (Constraint 5): a bare `on delete set null` on a COMPOSITE key nulls EVERY
-- referencing column, organisation_id included, and organisation_id is
-- NOT NULL -- so deleting a referenced contact/artist would fail with 23502.
-- The Postgres 15+ column-list form restricts the SET NULL to the nullable
-- column. Same trap, same fix, as events_venue_fkey (20260901000000).
-- ---------------------------------------------------------------------------
alter table public.financial_entries
  add constraint financial_entries_id_org_unique unique (id, organisation_id);

alter table public.financial_entries
  add constraint financial_entries_event_fkey
    foreign key (event_id, organisation_id)
    references public.events (id, organisation_id) on delete cascade;

alter table public.financial_entries
  add constraint financial_entries_supplier_contact_fkey
    foreign key (supplier_contact_id, organisation_id)
    references public.contacts (id, organisation_id)
    on delete set null (supplier_contact_id);

alter table public.financial_entries
  add constraint financial_entries_artist_fkey
    foreign key (artist_id, organisation_id)
    references public.artists (id, organisation_id)
    on delete set null (artist_id);

comment on constraint financial_entries_event_fkey on public.financial_entries is
  'Tenant-scoped and CASCADE: a finance line names an event that agrees with it about which organisation it belongs to, and deleting that event removes its finance lines -- they cannot outlive the event they price. Without the composite form a user could file a line against another tenant''s event.';
comment on constraint financial_entries_supplier_contact_fkey on public.financial_entries is
  'Tenant-scoped, set-null with the COLUMN LIST (supplier_contact_id). Deleting the linked contact leaves the line intact but unlinked; the column list is REQUIRED or the SET NULL would also null organisation_id (NOT NULL) and raise 23502. Same measured trap as events_venue_fkey.';
comment on constraint financial_entries_artist_fkey on public.financial_entries is
  'Tenant-scoped, set-null with the COLUMN LIST (artist_id). Same reasoning as the supplier-contact FK, on the artist side.';

-- ---------------------------------------------------------------------------
-- Indexes.
--
-- FK-covering (schema_invariants D3) plus the two covering indexes the list
-- and the per-event summary need.
--
-- The list sort-covering index deviates from the standard
-- `(organisation_id, <sort>, id) include (owner_user_id) where deleted_at is
-- null` shape: financial_entries has NO owner_user_id (header note 2), so the
-- covering column is `event_id` -- the finance list renders which event each
-- line is on, so event_id is what the index-only scan needs. Stated here and
-- in lib/crm/finance-list.ts's SortOption.backedBy comment.
-- ---------------------------------------------------------------------------
create index financial_entries_organisation_id_idx        on public.financial_entries (organisation_id);
create index financial_entries_event_id_org_idx           on public.financial_entries (event_id, organisation_id);
create index financial_entries_supplier_contact_id_org_idx on public.financial_entries (supplier_contact_id, organisation_id);
create index financial_entries_artist_id_org_idx          on public.financial_entries (artist_id, organisation_id);
create index financial_entries_created_by_idx             on public.financial_entries (created_by);

-- list default sort (occurred_on desc), keyset covering (Constraint 9). The
-- INCLUDE column is event_id, NOT owner_user_id -- there is no owner column.
create index financial_entries_org_occurred_id_idx
  on public.financial_entries (organisation_id, occurred_on, id)
  include (event_id) where deleted_at is null;

-- per-event summary aggregate covering (Task 2's event-finance panel sums
-- amount_minor per category/status for one event; this makes it an index-only
-- scan over the one event's live lines).
create index financial_entries_event_summary_idx
  on public.financial_entries (organisation_id, event_id)
  include (category, status, amount_minor) where deleted_at is null;

comment on index public.financial_entries_org_occurred_id_idx is
  'Covers the finance list''s default sort (occurred_on desc) and its keyset range, live rows only. INCLUDE is event_id, not owner_user_id: financial_entries has no owner column (finance scope is role-based), so the list''s rendered event column is what the index-only scan carries. lib/crm/finance-list.ts''s FINANCIAL_ENTRY_LIST.backedBy names this index.';

-- deleted/restore view sort (deleted_at desc), keyset covering, deleted rows
-- only. NOT IN THE BRIEF'S INDEX LIST -- a DELIBERATE ADDITION, stated here so
-- a reviewer does not read it as scope creep. FINANCIAL_ENTRY_DELETED_LIST
-- (lib/crm/finance-list.ts) is a listed Task 1 deliverable and its sort's
-- SortOption.backedBy is REQUIRED to name a real index (lib/list/spec.ts), so
-- the brief's index set (which omits a deleted-at index) and its deleted-list
-- deliverable are reconciled by adding this one. Mirrors events_org_deleted_
-- at_id_idx (20260901020000), with event_id as the INCLUDE column instead of
-- owner_user_id, for the reason the live index gives.
create index financial_entries_org_deleted_at_id_idx
  on public.financial_entries (organisation_id, deleted_at, id)
  include (event_id) where deleted_at is not null;

comment on index public.financial_entries_org_deleted_at_id_idx is
  'Covers FINANCIAL_ENTRY_DELETED_LIST''s sort (deleted_at desc) and keyset range, deleted rows only. Partial on deleted_at is not null; lib/list/query.ts''s scope: "deleted" writes that predicate, so no row this sort reaches has a NULL in it. Added beyond the brief''s index list to back the deleted-list deliverable honestly -- see the block comment above.';

-- ---------------------------------------------------------------------------
-- updated_at trigger, by hand (20260901000000 note (5)).
--
-- Named `set_updated_at` (rls_phase2_crm.sql L5 asserts exactly that name; L6
-- counts them -- 28 tables before this migration, 29 after). The `when` clause
-- is the verbatim one: a no-op UPDATE must not move the timestamp.
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.financial_entries;
create trigger set_updated_at before update on public.financial_entries
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.entity_org_unchanged() -- the `financial_entry` arm.
--
-- The financial_entries UPDATE policy (20260903003000) calls
-- entity_org_unchanged('financial_entry', id, organisation_id) in WITH CHECK,
-- pinning both organisation_id and id immutable through the client UPDATE --
-- closing the tenant-to-tenant transfer a user who is an admin of two
-- organisations could otherwise perform in one statement (20260828140500
-- IMP-3, measured: the composite FK constrains the NEW pair, not immutability).
--
-- The body below is the DEPLOYED one, read out of pg_get_functiondef() on the
-- live database (Constraint 1/13, per the events precedent) plus one arm --
-- NOT reconstructed from the migration source, because Phase 4 added eight
-- arms (task/meeting/note/document and their four link tables) after
-- 20260901011000. `create or replace function` is the additive form.
--
-- The arm is placed HERE rather than in the policy file so it ships in the
-- same migration as the table it names; the policy that calls it lands in
-- 20260903003000 and STILL works, because the arm exists by then.
-- ---------------------------------------------------------------------------
create or replace function private.entity_org_unchanged(
  p_entity_type text,
  p_id          uuid,
  p_org_id      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    -- The top-level entities.
    when 'company' then exists (
      select 1 from public.companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'contact' then exists (
      select 1 from public.contacts e where e.id = p_id and e.organisation_id = p_org_id)
    when 'agency' then exists (
      select 1 from public.agencies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist' then exists (
      select 1 from public.artists e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue' then exists (
      select 1 from public.venues e where e.id = p_id and e.organisation_id = p_org_id)
    when 'event' then exists (
      select 1 from public.events e where e.id = p_id and e.organisation_id = p_org_id)
    -- Organisation configuration.
    when 'custom_field_definition' then exists (
      select 1 from public.custom_field_definitions e where e.id = p_id and e.organisation_id = p_org_id)
    -- IMP-3: the child/join tables that carry an UPDATE policy. Named after
    -- the TABLE, not after a CRM entity type.
    when 'contact_company' then exists (
      select 1 from public.contact_companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_representation' then exists (
      select 1 from public.artist_representations e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_fee' then exists (
      select 1 from public.artist_fee_history e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue_room' then exists (
      select 1 from public.venue_rooms e where e.id = p_id and e.organisation_id = p_org_id)
    when 'custom_field_value' then exists (
      select 1 from public.custom_field_values e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 3 TASK 2, alongside event_lineup_update_via_event below.
    when 'event_lineup' then exists (
      select 1 from public.event_lineup e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 4 TASK 1: the four top-level operational entities (named after the
    -- entity) and the four link tables (named after the TABLE). Each carries an
    -- UPDATE policy in Task 2 that pins (id, organisation_id) through this
    -- guard. document_versions is absent on purpose -- dormant, no UPDATE.
    when 'task' then exists (
      select 1 from public.tasks e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting' then exists (
      select 1 from public.meetings e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note' then exists (
      select 1 from public.notes e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document' then exists (
      select 1 from public.documents e where e.id = p_id and e.organisation_id = p_org_id)
    when 'task_link' then exists (
      select 1 from public.task_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting_link' then exists (
      select 1 from public.meeting_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note_link' then exists (
      select 1 from public.note_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document_link' then exists (
      select 1 from public.document_links e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 5 TASK 1, alongside financial_entries_update_manage_finance in
    -- 20260903003000. financial_entries has no owner column, so this is the
    -- ONLY thing pinning its (id, organisation_id) against a two-org admin.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e where e.id = p_id and e.organisation_id = p_org_id)
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. TWENTY-TWO tables since Phase 5 Task 1: the six top-level entities, custom_field_definitions, the six child/join tables, the four operational entities and their four link tables, and public.financial_entries -- added by 20260903000000 alongside financial_entries_update_manage_finance which calls it. Fail-closed if p_id names no row.';

revoke all on function private.entity_org_unchanged(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_org_unchanged(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants and RLS.
--
-- The 20260827232507 default-privileges baseline means the table arrives with
-- an EMPTY ACL, so the revoke is belt-and-braces; written out anyway so a
-- reader knows the ACL without going to another file.
--
-- NO DELETE: soft delete is the only delete (CLAUDE.md § Non-negotiable rules).
--
-- RLS ON, POLICIES IN 20260903003000. The safe order "RLS on before access"
-- requires. See this file's header for the D4/D5/D11b interval it opens.
-- ---------------------------------------------------------------------------
revoke all on public.financial_entries from public, anon, authenticated, service_role;
grant select, insert, update on public.financial_entries to authenticated;
alter table public.financial_entries enable row level security;
