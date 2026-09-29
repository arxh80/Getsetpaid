-- Phase 7 Task 6, fix round 1, review finding I1: a READ of the feedback
-- budget, so the application can refuse BEFORE it spends storage and scanner
-- time on a submission the meter is about to refuse anyway.
--
-- ===========================================================================
-- THE PROBLEM THIS CLOSES
-- ===========================================================================
-- 20260911000000 meters the 10/hour budget in private.feedback_before_insert(),
-- where every writer passes -- and for the ROW that is the right place. But
-- in the application's own path the row is the cheap half: before the INSERT
-- runs, lib/feedback/actions.ts writes up to 5 MiB into the private
-- `feedback-screenshots` bucket through the service-role Storage client and
-- runs the malware scanner over it. The trigger cannot see either step. So a
-- submitter whose budget is spent -- or a Free-tier account, for which this is
-- the FIRST path that can drive the service-role Storage client at all --
-- could loop the dialog's action and burn storage and scanner time without
-- limit while `rate_limit_counters` read a flat 10.
--
-- ===========================================================================
-- WHY A READ, AND WHY IT DOES NOT DOUBLE-METER
-- ===========================================================================
-- Two meters on one submission would spend two units and halve the shipped
-- limit (20260911000000's reason for NOT calling consume_rate_limit in the
-- action). This function SPENDS NOTHING: it is STABLE, reads the caller's own
-- counter for the current window, and reports what is left. The trigger
-- remains the enforcement -- a pre-check that says "9 left" and a trigger
-- that then refuses is still a refusal, and a pre-check that is skipped (a
-- direct PostgREST INSERT) still meets the trigger. The direct path cannot
-- reach the bucket at all (the client fence), so the pre-check only needs to
-- guard the one path that can, and it guards it fail-closed: the action
-- treats an error from here exactly as it treats "0 left".
--
-- SECURITY DEFINER because no client role may read rate_limit_counters
-- (rls_phase7_rate_limits.sql § RC), and the caller must not be able to read
-- anyone's budget but their own: the subject is auth.uid(), never a parameter.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function public.feedback_budget_remaining()
returns table (remaining integer, retry_after_seconds integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
begin
  -- FAIL CLOSED: no session, no budget to report. The trigger would refuse
  -- the INSERT too (it exempts only sessionless DBA/fixture writers, which
  -- never arrive through PostgREST), so this is consistent, not stricter.
  if v_uid is null then
    raise exception 'feedback_budget_remaining: no session' using errcode = '42501';
  end if;

  select * into v_policy from public.rate_limit_policies p where p.category = 'feedback';
  if not found then
    -- The trigger's own posture: a missing policy row is a broken
    -- deployment, not a licence to submit without a budget.
    raise exception 'feedback: no rate-limit policy for feedback' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);

  select c.request_count into v_count
  from public.rate_limit_counters c
  where c.category      = 'feedback'
    and c.subject_scope = 'user'
    and c.subject_id    = v_uid
    and c.window_start  = v_window;

  -- `greatest` is a parser construct, unqualified on purpose under search_path = ''.
  remaining := greatest(0, v_policy.max_requests - coalesce(v_count, 0));
  -- The same arithmetic the trigger puts in PT429's `hint`, so the two
  -- refusals render the same wait through formatRetryAfter().
  retry_after_seconds := greatest(0, pg_catalog.ceil(extract(epoch from
      (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
        - pg_catalog.now())))::integer);
  return next;
end;
$$;

comment on function public.feedback_budget_remaining() is
  'Phase 7 Task 6 fix round 1 (I1): how much of the caller''s OWN 10/hour feedback budget is left in the current window, and how long until the window turns. A READ -- spends nothing, so it cannot double-meter; the BEFORE INSERT trigger stays the enforcement. lib/feedback/actions.ts calls it before ANY Storage I/O so a spent budget (or a Free-tier loop) cannot burn the service-role upload and the malware scan on a submission the trigger would refuse. Subject is auth.uid(), never a parameter: nobody reads another account''s budget. STABLE, so routable by GET as well as POST; 42501 with no session.';

revoke all on function public.feedback_budget_remaining() from public, anon, service_role;
grant execute on function public.feedback_budget_remaining() to authenticated;
