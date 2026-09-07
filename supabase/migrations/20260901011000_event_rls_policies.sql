-- Phase 3 (Events), Task 2b: the six RLS policies on public.events and
-- public.event_lineup, and the `event_lineup` arm of
-- private.entity_org_unchanged() that one of them calls.
--
-- 20260901000000 shipped both tables with `enable row level security` and ZERO
-- policies, which is the safe order ("RLS on before access") and which opened
-- a named interval: schema_invariants.sql D4 (`2`), D5 (`6`) and D11b (`17`)
-- have been red since. THIS FILE CLOSES IT. Those three assertions already
-- carry the post-Task-2 numbers -- 0, 0 and 21 -- so nothing in that file
-- needed editing; a reviewer checks they went GREEN rather than that they were
-- silenced.
--
-- ADDITIVE. `create policy`, never `alter`, because there is nothing to alter:
-- these six are new. `create or replace policy` does not exist in PostgreSQL
-- (42601 on the pinned 17.6) -- 20260828122000's header records the same.
--
-- SIX, NOT SEVEN. The task brief said seven and this header said it too until
-- fix round 1. Three per table -- SELECT, INSERT, UPDATE -- which is exactly
-- the venues / venue_rooms shape they are copied from, and there is no DELETE
-- policy because there is no DELETE grant. The seven is an arithmetic slip
-- over schema_invariants.sql D11b's 21, which counts policy EXPRESSIONS
-- rather than policies: UPDATE contributes two (USING and WITH CHECK), so
-- event_lineup's three policies are four expressions, 17 + 4 = 21.
--
-- ===========================================================================
-- THE SHAPE IS COPIED, NOT INVENTED
-- ===========================================================================
-- `events` is the `venues` block of 20260828121000 with the table and the key
-- changed; `event_lineup` is the `venue_rooms` block of the same file, as
-- 20260829001000 left it, with the same two substitutions. Three shape rules
-- are being obeyed and each has a measurement behind it:
--
--   1. THE SET FORM, NEVER THE PER-ROW FORM.
--      `organisation_id in (select private.permitted_organisations('key'))`,
--      never `public.has_permission(organisation_id, 'key')`. The subquery has
--      no correlation to the row, so the planner hoists it to an InitPlan and
--      evaluates it ONCE per statement; the per-row form was measured at
--      5210 ms for a fifty-row page where the set form takes 23 ms
--      (20260828120500's header). Both forms return identical rows for every
--      user, so no behavioural assertion can tell them apart -- which is why
--      rls_phase3_events.sql § EB carries the structural guard, in the style
--      of rls_phase2_crm.sql H12/H13.
--
--   2. THE CHILD IS SCOPED BY ITS ONE PARENT, INLINE.
--      `exists (select 1 from public.events p where ...)` written out in the
--      policy rather than hidden behind a helper function. 20260828121000
--      design note (b): a helper here would be evaluated per row as a SubPlan
--      (measured: a 50,000-row venue_rooms page went 12830 ms -> 19.6 ms when
--      the inline form replaced it), and the dependency graph stays acyclic --
--      no policy on `events` names `event_lineup`.
--
--   3. THE TENANT CORRELATION TERM IS NOT OPTIONAL.
--      `p.organisation_id = event_lineup.organisation_id` appears in all four
--      lineup policies. It is what D11 asserts structurally and what
--      rls_phase3_events.sql § EF asserts behaviourally with the composite FK
--      lifted -- the § Y technique. Removing it left the ENTIRE Phase 2 suite
--      green (843 psql assertions, 174 HTTP checks) when it was tried on
--      venue_rooms, because `event_lineup_event_fkey (event_id,
--      organisation_id)` makes the two columns agree by construction while it
--      holds. The FK and the policy term are each other's only backstop.
--
-- ===========================================================================
-- THE ENTITLEMENT GATE -- FOLLOWED, NOT INVENTED
-- ===========================================================================
-- 20260828140500's header fixes where `private.crm_write_organisations()` goes
-- on all 25 existing CRM write policies, and these follow it exactly:
--
--   INSERT -> WITH CHECK.  The only clause an INSERT policy has.
--   UPDATE -> WITH CHECK ONLY, deliberately NOT USING.
--   SELECT -> nowhere. Reads are not entitlement-gated: CLAUDE.md
--             § Subscription tiers makes Free a READ tier, and gating reads
--             would mean a downgrade hides a customer's existing data.
--
-- Putting it in an UPDATE's USING as well would be symmetric and worse: the
-- row would stop matching, and PostgREST would answer `204 No Content` for a
-- refusal instead of `403`, which is indistinguishable from success. A
-- Free-tier user editing an event should be told they cannot.
--
-- SECURITY.md § 10 records that this gate is currently INERT by design --
-- crm_write_organisations() has an `s.organisation_id is null` branch and
-- create_organisation() writes no subscription row -- so a divergence here
-- would be invisible today and would surface in Phase 7, when the escape
-- branch is removed. That is exactly why the shape is copied rather than
-- reasoned about afresh.
--
-- ===========================================================================
-- NO DELETE POLICY, NO DELETE GRANT
-- ===========================================================================
-- Both tables carry `deleted_at` and 20260901000000 granted only
-- SELECT/INSERT/UPDATE. Soft delete is an UPDATE of `deleted_at`; restore is
-- the same UPDATE in reverse, which is why SELECT must keep reaching
-- soft-deleted rows (design note (g)). schema_invariants.sql D5 asserts the
-- biconditional in both directions, so adding a DELETE policy without a grant
-- is as red as adding the grant without the policy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- private.entity_org_unchanged() -- the `event_lineup` arm.
--
-- 20260901001000 wrote, in the function body itself:
--
--     `event_lineup` is NOT here: it has no UPDATE policy until Task 2, and
--     20260901010000 owns adding both together for the same reason
--     entity_is_manageable's event arm waits.
--
-- The arm lands HERE rather than in 20260901010000 because "both together"
-- means together with THE POLICY THAT CALLS IT, and the policy is in this
-- file. 20260901010000 is the file the key had to be in; this is the file the
-- policy is in. The stale file reference in the deployed comment is corrected
-- below rather than left to be rediscovered -- 20260901001000 itself must not
-- be edited.
--
-- WHY event_lineup NEEDS IT AT ALL, when its policy already reaches EXISTS
-- against the parent: the child's own `organisation_id` is a column the client
-- supplies, and 20260828140500's IMP-3 measured that the composite FK does NOT
-- pin it -- the FK constrains the NEW pair, so a caller authorised in both
-- tenants moves the child and its parent reference in ONE statement and the
-- constraint is satisfied. That is why all five Phase 2 child/join tables with
-- an UPDATE policy carry this term, and `event_lineup` is the sixth.
-- Mirrored deliberately: `venue_rooms_update_via_venue`
-- (20260829001000:155) is the template, and it has it.
--
-- The body below is the deployed one (pg_get_functiondef) plus one arm.
-- ---------------------------------------------------------------------------
create or replace function private.entity_org_unchanged(
  p_entity_type text, p_id uuid, p_org_id uuid)
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
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. THIRTEEN tables since Phase 3 Task 2: the five Phase 2 top-level entities plus public.events, custom_field_definitions, and the six child/join tables with an UPDATE policy. public.event_lineup was added by 20260901011000, alongside event_lineup_update_via_event which calls it -- CORRECTING 20260901001000''s comment, which named 20260901010000 for that arm before the split between "the file that seeds the key" and "the file that writes the policy" was settled. Fail-closed if p_id names no row.';

-- ===========================================================================
-- 1. public.events -- the top-level entity
-- ===========================================================================
-- The `venues` block, table and key swapped. `view_crm` to read,
-- `manage_events` to write, record scope on `owner_user_id` for the roles
-- private.full_scope_organisations() excludes (standard_user and read_only).
--
-- events.owner_user_id carries `default auth.uid()` (20260901000000), which is
-- what makes the INSERT policy's record-scope disjunction satisfiable for a
-- Standard User who supplies no owner: without the default the row would
-- arrive unowned and be instantly invisible to its own creator, which is the
-- defect 20260828001134 § 2 fixed on the other five top-level entities.
-- ===========================================================================

create policy "events_select_view_crm"
  on public.events for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

comment on policy "events_select_view_crm" on public.events is
  'PERMITS: reading events of an organisation the caller holds view_crm in -- all of them for a full-scope role, only their own for a record-scoped one (standard_user, read_only). DOES NOT PERMIT: reading another tenant''s events under any role, or reading at all below aal2 for owner/admin/finance, whose permissions are MFA-gated (20260827210000) -- the read gate closes for them with no separate term here. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS: `deleted_at` is not a term, because the restore path and the detail page''s "Deleted" notice both read the row (20260828121000 design note (g)); the application filters. NOT entitlement-gated: reads stay open on Free and in a suspended organisation (Q6), which is why `view_crm` is the one permission with survives_suspension = true.';

create policy "events_insert_manage_events"
  on public.events for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_events'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );

comment on policy "events_insert_manage_events" on public.events is
  'PERMITS: creating an event in an organisation the caller holds manage_events in, on a plan that permits CRM writes, owned by themselves if their role is record-scoped. DOES NOT PERMIT: creating one in another tenant (42501, not a silent 0 -- an INSERT has only WITH CHECK); creating one for finance, marketing or read_only, none of which hold the key; a record-scoped user creating one owned by somebody else. The entitlement term is in WITH CHECK because that is where 20260828140500 put it on all 25 existing CRM write policies -- and it is INERT today (SECURITY.md § 10) because crm_write_organisations() exempts organisations with no subscription row, which is every organisation.';

create policy "events_update_manage_events"
  on public.events for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_events'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_events'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('event', id, organisation_id)
  );

comment on policy "events_update_manage_events" on public.events is
  'PERMITS: editing, soft-deleting (deleted_at := now()) and restoring (deleted_at := null) an event the caller may write -- all three are UPDATEs, there is no DELETE policy and no DELETE grant. DOES NOT PERMIT: moving an event to another organisation, which private.entity_org_unchanged(''event'', ...) refuses by comparing the NEW organisation_id against the row as it stands on the statement-start snapshot -- the tenant-to-tenant transfer a user who is an admin of two organisations could otherwise perform in one statement; a record-scoped user claiming another user''s event by rewriting owner_user_id (the USING clause filters it out first, so that is ok(0), not 42501) or giving their own away (WITH CHECK, so 42501). The entitlement term is in WITH CHECK ONLY, deliberately: in USING it would turn a Free-tier refusal into PostgREST''s 204 No Content, which is indistinguishable from success.';

-- ===========================================================================
-- 2. public.event_lineup -- scoped by the EVENT, on manage_events
-- ===========================================================================
-- Structurally `venue_rooms`: one parent, its own organisation_id, no
-- owner_user_id of its own (a slot's record scope is its event's).
--
-- ---------------------------------------------------------------------------
-- THE ARTIST END IS NOT A POLICY TERM, AND THAT IS DELIBERATE
-- ---------------------------------------------------------------------------
-- A lineup row names TWO parents -- the event and the artist -- and exactly
-- ONE of them is its scope. The event is, for the same reason venue_rooms is
-- scoped by its venue: the slot is a fact about the show.
--
-- 20260828235000's argument applies verbatim, and it is the reason there is no
-- `artists` term below:
--
--   * a policy predicate is EVALUATED AS THE CALLER. A term reading
--     public.artists would be filtered by artists_select_view_crm.
--   * so for a record-scoped user who owns the event and does NOT own the
--     artist -- an ordinary case, since a Standard User's artists are their
--     own and the roster is shared -- "the artist is deleted" would collapse
--     into "I cannot see the artist", and the policy would start refusing
--     perfectly legitimate writes against perfectly live artists.
--
-- WHAT ACTUALLY GUARDS THE ARTIST END, and neither of these is this policy:
--   * `event_lineup_artist_fkey (artist_id, organisation_id)` -- tenant-scoped
--     and composite, 23503, for EVERY writer in every role including postgres.
--     That is what stops a lineup row naming another tenant's artist.
--   * `liveInOrg(supabase, "artists", org.id, artistId)` in lib/crm/events.ts
--     (Task 5) -- the ONLY thing that refuses a SOFT-DELETED artist. There is
--     no database control behind it. Do not delete it believing there is.
--
-- rls_phase3_events.sql § EH is the assertion that pins this: a record-scoped
-- user adds an artist they do not own to their own event and it succeeds. It
-- exists so that a future "helpful" edit adding an artists term goes red.
-- ---------------------------------------------------------------------------
-- `p.deleted_at is null` ON THE THREE WRITE POLICIES ONLY, NEVER ON SELECT.
-- 20260829001000's rule, applied to the third child table: a soft-deleted
-- event's lineup must stay READABLE, because the detail page renders it beside
-- the "Deleted" notice so a user can see what restoring would bring back -- and
-- must not be WRITABLE, in both USING and WITH CHECK, so a slot can be moved
-- neither off a deleted event nor on to one, and cannot be added, edited,
-- removed or restored while the event is deleted.
-- ===========================================================================

create policy "event_lineup_select_via_event"
  on public.event_lineup for select to authenticated
  using (
    exists (
      select 1 from public.events p
      where p.id = event_lineup.event_id
        and p.organisation_id = event_lineup.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "event_lineup_select_via_event" on public.event_lineup is
  'PERMITS: reading the lineup of an event the caller can read -- scope is inherited whole from the parent, since a slot has no owner_user_id of its own. Includes the lineup of a SOFT-DELETED event: `p.deleted_at is null` is deliberately absent HERE and present on the three write policies, because the restore path and the detail page both have to see what restoring would bring back. DOES NOT PERMIT: reading a row whose own organisation_id disagrees with its event''s -- `p.organisation_id = event_lineup.organisation_id` is the term that refuses it, and it is the ONLY thing standing there if event_lineup_event_fkey is ever narrowed to a single column. Nothing here reads public.artists: see this migration''s header for why, and rls_phase3_events.sql § EF/§ EH for the two assertions that hold both halves.';

create policy "event_lineup_insert_via_event"
  on public.event_lineup for insert to authenticated
  with check (
    event_lineup.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.events p
      where p.id = event_lineup.event_id
        and p.organisation_id = event_lineup.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_events'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "event_lineup_insert_via_event" on public.event_lineup is
  'PERMITS: adding an artist to a LIVE event the caller may write. DOES NOT PERMIT: adding one to an event they do not own when their role is record-scoped; to another tenant''s event (42501 from this policy, and 23503 from event_lineup_event_fkey for any writer RLS does not apply to); to a SOFT-DELETED event (`p.deleted_at is null`); or on a plan that does not permit CRM writes. IT DOES NOT CHECK THE ARTIST -- deliberately, see this migration''s header. A deleted artist is refused by lib/crm/events.ts''s liveInOrg() and by nothing else; a cross-tenant artist is refused by event_lineup_artist_fkey.';

create policy "event_lineup_update_via_event"
  on public.event_lineup for update to authenticated
  using (
    exists (
      select 1 from public.events p
      where p.id = event_lineup.event_id
        and p.organisation_id = event_lineup.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_events'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    event_lineup.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('event_lineup', event_lineup.id, event_lineup.organisation_id)
    and exists (
      select 1 from public.events p
      where p.id = event_lineup.event_id
        and p.organisation_id = event_lineup.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_events'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );

comment on policy "event_lineup_update_via_event" on public.event_lineup is
  'PERMITS: reordering, re-billing, retiming, soft-deleting and restoring a slot on a LIVE event the caller may write -- all of those are UPDATEs, since there is no DELETE policy and no DELETE grant. DOES NOT PERMIT: any of it while the event is soft-deleted -- `p.deleted_at is null` is in BOTH clauses, so a slot can be moved neither OFF a deleted event (USING sees the OLD event_id) nor ON TO one (WITH CHECK sees the NEW one); moving the slot to another organisation, which private.entity_org_unchanged(''event_lineup'', ...) refuses -- the composite FK does NOT pin that, because it constrains the NEW pair and a caller authorised in both tenants moves child and parent reference in one statement (20260828140500 IMP-3, measured); repointing a slot at an event in another tenant. IT DOES NOT CHECK THE ARTIST, on either side -- see this migration''s header.';
