-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 2 -- N2 / Q178: THE REFUSAL NAMED TWO DOORS AND
-- BOTH OF THEM WERE LOCKED.
--
-- Fix round 1 re-founded Q131's question (I1): a live workspace that would be
-- left with NO ACTIVE OWNER blocks the erasure of any active member of it,
-- not only of an Owner. That is right, and it has a consequence the scoped
-- re-review measured: a NON-OWNER who is the last active member of an
-- ALREADY-OWNERLESS workspace that still holds records is refused, and the
-- sentence they read is
--
--   "Deleting this account would leave X with no owner. Make somebody else an
--    owner there, or close the workspace, and then ask again."
--
-- Neither half is available to them:
--
--   * "make somebody else an owner" needs another ACTIVE member to promote,
--     and there is nobody. Inviting one does not help -- the client policy
--     refuses any transition INTO `active`, so accepting is a third party's
--     act on a third party's account.
--   * "close the workspace" -- there is NO MEMBER-FACING ROUTE TO CLOSE A
--     WORKSPACE AT ALL. suspend_organisation / delete_organisation /
--     reinstate_organisation live in one file, the superuser dashboard.
--
-- The operator's DSR route dead-ends at the same guard, so the job is
-- recorded failed carrying the same sentence. There IS a working escape
-- hatch -- a superuser closing the workspace sets `deleted_at`, and
-- private.account_last_owner_workspaces() filters those out -- and nothing in
-- the product told anybody so, with a statutory clock running.
--
-- Q178's recommended default, adopted: KEEP THE GUARD, BRANCH THE SENTENCE.
-- When the subject is not an active Owner of the named workspace, the
-- refusal says that the workspace has no owner, that they cannot fix it, and
-- that support must close it -- and carries its own hint,
-- `workspace_has_no_owner`, so lib/erasure/runner.ts can give the recorded
-- failure_reason its own sentence too rather than the last-owner one.
--
-- The OTHER half of Q178 -- widening step 8b from `other_members = 0 and
-- is_empty` to `other_members = 0` for a workspace with no Owner at all, so
-- the last member takes it with them -- is NOT taken here. It destroys
-- records rather than stranding them, and that is a founder call, not a fix
-- round's.
--
-- ADDITIVE. Two functions are rebuilt from their LATEST definitions
-- (20260930003000 for the blocker list, 20261001001000 for the assertion).
-- Neither signature changes: `reason` gains a third value, which is what
-- lets the /account/erase page brand the same distinction without a new
-- column. private.erase_account() is untouched -- it calls the assertion by
-- name.
-- ===========================================================================


create or replace function private.account_erasure_blockers(p_user_id uuid)
returns table (organisation_id uuid, organisation_name text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.organisation_id, w.organisation_name,
         case
           -- N2: the subject cannot promote anybody or close anything here,
           -- because they are not an Owner of it. Said first, because it
           -- changes what the person is asked to DO, which is the whole
           -- point of Q131 naming a remedy at all.
           when not exists (
             select 1 from public.organisation_memberships m
              where m.organisation_id = w.organisation_id
                and m.user_id = p_user_id
                and m.role = 'owner'
                and m.status = 'active')
             then 'no_owner_to_transfer'
           when w.other_members > 0 then 'other_members'
           else 'workspace_has_data'
         end
    from private.account_last_owner_workspaces(p_user_id) w
   where w.other_members > 0 or not w.is_empty
$$;

comment on function private.account_erasure_blockers(uuid) is
  'What stands between this person and their own erasure: every live workspace their departure would leave with no active Owner that still has other members or records in it, with WHY. Three reasons since fix round 2 (N2/Q178) -- `other_members` and `workspace_has_data` are the Q131 cases where the subject IS an Owner and can transfer or close, and `no_owner_to_transfer` is the one where they are not, where neither remedy is theirs to perform and support has to close the workspace. The page and the refusal both brand that distinction; nothing else changed, so no caller of this function had to.';

revoke all on function private.account_erasure_blockers(uuid) from public, anon, authenticated, service_role;


create or replace function private.assert_account_is_erasable(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owned   text;
  v_unowned text;
begin
  select pg_catalog.string_agg(b.organisation_name, ', ' order by b.organisation_name)
           filter (where b.reason <> 'no_owner_to_transfer'),
         pg_catalog.string_agg(b.organisation_name, ', ' order by b.organisation_name)
           filter (where b.reason = 'no_owner_to_transfer')
    into v_owned, v_unowned
    from private.account_erasure_blockers(p_user_id) b;

  if v_owned is not null and v_unowned is null then
    -- Unchanged: the subject is an Owner of every blocker and both remedies
    -- are theirs to perform.
    raise exception 'Deleting this account would leave % with no owner. Make somebody else an owner there, or close the workspace, and then ask again.', v_owned
      using errcode = '22023', hint = 'last_owner_of_workspace';
  elsif v_owned is null and v_unowned is not null then
    -- N2: name the door that opens. Not an address -- the support contact is
    -- an environment value rendered at request time (SECURITY.md section 13),
    -- and the database is deliberately not one of the places it is written
    -- down.
    raise exception 'Deleting this account would leave % with no owner, and you are not an owner of it -- so you cannot make somebody else one, and there is no way for a member to close a workspace. Contact support and ask them to close it, and then ask again.', v_unowned
      using errcode = '22023', hint = 'workspace_has_no_owner';
  elsif v_owned is not null and v_unowned is not null then
    raise exception 'Deleting this account would leave % with no owner: make somebody else an owner there, or close the workspace. It would also leave % with no owner, and you are not an owner of that one -- contact support and ask them to close it. Then ask again.', v_owned, v_unowned
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;
end;
$$;

comment on function private.assert_account_is_erasable(uuid) is
  'Q131, ENFORCED IN THE DATABASE and not only in the UI: raises 22023 with a sentence naming the workspaces and saying what to do first. Called twice -- at the insert of the erasure job, so the refusal reaches the person while they are still on the page, and again inside private.erase_account(), which is the enforcement, because a workspace can lose its other Owner between the two. Since fix round 1 the question behind it is "would this leave the workspace with no active OWNER" rather than "is this person the last owner" (I1/Q176). Since fix round 2 the SENTENCE BRANCHES (N2/Q178): a subject who is an Owner of the blocker reads the Q131 remedy and hint `last_owner_of_workspace`, and a subject who is NOT -- the last member of an already-ownerless workspace, who can neither promote anybody nor close anything, because no member-facing route to close a workspace exists -- reads that support must close it, under hint `workspace_has_no_owner`. Naming a remedy somebody cannot perform, while a statutory clock runs, is the failure this branch removes.';

revoke all on function private.assert_account_is_erasable(uuid) from public, anon, authenticated, service_role;
