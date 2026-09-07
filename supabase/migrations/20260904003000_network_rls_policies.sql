-- Phase 6 (Network), Task 1d: the RLS policies on public.network_profiles,
-- public.network_links and public.network_connection_requests, plus the
-- BEFORE UPDATE transition guard on connection requests.
--
-- 20260904000000 shipped all three tables with `enable row level security` and
-- ZERO policies (the safe order, "RLS on before access") and opened a named
-- interval: schema_invariants.sql D4 (`3`) and D5 (`9`) have been red since.
-- THIS FILE CLOSES IT. Those assertions carry the post-Task-1d numbers (D4
-- `0`, D5 `0`); a reviewer checks they went GREEN rather than that they were
-- silenced. D11b is untouched by this phase -- none of the three tables is in
-- invariants.child_parent, so none of their expressions enters that census.
--
-- ADDITIVE. `create policy`, never `alter` -- there is nothing to alter, these
-- are new. `create or replace policy` does not exist in PostgreSQL (42601 on
-- the pinned 17.6).
--
-- NINE POLICIES. network_profiles 4 (SELECT own, SELECT directory, INSERT,
-- UPDATE), network_links 3 (SELECT, INSERT, UPDATE), and
-- network_connection_requests... no: network_connection_requests has 4 (SELECT,
-- INSERT, and TWO UPDATE policies). 4 + 3 + 4 = ELEVEN. No DELETE policy on any
-- of the three, because there is no DELETE grant on any of the three.
--
-- ===========================================================================
-- THE SHAPE RULES, OBEYED AND EACH WITH A MEASUREMENT BEHIND IT
-- ===========================================================================
--   1. THE SET FORM, NEVER THE PER-ROW FORM (Constraint 2).
--      `<org column> in (select private.permitted_organisations('key'))`,
--      never `public.has_permission(organisation_id, 'key')`. The subquery has
--      no row correlation, so the planner hoists it to one InitPlan per
--      statement; the per-row form was measured at 5210 ms for a fifty-row
--      page where the set form takes 23 ms (20260828120500). Both forms return
--      identical rows for every user, so NO BEHAVIOURAL TEST CAN TELL THEM
--      APART -- which is why rls_phase6_network.sql § NS carries the structural
--      guard, with its denominator, in the style of rls_phase2_crm.sql H12/H13.
--   2. AN INLINE `exists` AGAINST A SINGLE PARENT (Constraint 3), never a
--      SECURITY DEFINER helper, which cannot be inlined and is structurally
--      per-row (measured 12830 ms -> 19.6 ms, 20260828121000). Used on
--      network_links' network end and on both ends of a connection request.
--   3. THE POLYMORPHIC TARGET END TAKES THE EXCEPTION: it must call
--      private.entity_is_manageable, because you cannot write an inline
--      `exists` against a union of four tables.
--
-- ===========================================================================
-- WHERE THE ENTITLEMENT TERM GOES (20260828140500's placement rule)
-- ===========================================================================
--   INSERT -> WITH CHECK. The only clause an INSERT policy has, and it makes a
--             Free-tier refusal a loud 42501 rather than a silent 204.
--   UPDATE -> WITH CHECK ONLY, deliberately NOT USING. In USING, the row would
--             stop matching and PostgREST would answer 204 No Content, which is
--             indistinguishable from success (lib/crm/write.ts measured it).
--   SELECT -> nowhere. Q81: a downgrade never hides your own data, and Free is
--             a view-only NETWORK tier by design (CLAUDE.md § Subscription
--             tiers) -- browsing is precisely what Free is FOR.
--
-- The gate is INERT today (20260904001000): network_publish_organisations()
-- exempts organisations with no subscription row, which is every organisation.
-- ===========================================================================


-- ===========================================================================
-- 1. public.network_profiles
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SELECT (own). Your own profiles, drafts included.
--
-- No tier term (Q81: a downgrade never hides your own data). No deleted_at
-- term (the application filters -- Constraint 7 -- and the restore path and
-- the deleted view both need to read soft-deleted rows). No record-scope
-- disjunction: network_profiles has no owner_user_id and every role holds
-- view_network.
-- ---------------------------------------------------------------------------
create policy "network_profiles_select_view_network"
  on public.network_profiles for select to authenticated
  using ( organisation_id in (select private.permitted_organisations('view_network')) );

comment on policy "network_profiles_select_view_network" on public.network_profiles is
  'PERMITS: reading this organisation''s OWN network profiles, drafts and published alike, for any member holding view_network (every role does). DOES NOT PERMIT: reading another tenant''s DRAFT profile at all -- the directory policy beside this one requires status=''published'', so a draft is visible only to its own organisation. DELIBERATELY NOT TIER-GATED (no network_publish term): Q81, a downgrade freezes writing, it never hides a customer''s own data; and Free is a view-only network tier by design. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS (no deleted_at term): the restore path and the deleted view both read them; the application filters. NOT below aal2 for owner/admin/finance, whose keys are MFA-gated inside permitted_organisations (20260827210000) -- no separate term here. NOT for a SUSPENDED organisation: view_network is survives_suspension=false, unlike view_crm.';

-- ---------------------------------------------------------------------------
-- SELECT (directory). THE ONE POLICY IN THE PRODUCT THAT PERMITS A
-- CROSS-TENANT READ, and it is written so that fact is impossible to miss.
--
-- The membership `exists` is the "logged-in customer only" half of Q70 AT THE
-- POLICY LAYER, so the guarantee does not rest solely on the absent `anon`
-- grant. Two independent controls for one rule: N6 (the grant) and this term.
--
-- It is deliberately NOT `permitted_organisations('view_network')`: that would
-- make the directory readable only from a workspace you hold the key in, which
-- is the same answer for every real user (view_network is held by all nine
-- roles) at the cost of a per-caller key lookup for a predicate that is not
-- about any particular organisation. What this needs to know is "is this an
-- active member of ANY organisation", which is exactly what it asks.
-- ---------------------------------------------------------------------------
create policy "network_profiles_select_published_directory"
  on public.network_profiles for select to authenticated
  using (
    status = 'published'
    and deleted_at is null
    and exists (select 1 from public.organisation_memberships m
                 where m.user_id = (select auth.uid()) and m.status = 'active')
  );

comment on policy "network_profiles_select_published_directory" on public.network_profiles is
  'THE ONE POLICY IN THIS SCHEMA THAT PERMITS A CROSS-TENANT READ. PERMITS: every active member of every organisation to read this row, when it is published and live. DOES NOT PERMIT: an unauthenticated caller (there is no anon grant on this table -- N6 -- and this policy additionally requires an active membership, so Q70''s "no public, logged-out profiles" has two independent controls); reading a draft or soft-deleted profile of another tenant. AND IT DOES NOT CONSTRAIN WHICH COLUMNS ARE LEGIBLE -- that is public.network_directory''s job, and application code must NEVER select from this table for a foreign organisation. The base table is deliberately readable and the VIEW is the masking control; organisation_id, entity_id and every field the publisher marked hidden are reachable HERE and are absent from the view. Constraint 19''s network case: shipping the view while the discovery page reads this table directly would pass every structural assertion about the view and leak anyway.';

-- ---------------------------------------------------------------------------
-- INSERT. Three independent gates plus the polymorphic-target check.
--
--   ROLE   manage_network_profile -> permitted_organisations(...)
--   TIER   network_publish        -> network_publish_organisations(), in WITH
--                                    CHECK so a Free refusal is a loud 42501
--   MFA    aal2                   -> folded INTO permitted_organisations for
--                                    owner/admin; no separate term
--   TARGET entity_is_manageable(entity_kind, entity_id, organisation_id) --
--          YOU MAY ONLY PUBLISH A RECORD YOU COULD MANAGE. This is the
--          polymorphic exception (Constraint 3): entity_kind spans four tables,
--          so no inline `exists` is possible, and this dispatch asks for
--          manage_contacts / manage_artists / manage_venues per kind -- NOT for
--          a network key. Publishing your venue requires that you could edit
--          your venue.
-- ---------------------------------------------------------------------------
create policy "network_profiles_insert_manage_profile"
  on public.network_profiles for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_profile'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(entity_kind, entity_id, organisation_id)
  );

comment on policy "network_profiles_insert_manage_profile" on public.network_profiles is
  'PERMITS: creating a network profile for one of this organisation''s OWN private records, when the caller holds manage_network_profile (owner/admin/manager/marketing) at aal2 AND the plan permits network_publish (Starter/Pro) AND the caller could MANAGE that private record. Four gates. DOES NOT PERMIT: a FREE-tier organisation (42501 from the network_publish term -- a loud refusal, not a silent 0, which is why the term is in WITH CHECK; Q76/N7); a role without manage_network_profile (booker, venue_manager, finance, standard_user, read_only); a caller below aal2 where the role requires MFA (the key is simply not held); publishing another tenant''s record, or one of this tenant''s records the caller could not edit -- private.entity_is_manageable resolves entity_id against companies/artists/venues/agencies and asks for manage_contacts / manage_artists / manage_venues per kind, which is the polymorphic-target exception (Constraint 3) and the reason entity_id carries no foreign key. The network_publish term is INERT today (20260904001000): the helper exempts organisations with no subscription row, which is every organisation.';

-- ---------------------------------------------------------------------------
-- UPDATE. manage_network_profile in USING; WITH CHECK adds the tier term, the
-- target check, and the org-pin.
--
-- This ONE policy is publish, unpublish, edit, set-visibility and soft-delete:
-- all five are UPDATEs of network_profiles. There is no DELETE policy and no
-- DELETE grant.
-- ---------------------------------------------------------------------------
create policy "network_profiles_update_manage_profile"
  on public.network_profiles for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_network_profile'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_profile'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(entity_kind, entity_id, organisation_id)
    and private.entity_org_unchanged('network_profile', id, organisation_id)
  );

comment on policy "network_profiles_update_manage_profile" on public.network_profiles is
  'PERMITS: editing, PUBLISHING (status := published), UNPUBLISHING, changing field_visibility and soft-deleting a network profile the caller may write -- all five are UPDATEs; there is no DELETE policy or grant. Requires manage_network_profile (USING and WITH CHECK) at aal2, network_publish (WITH CHECK, the Free gate), a still-manageable private record, and an unchanged (id, organisation_id). DOES NOT PERMIT: any of it for a FREE-tier organisation -- the network_publish term is in WITH CHECK ONLY, deliberately, so a downgrade refusal is a 42501 rather than PostgREST''s 204 No Content (indistinguishable from success); MOVING A PROFILE TO ANOTHER ORGANISATION, which private.entity_org_unchanged(''network_profile'', ...) refuses by comparing the NEW organisation_id against the statement-start snapshot -- the tenant-to-tenant transfer a two-org admin could otherwise do in one statement, and the ONLY thing pinning it since network_profiles has no owner column. That transfer matters more here than anywhere else in the schema: this is the one table another tenant can read, so moving a row between tenants would move a cross-tenant-readable row. NOTE what this policy does NOT enforce, because a policy cannot: that a hidden field stores NULL. network_profiles_hidden_fields_are_null (20260904000000) is that control, and it holds for every writer including one RLS does not apply to.';


-- ===========================================================================
-- 2. public.network_links -- Q82: NO COUNTERPARTY PATH EXISTS AT ALL
-- ===========================================================================
-- A link is one organisation's private note that a network identity is the
-- same entity as one of its own records. The profile's OWNER is never told,
-- and there is no policy here that would tell them. Knowing who has filed you
-- in their CRM is itself commercially sensitive.
--
-- These three policies are also the REPLACEMENT GUARD for the single-column
-- network_profile_id FK (the one Constraint 4 exemption in this phase, see
-- 20260904000000): they read NOTHING from network_profiles except `id` and
-- `status`, and none of them grants any read to a non-owning organisation.
-- rls_phase6_network.sql § NS asserts both halves structurally, and the SELECT
-- policy's body is asserted to contain NO occurrence of `network_profiles` at
-- all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SELECT. THAT IS THE WHOLE POLICY.
--
-- There is no disjunction, no profile-owner branch, and ADDING ONE IS THE
-- LEAK. An `or exists (select 1 from public.network_profiles p where p.id =
-- network_links.network_profile_id and p.organisation_id in (select
-- private.permitted_organisations('view_network')))` would read as a
-- reasonable "let the profile's owner see their own links" and would disclose,
-- to every published organisation, the identity of every organisation that has
-- filed them -- a commercial map of the industry, derived from private CRM
-- data, handed out by an ordinary-looking policy edit.
-- ---------------------------------------------------------------------------
create policy "network_links_select_view_network"
  on public.network_links for select to authenticated
  using ( organisation_id in (select private.permitted_organisations('view_network')) );

comment on policy "network_links_select_view_network" on public.network_links is
  'PERMITS: reading the LINKING organisation''s own network links. That is the whole policy (Q82). DOES NOT PERMIT: the profile''s OWNER to see who has linked to them -- there is deliberately no disjunction, no profile-owner branch, and adding one is the leak: it would disclose to every published organisation the identity of every organisation that has filed them, a commercial map of the industry derived from private CRM data. The absence is the control, so it is asserted rather than trusted: rls_phase6_network.sql § NS asserts this policy''s body contains NO occurrence of `network_profiles`, which doubles as the replacement guard for the single-column network_profile_id FK. NOT tier-gated (reads survive a downgrade) and no deleted_at term (the application filters).';

-- ---------------------------------------------------------------------------
-- INSERT / UPDATE. manage_network_connections + the tier + the polymorphic
-- private end + an inline `exists` that the target profile is PUBLISHED and
-- LIVE.
--
-- That inline `exists` reads ONLY `id` and `status` from network_profiles --
-- which is the replacement guard named above -- and it is what stops a link to
-- a draft or a soft-deleted profile. It is INLINE rather than behind a helper
-- (Constraint 3: one parent, so the planner hoists it).
--
-- NOTE what it deliberately does NOT correlate: `p.organisation_id =
-- network_links.organisation_id`. Constraint 4's D11 term does not apply here,
-- BECAUSE THE PARENT IS ANOTHER TENANT'S BY DESIGN. Correlating them would
-- permit only self-links, which is the same wrong answer the composite FK
-- would have given.
-- ---------------------------------------------------------------------------
create policy "network_links_insert_manage_connections"
  on public.network_links for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(private_entity_type, private_entity_id, organisation_id)
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_links.network_profile_id
        and p.status = 'published'
        and p.deleted_at is null
    )
  );

comment on policy "network_links_insert_manage_connections" on public.network_links is
  'PERMITS: filing a PUBLISHED, LIVE network profile against one of this organisation''s own private records, when the caller holds manage_network_connections at aal2 AND the plan permits network_publish. DOES NOT PERMIT: a FREE-tier organisation (42501, Q76/N7); a role without manage_network_connections (finance, standard_user, read_only); linking a private record the caller could not manage (private.entity_is_manageable, the polymorphic-target exception); linking to a DRAFT or SOFT-DELETED profile (the inline exists). THE INLINE EXISTS READS ONLY `id` AND `status` FROM network_profiles, and that is the deliberate replacement guard for the single-column network_profile_id FK (20260904000000). It deliberately does NOT carry `p.organisation_id = network_links.organisation_id`: the parent is ANOTHER TENANT''S BY DESIGN, so correlating them would permit only self-links -- the same wrong answer the composite FK would have given. The network_publish term is INERT today.';

create policy "network_links_update_manage_connections"
  on public.network_links for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_network_connections'))
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(private_entity_type, private_entity_id, organisation_id)
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_links.network_profile_id
        and p.status = 'published'
        and p.deleted_at is null
    )
  );

comment on policy "network_links_update_manage_connections" on public.network_links is
  'PERMITS: soft-deleting (deleted_at := now()) and restoring a network link the caller may write -- both are UPDATEs; there is no DELETE policy or grant, and nothing else about a link is editable in the product. Requires manage_network_connections at aal2 (USING and WITH CHECK) and network_publish (WITH CHECK only, so a downgrade refusal is 42501 rather than a silent 204). DOES NOT PERMIT: repointing a link at a draft or deleted profile; repointing it at a private record the caller cannot manage. Reads only `id` and `status` from network_profiles, same replacement guard as the INSERT policy.';


-- ===========================================================================
-- 3. public.network_connection_requests -- BI-TENANT (Q83)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SELECT. Either side sees the request. Both terms in the SET form.
-- ---------------------------------------------------------------------------
create policy "network_connection_requests_select_view_network"
  on public.network_connection_requests for select to authenticated
  using (
    from_organisation_id in (select private.permitted_organisations('view_network'))
    or to_organisation_id in (select private.permitted_organisations('view_network'))
  );

comment on policy "network_connection_requests_select_view_network" on public.network_connection_requests is
  'PERMITS: either SIDE of a connection request to read it -- the sender through from_organisation_id, the recipient through to_organisation_id. Both terms in the set form (Constraint 2), so both are hoisted to one InitPlan each per statement. DOES NOT PERMIT: a third organisation reading a request between two others, in either direction; any read for a role without view_network (no role is excluded today, so this is the suspension and aal2 gate in practice). NOT tier-gated: a Free organisation can SEE a request addressed to it -- what it cannot do is accept it (Q76), which is the recipient UPDATE policy''s job.';

-- ---------------------------------------------------------------------------
-- INSERT. The sender's gates, plus TWO inline `exists` clauses that make BOTH
-- profile references honest.
--
-- Term (ii) is what makes `to_organisation_id` UNFORGEABLE: a caller cannot
-- address a request at an organisation whose profile they did not actually
-- pick, because the profile they named must really belong to the organisation
-- they named. Without it, `to_organisation_id` is a client-supplied column on
-- a table the client can INSERT into, and a caller could plant a request
-- against any organisation id they could guess.
-- ---------------------------------------------------------------------------
create policy "network_connection_requests_insert_manage_connections"
  on public.network_connection_requests for insert to authenticated
  with check (
    from_organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and from_organisation_id in (select private.network_publish_organisations())
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_connection_requests.from_network_profile_id
        and p.organisation_id = network_connection_requests.from_organisation_id
        and p.status = 'published'
        and p.deleted_at is null
    )
    and exists (
      select 1 from public.network_profiles p
      where p.id = network_connection_requests.to_network_profile_id
        and p.organisation_id = network_connection_requests.to_organisation_id
        and p.status = 'published'
        and p.deleted_at is null
    )
  );

comment on policy "network_connection_requests_insert_manage_connections" on public.network_connection_requests is
  'PERMITS: sending a connection request FROM one of your own published, live profiles (Q78) TO another organisation''s published, live profile, when the caller holds manage_network_connections at aal2 in the sending organisation AND that organisation''s plan permits network_publish. DOES NOT PERMIT: a FREE-tier organisation sending at all (42501, Q76/N7); sending from an organisation the caller is not in; sending from a DRAFT profile, or one belonging to somebody else; and -- the subtle one -- FORGING to_organisation_id. That column is client-supplied on a table the client may INSERT into, and the second inline exists is what makes it honest: the named to_network_profile_id must really belong to the named to_organisation_id, so a caller cannot address a request at an organisation whose profile they did not pick. Sending to YOURSELF is refused by network_connection_requests_not_self (23514), not here, so it holds for every writer. A repeat send while a pending/accepted/declined request stands is 23505 from network_connection_requests_live_pair (Q79).';

-- ---------------------------------------------------------------------------
-- UPDATE -- TWO POLICIES, NOT ONE WITH AN `or`. THIS IS THE SUBTLE ONE.
--
-- A single policy whose USING read
--     to_organisation_id in (...) or from_organisation_id in (...)
-- and whose WITH CHECK read
--     status in ('accepted','declined','withdrawn')
-- would let a SENDER mark its own request `accepted`, because both clauses are
-- evaluated over the same row and neither ties the identity of the actor to
-- the transition they are allowed to make. Splitting them into two policies is
-- what binds "who you are" to "what you may set": PostgreSQL ORs permissive
-- policies together, so the recipient path and the sender path each carry
-- their own WITH CHECK and a row must satisfy at least one PAIR in full.
--
-- rls_phase6_network.sql § NU is the assertion: the SENDER cannot set
-- status='accepted' (42501), the RECIPIENT can, with a positive control both
-- ways round.
-- ---------------------------------------------------------------------------
create policy "network_connection_requests_update_recipient_responds"
  on public.network_connection_requests for update to authenticated
  using (
    to_organisation_id in (select private.permitted_organisations('manage_network_connections'))
  )
  with check (
    to_organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and to_organisation_id in (select private.network_publish_organisations())
    and status in ('accepted','declined')
  );

comment on policy "network_connection_requests_update_recipient_responds" on public.network_connection_requests is
  'PERMITS: the RECIPIENT organisation to answer a request -- accepted or declined, and nothing else. Requires manage_network_connections at aal2 (USING and WITH CHECK) and network_publish (WITH CHECK only, so the refusal is a loud 42501 rather than a silent 204). DOES NOT PERMIT: a FREE-tier organisation ACCEPTING (Q76 -- a Free org can see and decline-by-inaction, it cannot form a connection); the recipient setting `withdrawn`, which is the sender''s word; the recipient rolling a terminal status back to `pending` (the WITH CHECK excludes pending, and private.network_request_status_transition_guard below refuses it again as defence in depth). This is HALF of a deliberate two-policy split -- see network_connection_requests_update_sender_withdraws. A single policy with an `or` across the two organisation columns would let a SENDER mark its own request accepted, which is the whole point of the split.';

-- DEVIATION FROM THE BRIEF, STATED, AND IT CLOSES A REAL HOLE (Constraint 13).
--
-- The brief specifies this policy's WITH CHECK as `status = 'withdrawn'` and
-- nothing else. THAT IS NOT SAFE, because PostgreSQL ORs PERMISSIVE POLICIES
-- TOGETHER IN BOTH CLAUSES -- the WITH CHECKs as well as the USINGs. So with a
-- bare `status = 'withdrawn'` here, a RECIPIENT's UPDATE would pass USING
-- through the recipient policy and then pass WITH CHECK through THIS one,
-- because this one carries no term about who the caller is. Measured on this
-- stack while writing the suite: the recipient could set `withdrawn`, which is
-- the sender's word alone.
--
-- Repeating the USING term in WITH CHECK is what every other policy in this
-- schema does, and it is what binds the actor to the transition -- which is the
-- entire stated purpose of splitting this policy in two. rls_phase6_network.sql
-- NU5 is the assertion; without this term it is red.
create policy "network_connection_requests_update_sender_withdraws"
  on public.network_connection_requests for update to authenticated
  using (
    from_organisation_id in (select private.permitted_organisations('manage_network_connections'))
  )
  with check (
    from_organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and status = 'withdrawn'
  );

comment on policy "network_connection_requests_update_sender_withdraws" on public.network_connection_requests is
  'PERMITS: the SENDING organisation to withdraw its own request, and NOTHING ELSE -- the WITH CHECK pins status to exactly ''withdrawn'' AND repeats the from_organisation_id term. DOES NOT PERMIT: the sender accepting or declining its own request (the whole reason this is a separate policy rather than an `or` branch of the recipient one); the RECIPIENT withdrawing -- and that second one is why the WITH CHECK repeats the organisation term rather than carrying the status alone as the Task 1 brief specified. PostgreSQL ORs permissive policies in BOTH clauses, so a bare `status = ''withdrawn''` here would be satisfied by a recipient whose USING passed through the OTHER update policy; measured on this stack while writing the suite. NO network_publish TERM, DELIBERATELY: withdrawing is how a Free-tier organisation retracts a request it can no longer act on, and gating the retraction behind the tier would strand it. Withdrawing frees the pair for exactly one retry (Q79, network_connection_requests_live_pair). The BEFORE UPDATE transition guard below additionally refuses withdrawing an already-terminal request.';

-- ---------------------------------------------------------------------------
-- THE TRANSITION GUARD -- defence in depth behind the two WITH CHECKs.
--
-- Modelled on private.guard_document_scan_status (20260902031000), the
-- documents_scan_status transition-guard precedent, and it exists for the same
-- reason: the table carries an UPDATE grant and UPDATE policies that do not
-- restrict WHICH values a column may move BETWEEN, only which it may land on.
-- So without this, a recipient could PATCH a `declined` request straight to
-- `accepted` -- un-declining it -- and the WITH CHECK would be satisfied,
-- because `accepted` is a permitted landing value.
--
-- A TERMINAL STATUS IS IMMUTABLE. pending -> {accepted, declined, withdrawn}
-- is the only move there is. Same-value UPDATEs are allowed (a responded_by /
-- responded_at correction, or any future column).
--
-- Raises 23514 to read like the constraint it is, exactly as the document
-- scan-status guard does.
-- ---------------------------------------------------------------------------
create or replace function private.network_request_status_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('accepted', 'declined', 'withdrawn')
     and new.status is distinct from old.status then
    raise exception
      'network_connection_requests.status is terminal and immutable (was %, tried to set %)',
      old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function private.network_request_status_transition_guard() is
  'BEFORE UPDATE guard on public.network_connection_requests: refuses any change of status once it is terminal (accepted/declined/withdrawn), so a stray PATCH cannot un-decline a request or revive a withdrawn one. Raises 23514 (check_violation) to read like the constraint it is. Allows pending->terminal (the only real transition) and same-value UPDATEs. DEFENCE IN DEPTH behind the two UPDATE policies'' WITH CHECK clauses, which pin the LANDING value but not the transition -- without this, a recipient could PATCH `declined` straight to `accepted` and satisfy the WITH CHECK, because accepted is a permitted landing value. Modelled on private.guard_document_scan_status (20260902031000).';

revoke all on function private.network_request_status_transition_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_status_transition on public.network_connection_requests;
create trigger guard_status_transition
  before update on public.network_connection_requests
  for each row
  execute function private.network_request_status_transition_guard();
