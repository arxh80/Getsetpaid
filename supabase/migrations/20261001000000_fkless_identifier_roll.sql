-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- C1: THE IDENTIFIERS NO FOREIGN KEY PROTECTS,
-- DERIVED FROM A PINNED ROLL INSTEAD OF FROM A COMMENT.
--
-- 20260930003000 section 6a was headed "merges / merge_candidates owner-id
-- SNAPSHOTS ... a stable identifier surviving erasure, which is the one thing
-- pseudonymisation must not produce" -- and the statement under it updated
-- public.merges ONLY. public.merge_candidates.keep_owner_user_id and
-- .duplicate_owner_user_id are the same shape (plain uuid, NO foreign key)
-- and survived a completed erasure, silently: neither derived assertion loop
-- (steps 8 and 10) can see them, because both walk pg_constraint and these
-- columns are in no constraint at all. public.screen_for_duplicates() writes
-- both on every flagged duplicate, so this was the common case.
--
-- THE FIX IS NOT FOUR MORE LINES. A column with no foreign key is invisible
-- to every derivation in the function, so the only honest denominator is a
-- ROLL that the catalogue itself is asked to agree with:
--
--   private.fkless_identifier_columns()     the roll: every FK-less uuid
--                                           column in public/private that is
--                                           not its table's own primary key,
--                                           each one CLASSIFIED and given a
--                                           treatment.
--   private.assert_fkless_identifier_roll() the derivation: any such column
--                                           that is NOT on the roll is a hard
--                                           refusal. A later phase that adds
--                                           one cannot ship without saying
--                                           what an erasure does about it.
--
-- private.erase_account() then RUNS the roll rather than a hand-written list,
-- and refuses before it touches anything if the roll and the catalogue
-- disagree. "Handle or refuse each one" is the whole contract.
--
-- ADDITIVE. private.erase_account() is rebuilt from its LATEST definition
-- (20260930003000 section 3); the only changes are the new assertion at step
-- 0 and steps 6a/6d, which become loops over the roll.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE ROLL.
--
--    `identifies` says WHOSE identifier the column can hold:
--      user          a person -- an account erasure must deal with it
--      organisation  a workspace -- a workspace purge must deal with it
--      record        a CRM row (polymorphic entity ids, merge winner/loser)
--      polymorphic   either, depending on a sibling column
--      other         neither (a correlation id, a job id, a session id)
--
--    `treatment` says what an erasure DOES:
--      null_on_match       set null where the column names the subject
--      delete_row          delete the row (with `predicate`, if it is scoped)
--      handled_explicitly  a named step in the function does something the
--                          generic loop cannot express -- and the roll says
--                          which, so it is a decision rather than an omission
--      not_a_person        nothing: it cannot hold a person's or a
--                          workspace's identifier at all
-- ---------------------------------------------------------------------------

create or replace function private.fkless_identifier_columns()
returns table (table_name text, column_name text, identifies text,
               treatment text, predicate text, note text)
language sql
immutable
security definer
set search_path = ''
as $$
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
      ('public.merge_candidates',     'duplicate_id',         'record', 'not_a_person', null, 'the proposed duplicate')
    ) as r(table_name, column_name, identifies, treatment, predicate, note)
$$;

comment on function private.fkless_identifier_columns() is
  'THE ROLL OF UUID COLUMNS NO FOREIGN KEY PROTECTS (Phase 8 Task 5 fix round 1, C1). Every uuid column in public/private that is not its own table''s primary key and is in no foreign key, classified by WHOSE identifier it can hold and given the treatment an erasure applies. private.erase_account() and private.erase_organisation() RUN this roll instead of a hand-written list, and private.assert_fkless_identifier_roll() makes the catalogue agree with it -- because a column with no foreign key is invisible to every pg_constraint walk in both functions, which is exactly how merge_candidates'' two owner-id snapshots survived a completed erasure while the code''s own comment said they did not.';

revoke all on function private.fkless_identifier_columns() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE DERIVATION. The roll is a list; this is what stops it being stale.
-- ---------------------------------------------------------------------------

create or replace function private.unclassified_fkless_identifiers()
returns table (table_name text, column_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.oid::pg_catalog.regclass::text, a.attname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relkind in ('r', 'p')
     and n.nspname in ('public', 'private')
     and a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
     -- not part of a foreign key
     and not exists (
       select 1 from pg_catalog.pg_constraint fk
        where fk.contype = 'f' and fk.conrelid = c.oid
          and a.attnum = any (fk.conkey))
     -- not part of the table's own primary key
     and not exists (
       select 1 from pg_catalog.pg_index i
        where i.indrelid = c.oid and i.indisprimary
          and a.attnum = any (i.indkey))
     -- and not on the roll
     and not exists (
       select 1 from private.fkless_identifier_columns() r
        where r.table_name = c.oid::pg_catalog.regclass::text
          and r.column_name = a.attname::text)
   order by 1, 2
$$;

create or replace function private.assert_fkless_identifier_roll()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_missing text;
begin
  select pg_catalog.string_agg(u.table_name || '.' || u.column_name, ', '
                               order by u.table_name, u.column_name)
    into v_missing
    from private.unclassified_fkless_identifiers() u;

  if v_missing is not null then
    raise exception 'erasure: uuid column(s) with no foreign key are not classified on private.fkless_identifier_columns() (%) -- an erasure cannot see them and will not guess', v_missing
      using errcode = '55000', hint = 'unclassified_fkless_identifier';
  end if;
end;
$$;

comment on function private.unclassified_fkless_identifiers() is
  'Every uuid column in public/private that no foreign key protects, that is not its own table''s primary key, and that private.fkless_identifier_columns() does not classify. It should always be empty; private.assert_fkless_identifier_roll() is what makes an erasure refuse when it is not.';

comment on function private.assert_fkless_identifier_roll() is
  'Raises 55000 / unclassified_fkless_identifier when the catalogue has grown a uuid column no foreign key protects that the roll does not classify. Called FIRST by private.erase_account(), before it touches a row: a column the erasure cannot see is one it cannot promise anything about, so the erasure refuses rather than reporting a success that left an identifier behind. That is C1''s failure mode, made impossible rather than fixed four columns at a time.';

revoke all on function private.unclassified_fkless_identifiers() from public, anon, authenticated, service_role;
revoke all on function private.assert_fkless_identifier_roll() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE CHOKEPOINT, REBUILT FROM ITS LATEST DEFINITION (20260930003000 s 3).
--
--    Three changes, and nothing else moves:
--      * step 0 asserts the roll against the catalogue;
--      * step 6a becomes a loop over the roll's `null_on_match` user columns,
--        which is how merge_candidates' two owner-id snapshots arrive handled;
--      * step 6d becomes a loop over its `delete_row` user columns.
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
  'THE ACCOUNT ERASURE CHOKEPOINT (Phase 8 Task 5, Q130/Q131/Q158). One transaction, one fixed order, all-or-nothing -- any raise rolls the whole thing back and the runner records the job failed in a separate transaction; there is no partial erasure. IDEMPOTENT: an account that is already gone returns {"already_erased": true}. It refuses the tombstone itself, refuses to run under any session_replication_role but `origin`, refuses while a byte of the account''s feedback screenshots or export archives is still in its bucket, and refuses when the person is the last Owner of a workspace with other members or data (Q131). It HARD-DELETES the account''s private notes -- nulling the owner of one leaves it readable by nobody and stored for ever -- keeps company notes with a nulled author, anonymises the data subject register and its notes onto the Q130 tombstone, clears the identifier stores no foreign key protects -- since fix round 1 (C1) by RUNNING private.fkless_identifier_columns(), the pinned roll that private.assert_fkless_identifier_roll() makes the catalogue agree with at step 0, plus the one column the roll marks handled_explicitly (audit_events.target_id, re-pointed WITH its before/after payload dropped) and incident_alerts.details, which is jsonb rather than a uuid column and is rewritten whole -- and then re-points every no-ON-DELETE reference to auth.users at the tombstone BY WALKING pg_constraint rather than by a list -- asserting first that no COMPOSITE such key exists, because the walk could not see one, and asserting afterwards, twice, that not one reference of any kind still names the account. A workspace the person was the last Owner of with no other member and nothing in it goes with them (Q131''s narrow case). The summary is ONE audit row of counts, actor = the tombstone.';

revoke all on function private.erase_account(uuid, uuid) from public, anon, authenticated, service_role;
