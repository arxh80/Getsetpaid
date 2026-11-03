# Phase 8 final review B: docs truth, scope, open questions, follow-ups

Reviewed at `605620e` (worktree `legal-phase`, 238 migrations). Read-only.
No database and no suite run. The only commands run were
`pnpm exec playwright test --list`, greps and arithmetic over the pins.
Reviewer A covers code. This review covers the ledger and the docs.

## VERDICT: MINOR

No finding hides a live security hole. One Important finding is in the
public sub-processor register (F1). It is a few lines of text, and it should
be fixed before the merge because the page is customer-facing. Everything
else is a stale number or sentence, each with its corrected text below.

## Measured at the tip

| Fact | Measured | Method |
|---|---|---|
| Migrations | **238** | `ls supabase/migrations \| wc -l` |
| psql suites / `run_suite` calls | **26 / 26** | `ls supabase/tests/*.sql`; grep `^run_suite` |
| Sum of the pinned totals | **4226** | summed from the 26 `run_suite` pins |
| Concurrency probes the runner calls | **2** (lifecycle, retention) | grep `probe.sh` in the runner. The erasure probe is standalone. |
| e2e | **178 tests in 30 files** | `playwright test --list` |
| `super-permissions.spec.ts` | **14** | `--list` |
| `/super` pages | **10**, plus the `[...unknown]` catch-all | `find app -path '*super*' -name page.tsx` |
| `service_role` runners (`SERVER_ONLY_RPCS`) | **23** | key count, `phase7-permission-matrix.test.ts:1276` |
| Audit action catalogue | **167** | pinned in `tests/integration/admin/audit-actions-match-db.test.ts:195` |
| Permission matrix | **not cheaply measurable** | The tests are table-driven (87 `it` sites) and need a database. The last measured value is **596** (`task-9c-report.md:359`, job 3a). Fix round 1b added RPCs after that, and nothing re-measured it. |
| Merge into `origin/main` (`68f96cf`) | **clean** | `git merge-tree`. Both parents of #25 are ancestors. The branch is **325 commits** over `origin/main`, not 546. |

## Findings, ranked

### F1 (Important): the Brevo register row omits every Phase 8 notification email

At `docs/sub-processors.md:34` (and the same row in `lib/legal/sub-processors.ts`, which the
public `/legal/subprocessors` page renders), the Purpose and Personal-data cells still list only
three emails: the feedback receipt, the incident digest and the lockout notice.

Since Task 9b/9c, Brevo also receives the following:
- the requester's email for a DSR received or closed notice, and for an export-ready notice;
- the emails of the active Owners and Admins, plus a counterparty's published display name, for connection-request notices;
- the assignee's email, the task title and the due date for a task reminder;
- the workspace name and slug, sent to the superuser, for a closure notice;
- the emails of the snapshotted Owners and Admins for a closure decision notice.

This breaks the register's own rule ("appears here in the same change that first sends it
personal data"). The drift test cannot catch it, because both copies agree.

**Corrected text.** Add this to Purpose, after "the account-lockout notice to the affected
account holder":

> ; since Phase 8 Task 9b/9c, the requester's data-subject-request received/closed and
> export-ready notices, the connection-request received/accepted/declined notices to the
> Owners and Admins (or the sender), task reminders to the assignee, and the workspace-closure
> and closure-decision notices (`lib/email/requester-notifications.ts`,
> `network-notifications.ts`, `task-reminder-notifications.ts`,
> `workspace-closure-notifications.ts`)

Add this to Personal data, after "the locked account's email address":

> ; for those notices, the recipient's email address plus a request reference, right and
> status, a counterparty's published display name, a task's title and due date, or a
> workspace's name and slug (never a note, rating, financial or the superuser's reason)

Edit both files in one change, update the drift fixture, and publish a Subprocessors version
(it stays a draft for counsel). Counsel should also check that the Privacy Notice covers these
emails.

### F2 (Minor): CLAUDE.md:91 says "twenty-five psql files" and "110 assertions"

Correct to: "(**twenty-six** psql files since Phase 8 Task 9c fix round 1 added
`rls_phase8_closure_backup.sql` (26 assertions); the workspace-closure suite is at **157**
since fix round 2; twenty-five since Task 9c job 1 added `rls_phase8_workspace_closure.sql` ...".

The same paragraph also says the retention suite is "**309 assertions**". Its pin is **312**,
since Task 9a fix round 1 (REL9a/REL11a/REL11b, which the pin list at :104-106 already records).

### F15 (Minor, factually false since Task 6): "there is no hard-purge path anywhere"

CLAUDE.md § Org lifecycle as shipped in Phase 7 Task 3, in the bullet "`deleted` is not
deleted", reads: "There is no hard-purge path anywhere in this product ... The purge past the
retention deadline is Phase 8+ machinery that does not exist." Task 6's 60-day workspace purge
(`erase_organisation()`, Q88/Q92/Q102) and Task 9c's `delete_closed_workspace()` both exist.
Correct to: "Since Phase 8 Task 6 the retention sweep purges a `deleted` (or `owner_closed`)
workspace 60 days after `lifecycle_changed_at` through `private.erase_organisation()`. Since
Task 9c, `delete_closed_workspace()` makes an Owner-closed workspace due at once (Q210). Until
the sweep runs, `reinstate_organisation()` still undoes a delete."

### F16 (Minor): "owed" lists that Task 6 closed

- In CLAUDE.md § Data exports: "**Three things are owed and queued** ... the BYTES of an
  expired archive are not purged until Task 6's retention job ...; a job left `running` ...
  wants a one-line reaper in that same job (Q166)". Both are closed by Task 6, as FOLLOW-UPS
  records ("Q166 ... CLOSED" and the archive sweep). Rewrite both as "purged by the Task 6
  sweep" and "reaped to `failed` after 1 h by the Task 6 sweep (Q166)".
- In CLAUDE.md § Erasure: "**Three things are owed and queued**" lists four. The third ("a job
  left `running` ... wants the same reaper Q166 asks for") and the fourth ("`erasure_jobs` has
  no retention rule of its own (Q175)") were both closed by Task 6: the Q166 reaper exists, and
  Q175 is closed at 90 days for failed jobs while succeeded jobs are kept. Keep Q174 (no
  success notice to the erased person) and the failure email, and state the other two as
  closed.

### F17 (Minor): "the erasure half is still dormant"

This appears twice in CLAUDE.md: in § Data subject requests ("the erasure half is still
dormant, which is exactly why ...") and in § Data exports ("The erasure half is still dormant
(Task 5)"). § Current state already says that marking an account-scope erasure request
`fulfilled` "now requires the job to have actually run". Correct both to: "the erasure half
went live in Phase 8 Task 5".

### F18 (Minor): the consent paragraph predates Task 5

CLAUDE.md § Consent, as built, says: "**No row is deleted in practice today:** the
`audit_events.actor_user_id` foreign key refuses the deletion of any account that has ever
consented, so how an account is removed is Task 5's decision and whether its consent history
survives is Q148". Since Task 5, `erase_account()` re-points that key at the tombstone, and the
consent ledger is deleted with the account (Q173, as § Erasure says). Correct to: "Since Phase 8
Task 5 a consent row is deleted only by the account's own erasure, which deletes the person's
whole ledger (Q173; the reason is in § Erasure)."

### F3 (Minor): CLAUDE.md:465 says "twenty-five psql files" and "twenty-five `run_suite` calls"

Correct to "**twenty-six** ... twenty-six `run_suite` calls since Phase 8 Task 9c fix round 1
added `rls_phase8_closure_backup.sql`, twenty-five since job 1 added
`rls_phase8_workspace_closure.sql` ...".

### F4 (Minor): the service_role runner census says 21

CLAUDE.md:467 and SECURITY.md:21 both say "**21** since Task 9b". Correct to "**23** since Phase
8 Task 9c job 2 (`pending_workspace_closure_notifications`,
`pending_workspace_decision_notifications`); 21 since Task 9b ...".

### F5 (Minor): the permission-matrix headline stops at 559 (9b job 3)

The headline is in CLAUDE.md:465 and in SECURITY.md:21, which says "548 tests ... 23
superuser-only and 12 member-reachable RPCs". Task 9c job 3a measured **596**
(`task-9c-report.md:359`), and fix round 1b's Q222/Q223/Q224 changed the RPCs again, so no
number for the tip exists. Re-measure on the next reset with `vitest run
tests/integration/security/phase7-permission-matrix.test.ts`. Then append "**N since Phase 8
Task 9c**" and re-count the superuser-only and member-reachable lists in SECURITY.md:21. The
superuser-only list now includes reassign, delete and candidates, and the member-reachable list
includes `close_my_workspace`.

### F6 (Minor): "over nine /super pages" is now ten

CLAUDE.md:470 and SECURITY.md:770 say nine. Since Task 9c job 3a there are ten: the hub,
audit-log, billing, closures, data-requests, feedback, health, impersonation, legal and
organisations. Correct to "over **ten** `/super` pages (nine until Phase 8 Task 9c job 3a added
`/super/closures`)". The census is a glob, so the tests are right and only the sentence is stale.

### F7 (Minor): CLAUDE.md:40-41 says Task 9c's two specs are "collected, not passed"

The sentence reads: "neither job's spec has been RUN yet, so these are collected, not passed".
That is false at the tip, because the full gate at `b0eac34` ran **178 passed / 0 failed**
(progress.md, Task 9c entry). Correct to: "both specs have since run green in the full gate
at `b0eac34` (178 passed, 0 failed, 238 migrations)". Also change "by `--list` at 229
migrations" to "at 238".

### F8 (Minor): SECURITY.md:812 says Q213 is still pending

The paragraph says the clock function's live comment "still says eight and ~440 s until the
next migration reissues it, Q213". `20261024000000_incident_alert_clock_comment_ten_deliveries.sql`
reissued it, naming TEN deliveries and ~490 s. Correct to "(the clock function's comment was
reissued for ten deliveries and ~490 s by `20261024000000`, Q213)".

### F9 (Minor): docs/email-setup.md:110-117 has two false sentences

- "**Nothing in the repo schedules that call** — point an external cron at it" has been false
  since Phase 7 Q118. The `pg_cron` job `incident-alert-delivery` runs every 10 min through
  `private.deliver_incident_alerts()` and Vault. Correct to: "`pg_cron` schedules it every 10
  minutes (`private.deliver_incident_alerts()`, Q118). It needs the two Vault entries in
  `SECURITY.md` § 15, and without them it is a no-op."
- "**Deferred:** connection-request / general notifications — there is no notification
  subsystem at MVP (Q45)" has been false since Task 9b. Correct to: "**Built (Phase 8 Task
  9b/9c):** DSR, export-ready, erasure-failure, connection-request, task-reminder and
  workspace-closure notices, all through `lib/email/send.ts` on the same tick. Telegram
  carries the counts-only operator alert (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`)."

### F10 (Minor): CLAUDE.md:531 says the Supabase region is UK-based

The text says "since the company and its Supabase region are UK-based". Since founder
2026-09-30 (Q145), the region is Ireland (eu-west-1). Correct to "since the company is UK-based
(its Supabase region is Ireland, eu-west-1, inside the EU and covered by UK adequacy
regulations)".

### F11 (Minor): § Current state (CLAUDE.md:18) stops at Task 9a

It describes Tasks 1-7 and 9a but not the 9b notification emails and Telegram channel, nor the
9c Owner-initiated closure. Both are described further down (CLAUDE.md:290, :299, :346, :376),
so append one clause: "and — since Phase 8 Task 9b — **all notification emails** (DSR,
export-ready, erasure-failure, connection requests, task reminders) and a counts-only
**Telegram** operator alert on the same 10-minute tick, and — since Task 9c — **an Owner may
close their own workspace** (read-only, automatic backup, a superuser reassign/delete decision
at `/super/closures`, the Q88 60-day purge as the backstop)".

### F12 (Minor): FOLLOW-UPS.md has no Phase 8 Task 7, 8, 9a or 9c section

The ledger ends at "Opened by Phase 8 Task 9b fix round 2" (line 4495). Items owed by Tasks
7, 8, 9a and 9c live only in progress.md and the task reports, which breaks standing lesson
8. Copy the deduplicated list below into a "Phase 8 Tasks 7-9c — owed at the PR" section.

### F13 (Minor, pre-existing, flagged only): a scope contradiction in CLAUDE.md

CLAUDE.md:480 lists "**public profiles and connection requests**" as Not MVP. CLAUDE.md:490
(Decisions log, "Network discovery: request-to-connect") and the whole of Phase 6 shipped
connection requests. Suggested wording: "public (logged-out) profiles". The connection requests
that shipped are the MVP discovery model.

Phase 8 added two things that are not on the Not MVP list, and both were founder-ruled on
2026-09-30, so neither is scope creep:
- **Notification emails.** Q45 had said there was no notification subsystem at MVP.
- **Owner-initiated closure.** This reverses Q104.

### F14 (note, founder awareness): `/super/closures` shows member names

CLAUDE.md § Superuser dashboard says the dashboard shows "only aggregate metadata". The
reassign picker on `/super/closures` lists a closed workspace's member names and roles (Q215,
now audited as `organisation.closure_candidates_viewed`, Q223). This is a second deliberate
exception besides feedback screenshots. § Superuser dashboard should name it, as § In-app
feedback names the screenshot exception.

## Open founder and counsel questions (Q188 onward, status not answered)

**Needs the founder now**
- **Q227.** The closure-backup read marker sits in `permitted_organisations()` /
  `has_permission()`, on the network-leakage path. The controller took default (a), pending
  the founder. The founder also needs to confirm the `export_job_id` column on
  `private.closure_backup_reads`.
- **Q228.** A failed closure backup is never rebuilt. The options are (i) an audited
  `requeue_closure_backup` RPC, (ii) separate, higher ceilings for closure backups, or (iii)
  keep the acknowledgement checkbox, which is current behaviour.
- **Q189.** The default was "YES, audit an Owner's rename with `organisation.updated`", and it
  is **not built**. `organisations` stays the one excused table in the audit census.
- **Q205.** Members of a closed workspace cannot read its finance lines (built; confirm).
- **Q209 / Q226.** Nobody can retrieve a closure backup after a reassign, and the superuser
  has no download.
- **Q212.** The decision email does not carry the superuser's reason.
- **Q215 / Q223.** The superuser can read member names (see F14).
- **Q200.** There is no dashboard view of a failed erasure's reason.
- **Q195.** A ceiling release cannot be revoked early.

**Needs counsel**
- **Q194 / Q197.** What the account export must include under Q167 (an operator account id
  versus a name; only the sessions the subject decided).
- **Q198.** Telegram as a no-personal-data channel with no register row.
- **Q199.** An erased requester gets no closure email.
- **Q201.** The 7-day window on notices.
- **Q188.** A `network_link` audit row seen against the Q82 privacy promise.
- **Q193.** The region is stated as fact and needs a deploy-time check.
- **F1.** The Brevo register.
- **Still waiting from before Q188:** Q130, Q132, Q133, Q139, Q140, Q146, Q148-Q150, Q158,
  Q173, Q177 and the retention-page gaps. **All fifteen legal pages are unreviewed drafts.**

**Safe defaults, already built.** Q190, Q191, Q192, Q196, Q202-Q204, Q206-Q208, Q210, Q211,
Q213 (done, `20261024000000`), Q214, Q216, Q217, Q219-Q225.

## Follow-ups owed (deduplicated, not closed later)

1. **F-T7-1.** REFUSAL PARITY runs in 50+ s against a 60 s timeout. Split it or give it its
   own timeout, never retries (progress.md, Task 7).
2. **Task 7 N1/N2.** Accounts erased before `20261007000000` are not revisited, and a
   concurrent writer can land an id after the 10b scan (progress.md, Task 7).
3. **F-T8-1.** The 5 s unit-test timeout under load (progress.md, Task 8).
4. **Task 8 M2/M3.** The "guard" mechanism is only "a 42501 raised by the function", and the
   destructive-primitive census is derived from a name regex. Accepted, and the re-reviewer
   asked to carry both (`task-8-rereview.md:79`).
5. **Task 1 fix round 2 (`13141f0..7ab1922`) and Task 2 fix round 2 (`f239ed7..c545f7e`).**
   Neither was independently re-reviewed. progress.md hands both to the final review (Reviewer
   A's scope).
6. **Q218.** Six `/[orgSlug]/network/*` pages still say "This workspace is suspended" in a
   closed workspace (measured: `network/{page,links,profiles,profiles/[id],requests,[profileId]}`).
   `linked-identity-section.tsx` and `support-access/page.tsx` were not checked.
7. **Q189.** The `organisation.updated` audit (see above).
8. **9c re-review 2 n1-n3.** The active-Owner check takes no membership lock, the
   suspended-ownerless branch of N2 is untested, and `acknowledged_no_backup` is derived rather
   than taken from the parameter (`task-9c-rereview2.md`).
9. **9c m7.** The app guards in `closeMyWorkspaceAction` and the `/super/closures` actions
   were not mutation-tested (`task-9c-review.md:130`). The integration test covers the RPC.
10. **9a 17c.** The integration layer of the reason-check mutant was not run
    (`task-9a-report.md:183`). The m-test at `task-9a-rereview.md:90` was not mutation-tested.
11. **9b residuals already in FOLLOW-UPS:**
    - m4: the stamps are written on the app clock;
    - m6: there is no PostgREST timeout;
    - a bare domain is still autolinked;
    - 30+ workspaces of one tenant can fill a batch;
    - N3: any `build()` throw drops a notice permanently;
    - `private` is blind to the export and audit censuses.
12. **9b gap.** `/super/health` shows no per-channel delivery status, and the `/super` hub
    shows no open-alert count (`task-9b-report.md:20`).
13. **Deploy-time items.** Four runner bearer secrets and Vault pairs, the Brevo env, the
    Telegram env, region `eu-west-1`, the IONOS host region (PENDING) and the real malware
    scanner (Q42) are all in `SECURITY.md` § 15. None of them is configured by the repo.
14. **The matrix total at the tip** (F5).
15. **CI is still a subset.** Q169 (heavy jobs on PRs and main for a month) is ruled but not
    built. It is Phase 9, together with merging `infra-parallel-stacks`.
