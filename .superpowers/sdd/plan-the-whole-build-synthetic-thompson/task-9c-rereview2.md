# Phase 8 Task 9c fix round 2: SCOPED RE-REVIEW 2

Range `bbe3efc..b0eac34` (migrations 235 -> 238), worktree `legal-phase`, reviewed at `b0eac34`.
Read-only: no reset, psql runner, integration vitest or Playwright run here. [verified] = read the
definitions/code myself; [report] = `task-9c-report.md` "## Fix round 2" measured gates.

**VERDICT: READY.** N1, N2 and N3(a) are closed; N3(b) was already built; N3(c) not building is
acceptable as reasoned in Q228. Three new nits, none blocking.

## N1 -- lock + re-check: closed

- **`private.lifecycle_lock(uuid)`** [verified]: SECURITY DEFINER, `search_path=''`, revoked from
  public/anon/authenticated/service_role then EXECUTE to `authenticated` only (needed: the
  INVOKER `lifecycle_target` calls it). The FIRST statement is the
  `has_platform_permission('manage_organisation_lifecycle')` aal2 guard, raising a constant
  42501 before any read or lock. So a tenant (or an aal1 superuser) can neither lock an
  arbitrary org row (no DoS lever) nor learn whether an id exists: same error, no row touched,
  no data-dependent timing. CL11/CL11b pin both refusals, CL11c the positive. The report's
  reason for definer (a locking read under INVOKER applies the UPDATE policy, which admits only
  inside `begin_lifecycle_transition()`) is correct Postgres semantics.
- **`lifecycle_target` now VOLATILE** [verified]: `git grep` finds it referenced only by the
  three Phase 7 RPCs (and comments/tests) -- no policy, view, index or STABLE caller depends on
  it. VOLATILE is required so the post-lock read sees the committed row. CL9 pins it.
- **Six UPDATE re-checks** [verified]: suspend/delete/reinstate `and lifecycle_state =
  v_target.lifecycle_state`; `close_my_workspace` now `for update` on the org first, plus
  `and lifecycle_state = 'active'`; reassign/delete_closed `and lifecycle_state =
  'owner_closed'`. Zero rows -> `40001 lifecycle_changed_concurrently` (the Phase 7 three
  distinguish a vanished/purged row as 42501 "refused"). Both race orders resolve: superuser
  first -> the close's `for update` waits then sees `deleted_at` set (`workspace_not_active`);
  Owner first -> the lock waits then returns `owner_closed` (I1 refusal). No lock-order cycle
  (one row). The reassign membership-role update precedes the org UPDATE but rolls back with
  the 40001. CL10 = 6 [report: mutants 5/6]; the 2 s probe goes red with both gates reverted.
- **UI** [verified]: `lib/admin/lifecycle.ts` maps 40001 to "That workspace changed while this
  ran, so nothing was done. Reload the page and decide again."; `lib/admin/closures.ts` maps the
  hint to the existing not-owner-closed sentence; `closure-contract.ts` maps it to `notActive`
  (unit-tested). All sensible, none echo the database.

## N2 -- reinstate needs an active Owner: closed

- `private.lifecycle_has_active_owner` [verified]: definer, same aal2 guard first (CN5: no
  membership oracle for a tenant), excludes the erasure tombstone. Called after the locked read
  and before any write; refusal 22023 `reinstate_needs_an_active_owner`, echoed by
  `lifecycle.ts`'s 22023 branch as "That workspace has no active Owner, so reinstating it would
  leave nobody able to manage it." -- readable.
- Rule is sound and narrower than "never reinstate a closure delete" (keeps Q210's undo).
- **Phase 7's normal reinstate is unchanged** for an org with an Owner: positive controls are
  CN4 (same org, Owner restored -> ok) and the Phase 7 suite's existing `reinstate_organisation
  ('org-alpha', ...)` ok(1) assertions (`rls_phase7_lifecycle.sql:462/542/573`) plus the
  permission matrix's reinstate surface, all green [report].

## N3 -- delete needs a backup or acknowledgement: closed (a), (b) pre-existing, (c) deferred

- (a) [verified]: 2-arg `delete_closed_workspace(text,text)` dropped, 3-arg created with
  `default false`, revoke/grant re-issued, comment re-issued on the new signature. **No caller of
  the 2-arg form is left**: `git grep` outside migrations finds only the action (now passes
  `p_acknowledge_no_backup`), the permission matrix (named args slug+reason -> resolves to the
  default; org B is active so it refuses on state before the backup check), and the closure suite
  (2-arg calls resolve via the default; the regprocedure in CL10 names the 3-arg form). Refusal
  checked before any write. Audit `after` carries `backup_status` and `acknowledged_no_backup`;
  CX3 asserts `queued`/true on the acknowledged delete, CX0f the succeeded/false case.
- Server-side refusal proven by e2e [verified code, report run 2 passed]: `super-closures.spec.ts`
  strips `required`, leaves the box unticked, submits, and asserts the
  `backup has not succeeded. Tick` sentence -- which only `rpcRefusal`'s
  `decision_backup_not_succeeded` mapping produces (the action does no client-side ack check) --
  and lifecycle still `owner_closed`; then ticks and the delete lands.
- (b) already built by `20261022000000` (`greatest(now + archive_days, retention_expires_at)`,
  CB6) -- my round-1 "7 days" was the ordinary path. Accepted.
- (c) **Not building a re-queue is acceptable with Q228.** A re-queue would need a second path
  through the closure-only insert fence, runs under the closing Owner's rights, is useless once
  they erased, and a ceiling failure repeats. With (a) the purge-without-a-copy can no longer
  happen silently: it is an explicit, audited superuser acknowledgement. Founder alternatives
  (i)-(iii) are recorded.

## New findings (ranked; all nits)

1. **n1 -- the active-Owner check does not lock memberships.** `lifecycle_has_active_owner` reads
   memberships unlocked, so an Owner removed/erased in a concurrent transaction could still
   leave a just-reinstated workspace ownerless. Needs two deliberate actions in the same instant
   on a superuser-only path; no data loss. Optional: `for share` on the owner row, or accept.
2. **n2 -- the suspended-ownerless branch of N2 is untested.** CN0-CN5 cover a *deleted* ownerless
   org only (and CN2 is absent from the numbering). Same code path, so low risk; one assertion
   would close it.
3. **n3 -- `acknowledged_no_backup` is derived, not the parameter.** It records `status <>
   succeeded`, which equals "the operator ticked" only because the refusal precedes it; a
   superuser passing `true` with a succeeded backup records `false`. Correct as "deleted without
   a backup", worth a word in the comment.

## Gates

lint, typegen + typecheck, psql runner (closure 157, lifecycle probe both rounds), vitest
118 files / 3267, and `super-closures.spec.ts` 2 passed at 238 migrations [report]. The
controller's full-gate run is in progress and was not repeated here.
