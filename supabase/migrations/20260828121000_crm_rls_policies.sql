-- Phase 2 (Core CRM), Task 2c: RLS policies and table privileges for the
-- twelve Phase 2 tables.
--
-- Task 1 shipped all twelve with RLS enabled, zero policies and an empty ACL,
-- which denies everything to every client role by two independent controls.
-- This migration opens exactly the intended holes and nothing else.
--
-- Depends on:
--   20260827232510 / 20260827232512  the tables
--   20260828001132 / 20260828001134  the tenant-scoped composite FKs, which
--                                    several policies below rely on and which
--                                    are named where they do
--   20260828120000                   the six permission keys
--   20260828120500                   the five policy helpers
--
-- ===========================================================================
-- Design notes -- read before changing anything in this file
-- ===========================================================================
--
-- (a) THE SCOPE PREDICATE, WRITTEN ONCE HERE AND REPEATED EVERYWHERE BELOW.
--
--       <org column> in (select private.permitted_organisations('<key>'))
--       and (
--         <org column> in (select private.full_scope_organisations())
--         or <owner column> = (select auth.uid())
--       )
--
--     First line: authorisation. Second: record scope (DECISIONS-QUEUE Q3 --
--     Standard User and Read Only see only rows they own, everyone else sees
--     the organisation). The MFA/aal2 gate rides in on the first line, because
--     permitted_organisations() carries it.
--
--     IT IS INLINE, NOT BEHIND A `private.record_in_scope(org, owner)` HELPER,
--     AND THAT IS DELIBERATE. The helper version was written first and
--     measured: a boolean function taking a COLUMN is evaluated once per row
--     and nothing hoists it, which cost 5210 ms to render a fifty-row page of
--     a 50,000-contact organisation. The three-subquery form above takes
--     constants, so the planner turns each into a hashed SubPlan evaluated once
--     per statement, and the same page takes 23 ms. 20260828120500's header
--     carries the plans. The repetition is the price of that, and it is paid on
--     purpose; the behavioural tests in rls_phase2_crm.sql § D are what keep
--     the twelve copies saying the same thing.
--
-- (b) CHILD TABLES NAME THEIR PARENT INLINE, WHICH FOUNDATION'S RULE FORBIDS.
--     20260826154304 design note (h) says "No policy expression here names a
--     table inline; every table access is behind a function call." That rule
--     exists to prevent RLS self-recursion (42P17), and it is right for the
--     tables it was written about -- a policy on organisation_memberships that
--     sub-queries organisation_memberships.
--
--     venue_rooms -> venues, contact_companies -> contacts,
--     artist_representations -> artists and artist_fee_history -> artists are
--     all acyclic: no policy on venues names venue_rooms, and so on for each.
--     Naming the parent inline is what lets the planner hoist the two set
--     subqueries out of the EXISTS and turn the whole thing into a hashed
--     SubPlan (measured: a 50,000-row venue_rooms page went 12830 ms -> 19.6 ms
--     against the equivalent helper-function form). A SECURITY DEFINER helper
--     cannot be inlined by the planner, so behind a function call this is
--     structurally per-row.
--
--     TWO CONSEQUENCES OF INLINING, both intended, both worth knowing:
--       1. The subquery runs as the CALLER, so the parent's own RLS applies to
--          it as well. "You can reach the child only through a parent you can
--          see" therefore holds even before the predicate below is read -- the
--          parent's SELECT policy is a second, independent gate on every child
--          row. That is the property Task 1's report asked for in words.
--       2. It requires `authenticated` to hold SELECT on the parent, which it
--          does (section 5).
--     THE RULE THIS IMPLIES: an inline parent reference is allowed only where
--     the reference graph is acyclic. Re-derive that before adding one. The
--     polymorphic tables cannot use this form at all -- entity_type varies per
--     row, so there is no single parent table to name -- and keep the dispatch
--     helper.
--
-- (c) SELECT IS A SUPERSET OF EVERY WRITE POLICY, AND MUST STAY ONE.
--     Postgres applies SELECT policies to an UPDATE's or DELETE's row-matching
--     whenever the statement has a WHERE clause or RETURNING. Foundation hit
--     the consequence of getting this wrong on organisation_subscriptions (see
--     its second SELECT policy's comment): a write path that silently matches
--     zero rows when aimed and succeeds when unaimed is worse than one that
--     just fails.
--
--     Here the property holds by construction rather than by a second policy:
--     every role holding manage_contacts / manage_artists / manage_venues /
--     manage_custom_fields / merge_records also holds view_crm in the Q2
--     matrix, and the record-scope term is character-for-character the same on
--     both sides. IF A LATER MIGRATION GRANTS A MANAGE KEY TO A ROLE WITHOUT
--     view_crm, that role's writes become unaimed-only. Do not do that; grant
--     view_crm with it.
--
-- (d) NO `for all` POLICIES, ANYWHERE. Separate policies per operation, per
--     CLAUDE.md § Non-negotiable rules and SECURITY.md § 2. A `for all` policy
--     applies its USING expression as the WITH CHECK for INSERT, which is how
--     an INSERT-time check silently ends up being the read predicate. Asserted
--     by schema_invariants.sql D4 and rls_phase2_crm.sql H7.
--
-- (e) WITH CHECK ON EVERY INSERT AND EVERY UPDATE.
--     Foundation's profiles_update_own comment states the general hole; the
--     specific one here is organisation_id. Without a WITH CHECK, a member of
--     org A can `UPDATE contacts SET organisation_id = <org B>` and post a row
--     into a tenant they are not in, or pull one out of it. Every UPDATE below
--     therefore carries:
--       * the same predicate as USING, re-evaluated against the NEW row (so the
--         new organisation_id must also be one the caller may write, and the
--         new owner_user_id must keep the row in their scope); and
--       * private.entity_org_unchanged(...) on the six tables where
--         organisation_id is otherwise freely writable, which pins it -- and
--         `id` -- to the stored value. The child tables get this from their
--         tenant-scoped composite FK and from the parent EXISTS instead.
--     Asserted by rls_phase2_crm.sql H8 (no INSERT/UPDATE policy without a
--     WITH CHECK) and § G (the behaviour).
--
-- (f) DELETE POLICIES: two tables have one, ten do not. Decided per table.
--
--     NO DELETE -- soft-deleted operational records. companies, contacts,
--     agencies, artists, venues, venue_rooms, artist_representations,
--     artist_fee_history all carry `deleted_at`; deletion is an UPDATE and is
--     covered by the UPDATE policy. Granting DELETE as well would hand every
--     manage-key holder a hard delete that bypasses the retention policy
--     (CLAUDE.md § Non-negotiable rules) and, on the parents, cascades through
--     every child.
--
--     NO DELETE -- custom_field_definitions, and this one is a judgement call
--     rather than a rule.
--     It has no `deleted_at`, and custom_field_values_definition_fkey is
--     ON DELETE CASCADE, so deleting one definition destroys every value ever
--     filed under it across the whole organisation -- user-entered CRM content,
--     not configuration. CLAUDE.md § Permissions ("must never silently delete
--     data") makes that the wrong default to ship, and FOLLOW-UPS.md already
--     routes the same cascade to Task 5 for the tier-downgrade path (M9). So
--     definitions can be created and edited but not removed until Task 5 adds
--     `deleted_at` and a deactivation path. THE COST IS REAL AND IS ACCEPTED:
--     a mistyped field cannot be deleted through the API today, only renamed.
--     Routed to Task 5 in FOLLOW-UPS.md rather than left as a surprise.
--
--     NO DELETE -- merges. Append-only; see (g).
--
--     DELETE -- contact_companies. A link row is not an operational record; it
--     has no deleted_at and no history value, and "this person no longer works
--     there" is a deletion, not a state. A soft-deleted link would also have to
--     be excluded from contact_companies_contact_company_unique, which would
--     mean re-adding a removed link fails on a row nobody can see.
--
--     DELETE -- custom_field_values. Clearing a field is a delete: the table
--     has no deleted_at, and `value IS NULL` already means "not filled in", so
--     a tombstone row would collide with a real state. FOLLOW-UPS.md
--     additionally REQUIRES a real DELETE here -- the orphan sweep every entity
--     delete (Task 4) and every merge (Task 6) has to run. ORDERING MATTERS AND
--     IS A CONSTRAINT ON TASK 4: this policy resolves entity_id against the
--     live entity row, so the sweep must delete the values BEFORE hard-deleting
--     the entity, or the entity is gone and the values are unreachable. Soft
--     delete leaves the row in place, so the ordinary path is unaffected.
--
-- (g) merges IS APPEND-ONLY, WITH ONE DELIBERATE DIFFERENCE FROM audit_events.
--     No UPDATE policy, no DELETE policy, and no UPDATE/DELETE grant, exactly
--     as Foundation does for audit_events. It DOES get a client INSERT policy,
--     where audit_events deliberately has none:
--
--       * audit_events is the audit trail. A client INSERT policy there is
--         audit-content forgery, so its only writer is a SECURITY DEFINER
--         function whose actor is forced to auth.uid() and which is granted to
--         no client role.
--       * merges is a domain record of an authorised action. Its INSERT is
--         gated on merge_records AND on both the winner and the loser being
--         manageable by the caller, which is a stronger statement than "the
--         caller may write this table". merged_by is pinned to auth.uid() in
--         the WITH CHECK for the same reason log_audit_event does not accept an
--         actor parameter.
--
--     Task 6 still writes BOTH a merges row and an audit_events row through
--     private.log_audit_event(); neither replaces the other.
--
-- (h) SOFT DELETE IS NOT FILTERED BY RLS. `deleted_at is not null` rows stay
--     visible, and the APPLICATION filters them. This was the alternative to
--     appending `and deleted_at is null` to every USING clause, and it was
--     rejected:
--
--       * Nothing could then undelete a record. `UPDATE ... SET deleted_at =
--         null` needs the row to match the UPDATE policy's USING clause, and a
--         USING clause that excludes deleted rows excludes exactly the row
--         being restored. Restore would need its own SECURITY DEFINER function
--         -- a privileged bypass added to work around a policy, which is how
--         bypasses accumulate.
--       * Task 6's merge has to read the loser, which the merge itself
--         soft-deletes. So does the merge history: merges.loser_id names a row
--         that is deleted by definition.
--       * Retention and DSR export (CLAUDE.md § Legal, 30-day DSR) must reach
--         soft-deleted rows; they are still personal data.
--       * A policy that hides rows makes `select count(*)` disagree with a
--         unique-constraint violation, which is the confusing failure mode:
--         "that email is already taken" pointing at a record the user cannot
--         see. The application can explain that; a policy cannot.
--
--     THIS IS A THING TASKS 3-7 MUST NOT FORGET. Every list query, every count
--     and every dedup lookup needs an explicit `deleted_at is null`, and the
--     partial trigram/email indexes only apply when it is present anyway (Task
--     1 §4.4 measured the Seq Scan you get without it). Recorded in
--     FOLLOW-UPS.md against Tasks 3-7 as well as here. Asserted by
--     rls_phase2_crm.sql § K.
--
-- (i) MFA NOW GATES CRM READS. A CHANGE OF POSTURE, ON PURPOSE.
--     permitted_organisations() carries the aal2 requirement (it restates
--     public.has_permission's clause), so every policy below -- reads included
--     -- is aal2-gated for owner, admin and finance. Foundation's read policies
--     deliberately are NOT: SECURITY.md § 4's "Known limitation: MFA gates
--     privileged WRITES, not READS" explains that gating them is the lockout
--     that would stop an un-enrolled user reaching the enrolment screen.
--
--     That reasoning does not extend to these tables, and the difference is the
--     whole justification: the enrolment path needs profiles, organisations and
--     organisation_memberships. It does not need a single CRM row. So an
--     un-enrolled Owner still signs in, still loads the app, still reaches the
--     enrolment screen, and sees no CRM data until they present a factor --
--     which is the correct answer and not a lockout. Asserted both ways by
--     rls_phase2_crm.sql § J: J1-J3 (an aal1 owner reads and writes nothing)
--     and J5-J6 (the same session still sees its organisation and memberships,
--     so the enrolment screen still renders).
--
--     What it buys is the larger half of that known limitation: a stolen Owner
--     password no longer reads the contact list, the artist roster or the venue
--     book. It does NOT close the limitation -- a stolen standard_user or
--     booker password still reads that user's CRM rows at aal1, because MFA is
--     optional for those roles at MVP and there is nothing to present (J7).
--     SECURITY.md § 4 is updated to say which half moved.
--
-- (j) RECURSION. Every table access below is either a set-returning DEFINER
--     helper (terminal, RLS off) or an acyclic inline reference to a parent
--     entity table (note (b)). The full call graph is in 20260828120500's
--     header. The rule from 20260826154304 design note (h) is unchanged for the
--     tables it was written about: a SELECT policy on organisation_memberships
--     or role_permissions must never call a SECURITY INVOKER helper that reads
--     them.
--
-- (k) GRANTS ARE A SEPARATE CONTROL FROM RLS, and are granted back to match the
--     policy shape one for one (Foundation design note (e)). The tables already
--     have an empty ACL -- 20260827232507's ALTER DEFAULT PRIVILEGES baseline
--     means they were created with no client privileges at all, which Task 1
--     verified against the counterfactual -- so the `revoke all` lines in
--     section 5 are belt-and-braces and are kept because the house pattern is
--     auditable by eye. anon gets nothing. service_role gets nothing, for
--     Foundation's reason: it bypasses RLS entirely, nothing server-side needs
--     it yet, and an ungranted service key is not by itself a read of every
--     tenant's data. schema_invariants.sql D5 asserts the grant/policy
--     biconditional in both directions.

-- ===========================================================================
-- 1. Top-level entities
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- companies / contacts / agencies -- the relationship layer, manage_contacts.
-- ---------------------------------------------------------------------------
create policy "companies_select_view_crm"
  on public.companies for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

-- owner_user_id DEFAULTS to auth.uid() (20260828001134), and a default is not
-- a constraint -- a client can send any value it likes. The scope term in the
-- WITH CHECK is what actually holds: a standard_user or read_only caller can
-- only insert a row they themselves own, and cannot create a row owned by
-- nobody or by a colleague. A full-scope role may set any owner, including
-- null, which is what bulk import and reassignment need.
create policy "companies_insert_manage_contacts"
  on public.companies for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

-- Both halves of the scope term matter on UPDATE and they are not the same
-- check: USING sees the OLD owner (you may only edit rows in your scope) and
-- WITH CHECK sees the NEW one (you may not push a row OUT of your scope, and a
-- scoped user therefore cannot hand their record to someone else -- nor claim
-- someone else's, because USING already refused it).
create policy "companies_update_manage_contacts"
  on public.companies for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('company', id, organisation_id)
  );

create policy "contacts_select_view_crm"
  on public.contacts for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "contacts_insert_manage_contacts"
  on public.contacts for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "contacts_update_manage_contacts"
  on public.contacts for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('contact', id, organisation_id)
  );

create policy "agencies_select_view_crm"
  on public.agencies for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "agencies_insert_manage_contacts"
  on public.agencies for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "agencies_update_manage_contacts"
  on public.agencies for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_contacts'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('agency', id, organisation_id)
  );

-- ---------------------------------------------------------------------------
-- artists -- manage_artists. A Booker holds this and does not hold
-- manage_venues; a Venue Manager is the mirror image. That asymmetry is the
-- point of having six keys rather than one.
-- ---------------------------------------------------------------------------
create policy "artists_select_view_crm"
  on public.artists for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "artists_insert_manage_artists"
  on public.artists for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "artists_update_manage_artists"
  on public.artists for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_artists'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('artist', id, organisation_id)
  );

-- ---------------------------------------------------------------------------
-- venues -- manage_venues.
-- ---------------------------------------------------------------------------
create policy "venues_select_view_crm"
  on public.venues for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "venues_insert_manage_venues"
  on public.venues for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

create policy "venues_update_manage_venues"
  on public.venues for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_venues'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('venue', id, organisation_id)
  );

-- ===========================================================================
-- 2. Child and join tables -- scope derived from a parent, inline (note (b))
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- contact_companies -- SCOPED BY THE CONTACT, NOT THE COMPANY.
--
-- Founder-adjudicated, DECISIONS-QUEUE § Q5: the link is a fact about the
-- person, and the person is what a Standard User is given to work. `AND` (must
-- own both) breaks the contact detail page for someone who owns the contact but
-- not the company; `OR` (owns either) lets a company owner enumerate the
-- contacts of people they do not own. With the tenant-scoped composite FKs in
-- place both parents are guaranteed same-tenant, so neither choice is a tenant
-- risk -- this is a product judgement, not a security one.
--
-- APPLIED TO WRITES TOO, and that is the part Q5 does not spell out. Requiring
-- the COMPANY to be manageable as well would reintroduce the `AND` that Q5
-- rejected, one layer down: a Standard User who owns a contact could not record
-- where that person works unless they also owned the employer, which is the
-- same broken page from the write side. The residue is a company-existence
-- oracle -- a caller can learn whether a uuid they already hold names a company
-- in their own tenant by whether the insert succeeds. That requires guessing a
-- v4 uuid inside one's own organisation and reveals nothing but existence, so
-- it is accepted and recorded rather than paid for.
--
-- DELETE, not soft delete -- see design note (f).
-- ---------------------------------------------------------------------------
create policy "contact_companies_select_via_contact"
  on public.contact_companies for select to authenticated
  using (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "contact_companies_insert_via_contact"
  on public.contact_companies for insert to authenticated
  with check (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- USING sees the OLD contact_id, WITH CHECK the NEW one, so repointing a link
-- onto a contact the caller cannot manage is refused from both directions.
create policy "contact_companies_update_via_contact"
  on public.contact_companies for update to authenticated
  using (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "contact_companies_delete_via_contact"
  on public.contact_companies for delete to authenticated
  using (
    exists (
      select 1 from public.contacts p
      where p.id = contact_companies.contact_id
        and p.organisation_id = contact_companies.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- artist_representations -- scoped by the ARTIST.
--
-- Three parents (artist, agency, contact) and one of them has to be the scope.
-- The artist is the record the representation is about; agency and contact are
-- who represents them. Q3a records the known consequence: a Standard User can
-- see a representation naming an agency they cannot see, and the agency renders
-- blank rather than leaking -- a display wart, not a disclosure.
--
-- Soft-deleted (deleted_at, added by 20260828001134 M3 so that an agency
-- folding does not destroy representation history), so no DELETE policy.
-- ---------------------------------------------------------------------------
create policy "artist_representations_select_via_artist"
  on public.artist_representations for select to authenticated
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "artist_representations_insert_via_artist"
  on public.artist_representations for insert to authenticated
  with check (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "artist_representations_update_via_artist"
  on public.artist_representations for update to authenticated
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from public.artists p
      where p.id = artist_representations.artist_id
        and p.organisation_id = artist_representations.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- artist_fee_history -- scoped by the ARTIST, on manage_artists.
--
-- NOT gated on a finance permission, and the reason is worth stating because
-- the table name invites the opposite instinct. The Q2 matrix gives Finance
-- view_crm and nothing else: the Finance role's writes are Phase 5's
-- financial_entries, at event/booking level. What a fee history row records is
-- an attribute of the artist -- "we paid this artist this much, this night" --
-- which is the booking team's data and moves with the artist record. When
-- Phase 5 lands, revisit whether Finance should hold a write key here; do not
-- pre-empt it by inventing one now. Asserted by rls_phase2_crm.sql C15.
-- ---------------------------------------------------------------------------
create policy "artist_fee_history_select_via_artist"
  on public.artist_fee_history for select to authenticated
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "artist_fee_history_insert_via_artist"
  on public.artist_fee_history for insert to authenticated
  with check (
    exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "artist_fee_history_update_via_artist"
  on public.artist_fee_history for update to authenticated
  using (
    exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from public.artists p
      where p.id = artist_fee_history.artist_id
        and p.organisation_id = artist_fee_history.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_artists'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- venue_rooms -- scoped by the VENUE, on manage_venues.
--
-- This is the table Task 1's review broke into end to end: a user who could not
-- see org B's venue at all inserted a room into it, tagged to her own
-- organisation, and org B's venue page rendered her attacker-controlled text.
-- Two independent controls now stop that, and it is worth being precise about
-- which does what, because only one of them is a policy:
--   * venue_rooms_venue_fkey, tenant-scoped and composite, refuses the row at
--     the constraint layer with 23503 -- for every writer, in every role, with
--     no session required. That is the fix, and it is what protects the paths
--     RLS does not apply to (postgres, a SECURITY DEFINER function, a DBA
--     repair script).
--   * the policy below refuses it FIRST for an `authenticated` caller, with
--     42501, including the variant tagged to the victim's organisation, which
--     the foreign key would happily accept.
-- Regression coverage for the first is schema_invariants.sql § A (run as
-- postgres, where no policy is in the way); for the second, rls_phase2_crm.sql
-- B19/B20 and G6/G7, which assert both layers in that order.
-- ---------------------------------------------------------------------------
create policy "venue_rooms_select_via_venue"
  on public.venue_rooms for select to authenticated
  using (
    exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "venue_rooms_insert_via_venue"
  on public.venue_rooms for insert to authenticated
  with check (
    exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

create policy "venue_rooms_update_via_venue"
  on public.venue_rooms for update to authenticated
  using (
    exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from public.venues p
      where p.id = venue_rooms.venue_id
        and p.organisation_id = venue_rooms.organisation_id
        and p.organisation_id in (select private.permitted_organisations('manage_venues'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

-- ===========================================================================
-- 3. Custom fields -- the two-permission table pair
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- custom_field_definitions -- ORGANISATION CONFIGURATION.
--
-- Read by anyone with view_crm, including read_only and standard_user, and
-- NOT record-scoped: a definition is not a record, it is the label and type
-- that make a value renderable. Withholding it from a Standard User would
-- leave them looking at values with no field names.
--
-- Written on manage_custom_fields, which the Q2 matrix gives to Owner and
-- Admin only -- Manager is excluded deliberately, because a definition is
-- schema and schema changes are an admin act.
--
-- Tier limits (Free 0 / Starter 5 per entity / Pro unlimited) are NOT enforced
-- here and cannot be: the limit is subscription_plans.custom_field_limit for
-- the organisation's current plan, which is a subquery, and a downgrade must
-- make existing definitions read-only rather than retroactively invalid.
-- Task 5 enforces it server-side. A policy that tried would either need a
-- correlated subquery over two more tables per row or would delete data on
-- downgrade, and CLAUDE.md forbids the second.
--
-- No DELETE policy -- design note (f).
-- ---------------------------------------------------------------------------
create policy "custom_field_definitions_select_view_crm"
  on public.custom_field_definitions for select to authenticated
  using ( organisation_id in (select private.permitted_organisations('view_crm')) );

create policy "custom_field_definitions_insert_manage_custom_fields"
  on public.custom_field_definitions for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
  );

create policy "custom_field_definitions_update_manage_custom_fields"
  on public.custom_field_definitions for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_custom_fields'))
    and private.entity_org_unchanged('custom_field_definition', id, organisation_id)
  );

-- ---------------------------------------------------------------------------
-- custom_field_values -- THE SUBTLEST POLICY IN THIS FILE. Three things are
-- happening at once and they are independent.
--
-- 1. THE PERMISSION IS THE PARENT ENTITY'S, NOT manage_custom_fields.
--    A Booker editing an artist must be able to fill in that artist's custom
--    fields without being able to define new ones. So the write gate is
--    entity_is_manageable(entity_type, ...), which resolves to manage_artists
--    for an artist, manage_venues for a venue, manage_contacts for the
--    relationship layer -- and never to manage_custom_fields, which governs the
--    DEFINITION table above and nothing else. Asserted in rls_phase2_crm.sql
--    § F, in both directions: a Booker can write an artist's value and cannot
--    create a definition; a Venue Manager is the mirror image.
--
-- 2. THE ENTITY DISPATCH IS A TENANT CONTROL, not a convenience.
--    entity_id is polymorphic and unvalidated -- no foreign key can express
--    "references whichever table this other column names". Task 1's re-review
--    proved the consequence: an org A user filed a value against an org B
--    contact and the row was accepted, so a parent-derived read policy on the
--    victim's side would have served attacker-controlled jsonb on the victim's
--    own contact page. entity_is_visible / entity_is_manageable resolve
--    entity_id against the physical table named by entity_type and compare that
--    row's organisation_id to this row's own, which is precisely the check
--    20260827232512's header and SECURITY.md § 10 name. Asserted in
--    rls_phase2_crm.sql § E.
--
--    The composite FK on (field_id, organisation_id, entity_type) already
--    covers the DEFINITION half of the same problem. These policies cover the
--    ENTITY half. Both halves are needed; neither implies the other.
--
-- 3. THE ORGANISATION TEST LEADS, AND IS NOT REDUNDANT WITH THE DISPATCH.
--    `organisation_id in (select ...)` is a hashed SubPlan evaluated once per
--    statement; the dispatch is a per-row function call (design note (b) in
--    20260828120500 explains why it has to be). Putting the cheap one first
--    means a row belonging to another tenant, or to an organisation the caller
--    holds nothing in, is discarded on a hash probe and never reaches the
--    dispatch. It is also a genuine second control: the dispatch answers "may I
--    touch this ENTITY", this answers "may I touch this ORGANISATION's rows",
--    and a row whose two disagree is refused by whichever is stricter.
--
-- DELETE is granted -- design note (f) -- and Task 4/6's orphan sweep must run
-- before the entity row is hard-deleted, because this policy needs to resolve
-- entity_id.
-- ---------------------------------------------------------------------------
create policy "custom_field_values_select_via_entity"
  on public.custom_field_values for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_visible(entity_type, entity_id, organisation_id)
  );

create policy "custom_field_values_insert_via_entity"
  on public.custom_field_values for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

create policy "custom_field_values_update_via_entity"
  on public.custom_field_values for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  )
  with check (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

create policy "custom_field_values_delete_via_entity"
  on public.custom_field_values for delete to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_manageable(entity_type, entity_id, organisation_id)
  );

-- ===========================================================================
-- 4. merges -- append-only
-- ===========================================================================
-- SELECT is scoped by the WINNER, not merely by view_crm on the organisation.
-- That matters more here than the table's size suggests: field_resolution holds
-- the surviving AND the discarded value of every field, so a merge row is a
-- verbatim copy of two records' contents. An org-wide read policy would hand a
-- Standard User the field values of records they are not allowed to see, which
-- is the record-scope boundary defeated by a history table. The winner survives
-- the merge and is the record the history belongs to, so it is the right
-- anchor; the loser is soft-deleted by definition and cannot be. Asserted by
-- rls_phase2_crm.sql D27.
--
-- INSERT requires merge_records AND that BOTH sides are manageable by the
-- caller -- a merge destroys the loser, so holding the key over only one of the
-- two records is not enough. Resolving both through the dispatch is also what
-- closes the winner_id/loser_id half of the polymorphic hole (SECURITY.md § 10
-- names all three columns; the other is custom_field_values.entity_id above).
--
-- merged_by is pinned to auth.uid() for the reason private.log_audit_event does
-- not take an actor parameter: attribution for a destructive action must not be
-- caller-supplied.
--
-- No UPDATE policy and no DELETE policy -- see design note (g).
-- ===========================================================================
create policy "merges_select_via_winner"
  on public.merges for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and private.entity_is_visible(entity_type, winner_id, organisation_id)
  );

create policy "merges_insert_merge_records"
  on public.merges for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('merge_records'))
    and merged_by = (select auth.uid())
    and private.entity_is_manageable(entity_type, winner_id, organisation_id)
    and private.entity_is_manageable(entity_type, loser_id,  organisation_id)
  );

-- ===========================================================================
-- 5. Table privileges
-- ===========================================================================
-- Design note (k). One grant per policy, no grant without a policy.

revoke all on public.companies                from anon, authenticated, service_role;
revoke all on public.contacts                 from anon, authenticated, service_role;
revoke all on public.contact_companies        from anon, authenticated, service_role;
revoke all on public.agencies                 from anon, authenticated, service_role;
revoke all on public.artists                  from anon, authenticated, service_role;
revoke all on public.artist_representations   from anon, authenticated, service_role;
revoke all on public.artist_fee_history       from anon, authenticated, service_role;
revoke all on public.venues                   from anon, authenticated, service_role;
revoke all on public.venue_rooms              from anon, authenticated, service_role;
revoke all on public.custom_field_definitions from anon, authenticated, service_role;
revoke all on public.custom_field_values      from anon, authenticated, service_role;
revoke all on public.merges                   from anon, authenticated, service_role;

-- Soft-deleted entities: no DELETE grant anywhere, matching the absent DELETE
-- policies. Deletion is `set deleted_at = now()`, i.e. an UPDATE.
grant select, insert, update on public.companies              to authenticated;
grant select, insert, update on public.contacts               to authenticated;
grant select, insert, update on public.agencies               to authenticated;
grant select, insert, update on public.artists                to authenticated;
grant select, insert, update on public.venues                 to authenticated;
grant select, insert, update on public.venue_rooms            to authenticated;
grant select, insert, update on public.artist_representations to authenticated;
grant select, insert, update on public.artist_fee_history     to authenticated;

-- Configuration: no DELETE grant either, but for a different reason -- the
-- cascade to custom_field_values. See design note (f).
grant select, insert, update on public.custom_field_definitions to authenticated;

-- The two tables where a real DELETE is the right verb.
grant select, insert, update, delete on public.contact_companies   to authenticated;
grant select, insert, update, delete on public.custom_field_values to authenticated;

-- merges: append-only. SELECT and INSERT only, no UPDATE and no DELETE grant
-- for any client role, matching audit_events' discipline.
grant select, insert on public.merges to authenticated;
