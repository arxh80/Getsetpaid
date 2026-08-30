-- Phase 2 (Core CRM), Task 2a: the CRM permission catalogue.
--
-- Six new organisation permission keys, granted per the founder-answered
-- matrix in .superpowers/sdd/phase-2-core-crm/DECISIONS-QUEUE.md § Q2
-- (ANSWERED 2026-08-28, "default accepted"). This is a decision, not a
-- proposal: changing a row here is a change of product decision.
--
-- WHY THIS IS A SEPARATE MIGRATION AND NOT AN EDIT OF 20260826202023
--   The hosted project is linked and live. Editing an applied migration
--   rewrites history that the remote has already run; `supabase db push`
--   would either skip it or fail the checksum. Every statement below is
--   `on conflict do nothing`, matching the reference-data migration's shape
--   exactly, so this file is re-runnable and can sit beside a future
--   migration that adds more keys.
--
-- ===========================================================================
-- WHY SIX KEYS
-- ===========================================================================
-- One `manage_crm` key would make Booker and Venue Manager indistinguishable
-- as roles -- the whole point of having both. One key per table would be ten
-- near-identical grants to maintain and would still not express "Booker reads
-- venues but does not edit them". Six is the smallest set that reproduces
-- CLAUDE.md § Permissions' role list as an enforceable matrix:
--
--   view_crm              read the CRM at all (SELECT on every entity table)
--   manage_contacts       write companies, contacts, agencies, and the
--                         contact<->company link. The relationship layer moves
--                         together in practice, so it shares one key.
--   manage_artists        write artists, representations, fee history
--   manage_venues         write venues and venue rooms
--   manage_custom_fields  DEFINE custom fields (the definition, not the value)
--   merge_records         run a duplicate merge
--
-- THE MATRIX (DECISIONS-QUEUE § Q2, reproduced so this file is self-contained;
-- if the two ever disagree, the queue is the decision and this is the bug):
--
--   Role           view  contacts  artists  venues  custom_fields  merge
--   owner           Y      Y         Y        Y         Y            Y
--   admin           Y      Y         Y        Y         Y            Y
--   manager         Y      Y         Y        Y         -            Y
--   booker          Y      Y         Y        -         -            -
--   venue_manager   Y      Y         -        Y         -            -
--   finance         Y      -         -        -         -            -
--   marketing       Y      Y         -        -         -            -
--   standard_user   Y*     Y*        Y*       Y*        -            -
--   read_only       Y*     -         -        -         -            -
--
--   * = record-scoped. The permission is held org-wide; the RLS policies
--     narrow WHICH ROWS it reaches to `owner_user_id = auth.uid()`, via
--     private.record_in_scope() in 20260828120500. Scope is NOT expressible
--     in this table and must not be faked by withholding a key -- withholding
--     view_crm from standard_user would deny them their own records too.
--
-- NO platform_superuser ROW, DELIBERATELY.
--   'platform_superuser' is not in public.roles at all -- Foundation removed
--   it from the org-role path in favour of the public.platform_admins
--   allowlist precisely so the superuser holds no org-scoped read anywhere and
--   every look at tenant data goes through the audited, admin-approved
--   impersonation flow (CLAUDE.md § Superuser dashboard;
--   20260826154304 design note (i)). The FK on role_permissions.role_key would
--   reject the row anyway; it is called out because "the superuser can see
--   everything" is the obvious wrong instinct here.
--
-- ===========================================================================
-- WHAT THESE KEYS INHERIT FOR FREE, AND THE ONE PLACE IT BITES
-- ===========================================================================
-- public.has_permission() has been MFA-gated since
-- 20260827210000_mfa_aal_permission_gate.sql: for a role in
-- private.role_requires_mfa() -- owner, admin, finance -- it returns false on
-- a session that has not reached aal2. Every policy built on it inherits that,
-- including the SELECT policies in 20260828121000.
--
-- THIS IS A DELIBERATE, DOCUMENTED CHANGE OF POSTURE and it is written up in
-- 20260828121000's header under "MFA now gates CRM READS": Foundation's read
-- policies deliberately never call has_permission, because gating THEM is the
-- lockout that stops an un-enrolled user reaching the enrolment screen. The
-- CRM tables are not on the enrolment path, so gating their reads costs no
-- lockout and closes the larger half of SECURITY.md § 4's known limitation for
-- the biggest tenant-data surface in the product. Read that header before
-- changing view_crm's call site.

insert into public.role_permissions (role_key, permission_key) values
  -- Owner / Admin: everything.
  ('owner',         'view_crm'),
  ('owner',         'manage_contacts'),
  ('owner',         'manage_artists'),
  ('owner',         'manage_venues'),
  ('owner',         'manage_custom_fields'),
  ('owner',         'merge_records'),
  ('admin',         'view_crm'),
  ('admin',         'manage_contacts'),
  ('admin',         'manage_artists'),
  ('admin',         'manage_venues'),
  ('admin',         'manage_custom_fields'),
  ('admin',         'merge_records'),

  -- Manager: all CRM writes and merges, but NOT custom field definitions --
  -- a definition is schema, and schema changes are an admin act (Q2, and the
  -- plan's Task 5 "definition UI (Owner/Admin only)").
  ('manager',       'view_crm'),
  ('manager',       'manage_contacts'),
  ('manager',       'manage_artists'),
  ('manager',       'manage_venues'),
  ('manager',       'merge_records'),

  -- Booker: works the roster and the relationship layer. No venue write -- a
  -- booker reads venues to place an artist; editing the venue record is the
  -- Venue Manager's job.
  ('booker',        'view_crm'),
  ('booker',        'manage_contacts'),
  ('booker',        'manage_artists'),

  -- Venue Manager: the mirror image.
  ('venue_manager', 'view_crm'),
  ('venue_manager', 'manage_contacts'),
  ('venue_manager', 'manage_venues'),

  -- Finance: read-only over the CRM. The Finance role's writes are Phase 5's
  -- financial entries, not contact records.
  ('finance',       'view_crm'),

  -- Marketing: works the contact list; the artist roster is the booking
  -- team's.
  ('marketing',     'view_crm'),
  ('marketing',     'manage_contacts'),

  -- Standard User: full CRM verbs, narrowed to their OWN records by
  -- private.record_in_scope(). Note they hold manage_* org-wide in this table
  -- and are stopped by the policy, not by the catalogue -- see the note on
  -- the matrix above for why that is the only shape that works.
  ('standard_user', 'view_crm'),
  ('standard_user', 'manage_contacts'),
  ('standard_user', 'manage_artists'),
  ('standard_user', 'manage_venues'),

  -- Read Only: sees its own records and writes nothing, anywhere.
  ('read_only',     'view_crm')
on conflict (role_key, permission_key) do nothing;
