-- Phase 6 (Network), Task 1c: the three network permission keys -- view_network,
-- manage_network_profile, manage_network_connections -- and their role grants
-- (Q77). Mirrors 20260902010000 (the four operations keys), which is the
-- granular one-key-per-surface precedent this follows.
--
-- ===========================================================================
-- NO entity_is_manageable / entity_is_visible ARM IN THIS FILE
-- ===========================================================================
-- None of these three keys is named by any polymorphic dispatch. The network
-- tables' POLYMORPHIC ends (network_profiles.entity_id keyed by entity_kind,
-- network_links.private_entity_id keyed by private_entity_type) both resolve to
-- one of FOUR EXISTING CRM ENTITIES -- company, artist, venue, agency -- and the
-- write policies call private.entity_is_manageable for exactly that, which asks
-- for manage_contacts / manage_artists / manage_venues, NOT for a network key.
-- That is deliberate and it is the "you may only publish a record you could
-- manage" rule: publishing your venue requires that you could edit your venue.
--
-- A network profile is never itself a polymorphic TARGET (nothing links to
-- one through an entity_type dispatch), so no dispatch has to resolve one and
-- none of these keys is ever chosen polymorphically. They are named DIRECTLY by
-- the policies in 20260904003000, which know their own table.
--
-- private.entity_org_unchanged DID gain a 'network_profile' arm -- in Task 1a
-- (20260904000000), named after the TABLE, because that guard is called by the
-- UPDATE policy and pins (id, organisation_id); it does not choose a key.
--
-- ===========================================================================
-- ALL THREE ARE survives_suspension = false, AND M1f'S EXPECTED SET IS
-- UNCHANGED
-- ===========================================================================
-- STATED EXPLICITLY BECAUSE A REVIEWER'S FIRST QUESTION ABOUT A NEW *READ* KEY
-- IS WHETHER IT MOVED THAT SET. It did not. `view_crm` remains the ONLY key in
-- the catalogue with survives_suspension = true, and rls_phase2_crm.sql M1f's
-- expected set is unchanged by this migration.
--
-- view_network is false on purpose even though it is a read key. view_crm is
-- true because a suspended organisation must still be able to SEE ITS OWN DATA
-- -- CLAUDE.md § Superuser dashboard: suspension makes a workspace read-only,
-- it does not blind it, and "downgrading must never silently delete data" has
-- the same spirit. Browsing the INDUSTRY NETWORK is not seeing your own data;
-- it is an outward-facing product surface, and a suspended workspace has no
-- claim on it. The consequence is that a suspended organisation's members
-- cannot browse the directory or read their own network profiles until the
-- workspace is reinstated -- their profiles and requests are untouched, and
-- come back with the workspace.
--
-- ===========================================================================
-- MFA IS ALREADY COVERED, FOR FREE
-- ===========================================================================
-- private.role_requires_mfa already returns true for owner/admin/finance
-- (20260827210000), and private.permitted_organisations() folds the aal2 check
-- in for those roles on EVERY key. So the network keys held by owner and admin
-- are aal2-gated with no new code in this file and no separate term in any
-- network policy. Task 5 proves it rather than assuming it: an aal1 owner
-- session holds none of these three keys.
--
-- ===========================================================================
-- WHO HOLDS THEM (Q77)
-- ===========================================================================
-- view_network                 -- ALL NINE roles. Free is a view-only network
--                                 tier (CLAUDE.md § Subscription tiers), so
--                                 browsing is the one network act every role
--                                 including read_only can do. The TIER gate,
--                                 not the role gate, is what makes Free
--                                 view-only, and it lives on the WRITE
--                                 policies.
-- manage_network_profile       -- owner, admin, manager, marketing. FOUR.
--                                 Publishing an identity is a marketing and
--                                 management act, which is why `marketing`
--                                 holds it here and holds no other write key
--                                 beyond manage_contacts. NOT booker,
--                                 venue_manager, finance, standard_user or
--                                 read_only: deciding what the business
--                                 publishes about itself is not an
--                                 individual-contributor decision.
-- manage_network_connections   -- owner, admin, manager, booker,
--                                 venue_manager, marketing. SIX. Sending and
--                                 accepting a connection, and filing a network
--                                 identity against a private record, ARE
--                                 individual-contributor acts -- a booker
--                                 connecting to an agency is the ordinary case
--                                 the product exists for. NOT finance,
--                                 standard_user or read_only.
--
-- Every omission is reversible with one insert.
-- ===========================================================================

insert into public.permissions (key, survives_suspension, description) values
  ('view_network',               false, 'Browse and search the network directory; read this organisation''s own profiles, links and connection requests.'),
  ('manage_network_profile',     false, 'Create, publish, unpublish and change the field visibility of this organisation''s network profiles.'),
  ('manage_network_connections', false, 'Send, accept, decline and withdraw connection requests, and link a private record to a network identity.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
select r, 'view_network' from unnest(array[
  'owner','admin','manager','booker','venue_manager','finance','marketing','standard_user','read_only']) r
union all
select r, 'manage_network_profile' from unnest(array['owner','admin','manager','marketing']) r
union all
select r, 'manage_network_connections' from unnest(array['owner','admin','manager','booker','venue_manager','marketing']) r
on conflict do nothing;
