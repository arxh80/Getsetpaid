-- Phase 4 (Operations), Task 2: the four operational WRITE permission keys --
-- manage_tasks, manage_meetings, manage_notes, manage_documents -- and their
-- role grants. Mirrors 20260901010000 (manage_events), which is the granular
-- one-key-per-entity precedent this follows rather than reuses.
--
-- ===========================================================================
-- NO entity_is_manageable ARM IN THIS FILE, AND THAT IS A MEASURED DECISION
-- ===========================================================================
-- 20260901010000 seeded manage_events AND added the sixth entity_is_manageable
-- arm in the same file, because the polymorphic dispatch names one key per
-- entity type and 'event' was a NEW target type. The Phase 4 split does NOT
-- repeat that, because none of these four keys is named by any polymorphic
-- dispatch:
--
--   * The *_links TARGET end (entity_type, entity_id) resolves to one of the
--     SIX existing CRM entities (company/contact/agency/artist/venue/event) --
--     20260902002000's allowlist CHECK is exactly that set, and 20260902003000
--     confirmed by census that entity_is_visible / entity_is_manageable already
--     carry all six arms. A task/meeting/note/document is never a link TARGET,
--     so no dispatch ever has to resolve one, so none of these four keys is
--     ever chosen polymorphically. They are named DIRECTLY by the top-level and
--     via-parent policies in 20260902011000, which know their own table.
--   * entity_org_unchanged DID gain arms for these tables -- but in Task 1
--     (20260902003000), named after the TABLE (task/meeting/note/document +
--     the four *_link), because that guard is called by the UPDATE policies and
--     pins (id, organisation_id), it does not choose a permission key.
--
-- So there is no "seed the key, then widen the dispatch that names it" pairing
-- to keep together here. The keys are seeded alone; the policies that name them
-- land in 20260902011000.
--
-- ===========================================================================
-- WHO HOLDS THEM -- founder-confirmed, mirrors manage_events (Q29 / Q43)
-- ===========================================================================
-- owner, admin, manager, booker, venue_manager, standard_user. SIX roles, the
-- same set as manage_events. NOT finance, marketing, read_only -- each omission
-- is the same decision manage_events made (20260901010000's header):
--   * finance   -- view_crm only; reads the CRM, writes only the finance module.
--   * marketing -- manage_contacts + view_crm; works the address book.
--   * read_only -- view_crm; by definition.
-- The finance/marketing exclusion is Q43 and is reversible with one insert.
--
-- `standard_user` holds all four ORG-WIDE in role_permissions, exactly as it
-- holds manage_events / manage_contacts, and is narrowed to its own records by
-- the record-scope disjunction in each policy (20260902011000) -- the catalogue
-- is not where record scope lives.
--
-- `survives_suspension = false` on all four: they are WRITE keys, and a
-- suspended organisation is read-only (CLAUDE.md § Superuser dashboard / Q6).
-- view_crm stays the ONLY key in the catalogue with `true`. § OA2 asserts this
-- set by name; § OG drives the suspension consequence with the EI/P11 technique.
-- ===========================================================================

insert into public.permissions (key, survives_suspension, description) values
  ('manage_tasks',     false, 'Write tasks and their entity links.'),
  ('manage_meetings',  false, 'Write meetings and their entity links.'),
  ('manage_notes',     false, 'Write notes (respecting private/company visibility) and their entity links.'),
  ('manage_documents', false, 'Upload, attach and soft-delete documents; issue download URLs.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
select r, k from unnest(array['owner','admin','manager','booker','venue_manager','standard_user']) r
  cross join unnest(array['manage_tasks','manage_meetings','manage_notes','manage_documents']) k
on conflict do nothing;
