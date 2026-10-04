# Phase 8 Task 9b: all notification emails and Telegram incident alerts. INDEPENDENT REVIEW.

Range `e8c00f3..026c62c`, worktree `legal-phase`, reviewed at `026c62c`
(migrations 216 -> 220: `20261014000000`, `20261015000000`, `20261016000000`,
`20261016001000`).

**VERDICT: MAJOR.**

Most of what the task built is sound. The Telegram channel is allowlisted by
construction and the token is scrubbed. The stamps cannot be moved from a
browser. Recipients are resolved in the database from `auth.users` through
active memberships. The route's worst case of ~440 s is correct.

Four things block a merge:

- **C1, a pre-existing Phase 6 hole:** a sender can INSERT a connection request that is already `accepted`. The Q203 grant measurement in this task walked straight past it, and job 3's new emails make it quieter, because the target is never emailed.
- **I1:** commit `348523a` deleted 893 unrelated lines of `FOLLOW-UPS.md`.
- **I2:** one tenant can starve every platform-wide connection notice or task reminder for seven days with poison rows.
- **I3:** the "one link only" rule can be bypassed with a mixed-case nested scheme.

The controller's known red (I4) is a census miss. I checked whether other censuses missed the ledger the same way.

## Method and constraints

The review was read-only. I ran no reset, psql runner, integration vitest, Playwright, dev server or DB query. Each item below is marked **[verified]** (I read or ran it myself) or **[report]** (taken from `task-9b-report.md` or the controller).

- **[verified]** I read `git diff e8c00f3 026c62c` for every product file and all four migrations.
- **[verified]** Lesson 4: the reissued `private.incident_alert_resolution_guard()` in `20261014000000`, diffed against its true latest definition `20260926000000`, differs by exactly the one `telegram_notified_at` line plus a shortened comment. `private.retention_subjects()` in `20261016000000` adds one row, and its header says it was rebuilt from the live catalogue.
- **[verified]** I recomputed the overlap budget from the code:

  | Delivery | Worst case |
  |---|---|
  | Digest | 10 s |
  | Telegram | 10 s |
  | Lockouts (120 + 10) | 130 s |
  | DSR (60 + 10) | 70 s |
  | Export (60 + 10) | 70 s |
  | Erasure | 10 s |
  | Connections (60 + 10) | 70 s |
  | Reminders (60 + 10) | 70 s |
  | **Total** | **440 s**, against the 600 s cadence |

  Caveat: the resolver reads and stamp RPCs carry no timeout (m6).
- **[verified]** I emulated `oneLine()` and the `assertOnlyLink()` regex in node, in the scratchpad (I3).
- **[verified]** I spot-checked three mutants against the live definitions and the assertions they cite. All three are the intended single change and would go red:
  - **M3a** removes the task-status term from `pending_task_reminder_notifications`. NX8 batches `t_done` and `t_cancelled`, and its expected value is `0`.
  - **M3b** removes the status term from `mark_notices_delivered`. NL12 stamps `t_done`, `t_deleted` and `t_future`, and its expected value is `0`.
  - **Tombstone exclusion removed** from `pending_dsr_notifications`. NR3 expects `0`, and NR3a proves the tombstone really has an address, so NR3 measures the exclusion rather than an empty join.

  NS12 (stamp plus `fulfilment_kind` as `service_role`) passes the grant layer, so it measures the moves-alone check. The mutant run logs are not in `mutation-results/`, so the red counts are **[report]**.
- **[report]** Gates: the psql suites all passed, e2e 175/0, and the controller's `pnpm test` has one red (I4).

---

## Critical

### C1. A sender can INSERT a connection request as `accepted`: a self-granted connection, now also unannounced

**Pre-existing since Phase 6. Statically derived and not executed. It needs a one-statement probe.**

**Where:**
- `supabase/migrations/20260904003000_network_rls_policies.sql:276-295`: the INSERT policy has no `status` term.
- `20260904000000_network_tables.sql:380,412`: status may be any of four values, and the only tie is `(status = 'pending') = (responded_at is null)`.
- The only status guard is BEFORE UPDATE (`:402-406`).
- The two BEFORE INSERT triggers (`20260904006000`: fill the recipient org; `20260909060000`: the meter) never read `status`.
- Grant: `20260904000000:635`, table-level `insert` to `authenticated`.
- I grepped the RLS and leakage suites and found no INSERT-as-accepted assertion.

**Failure scenario:**
1. A paid-tier Manager with `manage_network_connections` POSTs `/rest/v1/network_connection_requests` with `status: "accepted"`, `responded_at: now`, and a target profile.
2. `public.network_connected_profiles` (`20260904004000:134-140`) keys on `status = 'accepted'` alone, so the target org's `connections`-level fields resolve for the sender without consent. This breaks CLAUDE.md's "never unlocks until both sides accept".
3. **Task 9b relevance:** `pending_connection_request_notifications` emails the target only for `status = 'pending'`. A forged accepted row skips the target's "received" email, the only signal 9b gives it, and instead emails the sender's own org "accepted". Job 3 measured this table's table-level INSERT grant for Q203 but did not ask what else the grant admits.

**Fix:**
- Add `and status = 'pending' and responded_at is null and responded_by is null` to the INSERT `WITH CHECK`.
- Add a BEFORE INSERT trigger that refuses any other status for every writer.
- Add a psql assertion with the direct POST as the subject, plus a positive control.
- Consider column-narrowing the INSERT grant (Q125's remedy, as Q203's alternative already suggests). It would also close m3.

## Important

### I1. `348523a` deleted 893 unrelated lines of FOLLOW-UPS.md **[verified]**

**Evidence:** `FOLLOW-UPS.md` went from 4442 lines to 3570. `git diff 656362b 348523a -- FOLLOW-UPS.md` has a hunk `@@ -3554,896 +3568,3 @@` that removes every section from "Opened by Task 5 (the consolidated network-leakage suite)" onwards:
- the column-level-grants alternative;
- every minor from the Phase 6 Task 1-5 reviews;
- the Task 6 and pre-PR review entries;
- the Q70-Q88 one-liners;
- the Keyboard-a11y pass;
- the Phase 7 Task 7 exit notes;
- Phase 8 Tasks 4, 5 and 6, including "what is still owed" after Task 6 fix round 1.

The report claims an 18-line doc fix. This looks like a truncated rewrite of the file.

**Failure scenario:** the owed-work ledger silently loses roughly 50 open items. That is standing lesson 8 in reverse.

**Fix:** restore `FOLLOW-UPS.md` from `656362b`, re-apply only the intended hunks (`@@ -2546` and `@@ -3536`), and check the result with `git diff 656362b -- FOLLOW-UPS.md`.

### I2. Poison rows starve a shared 30-row queue for seven days **[verified, static plus node emulation]**

**Where:**
- `lib/email/requester-notifications.ts:113-120`: a `build()` throw counts as `failed`, stamps nothing, and is retried on every tick.
- The resolvers `LIMIT 30` ordered oldest first: `20261016000000:289` (`order by u.since`) and `:323` (`order by t.reminder_at`).

**Trigger:** any member can create a task titled `https://`. `oneLine` turns it into `""`, which throws "empty title" (`lib/email/task-reminder-template.ts:266-267`). The CHECK at `20260902000000:75` allows it because `btrim` of the title is not empty. `hthttps://tps://x` also works: it becomes `https://x`, and `assertOnlyLink` throws.

**Failure scenario:**
- A member of any workspace creates 30 such tasks with a past `reminder_at`. They become the 30 oldest owed rows.
- Every tick refetches them, refuses them all, and never reaches the next row. Every other workspace's task reminders are starved until the poison ages out of the seven-day window.
- The same works for connection notices through a published `display_name`, at 10 requests an hour per org, so about 3 hours to fill 30 slots.
- The same holds for an address Brevo permanently rejects.

**Fix:**
- Make content handling total. Strip free-text schemes to a fixed point, or neutralise `://` itself, and render without throwing for user-authored text.
- Record a deterministic refusal as terminal, for example a `refused` ledger row or stamp, so it leaves the queue.
- Or exclude rows after N failed attempts.
- Add a test with 31 poison rows ahead of one good row.

### I3. The one-link rule is bypassable: a cross-tenant phishing link in a GetSetPaid-branded email **[verified, node]**

**Where:** `lib/email/notice-render.ts`.
- `oneLine` (`:328-331`) strips `/https?:\/\//gi` in a single pass.
- `assertOnlyLink` (`:301`) matches `/https?:\/\//g`, which is case-sensitive.

**Failure scenario:**
1. A malicious org publishes the display name `Acme. Verify at HThttps://TPS://evil.example/login`.
2. One pass of `oneLine` produces `HTTPS://evil.example/login`. The check finds no lowercase match, so it passes.
3. The org sends connection requests. The targets' Owners and Admins receive a "wants to connect" email from the product carrying a scheme-qualified URL, which mail clients autolink.
4. Separately, `www.evil.example` is never stripped and is autolinked too.

The in-app directory shows the same text, but the email is a stronger lure, and the header's "can never be a second link" is false.

**Fix:**
- Make the link check case-insensitive.
- Strip to a fixed point (loop until unchanged), or neutralise `://` and `www.`.
- Add the nested mixed-case fixture to `tests/unit/email/connection-reminder-templates.test.ts`.

### I4. The TypeScript retention census misses the first private table **[report: controller red; verified cause]**

**Where:** `tests/integration/rls/retention-matches-db.test.ts:124-132` counts `pg_class` in `public` only. Since `20261004005000` the roll derives from `public` + `private`, and `private.notification_deliveries` is the first private base table on it, so the roll is 55 and the count is 54.

Job 3 ran `tests/integration/{email,security,export,retention,erasure}` but not `tests/integration/rls`, which is why it shipped red. A fixer is handling it.

**Same-shape check [verified]:**
- **The other public-only censuses do not cover the ledger at all**, and none reds:
  - `tests/integration/export/completeness-census.test.ts:486` (pinned at 54, public);
  - `tests/integration/admin/audit-actions-match-db.test.ts:67` (counts trigger pairs; unaffected);
  - `private.export_catalogue()`, `private.audit_coverage()` and `private.fkless_identifier_columns()`, which cover `public`/`private` uuid columns. The ledger's two uuid columns are both FK'd, so it is fine there.
- **Two censuses see it:** the permission matrix's relation and privilege census does (job 3 asserted it), and the retention roll does (the reason for the red).
- **No second numeric miss found.**
- **Residual risk:** the export completeness and audit-coverage censuses are blind to `private` by design. Whether a workspace export owes its notification stamps is a judgement call, and the default (no) is fine, but nothing will ask it. Note this in FOLLOW-UPS.

## Minor

- **m1. A connection email can name a counterparty the requests page shows as "No longer available"** **[verified]**
  - The resolver (`20261016000000:286-287`) tests `p.status = 'published' and p.deleted_at is null` only.
  - The page resolves names through `network_directory` (`lib/network/requests-list.ts:28-40`). That view's base policy also hides a closed org's profile at once, and a suspended org's after its period end (Q88/Q101, `20260908031000`).
  - **Fix:** join `private.organisation_is_live()` or the same lifecycle predicate.
- **m2. Two doc counts are stale** **[verified]**
  - The `service_role` runner census is **20**, not 14. I counted `SERVER_ONLY_RPCS` in `phase7-permission-matrix.test.ts` from claim_erasure_job through start_retention_run.
  - The stale "14" appears at `CLAUDE.md:456` and `SECURITY.md:21`. The report flagged it as known and left it.
- **m3. `requested_by` is client-supplied on INSERT** (default `auth.uid()`, no stamping trigger, `20260904000000:397`).
  - A sender can name any colleague. The accepted/declined email goes to them only while they are an active member of the sending org, so it stays inside the tenant.
  - A sender can also back-date `requested_at`, and a responder `responded_at`, to suppress the counterparty's email.
  - Same root cause as C1, same fix: stamp both from the session and the clock.
- **m4. Telegram and digest stamps use the app clock.** `lib/email/incident-alerts.ts` stamps `new Date().toISOString()`, and the resolution guard returns early for `service_role` (row security inactive). The job-2 and job-3 stamps force `now()`. This is cosmetic, but inconsistent with "the db clock" elsewhere.
- **m5. Multi-recipient connection notices put every Owner/Admin in `To`.** That discloses colleagues' addresses to each other. The migration comment says they "see each other on its members page already", which I did not check. Use one message per recipient, or `bcc`, if that is not true for every role holding the recipient set.
- **m6. The 440 s bound covers Brevo and Telegram calls only.** `createServiceClient()` reads and the stamp RPCs carry no statement timeout. A hung PostgREST call is unbounded, so the overlap argument rests on the database answering. Consider a `statement_timeout` on the service client, or the RPCs.
- **m7. Q202's choices are sensible against the PRD.** The PRD names no recipient. Owners and Admins for "received" matches who can answer, and the current assignee follows the "owner" in PRD § 6.6.
  - The one-reminder-per-task (no re-arm) choice will surprise users who move `reminder_at`. Q202 states it, so this is not a defect.

## What holds (verified)

- **Telegram payload:** the input type is `{alertType}` only. Types are mapped through the closed vocabulary to `other`. `assertTelegramPayloadAllowlisted` runs on every render. The link regex is pinned to `/super/health`. Plain text with no `parse_mode`.
- **Telegram token:** scrubbed from both error paths (`lib/telegram/send.ts:75,94`). Neither the route nor the senders log a URL, and `next.config.ts` has no `logging.fetches`. `scripts/telegram-test-send.mjs` scrubs too. The channel is a no-op unless both env vars are non-blank (`:39-44`). `.env.example` has names only.
- **Channel independence:** each channel reads and writes only its own column, and `settle()` isolates throws.
- **Stamp-after-ok in every loop:**
  - `deliverEach` stamps last, only on `ok:true`.
  - The erasure notice and Telegram stamp after `ok`.
  - A crash between send and stamp gives at most one resend, which is acceptable.
  - Overlapping ticks can double-send but never double-stamp (`ON CONFLICT DO NOTHING`, `is(col, null)`). Overlap is unreachable at 440 s / 600 s.
- **Stamp security:**
  - `private.notification_deliveries` is revoked from all API roles and service_role.
  - `mark_notices_delivered` and `mark_erasure_failures_notified` are service_role-only and refuse any session.
  - **Smuggling** (WHEN-skipped table guard plus stamp guard): an UPDATE that moves a stamp skips the table guard, but `notification_stamp_guard` refuses any session first (42501). For a server role it refuses any other column change (moves-alone), and two stamps at once are refused because each guard sees the other's column move. No client role holds UPDATE on any stamp column. A browser therefore cannot move a stamp and smuggle another column.
- **Recipients:** current `auth.users.email`, never the `user_email` snapshot. Active memberships only. The tombstone is excluded. Reassigned or departed assignees are excluded at send time (NX10/NX11).
- **Docs:** CLAUDE.md's `reminder_at` and "arrives silently" bullets are rewritten and true. SECURITY.md § 12's Telegram passage says Dubai, no personal data by construction, and Q198. The remaining Q45 lines (support-access, org lifecycle) are about features 9b did not touch, so they are still true.
