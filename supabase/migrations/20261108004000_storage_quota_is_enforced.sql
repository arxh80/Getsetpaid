-- ===========================================================================
-- Phase 10 Task 23 (G36): the storage quota is enforced, and the custom-field
-- limit stops racing.
--
-- subscription_plans.storage_limit_gb (Free 0, Starter 5, Pro 20) was read by
-- nothing but the tier tests and the health page, so one Starter user could
-- store about 6 GiB a day and nothing refused; SECURITY.md § 5 relies on the
-- quota as the bound on upload abuse. One BEFORE INSERT trigger on
-- public.documents is the control, because it binds every writer, and
-- uploadDocumentAction already removes the stored bytes when the row insert
-- fails.
--
--   * The limit is the EFFECTIVE plan's (private.effective_organisation_plan),
--     so a billing override counts. NULL means unlimited. A gigabyte here is
--     a GiB (1024^3 bytes).
--   * Usage is every document row whose bytes still exist: soft-deleted ones
--     count until the retention sweep purges them (Q52). Feedback screenshots
--     and export archives are platform-scoped and short-lived, so they are not
--     counted.
--   * A per-workspace transaction advisory lock serialises the check, so two
--     uploads in parallel cannot both spend the last free bytes.
--   * A downgrade never deletes. An organisation over its new limit keeps
--     every file; only new uploads are refused.
--   * The refusal is 42501 with hint `storage_quota_exceeded`, which the
--     action turns into a sentence.
--
-- ORACLE GUARD, as private.enforce_custom_field_limit() has: a BEFORE ROW
-- trigger runs before the RLS WITH CHECK, so a session that may not add
-- documents to this organisation is left to the policy, whose refusal says
-- nothing about the target's usage. A writer with no session (postgres, the
-- service role) is always checked.
-- ===========================================================================

create function private.enforce_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit_gb integer;
  v_used     bigint;
begin
  if (select auth.uid()) is not null
     and new.organisation_id not in (select private.permitted_organisations('manage_documents')) then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('storage_quota:' || new.organisation_id::text, 0));

  select e.storage_limit_gb into v_limit_gb
    from private.effective_organisation_plan(new.organisation_id) e;
  if v_limit_gb is null then
    return new;
  end if;

  select coalesce(sum(d.size_bytes), 0) into v_used
    from public.documents d
   where d.organisation_id = new.organisation_id
     and d.bytes_purged_at is null;

  if v_used + new.size_bytes > v_limit_gb::bigint * 1073741824 then
    raise exception 'storage quota exceeded for this organisation'
      using errcode = '42501', hint = 'storage_quota_exceeded';
  end if;
  return new;
end;
$$;

comment on function private.enforce_storage_quota() is
  'BEFORE INSERT on public.documents (20261108004000, Phase 10 Task 23, G36): refuses a document whose bytes would take the organisation past its effective plan''s storage_limit_gb (GiB; NULL = unlimited), counting every row whose bytes are not yet purged. Serialised per organisation by a transaction advisory lock. 42501, hint storage_quota_exceeded. Leaves a session that may not manage this organisation''s documents to the INSERT policy, so the refusal is not an oracle.';

revoke all on function private.enforce_storage_quota() from public, anon, authenticated, service_role;

create trigger enforce_storage_quota
  before insert on public.documents
  for each row execute function private.enforce_storage_quota();

-- ---------------------------------------------------------------------------
-- The custom-field limit (20260829010500, whose header says "IT DOES NOT
-- SERIALISE"): two definitions created at once could both see the last free
-- slot. Rebuilt from the live definition with one change: a per-organisation,
-- per-entity-type advisory lock before the count.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_custom_field_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- ORACLE GUARD, FIRST. A BEFORE ROW trigger runs before the RLS WITH CHECK,
  -- so without this a stranger could POST a definition naming any organisation
  -- id and read that organisation's limit state out of which refusal came
  -- back. Saying nothing here leaves the policy to answer, and the policy's
  -- answer carries no information about the target.
  if new.organisation_id not in (
    select private.permitted_organisations('manage_custom_fields')
  ) then
    return new;
  end if;

  -- Only the two transitions that INCREASE the live count are gated.
  --
  --   INSERT of a live row      -> gated
  --   INSERT of a deleted row   -> not gated (it consumes no slot)
  --   UPDATE deleted -> live    -> gated (restore; Q12 makes a slot the thing
  --                                being reclaimed, so it is a real spend)
  --   every other UPDATE        -> not gated, which is what keeps an
  --                                over-limit organisation editable after a
  --                                downgrade
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null then
    return new;
  end if;

  -- SERIALISED (Phase 10 Task 23): the count below and this row's insert are
  -- one decision per organisation and entity type, so two concurrent
  -- definitions cannot both take the last slot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'custom_field_limit:' || new.organisation_id::text || ':' || new.entity_type, 0));

  if not private.custom_field_slot_available(new.organisation_id, new.entity_type) then
    raise exception
      'custom field limit reached for this organisation on entity_type %', new.entity_type
      using errcode = '42501';
  end if;

  return new;
end;
$function$;
