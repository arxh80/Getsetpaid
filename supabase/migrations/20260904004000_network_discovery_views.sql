-- Phase 6 (Network), Task 1e: public.network_directory and
-- public.network_connected_profiles.
--
-- ===========================================================================
-- THIS IS THE SECURITY CONTROL OF THE PHASE
-- ===========================================================================
-- CLAUDE.md § The private/network split: "Discovery queries read only
-- explicitly published fields, and publishing is opt-in per field." These two
-- views ARE that sentence. The base table's directory SELECT policy
-- (20260904003000) deliberately does not constrain which COLUMNS are legible
-- -- it cannot; a policy filters rows -- so a cross-tenant reader of
-- public.network_profiles can see organisation_id, entity_id, and every value
-- column including ones the publisher marked hidden or connections-only.
--
-- THESE VIEWS ARE THE ONLY SANCTIONED READ PATH INTO PUBLISHED DATA, and
-- Constraint 19's network case is exactly this: shipping them while the
-- discovery page reads network_profiles directly would pass every structural
-- assertion ABOUT the views and leak anyway. lib/network/discovery-list.ts
-- names public.network_directory as its table, and nothing in app/ selects
-- from public.network_profiles for a foreign organisation.
--
-- ===========================================================================
-- security_invoker = true ON BOTH IS NOT DECORATION
-- ===========================================================================
-- It makes each row's REACHABILITY the caller's own network_profiles SELECT
-- policy, so the directory policy is the SINGLE gate rather than two gates
-- that can drift. Without it the view would run as its owner and become a
-- second, independent access-control surface that nothing keeps in step with
-- the policy -- the classic view-bypasses-RLS defect. This mirrors
-- public.activity_events (20260829040000) and public.event_finance_summary
-- (20260903010000) exactly.
--
-- So there are two orthogonal controls, and each does a job the other cannot:
--   WHICH ROWS    the base table's RLS policy, inherited through
--                 security_invoker.
--   WHICH COLUMNS these SELECT lists, and the `case when` masks in them.
--
-- ===========================================================================
-- organisation_id IS NOT PROJECTED BY EITHER VIEW, AND NEITHER IS entity_id
-- ===========================================================================
-- A discovery result identifies a PROFILE, never a tenant and never a tenant's
-- private record. Task 3's UI therefore has no tenant id to leak, no matter
-- what it renders. Task 5 asserts the column list AND probes the inference (a
-- caller cannot recover the owning organisation by filtering, joining or
-- ordering on a column that is not there).
--
-- The connection flow does not need organisation_id here either: a request
-- names to_network_profile_id, and the INSERT policy resolves the owning
-- organisation itself, in the database, from the profile the caller picked
-- (20260904003000, term (ii)). That is what makes to_organisation_id
-- unforgeable AND what makes projecting it here unnecessary.
--
-- ===========================================================================
-- N2 -- THE DEPENDENCY SET, WHICH IS ASSERTED RATHER THAN PROMISED
-- ===========================================================================
-- network_directory depends on exactly {public.network_profiles}, cardinality
-- 1. network_connected_profiles depends on exactly {public.network_profiles,
-- public.network_connection_requests}, cardinality 2. Nothing else, ever.
-- rls_phase6_network.sql § ND reads pg_depend/pg_rewrite and asserts both
-- sets, with a paired non-vacuity control over public.event_finance_summary
-- (which must return {financial_entries}) proving the query can see
-- dependencies at all.
--
-- That assertion is the structural form of "do not join private tables into
-- public discovery paths" -- and it is structural precisely because the
-- reviewable form ("nobody would do that") has failed everywhere it has been
-- tried. Joining public.companies in here to resolve a nicer display name is
-- the single most plausible future edit, and it is the one the assertion
-- catches.
--
-- ===========================================================================
-- SCHEMA-INVARIANT ACCOUNTING
-- ===========================================================================
-- Both are VIEWS (relkind 'v'), not tables (relkind 'r'), so they are outside
-- every table-shaped invariant in schema_invariants.sql: D1/D2 (the roster and
-- RLS-on-every-table), D4/D5 (policies and grants on the roster), D6 and D10
-- all count relkind='r' only, so two new views change none of their expected
-- numbers. This is the same accounting public.activity_events and
-- public.event_finance_summary get -- neither is in schema_invariants; their
-- grant/security_invoker surface is asserted in the RLS suites
-- (rls_phase2_crm.sql X1-X3, rls_phase5_finance.sql FB19) rather than in the
-- table invariants. The network analogue is rls_phase6_network.sql § ND/§ NG,
-- which additionally counts the `anon=` ACL across all FIVE objects (three
-- tables and both views) with the denominator stated.
--
-- ===========================================================================
-- PERFORMANCE -- LABELLED AS INFERENCE, NOT MEASURED (Constraint 13)
-- ===========================================================================
-- The connected view's `exists` is a CORRELATED subquery evaluated per row: it
-- reads network_connection_requests once per candidate profile, and the two
-- `permitted_organisations` calls inside it are hoisted (no row correlation)
-- but the request lookup is not. THIS IS AN INFERENCE AND NOT A MEASUREMENT:
-- at MVP profile counts a materialised connection table is not worth it, and
-- above some size it will be. The crossover has NOT been measured here.
-- network_connection_requests_to_profile_idx and _from_profile_idx are the
-- indexes it would use. Task 3 measures the directory page it builds; if that
-- measurement covers the connected view it should replace this paragraph with
-- a number.
--
-- ADDITIVE. `create or replace view` is the additive form for a view.

create or replace view public.network_directory
  with (security_invoker = true) as
select
  p.id, p.entity_kind, p.display_name,                                   -- always visible (Q71)
  case when p.field_visibility->>'headline'      = 'network' then p.headline      end as headline,
  case when p.field_visibility->>'bio'           = 'network' then p.bio           end as bio,
  case when p.field_visibility->>'city'          = 'network' then p.city          end as city,
  case when p.field_visibility->>'region'        = 'network' then p.region        end as region,
  case when p.field_visibility->>'country'       = 'network' then p.country       end as country,
  case when p.field_visibility->>'website_url'   = 'network' then p.website_url   end as website_url,
  case when p.field_visibility->>'contact_email' = 'network' then p.contact_email end as contact_email,
  p.published_at
from public.network_profiles p
where p.status = 'published' and p.deleted_at is null;

comment on view public.network_directory is
  'THE ONLY SANCTIONED READ PATH into another organisation''s published network data at the `network` level. Eleven columns: id, entity_kind and display_name (always visible, Q71), the seven publishable fields each masked by a `case when field_visibility->>''<field>'' = ''network''` test, and published_at. organisation_id and entity_id are DELIBERATELY NOT PROJECTED -- a discovery result identifies a PROFILE, never a tenant or a tenant''s private record, so Task 3''s UI has no tenant id to leak. security_invoker: row reachability is the caller''s own network_profiles SELECT policy (the published-directory one), so there is ONE gate rather than two that can drift. Its dependency set is exactly {public.network_profiles} and rls_phase6_network.sql § ND asserts that from pg_depend with a non-vacuity control -- joining a private table in here to resolve a nicer name is the most plausible future edit and is the one that assertion catches (N2). A field marked `hidden` is additionally NULL in the base column (network_profiles_hidden_fields_are_null, N3), so this mask is the second of two controls, not the only one.';

create or replace view public.network_connected_profiles
  with (security_invoker = true) as
select
  p.id, p.entity_kind, p.display_name,
  case when p.field_visibility->>'headline'      in ('network','connections') then p.headline      end as headline,
  case when p.field_visibility->>'bio'           in ('network','connections') then p.bio           end as bio,
  case when p.field_visibility->>'city'          in ('network','connections') then p.city          end as city,
  case when p.field_visibility->>'region'        in ('network','connections') then p.region        end as region,
  case when p.field_visibility->>'country'       in ('network','connections') then p.country       end as country,
  case when p.field_visibility->>'website_url'   in ('network','connections') then p.website_url   end as website_url,
  case when p.field_visibility->>'contact_email' in ('network','connections') then p.contact_email end as contact_email,
  p.published_at
from public.network_profiles p
where p.status = 'published' and p.deleted_at is null
  and exists (
    select 1 from public.network_connection_requests r
     where r.status = 'accepted'
       and (   (r.to_organisation_id   = p.organisation_id
                and r.from_organisation_id in (select private.permitted_organisations('view_network')))
            or (r.from_organisation_id = p.organisation_id
                and r.to_organisation_id   in (select private.permitted_organisations('view_network')))));

comment on view public.network_connected_profiles is
  'The same eleven columns as public.network_directory, resolved one level further: each of the seven publishable fields tests `in (''network'',''connections'')` rather than `= ''network''`, so a field the publisher marked connections-only becomes legible. AN ACCEPTED CONNECTION CHANGES EXACTLY THIS AND NOTHING ELSE (N4): it grants no access to any tenant table -- ratings (which do not exist and must not be reachable if they ever do), notes, financial entries, documents, events, activity, tasks and meetings are unreachable from a connected counterparty by construction, and Task 5 proves it query path by query path. The `exists` is Q80''s org-to-org symmetry, written BOTH WAYS ROUND because either side may have been the requester. organisation_id and entity_id are not projected here either. security_invoker, same single-gate reasoning as the directory view. Dependency set is exactly {public.network_profiles, public.network_connection_requests}, asserted from pg_depend (N2). PERFORMANCE, LABELLED AS INFERENCE AND NOT MEASURED HERE: the exists is a correlated subquery per row; at MVP profile counts a materialised connection table is not worth it and above some unmeasured size it will be.';

-- ---------------------------------------------------------------------------
-- Grants. SELECT to authenticated on both, and NOTHING to anon (N6).
--
-- Neither view is auto-updatable in any useful sense (both project computed
-- CASE expressions), so writes are refused by Postgres itself and not merely
-- ungranted -- the same surface public.activity_events and
-- public.event_finance_summary have. rls_phase6_network.sql § NG counts the
-- `anon=` ACL across five objects (three tables, two views) with the
-- denominator stated, plus an HTTP check that an unauthenticated
-- GET /rest/v1/network_directory is refused with a paired positive control
-- that a member's JWT returns rows.
-- ---------------------------------------------------------------------------
grant select on public.network_directory, public.network_connected_profiles to authenticated;
