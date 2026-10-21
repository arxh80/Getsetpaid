# Phase 8 Task 9c: an Owner closes their own workspace, and the superuser decides. INDEPENDENT REVIEW.

Range `b721290..ed26983`, worktree `legal-phase`, reviewed at `ed26983`
(migrations 224 -> 229: `20261021000000`, `20261022000000`, `20261022001000`,
`20261023000000`, `20261024000000`).

**VERDICT: MAJOR.**

The gates on the new RPCs are sound:
- The Owner's role check, aal2, the slug confirmation and the reason are each in the body and each mutation-tested.
- The superuser decisions read `platform_admins` and aal2 as separate gates.
- `closure_backup` has no client grant and is fenced by both triggers.
- The emails carry no reason, no actor and no new Owner.

Three things block a merge:

- **C1:** the "full workspace backup" cannot contain the workspace's finance lines. Q205's default rests on the backup carrying them, and it does not.
- **I1:** the Phase 7 reinstate, suspend and delete RPCs all accept `owner_closed`, and the `/super/organisations` page offers them. The decision flow can be bypassed in one click.
- **I2:** an Owner who closes and then erases before the backup runs gets the backup built as the tombstone.

## Method and constraints

The review was read-only. I ran no reset, psql runner, integration vitest, Playwright, dev server or DB query. Each claim below is marked **[verified]** (I read it myself) or **[report]** (taken from `task-9c-report.md` or the controller).

- **[verified]** I read `git diff b721290 ed26983` for all five migrations, the server actions (`lib/org/closure-actions.ts` and `lib/admin/closures.ts`), `lifecycle-contract.ts`, `step-up-gate.ts` and the access libraries.
- **[verified]** For each of these I read the live definition it depends on:
  - the lifecycle guard (`20261005002000`);
  - the Phase 7 lifecycle RPCs and `lifecycle_target` (`20260908030000`);
  - `organisation_network_presence_active` (`20260908031000`);
  - `crm_write_organisations` and `finance_module_organisations` (`20260909000000`);
  - the finance SELECT policy (`20260903003000:84`);
  - `export_read_page` (`20260928002000`);
  - the export catalogue (`20260930007000`);
  - the membership policies (`20260828220000`).
- **[verified]** I spot-checked two mutants against the live definitions:
  - **20a** (`close_my_workspace`) differs from the live body by exactly one line, the removal of `m.role = 'owner'`. CG4 is the right red.
  - **20f** (`crm_write_organisations`) differs from the live definition (`20260909000000`) by exactly `and o.deleted_at is null`.
  - I also read **20g**: it is the intended `if true then return new`.
- **[report]** Gates from the controller:
  - psql: "All suites passed".
  - vitest: 168 files, 3799 passed.
  - **e2e: 177 passed, 1 failed.** The red is `tests/e2e/workspace-closure.spec.ts:86`, at `forgeSubmit` (`:65`): "the captured form carries no server-action fields to forge". The form renders `action="javascript:throw…"` with no `$ACTION` fields. This is a fault in how the test forges the form, not in the product, and a fixer is handling it. It is listed as I3.
- **[report]** The route budget is ~490 s of 600 s: digest 10 + Telegram 10 + lockouts 130 + erasure failures 10 + six loops x 55. I checked the arithmetic and the 45 s constant named in the diff of `requester-notifications.ts`. I did not re-time the route.

---

## Critical

### C1. The closure backup carries no `financial_entries` rows (and probably no `view_network`-gated rows): a 7-year financial record purged with no copy

**Statically derived, not executed.**

**The cause:**
- `close_my_workspace` sets `deleted_at` and queues the backup in the same transaction (`20261021000000`, § 4).
- The runner builds the backup **later, after the commit**. It reads through `export_read_page` with the **requester's claims** (`requester_rls`; `20260928002000:~110-130`). A workspace export has no elevated reads (`export_read_page` raises `workspace_export_is_requester_rls`).
- `financial_entries_select_view_finance` reads `permitted_organisations('view_finance')` (`20260903003000:84-86`). `view_finance` is not `survives_suspension` (only `view_crm`, `end_support_access` and `export_organisation_data` are). So once `deleted_at` is set, the Owner's read of finance returns nothing. CW11 measures exactly this: "finance: hidden, Q205".
- The catalogue lists `financial_entries` as `'exported', 'requester_rls'` (`20260930007000:74`).

**Result:** the closure backup's `financial_entries` file is empty.

**Q205 is decided on a false premise.** Its default says "keep it -- the closure backup carries the finance lines" (`DECISIONS-QUEUE.md:1281-1283`). The backup does not carry them.

**The same may hold for every other table whose SELECT keys on a permission that does not survive suspension.** `view_network` is used 8 times, and network profiles and requests are candidates. I did not enumerate them.

**Failure scenario:**
1. The Owner closes the workspace.
2. The superuser chooses delete.
3. The hourly sweep runs `erase_organisation`.

The finance ledger, which has a 7-year retention default, is gone, and the backup that was supposed to preserve it has zero finance rows.

**Not tested:** no test reads a closure backup's contents.

**Fix:** make the closure backup read the workspace as it was before the closure. For example:
- `export_read_page` treats a `closure_backup` job's organisation as live for `permitted_organisations()` under a transaction-local marker; or
- build the backup **before** setting `deleted_at`, in a pre-closure phase.

Then add an integration test asserting that each catalogue table's backup row count equals its pre-closure count, finance included. Re-ask Q205 with the true facts.

## Important

### I1. The Phase 7 lifecycle RPCs accept `owner_closed`, so the decision flow can be bypassed

**The cause:**
- `suspend_organisation` refuses only `suspended`, `delete_organisation` only `deleted`, and `reinstate_organisation` only `active` (`20260908030000:786, 842, 905`).
- `lifecycle_target` has no state filter.
- `/super/organisations` lists every non-active row (`lib/admin/lifecycle-list.ts:80`, `.neq("lifecycle_state","active")`) beside its Reinstate action. So an owner_closed workspace is shown there with a one-click Reinstate.

**Failure scenarios:**
- **(a) Reinstate.** The workspace returns to `active` with no `closure_reassigned` row and no admin email. If the closing Owner has already erased (which closure exists to allow), it is a **live workspace with no Owner**, the state Q131's last-Owner rule exists to prevent.
- **(b) Suspend or delete.** The `owner_closed` discriminator is lost, the item silently leaves `/super/closures`, the clock is re-stamped (a fresh 60 days), and the admins get no decision email.

**Fix:**
- Refuse `owner_closed` in `lifecycle_target`, or in each of the three RPCs, with a hint that points to the decision RPCs.
- Exclude owner_closed rows from `listWoundDownOrganisations`, or show them without forms.
- Add a psql test for each of the three RPCs and a mutation of the new refusal.

### I2. An Owner who closes and then erases before the backup runs gets an empty (or failed) backup

Step 5b of `erase_account` (`20261022000000:264-275`) re-points **any** `closure_backup` job, whatever its status, to the tombstone. Nothing makes erasure wait for a `queued` or `running` backup. `export_read_page` then installs `sub = requested_by` (the tombstone), which has no membership, so every `requester_rls` read returns 0 rows.

Close-then-erase is exactly the flow the ruling is for ("lets an Owner delete their own account"). Erasure and export run on independent ticks, so this ordering is reachable.

The tests do not catch it: CQ1-CQ3 erase with the backup still queued and assert only that the row survives, not that it can be built.

**Fix:** either
- `erase_account` refuses while the requester has a `queued` or `running` closure backup (a new hint, plus a sentence in `lib/erasure/runner.ts`); or
- closure backups are built under a workspace-scoped identity that does not depend on the requester (this would also fix C1).

### I3. The Owner-closure e2e is red

`tests/e2e/workspace-closure.spec.ts:86` fails at `forgeSubmit` (`:65`) [report]. Until it is green, two things are unproven in a browser:
- the forged-POST refusal for a Manager;
- the closed-state banner, the disabled control and the forged-create walk.

Listed only, per the controller; a fixer is on it. Also re-check the axe scan count that CLAUDE.md quotes ("178 tests in 30 files") against the run once it is green.

## Minor

- **m1 (Q215), ranked Minor.** `closed_workspace_reassign_candidates` (`20261023000000`) shows the superuser members' `full_name` and role, unaudited.
  - It is not "record content" in CLAUDE.md's sense, since it shows no contacts, events or documents.
  - It is narrow: owner_closed only, at aal2, and exactly the set reassign would accept.
  - It is still personal data read outside impersonation, and "superuser access audits itself" argues for an audit row (e.g. `organisation.closure_candidates_viewed`), as the feedback-screenshot view does.
  - It is the founder's call. It does not block.
- **m2.** `reassign_closed_workspace` does not refuse the **superuser themselves** as the new Owner, if a `platform_admins` user is an active member (`20261022001000`, reassign target select). The candidates RPC would list them. Fix: `and not exists (select 1 from public.platform_admins …)` in both.
- **m3.** The candidates list is capped at 200 with no next page, so the UI cannot reach a valid target beyond row 200, although the RPC would accept one.
- **m4.** Membership writes while closed are structurally refused twice: the `manage_members` policies carry `organisation_is_live()` (`20260828220000:200-211`), and `accept_invite` gates on `deleted_at`. So an Owner cannot add a new Owner to dodge the decision. **But the closure suite has no probe for invite, role change, remove or accept.** Add CW rows.
- **m5.** After a reassign, nobody can retrieve the closure backup. `export_jobs_select_own` is `requested_by = auth.uid()`, which is the old Owner or the tombstone, and Q209 gives the superuser no download. The backup is useful only to the closing Owner before they erase. Say this in the closure section's copy and in SECURITY.md § 7, or decide otherwise.
- **m6.** The backup is built under the Owner's RLS, so colleagues' `private` notes are excluded. The "full workspace backup" copy should say so (the manifest note already does).
- **m7. Guards not mutation-tested** [verified from the report]:
  - the job-3b app guards in `closeMyWorkspaceAction`;
  - the `/super/closures` action guards (`authorise()`, the `confirmSlug` retype);
  - the integration test proves the RPC still refuses when the app is lied to, so this is acceptable.
  - **Q217:** the slug retype on delete is app-side only. A DB check is not needed: the RPC already takes the slug as its target and needs a superuser at aal2 with a reason, so the retype is a UX guard against misclicks, not a security boundary.

## Verified sound (no finding)

- **Who can reach `owner_closed`:**
  - Only `close_my_workspace` writes it, through definer bypass (`row_security_active` is false).
  - A direct UPDATE by an Owner or Admin is refused by the guard plus the policy (CD1, CD2, CW10).
  - The membership-row check excludes an impersonating superuser.
  - An Owner cannot un-close. The RPC refuses a non-null `deleted_at`, and only `reassign_closed_workspace` or (see I1) Phase 7 reinstate can clear it.
- **Writes while closed:** `deleted_at` is the gate everywhere; mutant 20f confirms it on the CRM side. Network presence ends at once for `owner_closed` (`organisation_network_presence_active` admits only active, or suspended within its clocks).
- **The backup flag:**
  - `closure_backup` cannot be INSERTed by a client (column grants) and is fenced by a marker plus same-transaction `owner_closed` in the insert trigger.
  - It is immutable in the update trigger. The Q206 re-point is limited to a closure_backup row, moved to the tombstone, under the erasure marker (CQ5, CQ6).
  - It is unmetered and exempt from the index, but it can be repeated only after a superuser reopen, so it cannot be abused.
- **The decisions:**
  - Both run only from `owner_closed`, with the row locked.
  - The reassign target must be an active member and not the tombstone.
  - Reassign clears `deleted_at`, so the sync trigger clears both clocks.
  - Delete re-dates `lifecycle_changed_at` and hands off to the existing sweep.
  - The audit rows hold the reason, the backup, the slug, the name and the recipient snapshot, taken after the promotion (so the new Owner is told).
- **The emails:** the resolvers are `service_role` only and read the snapshot, not live memberships. The tombstone is excluded. Each notice is stamped at most once (one subject per notice, plus a unique index).

## Docs

CLAUDE.md's Q104 paragraph describes the shipped flow accurately, except:
- it does not mention I1's bypass;
- it does not say that the backup lacks finance (C1).

Both need correcting with the fixes. SECURITY.md § 7's new paragraph has the same omission.
