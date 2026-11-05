-- ===========================================================================
-- Phase 10 Task 19 (Task 2 finding F1, Critical): public.network_profiles is
-- no longer a cross-tenant read path. The two views are.
--
-- THE HOLE. network_profiles carries a table-wide SELECT grant to
-- authenticated (20260904000000) and carried the cross-tenant ROW policy
-- network_profiles_select_published_directory (20260904003000, clock added in
-- 20260908031000). A row policy cannot mask columns, so any account with an
-- active membership anywhere -- a free sign-up plus create_organisation --
-- could send
--   GET /rest/v1/network_profiles?select=display_name,contact_email,bio,
--       headline,city,field_visibility,organisation_id,entity_id
--       &status=eq.published
-- with the anon key and its own JWT, and receive every published, live
-- profile with every `connections`-level value unmasked, plus the publisher's
-- organisation_id and entity_id, with no connection request at all.
-- Reproduced over HTTP before this migration. The suites had asserted it "by
-- design" (network_leakage_phase6.sql LB6c, run-rls-tests.sh LEAKAGE #1a), on
-- the premise that the application never reads the table for a foreign
-- organisation; PostgREST is a present path that never meets the application.
--
-- THE FIX.
--   1. The cross-tenant policy is dropped. The base table answers only its own
--      organisation's members: network_profiles_select_view_network, and
--      network_profiles_select_own_published below, which keeps Q6 (a
--      suspended workspace's members, who lose view_network, still read their
--      own published profiles -- network_leakage_phase6.sql LJ2f/LJ5b).
--   2. network_directory and network_connected_profiles become definer views
--      (security_invoker = false) that carry the row filter in their own
--      WHERE clause, so they still read a foreign row. security_barrier keeps
--      a caller's own filter from being evaluated ahead of that WHERE clause,
--      the guarantee RLS gave them before. Their relation sets (N2) are
--      unchanged; each gains one function call.
--   3. The old policy's caller-side terms live in ONE function,
--      private.network_profile_reaches_caller(organisation_id), byte for byte
--      the policy's terms plus the view_network disjunct the old
--      security_invoker views also inherited from the own-organisation
--      policy. The views call it, and so does
--      private.network_profile_is_discoverable(), the definer predicate the
--      three write policies now use for a profile the caller can no longer
--      read (network_links INSERT/UPDATE, the connection-request INSERT's
--      target). network_leakage_phase6.sql § LB13 asserts the predicate and
--      the views agree.
--
-- Column-level grants are not the fix (Phase 6's reason (1) still holds): the
-- owner's own reads need every column, and column grants are not
-- row-conditional. Every other read of network_profiles that can meet a
-- foreign row is SECURITY DEFINER already (fill_connection_request_recipient,
-- audit_network_row, pending_connection_request_notifications, the lifecycle
-- logger), checked against pg_policies and pg_proc on 2026-10-18.
-- ===========================================================================

-- The caller-side terms. Invoker rights on purpose: it reads only the caller's
-- own memberships (organisation_memberships_select_own) and three helpers that
-- are SECURITY DEFINER themselves.
create function private.network_profile_reaches_caller(p_organisation_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (
           exists (select 1 from public.organisation_memberships m
                    where m.user_id = (select auth.uid()) and m.status = 'active')
           and (
             private.organisation_network_presence_active(p_organisation_id)
             or private.is_active_member(p_organisation_id)
           )
         )
      or p_organisation_id in (select private.permitted_organisations('view_network'));
$$;

comment on function private.network_profile_reaches_caller(uuid) is
  'May the CURRENT CALLER see a published, live network profile owned by this organisation? The row-reach half of the network read rule, in one place since Phase 10 Task 19 (F1, 20261103000000): an active membership somewhere (Q70: no logged-out or member-of-nothing browsing) AND the publisher still has network presence (Q88/Q92/Q101) or the caller is its member (Q6) -- the dropped network_profiles_select_published_directory''s terms, unchanged -- OR the caller holds view_network over the publisher, which the old security_invoker views inherited from network_profiles_select_view_network (impersonation reaches it this way). Called by public.network_directory and public.network_connected_profiles (status/deleted_at stay inline there for the directory index) and by private.network_profile_is_discoverable(). Says nothing about status or deleted_at.';

revoke all on function private.network_profile_reaches_caller(uuid) from public, anon, authenticated, service_role;
grant execute on function private.network_profile_reaches_caller(uuid) to authenticated;

-- The write policies' check of a profile the caller can no longer read.
-- SECURITY DEFINER because that is the point. The optional organisation pins
-- the owner (the connection-request INSERT's NR3: to_organisation_id cannot
-- be forged); NULL means "any owner" and only network_links omits it.
create function private.network_profile_is_discoverable(p_profile_id uuid, p_organisation_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.network_profiles p
     where p.id = p_profile_id
       and (p_organisation_id is null or p.organisation_id = p_organisation_id)
       and p.status = 'published'
       and p.deleted_at is null
       and private.network_profile_reaches_caller(p.organisation_id)
  );
$$;

comment on function private.network_profile_is_discoverable(uuid, uuid) is
  'Is this network profile one the CURRENT CALLER could see through public.network_directory (published, live, and private.network_profile_reaches_caller)? With p_organisation_id, also: is it owned by that organisation. SECURITY DEFINER because since Phase 10 Task 19 (F1, 20261103000000) the caller cannot read a foreign row of public.network_profiles, and the write policies that check one -- network_links INSERT/UPDATE, the connection-request INSERT''s target -- still need the answer. Returns a boolean and nothing else: no column of the profile leaves this function. network_leakage_phase6.sql § LB13 asserts it agrees with both views for a published, a draft, a soft-deleted and a wound-down profile and a member of nothing.';

revoke all on function private.network_profile_is_discoverable(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.network_profile_is_discoverable(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. The base table: own organisation only.
-- ---------------------------------------------------------------------------
drop policy "network_profiles_select_published_directory" on public.network_profiles;

create policy "network_profiles_select_own_published"
  on public.network_profiles for select to authenticated
  using (
    status = 'published'
    and deleted_at is null
    and private.is_active_member(organisation_id)
  );

comment on policy "network_profiles_select_own_published" on public.network_profiles is
  'PERMITS: an active member of the publishing organisation to read its own published, live profiles -- the Q6 read: a SUSPENDED workspace''s members lose view_network (survives_suspension=false) and so network_profiles_select_view_network, and must still see their own published presence (network_leakage_phase6.sql LJ2f/LJ5b). Until Phase 10 Task 19 the cross-tenant directory policy carried this as its private.is_active_member() disjunct. DOES NOT PERMIT: any read of another organisation''s row (F1: no policy on this table does, since 20261103000000 -- a foreign profile reaches a caller only through public.network_directory and public.network_connected_profiles); a draft or soft-deleted row (those need view_network).';

comment on policy "network_profiles_select_view_network" on public.network_profiles is
  'PERMITS: reading this organisation''s OWN network profiles, drafts and published alike, for any member holding view_network (every role does). DOES NOT PERMIT: reading another tenant''s profile at all -- since Phase 10 Task 19 (F1, 20261103000000) no policy on this table permits a foreign row, and the two views are the only foreign read path. DELIBERATELY NOT TIER-GATED (no network_publish term): Q81, a downgrade freezes writing, it never hides a customer''s own data; and Free is a view-only network tier by design. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS (no deleted_at term): the restore path and the deleted view both read them; the application filters. NOT below aal2 for owner/admin/finance, whose keys are MFA-gated inside permitted_organisations (20260827210000) -- no separate term here. NOT for a SUSPENDED organisation: view_network is survives_suspension=false, unlike view_crm; network_profiles_select_own_published keeps that workspace''s published profiles readable to it (Q6).';

comment on table public.network_profiles is
  'One organisation''s PUBLISHED identity for one of its own private records (PRD § 8). Readable ONLY by the publishing organisation''s own members; another tenant reaches a published row only through public.network_directory / public.network_connected_profiles, definer views whose WHERE clause is the row gate and whose SELECT list is the column mask (Phase 10 Task 19, F1: until 20261103000000 a cross-tenant row policy made every column of a published row readable to any member over PostgREST). Carries its OWN COPY of every published value (Q75), never a pointer into the private record: a view resolving display_name by joining public.companies would put a tenant-private table in a discovery path, which N2 forbids and the pg_depend assertion measures. entity_kind/entity_id name the org''s own private record and are NEVER projected by either view. Soft-deleted, never hard-deleted; no DELETE grant.';

-- ---------------------------------------------------------------------------
-- 2. The write policies that checked a foreign profile inline. Rebuilt from
-- the live pg_policies text; only the foreign-profile `exists` changes. The
-- connection request's FROM side is the caller's own profile and stays inline.
-- ---------------------------------------------------------------------------
alter policy "network_links_insert_manage_connections"
  on public.network_links
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(private_entity_type, private_entity_id, organisation_id)
    and private.network_profile_is_discoverable(network_profile_id)
  );

alter policy "network_links_update_manage_connections"
  on public.network_links
  with check (
    organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and organisation_id in (select private.network_publish_organisations())
    and private.entity_is_manageable(private_entity_type, private_entity_id, organisation_id)
    and private.network_profile_is_discoverable(network_profile_id)
  );

alter policy "network_connection_requests_insert_manage_connections"
  on public.network_connection_requests
  with check (
    status = 'pending'
    and responded_at is null
    and responded_by is null
    and from_organisation_id in (select private.permitted_organisations('manage_network_connections'))
    and from_organisation_id in (select private.network_publish_organisations())
    and exists (
      select 1 from public.network_profiles p
       where p.id = network_connection_requests.from_network_profile_id
         and p.organisation_id = network_connection_requests.from_organisation_id
         and p.status = 'published'
         and p.deleted_at is null
    )
    and private.network_profile_is_discoverable(to_network_profile_id, to_organisation_id)
  );

comment on policy "network_links_insert_manage_connections" on public.network_links is
  'PERMITS: filing a PUBLISHED, LIVE network profile against one of this organisation''s own private records, when the caller holds manage_network_connections at aal2 AND the plan permits network_publish. DOES NOT PERMIT: a FREE-tier organisation (42501, Q76/N7); a role without manage_network_connections (finance, standard_user, read_only); linking a private record the caller could not manage (private.entity_is_manageable, the polymorphic-target exception); linking to a DRAFT or SOFT-DELETED profile, or one the caller could not discover (private.network_profile_is_discoverable, since Phase 10 Task 19 -- the caller can no longer read the foreign row an inline exists needed). THE TARGET CHECK RETURNS ONLY A BOOLEAN, and that is the deliberate replacement guard for the single-column network_profile_id FK (20260904000000). It deliberately does NOT pin the profile to network_links.organisation_id: the parent is ANOTHER TENANT''S BY DESIGN, so correlating them would permit only self-links -- the same wrong answer the composite FK would have given. The network_publish term is INERT today.';

comment on policy "network_links_update_manage_connections" on public.network_links is
  'PERMITS: soft-deleting (deleted_at := now()) and restoring a network link the caller may write -- both are UPDATEs; there is no DELETE policy or grant, and nothing else about a link is editable in the product. Requires manage_network_connections at aal2 (USING and WITH CHECK) and network_publish (WITH CHECK only, so a downgrade refusal is 42501 rather than a silent 204). DOES NOT PERMIT: repointing a link at a draft, deleted or undiscoverable profile; repointing it at a private record the caller cannot manage. The target check is private.network_profile_is_discoverable(), a boolean, same replacement guard as the INSERT policy.';

comment on policy "network_connection_requests_insert_manage_connections" on public.network_connection_requests is
  'PERMITS: sending a connection request FROM one of your own published, live profiles (Q78) TO another organisation''s published, live profile that you could discover, when the caller holds manage_network_connections at aal2 in the sending organisation AND that organisation''s plan permits network_publish -- and ONLY AS A PENDING REQUEST WITH NO RESPONSE (status = pending, responded_at and responded_by null; Phase 8 Task 9b fix round 1, C1). DOES NOT PERMIT: a request born accepted, declined or withdrawn -- before 20261017000000 a sender could INSERT status=accepted and read the target''s connections-level fields without consent; private.connection_request_born_pending refuses that first (23514), this clause again (42501); a FREE-tier organisation sending at all (42501, Q76/N7); sending from an organisation the caller is not in; sending from a DRAFT profile, or one belonging to somebody else; FORGING to_organisation_id (private.network_profile_is_discoverable(to_network_profile_id, to_organisation_id): the named profile must really belong to the named organisation; since Phase 10 Task 19 a definer predicate, because the caller can no longer read the foreign row). Sending to YOURSELF is refused by network_connection_requests_not_self (23514). A repeat send while a pending/accepted request stands is 23505 from network_connection_requests_live_pair (Q79 as changed 2026-09-07). requested_by and requested_at are stamped by the trigger, not taken from the client.';

-- ---------------------------------------------------------------------------
-- 3. The two views, rebuilt from the live pg_get_viewdef (identical to
-- 20260904004000; 20260908031000 changed neither). Only the options and the
-- reaches_caller term change.
-- ---------------------------------------------------------------------------
create or replace view public.network_directory
  with (security_invoker = false, security_barrier = true) as
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
where p.status = 'published' and p.deleted_at is null
  and private.network_profile_reaches_caller(p.organisation_id);

comment on view public.network_directory is
  'THE ONLY READ PATH into another organisation''s published network data at the `network` level. Eleven columns: id, entity_kind and display_name (always visible, Q71), the seven publishable fields each masked by a `case when field_visibility->>''<field>'' = ''network''` test, and published_at. organisation_id and entity_id are DELIBERATELY NOT PROJECTED -- a discovery result identifies a PROFILE, never a tenant or a tenant''s private record. A DEFINER VIEW ON PURPOSE (security_invoker = false; Supabase lint security_definer_view, accepted): since Phase 10 Task 19 (F1, 20261103000000) the base table answers only its own organisation, so this view reads it with its owner''s rights and ITS WHERE CLAUSE IS THE ROW GATE: published, live, and private.network_profile_reaches_caller(organisation_id) (an active member of some organisation, and the publisher still present or the caller its member; or view_network over the publisher). security_barrier, so a caller''s filter is never evaluated ahead of that clause. SELECT is its only grant, so no write passes through it. Its dependency set is exactly {public.network_profiles} and rls_phase6_network.sql § ND asserts that from pg_depend (N2). A field marked `hidden` is additionally NULL in the base column (network_profiles_hidden_fields_are_null, N3).';

create or replace view public.network_connected_profiles
  with (security_invoker = false, security_barrier = true) as
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
  and private.network_profile_reaches_caller(p.organisation_id)
  and exists (
    select 1 from public.network_connection_requests r
     where r.status = 'accepted'
       and (   (r.to_organisation_id   = p.organisation_id
                and r.from_organisation_id in (select private.permitted_organisations('view_network')))
            or (r.from_organisation_id = p.organisation_id
                and r.to_organisation_id   in (select private.permitted_organisations('view_network')))));

comment on view public.network_connected_profiles is
  'The same eleven columns as public.network_directory, resolved one level further: each of the seven publishable fields tests `in (''network'',''connections'')` rather than `= ''network''`, so a field the publisher marked connections-only becomes legible -- and only to an organisation with an ACCEPTED connection to the publisher (the `exists`, Q80''s org-to-org symmetry, written both ways round, each side pinned to the caller''s own view_network organisations). AN ACCEPTED CONNECTION CHANGES EXACTLY THIS AND NOTHING ELSE (N4): it grants no access to any tenant table. A DEFINER VIEW ON PURPOSE, for the reason network_directory gives (Phase 10 Task 19, F1): its WHERE clause is the row gate -- published, live, private.network_profile_reaches_caller(organisation_id), and the `exists`, which reads network_connection_requests with the owner''s rights and so is itself pinned to the caller. security_barrier; SELECT-only grant. organisation_id and entity_id are not projected. Dependency set is exactly {public.network_profiles, public.network_connection_requests}, asserted from pg_depend (N2). PERFORMANCE, LABELLED AS INFERENCE AND NOT MEASURED HERE: the exists is a correlated subquery per row.';

comment on function private.organisation_network_presence_active(uuid) is
  'Does this organisation still appear in the network directory TO OTHER TENANTS? Founder ruling Q88: a SUSPENDED organisation keeps its network presence until the end of its current subscription period -- and, per queued default Q92, no longer than the 60-day retention window, which for an annual plan can expire first and is the outer bound on the whole wind-down. A DELETED organisation loses presence at once (queued default Q101: Q88 is a ruling about suspension, and a deleted workspace is not waiting out a paid period). An ACTIVE one always has it. SECURITY DEFINER because it reads two tables the foreign counterparty cannot read; called from private.network_profile_reaches_caller() since Phase 10 Task 19 (20261103000000; before that, from the dropped cross-tenant policy on public.network_profiles). A missing subscription row makes both comparisons NULL and the answer FALSE, which is the fail-closed direction for a cross-tenant read. IT DOES NOT AFFECT THE ORGANISATION''S OWN MEMBERS -- reaches_caller disjoins it with private.is_active_member(), because founder decision Q6 (suspension does not hide a customer''s own data) is the older and stronger ruling. CAVEAT: for organisations that predate 20260908000000, current_period_end was backfilled to migration-time + 30 days and is a placeholder, not a billing date.';
