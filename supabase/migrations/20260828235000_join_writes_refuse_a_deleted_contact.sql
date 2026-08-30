-- Phase 2 (Core CRM), Task 4 fix round 2: put the "a deleted record's links
-- cannot be changed" rule behind the database, on the CONTACT end.
--
-- Additive only. Three `alter policy` statements, no existing migration
-- edited, and no new policy created (`create or replace policy` does not
-- exist in Postgres -- 42601). The bodies below are 20260828140500's, verbatim,
-- with ONE new conjunct: `p.deleted_at is null`.
--
-- ===========================================================================
-- WHAT WAS WRONG WITH THE REASON, NOT WITH THE BEHAVIOUR
-- ===========================================================================
-- Fix round 1 added `liveInOrg()` to lib/crm/contacts.ts and stopped the three
-- join actions writing the links of a soft-deleted record. It then argued the
-- database could not back that rule:
--
--     "`deleted_at` is deliberately absent from every RLS policy -- design
--      note (g), asserted at S13: RLS must not hide a soft-deleted row,
--      because restore has to read it. So the application is the only control
--      for this one rule."
--
-- Design note (g) is about SELECT ON THE RECORD BEING RESTORED. The rule this
-- migration needs is INSERT/UPDATE/DELETE ON contact_companies -- a different
-- table and a different verb. Restoring a contact writes `contacts.deleted_at`
-- and does not touch `contact_companies` at all, so nothing about restore
-- needs the join to be writable while an end is deleted. The re-review added
-- the predicate and ran the whole suite: the ONLY assertion that changed was
-- S28, which exists to record the absence. Nothing in 534 depends on it.
--
-- CLAUDE.md § Permissions: "hiding UI is not enforcement". The application
-- check stays -- it is what turns a silent 0-row PATCH into a sentence a user
-- can act on -- but it is no longer the only thing standing there. A member
-- with 'manage_contacts' and the anon key, going round the Server Action
-- straight to PostgREST, is now refused by the policy.
--
-- ===========================================================================
-- THE CONTACT END ONLY. THE COMPANY END STAYS APPLICATION-ONLY.
-- ===========================================================================
-- The product rule lib/crm/contacts.ts states is BOTH ENDS LIVE. This
-- migration enforces exactly HALF of it, and the half it leaves out is left
-- out on purpose:
--
--   * The three `*_via_contact` policies reach EXISTS against `contacts`
--     alone. That is the Q5 adjudication from Task 1 and 20260828121000's
--     header records its consequence: a record-scoped user who owns the
--     contact may link it to a company they cannot see. It is an accepted
--     company-existence oracle, and it is what makes the legitimate case work.
--
--   * A `companies.deleted_at is null` term would require the policy to READ
--     THE COMPANY ROW. For a record-scoped caller who does not own that
--     company, `companies_select_*` returns nothing -- but a policy predicate
--     is evaluated as the caller, so "the company is deleted" and "I cannot
--     see the company" would produce the same refusal. That breaks the Q5
--     case the schema deliberately permits, and it does it silently: the
--     Standard User's link write would start failing on companies that are
--     perfectly live.
--
-- So: the CONTACT's `deleted_at` is enforced here, and the COMPANY's
-- `deleted_at` is enforced only by lib/crm/contacts.ts (`liveInOrg`). That
-- asymmetry is measured rather than assumed -- supabase/tests/rls_phase2_crm.sql
-- S28 asserts the database now REFUSES a link write on a deleted contact, and
-- S28b asserts it still PERMITS one whose only deleted end is the company.
-- Anyone tempted to "finish the job" by adding the company term should read
-- S28b's comment first.
--
-- ===========================================================================
-- TASK 4b
-- ===========================================================================
-- `artist_representations_*_via_artist` has the same shape and will want the
-- same conjunct on `artists.deleted_at` -- and the same restraint about the
-- agency/contact ends, for the same Q3a reason.

-- INSERT. WITH CHECK only; a refused insert is a loud 403.
alter policy "contact_companies_insert_via_contact" on public.contact_companies
  with check (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- UPDATE. The conjunct goes in BOTH halves: USING sees the OLD contact_id and
-- WITH CHECK the NEW one, so without it in USING a link could still be moved
-- OFF a deleted contact, and without it in WITH CHECK a link could be moved
-- ON to one.
alter policy "contact_companies_update_via_contact" on public.contact_companies
  using (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('contact_company', contact_companies.id, contact_companies.organisation_id)
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- DELETE. No WITH CHECK exists on a DELETE policy, so the entitlement term and
-- this one both live in USING -- and an unentitled delete stays a silent
-- zero-row result rather than a 403. See 20260828140500's header.
alter policy "contact_companies_delete_via_contact" on public.contact_companies
  using (
    contact_companies.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- SELECT IS UNTOUCHED, and that is the whole of design note (g). A deleted
-- contact's links stay readable: the detail route renders them next to the
-- "Deleted" notice so a user can see what restoring would bring back, and the
-- restore queue reads the record itself. Only the three WRITE verbs changed.

comment on policy "contact_companies_update_via_contact" on public.contact_companies is
  'Scoped by the CONTACT (Q5), which must be LIVE: `p.deleted_at is null` in both USING and WITH CHECK, so a soft-deleted contact''s links cannot be repointed either off it or on to it. The COMPANY end is deliberately not checked here -- a companies.deleted_at term would have to read a row a record-scoped caller may not see, and would collapse "deleted" into "invisible", breaking the Q5 case where a Standard User links their own contact to a company they do not own. The company''s deleted_at is checked by lib/crm/contacts.ts (liveInOrg) only. Measured at S28 / S28b in supabase/tests/rls_phase2_crm.sql.';

-- set_contact_primary_company() gets the rule for free: it is SECURITY
-- INVOKER, so both of its statements are decided by the policy above. Its own
-- header says the soft-delete half "has no counterpart in the database at
-- all" -- that sentence was true when it was written and is now false for the
-- contact end. 20260828234500 is not edited (additive only); the comment on
-- the function is replaced here instead, which is where a reader looks.
comment on function public.set_contact_primary_company(uuid, uuid, uuid) is
  'Sets (or, with a null company, clears) a contact''s primary company as ONE transaction, within ONE organisation. Required, not convenience: contact_companies_one_primary_per_contact is a partial unique index and cannot be deferred, and a single UPDATE that demotes one row and promotes another is checked per row, so it succeeds or raises 23505 depending on physical row order -- measured both ways on the same two rows. p_organisation_id is MANDATORY and is not redundant with RLS: RLS answers "may this caller write this row", the organisation term answers "is this row the one this URL is about", and a multi-org member is where those diverge (the 2-arg version let a member of two workspaces promote a company on the other workspace''s contact from this one''s URL). SECURITY INVOKER: it adds no privilege, and every refusal the RLS policies make against a direct PATCH they make against this -- INCLUDING, as of 20260828235000, the refusal to write the links of a SOFT-DELETED contact, which is now a policy term (contact_companies_update_via_contact) and no longer application-only. The COMPANY end''s deleted_at remains application-only, by Q5 -- see that migration. Returns the number of rows promoted (0 only when clearing). Task 4b copies this shape for artist_representations -- copy the organisation term with it.';
