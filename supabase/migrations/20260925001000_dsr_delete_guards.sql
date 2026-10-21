-- ===========================================================================
-- PHASE 8 TASK 3, FIX ROUND 1 (review finding I2) -- THE DELETE GUARDS HAD THE
-- CONSENT LEDGER'S PRE-FIX SHAPE.
--
-- private.data_subject_requests_delete_guard() and
-- private.data_subject_request_notes_guard() (20260924000000 § 10) both let a
-- DELETE through at `pg_trigger_depth() >= 2`, citing "the consent ledger's
-- rule, 20260923000000 / 20260923002000" -- but 20260923002000 EXISTS because
-- that rule was wrong: depth >= 2 means "some trigger issued this DELETE", not
-- "the account's cascade issued it". Measured by the review in a rolled-back
-- transaction: a throwaway table whose AFTER INSERT trigger ran `delete from
-- public.data_subject_requests` emptied the register (3 -> 0) with the
-- requester's account alive.
--
-- ===========================================================================
-- WHAT MAY DELETE A REGISTER ROW NOW: NOTHING
-- ===========================================================================
-- Q158 was changed in this round from "cascade with the account" to "KEEP the
-- register row, anonymised": under cascade, the erasure job would delete the
-- very row its outcome has to be recorded against, so an erasure request could
-- never honestly reach `fulfilled`; and the request plus its outcome is the
-- evidence that a statutory deadline was met. With that ruling there is no
-- legitimate delete path left at all -- 20260925000000 already removed the
-- ON DELETE CASCADE from user_id -- so the guard is no longer "refuse unless
-- it is the cascade". It refuses, for every role and at every trigger depth.
--
-- THE ONE SEAM LEFT, EXPLICIT AND CLOSED: a RETENTION PURGE. Phase 8 Task 6
-- (the retention/GC job, Q133) will decide whether a closed request is ever
-- purged and after how long. When it does, it re-issues THIS function with its
-- own narrow admission (the shape to copy is the one below for notes: prove
-- the fact that makes the delete legitimate -- e.g. a closed row older than the
-- declared retention period, deleted from inside the purge -- never "a trigger
-- issued it"). Until a migration does that, nothing deletes a request. The
-- deliberate DBA escape hatches (disabling the trigger, session_replication_role
-- = replica) are the only ways past it, as for the consent ledger.
--
-- WHAT TASK 5 (ERASURE) MUST RE-ISSUE, because nothing shipped here lets it
-- anonymise a register row yet -- deliberately, that is Task 5's decision to
-- implement and Q158 is still counsel's to confirm:
--   1. private.data_subject_requests_before_update() (latest: 20260925000000
--      § 5) -- rule (1) "what never moves" refuses any change to user_id,
--      user_email and detail. Erasure needs ONE more admitted status-unchanged
--      write beside the three that exist: from a session with no person on it,
--      user_id -> Q130's tombstone, user_email and detail cleared,
--      rejection_reason cleared, on open AND closed rows (an old fulfilled
--      request belongs to the erased person too), nothing else moving.
--   2. The CHECKs that clearing would violate: data_subject_requests_detail_length
--      (1..4000) and `user_email not null` -- decide the cleared representation
--      (a fixed marker such as '[erased]', or nullable columns).
--   3. private.dsr_fulfilment_job_ready(text) -- its `erasure` line, to true.
--   4. data_subject_request_notes.author_user_id has no ON DELETE action
--      (phase-8-inventory.md) -- operator-only today, but it needs the
--      tombstone treatment the day a second operator exists.
--   5. NOT this guard: erasure deletes no register row.
--
-- ===========================================================================
-- NOTES: THE CONSENT LEDGER'S POST-FIX RULE
-- ===========================================================================
-- A note's ON DELETE CASCADE from its request stays declared, because a note
-- has no meaning without its request and Task 6's purge, if it ever deletes a
-- request, must take the notes with it. But it is admitted only when BOTH
-- hold: a trigger issued the DELETE (depth >= 2) AND the parent request no
-- longer exists -- which is true inside the foreign key's cascade (it runs
-- after the parent row is gone) and false for any trigger deleting the notes
-- of a request that is still there. Today the parent can never be gone, so
-- today this admits nothing; it is the right rule for the day it can.
--
-- SECURITY DEFINER (owner postgres, empty search_path) so the parent lookup
-- answers the same way whichever role's trigger issued the DELETE -- the
-- consents fix's reasoning, unchanged.
--
-- REBUILT FROM THEIR LATEST DEFINITIONS: 20260924000000 § 10 for both bodies
-- (20260924003000 reissued only the first one's comment). The triggers
-- themselves are unchanged -- each already calls its function by name.
-- ===========================================================================

create or replace function private.data_subject_requests_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- NOTHING deletes a request: not a DELETE statement from any role (depth
  -- 1), not a trigger's DELETE (depth >= 2), not the account's deletion --
  -- user_id no longer cascades (20260925000000) and Q158 keeps the row.
  raise exception 'data_subject_requests: a request is the evidence that it was answered -- it is kept, and nothing deletes it'
    using errcode = '42501', hint = 'register_rows_are_never_deleted';
end;
$$;

comment on function private.data_subject_requests_delete_guard() is
  'BEFORE DELETE on public.data_subject_requests, for EVERY role including postgres and at EVERY trigger depth: refuses (42501, hint register_rows_are_never_deleted). A request and its outcome are what prove a statutory deadline was met. Fix round 1 (review finding I2, 20260925001000): the shipped guard admitted any DELETE at pg_trigger_depth() >= 2 -- the consent ledger''s PRE-fix rule -- so any trigger could empty the register with the accounts alive. Under Q158 as changed (keep the row, anonymised) even the account''s cascade is not a legitimate delete, and user_id no longer cascades. THE ONLY SEAM: Phase 8 Task 6''s retention purge, if it decides closed requests are ever purged (Q133), re-issues this function with a narrow admission that proves its own legitimacy. Closed until then. The DBA escape hatches (disabling the trigger, session_replication_role = replica) are the only other ways past it.';

revoke all on function private.data_subject_requests_delete_guard() from public, anon, authenticated, service_role;


create or replace function private.data_subject_request_notes_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'data_subject_request_notes: a note is append-only -- add another'
      using errcode = '42501';
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
  'BEFORE UPDATE OR DELETE on public.data_subject_request_notes, for every role: refuses every update, and every delete except one issued by a trigger (pg_trigger_depth() >= 2) for a note whose request NO LONGER EXISTS -- i.e. the ON DELETE CASCADE from public.data_subject_requests, which runs after the parent row is gone. A trigger deleting the notes of a live request is refused (42501, hint note_outlives_nothing_but_its_request). Fix round 1 (review finding I2, 20260925001000): the shipped guard checked the depth alone, the consent ledger''s PRE-fix rule. Since no request can be deleted today (private.data_subject_requests_delete_guard), this admits nothing today; it is the rule for the day Task 6''s retention purge may. SECURITY DEFINER only so the parent lookup does not depend on the invoking role.';

revoke all on function private.data_subject_request_notes_guard() from public, anon, authenticated, service_role;
