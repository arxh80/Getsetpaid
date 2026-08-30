-- ===========================================================================
-- An empty email address is not an email address.
-- ===========================================================================
-- Final review I-5 (deferred-minor L945).
--
-- THE DEFECT. `private.duplicate_probe`'s exact-email predicate was
-- `subject.email is not null and lower(e.email) = lower(subject.email)`. Two
-- contacts both holding `''` satisfy it: `''` is not null, and `lower('')`
-- equals `lower('')`. They were labelled `exact_email`, sorted first by the
-- ORDER BY (which carried the same predicate), and `screen_for_duplicates`
-- proposed them for auto-merge -- which lib/crm/dedup.ts then performs
-- UNATTENDED. Auto-merge is the one path in Phase 2 that soft-deletes a record
-- and rewrites another with no human confirming it, so a predicate that can
-- match two unrelated records on the absence of data is the worst place in the
-- phase for this class of bug.
--
-- WHY IT WAS NOT REACHABLE THROUGH THE PRODUCT. `lib/forms.ts`'s `field()`
-- normalises `""` to null, so no form can create the state. A direct PostgREST
-- PATCH with the anon key, an import, or a future integration can, and
-- `contacts.email` carried no CHECK.
--
-- TWO LAYERS, BOTH ADDITIVE, AND THEY COVER DIFFERENT THINGS.
--
--   1. The CHECK below makes `''` unrepresentable, closing the exact case the
--      review named at the point where the data enters. It is `<> ''` rather
--      than `btrim(...) <> ''` deliberately: `field()` already normalises the
--      empty string and nothing else, so this constraint rejects exactly what
--      the application already refuses to write and does not start rejecting
--      addresses a user typed with a stray space.
--   2. The predicate below ignores an all-WHITESPACE subject email as well,
--      which the CHECK deliberately permits. `'   '` and `'   '` are as
--      unrelated as `''` and `''`, and the guard belongs in the matcher rather
--      than as an ever-widening constraint on stored data.
--
-- Both are needed: layer 1 without layer 2 leaves whitespace matching; layer 2
-- without layer 1 leaves `''` in the database for every other reader of the
-- column to think about. The suite asserts both, and asserts the positive
-- control -- a real matching pair is STILL `exact_email` -- because "no pair
-- is ever labelled exact_email" is also satisfied by a predicate that is
-- simply broken.
--
-- ADDITIVE, per CLAUDE.md § Git workflow and this repository's migration rule:
-- `create or replace function` on the shipped signature and
-- `alter table ... add constraint`. 20260829020000 is applied and is not
-- edited. The four other entity types have no email column at all and take the
-- second branch of this function, which is unchanged.
-- ===========================================================================

alter table public.contacts
  add constraint contacts_email_not_empty
  check (email is null or email <> '');

comment on constraint contacts_email_not_empty on public.contacts is
  'An empty string is not an address. lib/forms.ts field() already normalises "" to null on every form path, so this closes the direct-PostgREST/import path -- which mattered because private.duplicate_probe''s exact-email predicate treated two "" emails as an exact match and screen_for_duplicates proposed them for UNATTENDED auto-merge (final review I-5). Deliberately not btrim(): whitespace-only is handled in the matcher, not by widening a constraint on stored data.';

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
                   and pg_catalog.btrim(subject.email) <> ''
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
             and pg_catalog.btrim(subject.email) <> ''
             and pg_catalog.lower(e.email) = pg_catalog.lower(subject.email) )
           or ( e.name operator(extensions.%%) subject.name
                and extensions.similarity(e.name, subject.name)
                    >= private.dedup_similarity_threshold() )
         )
       -- Exact email first, then most similar, then oldest. The first row is
       -- therefore the auto-merge candidate when there is one.
       order by (case when subject.email is not null
                       and pg_catalog.btrim(subject.email) <> ''
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

-- The comment is re-stated because `create or replace function` keeps the old
-- one, and the old one did not mention the empty-email rule.
comment on function private.duplicate_probe(uuid, text, uuid, boolean) is
  'The dedup search. SECURITY DEFINER because pg_trgm''s % is not leakproof and therefore can never be an index qual for a caller RLS applies to -- measured 196x. The body re-establishes the WHOLE policy, not just membership: permitted_organisations(''view_crm'') (role mapping + aal2 + Q6 suspension), row-level tenant equality, the record-scope disjunction (when p_scoped), and the soft-delete filter RLS deliberately does not apply. NO organisation deleted_at test anywhere: Q6 makes suspension read-only and this is a read, so the answer must be whatever permitted_organisations() gives. When p_scoped, the record-scope disjunction is applied to the SUBJECT as well as to the matches: without that a record-scoped caller can ask about a record they cannot see and learn, from which of their own records come back, that it exists and roughly what it is called. GRANTED TO NOBODY -- p_scoped => false returns rows outside the caller''s record scope, which is correct for the flagging path and a leak for any other, so only its two SECURITY DEFINER callers can reach it. The exact-email predicate requires a NON-BLANK subject address at all three sites it appears (the reason label, the WHERE, and the ORDER BY): '''' is not null and lower('''') = lower(''''), so without that guard two contacts holding an empty email were labelled exact_email and proposed for unattended auto-merge (final review I-5).';

-- `create or replace function` preserves the existing ACL, so this is a
-- restatement rather than a change. It is here because the grant state of this
-- function is the whole reason it is safe to give it `p_scoped => false`, and a
-- migration that replaces the body without saying so reads as if it might have
-- reset it.
revoke all on function private.duplicate_probe(uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;
