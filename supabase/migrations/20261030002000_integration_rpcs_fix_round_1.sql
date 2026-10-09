-- ===========================================================================
-- PHASE 9 TASK 2, FIX ROUND 1 (task-2-review.md). Rebuilt from the LIVE
-- pg_get_functiondef of 20261030001000; no shipped migration is edited.
--
--   m4  The revoked-row freeze FAILS CLOSED. It compared ten columns by name,
--       so a column added later would have escaped it. It now compares the
--       whole row as jsonb minus the three person columns, and those three may
--       only move to NULL (an FK's ON DELETE SET NULL).
--   m6  store_integration_token() with a DANGLING token_secret_id (the Vault
--       secret deleted out of band). vault.update_secret() on a missing id
--       updates nothing and raises nothing, so the row went `active` with no
--       token behind it, and the failure surfaced only at read time. The
--       secret is now RECREATED. Recreating is the safer choice: a store is
--       the server presenting a fresh, legitimately obtained token, so
--       recreating keeps the invariant "active => a readable secret exists".
--       Raising instead would strand the connection with no way to recover
--       short of revoke-and-reconnect, and would add no protection: only
--       service_role or postgres can delete the secret in the first place.
--   m7  private.integration_role_held() is SECURITY INVOKER. Its only callers
--       are connect_integration() and revoke_integration(), both
--       postgres-owned definers, so it already runs as postgres; the definer
--       bit widened nothing and narrowed nothing. EXECUTE stays revoked from
--       every client role.
--
-- C1 (the role half of the not_a_server_session rail) needs no code change:
-- it gains assertions (rls_phase9_integrations.sql IV5d/e/f) and mutants.
-- ===========================================================================

-- m7 ------------------------------------------------------------------------
alter function private.integration_role_held(uuid) security invoker;

-- m4 ------------------------------------------------------------------------
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

  -- REVOKED IS TERMINAL FOR THE WHOLE ROW (20261030001000), and since
  -- 20261030002000 it FAILS CLOSED: the whole row as jsonb, minus the three
  -- person columns, must be unchanged -- so a column added later is frozen
  -- without anyone remembering to list it. The three may only be NULLED (a
  -- foreign key's ON DELETE SET NULL when the account is deleted or erased).
  if tg_op = 'UPDATE' and old.status = 'revoked' then
    if (pg_catalog.to_jsonb(new) - array['owner_user_id', 'created_by', 'revoked_by'])
         is distinct from
       (pg_catalog.to_jsonb(old) - array['owner_user_id', 'created_by', 'revoked_by'])
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

-- m6 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_integration_token(p_connection_id uuid, p_secret jsonb, p_expires_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- 20261030002000 (m6): a DANGLING reference (the secret deleted out of band)
  -- is treated as no secret at all and the secret is recreated. Without this,
  -- vault.update_secret() on the missing id updated nothing, raised nothing,
  -- and the row went `active` with no token behind it.
  if v_c.token_secret_id is not null
     and exists (select 1 from vault.secrets s where s.id = v_c.token_secret_id) then
    v_sid := v_c.token_secret_id;
    perform vault.update_secret(v_sid, p_secret::text);
  else
    -- A stale secret under this connection's name (its id lost) would collide
    -- with the unique name; it is this connection's own, so it goes first.
    delete from vault.secrets s where s.name = 'integration:' || v_c.id::text;
    v_sid := vault.create_secret(p_secret::text, 'integration:' || v_c.id::text);
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
$function$;

comment on function public.store_integration_token(uuid, jsonb, timestamptz) is
  'Phase 9 Task 2. THE ONLY WRITER OF AN INTEGRATION TOKEN. service_role alone, and refuses any session with a person on it, or any role other than service_role/postgres (not_a_server_session). Needs status pending/active/error. Creates the Vault secret (name integration:<connection id>) or rotates it in place; since 20261030002000 a dangling token_secret_id (secret deleted out of band) is recreated rather than silently left missing. Sets status active and token_expires_at. Audited as integration.token_stored with the provider ONLY -- never the secret id, never the token -- written directly with the Q130 tombstone as actor.';
