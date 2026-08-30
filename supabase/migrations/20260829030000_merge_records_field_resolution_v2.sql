-- ===========================================================================
-- Phase 2 Task 6, fix round 1 -- I-1: a merge could destroy a custom field
-- value with nothing recording it.
-- ===========================================================================
-- Additive. `20260829020000` is not edited; this replaces one function body.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- `public.merge_records()` built the custom-field half of
-- `merges.field_resolution` from the LOSER's rows only:
--
--     {"<field id>": {"loser": <the loser's value>}}
--
-- and the carry-over ends `on conflict (field_id, entity_id) do update set
-- value = excluded.value`. So when `p_custom_field_choices` named 'loser' for
-- a field THE WINNER ALSO HELD, the winner's value was overwritten and
-- appeared nowhere afterwards -- no `from`, no `chosen`, no `discarded`. The
-- ordinary columns had all three (`v_fields`) and the custom fields did not.
--
-- IT IS REACHABLE FROM THE FIRST MERGE ANYBODY PERFORMS. The merge screen
-- renders a radio per differing custom field; choosing the left-hand value on
-- a field both records hold is the whole point of the screen.
--
-- WHAT IT BREAKS, precisely, is the thing that stands in for an undo.
-- `20260829020000`'s DECISION 5 says the support path is: read the one merges
-- row, restore the loser, rewrite the winner's columns from
-- `field_resolution.winner.before`, and re-file the loser's custom field
-- values from `field_resolution.custom_fields.values`. That last step would
-- have re-filed OVER a winner value that no longer existed anywhere in the
-- database, and the engineer would have had no way to know they had done it.
--
-- ===========================================================================
-- THE FIX, AND THE SHAPE CHANGE IT MAKES
-- ===========================================================================
-- A FULL JOIN over both records' values, producing the same three keys the
-- ordinary columns use:
--
--     {"<field id>": {"from": "winner"|"loser",
--                     "chosen": <value>, "discarded": <value>}}
--
-- Every field either record holds gets an entry, including ones only the
-- winner holds (`from: winner`, `discarded: null`) -- consistent with `fields`,
-- which records every mergeable column whether or not it moved.
--
-- `field_resolution.version` goes 1 -> 2 with it. Rows already written stay at
-- 1 and stay in the v1 shape, because `merges` is append-only and there is no
-- UPDATE grant to change them with -- which is the correct outcome and the
-- reason the version number is there. A reader handles both:
--
--     v1   the loser's value is `.loser`; the winner's is NOT RECORDED
--     v2   `.from` says which side survived; `.chosen` and `.discarded` are
--          both there whichever way it went
--
-- ===========================================================================
-- WHAT IS NOT CHANGED
-- ===========================================================================
-- The carry-over's CONDITION, the sweep, the ordering (carry, sweep, THEN
-- soft-delete -- DECISION 4), the counts, every raise, and every other line of
-- the function. `taken_from` in the new query is a mirror of the insert's
-- `where` clause and is written immediately above it so the two cannot drift
-- silently; W90-W99 assert they agree in BOTH directions -- the chosen-loser
-- overwrite (W93-W95) and, in the same merge, an unchosen field that went the
-- other way (W96/W97), so neither is measuring a function that always answers
-- the same.
-- ===========================================================================

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

  -- 4. CUSTOM FIELD VALUES: record BOTH SIDES, carry, then sweep.
  --
  -- FOLLOW-UPS' obligation (b) names the sweep. It also asks what a merge
  -- SHOULD do with the values first, and answers that discarding them silently
  -- is the wrong default for a workflow whose whole purpose is not losing data.
  -- So the default is CARRY WHERE THE WINNER HAS NOTHING, and everything -- kept
  -- or discarded, from EITHER record -- goes into field_resolution before
  -- anything is deleted.
  --
  -- THE FULL JOIN IS THE FIX. See this file's header: the previous version
  -- read the loser's rows only, so a reviewer who explicitly chose the LOSER's
  -- value for a field the winner also held overwrote the winner's value and
  -- nothing recorded it.
  --
  -- `taken_from` MIRRORS THE INSERT BELOW EXACTLY, and that is the property
  -- that makes this a record rather than a guess. The insert carries the
  -- loser's value when the choice names it OR the winner has no row; every
  -- other field keeps the winner's. Change one and the other is a lie, so they
  -- are written next to each other with this sentence between them.
  select pg_catalog.jsonb_object_agg(f.field_id::text,
           pg_catalog.jsonb_build_object(
             'from',      f.taken_from,
             'chosen',    case f.taken_from when 'loser' then f.loser_value
                          else f.winner_value end,
             'discarded', case f.taken_from when 'loser' then f.winner_value
                          else f.loser_value end))
    into v_cf
    from (
      select coalesce(l.field_id, w.field_id) as field_id,
             l.value as loser_value,
             w.value as winner_value,
             case
               when l.field_id is null then 'winner'
               when coalesce(p_custom_field_choices ->> l.field_id::text, '') = 'loser'
                 then 'loser'
               when w.field_id is null then 'loser'
               else 'winner'
             end as taken_from
        from (select v.field_id, v.value from public.custom_field_values v
               where v.organisation_id = p_organisation_id
                 and v.entity_type = p_entity_type
                 and v.entity_id = p_loser_id) l
        full join
             (select v.field_id, v.value from public.custom_field_values v
               where v.organisation_id = p_organisation_id
                 and v.entity_type = p_entity_type
                 and v.entity_id = p_winner_id) w
          on w.field_id = l.field_id
    ) f;
  v_cf := coalesce(v_cf, '{}'::jsonb);

  select pg_catalog.count(*) into v_cf_seen
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type = p_entity_type
     and v.entity_id = p_loser_id;

  -- THE CONDITION BELOW IS THE ONE `taken_from` ABOVE MIRRORS. `on conflict do
  -- update` is what overwrites a winner value the reviewer chose to replace,
  -- which is exactly the case that used to go unrecorded.
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
      -- VERSION 2. `custom_fields.values` changed shape: v1 recorded
      -- {"<field id>": {"loser": <value>}} and v2 records
      -- {"<field id>": {"from": …, "chosen": …, "discarded": …}}, the same
      -- three keys `fields` uses for the ordinary columns. Bumped rather than
      -- left at 1, because a support engineer reading a v1 row and a v2 row
      -- has to know which one they are holding -- and the v1 rows are still
      -- there, unchanged, because merges is append-only.
      'version', 2,
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
  'Merge two records of one entity type in one transaction, and the only sanctioned way to do it. SECURITY INVOKER: every statement is decided by the caller''s own policies, so this grants nothing and adds atomicity and ORDER. The order is load-bearing -- drop/demote/promote BEFORE repointing, because contact_companies_one_primary_per_contact, contact_companies_contact_company_unique and artist_representations_one_current_primary_per_artist are non-deferrable and a plain repoint raises 23505; carry custom field values, then SWEEP them, then soft-delete the loser, because custom_field_values_delete_via_entity carries entity_is_live() since 20260829011000 and a soft-deleted loser''s values are undeletable by every client role. p_organisation_id is mandatory with no overload without it (PostgREST resolves by argument name). p_field_choices maps a column to ''winner''/''loser''; anything else, or an absent key, means the winner keeps its value UNLESS the winner''s is null and the loser''s is not, in which case the loser''s is carried. EVERY REFUSAL RAISES -- each repoint counts the rows it can see and compares, because the join tables'' SELECT policies are gated on view_crm while their UPDATE policies are gated on manage_*, so a partial merge is otherwise silent. Rows whose parent is soft-deleted are not updatable and are recorded as `stranded` rather than raised on. FIELD_RESOLUTION IS AT VERSION 2 SINCE 20260829030000: custom_fields.values records {from, chosen, discarded} for every field EITHER record holds, the same three keys the ordinary columns use. Version 1 rows record only the loser''s value and cannot say what a chosen-loser overwrite destroyed; merges is append-only, so they stay as they are and the version number is how a reader tells them apart. Returns the merges.id.';

-- Unchanged by the replace, and restated so the grant travels with the body a
-- reader is looking at. `create or replace function` preserves privileges, so
-- these are a no-op today and are the line that keeps being true if the
-- function is ever dropped and recreated instead.
revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb, jsonb)
  to authenticated;
