-- Phase 2 (Core CRM), Task 1 fix round 1: schema hardening.
--
-- The cross-tenant write is fixed separately, in 20260828001132. This migration
-- carries the rest of the review's schema-level findings: a stopgap on the
-- foreign-key-less event_id, a default for the record-scope column, soft delete
-- on the two tables that were missed, the is_primary decision the founder
-- delegated to this task, and one constraint rewritten for readability.
--
-- ===========================================================================
-- CORRECTIONS TO COMMENTS IN 20260827232510 AND 20260827232512
--
-- Two claims in those files were re-measured by the reviewer and are WRONG, in
-- the schema's favour. Migrations are additive-only and the hosted project is
-- linked, so those files cannot be edited -- the corrections live here, and a
-- reader working through the migrations in order meets them.
--
-- (1) 20260827232510, the trigram index block, claims the dedup query plans
--     with "organisation_id applied as a HEAP FILTER ... not as a bitmap AND
--     against contacts_organisation_id_idx".
--
--     NOT GENERALLY TRUE. That plan came from a fixture measured inside an
--     uncommitted transaction, where the GIN pending list is unflushed and the
--     statistics are stale. On a committed, VACUUM ANALYZEd fixture of the same
--     shape the planner chooses a BitmapAnd of BOTH indexes:
--
--       Bitmap Heap Scan on contacts
--         ->  BitmapAnd
--               ->  Bitmap Index Scan on contacts_organisation_id_idx
--               ->  Bitmap Index Scan on contacts_name_trgm_idx
--
--     The two RULES that comment draws are both still correct and both still
--     matter -- (i) a dedup query that omits the tenant filter reaches every
--     tenant's names, and (ii) omitting `deleted_at is null` makes the partial
--     index genuinely unusable, not merely unattractive (Seq Scan even with
--     enable_seqscan=off). Only the quoted plan was wrong.
--
--     THE TRANSFERABLE LESSON, since this is the second time it has bitten this
--     task: do not measure index plans inside an uncommitted transaction.
--
-- (2) 20260827232512, above custom_field_values' indexes, says no dedicated
--     index is needed because "the two indexes that already exist for other
--     reasons cover it between them", and cites a BitmapAnd.
--
--     The CONCLUSION is right, the REASON is wrong. Dropping
--     custom_field_values_organisation_id_idx changes the cascade timing not at
--     all (0.406ms vs 0.401ms). The leading `field_id` prefix of
--     custom_field_values_field_entity_unique does all the work; the second
--     bitmap is the planner adding something it does not need. So this is a
--     plain instance of the brief's "already the leading column of an existing
--     index" exemption, not a special case -- and the re-measure trigger that
--     comment states ("if the definition:value ratio changes materially") is
--     the wrong trigger. There is nothing here to re-measure.
--
-- (3) THE MOST DANGEROUS ONE. 20260827232510, in artist_fee_history's header,
--     instructs Phase 3 to add:
--
--       foreign key (event_id) references public.events (id) on delete set null
--
--     DO NOT APPLY THAT. It is a single-column foreign key, and applied as
--     written it re-creates in Phase 3 the exact cross-tenant defect that
--     20260828001132 just spent a migration closing: a fee row in org A naming
--     an event in org B. The correct form is
--
--       foreign key (event_id, organisation_id)
--         references public.events (id, organisation_id) on delete set null
--
--     which additionally requires public.events to carry
--     `unique (id, organisation_id)`. The same correction is made in
--     FOLLOW-UPS.md § "Phase 3 -- events", and it is repeated on the temporary
--     CHECK constraint below, because Phase 3 has to read that constraint's
--     comment in order to drop it -- which makes it the one place the
--     instruction cannot be missed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. artist_fee_history.event_id -- hold it NULL until Phase 3 can key it.
--
-- 20260827232510 left this column as an unvalidated uuid because public.events
-- does not exist yet, and documented that Phase 3 must add the foreign key.
-- Documentation is not enough, for a reason that only shows up at deploy time:
-- ADD CONSTRAINT ... FOREIGN KEY VALIDATES EVERY EXISTING ROW. One bad
-- event_id written by Task 4 or Task 6 in the meantime turns the Phase 3
-- migration into a failed deploy against the live hosted project -- precisely
-- the failure mode FOLLOW-UPS.md § "Gate: before the first `supabase db push`"
-- exists to prevent.
--
-- So the column is held NULL. This fails closed, costs nothing (no code writes
-- it yet -- Task 4 has not been built), and Phase 3 drops it in the same
-- migration that adds the real constraint.
--
-- Considered and rejected: dropping the column outright and letting Phase 3
-- add it. That loses the partial index and the documentation that lives on the
-- column, and gives Phase 3 two things to remember instead of one.
-- ---------------------------------------------------------------------------
alter table public.artist_fee_history
  add constraint artist_fee_history_event_id_unwritable_until_phase_3
  check (event_id is null);

comment on constraint artist_fee_history_event_id_unwritable_until_phase_3
  on public.artist_fee_history is
  'TEMPORARY, and Phase 3 must drop it. event_id cannot carry a foreign key until public.events exists, so rather than leave it an unvalidated uuid that accepts a nonexistent or cross-tenant event, it is held NULL. The reason this matters: ADD CONSTRAINT FOREIGN KEY validates existing rows, so any garbage written before Phase 3 would make the Phase 3 migration fail against the live hosted project. Drop this in the same migration that adds artist_fee_history_event_fkey -- which must be COMPOSITE, (event_id, organisation_id) -> events (id, organisation_id), or it re-opens the cross-tenant defect 20260828001132 just closed.';

-- ---------------------------------------------------------------------------
-- 2. owner_user_id defaults to the writing user.
--
-- The column is the record-scope mechanism (DECISIONS-QUEUE Q3, founder-
-- accepted): a Standard User sees rows where owner_user_id = auth.uid(). It
-- shipped nullable with no default, which made Task 4 the only thing standing
-- between a row and a permanently unowned state -- and an unowned row inserted
-- by a Standard User is a record they instantly cannot see.
--
-- auth.uid() as a DEFAULT is safe for every existing write path, which was
-- measured rather than assumed: it reads the request.jwt.claims GUC and returns
-- NULL, not an error, when that is unset. So `postgres` (migrations, seeds, the
-- test harness) and `service_role` both insert NULL exactly as they do today.
--
--   select auth.uid() is null;                     -- t, as postgres
--   create table t (owner_user_id uuid default auth.uid());
--   insert into t default values;                  -- owner_user_id is NULL
--
-- This is a floor, not the enforcement. Task 2's WITH CHECK for the scoped
-- roles should still require owner_user_id = (select auth.uid()) on insert --
-- a default is overridable by an explicit value, and "the client did not send
-- the column" is not the same statement as "the client may not set it".
-- ---------------------------------------------------------------------------
alter table public.companies alter column owner_user_id set default auth.uid();
alter table public.contacts  alter column owner_user_id set default auth.uid();
alter table public.agencies  alter column owner_user_id set default auth.uid();
alter table public.artists   alter column owner_user_id set default auth.uid();
alter table public.venues    alter column owner_user_id set default auth.uid();

-- ---------------------------------------------------------------------------
-- 3. Soft delete on the two operational tables that were missed.
--
-- 20260827232510 added deleted_at to agencies and venue_rooms beyond the plan,
-- reasoning from CLAUDE.md § Non-negotiable rules ("soft-delete operational
-- records rather than hard deletion"), and then did not apply that reasoning to
-- the two tables the argument fits best:
--
--   artist_fee_history      holds money. CLAUDE.md § Non-negotiable rules sets
--                           a 7-year retention default for financial records;
--                           it is the Phase 2 table closest to that class, and
--                           it was the only one with no soft-delete marker.
--   artist_representations  IS the representation history that the agencies
--                           deleted_at argument was made to protect. Protecting
--                           the history from the agency's deletion while
--                           leaving the history itself hard-deletable is half
--                           a control.
--
-- Both normally disappear by cascade from a soft-deleted parent, so the
-- exposure this closes is a direct DELETE against the child. That is a real
-- path: it is what "remove this fee line" and "remove this representation" are
-- in the UI Task 4 will build.
-- ---------------------------------------------------------------------------
alter table public.artist_fee_history     add column deleted_at timestamptz;
alter table public.artist_representations add column deleted_at timestamptz;

comment on column public.artist_fee_history.deleted_at is
  'Soft-delete marker. Added in fix round 1: this is the Phase 2 table holding money, and so the one closest to CLAUDE.md''s 7-year financial retention default. Task 2''s policies must exclude soft-deleted rows and Task 4 must delete by setting this, never by DELETE.';
comment on column public.artist_representations.deleted_at is
  'Soft-delete marker. Added in fix round 1 for consistency with agencies.deleted_at -- that column exists to stop an agency deletion destroying representation history, which is incomplete while the history itself can be hard-deleted directly.';

-- ---------------------------------------------------------------------------
-- 4. is_primary -- the decision DECISIONS-QUEUE Q4 delegated to this task.
--
-- Q4 is marked ANSWERED, "Task 1's schema-side recommendation governs". Task 1
-- recommended partial unique indexes and then deferred them to FOLLOW-UPS,
-- which leaves an answered decision unimplemented. The recommendation was to
-- add them, so they are added; both tables are empty, so it is free now and
-- would not be later.
--
-- THE COST, which Task 4 inherits and must design for: a partial unique index
-- cannot be deferred. "Make company B the primary" is therefore two statements
-- in one transaction -- clear the old primary, then set the new one -- not one
-- UPDATE. That was the reason for deferring; it is a real constraint on the
-- write path and it is worth paying for a schema that cannot represent "three
-- primary employers".
--
-- THE TWO INDEXES ARE NOT THE SAME SHAPE, and the difference is the point.
--
--   contact_companies: `where is_primary`. A contact's primary company is a
--   fact about now, and the link row is deleted when it stops being true.
--
--   artist_representations: `where is_primary and ended_at is null and
--   deleted_at is null`, i.e. at most one CURRENT primary. The naive form
--   would be a bug: an artist whose primary agency was X from 2020-2023 and is
--   Y from 2024 has two rows that were each primary at the time, and forbidding
--   that would make the table unable to record ordinary industry history. This
--   table has ended_at precisely because it keeps history; the constraint has
--   to respect it.
--
-- Q4's text is specifically about contact_companies. The representation index
-- is this task's own extension of the same reasoning, in the temporal form.
-- ---------------------------------------------------------------------------
create unique index contact_companies_one_primary_per_contact
  on public.contact_companies (contact_id)
  where is_primary;

create unique index artist_representations_one_current_primary_per_artist
  on public.artist_representations (artist_id)
  where is_primary and ended_at is null and deleted_at is null;

comment on index public.contact_companies_one_primary_per_contact is
  'At most one primary company per contact (DECISIONS-QUEUE Q4, delegated to Task 1). Partial unique indexes cannot be deferred, so Task 4 must clear the existing primary before setting a new one -- two statements in one transaction, not one UPDATE.';
comment on index public.artist_representations_one_current_primary_per_artist is
  'At most one CURRENT primary representation per artist. Scoped to ended_at is null deliberately: an artist can legitimately have had a different primary agency in an earlier period, and a naive unique index would make that history unrecordable.';

-- ---------------------------------------------------------------------------
-- 5. Constraint readability.
--
-- venues_capacity_check shipped as `(capacity is null or capacity >= 0)`. The
-- null branch is dead: a CHECK evaluating to NULL passes, so `capacity >= 0`
-- already admits NULL -- which is how artist_fee_history_amount_minor_check is
-- written on its NOT NULL column.
--
-- Cosmetic on its own. It matters because the identical `is null or` prefix in
-- artist_representations_period_ordered IS load-bearing (both columns are
-- nullable and the comparison must be skipped, not merely tolerated), and with
-- one redundant instance in the schema a reader cannot tell which is which.
-- Normalising the redundant one and commenting the deliberate one makes the
-- register readable in both directions.
-- ---------------------------------------------------------------------------
alter table public.venues drop constraint venues_capacity_check;
alter table public.venues add constraint venues_capacity_check check (capacity >= 0);

comment on constraint venues_capacity_check on public.venues is
  'NULL capacity passes, because a CHECK that evaluates to NULL passes -- no explicit `capacity is null or` branch is needed and it was removed as noise.';

comment on constraint artist_representations_period_ordered on public.artist_representations is
  'The `is null or` prefixes here ARE load-bearing, unlike the one removed from venues_capacity_check: both columns are nullable, an open-ended or undated representation is normal, and the ordering comparison must be skipped rather than merely tolerated when either end is absent.';
