-- Phase 4 (Operations), Task 2: the RLS policies on the nine tables
-- 20260902000000-002000 shipped with `enable row level security` and ZERO
-- policies -- tasks, meetings, notes, documents, the four *_links, and the
-- dormant document_versions.
--
-- That was the safe order ("RLS on before access") and it opened the SAME named
-- interval events opened in Phase 3: schema_invariants.sql D4 (`9`), D5 (`25`)
-- and D11b (`22`) have been red since Task 1. THIS FILE CLOSES IT. Those three
-- assertions already carry the post-Task-2 numbers -- 0, 0 and 39 -- so nothing
-- in that file needs editing; a reviewer checks they went GREEN rather than that
-- they were silenced. D11b's 39 is a Task-1 PREDICTION of the shapes below
-- (22 + 16 for the four *_links x four expressions + 1 for document_versions);
-- it is confirmed by this file turning it green.
--
-- ADDITIVE. `create policy`, never `alter` -- these are all new. `create or
-- replace policy` does not exist in PostgreSQL (42601 on 17.6).
--
-- ===========================================================================
-- THREE OF THE FOUR TOP-LEVEL TABLES ARE A STRAIGHT events COPY. NOTES IS NOT.
-- ===========================================================================
-- tasks, meetings and documents are the `events` block of 20260901011000 with
-- the table and key swapped: SELECT on view_crm + record scope; INSERT/UPDATE on
-- the entity's own manage key + crm_write_organisations() + record scope, UPDATE
-- adding entity_org_unchanged. Record scope = a standard_user / read_only reads
-- and writes only rows where owner_user_id = auth.uid(), because
-- full_scope_organisations() excludes those two roles.
--
-- The four *_links tables are the `event_lineup` block: scoped BY THEIR ONE
-- PARENT via an inline `exists`, the tenant-correlation term
-- `p.organisation_id = <link>.organisation_id` in every policy (D11), and
-- `p.deleted_at is null` on the three WRITE policies only, never on SELECT (a
-- soft-deleted parent's links stay readable so the restore path can show what
-- restoring brings back). Their polymorphic TARGET end is the one place a helper
-- is correct rather than forbidden -- see § 5.
--
-- The shape rules and the entitlement-gate placement are 20260828140500's and
-- 20260901011000's, obeyed not re-reasoned: the SET FORM only (never
-- has_permission per row -- measured 200x, § OB is the guard); crm_write in
-- WITH CHECK only (a Free-tier UPDATE refusal must be a loud 42501, not a
-- success-shaped 204); no DELETE policy and no DELETE grant anywhere (soft
-- delete is an UPDATE of deleted_at, Task 1 granted only select/insert/update).
--
-- ===========================================================================
-- 1. public.tasks -- the ordinary events shape, on manage_tasks
-- ===========================================================================
create policy "tasks_select_view_crm"
  on public.tasks for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "tasks_select_view_crm" on public.tasks is
  'PERMITS: reading tasks of an organisation the caller holds view_crm in -- all of them for a full-scope role, only their own for a record-scoped one (standard_user, read_only). DOES NOT PERMIT: reading another tenant''s tasks, or reading below aal2 for the MFA-gated roles. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS (deleted_at is not a term): the restore path and the detail page both read them, the application filters. NOT entitlement-gated: reads stay open on Free and while suspended (Q6).';

create policy "tasks_insert_manage_tasks"
  on public.tasks for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_tasks'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "tasks_insert_manage_tasks" on public.tasks is
  'PERMITS: creating a task in an organisation the caller holds manage_tasks in, on a plan that permits CRM writes, owned by themselves if their role is record-scoped. DOES NOT PERMIT: creating one in another tenant (42501); creating one for finance, marketing or read_only, none of which hold the key; a record-scoped user creating one owned by somebody else. crm_write is in WITH CHECK (where 20260828140500 put it on every CRM write policy) and is INERT today (crm_write_organisations() exempts orgs with no subscription row).';

create policy "tasks_update_manage_tasks"
  on public.tasks for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_tasks'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_tasks'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('task', id, organisation_id)
  );
comment on policy "tasks_update_manage_tasks" on public.tasks is
  'PERMITS: editing, soft-deleting (deleted_at := now()) and restoring a task the caller may write -- all three are UPDATEs, there is no DELETE policy or grant. DOES NOT PERMIT: moving a task to another organisation, which private.entity_org_unchanged(''task'', ...) refuses by comparing the NEW organisation_id against the statement-start snapshot -- the tenant-to-tenant transfer a two-org admin could otherwise do in one statement; a record-scoped user claiming another user''s task (USING filters it first -> ok(0)) or giving their own away (WITH CHECK -> 42501). crm_write is in WITH CHECK ONLY, so a Free-tier refusal is a 42501, not a 204.';

-- ===========================================================================
-- 2. public.meetings -- identical shape, on manage_meetings
-- ===========================================================================
create policy "meetings_select_view_crm"
  on public.meetings for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "meetings_select_view_crm" on public.meetings is
  'The tasks_select_view_crm shape, one table along -- view_crm to read, record scope for standard_user / read_only, soft-deleted rows deliberately not hidden. See tasks_select_view_crm.';

create policy "meetings_insert_manage_meetings"
  on public.meetings for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_meetings'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "meetings_insert_manage_meetings" on public.meetings is
  'The tasks_insert_manage_tasks shape, on manage_meetings. crm_write in WITH CHECK, inert today. See tasks_insert_manage_tasks.';

create policy "meetings_update_manage_meetings"
  on public.meetings for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_meetings'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_meetings'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('meeting', id, organisation_id)
  );
comment on policy "meetings_update_manage_meetings" on public.meetings is
  'The tasks_update_manage_tasks shape, on manage_meetings, with entity_org_unchanged(''meeting'', ...). See tasks_update_manage_tasks.';

-- ===========================================================================
-- 3. public.documents -- identical shape, on manage_documents
-- ===========================================================================
-- SELECT DOES NOT FILTER scan_status, DELIBERATELY. A pending or quarantined
-- document's METADATA row is readable by anyone who can read the document --
-- the uploader has to be able to see that their own file is being scanned, or
-- was quarantined, and why. Only the BYTES are gated, at the signed-URL path in
-- Task 5, which refuses anything but scan_status='clean'. A `scan_status='clean'`
-- term added HERE would hide a quarantined file's own status from the person who
-- uploaded it and present as a lost upload. § OH is the assertion that keeps it
-- off, structurally.
create policy "documents_select_view_crm"
  on public.documents for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "documents_select_view_crm" on public.documents is
  'The tasks_select_view_crm shape -- view_crm to read, record scope for standard_user / read_only. DOES NOT FILTER scan_status: a pending/quarantined document''s metadata row is readable so the uploader sees its state; only the bytes are gated, at the download path (Task 5). A scan_status term here would hide a quarantined file''s status from its own uploader -- § OH keeps it off. Soft-deleted rows deliberately not hidden.';

create policy "documents_insert_manage_documents"
  on public.documents for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_documents'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "documents_insert_manage_documents" on public.documents is
  'The tasks_insert_manage_tasks shape, on manage_documents. Records the METADATA row; the storage-key discipline (20260902001000) and the upload/scan pipeline (Task 4/5) are separate controls. crm_write in WITH CHECK, inert today.';

create policy "documents_update_manage_documents"
  on public.documents for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_documents'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_documents'))
    and organisation_id in (select private.crm_write_organisations())
    and (
      organisation_id in (select private.full_scope_organisations())
      or owner_user_id = (select auth.uid())
    )
    and private.entity_org_unchanged('document', id, organisation_id)
  );
comment on policy "documents_update_manage_documents" on public.documents is
  'The tasks_update_manage_tasks shape, on manage_documents, with entity_org_unchanged(''document'', ...). Soft delete and the scan-status transition (Task 5) are both UPDATEs; the scan-state guard is a separate trigger, not a policy term here. See tasks_update_manage_tasks.';

-- ===========================================================================
-- 4. public.notes -- THE NEW VISIBILITY SHAPE
-- ===========================================================================
-- notes carry a per-row `visibility` flag ('private' | 'company') that the five
-- Phase 2 entities do not, and it changes the SELECT predicate from the
-- record-scope one every other entity uses to a VISIBILITY one:
--
--   * a 'company' note reaches EVERY view_crm holder in the org -- including a
--     record-scoped standard_user who did not write it. There is NO
--     full_scope_organisations() term, on purpose: notes are scoped by
--     visibility, not by owner-record scope. § OD4 is the assertion that pins
--     this, and adding a full_scope term is the mutation it catches.
--   * a 'private' note reaches ONLY its author -- not even an Admin who did not
--     write it (full-scope does not override 'private'). § OD2 pins that.
--
-- WRITES ARE AUTHOR-ONLY. 'private' is an author-only VISIBILITY and NOT an ACL
-- (the finer per-user note ACL is Q44, deferred): INSERT pins
-- owner_user_id = auth.uid() for EVERYONE, so a note is always authored by its
-- writer with no "create on behalf of"; UPDATE keeps owner_user_id = auth.uid()
-- in BOTH USING and WITH CHECK, so only the author edits or soft-deletes a note
-- and its authorship can be neither reassigned nor claimed. There is deliberately
-- no full_scope disjunction on the write side either: an Admin does not edit
-- another user's note in v1.
create policy "notes_select_by_visibility"
  on public.notes for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      visibility = 'company'
      or owner_user_id = (select auth.uid())
    )
  );
comment on policy "notes_select_by_visibility" on public.notes is
  'THE PRD BINARY, IN THE DATABASE. PERMITS: reading any ''company'' note in an org the caller holds view_crm in (a record-scoped standard_user sees company notes they did not write -- § OD4), and reading one''s OWN ''private'' note. DOES NOT PERMIT: reading another user''s ''private'' note under ANY role -- there is no full_scope_organisations() term, so ''private'' is not overridden by full scope, and an Admin who did not write it reads 0 (§ OD2); reading another tenant''s notes. ''private'' is an author-only VISIBILITY, not an ACL -- the per-user note ACL is Q44, deferred. Soft-deleted rows deliberately not hidden.';

create policy "notes_insert_manage_notes"
  on public.notes for insert to authenticated
  with check (
    organisation_id in (select private.permitted_organisations('manage_notes'))
    and organisation_id in (select private.crm_write_organisations())
    and owner_user_id = (select auth.uid())
  );
comment on policy "notes_insert_manage_notes" on public.notes is
  'PERMITS: creating a note in an org the caller holds manage_notes in, on a CRM-write plan, ALWAYS authored by themselves. DOES NOT PERMIT: creating a note owned by somebody else -- owner_user_id = auth.uid() is pinned for everyone including full-scope roles, because a note is authored by its writer (no create-on-behalf-of); creating one for finance/marketing/read_only, none of which hold the key; another tenant (42501). crm_write in WITH CHECK, inert today. Q44.';

create policy "notes_update_manage_notes"
  on public.notes for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('manage_notes'))
    and owner_user_id = (select auth.uid())
  )
  with check (
    organisation_id in (select private.permitted_organisations('manage_notes'))
    and organisation_id in (select private.crm_write_organisations())
    and owner_user_id = (select auth.uid())
    and private.entity_org_unchanged('note', id, organisation_id)
  );
comment on policy "notes_update_manage_notes" on public.notes is
  'PERMITS: the AUTHOR editing, changing the visibility of, soft-deleting and restoring their OWN note -- all UPDATEs, no DELETE policy or grant. DOES NOT PERMIT: editing a note somebody else authored, even a ''company'' one visible to the caller (USING requires owner_user_id = auth.uid() -> a non-author matches 0 rows); CLAIMING a note by rewriting owner_user_id to oneself (WITH CHECK also requires owner_user_id = auth.uid(), and the row''s pre-image is owned by another, so the USING clause never admits it) -- authorship is neither reassigned nor claimed; moving it to another organisation (entity_org_unchanged(''note'', ...)). No full_scope term on either clause: an Admin does not edit another user''s note in v1 (Q44).';

-- ===========================================================================
-- 5. THE FOUR *_links TABLES -- the event_lineup shape, PLUS a polymorphic
--    TARGET check that is the one place a helper is correct.
-- ===========================================================================
-- Each link has TWO ends and exactly one of them is its scope:
--
--   * THE PARENT (parent_id -> tasks/meetings/notes/documents) is the scope,
--     inlined as `exists (select 1 from public.<parent> p ...)`. The planner
--     hoists the inline form; a SECURITY DEFINER helper here would be a per-row
--     SubPlan (measured 12830 ms -> 19.6 ms on venue_rooms). The
--     tenant-correlation term `p.organisation_id = <link>.organisation_id` is in
--     EVERY policy -- D11 asserts it structurally, § OE behaviourally with the
--     composite FK lifted. `p.deleted_at is null` on the three WRITE policies
--     only: a soft-deleted parent''s links stay READABLE, never WRITABLE.
--
--   * THE TARGET (entity_type, entity_id) is POLYMORPHIC -- it can be any of the
--     six CRM entities -- so there is no single parent table to inline against,
--     and this is the ONE exception to "no helper in a policy" (Global
--     Constraint 3). It calls private.entity_is_visible(entity_type, entity_id,
--     organisation_id), NOT entity_is_manageable: LINKING A TASK TO SOMETHING
--     YOU CAN SEE IS LEGITIMATE EVEN IF YOU CANNOT EDIT IT -- exactly
--     20260828235000''s decision that the company end of a contact-company link
--     is link-to-something-visible, not manage-gated. A full-scope Booker (no
--     manage_venues) linking a task to a venue they can see is the case § OF
--     asserts; switching this to entity_is_manageable is the mutation it catches.
--
-- Because entity_is_visible is evaluated AS THE CALLER, a target the caller
-- cannot see collapses the link to "cannot create / drops from the reverse
-- lookup" -- the deliberate consequence, asserted so a future switch to a raw FK
-- or to entity_is_manageable goes red. entity_is_visible does NOT filter
-- deleted_at (it has no such term -- confirmed against the deployed body), so a
-- link to a soft-deleted-but-otherwise-visible target is ALLOWED and the
-- application decides; § OF documents that in a labelled assertion.
--
-- The parent scope for task/meeting/document links is the record-scope
-- disjunction (full_scope OR owner). For NOTE links it is the NOTE''s own
-- author-only model: SELECT mirrors notes'' visibility (company OR author),
-- WRITE requires authorship (owner_user_id = auth.uid()) -- you link only a note
-- you can respectively see / have authored, never via full scope.

-- ---- task_links -> tasks / manage_tasks (record scope) --------------------
create policy "task_links_select_via_task"
  on public.task_links for select to authenticated
  using (
    exists (
      select 1 from public.tasks p
      where p.id = task_links.parent_id
        and p.organisation_id = task_links.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      task_links.entity_type, task_links.entity_id, task_links.organisation_id)
  );
comment on policy "task_links_select_via_task" on public.task_links is
  'PERMITS: reading a link whose PARENT task the caller can read AND whose TARGET the caller can see. Includes links on a soft-deleted task (p.deleted_at is null is absent HERE, present on the writes). DOES NOT PERMIT: reading a row whose own organisation_id disagrees with its task''s -- p.organisation_id = task_links.organisation_id is the only thing standing there if task_links_parent_fkey is ever narrowed (§ OE); reading a link whose target the caller cannot see (entity_is_visible, as the caller) -- a link to a now-invisible target drops out of the reverse lookup rather than leaking the target''s existence.';

create policy "task_links_insert_via_task"
  on public.task_links for insert to authenticated
  with check (
    task_links.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.tasks p
      where p.id = task_links.parent_id
        and p.organisation_id = task_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_tasks'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      task_links.entity_type, task_links.entity_id, task_links.organisation_id)
  );
comment on policy "task_links_insert_via_task" on public.task_links is
  'PERMITS: hanging a link off a LIVE task the caller may write, to a target the caller can SEE. DOES NOT PERMIT: a target the caller cannot see -- entity_is_visible, NOT entity_is_manageable, so linking to a see-but-not-manage record succeeds (§ OF) and a cross-tenant target refuses; a soft-deleted parent (p.deleted_at is null); a parent in another tenant (42501 from the correlation, and 23503 from task_links_parent_fkey for any writer RLS does not reach); a plan with no CRM writes.';

create policy "task_links_update_via_task"
  on public.task_links for update to authenticated
  using (
    exists (
      select 1 from public.tasks p
      where p.id = task_links.parent_id
        and p.organisation_id = task_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_tasks'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    task_links.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('task_link', task_links.id, task_links.organisation_id)
    and exists (
      select 1 from public.tasks p
      where p.id = task_links.parent_id
        and p.organisation_id = task_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_tasks'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      task_links.entity_type, task_links.entity_id, task_links.organisation_id)
  );
comment on policy "task_links_update_via_task" on public.task_links is
  'PERMITS: soft-deleting and restoring a link on a LIVE task the caller may write (a link is created and soft-deleted, re-pointed never). DOES NOT PERMIT: any of it while the task is soft-deleted (p.deleted_at is null in both clauses); moving the link to another organisation (entity_org_unchanged(''task_link'', ...) -- the composite FK does not pin that, 20260828140500 IMP-3); a WITH CHECK whose target the caller cannot see. entity_is_visible is in WITH CHECK, not USING: soft-deleting a link whose target became invisible is not blocked.';

-- ---- meeting_links -> meetings / manage_meetings (record scope) ------------
create policy "meeting_links_select_via_meeting"
  on public.meeting_links for select to authenticated
  using (
    exists (
      select 1 from public.meetings p
      where p.id = meeting_links.parent_id
        and p.organisation_id = meeting_links.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      meeting_links.entity_type, meeting_links.entity_id, meeting_links.organisation_id)
  );
comment on policy "meeting_links_select_via_meeting" on public.meeting_links is
  'The task_links_select_via_task shape, parent = meetings. A meeting_links row with entity_type=''contact'' is what puts "met with" on a contact''s timeline, so its visibility must follow the meeting''s. See task_links_select_via_task.';

create policy "meeting_links_insert_via_meeting"
  on public.meeting_links for insert to authenticated
  with check (
    meeting_links.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.meetings p
      where p.id = meeting_links.parent_id
        and p.organisation_id = meeting_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_meetings'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      meeting_links.entity_type, meeting_links.entity_id, meeting_links.organisation_id)
  );
comment on policy "meeting_links_insert_via_meeting" on public.meeting_links is
  'The task_links_insert_via_task shape, parent = meetings, key = manage_meetings. entity_is_visible on the target. See task_links_insert_via_task.';

create policy "meeting_links_update_via_meeting"
  on public.meeting_links for update to authenticated
  using (
    exists (
      select 1 from public.meetings p
      where p.id = meeting_links.parent_id
        and p.organisation_id = meeting_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_meetings'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    meeting_links.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('meeting_link', meeting_links.id, meeting_links.organisation_id)
    and exists (
      select 1 from public.meetings p
      where p.id = meeting_links.parent_id
        and p.organisation_id = meeting_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_meetings'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      meeting_links.entity_type, meeting_links.entity_id, meeting_links.organisation_id)
  );
comment on policy "meeting_links_update_via_meeting" on public.meeting_links is
  'The task_links_update_via_task shape, parent = meetings, entity_org_unchanged(''meeting_link'', ...). See task_links_update_via_task.';

-- ---- note_links -> notes / manage_notes (AUTHOR-ONLY, visibility on read) --
create policy "note_links_select_via_note"
  on public.note_links for select to authenticated
  using (
    exists (
      select 1 from public.notes p
      where p.id = note_links.parent_id
        and p.organisation_id = note_links.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.visibility = 'company'
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      note_links.entity_type, note_links.entity_id, note_links.organisation_id)
  );
comment on policy "note_links_select_via_note" on public.note_links is
  'PARENT SCOPE MIRRORS THE NOTE''S VISIBILITY, not owner-record scope: a link on a ''company'' note is readable by every view_crm holder, a link on a ''private'' note only by the note''s author -- the same binary notes_select_by_visibility applies, so a private note''s links never leak. Plus entity_is_visible on the target. Tenant-correlation p.organisation_id = note_links.organisation_id (§ OE / D11).';

create policy "note_links_insert_via_note"
  on public.note_links for insert to authenticated
  with check (
    note_links.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.notes p
      where p.id = note_links.parent_id
        and p.organisation_id = note_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_notes'))
        and p.owner_user_id = (select auth.uid())
    )
    and private.entity_is_visible(
      note_links.entity_type, note_links.entity_id, note_links.organisation_id)
  );
comment on policy "note_links_insert_via_note" on public.note_links is
  'AUTHOR-ONLY, mirroring notes'' write model: p.owner_user_id = auth.uid() (no full_scope disjunction) -- you link only a note YOU authored, on a live note, to a target you can SEE (entity_is_visible, not manageable). DOES NOT PERMIT: linking another user''s note even a company one; a soft-deleted note; another tenant; a plan with no CRM writes.';

create policy "note_links_update_via_note"
  on public.note_links for update to authenticated
  using (
    exists (
      select 1 from public.notes p
      where p.id = note_links.parent_id
        and p.organisation_id = note_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_notes'))
        and p.owner_user_id = (select auth.uid())
    )
  )
  with check (
    note_links.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('note_link', note_links.id, note_links.organisation_id)
    and exists (
      select 1 from public.notes p
      where p.id = note_links.parent_id
        and p.organisation_id = note_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_notes'))
        and p.owner_user_id = (select auth.uid())
    )
    and private.entity_is_visible(
      note_links.entity_type, note_links.entity_id, note_links.organisation_id)
  );
comment on policy "note_links_update_via_note" on public.note_links is
  'The author-only note_links_insert_via_note shape for soft-delete/restore, plus entity_org_unchanged(''note_link'', ...). Only the note''s author touches its links, on a live note. See note_links_insert_via_note.';

-- ---- document_links -> documents / manage_documents (record scope) --------
create policy "document_links_select_via_document"
  on public.document_links for select to authenticated
  using (
    exists (
      select 1 from public.documents p
      where p.id = document_links.parent_id
        and p.organisation_id = document_links.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      document_links.entity_type, document_links.entity_id, document_links.organisation_id)
  );
comment on policy "document_links_select_via_document" on public.document_links is
  'The task_links_select_via_task shape, parent = documents. Scope of the attachment is the document''s. See task_links_select_via_task.';

create policy "document_links_insert_via_document"
  on public.document_links for insert to authenticated
  with check (
    document_links.organisation_id in (select private.crm_write_organisations())
    and exists (
      select 1 from public.documents p
      where p.id = document_links.parent_id
        and p.organisation_id = document_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_documents'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      document_links.entity_type, document_links.entity_id, document_links.organisation_id)
  );
comment on policy "document_links_insert_via_document" on public.document_links is
  'The task_links_insert_via_task shape, parent = documents, key = manage_documents. Attaches a live document to a target the caller can SEE. See task_links_insert_via_task.';

create policy "document_links_update_via_document"
  on public.document_links for update to authenticated
  using (
    exists (
      select 1 from public.documents p
      where p.id = document_links.parent_id
        and p.organisation_id = document_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_documents'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  )
  with check (
    document_links.organisation_id in (select private.crm_write_organisations())
    and private.entity_org_unchanged('document_link', document_links.id, document_links.organisation_id)
    and exists (
      select 1 from public.documents p
      where p.id = document_links.parent_id
        and p.organisation_id = document_links.organisation_id
        and p.deleted_at is null
        and p.organisation_id in (select private.permitted_organisations('manage_documents'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
    and private.entity_is_visible(
      document_links.entity_type, document_links.entity_id, document_links.organisation_id)
  );
comment on policy "document_links_update_via_document" on public.document_links is
  'The task_links_update_via_task shape, parent = documents, entity_org_unchanged(''document_link'', ...). See task_links_update_via_task.';

-- ===========================================================================
-- 6. public.document_versions -- SELECT-ONLY, DORMANT (Release 1.1)
-- ===========================================================================
-- One policy, SELECT, scoped through its document exactly as the *_links read
-- side is. Task 1 granted only SELECT (no write grant), so there is NO INSERT /
-- UPDATE / DELETE policy -- file versioning is out of MVP scope (Global
-- Constraint / Scope discipline) and this table has no write path until 1.1.
-- D5 asserts the biconditional, so a write policy added here without a grant is
-- as red as a grant without a policy.
create policy "document_versions_select_via_document"
  on public.document_versions for select to authenticated
  using (
    exists (
      select 1 from public.documents p
      where p.id = document_versions.document_id
        and p.organisation_id = document_versions.organisation_id
        and p.organisation_id in (select private.permitted_organisations('view_crm'))
        and (
          p.organisation_id in (select private.full_scope_organisations())
          or p.owner_user_id = (select auth.uid())
        )
    )
  );
comment on policy "document_versions_select_via_document" on public.document_versions is
  'PERMITS: reading a version row whose parent document the caller can read, tenant-correlated (p.organisation_id = document_versions.organisation_id, D11). DORMANT: file versioning is out of MVP scope, this table has no write path or write grant until Release 1.1, so there is deliberately no INSERT/UPDATE/DELETE policy. The single SELECT policy exists so the read grant Task 1 issued is justified (D5).';
