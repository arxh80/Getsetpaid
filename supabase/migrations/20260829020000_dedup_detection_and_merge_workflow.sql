-- ===========================================================================
-- Phase 2 Task 6 -- duplicate detection, the review queue, and the merge.
-- ===========================================================================
-- Additive only. Nothing here edits an applied migration; every change to an
-- existing object is `alter policy`, `comment on`, a grant, or a new column.
--
-- WHAT THIS MIGRATION IS ANSWERING TO
--
-- CLAUDE.md § Domain entities: "exact matches (email/name) auto-merge; fuzzy
-- matches are flagged for manual review, never auto-merged silently. Every
-- merge is audited."
--
-- ===========================================================================
-- DECISION 1: AUTO-MERGE IS EMAIL-ONLY. NAME MATCHES NEVER AUTO-MERGE.
-- ===========================================================================
-- Founder decision, closed. Recorded here because CLAUDE.md still says
-- "email/name" and is updated when Phase 2 merges.
--
-- The measurement that makes it obvious rather than merely prudent, taken on
-- this schema before a line of this file was written:
--
--     contacts   name, email
--     companies  name
--     agencies   name
--     artists    name
--     venues     name
--
-- FOUR OF THE FIVE ENTITY TYPES HAVE NO EMAIL COLUMN AT ALL. So "exact match
-- on normalised name" is not a secondary rule for them, it is the ONLY rule --
-- and a live-events CRM is the worst possible place to apply it. Two agencies
-- called "Primary Talent", two venues called "The Social" in two cities, two
-- artists sharing a stage name: all real, all distinct, and an auto-merge
-- destroys one of each without a human ever seeing it.
--
-- So: auto-merge fires ONLY on a case-insensitive email equality, which today
-- means ONLY on contacts. Everything else -- an exact name match included --
-- is flagged into public.merge_candidates for a person to look at.
--
-- Shared mailboxes (bookings@venue.com on four different bookers) are the
-- residual risk of the email rule itself. It is bounded rather than eliminated:
-- see § DECISION 5, and reason 'exact_email' below.
--
-- ===========================================================================
-- DECISION 2: DETECTION FIRES ON CREATE.
-- ===========================================================================
-- Not on edit, and not as a batch sweep.
--
--   on create  both records exist, one of them is seconds old, and the person
--              who made it is present to be told. The destructive half
--              (auto-merge) is bounded to a record nobody has worked in yet.
--   on edit    an email typed into a collision would destroy a record with
--              months of history as a side effect of fixing a typo. The user
--              asked to change an address, not to merge two people.
--   batch      runs with no actor, so nothing can be attributed, and
--              merges.merged_by is NOT NULL with no ON DELETE clause. A merge
--              nobody performed is not a merge.
--
-- Nothing here fires by itself: THERE IS NO TRIGGER. Detection is an explicit
-- call from an authenticated request, so it cannot run in a context that has
-- no actor to attribute it to.
--
-- ===========================================================================
-- DECISION 3: RECORD SCOPE, AND WHY THE HAZARD THE BRIEF DESCRIBES CANNOT
-- ARISE TODAY.
-- ===========================================================================
-- The brief asks: if a Standard User's create auto-merges into a record they
-- cannot see, they have modified something outside their scope.
--
-- Measured against the shipped permission catalogue rather than assumed:
--
--     select role_key from public.role_permissions
--      where permission_key = 'merge_records';   -> owner, admin, manager
--
-- and private.full_scope_organisations() excludes exactly standard_user and
-- read_only. THE THREE ROLES THAT HOLD merge_records ARE ALL FULL-SCOPE. So no
-- record-scoped user can merge anything, auto or manual, and the hazard is
-- closed by the permission matrix rather than by anything written here.
--
-- IT IS STILL HANDLED STRUCTURALLY, because a future role could hold
-- merge_records without full scope and this file must not be the thing anyone
-- has to remember:
--
--   * public.screen_for_duplicates() proposes an auto-merge ONLY when BOTH
--     records are manageable by the caller (private.entity_is_manageable on
--     each). A match the caller cannot manage goes to the queue and is never
--     offered to them.
--   * the count it returns is the number of candidates the CALLER CAN SEE. A
--     match outside their scope is recorded silently -- answering "we found 1"
--     would be an existence oracle for a record they are not entitled to.
--   * public.merge_records() is SECURITY INVOKER, so every statement it runs
--     is decided by the same policies a PostgREST call would meet.
--
-- ===========================================================================
-- DECISION 4: THE LOSER IS SOFT-DELETED, AND THE SWEEP STILL RUNS FIRST.
-- ===========================================================================
-- CLAUDE.md § Non-negotiable rules: soft-delete operational records. A merge is
-- the most destructive thing this product does and is the last place to make an
-- exception. It also keeps the loser resolvable, which merges_select_via_winner
-- requires of BOTH sides (20260828140500) -- a hard delete would make every
-- merge invisible to the record-scoped readers it was made visible for.
--
-- FOLLOW-UPS records the custom_field_values sweep's ordering constraint as
-- binding only on a HARD delete: "A merge that soft-deletes the loser is
-- unaffected." THAT IS NO LONGER TRUE, and it stopped being true after the note
-- was written. 20260829011000 (Task 5) added
-- private.entity_is_live(entity_type, entity_id, organisation_id) to
-- custom_field_values_delete_via_entity. A soft-deleted loser is not live, so
-- its values become undeletable by every client role the moment it is
-- soft-deleted -- exactly the orphan state the sweep exists to prevent, reached
-- by the path the note calls safe. Reproduced, and asserted by W22/W23.
--
-- So the order in public.merge_records() is: carry over, sweep, THEN
-- soft-delete. It would be that order anyway; it is now also the only order
-- that does not leave orphans nobody can remove.
--
-- ===========================================================================
-- DECISION 5: NO UNDO, AND WHAT A SUPPORT REQUEST LOOKS LIKE INSTEAD.
-- ===========================================================================
-- Out of scope for Phase 2, deliberately: an undo has to restore the loser,
-- un-repoint links that may have been edited since, put back custom field
-- values whose definitions may have been soft-deleted, and decide what to do
-- about everything created against the winner in between. That is a feature,
-- not a button.
--
-- What replaces it is merges.field_resolution being COMPLETE ENOUGH TO
-- RECONSTRUCT BOTH RECORDS BY HAND. It carries, per merge:
--
--   winner.before / loser.before   every mergeable column of both records as
--                                  they stood immediately before the merge
--   fields                         per column: the surviving value, which
--                                  record it came from, and the discarded one
--   custom_fields                  per field id: the same three, including
--                                  every value swept off the loser
--   links                          how many rows were repointed, dropped as
--                                  duplicates, and which side's is_primary was
--                                  demoted
--
-- So the support request is: "merge <id> in workspace <slug> was wrong."
-- The engineer reads that one merges row, restores the loser
-- (`deleted_at = null`), rewrites the winner's columns from
-- `field_resolution.winner.before`, re-files the loser's custom field values
-- from `field_resolution.custom_fields`, and repoints the links back using the
-- counts as a checklist. Everything needed is in one row, and that row cannot
-- be edited or deleted (§ 8 below).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The fuzzy threshold, in one place.
-- ---------------------------------------------------------------------------
-- 0.6 at MVP, as a function rather than a literal repeated in three bodies.
--
-- WHERE A PER-ORG SETTING WOULD LIVE: here, and nowhere else. The signature
-- becomes dedup_similarity_threshold(p_organisation_id uuid) reading a column
-- on public.organisations, every call site already has an organisation id in
-- hand, and no query text changes. It is deliberately NOT a UI setting today:
-- a threshold is a statistical control whose right value depends on a tenant's
-- data, and shipping a number box before anyone has data to tune it against is
-- a control nobody can use correctly.
create or replace function private.dedup_similarity_threshold()
returns real
language sql
immutable
set search_path = ''
as $$ select 0.6::real $$;

comment on function private.dedup_similarity_threshold() is
  'The pg_trgm similarity at or above which two names are a possible duplicate. 0.6 at MVP (Phase 2 Task 6). THE ONE PLACE THE NUMBER LIVES -- a per-organisation setting is a change to this signature (add p_organisation_id, read a column) and to nothing else. Deliberately not exposed in the UI: nobody has tenant data to tune it against yet.';

revoke all on function private.dedup_similarity_threshold() from public, anon, authenticated, service_role;
grant execute on function private.dedup_similarity_threshold() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. entity_type -> physical table, as a closed allowlist.
-- ---------------------------------------------------------------------------
-- The dedup search and the merge both have to name a table chosen at runtime,
-- and neither can be five copies of the same twenty statements. This is the
-- only place a table identifier is derived; it derives it from a CASE over the
-- five values merges_entity_type_allowed permits, and returns NULL for
-- everything else -- so a caller that fails to check for NULL gets a NULL
-- format() result and a failed statement rather than something executable.
--
-- CLAUDE.md § Non-negotiable rules, "parameterise everything": every value in
-- every dynamic statement in this file is a USING parameter. The only
-- interpolation is %I over the output of this function.
create or replace function private.dedup_entity_table(p_entity_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then 'companies'
    when 'contact' then 'contacts'
    when 'agency'  then 'agencies'
    when 'artist'  then 'artists'
    when 'venue'   then 'venues'
    else null
  end;
$$;

comment on function private.dedup_entity_table(text) is
  'entity_type -> physical table name, as a CLOSED allowlist over the five values merges_entity_type_allowed permits. The single source of a table identifier for the dynamic SQL in private.duplicate_probe() and public.merge_records(); every other element of those statements is a bound parameter. Unknown or NULL input returns NULL, which makes format() return NULL and the statement fail rather than producing something executable. Phase 3 adds ''event'' here at the same time it widens the three CHECK allowlists and entity_is_visible/manageable/live.';

revoke all on function private.dedup_entity_table(text) from public, anon, authenticated, service_role;
grant execute on function private.dedup_entity_table(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Which columns a merge may choose between, per entity type.
-- ---------------------------------------------------------------------------
-- An ALLOWLIST, not "every column": id, organisation_id, owner_user_id,
-- created_at, updated_at and deleted_at are structure rather than content, and
-- a merge that let a user pick the loser's organisation_id would be a
-- cross-tenant write wearing a field choice's clothes.
create or replace function private.dedup_mergeable_columns(p_entity_type text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then array['name','type']
    when 'contact' then array['name','email','phone','title','location','website','socials','tags']
    when 'agency'  then array['name']
    when 'artist'  then array['name','genres','country','city','socials','website','notes']
    when 'venue'   then array['name','address','location','capacity','socials','website','technical_info']
    else array[]::text[]
  end;
$$;

comment on function private.dedup_mergeable_columns(text) is
  'The columns a merge may take from either record, per entity type. An ALLOWLIST: id, organisation_id, owner_user_id and the three timestamps are excluded because they are structure rather than content. Drives both the SET list of the winner update in public.merge_records() and the "fields" section of merges.field_resolution, so the record of what was discarded covers exactly the set that could be chosen.';

revoke all on function private.dedup_mergeable_columns(text) from public, anon, authenticated, service_role;
grant execute on function private.dedup_mergeable_columns(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The fifth trigram index.
-- ---------------------------------------------------------------------------
-- 20260827232510 gave contacts, companies, artists and venues a partial GIN
-- trigram index on `name` and gave AGENCIES none. Agencies are one of the five
-- entity types merges_entity_type_allowed permits and one of the five this
-- task screens, so without this the agency half of every fuzzy probe is a
-- sequential scan of the tenant's agencies while the other four are index
-- lookups -- an asymmetry with no reason behind it other than the order the
-- tables were written in.
--
-- Same shape and same partial predicate as the other four, so the write cost
-- recorded in FOLLOW-UPS (+0.01-0.03 ms per insert, a bulk update of `name`
-- roughly doubling, ~0.8-6 MB per 25k rows) applies unchanged.
create index if not exists agencies_name_trgm_idx
  on public.agencies using gin (name extensions.gin_trgm_ops)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 5. THE DEFINER DEDUP PROBE.
-- ---------------------------------------------------------------------------
-- FOLLOW-UPS specifies this function and the reason for it: under RLS a
-- non-leakproof operator can never become an index qual, so `name % $1` on a
-- table the caller has security quals for is a sequential scan of the tenant
-- forever. Inside a SECURITY DEFINER body owned by the table owner there are
-- no such quals and the trigram index is reachable -- measured at 196x
-- (0.159 ms against 31.233 ms over 20 calls, Bitmap Index Scan on
-- contacts_name_trgm_idx).
--
-- EVERY REQUIREMENT FROM THAT ENTRY, AND WHERE IT IS:
--
--   set search_path = ''                     on the function
--   `name operator(extensions.%) $n`         pg_trgm lives in extensions
--   extensions.similarity(...)               same reason
--   owned by the table owner                 postgres, by migration
--   revoke execute from public               below
--   THE WHOLE POLICY re-established here     the four terms below
--
-- The last is the one a reviewer got wrong and read another tenant's contact
-- out of the database with. The body is the entire control, so it carries:
--
--   1. p_organisation_id in (select private.permitted_organisations('view_crm'))
--      -- the role -> permission mapping, the MFA/aal2 gate, the membership,
--      and Q6's suspension rule.
--   2. e.organisation_id = p_organisation_id  -- tenant equality on the ROW,
--      not just on the argument. Without it the argument is checked and the
--      rows are not.
--   3. the record-scope disjunction, WHEN p_scoped -- see the note on that
--      parameter.
--   4. e.deleted_at is null -- RLS deliberately does not filter soft-deleted
--      rows (20260828121000 note (g)), so every query writes it itself, and
--      the partial indexes need it present to be usable anyway.
--
-- THE Q6 CORRECTION, which FOLLOW-UPS still records the pre-Q6 version of in
-- one place and the correction in another. A SUSPENDED ORGANISATION IS
-- READ-ONLY, NOT LOCKED OUT. This is a read. There is deliberately NO
-- `o.deleted_at is null` on the organisation anywhere in this body: term 1
-- calls the shipped private.permitted_organisations(), which resolves
-- suspension through public.permissions.survives_suspension, and view_crm
-- survives. A member of a suspended organisation therefore gets their rows and
-- a non-member still gets none -- the same answer permitted_organisations()
-- gives, which is what W12/W13 assert rather than a hardcoded 0.
--
-- WHY p_scoped IS A PARAMETER AND WHY IT IS NOT REACHABLE FROM A CLIENT.
-- Two callers need two different answers:
--
--   private.duplicate_matches()      what a person may SEE. Record scope on.
--                                    Granted to authenticated.
--   public.screen_for_duplicates()   what must be FLAGGED. Record scope off,
--                                    because a duplicate a record-scoped user
--                                    cannot see is precisely the one that has
--                                    to reach a full-scope reviewer.
--
-- If `authenticated` could call this directly it could pass p_scoped => false
-- and read every record in its organisation, which is the leak the record
-- scope exists to prevent. So THIS FUNCTION IS GRANTED TO NOBODY. Its two
-- callers are SECURITY DEFINER functions owned by postgres, which reach it
-- through the owner's own privileges. `revoke ... from public` below is not
-- decoration: without it PUBLIC holds the default EXECUTE.
create or replace function private.duplicate_probe(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid,
  p_scoped          boolean
)
returns table (
  id           uuid,
  name         text,
  email        text,
  owner_user_id uuid,
  created_at   timestamptz,
  reason       text,
  similarity   real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table text := private.dedup_entity_table(p_entity_type);
  v_has_email boolean := (p_entity_type = 'contact');
begin
  if v_table is null then
    raise exception 'duplicate_probe: unknown entity_type %', p_entity_type
      using errcode = '22023';
  end if;

  -- The subject row, read WITHOUT record scope on purpose: this is not a
  -- disclosure (nothing about it is returned), it is the value being matched
  -- against, and screen_for_duplicates() legitimately screens a record on
  -- behalf of a reviewer who may not own it.
  -- TWO STATEMENTS RATHER THAN ONE WITH SIX CONDITIONAL FRAGMENTS. Only
  -- `contacts` has an email column, so the exact-match half of the predicate
  -- does not merely evaluate to false for the other four -- it does not parse.
  -- The alternative (splicing `null::text` and `false` in at six positions)
  -- was written first and is exactly the kind of format() string where
  -- positional and sequential specifiers get mixed and nobody notices.
  --
  -- The four bound parameters are the same in both branches:
  --   $1 organisation, $2 entity type (unused in the SQL, bound for symmetry),
  --   $3 the subject's id, $4 whether to apply record scope.
  if v_has_email then
    return query execute pg_catalog.format($fmt$
      with subject as (
        select s.id, s.name, s.email
          from public.%1$I s
         where s.id = $3
           and s.organisation_id = $1
           and s.deleted_at is null
           -- THE SUBJECT IS SCOPED TOO, AND THIS LINE WAS MISSING IN THE FIRST
           -- VERSION OF THIS FUNCTION. Without it a record-scoped caller could
           -- ask about a record they cannot see and get back their OWN records
           -- that resemble it -- which answers "does a record with a name like
           -- mine exist over there", an existence-and-similarity oracle for a
           -- row outside their scope. Found by W7, which FOLLOW-UPS specifies
           -- as "called by a standard_user for a row they do not own -> 0
           -- rows"; the first implementation returned two.
           and ( not $4
                 or $1 in (select private.full_scope_organisations())
                 or s.owner_user_id = (select auth.uid()) )
      )
      select e.id,
             e.name,
             e.email,
             e.owner_user_id,
             e.created_at,
             case when subject.email is not null
                   and pg_catalog.lower(e.email) = pg_catalog.lower(subject.email)
                  then 'exact_email' else 'fuzzy_name' end as reason,
             extensions.similarity(e.name, subject.name)::real as similarity
        from public.%1$I e
        cross join subject
       where e.id <> subject.id
         and e.organisation_id = $1
         and e.deleted_at is null
         -- Term 1: the role -> permission mapping, the aal2 gate, the
         -- membership, and Q6's suspension rule -- all of it, in one call to
         -- the shipped helper rather than restated here.
         and $1 in (select private.permitted_organisations('view_crm'))
         -- Term 3: record scope, and ONLY when the caller is entitled to be
         -- told about rows they do not own.
         and ( not $4
               or $1 in (select private.full_scope_organisations())
               or e.owner_user_id = (select auth.uid()) )
         and (
           ( subject.email is not null
             and pg_catalog.lower(e.email) = pg_catalog.lower(subject.email) )
           or ( e.name operator(extensions.%%) subject.name
                and extensions.similarity(e.name, subject.name)
                    >= private.dedup_similarity_threshold() )
         )
       -- Exact email first, then most similar, then oldest. The first row is
       -- therefore the auto-merge candidate when there is one.
       order by (case when subject.email is not null
                       and pg_catalog.lower(e.email) = pg_catalog.lower(subject.email)
                      then 0 else 1 end),
                extensions.similarity(e.name, subject.name) desc,
                e.created_at asc,
                e.id asc
       limit 50
    $fmt$, v_table)
    using p_organisation_id, p_entity_type, p_entity_id, p_scoped;
  else
    return query execute pg_catalog.format($fmt$
      with subject as (
        select s.id, s.name from public.%1$I s
         where s.id = $3 and s.organisation_id = $1 and s.deleted_at is null
           -- Scoped, for the reason spelled out in the contacts branch above.
           and ( not $4
                 or $1 in (select private.full_scope_organisations())
                 or s.owner_user_id = (select auth.uid()) )
      )
      select e.id,
             e.name,
             null::text as email,
             e.owner_user_id,
             e.created_at,
             'fuzzy_name'::text as reason,
             extensions.similarity(e.name, subject.name)::real as similarity
        from public.%1$I e
        cross join subject
       where e.id <> subject.id
         and e.organisation_id = $1
         and e.deleted_at is null
         and $1 in (select private.permitted_organisations('view_crm'))
         and ( not $4
               or $1 in (select private.full_scope_organisations())
               or e.owner_user_id = (select auth.uid()) )
         and e.name operator(extensions.%%) subject.name
         and extensions.similarity(e.name, subject.name)
             >= private.dedup_similarity_threshold()
       order by extensions.similarity(e.name, subject.name) desc,
                e.created_at asc,
                e.id asc
       limit 50
    $fmt$, v_table)
    using p_organisation_id, p_entity_type, p_entity_id, p_scoped;
  end if;
end;
$$;

comment on function private.duplicate_probe(uuid, text, uuid, boolean) is
  'The dedup search. SECURITY DEFINER because pg_trgm''s % is not leakproof and therefore can never be an index qual for a caller RLS applies to -- measured 196x. The body re-establishes the WHOLE policy, not just membership: permitted_organisations(''view_crm'') (role mapping + aal2 + Q6 suspension), row-level tenant equality, the record-scope disjunction (when p_scoped), and the soft-delete filter RLS deliberately does not apply. NO organisation deleted_at test anywhere: Q6 makes suspension read-only and this is a read, so the answer must be whatever permitted_organisations() gives. When p_scoped, the record-scope disjunction is applied to the SUBJECT as well as to the matches: without that a record-scoped caller can ask about a record they cannot see and learn, from which of their own records come back, that it exists and roughly what it is called. GRANTED TO NOBODY -- p_scoped => false returns rows outside the caller''s record scope, which is correct for the flagging path and a leak for any other, so only its two SECURITY DEFINER callers can reach it.';

revoke all on function private.duplicate_probe(uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The scoped view of it, which IS granted.
-- ---------------------------------------------------------------------------
-- What a person may see: the same probe with record scope applied. This is the
-- function the four tests FOLLOW-UPS requires are written against -- an
-- organisation the caller is not in, an aal1 session for an MFA-required role,
-- a standard_user asking about rows they do not own, and the Q6 case asserting
-- the same answer permitted_organisations() gives.
create or replace function private.duplicate_matches(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid
)
returns table (
  id           uuid,
  name         text,
  email        text,
  owner_user_id uuid,
  created_at   timestamptz,
  reason       text,
  similarity   real
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.duplicate_probe(p_organisation_id, p_entity_type, p_entity_id, true);
$$;

comment on function private.duplicate_matches(uuid, text, uuid) is
  'Possible duplicates of one record, as the CALLER is entitled to see them: private.duplicate_probe() with record scope on. The granted half of the pair -- the unscoped probe is reachable only from SECURITY DEFINER callers. Returns 0 rows for an organisation the caller is not a member of, for an aal1 session whose role requires MFA, and for a record-scoped caller asking about rows they do not own; returns the caller''s own rows in a SUSPENDED organisation, because Q6 makes suspension read-only and this is a read.';

revoke all on function private.duplicate_matches(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.duplicate_matches(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE REVIEW QUEUE.
-- ---------------------------------------------------------------------------
-- "Fuzzy matches are flagged for manual review" (CLAUDE.md § Domain entities).
-- A flag needs somewhere to live, and the alternative -- computing the queue on
-- demand -- is O(n^2) over the tenant and cannot be paginated, sorted or
-- counted by lib/list/ like every other list in this phase.
--
-- WHY deleted_at RATHER THAN A status COLUMN. A resolved candidate is a
-- resolved candidate: merged or dismissed, it is off the queue and must not
-- come back. Soft delete is how this schema expresses "off the list but still
-- there", every partial index in the phase is predicated on it, and
-- lib/list/query.ts constrains the column on every query it makes -- so the
-- open queue and the resolved history are the same list surface with
-- `scope: "live"` and `scope: "deleted"`, at no cost. `resolution` says which
-- of the two it was.
--
-- THE PAIR IS ORDERED BY AGE, NOT BY UUID. keep_id is the OLDER record and is
-- what the merge screen proposes as the winner; duplicate_id is the newer one.
-- That makes the partial unique index below stable -- screening either record
-- against the other produces the same (keep, duplicate) pair -- without a
-- least()/greatest() expression index whose immutability would have to be
-- argued.
--
-- THE TWO DENORMALISED OWNER COLUMNS. Not convenience: they are what makes a
-- record-scoped read of this table indexable rather than a per-row polymorphic
-- dispatch, the same problem FOLLOW-UPS measured at 2266 ms on merges. They are
-- a PRE-FILTER and never the authority -- see the SELECT policy.
create table public.merge_candidates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  entity_type text not null,
  -- Polymorphic, both of them, for the reason merges.winner_id/loser_id are:
  -- no foreign key can say "references whichever table this other column
  -- names". private.entity_is_visible/manageable close the hole in the
  -- policies, exactly as they do for merges.
  keep_id uuid not null,
  duplicate_id uuid not null,
  keep_owner_user_id uuid,
  duplicate_owner_user_id uuid,
  -- The subject's name as it stood at detection. Not authoritative and never
  -- rendered as the record's name -- it exists so the queue has a searchable,
  -- sortable column, which lib/list/ requires and a polymorphic pair cannot
  -- otherwise provide. Both records are visible to anyone who can read the
  -- row (see the SELECT policy), so it discloses nothing the row does not.
  label text not null,
  reason text not null,
  similarity real,
  detected_at timestamptz not null default now(),
  -- Set together, or both null. `deleted_at` is what takes the row off the
  -- queue; `resolution` says which way it went.
  resolution text,
  resolved_by uuid references auth.users (id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint merge_candidates_entity_type_allowed check (
    entity_type in ('company', 'contact', 'agency', 'artist', 'venue')
  ),
  constraint merge_candidates_distinct_records check (keep_id <> duplicate_id),
  constraint merge_candidates_reason_allowed check (
    reason in ('exact_email', 'fuzzy_name')
  ),
  constraint merge_candidates_resolution_allowed check (
    resolution is null or resolution in ('merged', 'dismissed')
  ),
  -- A resolved row has all three, an open row has none. Without this a row can
  -- be off the queue with nothing recording why or who, which is the state the
  -- table exists to prevent.
  constraint merge_candidates_resolution_complete check (
    (deleted_at is null and resolution is null and resolved_by is null)
    or (deleted_at is not null and resolution is not null and resolved_by is not null)
  ),
  constraint merge_candidates_similarity_range check (
    similarity is null or (similarity >= 0 and similarity <= 1)
  )
);

comment on table public.merge_candidates is
  'The manual-review queue: a possible duplicate pair, flagged by public.screen_for_duplicates() and resolved by a person. keep_id is the OLDER record (the merge screen''s proposed winner), duplicate_id the newer. Written ONLY by screen_for_duplicates -- there is no INSERT grant and no INSERT policy -- because a candidate must be recordable against a record the flagging caller cannot see, which is exactly the case that has to reach a full-scope reviewer. Soft-deleted when resolved, so the open queue and the resolved history are one list surface with two scopes. keep_owner_user_id/duplicate_owner_user_id are a denormalised PRE-FILTER for the record-scoped read path and never the authority: the SELECT policy still evaluates entity_is_visible() on both sides.';

comment on column public.merge_candidates.label is
  'The subject record''s name at detection time. Exists so lib/list/ has a searchable, sortable column on a table whose subjects are polymorphic. Never rendered as a record''s current name -- it is a snapshot and goes stale. Discloses nothing: the SELECT policy already requires both records to be visible.';

comment on column public.merge_candidates.resolved_by is
  'The actor who resolved the candidate. NO ON DELETE clause, matching merges.merged_by and audit_events.actor_user_id: attribution outlives the account, so GDPR erasure must anonymise rather than delete. One decision across all three -- Phase 7+.';

-- Every foreign key''s leading column indexed (schema_invariants D3).
create index merge_candidates_organisation_id_idx
  on public.merge_candidates (organisation_id);
create index merge_candidates_resolved_by_idx
  on public.merge_candidates (resolved_by);

-- THE QUEUE'S OWN PAGE, and lib/list/spec.ts's `backedBy` has to name it.
-- Ordered by detection, newest first, partial on the open rows -- the same
-- shape as contacts_org_updated_at_id_live_idx and for the same reason.
-- include (keep_owner_user_id, duplicate_owner_user_id) because the SELECT
-- policy's pre-filter reads both, and without them a record-scoped reader pays
-- a heap fetch per candidate row.
create index merge_candidates_org_detected_id_live_idx
  on public.merge_candidates (organisation_id, detected_at desc, id desc)
  include (keep_owner_user_id, duplicate_owner_user_id)
  where deleted_at is null;

-- The resolved view's page.
create index merge_candidates_org_deleted_at_id_idx
  on public.merge_candidates (organisation_id, deleted_at desc, id desc)
  where deleted_at is not null;

-- "Has this pair already been flagged?" asked once per screening call, and the
-- guard against the queue filling with one row per create for the same pair.
-- PARTIAL ON THE OPEN ROWS: a dismissed pair that is genuinely flagged again
-- later (someone edited one of the names back into a collision) must be able to
-- come back, and a merged pair cannot recur because the loser is gone.
create unique index merge_candidates_open_pair_idx
  on public.merge_candidates (organisation_id, entity_type, keep_id, duplicate_id)
  where deleted_at is null;

-- Redundant with nothing: the merge resolves candidates naming its pair in
-- EITHER direction, and the unique index above only serves (keep, duplicate).
create index merge_candidates_duplicate_idx
  on public.merge_candidates (organisation_id, entity_type, duplicate_id)
  where deleted_at is null;

alter table public.merge_candidates enable row level security;

-- updated_at is maintained by the shared trigger, not by the application.
-- 20260828121500 decided this for all seventeen tables carrying the column and
-- FOLLOW-UPS records the obligation on every table added afterwards; L5 is the
-- assertion that catches an omission and L6 moves from 17 to 18.
create trigger set_updated_at
  before update on public.merge_candidates
  for each row
  when (old.* is distinct from new.*)
  execute function private.set_updated_at();

-- SELECT: BOTH SIDES VISIBLE, for the reason merges' policy requires it
-- (20260828140500, IMP-2). A candidate row names two records and carries a
-- label copied from one of them; scoping by one side would hand a
-- record-scoped user the existence and name of a record that was never in
-- their scope.
--
-- THE TERM ORDER IS THE PERFORMANCE DESIGN AND IS NOT COSMETIC:
--
--   1. organisation_id in (...)  hoisted to one InitPlan per statement.
--   2. full_scope_organisations()  also hoisted. A full-scope role -- which is
--      every role that can act on the queue -- never evaluates the dispatch.
--   3. the two owner equalities. Plain uuid comparisons against columns in the
--      covering index, so a record-scoped reader discards every candidate that
--      is not entirely theirs before any function is called.
--   4. entity_is_visible() on both sides. STILL THE AUTHORITY. The owner
--      columns are a snapshot taken at detection and go stale the moment a
--      record is reassigned, so they can narrow the set the dispatch runs on
--      and must never be the thing that grants.
create policy "merge_candidates_select_both_sides_visible"
  on public.merge_candidates for select to authenticated
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or (
        keep_owner_user_id = (select auth.uid())
        and duplicate_owner_user_id = (select auth.uid())
        and private.entity_is_visible(entity_type, keep_id, organisation_id)
        and private.entity_is_visible(entity_type, duplicate_id, organisation_id)
      )
    )
  );

-- UPDATE: resolving a candidate. `merge_records` because taking a pair off the
-- queue is a decision about a merge, and crm_write_organisations() because Q6
-- makes a suspended workspace read-only -- reading the queue stays open, acting
-- on it does not.
--
-- Both sides MANAGEABLE, not merely visible: dismissing a pair is a decision
-- about both records.
--
-- WHAT THE WITH CHECK PINS. entity_type, the two ids and organisation_id must
-- survive the update unchanged, so "dismiss" cannot be turned into "repoint
-- this candidate at a different pair" -- the polymorphic columns are exactly
-- the ones no foreign key protects.
create policy "merge_candidates_update_resolve"
  on public.merge_candidates for update to authenticated
  using (
    organisation_id in (select private.permitted_organisations('merge_records'))
    and organisation_id in (select private.crm_write_organisations())
    and private.entity_is_manageable(entity_type, keep_id, organisation_id)
    and private.entity_is_manageable(entity_type, duplicate_id, organisation_id)
  )
  with check (
    organisation_id in (select private.permitted_organisations('merge_records'))
    and organisation_id in (select private.crm_write_organisations())
    and resolved_by = (select auth.uid())
    and private.entity_is_manageable(entity_type, keep_id, organisation_id)
    and private.entity_is_manageable(entity_type, duplicate_id, organisation_id)
  );

comment on policy "merge_candidates_update_resolve" on public.merge_candidates is
  'The only client write on this table. Requires merge_records AND a live workspace (Q6: a suspended organisation may read the queue and not act on it) AND both records manageable -- dismissing a pair is a decision about both. resolved_by is pinned to auth.uid() for the reason merges.merged_by is: attribution for a destructive decision must not be caller-supplied. Immutability of entity_type/keep_id/duplicate_id/organisation_id is enforced by private.merge_candidate_pair_unchanged(), a BEFORE UPDATE trigger, rather than by a WITH CHECK term -- a WITH CHECK cannot see OLD.';

revoke all on public.merge_candidates from anon, authenticated, service_role;
grant select, update on public.merge_candidates to authenticated;

-- The pair is immutable. A WITH CHECK clause cannot compare against OLD, so
-- this is the only place the rule can live.
create or replace function private.merge_candidate_pair_unchanged()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organisation_id is distinct from old.organisation_id
     or new.entity_type is distinct from old.entity_type
     or new.keep_id is distinct from old.keep_id
     or new.duplicate_id is distinct from old.duplicate_id
     or new.detected_at is distinct from old.detected_at
     or new.reason is distinct from old.reason then
    raise exception
      'merge_candidates: organisation_id, entity_type, keep_id, duplicate_id, reason and detected_at are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.merge_candidate_pair_unchanged() is
  'BEFORE UPDATE guard: the identity of a candidate -- its workspace, entity type, the two records, why and when it was flagged -- cannot be rewritten. Without it the single UPDATE grant on this table lets "dismiss this pair" be sent as "make this row point at a different pair", and keep_id/duplicate_id are polymorphic so no foreign key would notice. Same argument as custom_field_definitions'' entity_type immutability (20260829012000), and the same mechanism, because a WITH CHECK cannot see OLD.';

create trigger merge_candidate_pair_unchanged
  before update on public.merge_candidates
  for each row
  execute function private.merge_candidate_pair_unchanged();

-- ---------------------------------------------------------------------------
-- 8. merges: the denormalised owner columns, and append-only for real.
-- ---------------------------------------------------------------------------
-- (e) A RECORD-SCOPED `merges` LIST IS ~2.3 s PER PAGE AT 20k ROWS AND NO
-- POLICY CAN FIX IT. merges_select_via_winner is the one CRM SELECT policy
-- calling a function with COLUMN arguments, so the polymorphic dispatch cannot
-- be hoisted; fix round 3 put the hoistable full-scope term first and bought
-- the full-scope case (12308 ms -> 6.083 ms), and the record-scoped reader
-- still paid two entity_is_visible() calls per row.
--
-- The recorded suggestion was a denormalised `winner_owner_user_id` with a
-- policy term of `winner_owner_user_id = auth.uid()`. TWO CORRECTIONS TO IT,
-- both of which change the shape:
--
--   * IT HAS TO BE BOTH SIDES. The policy has required both since
--     20260828140500 and for a real, reproduced leak -- field_resolution
--     copies the discarded values of both records. A `winner_owner_user_id`
--     term alone would re-open exactly that.
--   * IT CANNOT REPLACE THE DISPATCH, only narrow it. The columns are a
--     snapshot written at merge time; reassigning a record's owner afterwards
--     makes them stale, and a policy that GRANTS on a stale snapshot grants to
--     the wrong person. So they are ANDed in FRONT of the dispatch, which
--     remains the authority. Correctness is unchanged in the granting
--     direction and narrowed in the safe one: a merge whose record has since
--     been reassigned TO a record-scoped user is no longer visible to them.
--     That is the right direction for a history row that describes a state
--     that no longer holds.
--
-- Nullable, because merges rows predating this migration have no owner to
-- record and a NULL equality is not true -- a pre-existing merge is
-- unreachable to a record-scoped reader and reachable to a full-scope one,
-- which is the fail-safe direction.
alter table public.merges
  add column winner_owner_user_id uuid,
  add column loser_owner_user_id  uuid;

comment on column public.merges.winner_owner_user_id is
  'owner_user_id of the winner AS AT THE MERGE. A denormalised PRE-FILTER for the record-scoped read path, not an authority: merges_select_via_winner still evaluates entity_is_visible() on both sides behind it. Written by private.record_merge() from the row it read; NULL on merges predating Phase 2 Task 6, which makes them invisible to record-scoped readers and visible to full-scope ones. Goes stale on reassignment, which is why it can only narrow.';
comment on column public.merges.loser_owner_user_id is
  'owner_user_id of the loser AS AT THE MERGE. See winner_owner_user_id. BOTH are required by the policy because field_resolution copies the discarded values of BOTH records (20260828140500, IMP-2) -- the winner alone was the shape of the leak that change closed.';

-- The record-scoped page, and the one FOLLOW-UPS says is 2266 ms without it.
-- No `where` predicate: merges has no deleted_at and every row is live.
create index merges_org_owners_merged_at_idx
  on public.merges (organisation_id, winner_owner_user_id, merged_at desc, id desc)
  include (loser_owner_user_id);

-- The full-scope page. merged_at desc is the only sort this list has and the
-- full-scope reader is the common case.
create index merges_org_merged_at_id_idx
  on public.merges (organisation_id, merged_at desc, id desc);

-- H15 guards that the hoistable full-scope term LEADS the disjunction. It still
-- does; the two owner equalities go in front of the dispatch inside the other
-- branch, which is where the per-row cost was.
alter policy "merges_select_via_winner" on public.merges
  using (
    organisation_id in (select private.permitted_organisations('view_crm'))
    and (
      organisation_id in (select private.full_scope_organisations())
      or (
        winner_owner_user_id = (select auth.uid())
        and loser_owner_user_id = (select auth.uid())
        and private.entity_is_visible(entity_type, winner_id, organisation_id)
        and private.entity_is_visible(entity_type, loser_id,  organisation_id)
      )
    )
  );

comment on policy "merges_select_via_winner" on public.merges is
  'MISNAMED SINCE FIX ROUND 1: a record-scoped reader must be able to see BOTH the winner and the loser, because field_resolution copies the DISCARDED values of both records verbatim. REORDERED IN FIX ROUND 3 (New-2): the hoistable full_scope_organisations() term leads, so a full-scope role never evaluates the per-row polymorphic dispatch -- 12308 ms -> 6.083 ms on a 50-row page over 20k rows. NARROWED IN PHASE 2 TASK 6: the record-scoped branch now leads with winner_owner_user_id/loser_owner_user_id equality against auth.uid(), which is indexable and discards a merge that is not entirely the caller''s before any function runs -- entity_is_visible() on both sides is still evaluated behind it and is still the authority, because the two columns are a snapshot taken at merge time and a stale snapshot must never GRANT. Deliberate consequence: a merge whose record has since been reassigned to a record-scoped user is no longer visible to them, and a merges row predating the columns (NULL) is invisible to them too. For a full-scope reader the winner and loser identifiers are still not validated at all -- not for existence and not for membership of this organisation (NR2-1) -- because the dispatch that did that validation is the term they never reach.';

-- APPEND-ONLY, THE OTHER HALF.
--
-- 20260827232512's header: "Task 2 should do the same for this table" as
-- Foundation does for audit_events -- "no client UPDATE/DELETE grant, writes
-- through a privileged function". VERIFIED RATHER THAN ASSUMED, against the
-- live database:
--
--   information_schema.role_table_grants, grantee='authenticated':
--     audit_events  SELECT
--     merges        SELECT, INSERT
--
-- So Task 2 shipped the first half and not the second. The half that is
-- missing is not cosmetic: with a direct INSERT grant a client can POST a
-- merges row recording a merge that never happened -- no links repointed, no
-- custom field values carried, no loser soft-deleted -- and the merge history,
-- whose entire purpose is explaining what a merge did, becomes a table anyone
-- can write fiction into. It is the § 4 defect class ("a merge that reports
-- success without applying") reached without even running a merge.
--
-- Closed the way Foundation closes it: the grant goes, the policy goes with it
-- (schema_invariants D5 asserts grant <-> policy in BOTH directions, so
-- leaving the policy behind would be dead code AND a failing invariant), and
-- the whole of that policy is re-established inside private.record_merge().
revoke insert on public.merges from authenticated;
drop policy "merges_insert_merge_records" on public.merges;

-- ---------------------------------------------------------------------------
-- 9. private.record_merge() -- the sole writer into public.merges.
-- ---------------------------------------------------------------------------
-- The shape of private.log_audit_event(), for the same reason and with one
-- difference that has to be stated rather than glossed.
--
-- THE DIFFERENCE: log_audit_event is granted to NO client role, because its
-- callers are all SECURITY DEFINER. This one is granted to `authenticated`,
-- because its caller -- public.merge_records() -- is SECURITY INVOKER, which is
-- not negotiable: every CRM statement a merge runs must be decided by the same
-- policies a PostgREST call would meet, and a SECURITY DEFINER merge would run
-- them as postgres.
--
-- WHAT THAT LEAVES, stated honestly: a caller with a direct database session as
-- `authenticated` can call this and write a merges row without merging
-- anything. PostgREST cannot -- it exposes `public` only -- so this is not
-- reachable from the product's client surface, and it is strictly narrower than
-- the table grant it replaces, which WAS reachable from it. The body carries
-- every term the dropped INSERT policy carried, so the authorisation is
-- unchanged; what changed is who can reach the statement.
create or replace function private.record_merge(
  p_organisation_id     uuid,
  p_entity_type         text,
  p_winner_id           uuid,
  p_loser_id            uuid,
  p_winner_owner        uuid,
  p_loser_owner         uuid,
  p_field_resolution    jsonb,
  -- IDENTIFIERS, NAMES AND COUNTS ONLY. Never a value. audit_events is read by
  -- the platform superuser and CLAUDE.md § Superuser dashboard keeps tenant
  -- record content off that surface -- private.audit_crm_payload() is the same
  -- rule expressed as an allowlist. The projection is done by the caller,
  -- because the caller is what holds the values and can be sure none of them
  -- crossed. Passed separately from p_field_resolution for exactly that reason:
  -- deriving it here would mean this function handling the values it must not
  -- record.
  p_audit_summary       jsonb
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
    raise exception 'record_merge: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  -- THE WHOLE OF THE DROPPED merges_insert_merge_records POLICY, TERM FOR TERM.
  -- The body is the only control there is once the grant is gone, so it is
  -- written out rather than referenced.
  if p_organisation_id is null
     or p_organisation_id not in (select private.permitted_organisations('merge_records'))
     or p_organisation_id not in (select private.crm_write_organisations())
     or not private.entity_is_manageable(p_entity_type, p_winner_id, p_organisation_id)
     or not private.entity_is_manageable(p_entity_type, p_loser_id,  p_organisation_id)
  then
    raise exception 'merge not permitted for this caller in this workspace'
      using errcode = '42501';
  end if;

  insert into public.merges (
    organisation_id, entity_type, winner_id, loser_id,
    winner_owner_user_id, loser_owner_user_id,
    merged_by, field_resolution
  )
  values (
    p_organisation_id, p_entity_type, p_winner_id, p_loser_id,
    p_winner_owner, p_loser_owner,
    -- Pinned, never a parameter. Same rule as log_audit_event: attribution for
    -- a destructive action must not be caller-supplied, and there is no
    -- argument here that could carry it.
    v_actor,
    coalesce(p_field_resolution, '{}'::jsonb)
  )
  returning id into v_id;

  -- THE SECOND AUDIT ROW, and 20260828141000's header is what asks for it:
  -- "this trigger makes the second half structural rather than a thing Task 6
  -- has to remember -- and Task 6 should therefore NOT write its own audit row
  -- for the merge record itself (it still should for the field-level rewrite of
  -- the winner, which this cannot see)." The audit_insert trigger on
  -- public.merges records that a merge happened, with the two identifiers. It
  -- cannot record that the winner's name and email were rewritten from the
  -- loser, because that is an UPDATE on a table nothing audits.
  --
  -- Same correlation_id as nothing else, deliberately: log_audit_event() mints
  -- one per call and the trigger's row has its own, so the two are found by
  -- target_id (the merges row) rather than by correlation. Threading one
  -- through would mean the trigger taking a parameter it has no way to receive.
  perform private.log_audit_event(
    p_action          => 'records.merged.fields',
    p_target_type     => 'merge',
    p_organisation_id => p_organisation_id,
    p_target_id       => v_id,
    p_after           => coalesce(p_audit_summary, '{}'::jsonb));

  return v_id;
end;
$$;

comment on function private.record_merge(uuid, text, uuid, uuid, uuid, uuid, jsonb, jsonb) is
  'Sole write path into public.merges, which has no INSERT policy and no client INSERT grant since Phase 2 Task 6 -- the shape Foundation uses for audit_events, and the half 20260827232512 asked Task 2 for and Task 2 did not ship. merged_by is forced to auth.uid() and is not a parameter. The body restates the DROPPED merges_insert_merge_records policy term for term (merge_records, crm_write_organisations, entity_is_manageable on BOTH sides), so authorisation is unchanged and only reachability narrowed. GRANTED TO authenticated, unlike log_audit_event, because its caller public.merge_records() is SECURITY INVOKER and must stay that way; PostgREST exposes only `public`, so the residual is a direct database session, which the table grant it replaces was not limited to. TWO audit rows are written per merge and neither duplicates the other: the audit_insert trigger on public.merges records THAT a merge happened (identifiers only, via audit_crm_payload), and this function records WHAT IT DID to the winner -- p_audit_summary, which is column NAMES and counts and never a value, because audit_events is superuser-readable and CLAUDE.md § Superuser dashboard keeps tenant record content off it. 20260828141000''s header asks for exactly that split.';

revoke all on function private.record_merge(uuid, text, uuid, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.record_merge(uuid, text, uuid, uuid, uuid, uuid, jsonb, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 10. public.screen_for_duplicates() -- detection, and the only writer into
--     public.merge_candidates.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for two reasons that are the same reason twice: it reaches
-- private.duplicate_probe() with p_scoped => false, and it writes a table with
-- no INSERT grant and no INSERT policy. Both exist because A DUPLICATE THE
-- CALLER CANNOT SEE IS PRECISELY THE ONE THAT HAS TO REACH SOMEBODY ELSE. A
-- record-scoped user creating "Sam Patel" when a manager's "Sam Patel" already
-- exists must not be told about it, and the manager must.
--
-- Its own authorisation, since RLS decides nothing inside a definer body:
--
--   * private.entity_is_manageable() on the SUBJECT. You may screen a record
--     you may write, and no other. That carries the permission key per entity
--     type, the tenant equality, the MFA gate and record scope.
--   * private.crm_write_organisations(). This writes rows, and Q6 makes a
--     suspended workspace read-only. Reading the queue stays open; adding to
--     it does not.
--
-- WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT.
--   flagged                 candidates from THIS call that this caller can
--                           see. A match outside the caller's record scope is
--                           written and NOT counted -- "we found 1" would be
--                           an existence oracle for a record they are not
--                           entitled to know exists.
--   auto_merge_winner_id    non-null only for an exact email match where BOTH
--   auto_merge_loser_id     records are manageable by this caller. The older
--                           record wins.
--
-- WHY IT DOES NOT PERFORM THE AUTO-MERGE ITSELF, which is the trap in the
-- obvious design. SECURITY INVOKER means "the rights of the calling context",
-- and inside a SECURITY DEFINER body the calling context IS THE DEFINER. So
-- calling public.merge_records() from here would run every CRM statement of the
-- merge as postgres with RLS not applied -- a total bypass reached by nesting
-- two functions that are each individually correct. The two calls are therefore
-- made separately by the application, and the merge meets the caller's own
-- policies. Nothing is lost by the split: the candidate row is written first,
-- so a merge that is then refused leaves the pair in the queue rather than
-- disappearing.
create or replace function public.screen_for_duplicates(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table    text := private.dedup_entity_table(p_entity_type);
  v_subject  record;
  v_match    record;
  v_keep     uuid;
  v_dup      uuid;
  v_auto_w   uuid;
  v_auto_l   uuid;
  v_flagged  integer := 0;
begin
  if v_table is null then
    raise exception 'screen_for_duplicates: unknown entity_type %', p_entity_type
      using errcode = '22023';
  end if;

  if (select auth.uid()) is null then
    raise exception 'screen_for_duplicates: no authenticated user'
      using errcode = '28000';
  end if;

  if p_organisation_id is null
     or p_organisation_id not in (select private.crm_write_organisations())
     or not private.entity_is_manageable(p_entity_type, p_entity_id, p_organisation_id)
  then
    raise exception 'duplicate screening not permitted for this caller in this workspace'
      using errcode = '42501';
  end if;

  execute pg_catalog.format(
    'select s.id, s.name, s.created_at, s.owner_user_id
       from public.%I s
      where s.id = $1 and s.organisation_id = $2 and s.deleted_at is null',
    v_table)
    into v_subject
    using p_entity_id, p_organisation_id;

  if v_subject.id is null then
    raise exception 'duplicate screening not permitted for this caller in this workspace'
      using errcode = '42501';
  end if;

  for v_match in
    select * from private.duplicate_probe(p_organisation_id, p_entity_type, p_entity_id, false)
  loop
    -- OLDER RECORD WINS. created_at, with id as the tie-break so the pair is
    -- ordered deterministically even for two rows written in the same
    -- microsecond -- which matters because merge_candidates_open_pair_idx is
    -- keyed on (keep_id, duplicate_id) and an unstable order would let the same
    -- pair be flagged twice, once each way round.
    if (v_match.created_at, v_match.id) < (v_subject.created_at, v_subject.id) then
      v_keep := v_match.id;   v_dup := v_subject.id;
    else
      v_keep := v_subject.id; v_dup := v_match.id;
    end if;

    insert into public.merge_candidates (
      organisation_id, entity_type, keep_id, duplicate_id,
      keep_owner_user_id, duplicate_owner_user_id,
      label, reason, similarity
    )
    values (
      p_organisation_id, p_entity_type, v_keep, v_dup,
      case when v_keep = v_subject.id then v_subject.owner_user_id else v_match.owner_user_id end,
      case when v_dup  = v_subject.id then v_subject.owner_user_id else v_match.owner_user_id end,
      v_subject.name,
      v_match.reason,
      v_match.similarity
    )
    -- ALREADY FLAGGED IS NOT AN ERROR. Screening is idempotent by design: it
    -- runs on every create, and creating the same duplicate twice must not fail
    -- the second create.
    on conflict (organisation_id, entity_type, keep_id, duplicate_id)
      where deleted_at is null
      do nothing;

    -- Counted only if this caller could actually see it. entity_is_visible on
    -- the OTHER record is the whole test -- the subject is theirs by the gate
    -- above.
    if private.entity_is_visible(p_entity_type, v_match.id, p_organisation_id) then
      v_flagged := v_flagged + 1;
    end if;

    -- AUTO-MERGE: EMAIL ONLY, BOTH SIDES MANAGEABLE, FIRST MATCH ONLY.
    -- duplicate_probe orders exact-email matches first and then by age, so the
    -- first one is the oldest exact match. One pair per call: a merge is a
    -- transaction the caller performs, and chaining several unattended is how a
    -- run of near-duplicates collapses into one record nobody chose.
    if v_auto_w is null
       and v_match.reason = 'exact_email'
       and private.entity_is_manageable(p_entity_type, v_match.id, p_organisation_id)
    then
      v_auto_w := v_keep;
      v_auto_l := v_dup;
    end if;
  end loop;

  return jsonb_build_object(
    'flagged', v_flagged,
    'auto_merge_winner_id', v_auto_w,
    'auto_merge_loser_id',  v_auto_l
  );
end;
$$;

comment on function public.screen_for_duplicates(uuid, text, uuid) is
  'Duplicate detection for one record, and the SOLE writer into public.merge_candidates (no INSERT grant, no INSERT policy). SECURITY DEFINER because a duplicate the caller cannot see is exactly the one that must reach a full-scope reviewer -- it probes unscoped and flags silently. Its own gate: entity_is_manageable() on the subject (you may screen what you may write) and crm_write_organisations() (Q6: a suspended workspace may read the queue and not add to it). Returns {flagged, auto_merge_winner_id, auto_merge_loser_id}; `flagged` counts ONLY candidates this caller can see, because a count including the others would be an existence oracle. auto_merge_* is populated ONLY for a case-insensitive email match with both records manageable by the caller, older record winning -- and the CALLER performs the merge, because public.merge_records() is SECURITY INVOKER and calling it from inside this definer body would run every CRM statement as postgres with RLS not applied.';

revoke all on function public.screen_for_duplicates(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.screen_for_duplicates(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. public.merge_records() -- the merge itself.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, and that is the whole security argument, exactly as
-- set_artist_primary_representation() states it: every statement below runs as
-- the caller and is decided by the same policies a PostgREST request would
-- meet. Nothing here grants anything. What it adds is ATOMICITY -- a function
-- body runs inside the caller's transaction, and a merge is nine statements
-- that must not half-apply -- and the ORDER those statements have to be in.
--
-- ===========================================================================
-- THE ORDER, AND WHY EACH STEP IS WHERE IT IS
-- ===========================================================================
--   1. read both rows           through the caller's own RLS, so a record
--                               outside their scope is simply not there and
--                               the merge refuses. Also the last moment the
--                               loser's values exist to be recorded.
--   2. resolve the fields       in memory. No writes yet, so a bad choice
--                               fails before anything has moved.
--   3. LINKS: drop, demote,     BEFORE the repoint, because
--      promote, repoint         contact_companies_one_primary_per_contact and
--                               artist_representations_one_current_primary_per_artist
--                               are NOT DEFERRABLE -- FOLLOW-UPS' obligation
--                               (a). The plain repoint raises 23505 whenever
--                               both records have a primary, and
--                               contact_companies_contact_company_unique
--                               raises it whenever both link the same company.
--   4. custom fields: CARRY     BEFORE the sweep, obviously; and the sweep
--      then SWEEP               BEFORE the soft-delete, which is NOT obvious
--                               and is not the reason FOLLOW-UPS gives. See
--                               DECISION 4 in this file's header:
--                               custom_field_values_delete_via_entity now
--                               carries entity_is_live(), so the loser's values
--                               become undeletable by every client role the
--                               instant the loser is soft-deleted.
--   5. update the winner        after the links, so a failure there does not
--                               leave a rewritten winner behind.
--   6. soft-delete the loser    last of the data movement.
--   7. record the merge         private.record_merge(), which writes the
--                               merges row; the audit_events row is written by
--                               the audit_insert trigger on that table.
--   8. resolve the queue        the pair as 'merged', anything else naming the
--                               loser as 'dismissed'.
--
-- ===========================================================================
-- EVERY REFUSAL RAISES. NOTHING IS SIGNALLED BY A LOW ROW COUNT.
-- ===========================================================================
-- lib/crm/write.ts exists because a refused UPDATE is a 204 with a row count of
-- 0 and no error, and the brief names a merge that reports success without
-- applying as the worst instance of that class in the phase. Inside a function
-- the ambiguity is avoidable, so:
--
--   * each repoint COUNTS THE ROWS IT CAN SEE FIRST and compares. The SELECT
--     policies on the join tables are gated on view_crm while their UPDATE
--     policies are gated on manage_*, so "I can see six links and moved four"
--     is a reachable, silent, half-done merge. It now raises.
--   * the winner update and the loser soft-delete must each affect exactly one
--     row.
--   * the custom-field sweep is compared against what was there.
--   * private.record_merge() raises 42501 rather than returning null.
--
-- Raising rolls the whole thing back, so `error is null` from the client means
-- every part of the merge applied.
--
-- ===========================================================================
-- STRANDED LINKS, and why they are counted rather than raised on.
-- ===========================================================================
-- Three of the join-table UPDATE policies require the PARENT to be live:
-- contact_companies via its contact, artist_representations and venue_rooms via
-- their artist and venue. When the merge repoints the OTHER end -- a company
-- merge moving contact_companies.company_id, an agency merge moving
-- artist_representations.agency_id, a contact merge moving
-- artist_representations.contact_id -- rows whose parent is SOFT-DELETED are
-- visible and not updatable. Raising would make an agency unmergeable forever
-- because one artist who once used it has since been deleted, which is worse
-- than the alternative: those rows keep pointing at the loser, the loser is
-- only soft-deleted so the pointer still resolves, and the count is recorded in
-- field_resolution as `stranded` so the support path in DECISION 5 can find
-- them. The comparison above therefore excludes them by construction: what is
-- counted is what is updatable.
create or replace function public.merge_records(
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
  v_table     text := private.dedup_entity_table(p_entity_type);
  v_cols      text[];
  v_col       text;
  v_choice    text;
  v_winner    jsonb;
  v_loser     jsonb;
  v_new       jsonb := '{}'::jsonb;
  v_fields    jsonb := '{}'::jsonb;
  v_cf        jsonb := '{}'::jsonb;
  v_links     jsonb := '{}'::jsonb;
  v_set       text;
  v_rows      integer;
  v_seen      integer;
  v_dropped   integer := 0;
  v_demoted   integer := 0;
  v_promoted  integer := 0;
  v_stranded  integer := 0;
  v_cf_seen   integer;
  v_cf_moved  integer;
  v_winner_primary boolean;
  v_lost      uuid[] := '{}'::uuid[];
  v_promote   uuid[] := '{}'::uuid[];
  v_merge_id  uuid;
begin
  if v_table is null then
    raise exception 'merge_records: unknown entity_type %', p_entity_type
      using errcode = '22023';
  end if;
  if p_winner_id is null or p_loser_id is null or p_winner_id = p_loser_id then
    raise exception 'merge_records: the winner and the loser must be two different records'
      using errcode = '22023';
  end if;
  if p_organisation_id is null then
    raise exception 'merge_records: p_organisation_id is required' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_field_choices, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_custom_field_choices, '{}'::jsonb)) <> 'object' then
    raise exception 'merge_records: the choice arguments must be jsonb objects'
      using errcode = '22023';
  end if;

  -- 1. BOTH ROWS, THROUGH THE CALLER'S OWN RLS. A record the caller may not
  -- read is simply absent, and the merge refuses with the same code and the
  -- same sentence as one they may not write -- the tenant-isolation rule.
  -- BOTH must be LIVE: merging into or out of an already soft-deleted record
  -- produces a merge history entry describing something that did not happen.
  execute pg_catalog.format(
    'select pg_catalog.to_jsonb(t) from public.%I t
      where t.id = $1 and t.organisation_id = $2 and t.deleted_at is null',
    v_table) into v_winner using p_winner_id, p_organisation_id;
  execute pg_catalog.format(
    'select pg_catalog.to_jsonb(t) from public.%I t
      where t.id = $1 and t.organisation_id = $2 and t.deleted_at is null',
    v_table) into v_loser using p_loser_id, p_organisation_id;

  if v_winner is null or v_loser is null then
    raise exception 'merge_records: both records must be live and readable by this caller in this workspace'
      using errcode = '42501';
  end if;

  -- 2. RESOLVE THE FIELDS. Default: the winner keeps its own value, EXCEPT
  -- where the winner has nothing and the loser has something -- carrying that
  -- across is the difference between a merge and a delete, and making the user
  -- tick a box for every empty field is how they stop reading the screen.
  v_cols := private.dedup_mergeable_columns(p_entity_type);
  foreach v_col in array v_cols loop
    v_choice := coalesce(p_field_choices ->> v_col, '');
    if v_choice not in ('winner', 'loser') then
      -- The winner keeps its own value unless it HAS none and the loser HAS
      -- one. Both halves matter: without the second, two null columns are
      -- recorded as "taken from the loser", which is true and useless -- the
      -- audit summary then lists every empty column on the record as a field
      -- the merge moved, and a reader cannot find the ones that really moved.
      v_choice := case
        when (v_winner -> v_col) is null
             or pg_catalog.jsonb_typeof(v_winner -> v_col) = 'null'
        then case
          when (v_loser -> v_col) is null
               or pg_catalog.jsonb_typeof(v_loser -> v_col) = 'null'
          then 'winner' else 'loser' end
        else 'winner' end;
    end if;
    v_new := v_new || pg_catalog.jsonb_build_object(
      v_col, case v_choice when 'loser' then v_loser -> v_col else v_winner -> v_col end);
    v_fields := v_fields || pg_catalog.jsonb_build_object(v_col,
      pg_catalog.jsonb_build_object(
        'from',      v_choice,
        'chosen',    case v_choice when 'loser' then v_loser -> v_col else v_winner -> v_col end,
        'discarded', case v_choice when 'loser' then v_winner -> v_col else v_loser -> v_col end));
  end loop;

  -- 3. LINKS. Per entity type, and the demote/drop always before the repoint.
  if p_entity_type = 'contact' then
    -- contact_companies, moving contact_id.
    select pg_catalog.count(*) into v_seen from public.contact_companies l
     where l.organisation_id = p_organisation_id and l.contact_id = p_loser_id;

    select coalesce(pg_catalog.array_agg(l.company_id), '{}'::uuid[]) into v_lost
      from public.contact_companies l
     where l.organisation_id = p_organisation_id and l.contact_id = p_loser_id and l.is_primary
       and exists (select 1 from public.contact_companies w
                    where w.organisation_id = p_organisation_id
                      and w.contact_id = p_winner_id and w.company_id = l.company_id);

    select exists (select 1 from public.contact_companies w
                    where w.organisation_id = p_organisation_id
                      and w.contact_id = p_winner_id and w.is_primary)
      into v_winner_primary;

    -- contact_companies_contact_company_unique: the loser's link to a company
    -- the winner already links to is a duplicate row, not a row to repoint.
    delete from public.contact_companies l
     where l.organisation_id = p_organisation_id and l.contact_id = p_loser_id
       and exists (select 1 from public.contact_companies w
                    where w.organisation_id = p_organisation_id
                      and w.contact_id = p_winner_id and w.company_id = l.company_id);
    get diagnostics v_dropped = row_count;

    -- The winner's primary always survives. If it has none and the loser's was
    -- dropped as a duplicate above, the winner's own link to that company
    -- inherits it -- otherwise a merge silently leaves the contact with no
    -- primary company at all.
    if v_winner_primary then
      update public.contact_companies l set is_primary = false
       where l.organisation_id = p_organisation_id and l.contact_id = p_loser_id and l.is_primary;
      get diagnostics v_demoted = row_count;
    elsif pg_catalog.array_length(v_lost, 1) > 0 then
      update public.contact_companies w set is_primary = true
       where w.organisation_id = p_organisation_id and w.contact_id = p_winner_id
         and w.company_id = any(v_lost);
      get diagnostics v_promoted = row_count;
    end if;

    update public.contact_companies l set contact_id = p_winner_id
     where l.organisation_id = p_organisation_id and l.contact_id = p_loser_id;
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen - v_dropped then
      raise exception 'merge_records: % of % contact_companies links repointed', v_rows, v_seen - v_dropped
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('contact_companies',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', v_dropped,
                                    'demoted', v_demoted, 'promoted', v_promoted, 'stranded', 0));

    -- artist_representations, moving contact_id. Gated on the ARTIST parent
    -- being live, so representations of a soft-deleted artist are visible and
    -- not updatable -- counted as stranded rather than raised on.
    select pg_catalog.count(*) filter (where a.deleted_at is null),
           pg_catalog.count(*) filter (where a.deleted_at is not null)
      into v_seen, v_stranded
      from public.artist_representations r
      join public.artists a on a.id = r.artist_id
     where r.organisation_id = p_organisation_id and r.contact_id = p_loser_id;
    update public.artist_representations r set contact_id = p_winner_id
     where r.organisation_id = p_organisation_id and r.contact_id = p_loser_id
       and exists (select 1 from public.artists a
                    where a.id = r.artist_id and a.deleted_at is null);
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen then
      raise exception 'merge_records: % of % artist_representations contact links repointed', v_rows, v_seen
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('artist_representations_contact',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', 0,
                                    'demoted', 0, 'promoted', 0, 'stranded', v_stranded));

  elsif p_entity_type = 'company' then
    -- contact_companies, moving company_id. The unique index is
    -- (contact_id, company_id), so the collision is a contact linked to both
    -- companies. The is_primary index is keyed on contact_id, and both links
    -- belong to the SAME contact, so at most one of the pair can be primary.
    select pg_catalog.count(*) filter (where c.deleted_at is null),
           pg_catalog.count(*) filter (where c.deleted_at is not null)
      into v_seen, v_stranded
      from public.contact_companies l
      join public.contacts c on c.id = l.contact_id
     where l.organisation_id = p_organisation_id and l.company_id = p_loser_id;

    -- Contacts whose LOSER-side link is primary and who also link to the
    -- winner: the loser-side row is about to be deleted, so the winner-side row
    -- inherits the flag afterwards.
    select coalesce(pg_catalog.array_agg(l.contact_id), '{}'::uuid[]) into v_promote
      from public.contact_companies l
     where l.organisation_id = p_organisation_id and l.company_id = p_loser_id and l.is_primary
       and exists (select 1 from public.contact_companies w
                    where w.organisation_id = p_organisation_id
                      and w.company_id = p_winner_id and w.contact_id = l.contact_id);

    delete from public.contact_companies l
     where l.organisation_id = p_organisation_id and l.company_id = p_loser_id
       and exists (select 1 from public.contact_companies w
                    where w.organisation_id = p_organisation_id
                      and w.company_id = p_winner_id and w.contact_id = l.contact_id);
    get diagnostics v_dropped = row_count;

    if pg_catalog.array_length(v_promote, 1) > 0 then
      update public.contact_companies w set is_primary = true
       where w.organisation_id = p_organisation_id and w.company_id = p_winner_id
         and w.contact_id = any(v_promote);
      get diagnostics v_promoted = row_count;
    end if;

    update public.contact_companies l set company_id = p_winner_id
     where l.organisation_id = p_organisation_id and l.company_id = p_loser_id
       and exists (select 1 from public.contacts c
                    where c.id = l.contact_id and c.deleted_at is null);
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen - v_dropped then
      raise exception 'merge_records: % of % contact_companies links repointed', v_rows, v_seen - v_dropped
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('contact_companies',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', v_dropped,
                                    'demoted', 0, 'promoted', v_promoted, 'stranded', v_stranded));

  elsif p_entity_type = 'artist' then
    -- artist_representations, moving artist_id. THE 23505 OBLIGATION (a):
    -- artist_representations_one_current_primary_per_artist is partial on
    -- (is_primary and ended_at is null and deleted_at is null) and is not
    -- deferrable, so if both artists have a CURRENT primary the plain repoint
    -- raises. The demote carries the index's predicate exactly, for the reason
    -- set_artist_primary_representation() gives at length: a demote that
    -- ignored ended_at would rewrite the artist's representation history.
    select pg_catalog.count(*) into v_seen from public.artist_representations r
     where r.organisation_id = p_organisation_id and r.artist_id = p_loser_id;

    select exists (select 1 from public.artist_representations w
                    where w.organisation_id = p_organisation_id and w.artist_id = p_winner_id
                      and w.is_primary and w.ended_at is null and w.deleted_at is null)
      into v_winner_primary;

    if v_winner_primary then
      update public.artist_representations l set is_primary = false
       where l.organisation_id = p_organisation_id and l.artist_id = p_loser_id
         and l.is_primary and l.ended_at is null and l.deleted_at is null;
      get diagnostics v_demoted = row_count;
    end if;

    update public.artist_representations l set artist_id = p_winner_id
     where l.organisation_id = p_organisation_id and l.artist_id = p_loser_id;
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen then
      raise exception 'merge_records: % of % artist_representations repointed', v_rows, v_seen
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('artist_representations',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', 0,
                                    'demoted', v_demoted, 'promoted', 0, 'stranded', 0));

    select pg_catalog.count(*) into v_seen from public.artist_fee_history f
     where f.organisation_id = p_organisation_id and f.artist_id = p_loser_id;
    update public.artist_fee_history f set artist_id = p_winner_id
     where f.organisation_id = p_organisation_id and f.artist_id = p_loser_id;
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen then
      raise exception 'merge_records: % of % artist_fee_history rows repointed', v_rows, v_seen
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('artist_fee_history',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', 0,
                                    'demoted', 0, 'promoted', 0, 'stranded', 0));

  elsif p_entity_type = 'agency' then
    -- artist_representations, moving agency_id. No unique index involves
    -- agency_id, so there is nothing to drop and nothing to demote; the parent
    -- artist must be live for the UPDATE policy, hence `stranded`.
    select pg_catalog.count(*) filter (where a.deleted_at is null),
           pg_catalog.count(*) filter (where a.deleted_at is not null)
      into v_seen, v_stranded
      from public.artist_representations r
      join public.artists a on a.id = r.artist_id
     where r.organisation_id = p_organisation_id and r.agency_id = p_loser_id;
    update public.artist_representations r set agency_id = p_winner_id
     where r.organisation_id = p_organisation_id and r.agency_id = p_loser_id
       and exists (select 1 from public.artists a
                    where a.id = r.artist_id and a.deleted_at is null);
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen then
      raise exception 'merge_records: % of % artist_representations agency links repointed', v_rows, v_seen
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('artist_representations_agency',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', 0,
                                    'demoted', 0, 'promoted', 0, 'stranded', v_stranded));

  elsif p_entity_type = 'venue' then
    -- venue_rooms, moving venue_id. No unique index on (venue_id, name), so two
    -- rooms called "Main Room" survive as two rooms -- which is the honest
    -- outcome: the merge screen cannot know whether they are the same room.
    select pg_catalog.count(*) into v_seen from public.venue_rooms r
     where r.organisation_id = p_organisation_id and r.venue_id = p_loser_id;
    update public.venue_rooms r set venue_id = p_winner_id
     where r.organisation_id = p_organisation_id and r.venue_id = p_loser_id;
    get diagnostics v_rows = row_count;
    if v_rows <> v_seen then
      raise exception 'merge_records: % of % venue_rooms repointed', v_rows, v_seen
        using errcode = '42501';
    end if;
    v_links := v_links || pg_catalog.jsonb_build_object('venue_rooms',
      pg_catalog.jsonb_build_object('seen', v_seen, 'repointed', v_rows, 'dropped', 0,
                                    'demoted', 0, 'promoted', 0, 'stranded', 0));
  end if;

  -- 4. CUSTOM FIELD VALUES: record, carry, then sweep.
  --
  -- FOLLOW-UPS' obligation (b) names the sweep. It also asks what a merge
  -- SHOULD do with the values first, and answers that discarding them silently
  -- is the wrong default for a workflow whose whole purpose is not losing data.
  -- So the default is CARRY WHERE THE WINNER HAS NOTHING, and everything -- kept
  -- or discarded -- goes into field_resolution before anything is deleted.
  select pg_catalog.jsonb_object_agg(v.field_id::text,
           pg_catalog.jsonb_build_object('loser', v.value))
    into v_cf
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type = p_entity_type
     and v.entity_id = p_loser_id;
  v_cf := coalesce(v_cf, '{}'::jsonb);

  select pg_catalog.count(*) into v_cf_seen
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type = p_entity_type
     and v.entity_id = p_loser_id;

  insert into public.custom_field_values
    (organisation_id, field_id, entity_type, entity_id, value)
  select l.organisation_id, l.field_id, l.entity_type, p_winner_id, l.value
    from public.custom_field_values l
   where l.organisation_id = p_organisation_id
     and l.entity_type = p_entity_type
     and l.entity_id = p_loser_id
     and (
       coalesce(p_custom_field_choices ->> l.field_id::text, '') = 'loser'
       or not exists (select 1 from public.custom_field_values w
                       where w.organisation_id = p_organisation_id
                         and w.field_id = l.field_id
                         and w.entity_id = p_winner_id)
     )
  on conflict (field_id, entity_id) do update set value = excluded.value;
  get diagnostics v_cf_moved = row_count;

  -- THE SWEEP. custom_field_values.entity_id is polymorphic and cannot cascade,
  -- the table has no deleted_at, and `value` holds user-entered CRM content --
  -- so an unswept loser leaves rows nothing will ever resolve again, which is a
  -- retention and erasure problem rather than tidiness. It runs BEFORE the
  -- soft-delete: see DECISION 4.
  delete from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type = p_entity_type
     and v.entity_id = p_loser_id;
  get diagnostics v_rows = row_count;
  if v_rows <> v_cf_seen then
    raise exception 'merge_records: % of % custom field values swept off the loser', v_rows, v_cf_seen
      using errcode = '42501';
  end if;

  -- 5. THE WINNER'S SURVIVING VALUES. jsonb_populate_record does every type
  -- conversion (text[], jsonb, integer) from values that came out of
  -- to_jsonb(row) in step 1, so nothing is parsed from a string and no cast is
  -- written by hand. The SET list is built from
  -- private.dedup_mergeable_columns() and quote_ident(), so no identifier in it
  -- comes from the request.
  select pg_catalog.string_agg(
           pg_catalog.quote_ident(c) || ' = s.' || pg_catalog.quote_ident(c), ', ')
    into v_set
    from pg_catalog.unnest(v_cols) c;

  if v_set is not null then
    execute pg_catalog.format(
      'update public.%1$I t set %2$s
         from pg_catalog.jsonb_populate_record(null::public.%1$I, $1) s
        where t.id = $2 and t.organisation_id = $3 and t.deleted_at is null',
      v_table, v_set)
      using v_new, p_winner_id, p_organisation_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'merge_records: the winner was not updatable by this caller in this workspace'
        using errcode = '42501';
    end if;
  end if;

  -- 6. THE LOSER. Soft delete -- DECISION 4.
  execute pg_catalog.format(
    'update public.%I set deleted_at = pg_catalog.now()
      where id = $1 and organisation_id = $2 and deleted_at is null',
    v_table) using p_loser_id, p_organisation_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'merge_records: the loser was not deletable by this caller in this workspace'
      using errcode = '42501';
  end if;

  -- 7. THE RECORD OF IT. private.record_merge() re-establishes the whole of the
  -- dropped INSERT policy, pins merged_by, and writes the SECOND audit row --
  -- the one the audit_insert trigger on public.merges cannot write, because the
  -- winner's field rewrite is an UPDATE on a table nothing audits.
  --
  -- THE AUDIT SUMMARY IS PROJECTED HERE, not there, and it carries column NAMES
  -- and counts and no values at all. audit_events is superuser-readable and
  -- CLAUDE.md § Superuser dashboard keeps tenant record content off that
  -- surface; private.audit_crm_payload() is the same rule written as an
  -- allowlist for the trigger's half. field_resolution, which DOES carry the
  -- values, is on public.merges behind a policy requiring both records to be
  -- visible -- a different surface with a different audience, which is the
  -- whole reason the two rows exist.
  v_merge_id := private.record_merge(
    p_organisation_id, p_entity_type, p_winner_id, p_loser_id,
    (v_winner ->> 'owner_user_id')::uuid,
    (v_loser  ->> 'owner_user_id')::uuid,
    pg_catalog.jsonb_build_object(
      'version', 1,
      'entity_type', p_entity_type,
      'winner', pg_catalog.jsonb_build_object('id', p_winner_id, 'before', v_winner),
      'loser',  pg_catalog.jsonb_build_object('id', p_loser_id,  'before', v_loser),
      'fields', v_fields,
      'custom_fields', pg_catalog.jsonb_build_object(
        'carried', v_cf_moved, 'swept', v_cf_seen, 'values', v_cf),
      'links', v_links
    ),
    pg_catalog.jsonb_build_object(
      'entity_type', p_entity_type,
      'winner_id', p_winner_id,
      'loser_id',  p_loser_id,
      'fields_taken_from_loser', (
        select coalesce(pg_catalog.jsonb_agg(k.key order by k.key), '[]'::jsonb)
          from pg_catalog.jsonb_each(v_fields) k
         where k.value ->> 'from' = 'loser'),
      'custom_fields_carried', v_cf_moved,
      'custom_fields_swept',   v_cf_seen,
      'links', v_links
    ));

  -- 8. THE QUEUE. The pair is resolved as 'merged'; anything else still open
  -- against the loser is 'dismissed', because a candidate pairing a record that
  -- no longer exists with a third one is not a question anybody can answer.
  -- Neither statement raises on 0: a candidate whose OTHER record this caller
  -- cannot manage is simply left alone, and most merges have no candidate row
  -- at all.
  update public.merge_candidates c
     set deleted_at = pg_catalog.now(), resolution = 'merged',
         resolved_by = (select auth.uid())
   where c.organisation_id = p_organisation_id
     and c.entity_type = p_entity_type
     and c.deleted_at is null
     and ((c.keep_id = p_winner_id and c.duplicate_id = p_loser_id)
       or (c.keep_id = p_loser_id and c.duplicate_id = p_winner_id));

  update public.merge_candidates c
     set deleted_at = pg_catalog.now(), resolution = 'dismissed',
         resolved_by = (select auth.uid())
   where c.organisation_id = p_organisation_id
     and c.entity_type = p_entity_type
     and c.deleted_at is null
     and (c.keep_id = p_loser_id or c.duplicate_id = p_loser_id);

  return v_merge_id;
end;
$$;

comment on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb) is
  'Merge two records of one entity type in one transaction, and the only sanctioned way to do it. SECURITY INVOKER: every statement is decided by the caller''s own policies, so this grants nothing and adds atomicity and ORDER. The order is load-bearing -- drop/demote/promote BEFORE repointing, because contact_companies_one_primary_per_contact, contact_companies_contact_company_unique and artist_representations_one_current_primary_per_artist are non-deferrable and a plain repoint raises 23505; carry custom field values, then SWEEP them, then soft-delete the loser, because custom_field_values_delete_via_entity carries entity_is_live() since 20260829011000 and a soft-deleted loser''s values are undeletable by every client role. p_organisation_id is mandatory with no overload without it (PostgREST resolves by argument name). p_field_choices maps a column to ''winner''/''loser''; anything else, or an absent key, means the winner keeps its value UNLESS the winner''s is null, in which case the loser''s is carried. EVERY REFUSAL RAISES -- each repoint counts the rows it can see and compares, because the join tables'' SELECT policies are gated on view_crm while their UPDATE policies are gated on manage_*, so a partial merge is otherwise silent. Rows whose parent is soft-deleted are not updatable and are recorded as `stranded` rather than raised on. Returns the merges.id.';

revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 12. The five indexes built for this task, and their drop condition.
-- ---------------------------------------------------------------------------
-- 20260828190000 wrote the drop condition onto the trigram indexes themselves:
-- "Drop it if Task 6 ships dedup without a SECURITY DEFINER path -- at that
-- point it has no reachable consumer at all." IT DID NOT. private.duplicate_
-- probe() is that path, and it is the only consumer -- so the condition is
-- discharged and all five are kept. The comments are rewritten to say so,
-- because a drop condition that has been met or missed and still reads as an
-- open question is the kind of note that gets acted on years later by someone
-- who cannot check.
comment on index public.contacts_name_trgm_idx is
  'Fuzzy duplicate detection, and nothing else. CONSUMER SHIPPED (Phase 2 Task 6): private.duplicate_probe() reaches it -- SECURITY DEFINER owned by the table owner, which is the only context where pg_trgm''s non-leakproof % can become an index qual at all. Measured 196x (0.159 ms against 31.233 ms over 20 calls). NOT used by the contacts list''s search, which is ILIKE under RLS and is O(tenant) by construction (Task 3). The earlier drop condition -- "drop it if Task 6 ships dedup without a SECURITY DEFINER path" -- is discharged.';
comment on index public.companies_name_trgm_idx is
  'Fuzzy duplicate detection. CONSUMER SHIPPED (Phase 2 Task 6): private.duplicate_probe(). See contacts_name_trgm_idx for the measurement and the leakproofness argument. Drop condition discharged.';
comment on index public.artists_name_trgm_idx is
  'Fuzzy duplicate detection. CONSUMER SHIPPED (Phase 2 Task 6): private.duplicate_probe(). See contacts_name_trgm_idx. Drop condition discharged.';
comment on index public.venues_name_trgm_idx is
  'Fuzzy duplicate detection. CONSUMER SHIPPED (Phase 2 Task 6): private.duplicate_probe(). See contacts_name_trgm_idx. Drop condition discharged.';
comment on index public.agencies_name_trgm_idx is
  'Fuzzy duplicate detection for agencies, added by Phase 2 Task 6. The other four were created in 20260827232510 and agencies was omitted, which left one of the five dedup-able entity types on a sequential scan while the rest were index lookups. Same shape, same partial predicate, same consumer: private.duplicate_probe().';
comment on index public.contacts_org_email_lower_idx is
  'The EXACT-match half of duplicate detection: case-insensitive email equality within one organisation, over live rows only. CONSUMER SHIPPED (Phase 2 Task 6): private.duplicate_probe(), and it is the index behind the ONLY auto-merge this product performs. Contacts are the only one of the five entity types with an email column, which is why auto-merge is contacts-only -- see 20260829020000''s DECISION 1.';
