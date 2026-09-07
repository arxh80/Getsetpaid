-- Phase 6 (Network), final whole-branch review finding I1: publishing a
-- profile by DIRECT INSERT emitted no audit row -- the exact path the trigger
-- migration's own header says the trigger exists to cover.
--
-- ===========================================================================
-- THE GAP, MEASURED AGAINST THE SHIPPED OBJECTS
-- ===========================================================================
-- 20260904005000's network_profiles branch emits network_profile.published
-- only on `tg_op = 'UPDATE' and old.status = 'draft' and new.status =
-- 'published'`, and its `else` arm returns null for EVERY INSERT ("An INSERT
-- (a draft), or an ordinary field edit"). But nothing forces an insert to be a
-- draft:
--
--   * network_profiles_insert_manage_profile (20260904003000) carries no
--     status term;
--   * network_profiles_published_at_iff_published (20260904000000) is
--     satisfiable at creation -- status='published' with a non-null
--     published_at;
--   * there is no BEFORE INSERT trigger forcing status='draft'.
--
-- The application always inserts drafts (lib/network/profiles.ts), but that is
-- precisely the layer 20260904005000's header says cannot be relied on: the
-- client grants plus the anon key make `POST /rest/v1/network_profiles` with
-- `{"status":"published","published_at":...}` reachable WITHOUT touching the
-- Next.js app. So a holder of manage_network_profile could publish an identity
-- to every other tenant in the product and leave no network_profile.published
-- row -- an audit-completeness hole (not an access-control one: the same actor
-- could publish through the audited UPDATE path anyway), on the one action
-- PRD § 15 names explicitly.
--
-- ===========================================================================
-- THE FIX: ONE NEW BRANCH, AHEAD OF THE EXISTING CHAIN. NOTHING ELSE MOVES.
-- ===========================================================================
-- `tg_op = 'INSERT' and new.status = 'published'` now emits
-- network_profile.published. An INSERT as a draft still emits nothing (the
-- header's "a draft nobody else can see is not a high-value action" reasoning
-- is untouched -- what was wrong was only that the else-arm's parenthetical
-- assumed every INSERT is a draft). The connection-requests branch, the
-- payload allowlist, the sessionless early return and the live organisation
-- lookup are copied verbatim from 20260904005000.
--
-- Additive: `create or replace function` reissues the live function body; the
-- shipped 20260904005000 file is not edited (its `--` header still carries the
-- old else-arm wording, immutably -- this file is the correction of record,
-- the 20260904007000 precedent). rls_phase6_network.sql § NX5 is the
-- behavioural assertion: an authenticated insert-as-published emits exactly
-- one row, and an insert-as-draft still emits none.

create or replace function private.audit_network_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_action text;
  v_org    uuid;
  v_after  jsonb;
begin
  -- Sessionless writer: a migration, a seed, DBA repair, or a foreign-key
  -- cascade initiated by one. Not a client action, has no actor to attribute,
  -- and must not be turned into an error -- 20260828160000's early return.
  if v_actor is null then
    return null;
  end if;

  if tg_table_name = 'network_profiles' then
    -- Q81's transitions, then the visibility change. `elsif`, not independent
    -- branches: a single UPDATE that both publishes and changes visibility
    -- emits the PUBLISH row, because that is the consequential half and the
    -- payload carries the new field_visibility either way.
    --
    -- INSERT-AS-PUBLISHED FIRST (20260907001000): nothing forces an INSERT to
    -- be a draft, and publishing at creation is the same escalation as
    -- draft -> published -- so it emits the same action.
    if tg_op = 'INSERT' and new.status = 'published' then
      v_action := 'network_profile.published';
    elsif tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'published' then
      v_action := 'network_profile.published';
    elsif tg_op = 'UPDATE' and old.status = 'published' and new.status = 'draft' then
      v_action := 'network_profile.unpublished';
    elsif tg_op = 'UPDATE'
          and new.field_visibility is distinct from old.field_visibility then
      v_action := 'network_profile.visibility_changed';
    else
      -- An INSERT as a DRAFT, or an ordinary field edit. Not audited -- see
      -- 20260904005000's header's "what deliberately is not".
      return null;
    end if;

    -- LIVE LOOKUP, never new.organisation_id directly (20260828160000 New-1).
    select o.id into v_org
      from public.organisations o where o.id = new.organisation_id;

    -- IDENTIFIERS AND THE VISIBILITY MAP ONLY. No display_name, no headline,
    -- no bio, no city/region/country, no website_url, no contact_email --
    -- audit_events is superuser-readable.
    v_after := pg_catalog.jsonb_build_object(
      'entity_kind',      new.entity_kind,
      'entity_id',        new.entity_id,
      'status',           new.status,
      'field_visibility', new.field_visibility
    );

    perform private.log_audit_event(
      p_action          => v_action,
      p_target_type     => 'network_profile',
      p_organisation_id => v_org,
      p_target_id       => new.id,
      p_after           => v_after
    );

  elsif tg_table_name = 'network_connection_requests' then
    if tg_op = 'INSERT' then
      v_action := 'network_connection.requested';
    elsif tg_op = 'UPDATE' and new.status = 'accepted'
          and old.status is distinct from new.status then
      v_action := 'network_connection.accepted';
    elsif tg_op = 'UPDATE' and new.status = 'declined'
          and old.status is distinct from new.status then
      v_action := 'network_connection.declined';
    else
      -- A withdrawal, or an UPDATE that moved something else. Not audited.
      return null;
    end if;

    -- BI-TENANT (Q83), so the audit row is filed against the SENDING
    -- organisation for a request and the RESPONDING one for an answer -- the
    -- organisation whose member performed the act, which is what an audit
    -- trail is a record of. The other side is in the payload.
    select o.id into v_org
      from public.organisations o
     where o.id = case when tg_op = 'INSERT'
                       then new.from_organisation_id
                       else new.to_organisation_id end;

    v_after := pg_catalog.jsonb_build_object(
      'status',                  new.status,
      'from_organisation_id',    new.from_organisation_id,
      'to_organisation_id',      new.to_organisation_id,
      'from_network_profile_id', new.from_network_profile_id,
      'to_network_profile_id',   new.to_network_profile_id
    );

    perform private.log_audit_event(
      p_action          => v_action,
      p_target_type     => 'network_connection_request',
      p_organisation_id => v_org,
      p_target_id       => new.id,
      p_after           => v_after
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function private.audit_network_row() is
  'AFTER-trigger audit writer for the network surface (Q84; PRD § 15 names "Network publishing and changes to visibility" explicitly). Emits network_profile.published / .unpublished / .visibility_changed on the relevant transitions and network_connection.requested / .accepted / .declined. SINCE 20260907001000, INSERT-AS-PUBLISHED also emits network_profile.published: nothing forces an INSERT to be a draft (the INSERT policy carries no status term and the published_at CHECK is satisfiable at creation), and as first shipped a direct POST with status=published would have published an identity platform-wide with no audit row. A TRIGGER rather than an app-side audit because network_profiles carries client grants and the anon key ships in every browser, so a write setting status=published never has to touch the Next.js app -- the database is the only chokepoint (the same argument 20260828141000 makes, and the opposite of the documents case, whose bytes have no PostgREST path). Modelled line-for-line on private.audit_crm_row (20260828160000), including its auth.uid() is null early return (a migration/seed/cascade is not a client action) and its LIVE LOOKUP of organisation_id through public.organisations (naming NEW directly aborts an organisation cascade with 23503 -- New-1 in that file). PAYLOAD IS field_visibility AND IDENTIFIERS ONLY, NEVER A PUBLISHED FIELD''S VALUE: audit_events is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface. field_visibility is a map of field NAMES to LEVELS and carries no value the publisher wrote -- and an audit row saying "visibility changed" without saying to what is a notification, not an audit trail. Calls private.log_audit_event(), which is granted to no client role -- hence SECURITY DEFINER.';

-- Grants are preserved across `create or replace`, but the revocation is the
-- entire client-facing surface of this function, so it is restated rather than
-- assumed.
revoke all on function private.audit_network_row()
  from public, anon, authenticated, service_role;
