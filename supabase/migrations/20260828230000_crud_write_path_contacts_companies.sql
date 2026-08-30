-- Phase 2 (Core CRM), Task 4: the write path for contacts and companies.
--
-- Three things, in the order they were decided:
--
--   1. The `is_primary` decision (DECISIONS-QUEUE Q4, routed here).
--   2. The list indexes the companies list needs, on the rule FOLLOW-UPS.md
--      states for every list Task 4 and 4b ship.
--   3. The indexes the "deleted" views need, which is the half of soft-delete
--      the schema had no ordering for.
--
-- Additive only. No existing migration is edited; `create or replace function`
-- and new indexes only. (`create or replace policy` does not exist in
-- Postgres -- 42601 -- and nothing here needs a policy: the twelve tables'
-- policies from 20260828121000 already cover every statement below, and the
-- function is SECURITY INVOKER precisely so they keep covering it.)

-- ===========================================================================
-- 1. is_primary: the write path, and why the schema half was already right
-- ===========================================================================
-- Q4 was routed to this task as an open question -- "nothing enforces
-- at-most-one per contact". That was true when it was written and is not true
-- now: `contact_companies_one_primary_per_contact` and
-- `artist_representations_one_current_primary_per_artist` shipped in Task 1's
-- fix round (20260828001134 § 4). Verified against this database before
-- anything below was written:
--
--   CREATE UNIQUE INDEX contact_companies_one_primary_per_contact
--     ON public.contact_companies USING btree (contact_id) WHERE is_primary
--
-- So the decision left to make is not "index or no index". It is what the
-- write path does about an index that CANNOT BE DEFERRED, and the answer is
-- this function.
--
-- THE MEASUREMENT THAT DECIDED IT. The obvious way to avoid two statements is
-- to write one:
--
--     update contact_companies set is_primary = (company_id = $new)
--      where contact_id = $contact;
--
-- The final state of that statement is legal, so it is tempting to believe
-- Postgres accepts it. Run on this database against two link rows, A primary
-- and B not:
--
--     demote A / promote B, one statement   SUCCEEDED
--     demote B / promote A, one statement   FAILED  23505
--                 duplicate key value violates unique constraint
--                 "contact_companies_one_primary_per_contact"
--
-- Same two rows, same shape of statement, opposite outcomes, reproduced on
-- three consecutive runs. A unique index is checked as each row version is
-- inserted, not at end of statement, so whether the statement survives depends
-- on the order the executor happens to visit the rows in -- which changed
-- between the two calls because the first one rewrote both rows. That is a
-- defect that works in every fixture and raises in production on a row that
-- happened to be updated before.
--
-- So the operation is genuinely two statements, and they have to be in one
-- transaction, and supabase-js issues one HTTP request per statement. A
-- function is the only place the transaction can be.
--
-- WHAT THIS IS NOT:
--
--   NOT a trigger. A trigger that demotes the others on promote is the third
--   option Q4 listed, and it is logic in a place no reader of the write path
--   looks. It also makes an ordinary bulk insert silently rewrite rows the
--   caller did not name, which is worse than an error.
--
--   NOT "no index, enforce in the write path". That option requires an answer
--   to "what does a read do when it finds two primaries", and there is no good
--   one -- every consumer, including Task 6's merge and Task 4b's artist
--   representations, would have to carry a tie-break rule forever.
--
-- SECURITY INVOKER, AND THAT IS THE WHOLE SECURITY ARGUMENT. This function
-- adds no privilege: both statements run as the caller, under
-- contact_companies_update_via_contact, which requires 'manage_contacts' on
-- the contact's organisation, record scope over the parent contact, and -- on
-- the WITH CHECK side -- private.crm_write_organisations(). A read-only role,
-- a Free-tier organisation and a suspended workspace are all refused here
-- exactly as they are refused by a direct PATCH, and for the same reason. It
-- is a transaction boundary, not a privilege boundary.
--
-- No `set search_path` and no `security definer`: SECURITY.md § 2 requires a
-- pinned search_path for SECURITY DEFINER functions specifically, because
-- those run with the definer's rights. This one runs with the caller's, and
-- every object it names is schema-qualified anyway.
create or replace function public.set_contact_primary_company(
  p_contact_id uuid,
  p_company_id uuid
)
returns integer
language plpgsql
as $$
declare
  v_promoted integer := 0;
  v_demoted  integer := 0;
begin
  -- DEMOTE FIRST, ALWAYS. The reverse order raises 23505 against the
  -- non-deferrable index, and the measurement above is what says so.
  --
  -- `is distinct from` rather than `<>` so a null p_company_id -- "this
  -- contact has no primary company" -- demotes everything and promotes
  -- nothing. Re-nominating the company that is ALREADY primary is a no-op
  -- that still reports 1, because from the caller's side the write applied:
  -- the state they asked for is the state that holds.
  update public.contact_companies
     set is_primary = false
   where contact_id = p_contact_id
     and is_primary
     and (p_company_id is null or company_id is distinct from p_company_id);
  get diagnostics v_demoted = row_count;

  if p_company_id is null then
    -- CLEARING. Zero rows demoted has to be an error, and this is the one
    -- decision in this function that costs the caller something.
    --
    -- With no promote to follow it, the count of an accepted no-op and the
    -- count of a refusal are both 0 -- the exact shape lib/crm/write.ts exists
    -- to stop the application misreading. Nothing inside this function can
    -- tell them apart either: "the policy matched no rows" and "there was no
    -- primary to clear" are the same row count, and asking a second question
    -- to distinguish them would be asking whether a row the caller may not
    -- write exists, which is the oracle this schema is careful not to build.
    --
    -- So it raises, and the cost is that clearing a primary that is already
    -- clear reports a failure. The UI only offers the control when a primary
    -- is set, so that case is unreachable from the product -- and of the two
    -- ways to be wrong, "said it failed when nothing needed doing" is the one
    -- that does not lose a customer's edit.
    if v_demoted = 0 then
      raise exception
        'no primary company to clear, or contact_companies not writable by this caller'
        using errcode = '42501';
    end if;
    return 0;
  end if;

  if p_company_id is not null then
    update public.contact_companies
       set is_primary = true
     where contact_id = p_contact_id
       and company_id = p_company_id;
    get diagnostics v_promoted = row_count;

    -- ZERO ROWS PROMOTED MUST NOT COMMIT THE DEMOTION. Otherwise the one
    -- thing this function exists to prevent -- a contact left with no primary
    -- because half the operation applied -- is reachable through an ordinary
    -- refusal. Raising rolls the demotion back with it.
    --
    -- 42501 (insufficient_privilege) rather than a bespoke code, for two
    -- reasons. PostgREST maps it to 403, which is what the caller needs to
    -- see, and it does not distinguish "the policy refused you" from "no such
    -- link" -- which it must not, because from outside the tenant those are
    -- the same fact and telling them apart is an existence oracle for another
    -- organisation's rows.
    if v_promoted = 0 then
      raise exception
        'contact_companies row not writable by this caller'
        using errcode = '42501';
    end if;
  end if;

  -- The count, not a boolean and not void. The caller has to be able to tell
  -- an applied write from an accepted no-op, and every other mutating path in
  -- this application does that by reading a row count (see
  -- lib/crm/write.ts). Returning something else here would make this the one
  -- save path that cannot.
  return v_promoted;
end;
$$;

comment on function public.set_contact_primary_company(uuid, uuid) is
  'Sets (or, with a null company, clears) a contact''s primary company as ONE transaction. Required, not convenience: contact_companies_one_primary_per_contact is a partial unique index and cannot be deferred, and a single UPDATE that demotes one row and promotes another is checked per row, so it succeeds or raises 23505 depending on physical row order -- measured both ways on the same two rows. SECURITY INVOKER: it adds no privilege, and every refusal the RLS policies make against a direct PATCH they make against this. Returns the number of rows promoted (0 only when clearing).';

grant execute on function public.set_contact_primary_company(uuid, uuid) to authenticated;

-- The column comment still described this as an open question naming Task 4.
-- It is answered; `comment on` is additive, so the answer replaces it here
-- rather than by editing 20260827232510.
comment on column public.contact_companies.is_primary is
  'The contact''s main company affiliation. At-most-one per contact IS enforced, by the partial unique index contact_companies_one_primary_per_contact (20260828001134). Because a partial unique index cannot be deferred, change it through public.set_contact_primary_company(), which demotes then promotes inside one transaction -- a single UPDATE doing both is order-dependent and raises 23505 roughly half the time. Task 4 decision; artist_representations.is_primary takes the same answer.';

comment on column public.artist_representations.is_primary is
  'The artist''s main representation. At-most-one CURRENT per artist is enforced by artist_representations_one_current_primary_per_artist (partial: is_primary and ended_at is null and deleted_at is null). Task 4b writes the equivalent of set_contact_primary_company() for this table -- demote then promote in one transaction -- for the reason recorded on contact_companies.is_primary. Note the index''s predicate: the demote half must be scoped to `ended_at is null` too, or changing the primary rewrites history.';

-- ===========================================================================
-- 2. The companies list indexes
-- ===========================================================================
-- FOLLOW-UPS.md § "Opened by Task 3": a column may be in a list's sort
-- allowlist only if it is NOT NULL and has an index of this exact shape. The
-- rule is enforced in TypeScript by `backedBy` being a required field on every
-- sort option, which means this file is where those names have to become real.
--
-- Shape copied verbatim from 20260828180000's contacts pair, including
-- `include (owner_user_id)` (the RLS record-scope term reads that column, and
-- without it a Standard User's page costs a heap fetch per candidate row) and
-- the partial predicate (the list always writes `deleted_at is null`, so the
-- partial index is both smaller and the only one the plan can use).
--
-- Ascending only: organisation_id is pinned by equality and a btree scans
-- backwards, so one index serves both directions.
create index companies_org_name_id_live_idx
  on public.companies (organisation_id, name, id)
  include (owner_user_id)
  where deleted_at is null;

create index companies_org_updated_at_id_live_idx
  on public.companies (organisation_id, updated_at, id)
  include (owner_user_id)
  where deleted_at is null;

comment on index public.companies_org_name_id_live_idx is
  'Keyset pagination for the companies list, name sort. Mirrors contacts_org_name_id_live_idx; see 20260828180000 for the measurements behind the shape. lib/crm/companies-list.ts names this index in `backedBy` and the sort is not allowed to exist without it.';
comment on index public.companies_org_updated_at_id_live_idx is
  'Keyset pagination for the companies list, updated sort. updated_at is maintained by the trigger in 20260828121500 and is not client-writable, which is what makes it safe to order by.';

-- ===========================================================================
-- 3. The deleted views
-- ===========================================================================
-- CLAUDE.md § Non-negotiable rules requires soft delete, and a soft delete
-- nobody can undo is a hard delete with extra steps. Restore therefore needs a
-- way to REACH a deleted record, and this task ships it as a separate route
-- per entity (/contacts/deleted) rather than as a filter on the main list.
--
-- The reason is not layout. `lib/list/query.ts`'s `.is("deleted_at", null)` is
-- one of four clauses that file calls non-negotiable, with the partial indexes
-- above as half the argument -- a list that can be talked out of it by a query
-- parameter is a list whose most important clause is optional. A separate
-- route asks for `deleted_at is not null` explicitly, and the count line on
-- the live list stays a true statement about live records.
--
-- ONE SORT, deliberately: most recently deleted first is the only ordering a
-- restore queue is ever read in, and every sort in the allowlist costs an
-- index. So one index per entity, on deleted_at.
--
-- `notNull` on that sort option is true WITHIN this index's predicate rather
-- than of the column, which is the one place the spec's field is weaker than
-- it looks -- said out loud here and in lib/crm/*-list.ts because keyset
-- pagination over a nullable column silently drops a band of rows, and the
-- next person to reuse this shape needs to know the predicate is carrying it.
create index contacts_org_deleted_at_id_idx
  on public.contacts (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

create index companies_org_deleted_at_id_idx
  on public.companies (organisation_id, deleted_at, id)
  include (owner_user_id)
  where deleted_at is not null;

comment on index public.contacts_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-contacts (restore) view, which is a separate route from the list. The partial predicate is what makes deleted_at NOT NULL for every row this index covers -- the sort option''s `notNull: true` is true of the indexed set, not of the column.';
comment on index public.companies_org_deleted_at_id_idx is
  'Keyset pagination for the deleted-companies (restore) view. See contacts_org_deleted_at_id_idx.';
