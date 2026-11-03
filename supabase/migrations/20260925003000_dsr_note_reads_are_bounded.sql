-- ===========================================================================
-- PHASE 8 TASK 3, FIX ROUND 1 (review finding M9) -- TWO OPERATOR READS OF THE
-- NOTES TABLE WERE NOT BOUNDED THE WAY "PAGINATE EVERYTHING" ASKS.
--
-- lib/dsr/queue.ts counted a page's notes by SELECTING EVERY NOTE ROW for the
-- page's requests and counting them in TypeScript, with no limit -- capped
-- only by PostgREST's max_rows (1000), which truncates silently, so past that
-- the "(n)" in a row's header under-counted with no sign. And it fetched "the
-- newest 200 notes across ALL the requests on the page", so one heavily
-- annotated request could starve the others: a header saying "(3)" above a
-- list saying "No notes yet."
--
-- PostgREST cannot GROUP BY (aggregates are off, and should stay off), so the
-- two reads become two functions:
--
--   public.data_subject_request_note_counts(ids)      one row per request that
--       has notes, with the true count. The database counts; nothing is
--       fetched to be counted.
--   public.data_subject_request_recent_notes(ids, n)  the newest n notes PER
--       REQUEST (a window function), so no request can starve another.
--
-- Both are bounded by construction: at most 50 request ids (lib/list's
-- MAX_PAGE_SIZE -- the queue never shows more) and at most 20 notes per
-- request, so the largest possible answer is 50 and 1,000 rows respectively
-- and both ceilings are refused rather than silently clamped.
--
-- SECURITY INVOKER, DELIBERATELY. These add no access path: they read
-- public.data_subject_request_notes as the CALLER, so the table's one policy
-- (the aal2 platform superuser's SELECT) decides what they return, exactly as
-- it decided the two PostgREST reads they replace. A requester who calls
-- either gets zero rows for their own request -- asserted in
-- rls_phase8_data_subject_requests.sql § DN and in the permission matrix.
--
-- ADDITIVE. New objects only.
-- ===========================================================================

create or replace function public.data_subject_request_note_counts(p_request_ids uuid[])
returns table (request_id uuid, note_count bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.cardinality(p_request_ids), 0) > 50 then
    raise exception 'data_subject_request_note_counts: at most 50 requests at a time'
      using errcode = '22023', hint = 'too_many_requests';
  end if;
  return query
    select n.request_id, pg_catalog.count(*)
      from public.data_subject_request_notes n
     where n.request_id = any (p_request_ids)
     group by n.request_id;
end;
$$;

comment on function public.data_subject_request_note_counts(uuid[]) is
  'How many operator notes each of up to 50 data subject requests carries -- one row per request that has any (Phase 8 Task 3 fix round 1, M9). Counted in the database: the read it replaces fetched every note row to count them, silently truncated at PostgREST''s 1000-row ceiling. SECURITY INVOKER: it reads public.data_subject_request_notes as the caller, so that table''s one policy (the aal2 platform superuser) decides the answer and anybody else gets no rows. 22023 too_many_requests past 50 ids.';

revoke all on function public.data_subject_request_note_counts(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.data_subject_request_note_counts(uuid[]) to authenticated;


create or replace function public.data_subject_request_recent_notes(
  p_request_ids uuid[],
  p_per_request integer default 5
)
returns table (id uuid, request_id uuid, body text, created_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.cardinality(p_request_ids), 0) > 50 then
    raise exception 'data_subject_request_recent_notes: at most 50 requests at a time'
      using errcode = '22023', hint = 'too_many_requests';
  end if;
  if p_per_request is null or p_per_request < 1 or p_per_request > 20 then
    raise exception 'data_subject_request_recent_notes: between 1 and 20 notes per request'
      using errcode = '22023', hint = 'per_request_out_of_range';
  end if;
  return query
    select r.id, r.request_id, r.body, r.created_at
      from (
        select n.id, n.request_id, n.body, n.created_at,
               pg_catalog.row_number() over (
                 partition by n.request_id
                 order by n.created_at desc, n.id desc) as rn
          from public.data_subject_request_notes n
         where n.request_id = any (p_request_ids)
      ) r
     where r.rn <= p_per_request
     order by r.request_id, r.created_at desc, r.id desc;
end;
$$;

comment on function public.data_subject_request_recent_notes(uuid[], integer) is
  'The newest p_per_request (1..20) operator notes for EACH of up to 50 data subject requests (Phase 8 Task 3 fix round 1, M9). Per request, by a window function: the read it replaces took the newest 200 notes across the whole page, so one heavily annotated request could leave the others showing "No notes yet." under a header that counted three. SECURITY INVOKER -- the notes table''s one policy decides what comes back. 22023 too_many_requests / per_request_out_of_range.';

revoke all on function public.data_subject_request_recent_notes(uuid[], integer) from public, anon, authenticated, service_role;
grant execute on function public.data_subject_request_recent_notes(uuid[], integer) to authenticated;
