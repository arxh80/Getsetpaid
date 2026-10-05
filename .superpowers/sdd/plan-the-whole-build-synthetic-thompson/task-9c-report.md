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

## Job 2 (superuser decision item, reassign/delete, Q206) -- DATABASE HALF

Founder 2026-09-30 (Q176/Q178 changed, reversing Q104). Migrations 225 -> 227.
Commits: `03bb377` (Q206), `9b3440e` (decisions + registries + suite),
`74c7033` (erasure hint sentences), `e510a3b` (CLAUDE.md totals, Q208-Q211).

**Q206 (`20261022000000`).** Three functions are rebuilt from their latest
`pg_get_functiondef`:
- `erase_account` step 5b re-points a `closure_backup` job's `requested_by`
  at the tombstone (the Q158 pattern). Its bytes check skips that job's
  archive.
- `erasure_purge_manifest` no longer names that archive.
- `export_jobs_before_update` admits only that one rewrite: a closure_backup
  row, moved to the tombstone, under erase_account's transaction-local marker,
  with nothing else on the row changing.

Tests: CQ1-3 close the workspace, erase the Owner, and find the backup row
still present (latest closure_backup row of the org). CQ4: the Owner's
ordinary export still cascades. CQ5/CQ6: every other re-point is still
`export_request_is_immutable`.

Side effect: the erasure hint roll is a textual walk, so it now reaches the
export guard. Eleven hints got a sentence in `lib/erasure/runner.ts`.

**Decisions (`20261022001000`).**
- `reassign_closed_workspace(slug, new_owner, reason)` and
  `delete_closed_workspace(slug, reason)`. Both are SECURITY DEFINER and share
  one guard helper with separate hints, in this order: session, superuser
  (`platform_admins`), aal2, reason (trimmed, at most 500),
  slug, `owner_closed` (row locked).
- Reassign requires an active, non-tombstone member. It promotes them to
  Owner and clears `deleted_at`, so the sync trigger returns the workspace to
  active and clears both clocks.
- Delete does not add a second engine. It sets lifecycle to `deleted` and
  dates `lifecycle_changed_at` one retention period back, so the existing
  hourly sweep (bytes first, then `erase_organisation`) purges it (Q210).
- Both write one audit row (`organisation.closure_reassigned` /
  `.closure_deleted`). It records who, the previous role, the reason, the
  backup job, and a snapshot of the remaining active Owner/Admin user ids.
  The snapshot is taken because the purge cascades memberships.
- Dashboard RPC `closed_workspaces_awaiting_decision`: aal2 superuser only,
  keyset paginated, at most 50 per page. It returns aggregate metadata and the
  backup's status. There is no download (Q209).
- Email queues on the existing ledger. It gets an `audit_event_id` column,
  three notices, a rebuilt one-subject CHECK and a written-once index (lesson
  15: these pin the column). `mark_notices_delivered` and
  `mark_notices_undeliverable` are rebuilt from live with a branch for the new
  notices. Two service_role resolvers:
  - `pending_workspace_closure_notifications`: slug, name and closed-at, for
    the SUPPORT_CONTACT_EMAIL inbox;
  - `pending_workspace_decision_notifications`: the snapshotted recipients,
    tombstone excluded.
- If the founder never acts, the 60-day purge still applies: CX6, plus job
  1's CP1, which is unchanged.

**Registries.**
- Audit catalogue 164 -> 166: `audit-actions.ts`, the DB copy, PA6c, and the
  integration size test.
- Permission matrix: the two decisions and the list are SUPERUSER_ONLY. Each
  has an invariant (org B stays active) and a positive control that reaches
  the owner_closed check. The two resolvers are SERVER_ONLY.
- Runner pin cw 64 -> 110. CLAUDE.md re-summed: 25 suites, **4150** at 227
  migrations. The "twenty-four"/"4036" wording is fixed.

**Mutations.** Each was applied live and run against the closure suite, with
the control at 110/0 after every restore:

| mutant | red |
|---|---|
| no superuser gate | CS4, CS4b |
| no aal2 | CS5, CS5b |
| no reason check | CS6, CS6b, CS8-9, CQ7, CR1, CR5-7 (11) |
| no owner_closed check | CS7, CS7b, CR2, CX3 |
| reassign target need not be active | CS8c, CS9, CQ7, CR1, CR5-7 |
| recipients not limited to Owner/Admin | **first 0 red (FALSE GREEN)**: no non-admin member existed. A Manager was added to org B -> CX3, CX5 |
| list gate removed | CS3, CS3b |

The "stamp-after-ok" mutation was NOT run, because there is no sender yet
(below).

**NOT BUILT (owed, next job):**
- the TS senders on the tick: the superuser closure email to
  SUPPORT_CONTACT_EMAIL, and the decision email to the admins. Each needs an
  allowlisted builder with one /super or /<slug> link, a `deliverEach`
  loop, and stamps written only after ok through `mark_notices_delivered`;
- the stamp-after-ok mutation;
- the route's budget re-measured (+2 loops; Q204 says tighten to 45 s);
- the /super "Closed workspaces awaiting decision" page with its two step-up
  action forms, plus its e2e and axe scans.

The database half is complete and tested without them.

**Gates:** see "Job 2 gates" below.

### Job 2 gates
- `pnpm lint` and `next typegen` + `pnpm typecheck`: clean.
- After a reset at 227 migrations, `run-rls-tests.sh` reported "All suites
  passed": 25 suites at their pins (closure 110, erasure 212, PA6c 166) and
  API surface all passed, exit 0. It ran once, because the runner refuses a
  second run without a reset. The closure suite alone ran twice on one DB,
  110/0 both times.
- After a fresh reset, vitest over `tests/unit`, `tests/integration/{admin,email,rls}`
  and the permission matrix: 119 files, **3302/3302** green.
- No e2e, because no UI was added.

## Job 2b (closure senders)

Founder 2026-09-30, Q176/Q178. TypeScript only; no SQL, so migrations stay
at 227 (227 -> 227 before and after every run). Commits: `83431ca` senders +
templates + route + budget + tests, `8b702d0` SECURITY.md § 12 + Q212-Q214.

**Design.**
- `lib/email/workspace-closure-templates.ts`: two pure builders, each with an
  allowlist checked on every render and the shared one-link check on the
  final subject/text/HTML.
  - Closed -> superuser: slug, name (neutralised by `oneLine`), closed-at as
    a UK-local date (`formatDate`, `lib/format/date.ts`), one link to
    **`/super/closures`** (`SUPER_CLOSURES_PATH`; job 3 builds the page
    there, Q214).
  - Decision -> admins: what was decided and when. Reassigned links
    `/<slug>`. Deleted links **`/`**, the post-sign-in hub, because no
    workspace page exists and there is no `/account` root (Q214). There is
    no reason (Q212), no actor and no new Owner.
- `lib/email/workspace-closure-notifications.ts`: two loops over job 2's
  resolvers using the shared `deliverEach`. The stamp goes through
  `mark_notices_delivered(notice, [audit_event_id])` only after ok:true. A
  deterministic refusal goes through `mark_notices_undeliverable`. Decision
  recipients are the resolver's snapshot only, Bcc'd when there are several.
  An empty snapshot is a terminal `no_recipient`. An unset
  `SUPPORT_CONTACT_EMAIL` sends nothing and records nothing, because it is a
  deployment setting and not a property of the row.
- Route: ten deliveries, each wrapped in `settle()`. The census of
  service-client importers grows by one.

**Budget, re-measured.** Two more 70 s loops would have put the route at
~580 s, so I took Q204's default:
- `REQUESTER_NOTICE_BUDGET_MS` is now 45 s (was 60 s), so each loop takes
  ~55 s (the budget plus one in-flight 10 s send).
- Worst case: digest 10 + Telegram 10 + lockouts ~130 + erasure-failure 10
  + six loops x ~55 = **~490 s of 600 s**.

The live comment on `private.deliver_incident_alerts()` still says eight
deliveries and ~440 s. The next migration in this area must reissue it
(Q213).

**Tests.**
- Unit: templates 28 and sender 10. Plants (reason, superuser reason, actor,
  new Owner, `notify_user_ids`, backup job, contacts, `after`) are refused
  by both builders. A smuggled second URL is refused. The send-then-stamp
  order, failed and thrown sends, the unset inbox, and the empty snapshot
  are each covered.
- Delivery-route test: +1, the two loops run independently.
- Integration (real DB, stubbed transport, planted audit rows), 6 tests:
  - a failed send stamps nothing;
  - the retry stamps after the send (the ledger is read at send time);
  - a third tick sends nothing;
  - the closure goes to SUPPORT alone;
  - the reassigned decision reaches only the snapshotted Admin, **not
    org A's live Owner** (the denominator: a live-membership read would
    include them);
  - the deleted decision reaches exactly its two snapshotted ids;
  - no email carries the planted reason.

**Mutations (each went red, each restored, control 44/44 green after):**

| mutant | red |
|---|---|
| deliverEach stamps before the send | unit 5 + integration 4 |
| deliverEach stamps a failed send | unit 3 + integration 4 |
| decision recipients + the support inbox | unit 2 + integration 1 |
| resolver reads LIVE active Owners/Admins instead of the snapshot (live SQL, restored from `pg_get_functiondef`) | integration 1 |
| allowlist check removed | unit 20 |
| one-link check removed | unit 1 |

**Gates.**
- `pnpm lint` and `next typegen` + `pnpm typecheck`: clean.
- `vitest run tests/unit tests/integration/email`: 113 files,
  **2583/2583**.
- No SQL changed, so the psql runner was not run.
- Closing `npx supabase db reset --local` done (227 migrations).
- No e2e, because no UI changed.

**Still owed (job 3):**
- the `/super/closures` page with its two step-up forms, e2e and axe;
- the clock comment reissue (Q213).

## Job 3a (/super/closures)

Founder 2026-09-30 (Q176/Q178). Migrations 227 -> 228. Commits: `d8de240`
(candidates RPC + matrix), `f691edb` (page, actions, censuses), the e2e
commit after it, and this report + Q215-Q217.

**Built.**
- `app/(app)/super/closures/page.tsx` + `loading.tsx` at `SUPER_CLOSURES_PATH`
  (the job-2b email link now lands on a real page). `isSuperuser()` first
  await + gated `generateMetadata()` (census holds it). Lists
  `closed_workspaces_awaiting_decision` through a `CLOSURES_SPEC`
  (`lib/list` owns the cursor and page-size ceiling -- the one-cursor census
  refused my first hand-rolled `?after=`). Per row: name, slug, closed-at and
  purge-due (UK local, `formatDateTime`), days left, active member count,
  backup STATUS label only (Q209). A read failure is an Alert, not the empty
  state. The empty state teaches the closure -> decision -> purge flow.
- Two forms per row, inside `<StepUpGate>`; action state hoisted above the
  rows (a decided row unmounts on revalidate). `lib/admin/closures.ts`
  re-checks session, `isSuperuser()` and step-up, validates slug length,
  uuid grammar, reason <= 500 and (delete only) the retyped slug, then calls
  `reassign_closed_workspace` / `delete_closed_workspace`; refusals are mapped
  by the RPC's HINT. The org is re-derived by the RPC from the slug; the new
  Owner's membership is re-checked there.
- New RPC `public.closed_workspace_reassign_candidates(uuid)`
  (`20261023000000`): aal2 superuser only, `owner_closed` only (anything else,
  unknown ids included, `closure_candidates_not_owner_closed`), active
  non-tombstone members (exactly what reassign accepts): id, full_name, role;
  <= 200. SUPERUSER_ONLY in the permission matrix with a positive control.
- Registered: /super hub link, `SUPER_PAGE_URLS`, super-permissions
  `SUPER_SURFACES`, refusal-parity `PHASE8_SUPER`, use-server census.
- e2e `tests/e2e/super-closures.spec.ts` (2 tests, 2 axe scans): empty state
  reached through the hub link + scan; two workspaces closed via the REAL
  `close_my_workspace` as their Owner at aal2; populated scan; reassign to the
  Manager -> state `active`, membership `owner`, audit reason read back;
  delete with a mistyped slug refused (state unchanged), then retyped -> state
  `deleted`, audit reason read back.

**Gates.**
- `pnpm lint`, `next typegen` + `pnpm typecheck`: clean.
- `vitest run tests/unit`: 109 files, **2566/2566** (first run red on the
  route census x2, the one-cursor census -- all fixed -- and the known
  load-timed network DENOMINATOR, green on rerun).
- After a reset at 228: `run-rls-tests.sh` -> "All suites passed", API surface
  all passed, EXIT 0 (no pin moved; no psql assertion added -- the new RPC is
  proved in the matrix and the e2e).
- After a fresh reset: permission matrix **596/596**.
- **e2e NOT RUN.** Free RAM stayed at 2.2 GB (< the 3 GB floor; vmmemWSL
  3.2 GB) at every check, so neither `super-closures.spec.ts` nor
  super-permissions / refusal-parity was run. Owed: reset + `pnpm exec
  playwright test tests/e2e/super-closures.spec.ts
  tests/e2e/super-permissions.spec.ts tests/e2e/phase8-refusal-parity.spec.ts`.
- Closing `npx supabase db reset --local` done.

**Not done / owed.** The e2e run above; CLAUDE.md's e2e and matrix totals
(175 -> 177 tests in 29 files, +2 axe scans, matrix 596) are not re-summed
until that run measures them; Q213's comment reissue (not touched).
Questions: Q215 (member names to the superuser), Q216 (no index), Q217
(slug retype is app-side only).

## Job 3b (Owner close flow)

Founder 2026-09-30 (Q176/Q178). Migrations 228 -> 229. Commits: `Reissue the
incident-alert clock comment` (Q213), `e91f493` (closed-state copy), the close
flow, the erasure copy, the integration test, the e2e spec, the docs, and this
report + Q218-Q220.

**Built.**
- `20261024000000`: `comment on function private.deliver_incident_alerts()`
  reissued -- TEN deliveries, six notice loops at the 45 s budget, ~490 s of
  600 s (Q213). Comment only; body not rebuilt.
- Owner-only "Close this workspace" section on `/[orgSlug]/settings/export`
  (`#close-workspace`): consequences (read-only, full backup, superuser
  reassigns or deletes, purged after 60 days), typed slug, mandatory reason,
  inside `StepUpGate`. Rendered only for a non-impersonated Owner of a
  workspace that is active or owner_closed (then a statement replaces the
  form; the confirmation goes to the page's `ActionOutcome` region, which the
  revalidation cannot unmount).
- `lib/org/closure-actions.ts` (`closeMyWorkspaceAction`, on the use-server
  roll) + pure `lib/org/closure-contract.ts`: session -> workspace from the
  caller's own membership -> Owner and not impersonated -> `checkStepUp()` ->
  new `sessionIsAal2()` (`lib/auth/step-up-gate.ts`, verified claims) -> slug
  compared RAW (the RPC does not trim) and reason trimmed <= 500 -> RPC, every
  hint mapped to a sentence, raw DB text never echoed.
- Closed-state copy: `SuspendedBanner` says "was closed by its Owner", labels
  the Owner's reason, says GetSetPaid is deciding (reassign or delete) and
  that it is deleted at the retention date otherwise. `readOnlyExplanation()`
  (lifecycle-contract) now feeds the CRM, finance, network-publish and
  connections refusal sentences, so no disabled control in a closed workspace
  says "suspended -- contact support". Write gating unchanged (already the
  `deleted_at` flag).
- Erasure copy: the Q131 sentence (contract + runner) names where an Owner
  closes; `/account/erase` links each blocking workspace the reader owns to
  its close section.
- Docs: CLAUDE.md's Q104 paragraph now describes the whole shipped flow;
  SECURITY.md § 7 gains "An Owner closes their own workspace"; psql total
  re-stated at 229 migrations (still 4150 -- no pin moved); e2e "178 tests in
  30 files" from `--list` (collected, not run).

**Tests.**
- Unit `tests/unit/org/close-workspace-action.test.ts` (21): positive control
  reaches the stubbed RPC with the trimmed reason and the membership's org id
  (a posted organisationId is ignored); each non-Owner role, impersonation,
  a foreign slug, no session, an over-long slug, a read-only workspace, stale
  step-up and aal1 refuse with no RPC call; padded / cased / wrong slugs and
  blank / 501-char reasons are field errors (500 after trim accepted); every
  hint's sentence; `readOnlyExplanation()`.
- Integration `tests/integration/security/close-workspace-action.test.ts`
  (4, real DB): with `getCurrentOrg()`, step-up AND aal2 all mocked to say
  yes, a real aal2 Admin (`close_needs_an_owner`), an aal1 Manager
  (`close_needs_step_up`) and org B's aal2 Owner are refused BY THE RPC, with
  org A's state, closure-backup count and closure audit rows unchanged
  (denominator asserted first). 4/4 green.
- e2e `tests/e2e/workspace-closure.spec.ts` (1 test, 2 axe scans) -- WRITTEN,
  NOT RUN (memory constraint). Owner at aal2 reads the section (scan); a
  Manager sees no section, and the Owner's own server-action form, copied into
  the Manager's page and submitted natively, leaves the row active with 0
  backups and 0 closure audit rows; wrong slug refused; right slug ->
  `owner_closed`, 1 backup, reason on the audit row, confirmation in
  `export-outcome`; Manager reads the banner (closed by Owner, reason,
  awaiting decision, not "suspended"), disabled "New contact" with the closure
  sentence (scan); a forged create from the form captured while live lands 0
  contacts. Denominator: "New contact" asserted enabled and its form captured
  before the closure. Three new `fixtures.ts` helpers. Risk for the
  controller's run: the forge relies on React's progressive-enhancement
  `$ACTION` hidden fields (the helper asserts they are present), and
  `tearDownWorld` now runs over an owner_closed org with a closure backup row.

**Gates.**
- `pnpm lint`, `npx next typegen` + `pnpm typecheck`: clean.
- `vitest run tests/unit`: 110 files, **2587/2587**.
- Integration: the new file 4/4 (no other integration dir touched).
- psql: after `db reset` at **229** migrations, `run-rls-tests.sh` -> "All
  suites passed", API surface all passed, EXIT=0 (no pin moved).
- e2e: NOT RUN (brief); `playwright test --list` -> 178 tests in 30 files.
- Closing `npx supabase db reset --local` done.

**Not done / owed.** The e2e run (this spec plus job 3a's
`super-closures.spec.ts`, super-permissions and phase8-refusal-parity); no
mutation run of the new action (its guards are app-side duplicates; the
integration test is the "app lied to" layer). Questions: Q218 (network pages'
inline "suspended" copy), Q219 (section placement), Q220 (erase links by name).

## Gate follow-up

The controller's full e2e was 177/1: `workspace-closure.spec.ts` failed in its
own `forgeSubmit` precondition. The close form is a client component whose
action is a function prop, so its HTML carries no `$ACTION` hidden fields and
copying it into another page forged nothing. Reworked:

- **Forged close:** the Owner's real wrong-slug submit (step 3, moved before
  the forgery) is captured with `page.waitForRequest` (path + `next-action`
  header), and its Next-Action id, content-type, router-state header and body
  are REPLAYED via `fetch` from the Manager's signed-in page with the slug
  corrected. Asserted: the capture carried the action id and the typo; the
  forged body no longer does; the response is 200 and contains the action's
  own `CLOSE_MESSAGES.notOwner` sentence (an unknown action id cannot produce
  it); lifecycle `active`, backups 0, no `closed_by_owner` audit reasons.
- **Forged create:** a contact form opened in a second Manager tab while the
  workspace was live is submitted after the closure (a real hydrated form,
  the real action); the POST is captured and asserted to carry the name, the
  form's alert reads "closed by its Owner", contact count 0.

`pnpm lint` and `pnpm typecheck` clean. **The spec has not been RUN**: free RAM
was 1.9-2.4 GB, under the 2.5 GB floor, so the targeted e2e is owed.
