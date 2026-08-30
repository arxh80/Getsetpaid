-- Phase 2 (Core CRM), Task 2 fix round 1: audit the irreversible CRM writes.
--
-- IMP-5. CLAUDE.md § Non-negotiable rules: "Audit high-value actions. Actor,
-- org, timestamp, action, target, correlation ID, before/after." Task 2 opened
-- write access on twelve tables, two of which have a real hard DELETE, and
-- audited none of it.
--
-- ===========================================================================
-- THE SPLIT, AND WHY I ACCEPT IT
-- ===========================================================================
-- The coordinator routed FULL CRM write auditing to Phase 7, alongside the
-- audit log viewer, and asked for the irreversible operations now. That split
-- is right and it is not merely a scoping convenience:
--
--   * An UPDATE on a soft-deleted-everything schema is recoverable from the row
--     itself -- the row is still there. What is lost is the previous VALUE, and
--     capturing that well means a before/after diff design, a retention answer
--     for the diffs, and a viewer to read them. That is the Phase 7 feature.
--   * A hard DELETE destroys the row. There is no "after", nothing to diff
--     against, and no later task can reconstruct who did it. If it is not
--     captured at the moment it happens it is not capturable at all.
--   * A merge is destructive in the same sense: it soft-deletes the loser and
--     rewrites the winner, and CLAUDE.md § Domain entities says in terms
--     "Every merge is audited".
--
-- So: three triggers, on the two hard-DELETE paths this task opened and on
-- merges.
--
-- A TRIGGER, NOT APPLICATION CODE, for the reason report § 4.2 gave for
-- updated_at and IMP-5 correctly points out was not carried across: `grant ...
-- to authenticated` plus the anon key that ships in the browser makes
-- `DELETE /rest/v1/contact_companies?id=eq...` reachable without touching the
-- Next.js app. An application-side audit records the deletions someone
-- remembered to route through the app. The database is the only chokepoint.
-- Measured live before this migration: `manager DELETE contact_companies` -> 204,
-- `manager DELETE custom_field_values` -> 204, both with zero audit rows.
--
-- ===========================================================================
-- WHAT GOES INTO `before`, AND THE ONE THING THAT DELIBERATELY DOES NOT
-- ===========================================================================
-- The obvious implementation is `to_jsonb(old)`. It is rejected, and this is
-- the most consequential decision in this file.
--
-- public.audit_events is readable by exactly one principal: the platform
-- superuser (audit_events_select_platform_superuser). CLAUDE.md § Superuser
-- dashboard says the dashboard "never shows record content (contacts, events,
-- documents) directly -- only aggregate metadata", and § In-app feedback calls
-- the screenshot path "the ONE deliberate exception to 'no direct tenant-data
-- access outside impersonation'". Dumping a deleted row's payload into
-- audit_events would quietly create a second exception -- a superuser-readable
-- channel carrying custom field values and merge field_resolution, which is
-- tenant CRM content, from every tenant, with no impersonation request and no
-- org-admin approval.
--
-- So each trigger records IDENTIFIERS AND STRUCTURE, never user-entered
-- content:
--   contact_companies    contact_id, company_id, is_primary
--   custom_field_values  field_id, entity_type, entity_id   (NOT `value`)
--   merges               entity_type, winner_id, loser_id   (NOT field_resolution)
--
-- THE COST, STATED PLAINLY: this audit answers "who deleted what, when", which
-- is what accountability for an irreversible action requires. It does NOT
-- support restore-from-audit, because the payload is not there. If restore is
-- wanted, it needs a founder decision about superuser access to tenant content
-- -- or a tenant-scoped undo table rather than audit_events -- and that is a
-- Phase 7 question, recorded in FOLLOW-UPS.md rather than pre-empted here.
--
-- ===========================================================================
-- THE NULL-ACTOR CASE, WHICH WOULD OTHERWISE HAVE BROKEN ORGANISATION DELETION
-- ===========================================================================
-- private.log_audit_event() RAISES 28000 when auth.uid() is null, because an
-- unattributable audit record is worse than a failed write. That is correct for
-- its intended callers and fatal for a trigger: `delete from public.organisations`
-- as a DBA cascades into contact_companies and custom_field_values, with no
-- session and therefore no auth.uid(). An unconditional trigger would abort
-- that cascade -- turning a documented, measured behaviour (Task 1 fix round:
-- "organisation delete cascades cleanly, rooms 1 -> 0, no error") into a hard
-- failure, and taking every migration and seed with it.
--
-- The trigger therefore returns early when there is no authenticated actor.
-- What that excludes is precisely the set of writers that are not client
-- actions: migrations, seeds, DBA repair, and FK cascades initiated by them.
-- What it does NOT excuse is a privileged application path -- service_role
-- holds no grant on any of these tables (20260828121000 § 5), so there is no
-- sessionless client writer to miss.
--
-- The residual gap, recorded rather than hidden: a cascade triggered by a
-- SUPERUSER session (Phase 7's organisation deletion) does have an auth.uid(),
-- so it WILL emit one audit row per cascaded child row. For a large tenant that
-- is thousands of rows sharing nothing but a timestamp, because
-- log_audit_event() mints a fresh correlation_id per call. Phase 7's deletion
-- path should take a correlation id and pass it down, or suppress row-level
-- audit inside a deliberate bulk operation and write one summary row. Routed.

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
  -- and must not be turned into an error -- see the header.
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform private.log_audit_event(
      p_action          => tg_argv[0],
      p_target_type     => tg_argv[1],
      p_organisation_id => old.organisation_id,
      p_target_id       => old.id,
      -- Identifiers and structure only. No user-entered content: see the
      -- header's note on audit_events being superuser-readable.
      p_before          => private.audit_crm_payload(tg_argv[1], pg_catalog.to_jsonb(old))
    );
  else
    perform private.log_audit_event(
      p_action          => tg_argv[0],
      p_target_type     => tg_argv[1],
      p_organisation_id => new.organisation_id,
      p_target_id       => new.id,
      p_after           => private.audit_crm_payload(tg_argv[1], pg_catalog.to_jsonb(new))
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function private.audit_crm_row() is
  'AFTER-trigger audit writer for the irreversible CRM operations (the two hard DELETE paths and merges). Calls private.log_audit_event(), which is granted to no client role -- hence SECURITY DEFINER. Takes the action and target_type as trigger arguments. Returns early with no audit row when auth.uid() is null, because that is a migration, a seed or a DBA-initiated cascade rather than a client action, and log_audit_event() raises 28000 on a null actor -- an unconditional trigger would abort organisation deletion. The payload is filtered by private.audit_crm_payload(): identifiers and structure only, never user-entered content, because audit_events is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant record content out of that surface.';

-- ---------------------------------------------------------------------------
-- audit_crm_payload(target_type, row_as_jsonb)
--
-- The allowlist. Written as a per-target-type projection rather than a denylist
-- of sensitive columns, for the reason every allowlist beats every denylist:
-- a column added to one of these tables later is excluded by default, and
-- someone has to make a decision to include it. A denylist would leak the new
-- column on the day it ships.
--
-- Phase 3 and beyond: a new audited table needs a branch here, or its audit
-- payload is `{}` -- which is the fail-closed direction and will be visible in
-- the audit log the first time anyone looks.
-- ---------------------------------------------------------------------------
create or replace function private.audit_crm_payload(p_target_type text, p_row jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_target_type
    when 'contact_company' then pg_catalog.jsonb_build_object(
      'contact_id', p_row -> 'contact_id',
      'company_id', p_row -> 'company_id',
      'is_primary', p_row -> 'is_primary')
    when 'custom_field_value' then pg_catalog.jsonb_build_object(
      'field_id',    p_row -> 'field_id',
      'entity_type', p_row -> 'entity_type',
      'entity_id',   p_row -> 'entity_id')
    when 'merge' then pg_catalog.jsonb_build_object(
      'entity_type', p_row -> 'entity_type',
      'winner_id',   p_row -> 'winner_id',
      'loser_id',    p_row -> 'loser_id')
    else '{}'::jsonb
  end;
$$;

comment on function private.audit_crm_payload(text, jsonb) is
  'Projects an audited CRM row down to identifiers and structure, dropping every user-entered value (custom_field_values.value, merges.field_resolution). An ALLOWLIST per target_type, not a denylist: a column added to one of these tables later is excluded until someone decides to include it. Unknown target_type yields {} -- fail closed and visible in the log. audit_events is readable only by the platform superuser, and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface; the in-app feedback screenshot is described there as the ONE deliberate exception, and this function is why the audit trail does not become a second one.';

revoke all on function private.audit_crm_payload(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.audit_crm_row() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Attachment. Three triggers, listed one per statement so the audited set is
-- greppable, matching the set_updated_at pattern in 20260828121500.
--
-- FOR EACH ROW rather than statement-level: the audit needs the target_id of
-- each destroyed row, which a statement-level trigger does not have.
-- ---------------------------------------------------------------------------
drop trigger if exists audit_delete on public.contact_companies;
create trigger audit_delete
  after delete on public.contact_companies
  for each row
  execute function private.audit_crm_row('contact_company.deleted', 'contact_company');

drop trigger if exists audit_delete on public.custom_field_values;
create trigger audit_delete
  after delete on public.custom_field_values
  for each row
  execute function private.audit_crm_row('custom_field_value.deleted', 'custom_field_value');

-- merges is append-only, so INSERT is the only event there is. CLAUDE.md
-- § Domain entities: "Every merge is audited." 20260827232512's header already
-- says Task 6 must write BOTH a merges row and an audit_events row and that
-- neither replaces the other -- this trigger makes the second half structural
-- rather than a thing Task 6 has to remember, and Task 6 should therefore NOT
-- write its own audit row for the merge record itself (it still should for the
-- field-level rewrite of the winner, which this cannot see).
drop trigger if exists audit_insert on public.merges;
create trigger audit_insert
  after insert on public.merges
  for each row
  execute function private.audit_crm_row('records.merged', 'merge');
