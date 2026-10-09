-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- C2 AND I1: A WORKSPACE MAY NOT BE LEFT
-- WITH NO OWNER, BY EITHER ROUTE.
--
-- Q131 says: do not strand a workspace. As shipped, the guard asked a
-- narrower question -- "is this person the last OWNER" -- and asked it without
-- a lock. Two supported routes reached the outcome Q131 exists to prevent:
--
--   C2  TWO CONCURRENT ERASURES. private.erase_account() read the memberships
--       (step 2) and deleted them by cascade (step 9) with no lock in
--       between, so two co-Owners of one workspace both passed the guard and
--       both committed: members 0, owners 0, one CRM row, workspace live.
--       Reproduced with two psql sessions. One second apart the loser is
--       correctly refused, so the guard was right and only its atomicity was
--       wrong -- which is why a single-session psql suite could not see it.
--       It is reachable in the product: claim_erasure_job() uses
--       `for update skip locked`, so two runners take DIFFERENT jobs.
--
--   I1  AN ADMIN DEMOTING THE SOLE OWNER. An Admin at aal2 holds
--       manage_members and there was NO last-owner guard anywhere on
--       public.organisation_memberships. With zero owners the erasure guard
--       stopped firing for everybody, and the remaining members could erase
--       themselves one by one.
--
-- THE FIX, in three parts (Q176's recommended default):
--
--   1. RE-FOUND THE QUESTION. private.account_last_owner_workspaces() now
--      lists every LIVE workspace the subject is an ACTIVE MEMBER of that
--      would be left with no active Owner -- which subsumes the old
--      behaviour (an Owner is a member) and closes the demotion route.
--   2. LOCK BEFORE YOU READ. private.account_lock_workspaces() takes a
--      transaction-scoped advisory lock per candidate workspace, in id order
--      so two erasures cannot deadlock, and FOR UPDATE on that workspace's
--      membership rows -- so a concurrent erasure OR a concurrent demotion
--      waits and then re-reads, rather than both passing. Plus a POST-DELETE
--      assertion (step 9b) that every live workspace the subject was an
--      active member of still has an active Owner: the loser of a race that
--      got past the lock becomes a rollback, not a stranded workspace.
--      Belt and braces, deliberately: the lock is the fix and the assertion
--      is the proof it held.
--   3. ASK IT AT THE MEMBERSHIP TOO. private.membership_keeps_an_owner() is a
--      BEFORE UPDATE OR DELETE trigger on public.organisation_memberships --
--      the chokepoint every writer passes, policies and RPCs alike -- so
--      demotion, removal and leaving are all refused when they would leave a
--      live workspace that still has people or records in it with no Owner.
--      It admits the two cascades that are not a demotion: the workspace
--      itself being deleted, and the account itself being deleted (where the
--      chokepoint's own Q131 guard has already decided).
--
-- ADDITIVE. Every function is rebuilt from its LATEST definition
-- (20261001000000 for erase_account, 20260930003000 for the other two).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE QUESTION, RE-FOUNDED (I1).
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
     -- ANY active membership, not only an Owner's (I1): the question is
     -- whether this workspace is left with nobody who can manage it, and an
     -- Admin can already have demoted the last Owner before we are asked.
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
  'The live workspaces this person''s departure would leave WITH NO ACTIVE OWNER, with how many other members each has and whether it holds any records. Re-founded in fix round 1 (I1/Q176) from "workspaces this person is the last active Owner of": an Admin at aal2 can demote the sole Owner, and the old wording made the guard stop firing for everybody the moment that happened -- after which the remaining members could erase themselves one by one and leave a live workspace with records in it, no members and no route back. Q131: one with other members or data BLOCKS the erasure (transfer ownership or close the workspace first); one with neither goes WITH the account, because leaving an empty shell nobody can manage or delete is the outcome Q131 exists to prevent. A workspace that is already closed is not listed at all -- it is already on Task 6''s 60-day clock.';

revoke all on function private.account_last_owner_workspaces(uuid) from public, anon, authenticated, service_role;


-- The sentence changes with the question. It still names the workspaces and
-- still says what to do first, which is what Q131 asks of it.
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
    raise exception 'Deleting this account would leave % with no owner. Make somebody else an owner there, or close the workspace, and then ask again.', v_names
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;
end;
$$;

comment on function private.assert_account_is_erasable(uuid) is
  'Q131, ENFORCED IN THE DATABASE and not only in the UI: raises 22023 with hint `last_owner_of_workspace` and a sentence naming the workspaces and saying what to do first. Called twice -- at the insert of the erasure job, so the refusal reaches the person while they are still on the page, and again inside private.erase_account(), which is the enforcement, because a workspace can lose its other Owner between the two. Since fix round 1 the question behind it is "would this leave the workspace with no active OWNER" rather than "is this person the last owner" (I1/Q176).';

revoke all on function private.assert_account_is_erasable(uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE LOCK (C2).
--
--    Taken over EVERY live workspace the subject is an active member of, not
--    only the ones that block -- because in the race neither co-Owner is the
--    last Owner at the moment they read, and a lock taken only over the
--    workspaces that already block is a lock taken exactly where it is not
--    needed. In workspace-id order, so two erasures queue rather than
--    deadlock; FOR UPDATE on the membership rows as well as the advisory
--    lock, so a concurrent DEMOTION blocks too and not only another erasure.
-- ---------------------------------------------------------------------------

create or replace function private.account_lock_workspaces(p_user_id uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_n   bigint := 0;
begin
  for v_org in
    select distinct m.organisation_id
      from public.organisation_memberships m
      join public.organisations o on o.id = m.organisation_id
     where m.user_id = p_user_id
       and m.status = 'active'
       and o.deleted_at is null
     order by 1
  loop
    -- Two keys rather than one hash of a concatenation: the first names the
    -- lock space so this cannot collide with another feature's advisory lock.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('private.erase_account'), pg_catalog.hashtext(v_org::text));
    perform 1 from public.organisation_memberships m
      where m.organisation_id = v_org
      for update;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

comment on function private.account_lock_workspaces(uuid) is
  'C2: locks every live workspace this person is an active member of, before the Q131 guard reads them -- an advisory transaction lock per workspace (in id order, so two erasures queue instead of deadlocking) and FOR UPDATE on that workspace''s membership rows, so a concurrent DEMOTION blocks as well as a concurrent erasure. Without it two erasures of two co-Owners both passed the guard and both committed, leaving a live workspace with a record in it, no members and no owner -- reproduced with two psql sessions, and reachable in the product because claim_erasure_job() hands two runners two different jobs.';

revoke all on function private.account_lock_workspaces(uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE SAME QUESTION AT THE MEMBERSHIP (I1).
--
--    Asked DIRECTLY, at the table, not through an RPC that carries its own
--    guard: the demotion route reached the table through
--    `organisation_memberships_update_manage_members`, which is a policy and
--    not a rule about owners.
-- ---------------------------------------------------------------------------

create or replace function private.membership_keeps_an_owner()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  -- Only the loss of an ACTIVE OWNER can leave a workspace ownerless.
  if not (old.role = 'owner' and old.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and new.role = 'owner' and new.status = 'active'
     and new.organisation_id = old.organisation_id
     and new.user_id = old.user_id then
    return new;
  end if;

  -- THE TWO CASCADES THIS IS NOT ABOUT.
  --  * the workspace itself is being deleted (the parent row goes first, so
  --    it is already absent here);
  --  * the ACCOUNT itself is being deleted, where private.erase_account()'s
  --    own Q131 guard -- locked, and asserted again after the delete -- has
  --    already decided. Asking twice here would refuse the one path that is
  --    allowed to take the last Owner with it.
  select o.name into v_name
    from public.organisations o
   where o.id = old.organisation_id and o.deleted_at is null;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;

  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id
                and m.role = 'owner'
                and m.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- No other active Owner. An empty workspace with nobody else in it is
  -- allowed to end this way -- there is nothing to strand.
  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id)
     or not private.organisation_is_empty(old.organisation_id) then
    raise exception 'That would leave % with no owner. Make somebody else an owner there first.', v_name
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.membership_keeps_an_owner() is
  'BEFORE UPDATE OR DELETE on public.organisation_memberships (Phase 8 Task 5 fix round 1, I1/Q176). Refuses any change that would leave a LIVE workspace which still has other members or records in it with no active Owner -- demotion, suspension of the Owner''s membership, removal and leaving alike -- with 22023 / last_owner_of_workspace and a sentence naming the workspace. Before it there was no last-owner guard anywhere on this table, so an Admin at aal2 holding manage_members could demote the sole Owner, after which the erasure guard (keyed on the word "owner") stopped firing for everybody. It admits exactly two cascades: the workspace being deleted, and the ACCOUNT being deleted, where private.erase_account() has already asked the same question under a lock and asserts it again after the delete.';

create trigger membership_keeps_an_owner
  before update or delete on public.organisation_memberships
  for each row execute function private.membership_keeps_an_owner();

comment on trigger membership_keeps_an_owner on public.organisation_memberships is
  'Q131 asked at the table every writer passes, rather than only inside the erasure (I1).';


-- ---------------------------------------------------------------------------
-- 4. THE CHOKEPOINT, REBUILT FROM ITS LATEST DEFINITION (20261001000000 s 3).
--
--    Two changes, and nothing else moves:
--      * step 2 LOCKS the workspaces before the Q131 guard reads them (C2);
--      * step 9b asserts, after the delete, that every live workspace the
--        subject was an active member of still has an active Owner -- so a
--        race that somehow got past the lock rolls back instead of stranding
--        a workspace.
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
  'THE ACCOUNT ERASURE CHOKEPOINT (Phase 8 Task 5, Q130/Q131/Q158). One transaction, one fixed order, all-or-nothing -- any raise rolls the whole thing back and the runner records the job failed in a separate transaction; there is no partial erasure. IDEMPOTENT: an account that is already gone returns {"already_erased": true}. It refuses the tombstone itself, refuses to run under any session_replication_role but `origin`, refuses while a byte of the account''s feedback screenshots or export archives is still in its bucket, and refuses when the person is the last Owner of a workspace with other members or data (Q131). It HARD-DELETES the account''s private notes -- nulling the owner of one leaves it readable by nobody and stored for ever -- keeps company notes with a nulled author, anonymises the data subject register and its notes onto the Q130 tombstone, clears the identifier stores no foreign key protects -- since fix round 1 (C1) by RUNNING private.fkless_identifier_columns(), the pinned roll that private.assert_fkless_identifier_roll() makes the catalogue agree with at step 0, plus the one column the roll marks handled_explicitly (audit_events.target_id, re-pointed WITH its before/after payload dropped) and incident_alerts.details, which is jsonb rather than a uuid column and is rewritten whole -- and then re-points every no-ON-DELETE reference to auth.users at the tombstone BY WALKING pg_constraint rather than by a list -- asserting first that no COMPOSITE such key exists, because the walk could not see one, and asserting afterwards, twice, that not one reference of any kind still names the account. A workspace the person was the last Owner of with no other member and nothing in it goes with them (Q131''s narrow case). The summary is ONE audit row of counts, actor = the tombstone. SINCE FIX ROUND 1 (C2) the Q131 guard runs UNDER A LOCK -- private.account_lock_workspaces() takes an advisory transaction lock and FOR UPDATE on the membership rows of every live workspace the subject is an active member of -- and step 9b re-asserts after the delete that not one of those workspaces has been left with no active Owner, so two concurrent erasures of two co-Owners end as one success and one rollback rather than as a live workspace with records in it and nobody in it.';

revoke all on function private.erase_account(uuid, uuid) from public, anon, authenticated, service_role;
