-- ===========================================================================
-- PHASE 9 TASK 2: THE INTEGRATION RPCs. Tokens live in Vault, and only the
-- server reads them. No provider is live, so at MVP every real connect ends at
-- `integration_provider_not_live`.
--
-- WHAT THIS ADDS
--   1. private.integration_role_held(p_org): "this session holds
--      manage_integrations in p_org by ROLE", lifecycle ignored. has_permission
--      is false for every non-surviving key on a wound-down workspace, so
--      without this a suspended Owner is told `forbidden` when the truth is
--      `workspace_not_writable` -- and could not revoke a connection at all.
--   2. public.connect_integration()   -- authenticated. Inserts a pending row.
--   3. public.revoke_integration()    -- authenticated. Deletes the secret.
--   4. public.store_integration_token()       -- service_role only.
--   5. public.read_integration_token()        -- service_role only.
--   6. public.record_integration_sync_run()   -- service_role only.
--   7. The guard, rebuilt from LIVE: a revoked row admits NO update at all
--      (Task 1 review M5), except a foreign key's ON DELETE SET NULL on one
--      of its three person columns -- without that exception, deleting the
--      account that revoked a connection would be refused.
--   8. token_secret_id is no longer SELECTable by `authenticated`. Column
--      privileges cannot subtract from a table-level grant, so the table-level
--      SELECT is revoked and every OTHER column is granted by name. A browser
--      `select=*` is now refused; naming the columns works.
--   9. Four audit actions in the database copy of the catalogue (rebuilt from
--      LIVE); lib/admin/audit-actions.ts gains them in the same commit.
--
-- ATTRIBUTION. private.stamp_row_attribution() is a no-op under a postgres-
-- owned definer (Task 1, IT12), so connect sets created_by and revoke sets
-- revoked_by from auth.uid() themselves.
--
-- AUDIT. connect/revoke have a person on them and go through
-- private.log_audit_event(). store/sync have nobody on them; log_audit_event()
-- raises 28000 without an auth.uid(), so they INSERT into public.audit_events
-- directly with the Q130 tombstone as the actor -- the retention.swept
-- pattern. No payload ever holds a secret id or a token.
--
-- ERRORS NEVER ECHO INPUT. A provider error string could carry a token, so
-- p_error_code is validated here BEFORE the CHECK sees it: a CHECK violation's
-- DETAIL prints the failing row, value included.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE ROLE TEST, LIFECYCLE IGNORED.
-- ---------------------------------------------------------------------------
create or replace function private.integration_role_held(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organisation_memberships m
      join public.role_permissions rp on rp.role_key = m.role
     where m.user_id = (select auth.uid())
       and m.organisation_id = p_org
       and m.status = 'active'
       and rp.permission_key = 'manage_integrations'
       and (not private.role_requires_mfa(m.role) or private.session_is_aal2())
  );
$$;

comment on function private.integration_role_held(uuid) is
  'Phase 9 Task 2. TRUE when the session is an ACTIVE member of p_org whose role grants manage_integrations, with the MFA gate applied, IGNORING the workspace lifecycle. public.has_permission() answers false for every non-surviving key on a suspended or closed workspace; this is what lets connect_integration() name the real refusal (workspace_not_writable) and lets revoke_integration() work on a wound-down workspace. Never a grant on its own: both callers pair it with an explicit lifecycle test.';

revoke all on function private.integration_role_held(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. CONNECT.
-- ---------------------------------------------------------------------------
create or replace function public.connect_integration(
  p_org           uuid,
  p_provider      text,
  p_owner_user_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_live boolean;
  v_id   uuid;
begin
  if v_uid is null then
    raise exception 'connect_integration: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;

  -- null for a workspace that does not exist; false for a wound-down one.
  select o.deleted_at is null into v_live
    from public.organisations o where o.id = p_org;

  -- 1. forbidden. has_permission decides on a live workspace; on a wound-down
  --    one it is false for this non-surviving key, so the role test decides
  --    and the lifecycle refusal below names the real reason.
  if not (public.has_permission(p_org, 'manage_integrations')
          or (v_live is false and private.integration_role_held(p_org))) then
    raise exception 'connect_integration: the caller may not manage integrations in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;

  -- 2. the plan. crm_write_organisations() is the Starter+ gate every CRM
  --    write policy uses; it also drops a wound-down workspace, so for one of
  --    those the plan itself is read, and step 3 refuses it.
  if not exists (select 1 from private.crm_write_organisations() w where w = p_org)
     and not (v_live is false
              and exists (select 1 from private.effective_organisation_plan(p_org) e
                           where e.crm_writes and e.status_ok)) then
    raise exception 'connect_integration: this workspace''s plan does not include integrations'
      using errcode = '42501', hint = 'plan_does_not_include_integrations';
  end if;

  -- 3. writable: the predicate the CRM write path uses (deleted_at is null,
  --    which the organisations CHECK binds to lifecycle_state = 'active').
  if v_live is not true then
    raise exception 'connect_integration: this workspace is suspended or closed'
      using errcode = '42501', hint = 'workspace_not_writable';
  end if;

  -- 4. the catalogue.
  if not exists (select 1 from private.integration_providers() p where p.provider = p_provider) then
    raise exception 'connect_integration: unknown integration provider'
      using errcode = '22023', hint = 'unknown_integration_provider';
  end if;

  -- 5. live. AT MVP EVERY REAL CALL ENDS HERE.
  if not exists (select 1 from private.integration_providers() p
                  where p.provider = p_provider and p.live) then
    raise exception 'connect_integration: this provider cannot be connected yet'
      using errcode = '22023', hint = 'integration_provider_not_live';
  end if;

  -- 6. a person-scoped connection belongs to an active member.
  if p_owner_user_id is not null
     and not exists (select 1 from public.organisation_memberships m
                      where m.organisation_id = p_org and m.user_id = p_owner_user_id
                        and m.status = 'active') then
    raise exception 'connect_integration: the named owner is not an active member of this workspace'
      using errcode = '22023', hint = 'owner_not_a_member';
  end if;

  begin
    insert into public.integration_connections
      (organisation_id, provider, owner_user_id, status, created_by)
    values (p_org, p_provider, p_owner_user_id, 'pending', v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'connect_integration: this provider is already connected for that scope'
      using errcode = '23505', hint = 'integration_already_connected';
  end;

  perform private.log_audit_event(
    p_action          => 'integration.connected',
    p_target_type     => 'integration_connection',
    p_organisation_id => p_org,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object(
                           'provider', p_provider,
                           'owner_scoped', p_owner_user_id is not null));

  return v_id;
end;
$$;

comment on function public.connect_integration(uuid, text, uuid) is
  'Phase 9 Task 2. Opens a PENDING integration connection. Refusal order: not_authenticated (28000) -> forbidden (42501; no manage_integrations in p_org) -> plan_does_not_include_integrations (42501; not Starter+) -> workspace_not_writable (42501; suspended or closed) -> unknown_integration_provider (22023) -> integration_provider_not_live (22023) -> owner_not_a_member (22023). AT MVP NO PROVIDER IS LIVE, SO EVERY REAL CALL ENDS AT integration_provider_not_live. Sets created_by from the session (the attribution trigger is a no-op under a definer). Audited as integration.connected {provider, owner_scoped}.';

revoke all on function public.connect_integration(uuid, text, uuid) from public, anon;
grant execute on function public.connect_integration(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. REVOKE.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_integration(p_org uuid, p_connection_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_c    public.integration_connections%rowtype;
  v_role boolean;
begin
  if v_uid is null then
    raise exception 'revoke_integration: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;

  -- Works on a suspended or closed workspace: revoking only ever reduces
  -- access, so the lifecycle is deliberately not consulted.
  v_role := public.has_permission(p_org, 'manage_integrations')
            or private.integration_role_held(p_org);

  select * into v_c from public.integration_connections c
   where c.id = p_connection_id and c.organisation_id = p_org
   for update;

  if not found then
    if v_role then
      raise exception 'revoke_integration: no such connection in this workspace'
        using errcode = 'P0002', hint = 'integration_connection_not_found';
    end if;
    -- Not found and not entitled: the same answer as found-but-not-yours, so
    -- the call is no oracle for another workspace's connection ids.
    raise exception 'revoke_integration: the caller may not revoke this connection'
      using errcode = '42501', hint = 'forbidden';
  end if;

  -- coalesce: a WORKSPACE-scoped row has owner_user_id null, and
  -- `not (false or null)` is null, which an IF treats as false -- that would
  -- let anyone revoke any workspace-scoped connection (measured: IC11a).
  if not (v_role or coalesce(v_c.owner_user_id = v_uid, false)) then
    raise exception 'revoke_integration: the caller may not revoke this connection'
      using errcode = '42501', hint = 'forbidden';
  end if;

  -- Idempotent: a second revoke changes nothing and audits nothing.
  if v_c.status = 'revoked' then
    return;
  end if;

  if v_c.token_secret_id is not null then
    delete from vault.secrets where id = v_c.token_secret_id;
  end if;

  update public.integration_connections
     set status          = 'revoked',
         token_secret_id = null,
         revoked_at      = pg_catalog.now(),
         revoked_by      = v_uid
   where id = v_c.id;

  perform private.log_audit_event(
    p_action          => 'integration.revoked',
    p_target_type     => 'integration_connection',
    p_organisation_id => p_org,
    p_target_id       => v_c.id,
    p_after           => pg_catalog.jsonb_build_object(
                           'provider', v_c.provider,
                           'owner_scoped', v_c.owner_user_id is not null));
end;
$$;

comment on function public.revoke_integration(uuid, uuid) is
  'Phase 9 Task 2. Revokes a connection: allowed for a manage_integrations holder in p_org (by role, so it works on a suspended or closed workspace) or for the connection''s own owner_user_id. Locks the row; idempotent on an already-revoked row (no second audit). Deletes the Vault secret, then sets status revoked, token_secret_id null, revoked_at now(), revoked_by the session. Audited as integration.revoked {provider, owner_scoped}. A caller who is neither gets 42501 forbidden whether or not the id exists.';

revoke all on function public.revoke_integration(uuid, uuid) from public, anon;
grant execute on function public.revoke_integration(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. STORE A TOKEN (the server, after the OAuth callback).
-- ---------------------------------------------------------------------------
create or replace function public.store_integration_token(
  p_connection_id uuid,
  p_secret        jsonb,
  p_expires_at    timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   public.integration_connections%rowtype;
  v_sid uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), '') not in ('service_role', 'postgres', 'none', '') then
    raise exception 'store_integration_token: a token is stored by the server, never by a person''s session'
      using errcode = '42501', hint = 'not_a_server_session';
  end if;

  if p_secret is null or pg_catalog.jsonb_typeof(p_secret) <> 'object' then
    raise exception 'store_integration_token: the secret must be a json object'
      using errcode = '22023', hint = 'integration_secret_invalid';
  end if;

  select * into v_c from public.integration_connections c
   where c.id = p_connection_id
   for update;
  if not found then
    raise exception 'store_integration_token: no such connection'
      using errcode = 'P0002', hint = 'integration_connection_not_found';
  end if;
  if v_c.status not in ('pending', 'active', 'error') then
    raise exception 'store_integration_token: a revoked connection takes no token'
      using errcode = '22023', hint = 'integration_connection_revoked';
  end if;

  if v_c.token_secret_id is null then
    v_sid := vault.create_secret(p_secret::text, 'integration:' || v_c.id::text);
  else
    v_sid := v_c.token_secret_id;
    perform vault.update_secret(v_sid, p_secret::text);
  end if;

  update public.integration_connections
     set status           = 'active',
         token_secret_id  = v_sid,
         token_expires_at = p_expires_at
   where id = v_c.id;

  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    v_c.organisation_id, private.erased_user_id(), 'integration.token_stored', 'integration_connection',
    v_c.id, pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('provider', v_c.provider));
end;
$$;

comment on function public.store_integration_token(uuid, jsonb, timestamptz) is
  'Phase 9 Task 2. THE ONLY WRITER OF AN INTEGRATION TOKEN. service_role alone, and refuses any session with a person on it (not_a_server_session). Needs status pending/active/error. Creates the Vault secret (name integration:<connection id>) or updates it in place, then sets status active and token_expires_at. Audited as integration.token_stored with the provider ONLY -- never the secret id, never the token -- written directly with the Q130 tombstone as actor, because nobody is on the session.';

revoke all on function public.store_integration_token(uuid, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.store_integration_token(uuid, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. READ A TOKEN (the server, before a provider call).
-- ---------------------------------------------------------------------------
create or replace function public.read_integration_token(p_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.integration_connections%rowtype;
  v_s text;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), '') not in ('service_role', 'postgres', 'none', '') then
    raise exception 'read_integration_token: a token is read by the server, never by a person''s session'
      using errcode = '42501', hint = 'not_a_server_session';
  end if;

  select * into v_c from public.integration_connections c where c.id = p_connection_id;
  if not found or v_c.status <> 'active' or v_c.token_secret_id is null then
    raise exception 'read_integration_token: no active connection with a token'
      using errcode = 'P0002', hint = 'integration_connection_not_active';
  end if;

  select s.decrypted_secret into v_s from vault.decrypted_secrets s where s.id = v_c.token_secret_id;
  if v_s is null then
    raise exception 'read_integration_token: the connection''s secret is missing'
      using errcode = 'P0002', hint = 'integration_secret_missing';
  end if;

  return v_s::jsonb;
end;
$$;

comment on function public.read_integration_token(uuid) is
  'Phase 9 Task 2. Returns an ACTIVE connection''s token from vault.decrypted_secrets. service_role alone; refuses any session with a person on it (not_a_server_session). Anything else is P0002 integration_connection_not_active.';

revoke all on function public.read_integration_token(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_integration_token(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. A SYNC RUN (open with p_run_id null; close with it set).
-- ---------------------------------------------------------------------------
create or replace function public.record_integration_sync_run(
  p_connection_id uuid,
  p_run_id        uuid,
  p_status        text,
  p_items_read    integer,
  p_items_written integer,
  p_error_code    text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   public.integration_connections%rowtype;
  v_run uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), '') not in ('service_role', 'postgres', 'none', '') then
    raise exception 'record_integration_sync_run: a sync run is recorded by the server, never by a person''s session'
      using errcode = '42501', hint = 'not_a_server_session';
  end if;

  -- Validated here, NOT left to the CHECK: a CHECK violation's DETAIL prints
  -- the failing row, and a provider error string may carry a token. The value
  -- is never echoed.
  if p_error_code is not null
     and p_error_code not in ('auth_expired', 'rate_limited', 'provider_unavailable', 'scope_missing', 'internal') then
    raise exception 'record_integration_sync_run: error_code is not in the closed vocabulary'
      using errcode = '22023', hint = 'unknown_sync_error_code';
  end if;

  select * into v_c from public.integration_connections c
   where c.id = p_connection_id
   for update;
  if not found then
    raise exception 'record_integration_sync_run: no such connection'
      using errcode = 'P0002', hint = 'integration_connection_not_found';
  end if;

  -- OPEN.
  if p_run_id is null then
    if coalesce(p_status, 'running') <> 'running' or p_error_code is not null then
      raise exception 'record_integration_sync_run: a run opens as running, with no error'
        using errcode = '22023', hint = 'sync_run_opens_running';
    end if;
    if v_c.status not in ('active', 'error') then
      raise exception 'record_integration_sync_run: only an active connection syncs'
        using errcode = '22023', hint = 'integration_connection_not_active';
    end if;
    insert into public.integration_sync_runs (organisation_id, connection_id, status)
    values (v_c.organisation_id, v_c.id, 'running')
    returning id into v_run;
    return v_run;
  end if;

  -- CLOSE.
  if p_status is null or p_status not in ('succeeded', 'failed') then
    raise exception 'record_integration_sync_run: a run closes as succeeded or failed'
      using errcode = '22023', hint = 'sync_run_closes_terminal';
  end if;
  if (p_status = 'failed') <> (p_error_code is not null) then
    raise exception 'record_integration_sync_run: a failed run carries an error_code and only a failed run does'
      using errcode = '22023', hint = 'sync_run_error_code_mismatch';
  end if;

  update public.integration_sync_runs r
     set status        = p_status,
         finished_at   = pg_catalog.now(),
         items_read    = coalesce(p_items_read, 0),
         items_written = coalesce(p_items_written, 0),
         error_code    = p_error_code
   where r.id = p_run_id and r.connection_id = v_c.id and r.status = 'running'
  returning r.id into v_run;
  if v_run is null then
    raise exception 'record_integration_sync_run: no running sync run with that id on this connection'
      using errcode = 'P0002', hint = 'sync_run_not_running';
  end if;

  -- A revoked connection is frozen (the guard); its run is still closed.
  if v_c.status <> 'revoked' then
    if p_status = 'failed' then
      update public.integration_connections set status = 'error' where id = v_c.id;
    else
      update public.integration_connections set last_synced_at = pg_catalog.now() where id = v_c.id;
    end if;
  end if;

  if p_status = 'failed' then
    insert into public.audit_events
      (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
    values (
      v_c.organisation_id, private.erased_user_id(), 'integration.sync_failed', 'integration_connection',
      v_c.id, pg_catalog.gen_random_uuid(),
      pg_catalog.jsonb_build_object('provider', v_c.provider, 'error_code', p_error_code));
  end if;

  return v_run;
end;
$$;

comment on function public.record_integration_sync_run(uuid, uuid, text, integer, integer, text) is
  'Phase 9 Task 2. The server''s record of a sync attempt. service_role alone; refuses any session with a person on it. p_run_id null opens a running row (active/error connection only); otherwise closes that running row as succeeded (sets the connection''s last_synced_at) or failed (sets the connection to error and audits integration.sync_failed {provider, error_code}, tombstone actor). error_code is checked against the closed vocabulary before the CHECK, so a free-text value is never echoed in an error.';

revoke all on function public.record_integration_sync_run(uuid, uuid, text, integer, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_integration_sync_run(uuid, uuid, text, integer, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. THE GUARD, REBUILT FROM LIVE (20261030000000): a revoked row is frozen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.integration_connections_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from private.integration_providers() p where p.provider = new.provider) then
    raise exception 'integration_connections: provider % is not in the integration catalogue', new.provider
      using errcode = '23514', hint = 'unknown_integration_provider';
  end if;

  -- 20261030001000 (Task 1 review M5): REVOKED IS TERMINAL FOR THE WHOLE ROW,
  -- not only for status. The one update a revoked row admits is a foreign
  -- key's ON DELETE SET NULL on owner_user_id / created_by / revoked_by --
  -- otherwise deleting (or erasing) the account that revoked it is refused.
  if tg_op = 'UPDATE' and old.status = 'revoked' then
    if (new.id, new.organisation_id, new.provider, new.status, new.scopes, new.token_secret_id,
        new.token_expires_at, new.last_synced_at, new.created_at, new.revoked_at)
       is distinct from
       (old.id, old.organisation_id, old.provider, old.status, old.scopes, old.token_secret_id,
        old.token_expires_at, old.last_synced_at, old.created_at, old.revoked_at)
       or (new.owner_user_id is distinct from old.owner_user_id and new.owner_user_id is not null)
       or (new.created_by    is distinct from old.created_by    and new.created_by    is not null)
       or (new.revoked_by    is distinct from old.revoked_by    and new.revoked_by    is not null)
    then
      raise exception 'integration_connections: a revoked connection cannot be changed; connect again instead'
        using errcode = '23514', hint = 'revoked_is_terminal';
    end if;
  end if;

  return new;
end;
$function$;

comment on function private.integration_connections_guard() is
  'Phase 9. BEFORE INSERT OR UPDATE on public.integration_connections: refuses a provider outside private.integration_providers() (23514, hint unknown_integration_provider) and ANY update of a revoked row (23514, hint revoked_is_terminal; since 20261030001000, previously only a move out of status revoked), except a foreign key nulling owner_user_id / created_by / revoked_by when the referenced account is deleted.';

-- ---------------------------------------------------------------------------
-- 8. token_secret_id IS NOT READABLE BY A CLIENT.
-- ---------------------------------------------------------------------------
revoke select on public.integration_connections from authenticated;
grant select (id, organisation_id, provider, owner_user_id, status, scopes,
              token_expires_at, last_synced_at, created_by, created_at,
              revoked_at, revoked_by)
   on public.integration_connections to authenticated;

-- ---------------------------------------------------------------------------
-- 9. THE AUDIT CATALOGUE (database copy), rebuilt from LIVE
--    (20261027002000), four names appended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.platform_audit_actions()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
    ('membership.accepted'),
    ('document_uploaded'),
    ('document_downloaded'),
    ('document_deleted'),
    ('document_quarantined'),
    ('network_profile.published'),
    ('network_profile.unpublished'),
    ('network_profile.visibility_changed'),
    ('network_connection.requested'),
    ('network_connection.accepted'),
    ('network_connection.declined'),
    ('network_connection.withdrawn'),
    ('network_connection.updated'),
    ('audit_log.viewed'),
    ('impersonation.requested'),
    ('impersonation.accepted'),
    ('impersonation.declined'),
    ('impersonation.started'),
    ('impersonation.page_viewed'),
    ('impersonation.ended'),
    ('impersonation.expired'),
    ('organisation.suspended'),
    ('organisation.deleted'),
    ('organisation.reinstated'),
    ('organisation.closed_by_owner'),
    ('organisation.closure_reassigned'),
    ('organisation.closure_deleted'),
    ('organisation.closure_candidates_viewed'),
    ('organisation.billing_override_granted'),
    ('organisation.billing_override_revoked'),
    ('organisation.feature_override_granted'),
    ('organisation.feature_override_revoked'),
    ('platform_health.viewed'),
    ('incident_alert.resolved'),
    ('incident_alert.reopened'),
    ('feedback.submitted'),
    ('feedback.status_changed'),
    ('feedback.screenshot_viewed'),
    ('legal_document.draft_created'),
    ('legal_document.draft_updated'),
    ('legal_document.published'),
    ('legal_document.counsel_review_recorded'),
    ('consent.granted'),
    ('consent.withdrawn'),
    ('data_subject_request.submitted'),
    ('data_subject_request.in_progress'),
    ('data_subject_request.routed'),
    ('data_subject_request.fulfilled'),
    ('data_subject_request.rejected'),
    ('data_subject_request.withdrawn'),
    ('data_subject_request.fulfilment_recorded'),
    ('data_subject_request.note_added'),
    ('data_subject_request.rerouted'),
    ('export_job.requested'),
    ('export_job.downloaded'),
    ('erasure_job.requested'),
    ('account.erased'),
    ('organisation.erased'),
    ('retention_settings.changed'),
    ('retention.swept'),
    ('retention.audit_ceiling_released'),
    ('integration.connected'),
    ('integration.revoked'),
    ('integration.token_stored'),
    ('integration.sync_failed')
$function$
;
