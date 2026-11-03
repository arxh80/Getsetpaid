-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- M1: THE AUDIT PAYLOADS OF THE ROWS THE
-- ERASED PERSON WAS THE ACTOR ON.
--
-- /legal/data-subject-rights version 5 says, of the security audit record:
--
--     "We keep what happened and remove who did it: every entry of yours is
--      re-pointed at a single shared 'erased user' identity ... and any
--      description of the change is dropped."
--
-- As shipped, `before`/`after` were nulled only where the subject was the
-- TARGET (step 6b). On the rows where they were the ACTOR -- which is what
-- "every entry of yours" means to a reader -- step 7 re-pointed
-- actor_user_id and left the payloads exactly as they were. Nothing
-- identifying survives TODAY (no audit writer puts a person's identifier in
-- those payloads, and private.audit_crm_payload() projects a CRM row down to
-- ids and changed column NAMES), but the page states a property the code did
-- not enforce, and one payload change would make it false in silence -- the
-- same shape as C1.
--
-- TWO WAYS TO CLOSE IT: make the sentence true, or soften the sentence in a
-- version 6. This takes the first, because it is the one that errs toward the
-- data subject, and because a published legal version is immutable -- so the
-- weaker promise would have to be published and could not be withdrawn.
-- What is kept is what the page also promises: the action, the target, the
-- timestamp and the correlation thread. What goes is the CHANGED-COLUMN
-- DESCRIPTION of writes that person made, which is a cost to the workspace's
-- own record of its history and is stated in Q177 rather than implied.
--
-- ADDITIVE. private.erase_account() is rebuilt from its LATEST definition
-- (20261001001000); the only change is step 6e.
-- ===========================================================================

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
  'THE ACCOUNT ERASURE CHOKEPOINT (Phase 8 Task 5, Q130/Q131/Q158). One transaction, one fixed order, all-or-nothing -- any raise rolls the whole thing back and the runner records the job failed in a separate transaction; there is no partial erasure. IDEMPOTENT: an account that is already gone returns {"already_erased": true}. It refuses the tombstone itself, refuses to run under any session_replication_role but `origin`, refuses while a byte of the account''s feedback screenshots or export archives is still in its bucket, and refuses when the person is the last Owner of a workspace with other members or data (Q131). It HARD-DELETES the account''s private notes -- nulling the owner of one leaves it readable by nobody and stored for ever -- keeps company notes with a nulled author, anonymises the data subject register and its notes onto the Q130 tombstone, clears the identifier stores no foreign key protects -- since fix round 1 (C1) by RUNNING private.fkless_identifier_columns(), the pinned roll that private.assert_fkless_identifier_roll() makes the catalogue agree with at step 0, plus the one column the roll marks handled_explicitly (audit_events.target_id, re-pointed WITH its before/after payload dropped) and incident_alerts.details, which is jsonb rather than a uuid column and is rewritten whole -- and then re-points every no-ON-DELETE reference to auth.users at the tombstone BY WALKING pg_constraint rather than by a list -- asserting first that no COMPOSITE such key exists, because the walk could not see one, and asserting afterwards, twice, that not one reference of any kind still names the account. A workspace the person was the last Owner of with no other member and nothing in it goes with them (Q131''s narrow case). The summary is ONE audit row of counts, actor = the tombstone. It also DROPS the before/after payload of every audit row the person was the ACTOR on (M1), which is what /legal/data-subject-rights v5 promises and step 6b did only for rows that TARGETED them. SINCE FIX ROUND 1 (C2) the Q131 guard runs UNDER A LOCK -- private.account_lock_workspaces() takes an advisory transaction lock and FOR UPDATE on the membership rows of every live workspace the subject is an active member of -- and step 9b re-asserts after the delete that not one of those workspaces has been left with no active Owner, so two concurrent erasures of two co-Owners end as one success and one rollback rather than as a live workspace with records in it and nobody in it.';

revoke all on function private.erase_account(uuid, uuid) from public, anon, authenticated, service_role;
