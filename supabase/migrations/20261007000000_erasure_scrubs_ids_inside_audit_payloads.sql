-- ===========================================================================
-- PHASE 8 TASK 7, FIX ROUND 1 -- C1: A THIRD PARTY'S USER ID INSIDE AN AUDIT
-- PAYLOAD SURVIVED A COMPLETED ERASURE.
--
-- 20261001003000's header says: "Nothing identifying survives TODAY (no
-- audit writer puts a person's identifier in those payloads ...)". The
-- Phase 2 allowlist (`owner_user_id` on five CRM targets) already strained
-- that sentence, and 20261006000000 broke it outright: its allowlist copies
-- `membership.user_id` / `.invited_by`, `owner_user_id` on events, tasks,
-- meetings, notes and documents, `created_by` on three more, and the two
-- merge-candidate owner snapshots into audit_events.before/after BY VALUE.
-- On those rows the ACTOR is the Admin or colleague and the TARGET is the
-- membership or task id -- so step 6b (target = the person) and step 6e
-- (actor = the person) both miss them, and every invited member of every
-- workspace had at least one such row naming them after they were erased.
-- Reproduced before this migration (the reviewer's O1): an Admin invites X
-- and reassigns a task to X, 2 payloads contain X's uuid, erase_account(X)
-- succeeds, 2 payloads still contain it.
--
-- TWO WAYS TO CLOSE IT, AND WHY THIS IS THE SECOND:
--   (a) stop copying person ids into the payload. It would make an audit row
--       of a role escalation or an invitation unable to say WHO was invited
--       or escalated, which is the reason organisation_memberships joined the
--       audit at all; it would have to be enforced against every future
--       writer (the dedicated writers, and every private.log_audit_event()
--       caller, are outside the allowlist); and it would not touch the rows
--       already written.
--   (b) extend the erasure to scrub payload VALUES. Complete regardless of
--       key, depth or writer, retroactive over every row already written,
--       and it keeps the workspace's record that its Admin invited somebody
--       -- that somebody becomes the Q130 tombstone, exactly as every
--       foreign key to them already does at step 7.
-- (b), with (a)'s concern answered by a derivation instead:
--
--   * step 6f  whole-document, case-insensitive replace of the id with the
--              tombstone in before AND after of every audit row carrying it
--              (the incident_alerts step 6c shape);
--   * step 10b after the delete, count the payloads that still contain the
--              id and REFUSE (hint identifier_survived_in_audit_payload) if
--              any does -- so a cascade that wrote one during the delete, or
--              a later rebuild that loses 6f, fails the erasure closed rather
--              than reporting a success;
--   * private.audit_payload_person_columns(), below: every (target, column)
--              the two generic writers copy BY VALUE that identifies a
--              person -- a foreign key to auth.users / public.profiles, or a
--              `user` row on the FK-less roll. rls_phase8_erasure.sql § EP
--              pins it by name, so a future allowlisted person column is red
--              by name, and plants one payload per derived row so the scrub
--              is measured on every one of them, not on two examples.
--
-- So 20261001003000's sentence is TRUE AGAIN, and enforced rather than
-- observed. That header is a plain `--` comment in an immutable migration and
-- is left as written; this header and the reissued `comment on function`
-- below are the correction of record.
--
-- COST, MEASURED (task-7-report.md § Fix round 1): 6f and 10b are two
-- sequential scans of audit_events per erasure, the same shape 6c already
-- runs over incident_alerts. An erasure is rare and runs from the
-- out-of-transaction runner, not a request path.
--
-- ADDITIVE. private.erase_account() is rebuilt from its LATEST definition
-- (20261001003000 -- nothing later redefines it); the only changes are 6f,
-- 10b, and the comment.
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
$$;

comment on function private.erase_account(uuid, uuid) is
  'THE ACCOUNT ERASURE CHOKEPOINT (Phase 8 Task 5, Q130/Q131/Q158). One transaction, one fixed order, all-or-nothing -- any raise rolls the whole thing back and the runner records the job failed in a separate transaction; there is no partial erasure. IDEMPOTENT: an account that is already gone returns {"already_erased": true}. It refuses the tombstone itself, refuses to run under any session_replication_role but `origin`, refuses while a byte of the account''s feedback screenshots or export archives is still in its bucket, and refuses when the person is the last Owner of a workspace with other members or data (Q131). It HARD-DELETES the account''s private notes -- nulling the owner of one leaves it readable by nobody and stored for ever -- keeps company notes with a nulled author, anonymises the data subject register and its notes onto the Q130 tombstone, clears the identifier stores no foreign key protects -- since fix round 1 (C1) by RUNNING private.fkless_identifier_columns(), the pinned roll that private.assert_fkless_identifier_roll() makes the catalogue agree with at step 0, plus the one column the roll marks handled_explicitly (audit_events.target_id, re-pointed WITH its before/after payload dropped) and incident_alerts.details, which is jsonb rather than a uuid column and is rewritten whole -- and then re-points every no-ON-DELETE reference to auth.users at the tombstone BY WALKING pg_constraint rather than by a list -- asserting first that no COMPOSITE such key exists, because the walk could not see one, and asserting afterwards, twice, that not one reference of any kind still names the account. A workspace the person was the last Owner of with no other member and nothing in it goes with them (Q131''s narrow case). The summary is ONE audit row of counts, actor = the tombstone. It also DROPS the before/after payload of every audit row the person was the ACTOR on (M1), which is what /legal/data-subject-rights v5 promises and step 6b did only for rows that TARGETED them. SINCE FIX ROUND 1 (C2) the Q131 guard runs UNDER A LOCK -- private.account_lock_workspaces() takes an advisory transaction lock and FOR UPDATE on the membership rows of every live workspace the subject is an active member of -- and step 9b re-asserts after the delete that not one of those workspaces has been left with no active Owner, so two concurrent erasures of two co-Owners end as one success and one rollback rather than as a live workspace with records in it and nobody in it. SINCE PHASE 8 TASK 7 FIX ROUND 1 (C1, 20261007000000) step 6f replaces the account''s id with the tombstone''s inside the before/after payload of EVERY audit row that still carries it -- the third shape, where the person is neither actor nor target (an Admin''s membership.created naming the invitee, a task.updated reassigning a task to them, a merge_candidate row naming two owners), which 20261006000000 made common and 6b/6e could not see -- and step 10b refuses the whole erasure (hint identifier_survived_in_audit_payload) if, after the delete, a single payload still contains it. So the sentence 20261001003000 wrote in its header, "nothing identifying survives", is enforced rather than observed.';

revoke all on function private.erase_account(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE DERIVED ROLL OF PERSON IDS THE GENERIC AUDIT WRITERS COPY BY VALUE.
-- Not used by the erasure (6f is value-based and needs no list); it exists so
-- that the day an allowlist entry or a payload projection starts copying a
-- column that identifies a person, a test names it. Derived from pg_trigger
-- (which tables carry private.audit_crm_change / private.audit_crm_row, and
-- with which target), from the two functions' own answers (the allowlist, and
-- the projection's keys asked with an empty row), and from pg_constraint plus
-- the FK-less roll for "identifies a person". A uuid column with neither a
-- foreign key nor a roll entry cannot exist without
-- private.assert_fkless_identifier_roll() refusing every erasure first.
-- LIMIT, STATED: the dedicated writers (private.audit_network_row() and the
-- RPCs that call private.log_audit_event() directly) build their payloads in
-- code this cannot read. 6f/10b cover them by value regardless.
-- ---------------------------------------------------------------------------
create or replace function private.audit_payload_person_columns()
returns table (
  target_type   text,
  table_name    text,
  column_name   text,
  writer        text,
  identified_by text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with trig as (
    select t.tgrelid,
           p.proname::text as writer,
           pg_catalog.string_to_array(
             pg_catalog.rtrim(pg_catalog.encode(t.tgargs, 'escape'), '\000'), '\000') as args
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal
       and p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname in ('audit_crm_change', 'audit_crm_row')
  ),
  copied as (
    -- The generic pair: the trigger's one argument is the allowlist key.
    select tr.args[1] as target_type, tr.tgrelid, v.col, tr.writer
      from trig tr
      cross join lateral pg_catalog.unnest(private.audit_crm_value_columns(tr.args[1])) v(col)
     where tr.writer = 'audit_crm_change'
    union
    -- The hard-delete / merge writer: the second argument is the payload key,
    -- and the projection's KEYS are the columns it copies -- asked of the
    -- function itself with an empty row, so nothing here restates it.
    select tr.args[2], tr.tgrelid, k.col, tr.writer
      from trig tr
      cross join lateral pg_catalog.jsonb_object_keys(
        private.audit_crm_payload(tr.args[2], '{}'::jsonb)) k(col)
     where tr.writer = 'audit_crm_row'
  )
  select c.target_type,
         c.tgrelid::pg_catalog.regclass::text,
         c.col,
         c.writer,
         (case
            when exists (
              select 1
                from pg_catalog.pg_constraint k
                join pg_catalog.pg_attribute a
                  on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
               where k.conrelid = c.tgrelid and k.contype = 'f'
                 and a.attname = c.col
                 and k.confrelid in ('auth.users'::pg_catalog.regclass,
                                     'public.profiles'::pg_catalog.regclass))
              then 'foreign_key'
            else 'fkless_roll'
          end)::text
    from copied c
   where exists (
           select 1
             from pg_catalog.pg_constraint k
             join pg_catalog.pg_attribute a
               on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
            where k.conrelid = c.tgrelid and k.contype = 'f'
              and a.attname = c.col
              and k.confrelid in ('auth.users'::pg_catalog.regclass,
                                  'public.profiles'::pg_catalog.regclass))
      or exists (
           select 1 from private.fkless_identifier_columns() r
            where r.table_name = c.tgrelid::pg_catalog.regclass::text
              and r.column_name = c.col
              and r.identifies = 'user')
   order by 1, 3
$$;

comment on function private.audit_payload_person_columns() is
  'Every (target_type, column) that private.audit_crm_change() (via private.audit_crm_value_columns()) or private.audit_crm_row() (via private.audit_crm_payload()) copies BY VALUE into audit_events.before/after and that identifies a person: a foreign key to auth.users or public.profiles, or a `user` row on private.fkless_identifier_columns(). Derived at call time from pg_trigger, the two functions'' own answers and pg_constraint. Phase 8 Task 7 fix round 1 (C1, 20261007000000): erase_account() step 6f scrubs these by value, and rls_phase8_erasure.sql § EP pins the set by name so a new one is red by name.';

revoke all on function private.audit_payload_person_columns() from public, anon, authenticated, service_role;

