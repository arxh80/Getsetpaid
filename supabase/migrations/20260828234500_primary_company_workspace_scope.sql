-- Phase 2 (Core CRM), Task 4 fix round 1: give the primary-company RPC the
-- workspace term every other write in the task already carries.
--
-- Additive only. `create or replace function` for the new signature, then a
-- `revoke` and a `drop` for the old one. No existing migration is edited, and
-- nothing here needs a policy (`create or replace policy` does not exist in
-- Postgres -- 42601): 20260828121000's policies already decide every statement
-- below, and the function stays SECURITY INVOKER so they keep deciding it.
--
-- ===========================================================================
-- WHAT WAS WRONG, AND HOW IT WAS MEASURED
-- ===========================================================================
-- `public.set_contact_primary_company(uuid, uuid)` took a contact and a
-- company and applied NO tenant predicate. Every sibling write in
-- lib/crm/contacts.ts carries `.eq("organisation_id", org.id)` and says why:
--
--     multi-org membership ships at MVP, so RLS alone would permit an id from
--     the caller's OTHER workspace to be edited from this one's URL.
--
-- That is exactly what happened here. `contact_companies_update_via_contact`
-- asks whether the CALLER may write the row, not whether the row belongs to
-- the workspace whose URL the request came from -- and for a user who is a
-- member of two organisations both answers are yes. Reproduced in the Task 4
-- review as `pmulti` (admin in org-alpha AND org-beta), acting from
-- org-alpha's URL:
--
--     rows_promoted  1
--     Beta Contact | Beta Co | is_primary = t
--
-- The courtesy gate ran against org-alpha and the write landed in org-beta;
-- `revalidatePath` then invalidated the page that had not changed. Not a
-- tenant breakout -- everything aimed across a real boundary was refused with
-- 42501 -- but a workspace boundary the rest of the application enforces and
-- this one statement did not.
--
-- ===========================================================================
-- THE ORGANISATION TERM IS MANDATORY, AND TASK 4b MUST NOT COPY IT OUT
-- ===========================================================================
-- Task 4b writes the same function for `artist_representations.is_primary`.
-- Copy the demote/promote ORDER, the raise-rather-than-return-0 rule, AND
-- `p_organisation_id` on BOTH statements. RLS is not a substitute for it: RLS
-- answers "may this caller write this row", and the workspace term answers
-- "is this row the one this URL is about". Those are different questions and
-- a multi-org member is where they diverge.
--
-- The parameter is trusted only as far as the caller is: it comes from
-- `getCurrentOrg()`, which is RLS-gated, so a slug the caller cannot see
-- resolves to null and never reaches here. Passing someone else's
-- organisation id narrows the statement to zero rows -- it cannot widen it,
-- because RLS is still underneath. CLAUDE.md § Tenancy model is satisfied by
-- the resolution step, not by this function.
create or replace function public.set_contact_primary_company(
  p_contact_id uuid,
  p_company_id uuid,
  p_organisation_id uuid
)
returns integer
language plpgsql
as $$
declare
  v_promoted integer := 0;
  v_demoted  integer := 0;
begin
  -- DEMOTE FIRST, ALWAYS. The reverse order raises 23505 against the
  -- non-deferrable partial unique index -- 20260828230000's header carries the
  -- measurement, and S1/S2/S3 in the RLS suite pin it.
  --
  -- `is distinct from` rather than `<>` so a null p_company_id -- "this
  -- contact has no primary company" -- demotes everything and promotes
  -- nothing. Re-nominating the company that is ALREADY primary is a no-op that
  -- still reports 1, because from the caller's side the write applied: the
  -- state they asked for is the state that holds.
  update public.contact_companies
     set is_primary = false
   where organisation_id = p_organisation_id
     and contact_id = p_contact_id
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
    -- REACHABLE BY A RACE AS WELL AS BY A REFUSAL, which the first version of
    -- this comment denied ("the UI only offers the control when a primary is
    -- set, so that case is unreachable from the product"). Measured in the
    -- Task 4 review with two overlapping transactions, one promoting and one
    -- clearing: under READ COMMITTED the clear's row re-check fails against
    -- the row the promoter just demoted, and the row it just promoted was not
    -- in this statement's scan -- so v_demoted is 0 and the caller is told
    -- "no primary company to clear" at a moment when one demonstrably exists.
    -- The transaction still rolls back whole, which is the property that
    -- matters; the message is the part that is wrong, and lib/crm/contacts.ts
    -- carries the honest one for the 23505 half of the same race.
    if v_demoted = 0 then
      raise exception
        'no primary company to clear, or contact_companies not writable by this caller'
        using errcode = '42501';
    end if;
    return 0;
  end if;

  update public.contact_companies
     set is_primary = true
   where organisation_id = p_organisation_id
     and contact_id = p_contact_id
     and company_id = p_company_id;
  get diagnostics v_promoted = row_count;

  -- ZERO ROWS PROMOTED MUST NOT COMMIT THE DEMOTION. Otherwise the one thing
  -- this function exists to prevent -- a contact left with no primary because
  -- half the operation applied -- is reachable through an ordinary refusal.
  -- Raising rolls the demotion back with it.
  --
  -- 42501 (insufficient_privilege) rather than a bespoke code, for two
  -- reasons. PostgREST maps it to 403, which is what the caller needs to see,
  -- and it does not distinguish "the policy refused you" from "no such link"
  -- and now also from "wrong workspace" -- which it must not, because from
  -- outside the tenant those are the same fact and telling them apart is an
  -- existence oracle for another organisation's rows.
  if v_promoted = 0 then
    raise exception
      'contact_companies row not writable by this caller in this workspace'
      using errcode = '42501';
  end if;

  -- The count, not a boolean and not void. The caller has to be able to tell
  -- an applied write from an accepted no-op, and every other mutating path in
  -- this application does that by reading a row count (lib/crm/write.ts).
  return v_promoted;
end;
$$;

comment on function public.set_contact_primary_company(uuid, uuid, uuid) is
  'Sets (or, with a null company, clears) a contact''s primary company as ONE transaction, within ONE organisation. Required, not convenience: contact_companies_one_primary_per_contact is a partial unique index and cannot be deferred, and a single UPDATE that demotes one row and promotes another is checked per row, so it succeeds or raises 23505 depending on physical row order -- measured both ways on the same two rows. p_organisation_id is MANDATORY and is not redundant with RLS: RLS answers "may this caller write this row", the organisation term answers "is this row the one this URL is about", and a multi-org member is where those diverge (the 2-arg version let a member of two workspaces promote a company on the other workspace''s contact from this one''s URL). SECURITY INVOKER: it adds no privilege, and every refusal the RLS policies make against a direct PATCH they make against this. Returns the number of rows promoted (0 only when clearing). Task 4b copies this shape for artist_representations -- copy the organisation term with it.';

grant execute on function public.set_contact_primary_company(uuid, uuid, uuid) to authenticated;

-- ===========================================================================
-- THE 2-ARG VERSION GOES, RATHER THAN STAYING AS A REACHABLE OVERLOAD
-- ===========================================================================
-- Leaving it granted would leave the defect reachable: PostgREST resolves an
-- RPC by the argument names in the request body, so a caller who simply omits
-- `p_organisation_id` gets the old, unscoped function back. A `revoke` alone
-- would do, and the drop is better -- an overload that exists is an overload
-- somebody copies. Nothing else references it: lib/crm/contacts.ts is the only
-- caller and passes three arguments now, and supabase/tests/rls_phase2_crm.sql
-- is updated in the same commit.
revoke execute on function public.set_contact_primary_company(uuid, uuid) from authenticated;
drop function public.set_contact_primary_company(uuid, uuid);
