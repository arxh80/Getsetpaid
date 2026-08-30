-- Phase 2 (Core CRM), Task 2 fix round 3: two Importants from the re-review.
--
--   New-1  the audit trigger ABORTS `DELETE FROM organisations` when a session
--          is set -- fix round 1 closed one abort and opened another
--   New-2  requiring both merge sides doubled an already-slow unhoistable read
--
-- Additive. No previously applied migration is edited.
--
-- ===========================================================================
-- New-1 -- AND THE CORRECTION TO WHAT I WROTE ABOUT IT
-- ===========================================================================
-- 20260828141000's header, and FOLLOW-UPS.md § Phase 7, both describe the
-- residual risk as VOLUME: "a cascade triggered by a SUPERUSER session does
-- have an auth.uid(), so it WILL emit one audit row per cascaded child row ...
-- thousands for a real tenant".
--
-- THAT IS WRONG, AND WRONG IN THE REASSURING DIRECTION. It does not emit
-- thousands of rows. It aborts the statement:
--
--   -- identical statement; the only difference is request.jwt.claims
--   no session:   DELETE FROM public.organisations WHERE id = <org>  -> DELETE 1
--   with session: ERROR:  insert or update on table "audit_events" violates
--                 foreign key constraint "audit_events_organisation_id_fkey"
--                 DETAIL:  Key (organisation_id)=(98154f15-...) is not present
--                          in table "organisations".
--                 CONTEXT: private.log_audit_event(...) <- private.audit_crm_row()
--
-- The mechanism: the organisations row goes first, the foreign-key cascade then
-- removes the contact_companies / custom_field_values children, and each
-- child's AFTER DELETE trigger inserts an audit_events row naming an
-- organisation that is already gone. audit_events.organisation_id's own
-- ON DELETE SET NULL was resolved against the rows that existed when the DELETE
-- began; a row INSERTED during the cascade gets no such treatment.
--
-- This is the third time in this task that a claim about behaviour was written
-- without being run (design note (e), the "existence oracle" note, and now
-- this), and the second time the error made the system sound safer than it was.
-- The pattern is consistent: reason about a mechanism, write the conclusion as
-- fact, do not execute the statement.
--
-- WHY IT IS IMPORTANT AND NOT CRITICAL: `authenticated` holds only SELECT and
-- UPDATE on public.organisations and there is no DELETE policy, so no client
-- can reach it. What it breaks is Phase 7's superuser organisation deletion and
-- any GDPR erasure path that runs as a user -- and DSR erasure is a legal
-- obligation with a 30-day statutory clock (CLAUDE.md § Legal). It also broke a
-- behaviour Task 1's fix round explicitly measured ("organisation delete
-- cascades cleanly, no error").
--
-- WHY THE SUITE DID NOT NOTICE: R10/R11 delete the throwaway organisation
-- SESSIONLESS, which is the branch that was already safe -- the null-actor
-- guard returns before the insert. The failing branch is the one with a
-- session, which is the branch Phase 7 will actually use. R12/R13 cover it now.
--
-- THE FIX: resolve the organisation through a live lookup instead of naming
-- old.organisation_id directly. A parent that has already vanished yields NULL,
-- which audit_events.organisation_id accepts (it is nullable), so the audit row
-- survives and the DELETE completes. An ordinary delete -- where the
-- organisation still exists -- is unaffected and still records it.
--
-- Note what this deliberately does NOT do: it does not SKIP the audit row when
-- the organisation is gone. An organisation-wide deletion is exactly the event
-- an audit trail exists for, and a row saying "this actor deleted this
-- contact_company at this time" is worth keeping even when the organisation it
-- belonged to can no longer be named.

create or replace function private.audit_crm_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- Sessionless writer: a migration, a seed, DBA repair, or a foreign-key
  -- cascade initiated by one. Not a client action, has no actor to attribute,
  -- and must not be turned into an error -- see 20260828141000's header.
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform private.log_audit_event(
      p_action          => tg_argv[0],
      p_target_type     => tg_argv[1],
      -- NEW-1. A cascade from public.organisations removes the parent BEFORE
      -- this trigger runs, and audit_events.organisation_id has a foreign key
      -- to it -- so naming old.organisation_id directly aborts the entire
      -- DELETE with 23503 whenever a session is set. Resolving it yields NULL
      -- for a vanished parent, which the nullable column accepts, so the audit
      -- row survives and the delete completes. Asserted by R12/R13, which run
      -- WITH request.jwt.claims set; R10/R11 run sessionless and never saw it.
      p_organisation_id => (select o.id from public.organisations o
                             where o.id = old.organisation_id),
      p_target_id       => old.id,
      -- Identifiers and structure only. No user-entered content: audit_events
      -- is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant
      -- record content off that surface.
      p_before          => private.audit_crm_payload(tg_argv[1], pg_catalog.to_jsonb(old))
    );
  else
    perform private.log_audit_event(
      p_action          => tg_argv[0],
      p_target_type     => tg_argv[1],
      p_organisation_id => (select o.id from public.organisations o
                             where o.id = new.organisation_id),
      p_target_id       => new.id,
      p_after           => private.audit_crm_payload(tg_argv[1], pg_catalog.to_jsonb(new))
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function private.audit_crm_row() is
  'AFTER-trigger audit writer for the irreversible CRM operations (the two hard DELETE paths and merges). Calls private.log_audit_event(), which is granted to no client role -- hence SECURITY DEFINER. Returns early with no audit row when auth.uid() is null: that is a migration, a seed or a DBA-initiated cascade rather than a client action, and log_audit_event() raises 28000 on a null actor. RESOLVES organisation_id through a live lookup rather than naming OLD/NEW directly: a cascade from public.organisations removes the parent before this trigger fires, and audit_events'' foreign key to it would otherwise abort the whole DELETE with 23503 as soon as a session is set (fix round 3, New-1). A vanished parent becomes NULL; an ordinary delete still records the organisation. The payload is filtered by private.audit_crm_payload(): identifiers and structure only, never user-entered content.';

-- ===========================================================================
-- New-2 -- merges reads were 12.3 seconds per page, and IMP-2 doubled it
-- ===========================================================================
-- Measured by the re-reviewer on 20,004 merges rows in one organisation, a
-- 50-row page, as a FULL-SCOPE role (the common case):
--
--   as shipped (winner AND loser checked)   Execution Time: 12308.137 ms
--   the pre-fix shape (winner only)          Execution Time:  6069.102 ms
--
-- merges_select_via_winner is the one CRM SELECT policy whose predicate calls a
-- function with COLUMN arguments, so neither entity_is_visible() can be
-- hoisted; each call re-runs permitted_organisations() and
-- full_scope_organisations() per row, and 20k rows cost roughly 80k
-- set-returning invocations.
--
-- THIS IS THE EXACT PATHOLOGY task-2-report.md § 3.1 DESCRIBES AND REMOVED.
-- That section deleted private.record_in_scope() for being a per-row boolean
-- helper taking a column (5210 ms -> 23 ms), and then added H12/H13 as shape
-- guards so nobody could reintroduce it. Those guards only forbid
-- `has_permission(` and require `permitted_organisations`, so a per-row
-- polymorphic dispatch walks straight past them. Half the cost predates fix
-- round 1; IMP-2 doubled it, and I measured neither.
--
-- THE FIX IS A REORDERING, NOT A WEAKENING. The hoistable full-scope term goes
-- in front, so a reader who can see every record in the organisation never
-- evaluates the per-row dispatch at all:
--
--   full-scope role     12308 ms -> 6.083 ms
--   record-scoped role             2266 ms   (unchanged in shape; see below)
--
-- The predicate is logically identical for a record-scoped reader: for them
-- `organisation_id in (select full_scope_organisations())` is false, so both
-- entity_is_visible() calls still run and IMP-2's guarantee is intact. Asserted
-- by Q3/Q4 (the leak stays closed) and Q5 (not over-closed).
--
-- ONE DELIBERATE BEHAVIOUR CHANGE, recorded rather than absorbed. For a
-- FULL-SCOPE role the dispatch is now skipped entirely, so a merge whose winner
-- or loser has been HARD-deleted becomes visible to them, where previously it
-- was invisible to everyone. That is a change, and Task 6 depends on it.
--
-- I take it as a correction rather than a regression, and the argument is the
-- one 20260828140500's own comment already makes against the state it shipped:
-- "if a loser is ever HARD-deleted, its merge record becomes invisible to
-- everyone, including the superuser's audit view. That is the correct failure
-- direction for a confidentiality control and the WRONG one for a history
-- table." A merge record whose subject has been erased is precisely when
-- someone needs to know a merge happened. And the control IMP-2 exists to
-- enforce is RECORD SCOPE -- keeping one organisation's Standard User away from
-- field values they were never entitled to -- while a full-scope role is
-- entitled to every record in that organisation by definition, so nothing is
-- disclosed to them that they could not already read.
--
-- WHAT THIS DOES NOT FIX, and Task 6 must: the record-scoped path is still
-- ~2.3 s per page at 20k rows, because for that reader the per-row polymorphic
-- dispatch is unavoidable inside a policy. A merge list for a record-scoped
-- user needs an index-backed design -- most plausibly a denormalised
-- `winner_owner_user_id` maintained by Task 6's own merge -- not a cleverer
-- predicate. Routed in FOLLOW-UPS.md.
alter policy "merges_select_via_winner" on public.merges
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      -- Hoisted into one InitPlan per statement. A full-scope role sees every
      -- merge in its own organisation and never pays the per-row dispatch.
      organisation_id in (select private.full_scope_organisations())
      or (
        private.entity_is_visible(entity_type, winner_id, organisation_id)
        and private.entity_is_visible(entity_type, loser_id,  organisation_id)
      )
    )
  );

comment on policy "merges_select_via_winner" on public.merges is
  'MISNAMED SINCE FIX ROUND 1: a record-scoped reader must be able to see BOTH the winner and the loser, because field_resolution copies the DISCARDED values of both records verbatim -- scoping by the winner alone let a Standard User read the email and phone of a contact that was never in their scope. REORDERED IN FIX ROUND 3 (New-2): the hoistable full_scope_organisations() term leads, so a full-scope role never evaluates the per-row polymorphic dispatch -- measured 12308 ms -> 6.083 ms on a 50-row page over 20k rows. Deliberate consequence: a full-scope role can now see a merge whose winner or loser has been HARD-deleted, where previously it was invisible to everyone. Taken as a correction -- a history table that loses rows when its subject is erased is the wrong failure direction, and a full-scope role is entitled to every record in the organisation anyway. The record-scoped path is unchanged in shape and still ~2.3 s at 20k rows; Task 6 owns an index-backed design for it. Renaming the policy would mean dropping and re-creating it, which these migrations deliberately avoid.';
