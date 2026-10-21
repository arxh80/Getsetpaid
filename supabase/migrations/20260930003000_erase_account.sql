-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 4: ERASING AN ACCOUNT.
--
-- ONE function does the whole sequence, in ONE transaction, in a FIXED order.
-- The server action is a caller; the runner is a caller; Task 6 will be a
-- caller. None of them is where the rules live.
--
-- ===========================================================================
-- THE ORDER, AND WHY EACH STEP IS WHERE IT IS
-- ===========================================================================
--  0  refuse the tombstone itself, and the null subject
--  1  IDEMPOTENCE: an account that is already gone returns
--     {"already_erased": true}. Running it twice is not an error (the brief),
--     and a retry after a failed write of a failure must not raise.
--  2  THE Q131 LAST-OWNER GUARD, as the enforcement. It is asked again at
--     the insert, but a workspace can lose its other Owner in between.
--  3  THE BYTES ARE ALREADY GONE, or refuse. Storage lives outside Postgres;
--     the runner sweeps it first and this REFUSES while anything is left, so
--     deleting the rows can never be what makes an object unreachable-but-
--     present. Feedback screenshots and export archives, by name.
--  4  PRIVATE NOTES ARE HARD-DELETED. `notes_select_by_visibility` reads a
--     private note to its owner alone; the account's deletion sets
--     `owner_user_id` to null by the foreign key, and a private note with a
--     null owner is READABLE BY NOBODY AND STILL STORED for ever. Nulling is
--     not erasure, it is burial. A COMPANY note is the workspace's and stays,
--     with its author nulled -- which is what the sixth requirement means by
--     "a member's departure is not the workspace's erasure".
--  5  THE REGISTER AND ITS NOTES ARE RE-POINTED AND CLEARED (Q158, CHANGED).
--     Before the re-point loop, because both tables carry guards that had to
--     be re-issued to admit exactly this and nothing else.
--  6  THE FK-LESS IDENTIFIERS. merges' owner-id snapshots, audit target ids
--     and payloads, incident alert details, rate limit counters: four places
--     holding a user id that NO foreign key protects, so the delete in step 9
--     would leave every one of them behind.
--  7  THE RE-POINT, DERIVED FROM pg_constraint. Every no-ON-DELETE reference
--     to auth.users is rewritten to the tombstone by walking the catalogue --
--     not a list, because a list written today is wrong the first time a
--     later phase adds a fourteenth.
--  8  ASSERT IT WORKED, derived the same way. A guard that refused one of
--     step 7's updates fails the whole transaction here rather than at the
--     foreign key, with a sentence naming the column.
--  8b Q131's NARROW CASE: a workspace this person was the last Owner of, with
--     no other member and nothing in it, goes with them. Leaving an ownerless
--     empty shell is the thing Q131 exists to prevent.
--  9  DELETE THE auth.users ROW. Every cascade and every ON DELETE SET NULL
--     runs, at `origin`.
-- 10  ASSERT AGAIN over EVERY foreign key, not just the blocking ones.
-- 11  ONE SUMMARY AUDIT ROW, counts only, actor = the tombstone (the person
--     who would otherwise be the actor no longer exists).
--
-- ALL-OR-NOTHING: every step is in the caller's transaction. Any raise rolls
-- the whole thing back, and the runner records the job `failed` with the
-- reason in a SEPARATE transaction. There is no partial erasure.
--
-- ===========================================================================
-- WHAT IT DOES NOT DO, ON PURPOSE
-- ===========================================================================
--  * It does not delete another tenant's rows. Nothing here is keyed on an
--    organisation; every statement is keyed on the subject's user id, and
--    step 8b is the one exception, which requires the workspace to be the
--    person's own, solo and empty.
--  * It does not delete a workspace's CRM records because a member left
--    (Q132). Contacts, artists, events, documents and finances belong to the
--    business, which is their controller. The member's OWNERSHIP of them goes
--    (the foreign keys' ON DELETE SET NULL); the records stay.
--  * It does not delete audit or financial records. `audit_events` is
--    pseudonymised; `financial_entries.created_by` goes null by the foreign
--    key and the entry itself is untouched inside its 7-year retention.
--  * It does not delete the CONSENT ledger deliberately, it lets the shipped
--    ON DELETE CASCADE take it -- and that is a DEPARTURE from Q158's
--    treatment of the register, with a measured reason rather than a
--    preference. `public.consents` is an ALTERNATING CHAIN per (user,
--    purpose): `private.consents_before_insert()` refuses a grant on a
--    granted chain and a withdrawal on a withdrawn one, and
--    `consents_withdraws_id_key` makes each withdrawal name exactly one
--    grant. Re-pointing two erased people's ledgers at ONE tombstone
--    interleaves two chains into one and produces a history that the table's
--    own rules say cannot exist -- two consecutive grants, or two withdrawals
--    of the same state -- so the "evidence a lawful basis existed" would be
--    evidence of nothing, about nobody. The register has no such invariant,
--    which is why it can be kept and this cannot. Q173 puts it to counsel.
--
-- ADDITIVE. No previously applied migration is edited. Both re-issued
-- functions are rebuilt from their LATEST definitions.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE Q131 LAST-OWNER GUARD.
--
--    Refused, with a sentence saying what to do first. The workspaces are
--    returned as rows rather than as a boolean so the page, the action and
--    the refusal can all name them.
-- ---------------------------------------------------------------------------

create or replace function private.account_last_owner_workspaces(p_user_id uuid)
returns table (organisation_id uuid, organisation_name text, slug text,
               other_members bigint, is_empty boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.slug,
         (select pg_catalog.count(*) from public.organisation_memberships m2
           where m2.organisation_id = o.id and m2.user_id <> p_user_id),
         private.organisation_is_empty(o.id)
    from public.organisation_memberships m
    join public.organisations o on o.id = m.organisation_id
   where m.user_id = p_user_id
     and m.role = 'owner'
     and m.status = 'active'
     and o.deleted_at is null
     -- ... and nobody else is an active Owner of it.
     and not exists (
       select 1 from public.organisation_memberships m3
        where m3.organisation_id = o.id
          and m3.user_id <> p_user_id
          and m3.role = 'owner'
          and m3.status = 'active')
   order by o.name
$$;

comment on function private.account_last_owner_workspaces(uuid) is
  'The workspaces this person is the LAST ACTIVE OWNER of, with how many other members each has and whether it holds any records. Q131: one with other members or data BLOCKS the erasure (transfer ownership or close the workspace first); one with neither goes WITH the account, because leaving an empty ownerless shell nobody can manage or delete is the outcome Q131 exists to prevent. A workspace that is already closed is not listed at all -- it is already on Task 6''s 60-day clock.';

create or replace function private.account_erasure_blockers(p_user_id uuid)
returns table (organisation_id uuid, organisation_name text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.organisation_id, w.organisation_name,
         case when w.other_members > 0 then 'other_members' else 'workspace_has_data' end
    from private.account_last_owner_workspaces(p_user_id) w
   where w.other_members > 0 or not w.is_empty
$$;

create or replace function private.assert_account_is_erasable(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_names text;
begin
  select pg_catalog.string_agg(b.organisation_name, ', ' order by b.organisation_name)
    into v_names
    from private.account_erasure_blockers(p_user_id) b;

  if v_names is not null then
    raise exception 'This account is the last owner of %. Make somebody else an owner there, or close the workspace, and then ask again.', v_names
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;
end;
$$;

comment on function private.assert_account_is_erasable(uuid) is
  'Q131, ENFORCED IN THE DATABASE and not only in the UI: raises 22023 with hint `last_owner_of_workspace` and a sentence naming the workspaces and saying what to do first. Called twice -- at the insert of the erasure job, so the refusal reaches the person while they are still on the page, and again inside private.erase_account(), which is the enforcement, because a workspace can lose its other Owner between the two.';

revoke all on function private.account_last_owner_workspaces(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_erasure_blockers(uuid) from public, anon, authenticated, service_role;
revoke all on function private.assert_account_is_erasable(uuid) from public, anon, authenticated, service_role;
-- The /account page has to be able to SHOW the person what will happen. The
-- read is about the CALLER and nobody else -- the function takes an argument,
-- so the wrapper below is what binds it to auth.uid().
create or replace function public.my_erasure_blockers()
returns table (organisation_name text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.organisation_name, b.reason
    from private.account_erasure_blockers((select auth.uid())) b
   where (select auth.uid()) is not null
$$;

comment on function public.my_erasure_blockers() is
  'What would stop THE CALLER erasing their own account, for the /account/erase page to render before anything is asked for. It takes no argument and reads private.account_erasure_blockers(auth.uid()), so it cannot be pointed at anybody else; a signed-out caller gets no rows rather than an error. Seeing the answer early is the difference between "we cannot do this and here is why" and a job that fails minutes later.';

revoke all on function public.my_erasure_blockers() from public, anon, service_role;
grant execute on function public.my_erasure_blockers() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE TWO GUARDS THAT HAVE TO LEARN ABOUT ERASURE.
--
--    Both are rebuilt from their LATEST definitions and both gain ONE branch,
--    admitted only from a sessionless server role AND only while an erasure
--    job for exactly that subject is `running`. That interlock is not a GUC:
--    a custom GUC is PGC_USERSET and a direct session could set it, whereas
--    no client role can insert or advance an erasure job at all.
-- ---------------------------------------------------------------------------

-- 20260925001000 § 2 is the latest definition of this one. The only change is
-- the UPDATE branch, which used to refuse every update unconditionally.
create or replace function private.data_subject_request_notes_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role text := coalesce(pg_catalog.current_setting('role', true), '');
begin
  if tg_op = 'UPDATE' then
    -- THE ONE ADMITTED UPDATE (Phase 8 Task 5): an erasure re-pointing the
    -- author at the Q130 tombstone. Nothing else may move, it must come from
    -- a sessionless server role, and an erasure job for the outgoing author
    -- must be running -- so this is unreachable from any client session and
    -- unreachable even from `postgres` unless a real erasure is in flight.
    if new.author_user_id = private.erased_user_id()
       and old.author_user_id is distinct from private.erased_user_id()
       and new.id is not distinct from old.id
       and new.request_id is not distinct from old.request_id
       and new.body is not distinct from old.body
       and new.created_at is not distinct from old.created_at
       and v_uid is null
       and v_role in ('postgres', 'service_role', 'none', '')
       and exists (select 1 from public.erasure_jobs j
                    where j.kind = 'account'
                      and j.subject_user_id = old.author_user_id
                      and j.status = 'running') then
      return new;
    end if;
    raise exception 'data_subject_request_notes: a note is append-only -- add another'
      using errcode = '42501', hint = 'note_is_append_only';
  end if;
  -- DELETE. Depth 1 is a DELETE statement (from any role, or any function).
  -- Depth >= 2 is a trigger's DELETE -- allowed only when it is the cascade
  -- from the note's own request being deleted, i.e. that request is already
  -- gone. A trigger deleting the notes of a request that still exists is
  -- refused.
  if pg_catalog.pg_trigger_depth() < 2
     or exists (select 1 from public.data_subject_requests d where d.id = old.request_id) then
    raise exception 'data_subject_request_notes: a note goes only with the request it belongs to'
      using errcode = '42501', hint = 'note_outlives_nothing_but_its_request';
  end if;
  return old;
end;
$$;

comment on function private.data_subject_request_notes_guard() is
  'BEFORE DELETE OR UPDATE on public.data_subject_request_notes (rebuilt in 20260930003000 from 20260925001000 § 2). A note is still append-only and still goes only with its own request. ONE update is admitted, added by Phase 8 Task 5: re-pointing author_user_id at the Q130 tombstone, with every other column identical, from a sessionless server role, and only while an erasure job for that author is `running`. The running-job interlock rather than a GUC, because a custom GUC is PGC_USERSET and a direct session could set one; no client role can insert or advance an erasure job at all. Without this branch the author_user_id foreign key -- an eighth no-ON-DELETE reference to auth.users, added by Task 3 -- would make the founder''s own account undeletable for ever.';


-- 20260927003000 § 2 is the latest definition of this one. The only change is
-- the anonymisation branch, inserted after the seam test and before the
-- immutability test that would otherwise refuse it.
create or replace function private.data_subject_requests_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_is_owner   boolean := v_uid is not null and old.user_id = v_uid;
  v_operator   boolean := (select private.has_platform_permission('oversee_data_subject_requests'));
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), 'none');
  v_server_session boolean;
  v_required   text;
  v_name       text;
  v_seam_moved boolean;
  v_rest_moved boolean;
begin
  v_server_session := v_uid is null
                      and v_session_role in ('postgres', 'service_role', 'none', '');

  -- (-1) THE ERASURE ANONYMISATION (Q158, CHANGED to keep-the-row).
  -- The register row is the evidence that a statutory deadline was met, and
  -- the request most likely to be asked about later is the one that ASKED for
  -- the erasure -- so it is kept, re-pointed at the Q130 tombstone, with the
  -- three free-text/identifying columns replaced by a sentinel. `[erased]`
  -- rather than null because user_email and detail are NOT NULL, detail has a
  -- length >= 1 CHECK, and a rejected row must keep a non-null reason.
  --
  -- Admitted only from a sessionless server role AND only while an erasure
  -- job for exactly this requester is `running`, and only when NOTHING else
  -- moves. This branch is what makes the account deletable at all: user_id
  -- has no ON DELETE action (20260925000000 § 2) precisely so the cascade
  -- cannot destroy the row, which means something has to move it by hand.
  if new.user_id = private.erased_user_id()
     and old.user_id is distinct from private.erased_user_id() then
    if not v_server_session then
      raise exception 'data_subject_requests: only the erasure job anonymises a register row'
        using errcode = '42501', hint = 'erasure_anonymisation_is_server_only';
    end if;
    if not exists (select 1 from public.erasure_jobs j
                    where j.kind = 'account'
                      and j.subject_user_id = old.user_id
                      and j.status = 'running') then
      raise exception 'data_subject_requests: no erasure of that account is in flight'
        using errcode = '42501', hint = 'no_erasure_in_flight';
    end if;
    if new.user_email is distinct from '[erased]'
       or new.detail is distinct from '[erased]'
       or (old.rejection_reason is not null and new.rejection_reason is distinct from '[erased]')
       or (old.rejection_reason is null and new.rejection_reason is not null) then
      raise exception 'data_subject_requests: an anonymisation clears the email, the detail and the reason, and writes nothing else'
        using errcode = '22023', hint = 'anonymisation_shape';
    end if;
    if new.id is distinct from old.id
       or new.seq is distinct from old.seq
       or new.right_type is distinct from old.right_type
       or new.subject_scope is distinct from old.subject_scope
       or new.status is distinct from old.status
       or new.requested_at is distinct from old.requested_at
       or new.fulfilled_at is distinct from old.fulfilled_at
       or new.rejected_at is distinct from old.rejected_at
       or new.withdrawn_at is distinct from old.withdrawn_at
       or new.routed_at is distinct from old.routed_at
       or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id
       or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name
       or new.fulfilment_kind is distinct from old.fulfilment_kind
       or new.fulfilment_reference is distinct from old.fulfilment_reference
       or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at then
      raise exception 'data_subject_requests: an anonymisation changes who it was about, and nothing about what happened'
        using errcode = '22023', hint = 'anonymisation_shape';
    end if;
    return new;
  end if;

  v_seam_moved :=
       new.fulfilment_kind        is distinct from old.fulfilment_kind
    or new.fulfilment_reference   is distinct from old.fulfilment_reference
    or new.fulfilment_recorded_at is distinct from old.fulfilment_recorded_at;

  v_rest_moved :=
       new.fulfilled_at     is distinct from old.fulfilled_at
    or new.rejected_at      is distinct from old.rejected_at
    or new.withdrawn_at     is distinct from old.withdrawn_at
    or new.rejection_reason is distinct from old.rejection_reason
    or new.routed_at        is distinct from old.routed_at
    or new.routed_to_organisation_name is distinct from old.routed_to_organisation_name;

  if v_seam_moved and not v_server_session then
    raise exception 'data_subject_requests: the fulfilment record is written by the server-side job, never from a person''s session'
      using errcode = '42501', hint = 'fulfilment_seam_is_server_only';
  end if;

  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.user_id is distinct from old.user_id
     or new.user_email is distinct from old.user_email
     or new.right_type is distinct from old.right_type
     or new.subject_scope is distinct from old.subject_scope
     or new.detail is distinct from old.detail
     or new.requested_at is distinct from old.requested_at then
    raise exception 'data_subject_requests: the request itself is immutable -- only its state and its outcome may change'
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    if old.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is null
       and not v_seam_moved
       and not v_rest_moved
       and pg_catalog.pg_trigger_depth() >= 2
       and not exists (select 1 from public.organisations o
                        where o.id = old.routed_to_organisation_id) then
      return new;
    end if;

    if v_seam_moved then
      if v_rest_moved
         or new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
        raise exception 'data_subject_requests: recording a fulfilment changes the fulfilment record and nothing else'
          using errcode = '42501', hint = 'seam_write_moves_only_the_seam';
      end if;
      if old.status in ('fulfilled', 'rejected', 'withdrawn') then
        raise exception 'data_subject_requests: a closed request is not rewritten, its fulfilment record included'
          using errcode = '22023', hint = 'request_is_closed';
      end if;
      select r.fulfilment_kind into v_required
        from private.dsr_rights() r where r.right_type = old.right_type;
      if old.subject_scope <> 'account'
         or v_required is null
         or new.fulfilment_kind is distinct from v_required
         or new.fulfilment_reference is null then
        raise exception 'data_subject_requests: a % request about % is not fulfilled by %',
          old.right_type, old.subject_scope, coalesce(new.fulfilment_kind, 'nothing')
          using errcode = '22023', hint = 'fulfilment_kind_mismatch';
      end if;
      new.fulfilment_recorded_at := pg_catalog.now();
      return new;
    end if;

    if old.status = 'routed'
       and new.routed_to_organisation_id is not null
       and new.routed_to_organisation_id is distinct from old.routed_to_organisation_id then
      if not v_operator then
        raise exception 'data_subject_requests: only the platform operator may progress a request'
          using errcode = '42501';
      end if;
      select o.name into v_name from public.organisations o
       where o.id = new.routed_to_organisation_id;
      if not found then
        raise exception 'data_subject_requests: there is no such workspace to route to'
          using errcode = '22023', hint = 'unknown_workspace';
      end if;
      new.fulfilled_at     := old.fulfilled_at;
      new.rejected_at      := old.rejected_at;
      new.withdrawn_at     := old.withdrawn_at;
      new.rejection_reason := old.rejection_reason;
      new.routed_at        := pg_catalog.now();
      new.routed_to_organisation_name := v_name;
      return new;
    end if;

    raise exception 'data_subject_requests: % is not a transition', old.status
      using errcode = '22023', hint = 'not_a_transition';
  end if;

  if not private.dsr_transition_allowed(old.status, new.status) then
    raise exception 'data_subject_requests: a request cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_transition';
  end if;

  if new.status = 'withdrawn' then
    if not v_is_owner then
      raise exception 'data_subject_requests: only the person who made a request may withdraw it'
        using errcode = '42501';
    end if;
  elsif not v_operator then
    raise exception 'data_subject_requests: only the platform operator may progress a request'
      using errcode = '42501';
  end if;

  new.fulfilled_at := case when new.status = 'fulfilled' then pg_catalog.now() end;
  new.rejected_at  := case when new.status = 'rejected'  then pg_catalog.now() end;
  new.withdrawn_at := case when new.status = 'withdrawn' then pg_catalog.now() end;

  if new.status <> 'rejected' then
    new.rejection_reason := null;
  elsif new.rejection_reason is null or pg_catalog.btrim(new.rejection_reason) = '' then
    raise exception 'data_subject_requests: a refusal must say why -- the requester is shown this'
      using errcode = '22023', hint = 'rejection_needs_reason';
  else
    new.rejection_reason := pg_catalog.btrim(new.rejection_reason);
  end if;

  if new.status = 'routed' then
    if old.subject_scope <> 'workspace_records' then
      raise exception 'data_subject_requests: only a request about a workspace''s own records can be routed to that workspace'
        using errcode = '22023', hint = 'not_a_processor_request';
    end if;
    if new.routed_to_organisation_id is null then
      raise exception 'data_subject_requests: routing must name the workspace it goes to'
        using errcode = '22023', hint = 'routing_needs_workspace';
    end if;
    select o.name into v_name from public.organisations o
     where o.id = new.routed_to_organisation_id;
    if not found then
      raise exception 'data_subject_requests: there is no such workspace to route to'
        using errcode = '22023', hint = 'unknown_workspace';
    end if;
    new.routed_at := pg_catalog.now();
    new.routed_to_organisation_name := v_name;
  else
    new.routed_at := old.routed_at;
    new.routed_to_organisation_id   := old.routed_to_organisation_id;
    new.routed_to_organisation_name := old.routed_to_organisation_name;
  end if;

  if new.status = 'fulfilled' and old.subject_scope = 'account' then
    select r.fulfilment_kind into v_required
      from private.dsr_rights() r where r.right_type = old.right_type;
    if v_required is not null
       and private.dsr_fulfilment_job_ready(v_required)
       and (new.fulfilment_kind is distinct from v_required
            or new.fulfilment_recorded_at is null) then
      raise exception 'data_subject_requests: a % request cannot be marked fulfilled until the % has actually run',
        old.right_type, v_required
        using errcode = '22023', hint = 'fulfilment_not_recorded';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.data_subject_requests_before_update() is
  'BEFORE UPDATE on public.data_subject_requests, for EVERY writer (rebuilt in 20260930003000 from 20260927003000 § 2). Everything that migration described is unchanged. ONE branch is added, ahead of the immutability test that would otherwise refuse it: THE ERASURE ANONYMISATION (Q158 as changed). Re-pointing user_id at the Q130 tombstone, with user_email, detail and any rejection reason replaced by `[erased]` and every other column identical, is admitted only from a sessionless server role (42501, hint erasure_anonymisation_is_server_only) and only while an erasure job for exactly that requester is `running` (42501, hint no_erasure_in_flight); any other shape is 22023, hint anonymisation_shape. user_id has NO ON DELETE action precisely so the account''s deletion cannot take the row, which means something has to move it deliberately -- this is that something, and nothing else in the schema can reach it.';


-- ---------------------------------------------------------------------------
-- 3. THE CHOKEPOINT.
-- ---------------------------------------------------------------------------

create or replace function private.erase_account(p_user_id uuid, p_job_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tomb    uuid := private.erased_user_id();
  v_counts  jsonb := '{}'::jsonb;
  v_n       bigint;
  v_total   bigint := 0;
  v_rec     record;
  v_org     record;
  v_multi   text;
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

  -- (1) IDEMPOTENCE ---------------------------------------------------------
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) Q131 ----------------------------------------------------------------
  perform private.assert_account_is_erasable(p_user_id);

  -- (3) THE BYTES -----------------------------------------------------------
  select count(*) into v_n
    from storage.objects o
   where (o.bucket_id = 'feedback-screenshots'
          and o.name in (select 'feedback/' || f.id::text
                           from public.feedback f where f.user_id = p_user_id))
      or (o.bucket_id = 'exports'
          and o.name in (select j.storage_key from public.export_jobs j
                          where j.requested_by = p_user_id and j.storage_key is not null));
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

  update public.data_subject_request_notes t
     set author_user_id = v_tomb
   where t.author_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('data_subject_request_notes', v_n);

  -- (6) THE IDENTIFIERS NO FOREIGN KEY PROTECTS -----------------------------
  -- 6a. merges / merge_candidates owner-id SNAPSHOTS. Plain uuid columns with
  --     no foreign key, so step 9's delete would leave them naming a person
  --     who no longer exists -- a stable identifier surviving erasure, which
  --     is the one thing pseudonymisation must not produce.
  update public.merges m
     set winner_owner_user_id = case when m.winner_owner_user_id = p_user_id then null
                                     else m.winner_owner_user_id end,
         loser_owner_user_id  = case when m.loser_owner_user_id = p_user_id then null
                                     else m.loser_owner_user_id end
   where m.winner_owner_user_id = p_user_id or m.loser_owner_user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('merges.owner_snapshots', v_n);

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

  -- 6d. RATE LIMIT COUNTERS. Enforcement state about a person who will not be
  --     making any more requests. Deleted rather than re-pointed: rolling an
  --     erased account's spent budget onto the tombstone would throttle the
  --     next one (Q110 leaves the general sweep to Task 6; this is the
  --     subject-scoped part of it).
  delete from public.rate_limit_counters c
   where c.subject_scope = 'user' and c.subject_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('rate_limit_counters', v_n);

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
$$;

comment on function private.erase_account(uuid, uuid) is
  'THE ACCOUNT ERASURE CHOKEPOINT (Phase 8 Task 5, Q130/Q131/Q158). One transaction, one fixed order, all-or-nothing -- any raise rolls the whole thing back and the runner records the job failed in a separate transaction; there is no partial erasure. IDEMPOTENT: an account that is already gone returns {"already_erased": true}. It refuses the tombstone itself, refuses to run under any session_replication_role but `origin`, refuses while a byte of the account''s feedback screenshots or export archives is still in its bucket, and refuses when the person is the last Owner of a workspace with other members or data (Q131). It HARD-DELETES the account''s private notes -- nulling the owner of one leaves it readable by nobody and stored for ever -- keeps company notes with a nulled author, anonymises the data subject register and its notes onto the Q130 tombstone, clears the four identifier stores no foreign key protects (merges'' owner snapshots, audit target ids and payloads, incident alert details, rate limit counters), and then re-points every no-ON-DELETE reference to auth.users at the tombstone BY WALKING pg_constraint rather than by a list -- asserting first that no COMPOSITE such key exists, because the walk could not see one, and asserting afterwards, twice, that not one reference of any kind still names the account. A workspace the person was the last Owner of with no other member and nothing in it goes with them (Q131''s narrow case). The summary is ONE audit row of counts, actor = the tombstone.';

revoke all on function private.erase_account(uuid, uuid) from public, anon, authenticated, service_role;
