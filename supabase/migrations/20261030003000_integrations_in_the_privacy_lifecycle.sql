-- ===========================================================================
-- PHASE 9 TASK 3 -- INTEGRATIONS IN THE PRIVACY LIFECYCLE.
--
-- Every function below that already existed is rebuilt from its LIVE
-- pg_get_functiondef (no shipped migration is edited), with only the stated
-- lines added:
--
--   (1) private.integration_connections_guard(): a revoked row's created_by
--       and revoked_by may also move to the Q130 tombstone (the erasure's
--       re-point), not only to NULL; and a LIVE person-scoped row whose owner
--       is nulled by the FK (an account deleted outside the erasure) is
--       revoked in that same write, its Vault secret deleted, so it can never
--       become a live workspace-scoped connection.
--   (2) private.revoke_integration_row() -- NEW. The one "delete the Vault
--       secret, mark revoked, audit" primitive, factored out of
--       revoke_integration() so the membership trigger and the erasure reuse
--       it rather than restate it.
--   (3) public.revoke_integration(): its body after the authorisation checks
--       is now one call to (2).
--   (4) A person who LEAVES a workspace (membership deleted, or revoked)
--       loses their person-scoped connections there: an AFTER DELETE/UPDATE
--       trigger on organisation_memberships revokes them through (2).
--       Workspace-scoped connections they created are the workspace's and stay.
--   (5) private.erase_account() step 5c, BEFORE the auth.users delete: each
--       of the person's person-scoped connections is revoked through (2)
--       (Vault secret first) and then deleted with its sync runs; what they
--       created or revoked for a workspace is attributed to the tombstone.
--       Task 1 review finding (routed here): owner_user_id is ON DELETE SET
--       NULL, so without this step the erasure turned a person-scoped
--       connection into a WORKSPACE-scoped one an Owner/Admin can read,
--       orphaned its Vault secret, and -- with a live workspace connection to
--       the same provider -- FAILED on integration_connections_one_live.
--   (6) private.erase_organisation() step 5c: the workspace's Vault secrets
--       are deleted before the cascade (vault.secrets has no foreign key to
--       anything of ours, so the cascade alone orphaned every one).
--   (7) private.export_catalogue(): Task 1's three INTERIM excused rows become
--       exports. token_secret_id is projected OUT by name (and is not
--       selectable by authenticated anyway, 20261030001000).
--   (8) private.fkless_identifier_columns(): token_secret_id's interim note is
--       replaced by its final one (classification unchanged: not a person).
--   (9) Retention: two classes (integration_sync_run 90 days,
--       integration_connection_revoked 2 years), Task 1's interim `cascades`
--       subjects become `swept`, a sweep that applies them, the sweep body
--       that runs it, and the two clock columns classified.
--
-- private.audit_payload_person_columns() needs no change: it is derived from
-- the CRM audit triggers, and neither integration table carries one; the
-- integration audit payloads are {provider, owner_scoped[, reason]} and
-- {provider[, error_code]} -- no person column (rls_phase9_integrations.sql
-- IE5 measures the erasure's payload scan over them).
-- ===========================================================================

-- (1) THE GUARD ------------------------------------------------------------
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

  -- 20261030003000: AN ACCOUNT DELETED OUTSIDE THE ERASURE. erase_account()
  -- deletes a person's own person-scoped connections before it deletes the
  -- account (step 5c). Anything else that deletes an auth.users row -- the
  -- Auth admin API, a Studio click; no product path does -- reaches this row
  -- through owner_user_id's ON DELETE SET NULL, and that UPDATE runs BEFORE
  -- any AFTER trigger on the cascaded membership (measured). Left alone it
  -- would turn the person's own mailbox into a LIVE workspace-scoped
  -- connection an Owner can read, keep its Vault secret, and -- beside a live
  -- workspace connection to the same provider -- refuse the delete on the
  -- one-live index. So that write REVOKES the row in place: the secret is
  -- deleted, the row is marked revoked (it keeps no owner, because the owner
  -- no longer exists) and the revoke is audited with the tombstone as actor.
  if tg_op = 'UPDATE' and old.status <> 'revoked'
     and old.owner_user_id is not null and new.owner_user_id is null then
    delete from vault.secrets s
     where s.id = old.token_secret_id or s.name = 'integration:' || old.id::text;
    new.status          := 'revoked';
    new.token_secret_id := null;
    new.revoked_at      := pg_catalog.now();
    insert into public.audit_events
      (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
    values (
      old.organisation_id, private.erased_user_id(), 'integration.revoked', 'integration_connection', old.id,
      pg_catalog.gen_random_uuid(),
      pg_catalog.jsonb_build_object('provider', old.provider, 'owner_scoped', true, 'reason', 'account_deleted'));
    return new;
  end if;

  -- REVOKED IS TERMINAL FOR THE WHOLE ROW (20261030001000), and since
  -- 20261030002000 it FAILS CLOSED: the whole row as jsonb, minus the three
  -- person columns, must be unchanged -- so a column added later is frozen
  -- without anyone remembering to list it. The three may only be NULLED (a
  -- foreign key's ON DELETE SET NULL when the account is deleted or erased).
  -- Since 20261030003000 created_by and revoked_by may also move to the Q130
  -- TOMBSTONE, and only to it: erase_account() step 5c attributes what an
  -- erased person created or revoked for a workspace to the shared "erased
  -- user" marker, the same re-point step 7 makes for every NO ACTION key.
  -- owner_user_id gets no such exemption -- a person-scoped row is deleted by
  -- the erasure, never handed to the tombstone.
  if tg_op = 'UPDATE' and old.status = 'revoked' then
    if (pg_catalog.to_jsonb(new) - array['owner_user_id', 'created_by', 'revoked_by'])
         is distinct from
       (pg_catalog.to_jsonb(old) - array['owner_user_id', 'created_by', 'revoked_by'])
       or (new.owner_user_id is distinct from old.owner_user_id and new.owner_user_id is not null)
       or (new.created_by    is distinct from old.created_by    and new.created_by    is not null
           and new.created_by    is distinct from private.erased_user_id())
       or (new.revoked_by    is distinct from old.revoked_by    and new.revoked_by    is not null
           and new.revoked_by    is distinct from private.erased_user_id())
    then
      raise exception 'integration_connections: a revoked connection cannot be changed; connect again instead'
        using errcode = '23514', hint = 'revoked_is_terminal';
    end if;
  end if;

  return new;
end;
$function$;

-- (2) THE PRIMITIVE -------------------------------------------------------------
-- Returns true when it revoked the row, false when there was nothing to do
-- (no such row, or already revoked: idempotent, no second audit row).
--
-- p_actor is who revoked it: the session's person for the RPC and for a
-- member removed by an Admin; NULL when nobody is on the session (an account
-- deleted through the Auth admin API); the tombstone for an erasure. The
-- audit row goes through log_audit_event() when p_actor IS the session's
-- person, so the correlation thread is the usual one; otherwise it is
-- written directly with p_actor, or the tombstone when p_actor is NULL (the
-- sessionless pattern of 20261030001000).
--
-- p_reason is NULL for the person's own revoke (the payload stays exactly
-- {provider, owner_scoped}) and a fixed word otherwise. It is never free text
-- from a client: the only callers are this migration's trigger and erasure.
create or replace function private.revoke_integration_row(
  p_connection_id uuid, p_actor uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_c     public.integration_connections%rowtype;
  v_after jsonb;
begin
  select * into v_c from public.integration_connections c
   where c.id = p_connection_id
   for update;

  if not found or v_c.status = 'revoked' then
    return false;
  end if;

  -- THE SECRET FIRST, by id and by the connection's own name (a secret whose
  -- id the row lost is still this connection's).
  delete from vault.secrets s
   where s.id = v_c.token_secret_id
      or s.name = 'integration:' || v_c.id::text;

  update public.integration_connections
     set status          = 'revoked',
         token_secret_id = null,
         revoked_at      = pg_catalog.now(),
         revoked_by      = p_actor
   where id = v_c.id;

  v_after := pg_catalog.jsonb_build_object(
               'provider', v_c.provider,
               'owner_scoped', v_c.owner_user_id is not null);
  if p_reason is not null then
    v_after := v_after || pg_catalog.jsonb_build_object('reason', p_reason);
  end if;

  if p_actor is not null and p_actor = (select auth.uid()) then
    perform private.log_audit_event(
      p_action          => 'integration.revoked',
      p_target_type     => 'integration_connection',
      p_organisation_id => v_c.organisation_id,
      p_target_id       => v_c.id,
      p_after           => v_after);
  else
    insert into public.audit_events
      (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
    values (
      v_c.organisation_id, coalesce(p_actor, private.erased_user_id()),
      'integration.revoked', 'integration_connection', v_c.id,
      pg_catalog.gen_random_uuid(), v_after);
  end if;

  return true;
end;
$function$;

revoke all on function private.revoke_integration_row(uuid, uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.revoke_integration_row(uuid, uuid, text) is
  'Phase 9 Task 3 (20261030003000). THE ONE REVOKE PRIMITIVE, shared by public.revoke_integration(), the membership trigger and private.erase_account(). Locks the row; returns false (and audits nothing) if it is missing or already revoked. Deletes the Vault secret by id AND by the connection''s name, sets status revoked, token_secret_id null, revoked_at now(), revoked_by p_actor, and audits integration.revoked {provider, owner_scoped[, reason]} -- via log_audit_event() when p_actor is the session''s person, otherwise directly with p_actor or the tombstone. No client role executes it.';

-- (3) revoke_integration(), REBUILT ON THE PRIMITIVE -------------------------
CREATE OR REPLACE FUNCTION public.revoke_integration(p_org uuid, p_connection_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- 20261030003000: THE BODY IS private.revoke_integration_row(), the one
  -- primitive the membership trigger and the account erasure share. It owns
  -- the idempotence (a second revoke changes nothing and audits nothing), the
  -- Vault delete, the revoked_by stamp and the audit row -- written through
  -- log_audit_event() with the caller as actor, because the caller is the
  -- session's person.
  perform private.revoke_integration_row(v_c.id, v_uid, null);
end;
$function$;

comment on function public.revoke_integration(uuid, uuid) is
  'Phase 9 Task 2; since 20261030003000 its body is private.revoke_integration_row(). Revokes a connection: allowed for a manage_integrations holder in p_org (by role, so it works on a suspended or closed workspace) or for the connection''s own owner_user_id. Locks the row; idempotent on an already-revoked row (no second audit). Deletes the Vault secret, then sets status revoked, token_secret_id null, revoked_at now(), revoked_by the session. Audited as integration.revoked {provider, owner_scoped}. A caller who is neither gets 42501 forbidden whether or not the id exists.';

-- (4) A PERSON WHO LEAVES A WORKSPACE TAKES THEIR CONNECTIONS WITH THEM -------
-- A person-scoped connection is the PERSON'S own mailbox or calendar, made
-- inside one workspace. When their membership there ends -- the row is
-- deleted (removed, or left), or its status moves to `revoked` -- every live
-- person-scoped connection they own IN THAT WORKSPACE is revoked through the
-- primitive: the Vault secret is deleted, the row is marked revoked and
-- audited with reason `membership_ended`. The person-scoped read policy
-- already hid the row from them (Task 1 fix round, IR8/IR9); this is what
-- stops the server holding a live token for somebody who has gone.
--
-- Workspace-scoped connections they CREATED are not touched: they belong to
-- the workspace (created_by is attribution, not ownership).
--
-- When the WORKSPACE itself is deleted, the cascade has already removed its
-- connections by the time this fires for the cascaded memberships (measured:
-- rls_phase9_integrations.sql IP4), so it finds nothing to revoke and writes
-- no audit row naming a workspace that is gone.
create or replace function private.integration_connections_follow_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_id    uuid;
begin
  if tg_op = 'UPDATE' then
    if new.user_id = old.user_id
       and new.organisation_id = old.organisation_id
       and not (new.status = 'revoked' and old.status is distinct from 'revoked') then
      return null;
    end if;
  end if;

  -- Who removed them, if that is a real account; otherwise nobody (the
  -- primitive then audits with the tombstone as actor).
  select u.id into v_actor from auth.users u where u.id = (select auth.uid());

  for v_id in
    select c.id from public.integration_connections c
     where c.organisation_id = old.organisation_id
       and c.owner_user_id = old.user_id
       and c.status <> 'revoked'
     order by c.id
  loop
    perform private.revoke_integration_row(v_id, v_actor, 'membership_ended');
  end loop;

  return null;
end;
$function$;

revoke all on function private.integration_connections_follow_membership()
  from public, anon, authenticated, service_role;

drop trigger if exists integration_connections_follow_membership on public.organisation_memberships;
create trigger integration_connections_follow_membership
  after delete or update of status, user_id, organisation_id on public.organisation_memberships
  for each row execute function private.integration_connections_follow_membership();

comment on function private.integration_connections_follow_membership() is
  'Phase 9 Task 3 (20261030003000). AFTER DELETE/UPDATE on organisation_memberships: when a membership ends (deleted, or status moved to revoked, or the row moved to another person/workspace), every live PERSON-scoped integration connection that person owns in that workspace is revoked through private.revoke_integration_row() (reason membership_ended). Workspace-scoped connections they created stay. On a workspace delete the cascade has already removed the connections, so it finds nothing.';

-- (5) erase_account(): STEP 5c ---------------------------------------------
CREATE OR REPLACE FUNCTION private.erase_account(p_user_id uuid, p_job_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tomb    uuid := private.erased_user_id();
  v_counts  jsonb := '{}'::jsonb;
  v_n       bigint;
  v_total   bigint := 0;
  v_rec     record;
  v_org     record;
  v_multi   text;
  v_orgs    uuid[];
  v_left    text;
begin
  -- (0) ---------------------------------------------------------------------
  if p_user_id is null then
    raise exception 'erase_account: a subject is required' using errcode = '22023';
  end if;
  if p_user_id = v_tomb then
    raise exception 'erase_account: the tombstone is not a person and cannot be erased'
      using errcode = '42501', hint = 'tombstone_is_nobody';
  end if;
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'erase_account: refuses to run with session_replication_role = %, because the cascades and the ON DELETE SET NULLs it depends on would not fire',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;
  -- (0b) THE ROLL AND THE CATALOGUE MUST AGREE (fix round 1, C1). A uuid
  -- column no foreign key protects is invisible to steps 7, 8 and 10, so an
  -- unclassified one is a promise this function cannot keep. It refuses here,
  -- before a single row moves, rather than reporting a success that left a
  -- stable identifier behind.
  perform private.assert_fkless_identifier_roll();

  -- (1) IDEMPOTENCE ---------------------------------------------------------
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) Q131, UNDER A LOCK (C2) ---------------------------------------------
  -- The lock comes FIRST and covers every live workspace this person is an
  -- active member of. Without it two erasures of two co-Owners both read a
  -- workspace that still had an Owner in it and both deleted one.
  perform private.account_lock_workspaces(p_user_id);
  perform private.assert_account_is_erasable(p_user_id);

  -- The workspaces to re-assert at 9b, captured while the guard's answer is
  -- still true and before any of them can be purged by 8b.
  select pg_catalog.array_agg(distinct m.organisation_id)
    into v_orgs
    from public.organisation_memberships m
    join public.organisations o on o.id = m.organisation_id
   where m.user_id = p_user_id and m.status = 'active' and o.deleted_at is null;

  -- (2b) 20261025000000 (Task 9c fix round 1, I2): A CLOSURE BACKUP IS BUILT
  -- AS ITS CLOSING OWNER, SO THE OWNER WAITS FOR IT. The export runner reads a
  -- closure backup under the requester's own rights; erased first, step 5b
  -- re-points it at the tombstone, which is a member of nothing, and the
  -- backup was measured built with all 35 of its files empty. Refused, not
  -- deferred: the whole erasure rolls back and the person asks again.
  if exists (select 1 from public.export_jobs j
              where j.requested_by = p_user_id and j.closure_backup
                and j.status in ('queued', 'running')) then
    raise exception 'erase_account: the backup of a workspace this account closed has not been built yet'
      using errcode = '55000', hint = 'closure_backup_not_built';
  end if;

  -- (3) THE BYTES -----------------------------------------------------------
  select count(*) into v_n
    from storage.objects o
   where (o.bucket_id = 'feedback-screenshots'
          and o.name in (select 'feedback/' || f.id::text
                           from public.feedback f where f.user_id = p_user_id))
      or (o.bucket_id = 'exports'
          and o.name in (select j.storage_key from public.export_jobs j
                          where j.requested_by = p_user_id and j.storage_key is not null
                            and not j.closure_backup));
  if v_n > 0 then
    raise exception 'erase_account: % stored object(s) belonging to this account are still in their buckets', v_n
      using errcode = '55000', hint = 'bytes_not_purged';
  end if;
  v_counts := v_counts || pg_catalog.jsonb_build_object('bytes_purged', true);

  -- (4) PRIVATE NOTES ARE HARD-DELETED --------------------------------------
  delete from public.notes n
   where n.owner_user_id = p_user_id and n.visibility = 'private';
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('notes.private_deleted', v_n);

  select count(*) into v_n from public.notes n
   where n.owner_user_id = p_user_id and n.visibility = 'company';
  v_counts := v_counts || pg_catalog.jsonb_build_object('notes.company_kept', v_n);

  -- (5) THE REGISTER AND ITS NOTES (Q158) -----------------------------------
  update public.data_subject_requests d
     set user_id          = v_tomb,
         user_email       = '[erased]',
         detail           = '[erased]',
         rejection_reason = case when d.rejection_reason is not null then '[erased]' end
   where d.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('data_subject_requests', v_n);

  -- (5b) Q206: A CLOSURE BACKUP SURVIVES ITS REQUESTER. The backup
  -- the Owner's closure RPC queued belongs to the closed WORKSPACE (the
  -- superuser's decision item reads it); its requested_by is re-pointed at
  -- the tombstone rather than cascaded away with auth.users. The marker is
  -- what private.export_jobs_before_update() admits this one rewrite on.
  perform pg_catalog.set_config('app.erasing_account', p_user_id::text, true);
  update public.export_jobs j
     set requested_by = v_tomb
   where j.requested_by = p_user_id and j.closure_backup;
  get diagnostics v_n = row_count;
  perform pg_catalog.set_config('app.erasing_account', '', true);
  v_counts := v_counts || pg_catalog.jsonb_build_object('export_jobs.closure_backups_kept', v_n);

  update public.data_subject_request_notes t
     set author_user_id = v_tomb
   where t.author_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('data_subject_request_notes', v_n);

  -- (5c) THE PERSON'S OWN INTEGRATIONS, BEFORE THE DELETE (Phase 9 Task 3,
  -- 20261030003000; Task 1 review finding). owner_user_id is ON DELETE SET
  -- NULL, so leaving a person-scoped connection to step 9 turned it into a
  -- WORKSPACE-scoped one an Owner or Admin can read, orphaned its Vault
  -- secret, and -- when the workspace already held a live connection to the
  -- same provider -- FAILED the whole erasure on the one-live unique index.
  -- So each is revoked through the one primitive (the Vault secret first;
  -- audited with the tombstone as actor), then its sync runs and the row go.
  -- Every workspace, closed ones included: it is the person's own.
  for v_rec in
    select c.id from public.integration_connections c
     where c.owner_user_id = p_user_id
     order by c.id
  loop
    perform private.revoke_integration_row(v_rec.id, v_tomb, 'account_erased');
  end loop;
  delete from public.integration_sync_runs r
   using public.integration_connections c
   where r.organisation_id = c.organisation_id and r.connection_id = c.id
     and c.owner_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_sync_runs.deleted', v_n);
  delete from public.integration_connections c where c.owner_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_connections.deleted', v_n);

  -- What they created or revoked FOR A WORKSPACE stays the workspace's, and is
  -- attributed to the tombstone. Both keys are ON DELETE SET NULL, which step
  -- 7's walk (NO ACTION keys only) does not reach, and NULL would read as
  -- "nobody did this"; the guard admits this one move on a revoked row.
  update public.integration_connections c set created_by = v_tomb where c.created_by = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_connections.created_by', v_n);
  update public.integration_connections c set revoked_by = v_tomb where c.revoked_by = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_connections.revoked_by', v_n);

  -- (6) THE IDENTIFIERS NO FOREIGN KEY PROTECTS -----------------------------
  -- 6a. THE OWNER-ID SNAPSHOTS, RUN FROM THE ROLL RATHER THAN LISTED. Plain
  --     uuid columns with no foreign key, so step 9's delete would leave them
  --     naming a person who no longer exists -- a stable identifier surviving
  --     erasure, which is the one thing pseudonymisation must not produce.
  --     This loop is the C1 fix: the version that listed them named
  --     public.merges and NOT public.merge_candidates, whose two columns
  --     public.screen_for_duplicates() writes on every flagged duplicate, and
  --     no derived assertion in this function could see the omission.
  for v_rec in
    select r.table_name as tbl, r.column_name as col
      from private.fkless_identifier_columns() r
     where r.identifies = 'user' and r.treatment = 'null_on_match'
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = null where %I = $1',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using p_user_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
  end loop;

  -- 6b. THE AUDIT LOG AS A TARGET. `actor_user_id` is handled by the derived
  --     re-point below (it is a foreign key). `target_id` is not a foreign
  --     key at all -- it is polymorphic -- so a row whose TARGET was this
  --     person keeps their id unless it is moved here, and its before/after
  --     payload describes them and is dropped. What happened stays; who it
  --     happened to stops being nameable.
  update public.audit_events a
     set target_id = v_tomb,
         before    = null,
         after     = null
   where a.target_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.targeted', v_n);

  -- 6e. AND THE PAYLOADS OF THE ROWS THIS PERSON WAS THE ACTOR ON (M1).
  --     actor_user_id itself is a foreign key and the derived walk at step 7
  --     re-points it; the payload beside it is not a foreign key, is not a
  --     uuid column, and was left untouched. The page promises that "any
  --     description of the change is dropped" for every entry of theirs, so
  --     it is dropped here -- what happened, when, to what and on which
  --     correlation thread all stay.
  update public.audit_events a
     set before = null,
         after  = null
   where a.actor_user_id = p_user_id
     and (a.before is not null or a.after is not null);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.acted_payloads', v_n);

  -- 6c. INCIDENT ALERT DETAILS. A jsonb blob with no foreign key that carries
  --     subject ids (a rate-limit crossing names the subject it metered). The
  --     whole document is rewritten with the id replaced, which is complete
  --     regardless of where in the shape it sits -- a key-by-key walk would
  --     miss a nested one.
  update public.incident_alerts i
     set details = pg_catalog.replace(i.details::text, p_user_id::text, v_tomb::text)::jsonb
   where i.details::text like '%' || p_user_id::text || '%';
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('incident_alerts.details', v_n);

  -- 6f. THE PAYLOAD VALUES THAT NAME THIS PERSON ON SOMEBODY ELSE'S ROW
  --     (Phase 8 Task 7 fix round 1, C1). 6b clears the rows that TARGET the
  --     person and 6e the rows they ACTED on. Since 20261006000000 a third
  --     shape exists on every workspace: an Admin's `membership.created`
  --     carries the invitee's user_id, a Manager's `task.updated` carries the
  --     colleague the task was reassigned to, a screen's `merge_candidate.*`
  --     carries two owners -- rows whose actor and target are both somebody
  --     or something else. Neither 6b nor 6e can see them.
  --     THE VALUE IS REPLACED, NOT THE PAYLOAD DROPPED: the row is the
  --     workspace's record of what its Admin did, and "an Admin invited the
  --     erased user" is still true and still worth keeping; who the invitee
  --     was is what stops being nameable -- the same tombstone step 7 points
  --     every foreign key at. Whole-document text replace, the 6c shape,
  --     because it is complete regardless of which key, which depth or which
  --     writer put the id there, including writers that do not exist yet.
  --     Case-insensitive, because a payload built by application code is not
  --     guaranteed to have gone through the uuid type's lower-case output.
  update public.audit_events a
     set before = case when a.before is null then null else
                    pg_catalog.regexp_replace(a.before::text, p_user_id::text, v_tomb::text, 'gi')::jsonb end,
         after  = case when a.after is null then null else
                    pg_catalog.regexp_replace(a.after::text, p_user_id::text, v_tomb::text, 'gi')::jsonb end
   where pg_catalog.strpos(pg_catalog.lower(coalesce(a.before::text, '')), p_user_id::text) > 0
      or pg_catalog.strpos(pg_catalog.lower(coalesce(a.after::text, '')), p_user_id::text) > 0;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('audit_events.payload_values', v_n);

  -- 6d. RATE LIMIT COUNTERS. Enforcement state about a person who will not be
  --     making any more requests. Deleted rather than re-pointed: rolling an
  --     erased account's spent budget onto the tombstone would throttle the
  --     next one (Q110 leaves the general sweep to Task 6; this is the
  --     subject-scoped part of it).
  --     Run from the roll too, with the roll carrying the scope predicate --
  --     `subject_id` is polymorphic and a workspace's counters are not this
  --     person's to delete.
  for v_rec in
    select r.table_name as tbl, r.column_name as col, r.predicate as pred
      from private.fkless_identifier_columns() r
     where r.identifies = 'user' and r.treatment = 'delete_row'
     order by 1, 2
  loop
    execute pg_catalog.format('delete from %s where %I = $1 and (%s)',
                              v_rec.tbl, v_rec.col,
                              coalesce(v_rec.pred, 'true'))
      using p_user_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', ''), v_n);
  end loop;

  -- (7) THE RE-POINT, DERIVED ------------------------------------------------
  -- ASSERT WHAT THE DERIVATION WOULD DROP, first: a COMPOSITE foreign key to
  -- auth.users cannot be re-pointed by the single-column walk below, and would
  -- be skipped silently. There is none today; there must not be one tomorrow
  -- without somebody noticing.
  select pg_catalog.string_agg(con.conname, ', ') into v_multi
    from pg_catalog.pg_constraint con
   where con.contype = 'f'
     and con.confrelid = 'auth.users'::pg_catalog.regclass
     and pg_catalog.array_length(con.conkey, 1) > 1;
  if v_multi is not null then
    raise exception 'erase_account: composite foreign key(s) to auth.users (%) are not handled by the re-point walk', v_multi
      using errcode = '55000', hint = 'composite_fk_to_auth_users';
  end if;

  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and con.confdeltype = 'a'          -- NO ACTION: the ones that BLOCK
       and c.relkind in ('r', 'p')
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = $1 where %I = $2',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using v_tomb, p_user_id;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    if v_n > 0 then
      v_counts := v_counts || pg_catalog.jsonb_build_object(
        pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
    end if;
  end loop;
  v_counts := v_counts || pg_catalog.jsonb_build_object('tombstoned_references', v_total);

  -- (8) ASSERT IT WORKED -----------------------------------------------------
  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and con.confdeltype = 'a'
       and c.relkind in ('r', 'p')
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1', v_rec.tbl, v_rec.col)
      into v_n using p_user_id;
    if v_n > 0 then
      raise exception 'erase_account: %.% still names the account after the re-point (% row(s)) -- a guard refused it',
        v_rec.tbl, v_rec.col, v_n
        using errcode = '55000', hint = 'reference_survived_the_repoint';
    end if;
  end loop;

  -- (8b) Q131'S NARROW CASE --------------------------------------------------
  for v_org in
    select w.organisation_id from private.account_last_owner_workspaces(p_user_id) w
     where w.other_members = 0 and w.is_empty
  loop
    perform private.erase_organisation(v_org.organisation_id, p_job_id, false);
    v_counts := v_counts || pg_catalog.jsonb_build_object('workspace_purged', true);
  end loop;

  -- (9) THE DELETE -----------------------------------------------------------
  delete from auth.users u where u.id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('auth_users', v_n);

  -- (9b) AND THE Q131 INVARIANT ITSELF, AFTER THE DELETE (C2) ----------------
  -- The lock at step 2 is what stops the race; this is what proves it held.
  -- Every live workspace this person was an active member of must still have
  -- an active Owner -- unless 8b took the whole workspace with them, in which
  -- case there is nothing left to strand.
  select pg_catalog.string_agg(o.name, ', ' order by o.name)
    into v_left
    from public.organisations o
   where o.id = any (coalesce(v_orgs, '{}'::uuid[]))
     and o.deleted_at is null
     and not exists (
       select 1 from public.organisation_memberships m
        where m.organisation_id = o.id
          and m.role = 'owner'
          and m.status = 'active');
  if v_left is not null then
    raise exception 'erase_account: % would be left with no owner -- another erasure of a co-owner committed while this one was running', v_left
      using errcode = '55000', hint = 'workspace_left_ownerless';
  end if;

  -- (10) ASSERT AGAIN, OVER EVERY FOREIGN KEY --------------------------------
  for v_rec in
    select con.conrelid::pg_catalog.regclass::text as tbl, a.attname::text as col
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::pg_catalog.regclass
       and c.relkind in ('r', 'p')
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1', v_rec.tbl, v_rec.col)
      into v_n using p_user_id;
    if v_n > 0 then
      raise exception 'erase_account: %.% still names the account after the delete (% row(s))',
        v_rec.tbl, v_rec.col, v_n
        using errcode = '55000', hint = 'reference_survived_the_delete';
    end if;
  end loop;

  -- (10b) AND OVER EVERY AUDIT PAYLOAD (C1) -------------------------------
  -- The foreign-key walks above cannot see inside jsonb. This can: after the
  -- delete, so that anything a cascade wrote is inside the measurement too,
  -- not one audit row's before/after may still contain the account's id.
  -- Refusing rolls the whole erasure back, which is the fail-closed direction
  -- -- a success that left the id in a payload is the thing C1 was.
  select count(*) into v_n
    from public.audit_events a
   where pg_catalog.strpos(pg_catalog.lower(coalesce(a.before::text, '')), p_user_id::text) > 0
      or pg_catalog.strpos(pg_catalog.lower(coalesce(a.after::text, '')), p_user_id::text) > 0;
  if v_n > 0 then
    raise exception 'erase_account: % audit payload(s) still contain the account''s id after the scrub', v_n
      using errcode = '55000', hint = 'identifier_survived_in_audit_payload';
  end if;

  -- (11) ONE SUMMARY ROW -----------------------------------------------------
  -- Counts, never content, and the ACTOR IS THE TOMBSTONE because the person
  -- who asked no longer exists. It is written last so that its own
  -- actor_user_id is already a pseudonym rather than something step 7 would
  -- have had to rewrite.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    null, v_tomb, 'account.erased', 'erasure_job',
    p_job_id,
    coalesce(p_job_id, pg_catalog.gen_random_uuid()),
    v_counts);

  return v_counts;
end;
$function$;

-- (6) erase_organisation(): STEP 5c ----------------------------------------
CREATE OR REPLACE FUNCTION private.erase_organisation(p_organisation_id uuid, p_job_id uuid DEFAULT NULL::uuid, p_require_closed boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_counts   jsonb := '{}'::jsonb;
  v_org      public.organisations%rowtype;
  v_type     text;
  v_n        bigint;
  v_total    bigint := 0;
  v_left     text;
  v_orphans  bigint;
  v_rec      record;
begin
  if p_organisation_id is null then
    raise exception 'erase_organisation: a workspace is required' using errcode = '22023';
  end if;

  -- (0) NEVER UNDER `replica`. See the header. This is the control; the
  -- sentence in the brief is not.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'erase_organisation: refuses to run with session_replication_role = %, because the ON DELETE SET NULL that keeps a routed data subject request readable would not fire',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- (0b) THE ROLL AND THE CATALOGUE MUST AGREE (fix round 1, C1). The same
  -- assertion the account erasure makes, for the same reason: a uuid column
  -- no foreign key protects is invisible to step 7's walk.
  perform private.assert_fkless_identifier_roll();

  -- (1) IDEMPOTENCE. Running it twice is not an error.
  select * into v_org from public.organisations o where o.id = p_organisation_id;
  if not found then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) A LIVE WORKSPACE IS NOT PURGED. Task 6's 60-day clock decides WHEN a
  -- closed workspace goes; this decides that an OPEN one never does. The one
  -- caller that passes false is Q131's empty-and-ownerless case, which checks
  -- emptiness itself.
  if p_require_closed and v_org.deleted_at is null then
    raise exception 'erase_organisation: a live workspace is not purged -- close it first'
      using errcode = '22023', hint = 'workspace_is_live';
  end if;

  -- (3) THE BYTES FIRST, ALWAYS. Q52: soft-deleting a document keeps its
  -- bytes, so the rows are NOT what makes a file unreachable. If the runner's
  -- storage sweep has not finished, this refuses -- deleting the rows now
  -- would leave objects in the bucket that nothing in the database names.
  select count(*) into v_n
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name like p_organisation_id::text || '/%';
  if v_n > 0 then
    raise exception 'erase_organisation: % document object(s) are still in the bucket', v_n
      using errcode = '55000', hint = 'bytes_not_purged';
  end if;

  -- (4) TRAP: THE POLYMORPHIC TABLE, SWEPT BEFORE ITS ENTITIES, FOR EVERY
  -- TYPE THE LIVE CHECK ALLOWS (seven, not the brief's six).
  for v_type in select t from private.custom_field_entity_types() t loop
    v_n := private.sweep_custom_field_values(p_organisation_id, v_type, null);
    v_total := v_total + v_n;
    v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values.' || v_type, v_n);
  end loop;
  v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values', v_total);

  -- (5) TRAP: THE DISCARDED RECORD'S VALUES, VERBATIM. merges.field_resolution
  -- holds what the losing contact/company/artist actually said -- email,
  -- phone, address. Scrubbed before the delete rather than left to the
  -- cascade, so a backup taken in between already has nothing in it. The
  -- owner-id snapshots beside it have no foreign key and go with it.
  update public.merges m
     set field_resolution = '{}'::jsonb,
         winner_owner_user_id = null,
         loser_owner_user_id  = null
   where m.organisation_id = p_organisation_id
     and (m.field_resolution <> '{}'::jsonb
          or m.winner_owner_user_id is not null
          or m.loser_owner_user_id is not null);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('merges.field_resolution', v_n);

  -- (5b) THE WORKSPACE-BEARING COLUMNS NO FOREIGN KEY PROTECTS, RUN FROM THE
  -- ROLL (fix round 1). public.feedback.support_access_organisation_id names
  -- the workspace a superuser was inside; the counters name a workspace that
  -- will not be asking for anything else. Neither is reachable by step 7's
  -- pg_constraint walk, so neither was touched before.
  for v_rec in
    select r.table_name as tbl, r.column_name as col
      from private.fkless_identifier_columns() r
     where r.identifies = 'organisation' and r.treatment = 'null_on_match'
     order by 1, 2
  loop
    execute pg_catalog.format('update %s set %I = null where %I = $1',
                              v_rec.tbl, v_rec.col, v_rec.col)
      using p_organisation_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.' || v_rec.col, v_n);
  end loop;
  for v_rec in
    select r.table_name as tbl, r.column_name as col, r.predicate as pred
      from private.fkless_identifier_columns() r
     where r.identifies = 'organisation' and r.treatment = 'delete_row'
     order by 1, 2
  loop
    execute pg_catalog.format('delete from %s where %I = $1 and (%s)',
                              v_rec.tbl, v_rec.col, coalesce(v_rec.pred, 'true'))
      using p_organisation_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(
      pg_catalog.replace(v_rec.tbl, 'public.', '') || '.purged', v_n);
  end loop;

  -- (5c) THE VAULT SECRETS BEFORE THE CASCADE (Phase 9 Task 3,
  -- 20261030003000). vault.secrets has no foreign key to anything of ours, so
  -- the cascade below deleted each integration connection and left its token
  -- behind in the Vault, named for a connection that no longer exists. They
  -- go first, by id and by the connection's own name; then the connections
  -- (their sync runs cascade), explicitly, so the count is on the summary.
  delete from vault.secrets s
   where s.id in (select c.token_secret_id from public.integration_connections c
                   where c.organisation_id = p_organisation_id
                     and c.token_secret_id is not null)
      or s.name in (select 'integration:' || c.id::text from public.integration_connections c
                     where c.organisation_id = p_organisation_id);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_secrets', v_n);
  delete from public.integration_connections c where c.organisation_id = p_organisation_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('integration_connections', v_n);

  -- (6) THE DELETE. Every cascade runs, at `origin`, paying for the
  -- referential integrity that keeps a routed request readable.
  delete from public.organisations o where o.id = p_organisation_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('organisations', v_n);

  -- (7) ASSERT WHAT IS LEFT, DERIVED. Every foreign key in the database that
  -- points at public.organisations is asked directly whether it still names
  -- this workspace. A cascade that did not run -- because a later migration
  -- shipped a NO ACTION reference, or because somebody reached for `replica`
  -- despite (0) -- is a hard failure and the whole transaction rolls back.
  for v_type in
    select con.conrelid::pg_catalog.regclass::text || '|' || a.attname
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'public.organisations'::pg_catalog.regclass
       and c.relkind in ('r', 'p')
       and pg_catalog.array_length(con.conkey, 1) = 1
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1',
                              pg_catalog.split_part(v_type, '|', 1),
                              pg_catalog.split_part(v_type, '|', 2))
      into v_n using p_organisation_id;
    if v_n > 0 then
      raise exception 'erase_organisation: % still names the workspace after the delete (% row(s))',
        pg_catalog.replace(v_type, '|', '.'), v_n
        using errcode = '55000', hint = 'reference_survived_the_purge';
    end if;
  end loop;

  -- (8) AND THE ORPHAN CENSUS FOR THE ONE TABLE NO FOREIGN KEY PROTECTS.
  select count(*) into v_orphans
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id;
  if v_orphans > 0 then
    raise exception 'erase_organisation: % custom field value(s) survived', v_orphans
      using errcode = '55000', hint = 'custom_field_values_orphaned';
  end if;

  if p_job_id is not null then
    v_counts := v_counts || pg_catalog.jsonb_build_object('workspace_purged', true);
  end if;

  -- (9) ONE SUMMARY ROW (M2). Counts, never content, and the ACTOR IS THE
  -- TOMBSTONE -- the platform purges a workspace and the workspace's own
  -- people are not the actor of it; by the time Task 6's clock runs there
  -- may be none of them left. organisation_id is NULL because the workspace
  -- it would name has just been deleted (the column is a foreign key), which
  -- is why the id travels in the payload instead.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    null, private.erased_user_id(), 'organisation.erased', 'organisation',
    p_organisation_id,
    coalesce(p_job_id, pg_catalog.gen_random_uuid()),
    v_counts || pg_catalog.jsonb_build_object('organisation_id', p_organisation_id));

  return v_counts;
end;
$function$;

-- (7) THE EXPORT CATALOGUE --------------------------------------------------
CREATE OR REPLACE FUNCTION private.export_catalogue()
 RETURNS TABLE(export_kind text, table_name text, disposition text, reason text, authorisation text, scope_columns text[], key_column text, projection text[])
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
values
  -- =====================================================================
  -- WORKSPACE EXPORT. The customer is the controller; we are the
  -- processor. Every read is `requester_rls`, without exception -- which
  -- is what makes "an Owner's export contains no other member's private
  -- note" true by construction rather than by a rule this file would
  -- otherwise have had to restate and get wrong.
  -- =====================================================================
  ('workspace', 'organisations',                  'exported', null::text, 'requester_rls', array['id'],                    'id', null::text[]),
  ('workspace', 'organisation_memberships',       'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_subscriptions',     'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_billing_overrides', 'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'organisation_feature_overrides', 'exported', null,       'requester_rls', array['organisation_id'],       'id', null),
  ('workspace', 'impersonation_sessions',         'exported', null,       'requester_rls', array['target_organisation_id'],'id', null),

  ('workspace', 'companies',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'contacts',                 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'contact_companies',        'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'agencies',                 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artists',                  'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artist_representations',   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'artist_fee_history',       'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'venues',                   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'venue_rooms',              'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'custom_field_definitions', 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'custom_field_values',      'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'merges',                   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'merge_candidates',         'exported', null, 'requester_rls', array['organisation_id'], 'id', null),

  ('workspace', 'events',               'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'event_lineup',         'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'event_status_changes', 'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'tasks',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'meetings',             'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'notes',                'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'documents',            'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'document_versions',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'task_links',           'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'meeting_links',        'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'note_links',           'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'document_links',       'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'financial_entries',    'exported', null, 'requester_rls', array['organisation_id'], 'id', null),

  -- network_connection_requests SPANS TWO TENANTS. Both ends are named as
  -- scope columns, and the RLS policy behind the read is the same one the
  -- browser gets -- so "this side's view only" is not a filter this file
  -- invented and could get wrong.
  ('workspace', 'network_profiles',            'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'network_links',               'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  ('workspace', 'network_connection_requests', 'exported', null, 'requester_rls', array['from_organisation_id','to_organisation_id'], 'id', null),

  -- ---- EXCUSED, four of them, each for a stated reason -----------------
  ('workspace', 'audit_events', 'excused',
   'The platform security record, not the workspace''s own data: superuser-readable by policy (SECURITY.md section 7), with its own retention (30 days hot, 1 year archived), and handing an Owner a cross-member log of everything their colleagues did would create a surveillance surface the product deliberately does not have. A member''s OWN audit rows are in the ACCOUNT export, which is where they are that person''s data.',
   null, null, null, null),
  ('workspace', 'incident_alerts', 'excused',
   'Platform operations. An alert is GetSetPaid''s own signal that something crossed a threshold -- a rate limit, a quarantined upload, a missed statutory deadline -- addressed to the operator, and its details payload carries subject ids from outside this tenant. No member holds a read of it today.',
   null, null, null, null),
  ('workspace', 'feedback', 'excused',
   'Platform-scoped by design (CLAUDE.md, In-app feedback): no submitter can read any row, their own included (Q103), because RLS filters rows and not columns and status / notified_at / organisation_role are GetSetPaid''s rather than theirs. A person''s own submissions are in the ACCOUNT export.',
   null, null, null, null),
  ('workspace', 'export_jobs', 'excused',
   'The register of exports themselves. It is metadata about this feature rather than a record of the business, there is no cross-member read of it (an export of it would hold only the reader''s own jobs), and it necessarily contains the job building the archive -- a record of itself. The reader sees every one of their own on the export page, live.',
   null, null, null, null),
  ('workspace', 'erasure_jobs', 'excused',
   'The register of erasures. A workspace appears on it in exactly one way -- as the subject of its own 60-day purge (Q88/Q92) -- and a record that this workspace is scheduled to be destroyed is the platform''s operational state rather than one of the business''s records. The row holds no content of any kind: `summary` is CHECK-constrained to counts. Phase 8 Task 5 added it, and it is excused for the same reasons export_jobs is.',
   null, null, null, null),
  ('workspace', 'data_subject_requests', 'excused',
   'Another person''s statutory request. The workspace appears on it only as the organisation an operator ROUTED it to (Q160), and the row holds the requester''s identity, their own words and our handling of them -- none of which is the workspace''s data. The requester gets it in their own account export.',
   null, null, null, null),

  -- =====================================================================
  -- ACCOUNT EXPORT. GetSetPaid is the controller.
  -- =====================================================================
  -- PHASE 8 TASK 6. public.retention_settings carries `updated_by`, a uuid
  -- reference to auth.users, which is a row -> user path and therefore in
  -- scope for this census by construction -- it went red the moment the table
  -- existed (XC3), which is what the census is for. It is EXCUSED, and the
  -- reason is as plain as it gets: the row is the retention job's two kill
  -- switches, one per deployment, and "the platform superuser turned the
  -- audit purge off at 3am and said why" is the PLATFORM's operational state.
  -- It is not a record about the person whose id is in that column, and it is
  -- not a record about anybody else either.
  ('account', 'retention_settings', 'excused',
   'The retention job''s kill switches -- one row for the whole deployment, carrying which switches are on, when they were last changed, the operator''s reason and their user id. It is in this census only because that id is a reference to auth.users. It is the platform''s own operational state, not a record about the person who flipped the switch; the audit row for the change (retention_settings.changed) is where that act is recorded, and a superuser''s own audit rows are already in their account export.',
   null, null, null, null),

  ('account', 'profiles',                 'exported', null, 'requester_rls', array['id'],      'id', null),
  ('account', 'organisation_memberships', 'exported', null, 'requester_rls', array['user_id'], 'id', null),
  ('account', 'consents',                 'exported', null, 'requester_rls', array['user_id'], 'id', null),
  ('account', 'data_subject_requests',    'exported', null, 'requester_rls', array['user_id'], 'id', null),

  -- ---- ELEVATED, four of them. Each has NO client read this person could
  -- ---- use, so a requester_rls read would have returned ZERO ROWS and
  -- ---- every assertion about it would still have passed.
  ('account', 'audit_events', 'exported',
   'ELEVATED: public.audit_events is superuser-only by policy, so there is no session that could read these rows under RLS. Read as the definer, filtered to actor_user_id = the requester, and PROJECTED to identifiers, action and timestamps. before and after are withheld -- they carry the changed COLUMN NAMES and structural values of other people''s tenant records, which are not this person''s data and which no client role may read. The manifest records the withholding.',
   'elevated', array['actor_user_id'], 'id',
   array['id','organisation_id','actor_user_id','action','target_type','target_id','correlation_id','created_at']),
  ('account', 'feedback', 'exported',
   'ELEVATED: no submitter can read any feedback row, their own included (Q103), so there is no session that could read these under RLS. Read as the definer, filtered to user_id = the requester, and PROJECTED to what the person wrote and what we did with it. screenshot_key is withheld -- an opaque storage path is not portable data, and the bytes travel as a file in the archive instead -- as are the support-access attribution columns, which are the operator''s record of their own session.',
   'elevated', array['user_id'], 'id',
   array['id','organisation_id','category','message','route','user_agent','status','screenshot_scan_status','during_support_access','created_at']),
  ('account', 'platform_admins', 'exported',
   'ELEVATED: public.platform_admins has NO select policy for any client role, so nothing could read it under RLS. Two columns, both about the requester: that this account is the platform operator, and since when. Filtered to user_id = the requester. The projection names both columns rather than being null -- the whole row IS theirs, so it withholds nothing, and it is written out so that "every elevated row carries a projection" can be a machine-checked rule (private.export_catalogue_is_sound(), 20260928001000) instead of prose. A third column added to this table by a later phase therefore has to be looked at before it is exported.',
   'elevated', array['user_id'], 'user_id', array['user_id','created_at']),
  ('account', 'impersonation_sessions', 'exported',
   'ELEVATED: the workspace-admin read this rests on is a permission IN a workspace, so a person who has left that workspace would silently export nothing -- while the record of support access THEY consented to or refused stays their own act. Filtered to the two columns that name them as the decider; a session they neither accepted nor declined is not theirs and is not returned, and neither is a session in another workspace or one somebody else decided. PROJECTED to the columns describing that decision AND, since 20261009000000 (founder 2026-09-30, Q167 CHANGED), to the operator''s break-glass `reason` and `superuser_user_id`: a person who let GetSetPaid into their workspace, or refused to, is entitled to know why it was asked for and who asked. The operator''s identity is the account id recorded on the session -- the narrowest identifier the row holds; the manifest says what it denotes. No other column was added, and no other operator data (no profile, no email, no other session) is joined in. A CURRENT workspace admin can still read the whole row through impersonation_sessions_select_target_admin; the export is for the person who has LEFT, which is the case this row is elevated for in the first place.',
   'elevated', array['admin_accepted_by','declined_by'], 'id',
   array['id','target_organisation_id','superuser_user_id','reason','status','requested_at','admin_accepted_by','accepted_at','declined_by','declined_at','started_at','expires_at','ended_at']),

  -- ---- EXCUSED ---------------------------------------------------------
  ('account', 'erasure_jobs', 'excused',
   'The register of erasures -- metadata about the process rather than data about the person, and in practice unreachable: a SUCCEEDED account erasure has already deleted the account, so no export of that account can ever contain it. What it could hold is a QUEUED or FAILED job, and the person reads both of those on /account/erase, live, with the reason. It also names the OPERATOR as requested_by when an erasure was started on a statutory request (20260930005000), and a GetSetPaid staff identity on a job register is not this person''s data -- the argument the feedback row makes for its support-access attribution columns. (Q167 as CHANGED by the founder on 2026-09-30 puts the operator into the account export for BREAK-GLASS SESSIONS only, in the impersonation_sessions row; it is not a general rule that staff identities are exported.) Excused rather than projected, because everything left after that projection is already on their own page.',
   null, null, null, null),
  ('account', 'export_jobs', 'excused',
   'The register of exports themselves -- metadata about this feature rather than data about the person, and a record of itself: the job building the archive would be in it. Every one of their own jobs is on /account/exports, live, with its status, its counts and what it withheld.',
   null, null, null, null),
  ('account', 'data_subject_request_notes', 'excused',
   'The operator''s working notes on statutory requests (Q103). The requester has no read of them anywhere in the product -- they are a separate table with no own-rows policy precisely so that there is nothing for a page to decline to render -- and an export that included them would hand back exactly what that split exists to withhold. The only author is the operator.',
   null, null, null, null),
  ('account', 'legal_documents', 'excused',
   'The public legal pages. Every published version is world-readable at /legal/<slug> signed out; the only users it references are the operator who drafted, published or recorded counsel''s review of a version, and that authorship is already in this person''s exported audit rows.',
   null, null, null, null),

  -- ---- EXCUSED: twenty tables whose only reference to a person is an
  -- ---- ownership or attribution column on a WORKSPACE record. This is the
  -- ---- Q132 line and the whole reason there are two exports: the row is
  -- ---- the customer''s data, not the member''s. Each is in the WORKSPACE
  -- ---- export, where its controller can ask for it.
  ('account', 'agencies',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'artists',                        'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'companies',                      'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'contacts',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'documents',                      'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'events',                         'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'event_status_changes',           'excused', 'Workspace record; the account appears only as changed_by. In the workspace export.', null, null, null, null),
  ('account', 'financial_entries',              'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'meetings',                       'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'merges',                         'excused', 'Workspace record; the account appears only as merged_by. In the workspace export.', null, null, null, null),
  ('account', 'merge_candidates',               'excused', 'Workspace record; the account appears only as resolved_by. In the workspace export.', null, null, null, null),
  ('account', 'network_connection_requests',    'excused', 'Workspace record; the account appears only as requested_by / responded_by, and the row spans two tenants. In the workspace export.', null, null, null, null),
  ('account', 'network_links',                  'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'network_profiles',               'excused', 'Workspace record; the account appears only as created_by. In the workspace export.', null, null, null, null),
  ('account', 'notes',                          'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export -- where a PRIVATE note is still readable by its author alone, because that export runs under the requester''s own RLS.', null, null, null, null),
  ('account', 'organisation_billing_overrides', 'excused', 'Platform record about a WORKSPACE''s billing; the account appears only as granted_by / revoked_by, which is the operator. In the workspace export.', null, null, null, null),
  ('account', 'organisation_feature_overrides', 'excused', 'Platform record about a WORKSPACE''s feature flags; the account appears only as granted_by / revoked_by, which is the operator. In the workspace export.', null, null, null, null),
  ('account', 'tasks',                          'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'venues',                         'excused', 'Workspace record; the account appears only as owner_user_id. In the workspace export.', null, null, null, null),
  ('account', 'incident_alerts',                'excused', 'Platform operations; the account appears only as resolved_by, which is the operator acting on GetSetPaid''s own signal. Excused from both exports.', null, null, null, null),
  -- =====================================================================
  -- PHASE 9 (tables 20261030000000; exported since 20261030003000).
  -- Connection METADATA -- provider, status, scopes, dates, who -- and
  -- the sync history. token_secret_id is PROJECTED OUT BY NAME: it is the
  -- id of a Vault secret, not portable data, and authenticated cannot
  -- select it anyway (20261030001000), so a projection that named it would
  -- make the read refuse rather than leak. The token itself is never a
  -- column. Both workspace reads are requester_rls like every other, so
  -- the export is exactly what the requester reads in the product: an
  -- Owner/Admin (manage_integrations) reads EVERY connection in the
  -- workspace, a colleague's person-scoped mailbox or calendar included --
  -- its metadata, never its token (rls_phase9_integrations.sql IR1a, IX4;
  -- whether that is right is founder question Q234, default as built).
  -- =====================================================================
  ('workspace', 'integration_connections', 'exported', null, 'requester_rls', array['organisation_id'], 'id',
   array['id','organisation_id','provider','owner_user_id','status','scopes','token_expires_at','last_synced_at','created_by','created_at','revoked_at','revoked_by']),
  ('workspace', 'integration_sync_runs',   'exported', null, 'requester_rls', array['organisation_id'], 'id', null),
  -- The ACCOUNT export carries the person's OWN person-scoped connections
  -- (owner_user_id = them), read under their own RLS, with the same
  -- projection. A workspace-scoped connection they merely created is the
  -- workspace's record (the Q132 line) and is in the workspace export.
  ('account',   'integration_connections', 'exported', null, 'requester_rls', array['owner_user_id'], 'id',
   array['id','organisation_id','provider','owner_user_id','status','scopes','token_expires_at','last_synced_at','created_by','created_at','revoked_at','revoked_by'])
$function$;

-- (8) THE FK-LESS ROLL -------------------------------------------------------
CREATE OR REPLACE FUNCTION private.fkless_identifier_columns()
 RETURNS TABLE(table_name text, column_name text, identifies text, treatment text, predicate text, note text)
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select *
    from (values
      -- THE PERSON-BEARING ONES. Every one of these is why this roll exists.
      ('public.merges',           'winner_owner_user_id',    'user', 'null_on_match', null,
       'who owned the surviving record at the moment of the merge'),
      ('public.merges',           'loser_owner_user_id',     'user', 'null_on_match', null,
       'who owned the discarded record at the moment of the merge'),
      ('public.merge_candidates', 'keep_owner_user_id',      'user', 'null_on_match', null,
       'C1: written by public.screen_for_duplicates() on EVERY flagged duplicate'),
      ('public.merge_candidates', 'duplicate_owner_user_id', 'user', 'null_on_match', null,
       'C1: the same, for the proposed duplicate'),
      ('public.rate_limit_counters', 'subject_id',           'user', 'delete_row',
       'subject_scope = ''user''',
       'enforcement state about somebody who will not be asking for anything else; deleted rather than re-pointed, so an erased budget cannot throttle the tombstone'),
      ('public.rate_limit_counters', 'subject_id',           'organisation', 'delete_row',
       'subject_scope = ''organisation''',
       'the same column again, on its other scope: enforcement state about a workspace that has been purged, which the workspace purge deletes (fix round 1 -- the roll named only the `user` scope, so a purged workspace kept its counters)'),
      ('public.audit_events',     'target_id',               'polymorphic', 'handled_explicitly', null,
       'erase_account() step 6b re-points it at the tombstone AND drops the payload; a workspace purge leaves it, because a workspace is not a data subject'),

      -- THE WORKSPACE-BEARING ONE.
      ('public.feedback', 'support_access_organisation_id', 'organisation', 'null_on_match', null,
       'a snapshot of the workspace a superuser was inside when the feedback was written; no foreign key, so a purge would leave it naming a workspace that is gone'),

      -- AND THE REST, CLASSIFIED SO THAT THE DENOMINATOR IS THE CATALOGUE AND
      -- NOT A HABIT. None of these can hold a person or a workspace.
      ('public.audit_events',         'correlation_id',       'other',  'not_a_person', null, 'a thread id'),
      ('public.data_subject_requests','fulfilment_reference', 'other',  'not_a_person', null, 'an export or erasure job id'),
      ('public.feedback',             'support_access_session_id','other','not_a_person', null, 'an impersonation session id'),
      ('public.custom_field_values',  'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.document_links',       'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.meeting_links',        'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.note_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.task_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.network_links',        'private_entity_id',    'record', 'not_a_person', null, 'this workspace''s own CRM row'),
      ('public.network_profiles',     'entity_id',            'record', 'not_a_person', null, 'the published entity'),
      ('public.merges',               'winner_id',            'record', 'not_a_person', null, 'the surviving CRM row'),
      ('public.merges',               'loser_id',             'record', 'not_a_person', null, 'the discarded CRM row'),
      ('public.merge_candidates',     'keep_id',              'record', 'not_a_person', null, 'the proposed survivor'),
      ('public.merge_candidates',     'duplicate_id',         'record', 'not_a_person', null, 'the proposed duplicate'),
      -- PHASE 8 TASK 6. public.retention_runs.correlation_id is the thread a
      -- retention run's audit rows are written on -- audit_events.correlation_id's
      -- twin, and classified the same way for the same reason: it identifies a
      -- RUN OF A JOB and can never name a person or a workspace. It is on this
      -- roll because it MADE THE ERASURE REFUSE the moment the table existed
      -- (55000 / unclassified_fkless_identifier, measured by
      -- rls_phase8_retention.sql § RW on its first run), which is exactly what
      -- the derivation is for.
      ('public.retention_runs',       'correlation_id',       'other',  'not_a_person', null, 'the thread one retention run''s audit rows are written on'),
      -- PHASE 9 (20261030000000; final classification 20261030003000).
      -- token_secret_id names a vault.secrets row (no FK: vault is not ours to
      -- reference). It identifies a SECRET, never a person or a workspace, so
      -- neither generic loop touches it. The secret itself is handled by name:
      -- erase_account() step 5c revokes (Vault secret first) and deletes the
      -- erased person's own person-scoped connections, and erase_organisation()
      -- step 5c deletes every secret of the workspace's connections before the
      -- cascade. The person columns beside it are foreign keys (owner_user_id,
      -- created_by, revoked_by), reached by step 5c and the FK walks.
      ('public.integration_connections', 'token_secret_id', 'other', 'not_a_person', null, 'a vault.secrets id; the token itself is never a column. Its secret is deleted by name by erase_account() and erase_organisation() step 5c')
    ) as r(table_name, column_name, identifies, treatment, predicate, note)
$function$;

-- (9a) THE TWO CLASSES -------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_periods()
 RETURNS TABLE(class text, period interval, applies_to text, clock_from text, authority text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    ('financial',
     interval '7 years',
     'Financial records, and a document attached to an event that carries financial entries (private.document_retention_class()).',
     'the record''s deleted_at',
     'CLAUDE.md § Non-negotiable rules ("7 years for financial records"); Q133.'),

    ('operational',
     interval '2 years',
     'A soft-deleted document with no financial parent: its BYTES, once this has run from its deletion. The row stays as the record that the file existed.',
     'documents.deleted_at',
     'CLAUDE.md § Non-negotiable rules ("2 years for inactive-account data"); Q52; Q133.'),

    ('feedback',
     interval '2 years',
     'public.feedback rows and their feedback-screenshots objects. Already enforced at READ time by private.feedback_retention_cutoff(); the sweep is what makes an expired row actually absent.',
     'feedback.created_at',
     'CLAUDE.md § In-app feedback ("Retention: 2 years"); Q120; Q133.'),

    ('audit_hot',
     interval '30 days',
     'public.audit_events stay in the audit-log viewer''s DEFAULT range for this long. Nothing is deleted at this age -- Q135: at MVP "archived" means the rows are still in Postgres and simply fall out of the default window.',
     'audit_events.created_at',
     'CLAUDE.md § Non-negotiable rules ("hot/queryable for 30 days"); Q135.'),

    ('audit_total',
     interval '1 year',
     'public.audit_events are DELETED at this age. THE ONE SWEEP THAT DESTROYS EVIDENCE -- private.purge_audit_events() carries a hard floor that refuses a period shorter than this whatever this row says (part 4).',
     'audit_events.created_at',
     'CLAUDE.md § Non-negotiable rules ("archived (cold storage) for up to 1 year total, then purged"); Q135; SECURITY.md § 7.'),

    ('workspace',
     interval '60 days',
     'A suspended or closed workspace, then hard-purged by private.erase_organisation(). Reinstating it any time inside the window clears the clock outright (private.organisation_lifecycle_sync()).',
     'organisations.lifecycle_changed_at, through retention_expires_at',
     'FOUNDER RULING Q88 (2026-09-07); Q92; Q102; Q133.'),

    ('rate_limit_counter',
     interval '7 days',
     'A fixed-window counter whose window closed this long ago. The longest live window is 24h (account_erasure, account_lockout), so seven days is a week of slack past the longest thing that could still be counting.',
     'rate_limit_counters.window_start',
     'Q110. No founder ruling: the counters are enforcement state, not records about anybody, and the only cost of a longer period is table size.'),

    ('incident_alert',
     interval '1 year',
     'A RESOLVED incident alert and its details JSON (which carries subject ids). An OPEN alert is never purged at any age -- it is an outstanding operational problem, and deleting it would delete the reason somebody has not looked at it yet.',
     'incident_alerts.resolved_at',
     'Q117, proposed here and queued: nothing had been written. One year matches audit_total, which is what an alert is evidence alongside.'),

    ('erasure_job_failed',
     interval '90 days',
     'A FAILED public.erasure_jobs row, which still names the person and the reason. A SUCCEEDED row is kept FOR EVER and is deliberately not on this list: both its user columns are already null, so it is pseudonymous, and it is the proof the deletion happened.',
     'erasure_jobs.completed_at',
     'Q175, recommended by Task 5 for this task.'),

    ('stuck_job',
     interval '1 hour',
     'A public.export_jobs or public.erasure_jobs row left `running` this long is marked `failed` with a recorded reason. NOT A DELETION: the row survives, and the point is to release the one-live-job index so the subject can ask again.',
     'the job''s started_at',
     'Q166, recommended by Task 4 for this task; Task 5 recorded the same shape, worse, for an erasure.'),

    -- ADDED IN 20261003002000, with the sweep that needs it.
    ('storage_orphan',
     interval '1 day',
     'A stored object that NO row in the database names. Deleted by the runner once it is this old. The grace period is not caution for its own sake: an upload writes the object and THEN the row, so for a fraction of a second every healthy upload is an orphan, and a sweep with no grace would occasionally delete a file somebody was in the middle of sending.',
     'storage.objects.created_at',
     'Q52 and Q120 both ask for the orphan half; the grace period is engineering, not a legal period, and it is the one entry on this list counsel has no view on.'),

    -- ADDED IN 20261030003000 (Phase 9 Task 3), with the sweep that needs them.
    ('integration_sync_run',
     interval '90 days',
     'A FINISHED sync run of an integration connection: when the service last synced with another one, how many items moved and, for a failure, a closed error code. A run still `running` is not on this clock.',
     'integration_sync_runs.finished_at',
     'Phase 9 spec (2026-10-09 integrations schema design, founder-approved); operational history, not a record about anybody.'),

    ('integration_connection_revoked',
     interval '2 years',
     'A REVOKED integration connection: the record that it existed (provider, scopes, dates, who). Its token is already gone -- revoking deletes the Vault secret at once. A live connection is never on this clock; it goes with its workspace, or with its owner''s account if it is person-scoped.',
     'integration_connections.revoked_at',
     'Phase 9 spec; CLAUDE.md § Non-negotiable rules ("2 years for inactive-account data") as the inactive-data default.')
$function$;

-- (9b) THE SUBJECTS: THE INTERIM ROWS REPLACED --------------------------------
CREATE OR REPLACE FUNCTION private.retention_subjects()
 RETURNS TABLE(table_name text, treatment text, class text, reason text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are already purged by the export runner''s own expiry.'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.'),

    -- ---- the notice ledger (added in 20261016000000) ----------------------
    ('private.notification_deliveries', 'cascades', null,
     'One row per connection-request / task-reminder email accepted by Brevo: a notice name, a subject id and a time -- no address, no content. FKs to public.tasks and public.network_connection_requests, ON DELETE CASCADE: a stamp goes with the row it is about, and both of those go with their workspace.'),

    -- ---- the closure-backup marker (added in 20261027000000) -------------
    ('private.closure_backup_reads', 'ephemeral', null,
     'One row per transaction in which public.export_read_page() is reading a closure_backup job (20261025000000, Task 9c C1): a transaction id, the organisation id and the export job id -- no tenant data. Inserted and deleted inside that one call, on both its success and its failure path, so the table is empty at rest (rls_phase8_closure_backup.sql KA7/KM). Nothing to sweep; the FKs also cascade with the workspace and the job.'),

    -- ---- integrations (tables 20261030000000; classes 20261030003000) ---
    ('integration_connections', 'swept', 'integration_connection_revoked',
     'private.sweep_integration_records(): a REVOKED connection, once its class has run from revocation; its token went when it was revoked. A live one goes with its workspace (erase_organisation step 5c deletes the Vault secrets first) or, person-scoped, with its owner''s account (erase_account step 5c) or membership (the membership trigger revokes it).'),
    ('integration_sync_runs',   'swept', 'integration_sync_run',
     'private.sweep_integration_records(): a FINISHED run, once its class has run. Also goes with its connection (composite FK, ON DELETE CASCADE) and its workspace.')
$function$;

-- (9c) THE SWEEP ------------------------------------------------------------------
-- The sync runs first, so a connection deleted second does not take a run
-- this sweep was about to count. A revoked connection holds no secret (the
-- CHECK and revoke both guarantee it); a secret still filed under its name
-- is deleted with it anyway, because the row is the last thing naming it.
create or replace function private.sweep_integration_records(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runs  bigint;
  v_conns bigint;
  v_run_cut  timestamptz;
  v_conn_cut timestamptz;
  v_ids   uuid[];
begin
  v_run_cut  := pg_catalog.now() - private.retention_period('integration_sync_run');
  v_conn_cut := pg_catalog.now() - private.retention_period('integration_connection_revoked');

  if p_dry then
    select pg_catalog.count(*) into v_runs
      from (select 1 from public.integration_sync_runs r
             where r.finished_at is not null and r.finished_at < v_run_cut
             order by r.finished_at
             limit p_limit) t;
    select pg_catalog.count(*) into v_conns
      from (select 1 from public.integration_connections c
             where c.status = 'revoked' and c.revoked_at is not null
               and c.revoked_at < v_conn_cut
             order by c.revoked_at
             limit p_limit) t;
  else
    with doomed as (
      select r.id from public.integration_sync_runs r
       where r.finished_at is not null and r.finished_at < v_run_cut
       order by r.finished_at
       limit p_limit)
    delete from public.integration_sync_runs r using doomed d where r.id = d.id;
    get diagnostics v_runs = row_count;

    select pg_catalog.array_agg(t.id) into v_ids
      from (select c.id from public.integration_connections c
             where c.status = 'revoked' and c.revoked_at is not null
               and c.revoked_at < v_conn_cut
             order by c.revoked_at
             limit p_limit) t;
    delete from vault.secrets s
     where s.name in (select 'integration:' || x::text
                        from pg_catalog.unnest(coalesce(v_ids, '{}'::uuid[])) x);
    delete from public.integration_connections c where c.id = any (coalesce(v_ids, '{}'::uuid[]));
    get diagnostics v_conns = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'integration_sync_runs.rows', v_runs,
    'integration_sync_runs.capped', v_runs >= p_limit,
    'integration_connections.rows', v_conns,
    'integration_connections.capped', v_conns >= p_limit);
end;
$function$;

revoke all on function private.sweep_integration_records(boolean, integer)
  from public, anon, authenticated, service_role;

comment on function private.sweep_integration_records(boolean, integer) is
  'Phase 9 Task 3 (20261030003000). Retention for the integration tables: FINISHED sync runs older than integration_sync_run (90 days, from finished_at), then REVOKED connections older than integration_connection_revoked (2 years, from revoked_at), with any Vault secret still filed under such a connection''s name. Live connections and running sync runs are never on a clock. Bounded by p_limit per table; p_dry counts only.';

-- (9d) THE SWEEP BODY ---------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_sweep_body(p_dry boolean, p_limit integer)
 RETURNS TABLE(swept jsonb, refused jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_swept   jsonb := '{}'::jsonb;
  v_refused jsonb := '{}'::jsonb;
  v_state   text;
  v_hint    text;
begin
  -- Each sweep in its own subtransaction. A refusal is recorded and the run
  -- carries on; there is no sweep whose failure stops another.
  begin
    v_swept := v_swept || private.sweep_rate_limit_counters(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('rate_limit_counters', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_feedback(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('feedback', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_incident_alerts(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('incident_alerts', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_erasure_jobs(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('erasure_jobs', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.reap_stuck_jobs(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('stuck_jobs', coalesce(nullif(v_hint, ''), v_state));
  end;

  begin
    v_swept := v_swept || private.sweep_document_bytes(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('documents', coalesce(nullif(v_hint, ''), v_state));
  end;

  -- 20261030003000 (Phase 9 Task 3): finished sync runs at 90 days, revoked
  -- connections at 2 years.
  begin
    v_swept := v_swept || private.sweep_integration_records(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('integrations', coalesce(nullif(v_hint, ''), v_state));
  end;

  -- THE DANGEROUS ONE, in the middle of the list rather than first or last,
  -- because its rails are what protect it and not its position.
  begin
    v_swept := v_swept || private.purge_audit_events(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('audit_events', coalesce(nullif(v_hint, ''), v_state));
  end;

  -- LAST, deliberately: the primitive refuses while a byte of the workspace
  -- is still in its bucket, so it wants the freshest possible view of a
  -- bucket the runner has just been deleting from.
  begin
    v_swept := v_swept || private.sweep_expired_workspaces(p_dry, p_limit);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    v_refused := v_refused || pg_catalog.jsonb_build_object('organisations', coalesce(nullif(v_hint, ''), v_state));
  end;

  return query select v_swept, v_refused;
end;
$function$;

-- (9e) THE CLOCK ROLL ---------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_clock_columns()
 RETURNS TABLE(schema_name text, table_name text, column_name text, role text, guard text, note text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    ('public', 'audit_events', 'created_at', 'clock', null,
     'audit_total. No client role holds INSERT or UPDATE on the table; rows are written by definer functions and triggers.'),

    ('public', 'documents', 'deleted_at', 'clock',
     'trigger:private.guard_document_retention_columns',
     'operational / financial. THE COLUMN REVIEW FINDING C1 WAS ABOUT. A client holds UPDATE on it because soft-delete and restore are its own writes; the guard overwrites a null -> value transition with now() and refuses a re-date (20261004000000). Not in the INSERT grant.'),
    ('public', 'documents', 'retention_class', 'clock',
     'trigger:private.guard_document_retention_columns',
     'THE PERIOD HALF OF THE SAME CLOCK (fix round 2, I-N1 / Q186): which of operational / financial applies, frozen by the guard when deleted_at is set, cleared on restore, immutable otherwise for every writer. No client grant at all; derived onto this roll as the column the sweep hands to retention_period().'),
    ('public', 'documents', 'bytes_purged_at', 'clock', null,
     'The record that the sweep ran, and the term that takes a document OUT of every future sweep. No client grant at all since 20261004000000; the guard refuses it too if one is ever added.'),
    ('public', 'documents', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s. No client grant since 20261004000000 either.'),

    ('public', 'erasure_jobs', 'completed_at', 'clock', null,
     'erasure_job_failed. No client write path: the table''s outcome columns are server-only (20260930001000).'),
    ('public', 'erasure_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_jobs', 'completed_at', 'clock', null,
     'Written by the reaper, read by nothing as a cutoff; classified `clock` rather than excused because no client can write it and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'requested_at', 'clock', null,
     'Q229 (20261029002000): private.closure_backup_owed() reads it to pick a workspace''s LATEST closure backup, the one whose download releases the held purge -- an ordering, not a cutoff, classified `clock` rather than excused because no client can write it (the request is immutable under export_jobs_before_update(), and authenticated''s INSERT grant is column-level, without it) and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    -- PHASE 9 TASK 3 (20261030003000). Neither table has ANY client write
    -- grant (20261030000000: authenticated holds SELECT only; anon and
    -- service_role hold nothing), so no client can move either clock.
    ('public', 'integration_connections', 'revoked_at', 'clock', null,
     'integration_connection_revoked. Written by two server paths only, each with now(): private.revoke_integration_row(), and the out-of-band branch of private.integration_connections_guard() (an account deleted outside the erasure nulls a live person-scoped row''s owner, and the guard revokes it in that write). A revoked row is then frozen whole by the same guard. No client INSERT or UPDATE grant on the table.'),
    ('public', 'integration_sync_runs', 'finished_at', 'clock', null,
     'integration_sync_run. Written only by public.record_integration_sync_run() (service_role, no person on the session), with now(). No client INSERT or UPDATE grant on the table.'),

    ('public', 'merge_candidates', 'deleted_at', 'not_a_clock', null,
     'A false candidate the fixed-point walk (m-N1) reaches through private.erase_account(): that function''s `deleted_at` is organisations'', read as a filter on which workspaces are live, never as a cutoff. No client role holds UPDATE on merge_candidates.deleted_at.'),
    ('public', 'notes', 'deleted_at', 'not_a_clock', null,
     'A false candidate reached the same way: erase_account() hard-deletes a private note by ownership, not by age. A client holds UPDATE on notes.deleted_at (soft-delete/restore are its own writes), which is harmless because nothing judges a note on it.'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC, with the hint organisation_lifecycle_is_the_rpcs (m-N2) so the probe can tell it from organisations_update_manage_organisation''s WITH CHECK, which carries `deleted_at is null` and refuses the same write with the same SQLSTATE -- a second layer, not the named one.'),
    ('public', 'organisations', 'retention_expires_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace. RECOMPUTED on every write by the sync trigger from lifecycle_changed_at, and nulled whenever the workspace is live -- so a written value never survives the statement that wrote it.'),
    ('public', 'organisations', 'lifecycle_changed_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace -- THE REAL CLOCK, and one the derivation cannot reach: no retention function names it, the sync trigger computes retention_expires_at from it. Nulled on a live workspace; on a closed one it is writable only by a session the UPDATE policies admit, which is the audited lifecycle RPCs and nobody else.'),
    ('public', 'organisations', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s.'),

    ('public', 'rate_limit_counters', 'window_start', 'clock', null,
     'rate_limit_counter. No client role can write or read a counter (20260909020000).'),

    ('public', 'retention_settings', 'audit_ceiling_released_at', 'clock', null,
     'The start of an audit-purge ceiling release (Q184, founder 2026-09-30, 20261010000000), read by private.audit_ceiling_release_active() -- not a cutoff for any row, but it decides whether rail 3 applies, so it is classified as a clock rather than excused. No client role holds INSERT or UPDATE on retention_settings (RC4); written only by public.release_audit_purge_ceiling(), with now().'),
    ('public', 'retention_settings', 'audit_ceiling_release_expires_at', 'clock', null,
     'The end of that release: released_at + 72 hours, held by the CHECK retention_settings_audit_ceiling_release_shape and re-checked by the reader. Same writer, same absence of any client grant.'),

    ('storage', 'objects', 'created_at', 'clock',
     'no_permissive_policy,policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies; the six named here are the INSERT and UPDATE halves of that fence. THE LAYER THAT ACTUALLY REFUSES TODAY IS DEFAULT DENY -- no permissive policy admits a client role at all (m-N2) -- so `no_permissive_policy` is named first: adding one is a forgeable_retention_clock refusal, and the restrictive six are the layer behind it. The probe measures their composite.')
$function$;

-- ---------------------------------------------------------------------------
-- SELF-CHECKS. Each refuses the migration rather than ship a lifecycle that
-- does not hold.
-- ---------------------------------------------------------------------------
do $do$
begin
  if private.export_catalogue_is_sound() <> 'sound' then
    raise exception 'phase 9 task 3: the export catalogue is not sound: %', private.export_catalogue_is_sound();
  end if;
  if exists (select 1 from private.export_catalogue()
              where table_name like 'integration\_%' and disposition <> 'exported') then
    raise exception 'phase 9 task 3: an integration table is still excused from an export';
  end if;
  if exists (select 1 from private.export_catalogue()
              where table_name = 'integration_connections'
                and (projection is null or 'token_secret_id' = any (projection))) then
    raise exception 'phase 9 task 3: an integration_connections export does not project token_secret_id out';
  end if;
  if (select count(*) from private.retention_subjects()
       where table_name like 'integration\_%' and treatment = 'swept') <> 2 then
    raise exception 'phase 9 task 3: the integration retention subjects are not both swept';
  end if;
  perform private.retention_period('integration_sync_run');
  perform private.retention_period('integration_connection_revoked');
  if exists (select 1 from private.integration_providers() where live) then
    raise exception 'phase 9 task 3: a provider is live';
  end if;
end;
$do$;
