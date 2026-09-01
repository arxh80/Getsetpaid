-- Phase 5 (Finance), Task 1c: the `view_finance` and `manage_finance`
-- permission keys, and the role grants for them.
--
-- ===========================================================================
-- WHO HOLDS THEM
-- ===========================================================================
-- owner, admin, finance -- THREE roles, for both keys. Finance is the role the
-- module is named for; owner and admin hold every management key. No other
-- role gets finance: a Booker builds lineups and a Venue Manager takes
-- bookings, but neither runs the money, and Marketing works the address book.
-- Read-only holds view_crm and nothing else, by definition.
--
-- THIS IS THE FIRST PHASE TO GIVE THE FINANCE ROLE A WRITE KEY. Per
-- 20260901010000's header, Finance previously held ONLY `view_crm`
-- (rls_phase2_crm.sql A6) -- it READ the CRM and wrote nothing, because the
-- finance module was a later phase's surface. manage_finance is that surface
-- arriving: the Finance role now writes financial_entries and nothing else.
--
-- ===========================================================================
-- THE MFA GATE NEEDS NO NEW CODE
-- ===========================================================================
-- private.role_requires_mfa('finance') is already `true` (20260827210000), as
-- it is for owner and admin. So both keys are AUTOMATICALLY aal2-gated for all
-- three roles inside private.permitted_organisations()/public.has_permission()
-- -- the aal2 conjunct is already in those functions and applies to any key a
-- role holds. A finance write below aal2 therefore holds neither key and is
-- refused with no separate term in any finance policy. Task 4 proves it.
--
-- ===========================================================================
-- survives_suspension = false ON BOTH
-- ===========================================================================
-- Q65. `view_crm` stays the ONLY key with survives_suspension = true; a
-- suspended organisation is read-only for the CRM but view_crm keeps its reads
-- open. view_finance is a finance READ key and does NOT survive suspension --
-- a suspended org's finance panel closes with everything else, which is the
-- conservative reading and consistent with view_finance not being view_crm.
-- manage_finance is a WRITE key and false by the same rule every write key
-- follows. rls_phase2_crm.sql M1f asserts the survives_suspension = true SET by
-- name (`view_crm` alone), so seeding two more false keys leaves that set
-- unchanged -- its expected value does not move.
-- ===========================================================================

insert into public.permissions (key, survives_suspension, description) values
  ('view_finance',   false, 'Read financial entries and the event finance summary.'),
  ('manage_finance', false, 'Write financial entries (budget & actuals) and their custom field values.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
select r, k from unnest(array['owner','admin','finance']) r
  cross join unnest(array['view_finance','manage_finance']) k
on conflict do nothing;
