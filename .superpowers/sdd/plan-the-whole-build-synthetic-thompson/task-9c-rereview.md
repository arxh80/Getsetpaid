# Phase 8 Task 9c fix rounds 1 / 1b: SCOPED RE-REVIEW

Range `899f107..757bd50` (migrations 229 -> 235), worktree `legal-phase`, reviewed at `757bd50`.

**VERDICT: MINOR.** C1, I1 and I2 are closed. I3 is closed in code, but the spec has not been run yet. The marker that the two core tenant predicates now carry holds up under attack: I found no client path that writes it, keeps it alive, or reaches it. There are three new Minor findings (N1 to N3). None of them blocks a merge.

## Method

Read-only. I ran no reset, psql runner, integration vitest, Playwright or dev server. Each claim is marked:
- **[verified]**: I read the definitions myself.
- **[report]**: taken from `task-9c-report.md`, either the fix rounds' measured runs or the controller's gates.

I read:
- `20261025000000` in full: the marker, the predicates, `export_read_page` and `erase_account`;
- `20261026000000`, `20261027000000`, `20261027001000`, `20261027002000` and `20261027003000`;
- the diffs to `network_leakage_phase6.sql` § LF and `rls_phase8_workspace_closure.sql` CW15g/h;
- the e2e rework.

I also read the live definitions these depend on:
- `export_jobs_before_insert` (2b) and the `export_jobs` transition guard;
- `claim_export_job` and its grants;
- `reap_stuck_jobs` and `private.export_limits()`;
- `lifecycle_target` and the Phase 7 RPC UPDATE predicates;
- the decision RPCs in `20261022001000`;
- `lib/export/runner.ts` and `lib/org/closure-actions.ts`.

## The marker: attacked

**Who can write a marker row.** [verified]
- It has exactly one writer: `public.export_read_page()`. Grep finds `closure_backup_reads` only in `20261025000000` and `20261027000000`, plus the tests.
- That function is SECURITY DEFINER. EXECUTE is granted to `service_role` only, and step (0) also refuses any caller with an `auth.uid()` or a role other than postgres/service_role.
- It writes the marker only when `v_job.closure_backup` is true.
- The table has `revoke all` from public, anon, authenticated and service_role.

So a marker exists only while a server-side runner reads a job flagged `closure_backup`.

**Who can create a `closure_backup` job.** [verified]
- A client has no column grant to name `closure_backup`.
- Every other writer passes trigger fence 2b, which needs three things at once:
  - `kind = 'workspace'`;
  - the `app.workspace_closure_backup` GUC naming the org;
  - the org is `owner_closed` with `lifecycle_changed_at = now()`, which means it was closed in this very transaction.
- Taken alone, the GUC is forgeable by any session. The column grant plus the same-transaction closure is what makes the whole fence unforgeable, and only `close_my_workspace()` can produce that closure.
- A non-closure export (account or workspace) never sets the flag, and the flag is immutable in the update trigger. So an ordinary export job cannot write a marker.

**Pointing the runner at another org's backup.** [verified]
- `export_read_page` takes only `p_job_id`. The org, requester and aal all come from the job row, and the marker's org is `v_job.organisation_id`.
- Only `service_role` can name a job id, and that role is already trusted.
- Even then, the read still needs the requester's own active membership in that org. A misdirected id therefore admits nothing the job's requester could not read before the closure.

**Keying, clearing, reuse.** [verified]
- Admission is `xact = pg_current_xact_id_if_assigned() AND organisation_id = p_org`. That means the current top-level transaction only. `pg_current_xact_id` returns the top-level xid even inside the plpgsql exception subtransaction.
- The job is not in the key. That is harmless, because `on conflict (xact)` allows one marker per transaction and each RPC call is its own transaction.
- The marker is deleted on the success path and on the `when others` path.
- **QueryCanceled is not caught by `OTHERS`** (a statement timeout or cancel), and then the delete is skipped. But the error aborts the transaction, and the insert rolls back with it. A row survives only if the transaction commits, and the function deletes it before every normal return.
- Even a leftover row could never match again. `xid8` is epoch-extended to 64 bits, so there is no wraparound reuse, and admission compares against the current xid only.
- LF5c pins "empty at rest" and KE3b covers "none after a build" [report].

**What else runs inside a marked transaction.** [verified]
- The marked window is only the call to `export_read_page_as_requester(v_sql, ...)`: one SELECT built by `export_page_sql` from the catalogue's fixed projection.
- The runner calls it over PostgREST as service_role, one RPC per transaction, so no person's session can share that transaction.
- Inside it, `has_permission` would also admit write keys such as `manage_members`. But no write runs there, and the write gates (`organisation_is_live()`, `crm_write_organisations()`, `accept_invite`'s `deleted_at` check) read `deleted_at` directly rather than the predicate.

**Finance/network visible only to the backup (Q205/Q221).** In-app members get the old answer, because their transactions have different xids. This is measured as KA5, KM2c/d and M1/M1b at 0 mismatches over 1296 triples [report], and it is consistent with the definitions [verified].

**N2 / network census (Q227).** [verified]
- LF5 is an **exact-name** allowlist of `private.closure_backup_reads`. It allows no schema or pattern, and any other private relation named in a closure body reddens it.
- LF5b pins the column set to `xact`, `organisation_id` and `export_job_id`. These are no tenant content.
- The LF1-3 red at 231 migrations was a **text false positive**. `permitted_organisations()` never calls `export_read_page`, so rewording its comment is legitimate and hides no real edge.
- 7 = the 6 bodies before the change + `closure_backup_read_admits`, which is honest.
- LF5 also closes a blind spot that existed before this change: LF1 looked only at `public.` relations.
- The extra `export_job_id` column, which the brief did not ask for, is an FK with no tenant data. Accepted.

## Prior findings

| ID | Status | Note |
|---|---|---|
| C1 | **closed** | Marker plus the two predicates. KA1 35/35 tables and KA2 finance 3 rows, mutation-tested [report]; the code agrees [verified]. A colleague's private note is still excluded (KS5/KA4). |
| I1 | **closed** (residual N1, N2) | All three RPCs refuse `owner_closed` before writing. `/super/organisations` shows a link and no Reopen. CL1-8 mutation-tested [report]. |
| I2 | **closed** (residual N3) | Erasure step 2b waits. The belt `closure_backup_requester_erased` (KT1) stops a tombstone build. |
| I3 | **closed in code, NOT RUN** | The forgery replays the Owner's captured Next-Action id from the Manager's session. It asserts a 200 carrying the action's own `notOwner` sentence, which a page render cannot produce (the settings page's copy differs), plus lifecycle `active`, 0 backups and 0 audit rows. That proves a real server refusal once it runs green. |
| m1/Q223 | closed | VOLATILE, audited with counts only. The keyset rebuild keeps the audit call. |
| m2/Q222 | closed | Refused in reassign. Excluded in both candidates bodies, including the paged one. |
| m3/Q224 | closed | Keyset on (rank, id). The cursor is validated. |
| m4/Q225 | closed | The CW15g/h false-green fix is sound. CW15g pins the catalogue gate and CW15h the policy text, so each of the two independent refusals has its own red. |
| m5/m6/Q226 | closed (copy) | |

## New findings

**N1 (Minor). The I1 refusal is a time-of-check/time-of-use race.**
- `lifecycle_target` reads the organisation without `FOR UPDATE`. The Phase 7 UPDATE matches on `id` only, and no trigger guards a transition out of `owner_closed`.
- Failure sequence:
  1. The superuser clicks Suspend or Delete on an **active** workspace.
  2. In the same instant, its Owner commits `close_my_workspace()`.
  3. The superuser's UPDATE waits for the lock, re-evaluates on the new row, and overwrites `owner_closed`.
- The result is I1(b) again: the discriminator is lost, the item leaves `/super/closures`, and the clock is re-stamped. No data is lost.
- Fix: lock in `lifecycle_target`, or add `and lifecycle_state = v_target.lifecycle_state` to each UPDATE.

**N2 (Minor). A closure-deleted workspace can still be reinstated, and the result can have no Owner.**
- `delete_closed_workspace()` moves the workspace to `deleted`, which is documented as "reversible with reinstate_organisation() until the purge runs". `reinstate_organisation` accepts `deleted`.
- If the closing Owner has already erased their account, that one deliberate superuser click yields a live workspace with no Owner (Q131).
- The window is short, because the delete makes the workspace due at the next hourly sweep, and the action is superuser-only.
- Fix, either:
  - refuse reinstate while the workspace has no active Owner; or
  - refuse reinstate when the last lifecycle event was `closure_deleted`.

**N3 (Minor). The erasure wait is bounded, but a failed closure backup is gone for good.** On the stuck-job question:
- **Running.** A `running` job is reaped to `failed` after 1 h by `reap_stuck_jobs()`, so the wait releases. A stuck job does **not** make an account un-erasable for good.
- **Kill switch.** The one exception is the retention kill switch. While `enabled = false`, no reaping happens, so every erasure request that Owner makes fails "ask again" until the switch is restored. The 30-day DSR duty is at risk only for as long as an operator leaves the sweep off.
- **Queued.** A `queued` job waits only while the export runner itself is down, which blocks every export and is loud.
- **The real residual.** Once failed, a closure backup cannot be re-queued, except by a superuser reassign followed by a fresh closure. This applies to a reaped job, and also to a deterministic failure on a workspace over the ceilings (50k rows per table, 500k rows in total, or 40 MiB). The erasure then proceeds, and `delete_closed_workspace()` does **not** require a succeeded backup. The 7-year finance ledger can therefore still be purged with no copy. The cause has moved from C1's emptiness to size and failure.
- Fix: refuse delete, or ask for an explicit "no backup" acknowledgement, when `backup_status <> 'succeeded'`. Q205 owner, founder call.
- Related: the backup archive expires 7 days after it is built (`archive_days`), well inside the 60-day decision window. Worth one line in Q226's copy.

## Gates

lint, typecheck and psql (all suites, at the pins) are green at 235 migrations [report]. Two things are owed:
- the targeted run of `workspace-closure.spec.ts`;
- the integration vitest for this round.

Both are in the controller's current full-gate run.
