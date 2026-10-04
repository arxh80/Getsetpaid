# Task 9c report

## Job 1 (close RPC, closed state, backup, N4)

Founder 2026-09-30: Q176/Q178 changed, **reversing Q104**. This job is the
database half of requirements 1, 2 and 4. Job 2 (superuser decision item,
reassign/delete, emails) and job 3 (Owner UI, e2e) are not started.

Migration `20261021000000_owner_may_close_their_workspace.sql` (224 -> 225).

**1. The RPC.** `public.close_my_workspace(p_organisation_id uuid,
p_confirmation text, p_reason text) returns uuid` (the backup job's id).
It is SECURITY DEFINER, `authenticated` only, and checks in this order:
- a session (`close_needs_a_session`);
- aal2 (`close_needs_step_up`);
- an ACTIVE `owner` membership row of that workspace (`close_needs_an_owner`).
  An unknown id gets the same answer. An impersonating superuser cannot close
  a workspace, because the check reads the membership row and not
  `permitted_organisations`.
- the workspace is still active (`workspace_not_active`);
- the confirmation is the **slug, exactly**, with no trimming or case-folding
  (`close_confirmation_mismatch`);
- the reason is trimmed, non-blank and at most 500 characters
  (`close_reason_required`, `close_reason_too_long`).

The lifecycle guard and `organisations_update_manage_organisation` are
unchanged. CD1/CD2 prove that an aal2 Owner's direct UPDATE is still refused
(`organisation_lifecycle_is_the_rpcs`). CD3 is the positive control: a rename
still goes through.

The RPC is audited as `organisation.closed_by_owner`. The actor comes from the
session, and the payload holds the reason, the clocks, `backup_export_job_id`
and the active member count. It shares one correlation id with the backup's
`export_job.requested`. The action is registered in `lib/admin/audit-actions.ts`
and in `private.platform_audit_actions()`, which is rebuilt from its LIVE
definition. The RPC is in the matrix's `MEMBER_REACHABLE_RPCS` with its reason.

**2. The closed state.** A new `lifecycle_state` value, `owner_closed`, rather
than a `closed_at` column. The invariant forces `deleted_at` to be set with it,
and `deleted_at` is the read-only flag every gate already reads, so no gate was
edited. Because the sync trigger stamps `retention_expires_at`, the Q88 60-day
purge (`sweep_expired_workspaces`, which ignores the state) applies; CP1 checks
this. `lifecycle-contract.ts` gets the state, labelled "Closed by its Owner".

The tests show one refused write per phase, each with a positive control
before the closure (CF): contact, event, task, note, document-upload row,
finance entry, network publish (0 rows) and connection request. Editing a
record and clearing `deleted_at` both affect 0 rows. The Owner and a Manager
can still read. CW14a-f check each gate separately (see mutation 20f).

**Finding (Q205):** finance lines are NOT readable in a closed workspace.
`finance_module_organisations()` gates reads on `deleted_at`. That is the
existing suspension rule, inherited here. The default is to keep it.

**3. The backup.** In the same transaction, the RPC inserts an `export_jobs`
row with kind `workspace` and `closure_backup = true`. It goes through the
Task 4 pipeline's own trigger, so the requester is stamped and
`export_organisation_data` is checked. The backup:
- is **unmetered**;
- is **exempt from the one-live-workspace-job index**, so an ordinary queued
  export does not block a closure (CC5b);
- is **kept until the workspace's `retention_expires_at`** rather than 7 days
  (CB6).

Lesson 15: the new column `export_jobs.closure_backup` has no client INSERT
grant, because the grants are column-level on kind and organisation_id only
(CB1). The trigger refuses it outside the RPC unless the marker names the org
AND the org was closed in this transaction (CB2/CB3). It cannot be changed in
either direction (CB4/CB5). No new client grant was added, so the privilege
census is unchanged.

**How job 2 finds the backup:** take the latest `export_jobs` row with
`organisation_id = <org> and closure_backup`, or read `after.backup_export_job_id`
on the `organisation.closed_by_owner` audit row.

**Open for job 2 (Q206):** `export_jobs.requested_by` is ON DELETE CASCADE.
An Owner who closes their workspace and then erases their account (which a
closed workspace no longer blocks) deletes the backup row. The default for
job 2 is to re-point it at the tombstone.

**4. N4.** The erasure suite's § EN creates a user who is both `requested_by`
and `responded_by` on an accepted request between real profiles. Erasure
succeeds (bound_update's owner exemption) and both columns become null; the
suite total goes from 208 to 212. My first fixture used invented profile ids
and went red with 23503 for a reason unrelated to N4. It was fixed to use real
profiles.

**Mutations** (files in `supabase/tests/mutations/20a-20g`, each built from the
LIVE definition at 225 migrations). Each was run against the closure suite and
followed by a control with the originals restored (0/64). The runner layer
reds through its pin whenever a suite stops recording.

| mutant | red |
|---|---|
| 20a no Owner check | CG4 |
| 20b no aal2 | CG3 |
| 20c no confirmation | 11 red + only 29/64 recorded (pin red) |
| 20d no reason check | 8 red + 29/64 (pin red) |
| 20e closure does not set deleted_at | CC1, CC2 + 29/64 (pin red) |
| 20f CRM write gate ignores deleted_at | **0/58 before (FALSE GREEN: has_permission refuses too)** -> CW14a added -> 1/64 |
| 20g lifecycle guard open | CD1, CD2 |

Only the closure suite and the runner's pin were measured, not the full runner
plus vitest. The full psql pass for each mutant (~25 min each) did not fit the
job's time.

**Gates:**
- lint and typecheck: clean.
- `vitest tests/unit`: 2522/2523. The one failure is
  `no-private-table-in-network-path` DENOMINATOR timing out at 5 s while the
  psql suite was running; it passes alone in 2 s and is load-related, not a
  regression.
- psql/RLS, two full runs, each after a reset at 225 migrations:
  - Run 1 was red only on EN2-4, the fixture bug above.
  - Run 2 was green except PA6c. The derived audit catalogue now has 164 names
    (+ organisation.closed_by_owner), and its pin is bumped in
    rls_phase8_crm_audit_p3_6.sql and audit-actions-match-db.test.ts.
  - On both runs: closure 64/64, erasure 212/212, HTTP 0 failures.
  - I could not do a third full run after the PA6c pin bump. The bump is
    verified against the live count (164/164) and by integration vitest.
- Integration vitest after a fresh reset, all green:
  - admin, rls, the permission matrix, export and erasure: 14 files / 789 tests.
  - legal: 3 files / 45 tests.

Questions: Q205, Q206 and Q207 (the confirmation and reason bounds) are in
DECISIONS-QUEUE.md. CLAUDE.md's Q104 paragraph is corrected (requirement 5).
