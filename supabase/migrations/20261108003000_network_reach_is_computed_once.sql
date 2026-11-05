-- ===========================================================================
-- Phase 10 Task 16 (G29): the network directory's row gate, computed once.
--
-- Measured by supabase/tests/perf (20,000 published profiles, one caller):
-- the first page of public.network_directory took 4,013 ms. The views called
-- private.network_profile_reaches_caller(p.organisation_id) for every
-- candidate row, and Postgres cannot inline it (its body has sub-selects and
-- a SET clause), so every row paid for a membership probe, a presence check
-- and permitted_organisations() again. Asked once per QUERY as a set, the
-- same page takes 7 ms and walks network_profiles_directory_idx in order.
--
-- THE RULE IS UNCHANGED AND STILL HAS ONE HOME. The terms move verbatim into
-- private.network_reaching_organisations(): an active membership somewhere
-- (Q70) and the publisher still present (Q88/Q92/Q101) or the caller its
-- member (Q6), or view_network over the publisher. reaches_caller() is now
-- "is this organisation in that set", so network_profile_is_discoverable()
-- and the two views cannot drift (network_leakage_phase6.sql § LB13 still
-- asserts they agree).
--
-- SECURITY DEFINER, unlike the predicate it replaces, because a set of
-- organisations has to be read from public.organisations, which a caller can
-- read only for their own. It returns organisation ids and nothing else, only
-- for a caller with an active membership, and the private schema is not
-- exposed through PostgREST. Every term inside it reads the caller from
-- auth.uid() / the request mark, which a definer function sees unchanged.
-- ===========================================================================

create function private.network_reaching_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id
    from public.organisations o
   where exists (select 1 from public.organisation_memberships m
                  where m.user_id = (select auth.uid()) and m.status = 'active')
     and (
       private.organisation_network_presence_active(o.id)
       or private.is_active_member(o.id)
     )
  union
  select private.permitted_organisations('view_network');
$$;

comment on function private.network_reaching_organisations() is
  'Every organisation whose published, live network profiles the CURRENT CALLER may see: an active membership somewhere (Q70) AND the publisher still has network presence (Q88/Q92/Q101) or the caller is its member (Q6), OR the caller holds view_network over it. The row-reach half of the network read rule, in one place since 20261108003000 (Phase 10 Task 16, G29), which made it a set so the views ask it once per query instead of once per row. private.network_profile_reaches_caller() is membership in this set. SECURITY DEFINER to read public.organisations beyond the caller''s own; returns ids only.';

revoke all on function private.network_reaching_organisations() from public, anon, authenticated, service_role;
grant execute on function private.network_reaching_organisations() to authenticated;

create or replace function private.network_profile_reaches_caller(p_organisation_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_organisation_id in (select private.network_reaching_organisations());
$$;

comment on function private.network_profile_reaches_caller(uuid) is
  'May the CURRENT CALLER see a published, live network profile owned by this organisation? Membership in private.network_reaching_organisations(), where the terms live (since 20261108003000, Phase 10 Task 16). Called by private.network_profile_is_discoverable(); the two views test the set directly so it is computed once per query. Says nothing about status or deleted_at.';

-- Both views rebuilt from 20261108000000 with ONE term changed each:
-- reaches_caller(p.organisation_id) becomes membership in the set. Columns,
-- options and grants are unchanged; their pg_depend RELATION sets are
-- unchanged (N2); their FUNCTION sets swap reaches_caller for
-- network_reaching_organisations (rls_phase6_network.sql ND3c/ND3d and
-- network_leakage_phase6.sql LF2c are re-pinned for it, deliberately).
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
  and p.organisation_id in (select private.network_reaching_organisations())
  and private.request_is_from_server();

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
  and p.organisation_id in (select private.network_reaching_organisations())
  and private.request_is_from_server()
  and exists (
    select 1 from public.network_connection_requests r
     where r.status = 'accepted'
       and (   (r.to_organisation_id   = p.organisation_id
                and r.from_organisation_id in (select private.permitted_organisations('view_network')))
            or (r.from_organisation_id = p.organisation_id
                and r.to_organisation_id   in (select private.permitted_organisations('view_network')))));

do $$
declare v text;
begin
  foreach v in array array['public.network_directory', 'public.network_connected_profiles'] loop
    execute pg_catalog.format('comment on view %s is %L', v,
      pg_catalog.obj_description(v::regclass, 'pg_class')
      || ' Since 20261108003000 (Phase 10 Task 16, G29) the reach term is p.organisation_id in (select private.network_reaching_organisations()), the same rule as private.network_profile_reaches_caller(), asked once per query rather than once per row.');
  end loop;
end $$;
