-- Phase 6 (Network), Task 1f: private.audit_network_row() and the two triggers
-- that call it (Q84).
--
-- PRD § 15 "Audit events to retain" names "Network publishing and changes to
-- visibility" EXPLICITLY, and CLAUDE.md § Non-negotiable rules requires actor,
-- org, timestamp, action, target and before/after on every high-value action.
-- Publishing an identity to every other tenant in the product is the
-- highest-value action this phase adds, and changing a field's visibility is
-- the one a user is most likely to get wrong. This file owes both.
--
-- ===========================================================================
-- A TRIGGER, NOT AN APP-SIDE AUDIT -- AND WHY THAT DIFFERS FROM DOCUMENTS
-- ===========================================================================
-- 20260902031000 chose an APP-SIDE audit for documents, on the argument that a
-- document's BYTES have no PostgREST path: storage.objects is deny-all fenced,
-- so the application is the only way in or out.
--
-- NETWORK PROFILES ARE THE OPPOSITE CASE, and it is the Phase 2 case verbatim:
-- `grant select, insert, update ... to authenticated` plus the anon key that
-- ships in every browser bundle makes
-- `PATCH /rest/v1/network_profiles?id=eq...` with `{"status":"published"}`
-- reachable WITHOUT touching the Next.js app. For this table the DATABASE is
-- the only chokepoint, so the audit has to live in the database. Same
-- reasoning 20260828141000 gives for the hard-delete and merge triggers.
--
-- ===========================================================================
-- MODELLED LINE-FOR-LINE ON private.audit_crm_row() (20260828160000)
-- ===========================================================================
-- Two properties are carried over verbatim, and each of them was a measured
-- defect somewhere before it was a convention:
--
--   1. THE `auth.uid() is null` EARLY RETURN. A migration, a seed or a
--      foreign-key cascade initiated by a DBA is not a client action, has no
--      actor to attribute, and private.log_audit_event() raises 28000 on a
--      null actor -- so an unconditional trigger would abort those statements.
--
--   2. organisation_id RESOLVED THROUGH A LIVE LOOKUP, never named off
--      NEW/OLD directly. 20260828160000 New-1: a cascade from
--      public.organisations removes the parent BEFORE this trigger runs, and
--      audit_events' foreign key to it aborts the whole DELETE with 23503 as
--      soon as a session is set. A vanished parent resolves to NULL, which the
--      nullable column accepts, so the audit row survives and the delete
--      completes. Both network tables cascade from public.organisations, so
--      both would hit it.
--
-- It is a SEPARATE FUNCTION rather than a new tg_argv shape on audit_crm_row
-- because the ACTION is not a constant here: which action string to emit
-- depends on the TRANSITION (draft -> published is `published`, published ->
-- draft is `unpublished`, a field_visibility change is `visibility_changed`),
-- which a two-argument trigger cannot express and which audit_crm_row has no
-- concept of. Editing audit_crm_row to grow one would change the behaviour of
-- three shipped Phase 2 triggers.
--
-- ===========================================================================
-- PAYLOAD: field_visibility AND IDENTIFIERS ONLY. NEVER A PUBLISHED VALUE.
-- ===========================================================================
-- public.audit_events is superuser-readable, and CLAUDE.md § Superuser
-- dashboard keeps tenant record content off that surface ("The dashboard never
-- shows record content ... only aggregate metadata"). private.audit_crm_payload
-- is the same rule written as an allowlist for the Phase 2 tables, and this
-- function applies it by construction: the payloads below name
-- entity_kind/entity_id/status/field_visibility and the request's four
-- identifier columns, and NOT display_name, headline, bio, city, region,
-- country, website_url or contact_email.
--
-- field_visibility IS INCLUDED ON PURPOSE and is not an exception to that
-- rule: it is a map of field NAMES to LEVELS. It contains no value the
-- publisher wrote. It is also the entire point of a `visibility_changed` audit
-- row -- an audit that says "visibility changed" without saying to what is not
-- an audit trail, it is a notification.
--
-- ===========================================================================
-- WHAT IS AUDITED, AND WHAT DELIBERATELY IS NOT
-- ===========================================================================
--   network_profile.published          draft -> published
--   network_profile.unpublished        published -> draft
--   network_profile.visibility_changed field_visibility is distinct from old
--   network_connection.requested       INSERT
--   network_connection.accepted        status -> accepted
--   network_connection.declined        status -> declined
--
-- NOT audited, each for a reason:
--   * profile CREATE (a draft nobody else can see is not a high-value action;
--     the publish that makes it visible is, and it is audited).
--   * ordinary field EDITS on an unpublished-or-published profile (they are
--     CRM-grade record edits, and field-level edit auditing is a Phase 7
--     decision for the whole schema, not a network-only one).
--   * profile SOFT-DELETE (it removes the row from discovery, i.e. it is a
--     de-escalation; the audit trail's job here is escalation).
--   * network_links entirely (Q82: a link is private to the linking
--     organisation, is invisible to everyone else, and grants nothing).
--   * connection WITHDRAWN (the sender retracting its own request grants
--     nothing to anyone and reveals nothing).
-- ===========================================================================

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
    -- Q81's two transitions, then the visibility change. `elsif`, not three
    -- independent branches: a single UPDATE that both publishes and changes
    -- visibility emits the PUBLISH row, because that is the consequential half
    -- and the payload carries the new field_visibility either way.
    if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'published' then
      v_action := 'network_profile.published';
    elsif tg_op = 'UPDATE' and old.status = 'published' and new.status = 'draft' then
      v_action := 'network_profile.unpublished';
    elsif tg_op = 'UPDATE'
          and new.field_visibility is distinct from old.field_visibility then
      v_action := 'network_profile.visibility_changed';
    else
      -- An INSERT (a draft), or an ordinary field edit. Not audited -- see the
      -- header's "what deliberately is not".
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
  'AFTER-trigger audit writer for the network surface (Q84; PRD § 15 names "Network publishing and changes to visibility" explicitly). Emits network_profile.published / .unpublished / .visibility_changed on the relevant transitions and network_connection.requested / .accepted / .declined. A TRIGGER rather than an app-side audit because network_profiles carries client grants and the anon key ships in every browser, so a PATCH setting status=published never touches the Next.js app -- the database is the only chokepoint (the same argument 20260828141000 makes, and the opposite of the documents case, whose bytes have no PostgREST path). Modelled line-for-line on private.audit_crm_row (20260828160000), including its auth.uid() is null early return (a migration/seed/cascade is not a client action) and its LIVE LOOKUP of organisation_id through public.organisations (naming NEW directly aborts an organisation cascade with 23503 -- New-1 in that file). PAYLOAD IS field_visibility AND IDENTIFIERS ONLY, NEVER A PUBLISHED FIELD''S VALUE: audit_events is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface. field_visibility is a map of field NAMES to LEVELS and carries no value the publisher wrote -- and an audit row saying "visibility changed" without saying to what is a notification, not an audit trail. Calls private.log_audit_event(), which is granted to no client role -- hence SECURITY DEFINER.';

revoke all on function private.audit_network_row()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Attachment. Two triggers, one per table, listed one per statement so the
-- audited set is greppable -- the 20260828141000 pattern.
--
-- AFTER INSERT OR UPDATE on both. The function itself decides which
-- transitions are worth a row and returns null for the rest, rather than the
-- trigger carrying a `when` clause: the publish/unpublish/visibility split
-- needs OLD and NEW together in three combinations, which reads far more
-- clearly as plpgsql than as a `when` expression, and a `when` that got one of
-- the three wrong would silently stop auditing.
--
-- FOR EACH ROW rather than statement-level: the audit needs each row's
-- target_id, which a statement-level trigger does not have.
--
-- NO TRIGGER ON public.network_links. Q82: a link is private to the linking
-- organisation, invisible to everyone else, and grants nothing. Stated so the
-- absence reads as a decision.
-- ---------------------------------------------------------------------------
drop trigger if exists audit_network on public.network_profiles;
create trigger audit_network
  after insert or update on public.network_profiles
  for each row
  execute function private.audit_network_row();

drop trigger if exists audit_network on public.network_connection_requests;
create trigger audit_network
  after insert or update on public.network_connection_requests
  for each row
  execute function private.audit_network_row();
