-- Phase 7 Task 6b, part 2: one correlation id per multi-row CRM operation.
--
-- 20260912000000 put an audit row on every INSERT and UPDATE of the eleven
-- mutable CRM tables. Four RPCs in this schema perform SEVERAL such writes as
-- one action, and without this file each of their rows would carry its own
-- freshly minted correlation_id -- exactly the un-correlated spray Q94 and
-- 20260828141000's header ("thousands of rows sharing nothing but a
-- timestamp") warned about:
--
--   public.merge_records                   winner rewrite, loser soft-delete,
--                                          link repoints, custom-field carries
--                                          and sweeps, the merges row, the
--                                          summary row
--   public.set_contact_primary_company     demote the old primary, promote the
--                                          new one
--   public.set_artist_primary_representation  the same pair
--   public.set_custom_field_values         N upserts plus a sweep
--
-- THE MECHANISM IS TASK 3's, REUSED, NOT REINVENTED. 20260908030000 taught
-- private.log_audit_event() to resolve its correlation id in three steps --
-- an explicit argument, then the transaction-local thread
-- private.begin_lifecycle_transition() declares, then a fresh uuid -- so that
-- "an operation declares itself once and every audit row written anywhere
-- inside it, by any trigger including one added years later, joins one thread
-- with no call site edited." That is precisely the property needed here, and
-- the triggers 20260912000000 added are the "trigger added later" that
-- sentence anticipated.
--
-- BUT NOT THE SAME GUC, AND THIS IS THE ONE DESIGN DECISION IN THIS FILE.
-- begin_lifecycle_transition() is gated on the platform superuser, and its
-- marker (app.lifecycle_correlation_id) is ALSO A SECURITY CONTROL: it is the
-- second term of organisations_update_platform_lifecycle, what stops a raw
-- PATCH from satisfying the superuser's UPDATE policy. A merge is run by an
-- ordinary member. Letting a member set THAT marker would be harmless today
-- (the policy's first term still requires the platform permission) and a
-- latent hole tomorrow (any future policy that reads the marker alone). So
-- this file adds a SECOND, unprivileged thread -- app.crm_bulk_correlation_id
-- -- that log_audit_event() consults AFTER the lifecycle one and that nothing
-- in any policy reads. Declaring it groups rows and grants nothing.
--
-- HOW THE FOUR RPCs PICK IT UP WITHOUT A 600-LINE COPY. Their shipped bodies
-- are immutable and long (merge_records alone is ~500 lines of dynamic SQL).
-- Each is MOVED, not copied: `alter function ... set schema private` plus a
-- rename to `<name>_unthreaded`, and a thin public wrapper with the ORIGINAL
-- name and signature that opens the thread, delegates, and closes it. The
-- wrapper is SECURITY INVOKER like the body it wraps, so RLS is unchanged.
-- Moving the body to `private` is what keeps the thread mandatory: `private`
-- is not exposed to PostgREST, so `POST /rest/v1/rpc/merge_records_unthreaded`
-- is 404, and the only routable name is the one that declares the thread.
-- The runner's HTTP block asserts that.
--
-- WHAT CLOSES THE THREAD. end_crm_bulk_audit() as the wrapper's last
-- statement, for the reason 20260908030000 measured: an is_local GUC stands
-- until the end of the TRANSACTION whatever SET clauses the call stack
-- carries. A raise inside the body aborts the transaction and takes the
-- marker with it. Over PostgREST each request is its own transaction anyway;
-- the explicit close is for psql and for any future RPC that calls two of
-- these in one transaction and wants two threads, not one.

-- ---------------------------------------------------------------------------
-- 1. THE SECOND THREAD
-- ---------------------------------------------------------------------------
create or replace function private.crm_bulk_correlation_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare v_raw text;
begin
  v_raw := nullif(pg_catalog.current_setting('app.crm_bulk_correlation_id', true), '');
  if v_raw is null then
    return null;
  end if;
  return v_raw::uuid;
exception when invalid_text_representation then
  -- Narrow on purpose (20260908030000's lesson): a malformed value means "no
  -- thread", never "no audit row", and never a swallowed coding error.
  return null;
end;
$$;

comment on function private.crm_bulk_correlation_id() is
  'The correlation id of the multi-row CRM operation in progress, or null. Reads the transaction-local GUC app.crm_bulk_correlation_id, which only private.begin_crm_bulk_audit() sets. Consulted by private.log_audit_event() after the lifecycle thread and before minting a fresh id. Deliberately a SEPARATE GUC from app.lifecycle_correlation_id: that one is a security control read by organisations_update_platform_lifecycle, this one is read by no policy and grants nothing -- it only groups rows.';

revoke all on function private.crm_bulk_correlation_id() from public, anon, authenticated, service_role;

create or replace function private.begin_crm_bulk_audit(p_correlation_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_correlation_id is null then
    raise exception 'begin_crm_bulk_audit: a correlation id is required'
      using errcode = '22023';
  end if;
  perform pg_catalog.set_config(
    'app.crm_bulk_correlation_id', p_correlation_id::text, true);
end;
$$;

comment on function private.begin_crm_bulk_audit(uuid) is
  'OPENS one multi-row CRM operation under one correlation id, so every audit row written inside it -- by the INSERT/UPDATE/DELETE triggers on the CRM tables, by private.record_merge(), by anything added later -- joins one thread. Granted to authenticated because its callers are the SECURITY INVOKER wrappers public.merge_records / set_contact_primary_company / set_artist_primary_representation / set_custom_field_values; unroutable itself because `private` is not exposed. Not a permission gate and read by no policy. MUST BE PAIRED with private.end_crm_bulk_audit().';

revoke all on function private.begin_crm_bulk_audit(uuid) from public, anon, service_role;
grant execute on function private.begin_crm_bulk_audit(uuid) to authenticated;

create or replace function private.end_crm_bulk_audit()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.crm_bulk_correlation_id', '', true);
end;
$$;

comment on function private.end_crm_bulk_audit() is
  'CLOSES the operation private.begin_crm_bulk_audit() opened. Called as the last statement of each wrapper; an is_local GUC otherwise stands to the end of the transaction whatever SET clauses the call stack carries (measured in 20260908030000).';

revoke all on function private.end_crm_bulk_audit() from public, anon, service_role;
grant execute on function private.end_crm_bulk_audit() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. log_audit_event(): three steps become four. Everything else is byte for
-- byte 20260908030000's, which was byte for byte 20260826154304's.
-- ---------------------------------------------------------------------------
create or replace function private.log_audit_event(
  p_action          text,
  p_target_type     text,
  p_organisation_id uuid  default null,
  p_target_id       uuid  default null,
  p_correlation_id  uuid  default null,
  p_before          jsonb default null,
  p_after           jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_actor is null then
    raise exception 'log_audit_event: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if p_action is null or pg_catalog.btrim(p_action) = '' then
    raise exception 'log_audit_event: action is required' using errcode = '22023';
  end if;

  if p_target_type is null or pg_catalog.btrim(p_target_type) = '' then
    raise exception 'log_audit_event: target_type is required' using errcode = '22023';
  end if;

  insert into public.audit_events (
    organisation_id, actor_user_id, action, target_type,
    target_id, correlation_id, before, after
  )
  values (
    p_organisation_id,
    v_actor,
    p_action,
    p_target_type,
    p_target_id,
    -- THE FOUR-STEP COALESCE. An explicit id wins; then the superuser's
    -- lifecycle thread (Task 3); then the member-level CRM bulk thread
    -- (Task 6b); then, exactly as before, a fresh id per row.
    coalesce(
      p_correlation_id,
      private.bulk_audit_correlation_id(),
      private.crm_bulk_correlation_id(),
      pg_catalog.gen_random_uuid()),
    p_before,
    p_after
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb) is
  'Sole write path into public.audit_events (which has no INSERT policy). actor_user_id is forced to auth.uid() and cannot be supplied by the caller. EXECUTE is intentionally granted to no client role -- callers are other SECURITY DEFINER functions. The correlation id resolves in FOUR steps since Phase 7 Task 6b (20260912001000): an explicit p_correlation_id wins; then the superuser''s lifecycle thread (private.begin_lifecycle_transition, Task 3); then the member-level CRM bulk thread (private.begin_crm_bulk_audit, Task 6b -- a separate GUC because the lifecycle one is also a policy term); then a fresh uuid per call. An operation declares itself once and every row written anywhere inside it, by any trigger, joins one thread with no call site edited.';

revoke all on function private.log_audit_event(text, text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE FOUR WRAPPERS. Move the body, wrap it under its own name.
-- ---------------------------------------------------------------------------

-- merge_records ------------------------------------------------------------
alter function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb) set schema private;
alter function private.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  rename to merge_records_unthreaded;
revoke all on function private.merge_records_unthreaded(uuid, text, uuid, uuid, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function private.merge_records_unthreaded(uuid, text, uuid, uuid, jsonb, jsonb)
  to authenticated;

create function public.merge_records(
  p_organisation_id      uuid,
  p_entity_type          text,
  p_winner_id            uuid,
  p_loser_id             uuid,
  p_field_choices        jsonb default '{}'::jsonb,
  p_custom_field_choices jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.begin_crm_bulk_audit(pg_catalog.gen_random_uuid());
  v_id := private.merge_records_unthreaded(
    p_organisation_id, p_entity_type, p_winner_id, p_loser_id,
    p_field_choices, p_custom_field_choices);
  perform private.end_crm_bulk_audit();
  return v_id;
end;
$$;

comment on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb) is
  'The client-callable merge (Phase 2 Task 6 fix rounds, 20260829030000 for the body). Since Phase 7 Task 6b a thin SECURITY INVOKER wrapper: opens one CRM bulk-audit thread, delegates to private.merge_records_unthreaded() -- the moved, unchanged body -- and closes it, so the winner rewrite, the loser soft-delete, every link repoint, every custom-field carry and sweep, the merges row and the summary row share ONE correlation_id in audit_events. The body is in `private` so it is not routable on its own; the only reachable merge is the threaded one. Authorisation is unchanged: the wrapper runs as the caller and every statement inside still meets RLS.';

revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  to authenticated;

-- set_contact_primary_company ----------------------------------------------
alter function public.set_contact_primary_company(uuid, uuid, uuid) set schema private;
alter function private.set_contact_primary_company(uuid, uuid, uuid)
  rename to set_contact_primary_company_unthreaded;
revoke all on function private.set_contact_primary_company_unthreaded(uuid, uuid, uuid)
  from public, anon, service_role;
grant execute on function private.set_contact_primary_company_unthreaded(uuid, uuid, uuid)
  to authenticated;

create function public.set_contact_primary_company(
  p_contact_id      uuid,
  p_company_id      uuid,
  p_organisation_id uuid
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.begin_crm_bulk_audit(pg_catalog.gen_random_uuid());
  v_n := private.set_contact_primary_company_unthreaded(
    p_contact_id, p_company_id, p_organisation_id);
  perform private.end_crm_bulk_audit();
  return v_n;
end;
$$;

comment on function public.set_contact_primary_company(uuid, uuid, uuid) is
  'Changes a contact''s primary company as one transaction (20260828234500/20260828235000 for the body). Since Phase 7 Task 6b a thin SECURITY INVOKER wrapper that opens one CRM bulk-audit thread around private.set_contact_primary_company_unthreaded(), so the demote and the promote -- two contact_company.updated rows -- share one correlation_id. Authorisation unchanged.';

revoke all on function public.set_contact_primary_company(uuid, uuid, uuid)
  from public, anon, service_role;
grant execute on function public.set_contact_primary_company(uuid, uuid, uuid)
  to authenticated;

-- set_artist_primary_representation ----------------------------------------
alter function public.set_artist_primary_representation(uuid, uuid, uuid) set schema private;
alter function private.set_artist_primary_representation(uuid, uuid, uuid)
  rename to set_artist_primary_representation_unthreaded;
revoke all on function private.set_artist_primary_representation_unthreaded(uuid, uuid, uuid)
  from public, anon, service_role;
grant execute on function private.set_artist_primary_representation_unthreaded(uuid, uuid, uuid)
  to authenticated;

create function public.set_artist_primary_representation(
  p_artist_id         uuid,
  p_representation_id uuid,
  p_organisation_id   uuid
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.begin_crm_bulk_audit(pg_catalog.gen_random_uuid());
  v_n := private.set_artist_primary_representation_unthreaded(
    p_artist_id, p_representation_id, p_organisation_id);
  perform private.end_crm_bulk_audit();
  return v_n;
end;
$$;

comment on function public.set_artist_primary_representation(uuid, uuid, uuid) is
  'Changes an artist''s primary representation as one transaction (20260829000000 for the body). Since Phase 7 Task 6b a thin SECURITY INVOKER wrapper that opens one CRM bulk-audit thread around private.set_artist_primary_representation_unthreaded(), so the demote and the promote share one correlation_id. Authorisation unchanged.';

revoke all on function public.set_artist_primary_representation(uuid, uuid, uuid)
  from public, anon, service_role;
grant execute on function public.set_artist_primary_representation(uuid, uuid, uuid)
  to authenticated;

-- set_custom_field_values --------------------------------------------------
alter function public.set_custom_field_values(uuid, text, uuid, jsonb) set schema private;
alter function private.set_custom_field_values(uuid, text, uuid, jsonb)
  rename to set_custom_field_values_unthreaded;
revoke all on function private.set_custom_field_values_unthreaded(uuid, text, uuid, jsonb)
  from public, anon, service_role;
grant execute on function private.set_custom_field_values_unthreaded(uuid, text, uuid, jsonb)
  to authenticated;

create function public.set_custom_field_values(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid,
  p_values          jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.begin_crm_bulk_audit(pg_catalog.gen_random_uuid());
  v_n := private.set_custom_field_values_unthreaded(
    p_organisation_id, p_entity_type, p_entity_id, p_values);
  perform private.end_crm_bulk_audit();
  return v_n;
end;
$$;

comment on function public.set_custom_field_values(uuid, text, uuid, jsonb) is
  'Writes one entity''s whole custom-field value set as one transaction (20260829011000 for the body). Since Phase 7 Task 6b a thin SECURITY INVOKER wrapper that opens one CRM bulk-audit thread around private.set_custom_field_values_unthreaded(), so every custom_field_value.created/.updated/.deleted row one save produces shares one correlation_id. Authorisation unchanged.';

revoke all on function public.set_custom_field_values(uuid, text, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.set_custom_field_values(uuid, text, uuid, jsonb)
  to authenticated;
