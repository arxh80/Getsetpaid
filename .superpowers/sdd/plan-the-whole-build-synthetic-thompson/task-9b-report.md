# Task 9b report

## Job 1 (req 2-3)

Founder 2026-09-30, Q111: incident alerts go by email, a dashboard notification and a Telegram bot; Telegram replaces SMS.

**Commits** (worktree-legal-phase, pushed): `20c1107` schema seam, `ffc55e8` channel, `f2cac2f` matrix fix, `8322169` docs + Q198. Migrations 216 -> 217 (`20261014000000`).

### A. Telegram channel
- `incident_alerts.telegram_notified_at`: its own stamp. `service_role` gets UPDATE on that one column. It is outside `authenticated`'s column grant and is in the reissued resolution guard's immutable set (rebuilt from the latest definition, 20260926000000). I also reissued the clock function's comment with the new worst case, ~150 s. That is the digest's 10 s, plus Telegram's 10 s, plus the lockout notices' 120 s budget and one more 10 s send.
- `lib/telegram/send.ts`: the one transport. It has a 10 s `AbortSignal` timeout and scrubs the token from every error string. `telegramConfig()` returns null, so the channel does nothing, unless BOTH `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` are set.
- `lib/telegram/incident-alert-payload.ts`: builds the message from an allowlist. The input type is `{alertType}` only. Alert types are mapped through the closed vocabulary, and an unknown one is counted as `other`. `assertTelegramPayloadAllowlisted` (fields `counts{alertType,count}`, `total`, `link` = /super/health) runs on every render, not only in tests.
- `deliverPendingIncidentAlertsToTelegram` (in `lib/email/incident-alerts.ts`, so the service-client census is unchanged) reads `id, alert_type` where `telegram_notified_at is null`. It sends one message and stamps only after ok:true. The email half never touches the Telegram column, and the Telegram half never touches `notified_at`.
- The route runs digest, then Telegram, then lockout notices. Each is wrapped in `settle()`, so one delivery throwing cannot skip the others. The response gains a `telegram` field, and `disabled` is not a 503.
- Env var names are in `.env.example`. No value was read, printed or committed. `scripts/telegram-test-send.mjs` is for the founder to run by hand; I did not run it.
- All tests stub the transport (global `fetch` in send.test, `sendTelegramMessage` in senders.test). No test makes a real send.

### B. /super dashboard
It already existed. `/super/health` has listed incident alerts since Phase 7 Task 5: keyset-paginated, with type, status and attribution filters, a search, and Resolve. It has an e2e walk and an axe scan with an alert on the page (`platform-health.spec.ts`), and the `/super` landing card links to it. I added no UI and did not run e2e.
- Gap noted, not built: the list does not show per-channel delivery status, and the `/super` hub shows no open-alert count.

### C. SECURITY.md § 12 and Q198
- § 12 now says Telegram (Dubai, outside the UK/EU) receives no personal data by construction, and describes the separate stamps and the test evidence.
- The old SMS sentences in SECURITY.md § 5/§ 12 and CLAUDE.md are rewritten.
- Q198 is queued with the default: no sub-processor row; documented as a channel that carries no personal data.

### Mutations (every one went red; nothing stayed green)
| Mutation | Layer that went red |
|---|---|
| M1a: allowlist's top-level key check removed | unit: 2 "planted" tests (summary, email) |
| M1b: count-field check removed | unit: 2 planted tests (id, organisationId on a count) |
| M1c: builder passes a row summary into the payload | unit: 3 payload tests + 2 delivery tests (render throws) |
| M2a: no-op only when BOTH variables are missing | unit: 4 config tests + 2 delivery no-op tests |
| M2b: delivery ignores missing config | unit: 3 delivery no-op tests |
| M3a: Telegram failure un-stamps `notified_at` | unit: 2 "stamps NOTHING" tests |
| M3b: Telegram success stamps the EMAIL column | unit: stamp-column test |
| M3c: an email failure skips Telegram | unit route: "FAILED or THROWING email digest still lets Telegram run" |
| M3d: a Telegram throw is not isolated | unit route: "THROWING Telegram still lets the lockout notices run" |
| M5: Telegram read widened to `summary` | unit: "reads ONLY id and alert_type" |
| M4a: browser can write the stamp (`grant update (telegram_notified_at) to authenticated`, live) | integration matrix: 4 red (the privilege census, its column PLANT, authenticated-only-resolution-flag, three-delivery-stamps); psql RD12t by construction |
| M4b: telegram clause removed from the guard (rolled-back transaction) | psql RD12bt predicate false |

RD13t's refusal comes from the grant first, so RD12bt reads the guard's own body to catch M4b.

### Gates
- `pnpm lint` and `pnpm typecheck` (after `next typegen`) are clean.
- After a reset, `run-rls-tests.sh` passed every suite: all 23 at their pins and the API surface checks all passed. The rate-limit pin went 183 -> 191 (RD11t-RD13v), so the total is 3908 at 217 migrations. It ran once, not twice: the runner refuses a second run without a reset.
- Vitest, `tests/unit` + permission matrix + alert-vocabulary census: 105 files. Before the matrix fix this run was 2905/2906, with 1 red: my new assertion did not exclude the table owner `postgres`. That is fixed in `f2cac2f`. The matrix then reran alone at 558/558; the full set was not rerun.
- There is no `tests/integration/email` directory.
- I ran no e2e, because I touched no UI.

## Job 2 (req 1: DSR, erasure, export emails)

Founder 2026-09-30, Q157(3)/Q174/Q45: build all notification emails through the one Brevo sender. This job built four: DSR received and DSR closed (to the requester), export ready (to the requester) and erasure failure (to the superuser). Connection-request and task-reminder emails are job 3.

**Commits** (worktree-legal-phase, pushed): `27e8b11` schema seam + psql suite + registries, `129c797` sender + templates + route + tests, `2a24252` marketing-sender census, `656362b` docs + Q199-Q201, then a matrix-expectation fix and this report. Migrations 217 -> 218 (`20261015000000`).

### Design
- **Stamps.** `data_subject_requests.received_notified_at` / `closed_notified_at`, `export_jobs.ready_notified_at`, `erasure_jobs.failure_notified_at`. `service_role` gets UPDATE on each column (plus SELECT on the two DSR stamps, because its DSR SELECT is column-narrow). No client role holds any UPDATE on these tables, so the browser is outside the grant by construction.
- **Erasure is the exception, measured.** Its CHECK `erasure_jobs_summary_is_counts` calls `private.jsonb_is_count_map()`, which `service_role` cannot execute, and a CHECK runs on every UPDATE. So any direct `service_role` UPDATE of that table is 42501. The stamp therefore goes through `public.mark_erasure_failures_notified(uuid[])`, a definer RPC for `service_role` only, with no column grant.
- **Stamp guard.** `private.notification_stamp_guard()` runs as one BEFORE UPDATE trigger per stamp. A stamp moves only from a server session, only from null (once, never cleared), only alone, only on a row in the right state (closed, succeeded or failed), and always to `now()`. It strips generated columns before the moves-alone check, because `due_by` reads as null in a BEFORE trigger.
- **Table guards.** I did not rebuild the three long guard functions (standing lesson 4). Each guard's trigger is recreated with `WHEN (stamps not distinct)`. Every update that leaves the stamps alone, a no-op included, still reaches the guard, and the guard functions are byte-identical. A whole-row WHEN was not possible: Postgres refuses NEW whole-row references in a BEFORE trigger's WHEN when the table has generated columns.
- **Recipients.** `public.pending_dsr_notifications()` and `public.pending_export_ready_notifications()` are `service_role` only, take no user argument and return at most 30 rows. Both read `auth.users.email` through the row's own user column. They never use the DSR `user_email` snapshot, and they exclude the Q130 tombstone by name, because it has an address of its own. They apply a seven-day window (Q201). The export resolver returns no key and no URL.
- **Content.** `lib/email/requester-templates.ts` holds pure builders. Every render checks the input's keys against an allowlist and checks that the body carries no URL except its one in-app link. The export notice links `/account/exports` or `/<slug>/settings/export` only. The erasure notice is a count plus `/super/data-requests`. No email includes a detail, a rejection reason or a failure reason.
- **Delivery: the existing tick for all four** (`lib/email/requester-notifications.ts`, three more `settle()` calls in the route). Each trigger is a database state change, mostly sessionless: operator closure, the erasure transaction's own closure, the export runner, `fail_erasure_job()`. A synchronous send would need four hooks plus a retry anyway. DSR received also rides the tick, so a submission never waits on Brevo. The cost is up to 10 minutes of latency.
- **Budget, re-measured.** The DSR and export loops each take 30 rows and a 60 s budget, checked before each send (~70 s each). The erasure notice is one 10 s call. Adding the digest (10 s), Telegram (10 s) and lockouts (~130 s) gives a worst case of **~300 s against the 600 s tick**. The clock comment is reissued with this.
- Sends are not audited (same as the digest and lockout senders), so no audit catalogue change.

### Mutations (every one went red)
| Mutation | Layer that went red |
|---|---|
| stamp before ok (sender stamps, then sends) | unit 4 (order, failed-send, thrown-send, export) + integration 3 (DSR failed-send, retry, export) |
| browser can write the stamp (`grant update (received_notified_at) ... to authenticated`, live) | psql NG1, NC1; matrix 3 (privilege census, its column PLANT, DSR no-client-write) |
| export-ready email carries a signed URL (one-link check removed + URL added) | unit 2 template tests + integration export test. With the check left in, the builder throws and every export test goes red |
| recipient from the wrong field: SQL `r.user_email` | psql NR1, NR4 |
| recipient from the wrong field: sender sends to the support inbox | unit 1 + integration 2 |
| tombstone exclusion removed | psql NR3 |
| "moves alone" check removed | psql NS12, NS14 |
| WHEN clause removed from export guard | psql NS3, NS6, NS8, NS10, NS13, NT4 |

### Gates
- `pnpm lint` and `next typegen` + `pnpm typecheck` are clean.
- `tests/unit`: 105 files and 2384 tests, all green. The marketing-sender census went red on the new importer until the importer was declared transactional.
- `tests/integration/email`: 5 of 5 green. These are real DB and service_role tests with a stubbed transport and no real sends.
- After a reset at 218 migrations, `run-rls-tests.sh` passed all 24 suites at their pins. The new suite is `rls_phase8_notification_stamps.sql` at 42. Total 3950. HTTP: 409 PASS / 0 FAIL, "All suites passed", exit 0. It ran once: the runner refuses a second run without a reset.
- Permission matrix: 558 of 558. The first run was 557/558: DSR's "service_role writes EXACTLY the two seam columns" assertion needed the two stamps, so I fixed its expectation. The grant mutation also reddened it.
- No e2e was run, because no UI changed.

### Questions
- **Q199:** no closure email goes to an erased requester, because the address is gone.
- **Q200:** the failure reason of a failed erasure has no `/super` view.
- **Q201:** the seven-day window.

## Job 3 (req 1 rest + req 4)

Founder 2026-09-30, Q157(3)/Q174/Q45: the last four notification emails (connection request received / accepted / declined, task reminder) and the doc fixes.

**Commits** (worktree-legal-phase, pushed): `c506e6b` ledger + resolvers + psql + matrix, `939ca5c` senders + templates + route + tests, `77d1814` comment-only migration (reminder_at), `348523a` docs + in-app copy + Q202-Q204, then this report. Migrations 218 -> 220 (`20261016000000`, `20261016001000`).

### Design
- **Recipients (Q202, PRD names none):** received -> the requested workspace's ACTIVE Owners + Admins on one message; accepted/declined -> the sender while still an active member of the sending workspace, else that workspace's active Owners + Admins; reminder -> the task's CURRENT active assignee (`owner_user_id`); no assignee -> nobody. Withdrawn requests are emailed to nobody. One reminder per task (no re-arm). Seven-day window (Q201's).
- **Stamps are a ledger, not columns (Q203) -- a deviation from the brief, measured:** `tasks` and `network_connection_requests` grant `authenticated` TABLE-level INSERT/UPDATE, so a `*_notified_at` column there is browser-writable (and insertable pre-stamped) the moment it exists -- the Q125 shape -- and a stamp UPDATE would also bump `updated_at` and write an audit row. `private.notification_deliveries` (notice, request_id | task_id, notified_at; FK-cascades with its subject): no privilege for anon/authenticated/service_role; ONE write path `public.mark_notices_delivered(notice, ids)` (service_role only, refuses any session with the stamp guard's hint, stamps only a subject still in its email's state); written once (unique per subject+notice, ON CONFLICT DO NOTHING); never updated (guard, `notification_stamp_is_written_once`); db clock forced. The retention roll (which sees `private` since 20261004005000) refused the job until the ledger was classified -- reissued from its latest definition with one `cascades` row.
- **Content:** connection notices carry the counterparty's display_name only while its profile is published (else no name -- the requests page says "No longer available") + one `/<slug>/network/requests` link; never an org name, member, responder, field, note, rating or financial; declined says only "declined" (what the Sent list says). Reminder: title, due date (UK local), one `/<slug>/tasks/<id>` link, never `detail`. Allowlist + one-link check on every render (`lib/email/notice-render.ts`); URL schemes in free text are stripped.
- **Delivery: the existing tick for all four**, not the server action: the action must not wait on Brevo, a PostgREST POST bypasses the action, and a reminder has no writer at fall-due time. Reuses job 2's `deliverEach` (now multi-recipient). Two more loops, 30 notices / 60 s each: route worst case **~440 s of 600 s** (clock comment reissued; Q204: if a ninth loop arrives, tighten to 45 s rather than add 70 s).
- Connection code lives on the network path (`lib/email/network-*.ts`), so the network leakage census sweeps it; it first went red when the reminder template shared the file (it names `/tasks/`), hence the split.

### Mutations (every one went red)
| Mutation | Red |
|---|---|
| M1 received -> the SENDING org (resolver) | psql NX1; integration 1 |
| M2 counterparty = organisation NAME (private) instead of published display_name | psql NX1, NX2, NX12; integration 3 |
| M2b allowlist check removed | unit 32 (every planted field) |
| M2c sender spreads the row into the declined builder | unit 3 |
| M3a resolver ignores task status (completed task reminded) | psql NX8; integration 1 |
| M3b stamp RPC ignores task status | psql NL12 |
| M4 browser can write the ledger (`grant insert, update ... to authenticated`, live) | psql NL1, NL6 (guard still refused, by its own hint); matrix ledger test |
| M4b browser can call the stamp RPC | psql NL2, NL5 |
| M5 stamp before the send | unit 5 + integration 4 |

### Gates
- `pnpm lint`, `next typegen` + `pnpm typecheck`: clean.
- `tests/unit` + `tests/integration/{email,security,export,retention,erasure}`: 121 files, all green after the fixes (first run: 2 red in the matrix's service_role-runner census until the three RPCs were declared -- by design).
- Permission matrix 558 -> 559. Notification-stamp psql suite 42 -> 78; also ran twice on one DB (pre-reset) green.
- After a reset at **219** migrations, `run-rls-tests.sh`: all 24 suites at their pins (notification stamps 78), total 3986, HTTP 409 PASS / 0 FAIL, "All suites passed", exit 0; 219 -> 219 across the run. The 220th migration (`20261016001000`) is a comment only and landed after that run; the closing reset applied it (220) and its comment reads back. Ran once (the runner refuses a second run without a reset).
- **No e2e run.** The UI change is copy only (requests page paragraph, the task form's reminder hint); no test asserts either string (grepped). A full `pnpm test:e2e` is owed before merge.
- Docs (req 4): CLAUDE.md's `reminder_at` and "arrives silently" bullets rewritten, counts (24 files / 3986 / 220 migrations, matrix 559); SECURITY.md § 12 (new notices, ledger, ~440 s) and the two "no notification subsystem" parentheticals in § 1; FOLLOW-UPS' connection entry DISCHARGED (withdrawn still unemailed, no toast) and the impersonation entry corrected; in-app comments on the hub, requests and support-access pages; `tasks.reminder_at`'s live column comment reissued.
- **Missed census, fixed after the controller's full `pnpm test`:** `tests/integration/rls/retention-matches-db.test.ts` ("the roll is exactly the catalogue") went red 55 vs 54 -- it is in `tests/integration/rls`, which job 3 did not run. Not a TypeScript copy: the test's own pg_class catalogue still counted `public` r/p only, while the roll has covered `public`+`private` r/p/m since 20261004005000; `private.notification_deliveries` was the first `private` table, so the DB roll (55, correct) outgrew the undercounted catalogue. Fix widens the test's independent catalogue to the roll's scope (stricter, not weaker). After a reset: that file 7/7, and rls + export + security + erasure + retention + crm-audit-coverage + every `*-matches-db` = 28 files / 925 green; lint + typecheck clean. Export completeness is `public`-only by design and stayed green.
- Known narrative drift not fixed here: CLAUDE.md's "censuses of the 14 `service_role` runners" (Task 8's count) -- the census list is now 20.

### Questions
Q202 recipients; Q203 ledger instead of columns; Q204 the tick's headroom (DECISIONS-QUEUE.md).

## Fix round 1 (part A: C1, I1)

### C1. Probe first (fresh `db reset`, 220 migrations, before the fix)

The probe ran in one rolled-back transaction. As `postgres` it planted two orgs, two users (sender = manager, target = owner), and two published profiles. The target's `contact_email` is at `connections`. Then, as `authenticated` with the sender's claims:

```
--- BEFORE: sender reads target via connected view
 display_name | contact_email
(0 rows)
--- THE FORGERY: sender INSERTs status=accepted
 status   | requested_by                         | requested_at                  | responded_at
 accepted | a1000000-0000-0000-0000-00000000000a | 2026-09-04 18:08:36.588578+00 | 2026-10-04 18:08:36.588578+00
INSERT 0 1
--- AFTER: sender reads target via connected view
 display_name    | contact_email
 Probe Target Co | secret@target.test
```

**It leaked.** The forged row landed with a back-dated `requested_at` (m3) and resolved the target's connections-level field without consent.

- This hole has existed since Phase 6.
- Task 9b made it silent: the target is emailed only about a `pending` row.

The same probe after the fix:

```
ERROR: network_connection_requests: a request is created pending (tried accepted); only the recipient can accept it
```

### C1. Fix: `20261017000000_connection_request_is_born_pending.sql`

- **Trigger:** `private.connection_request_born_pending()` is a BEFORE INSERT trigger named `born_pending`. It is SECURITY INVOKER and sorts before the fill and meter triggers.
  - It refuses with 23514: a status other than pending, a non-null `responded_at` or `responded_by`, or a `requested_by` other than `auth.uid()`.
  - It then stamps `requested_by := auth.uid()` and `requested_at := now()`.
  - It binds every role except `postgres` and `supabase_admin`, so `service_role` is included.
- **Policy:** `ALTER POLICY` on the INSERT policy adds `status = 'pending' and responded_at is null and responded_by is null`. It was rebuilt from the live `pg_get_expr`, and the policy comment was reissued.
- **Seeds:** the paths that plant accepted, declined or back-dated rows all run as `postgres`, so they are exempt and unchanged. They are `tests/e2e/support/fixtures.ts`, `discovery.test.ts`, `connection-reminder-notifications.test.ts`, `rls_phase8_notification_stamps.sql`, and the HTTP H4 fixture.
  - I chose the exemption over routing them through accept because several need back-dated `requested_at`.
  - No SECURITY DEFINER function inserts into this table.
- **Residual, logged in FOLLOW-UPS:** the responder half of m3 is still open. `responded_at` and `responded_by` on UPDATE are still client-supplied.

### C1. Assertions

**psql: `rls_phase6_network.sql` § NP, 16 new assertions (pin 127 -> 143).**
- NP0: the trigger exists.
- NP1-NP3b: forged accepted, withdrawn, pre-responded and foreign-`requested_by` inserts are refused with 23514. Each is asked by a raw INSERT, so no RPC is involved.
- NP5: the connected view returns 0 rows for the forger. NP5b is its control: after a real accept, the same query returns 2.
- NP4: as `service_role`, with the INSERT grant lent and then revoked, the insert is refused with 23514. NP4c checks the grant is gone again. NP4b checks no row was written.
- NP6-NP8: an honest pending insert succeeds, and its 30-day back-date is replaced by now() and `requested_by` by the session.
- NP9: the policy term is present, read structurally.
- NP10: the recipient accepts the born-pending row.
- NP12: housekeeping. The fixture is deleted so that LZ1b and the HTTP "4 published profiles" counts still hold.

**Pins updated:**
- NX2: 6/1/1 -> 7/2/1.
- `network_leakage_phase6.sql` LE1b: 11/2/13/26 -> 11/2/14/27.
- LE1d: the new function was added to its list.

**HTTP: a new "C1 at the API surface" block in `run-rls-tests.sh`.**
- The forger is GAMMA's manager, with a fresh published profile.
- The forged POST gets 400 (the trigger's 23514) and the connected view stays empty.
- The honest POST gets 201. The row is stored as `pending:true:true`, meaning born pending, with `requested_by` and `requested_at` stamped by the server. The view is still empty.

### C1. Mutation results

| Mutation | Result |
|---|---|
| Trigger dropped (full `run-rls-tests.sh`, temp migration, 222 migrations) | **12 red** in the network suite: NP0, NP1, NP2, NP3 and NP3b; NP4, NP4b and NP6; NP7, NP8, NP10 and NX2. **2 red** in leakage: LE1b and LE1d. See layering note 1. |
| Policy term reverted, trigger kept (rolled-back transaction) | The forged insert still gets 23514 from the trigger. Only the NP9 structural check reads false. See layering note 2. |
| Both layers off (rolled-back transaction) | The forged row lands and the connected view returns `secret@target.test`. The hole is back. |

Layering notes:
1. With the trigger dropped, NP1-NP3 became 42501, which is the policy holding. NP5 stayed 0, so the policy alone closes the leak for `authenticated`. NP3b landed, so `requested_by` forgery is caught by the trigger only. NP4 hit 23505 behind NP3b's row, but the trigger is the only layer that covers `service_role`.
2. With the policy term reverted, every behavioural assertion stayed green. The trigger holds.

### I1. FOLLOW-UPS.md restored

- The file was rebuilt from `656362b`, and only 348523a's two intended hunks (`@@ -2546` and `@@ -3536`) were re-applied.
- No commit after 348523a touched the file.
- `git diff 656362b --stat` shows 18 insertions and 4 deletions, exactly those two hunks. The file is 4463 lines.
- The C1 commit later added its own FOLLOW-UPS entry.

### Gates

| Gate | Result |
|---|---|
| `pnpm lint` | Clean. |
| `npx next typegen` + `pnpm typecheck` | Clean. |
| Reset + `run-rls-tests.sh` | "All suites passed", EXIT=0, 221 migrations. |
| `vitest`: network, rls, phase7-permission-matrix, connection-request-budget, connection-reminder-notifications | 14 files, 781 tests passed. |
| e2e `network.spec.ts` after a fresh reset | 1 passed. |
| `vitest run tests/unit` | One timeout under load, in `no-private-table-in-network-path.test.ts` (5.6 s against a 5 s limit). It passed when re-run on its own. |

### Commits

- `d29d46f`: I1.
- `f843c61`: C1.

## Fix round 1 (part B: I2, I3, minors)

**Commits** (pushed): `feb1f95` I3, `f111cda` I2, `7d79147` m1, `17ef401` m5, `88f30cb` m2 + m4/m6 accepted. Migrations 221 -> 223 (`20261018000000`, `20261019000000`).

### I3. One-link bypass
- `neutraliseLinks()` (`lib/email/notice-render.ts`): NFKC, `\p{Cf}` dropped, then every `<scheme>://` (any scheme, any case) and `www.` removed **until the text stops changing**. `oneLine()` uses it, so it never throws.
- `LINK_LIKE` / `assertOnlyLink()` (`lib/email/requester-templates.ts`, now the one check every builder uses): case-insensitive, any scheme or bare `www.`, on the NFKC-folded final subject/text/HTML.
- An empty-after-neutralisation title renders "Untitled task" (was a throw, an I2 poison source).
- Tests: the reviewer's two payloads, upper/mixed case, `www.`/`WWW.`, three-level nesting, other schemes, full-width, zero-width, newline-split, and two payloads that need a SECOND pass (`https:www.//evil`), across all four builders; a planted upper-case URL refused by the check.
- Mutants: one-pass `https?://` strip -> 45 red; case-sensitive check -> 1 red; both (the reviewed state) -> 46 red; fixed-point loop removed -> 8 red (the second-pass payloads; the first cut had none, and went green -- caught and fixed).
- Residual: a bare domain (`evil.example/login`) is left as typed (FOLLOW-UPS).

### I2. Queue poisoning
- Content is total (I3). A deterministic refusal (builder refused / no recipient) is TERMINAL: `public.mark_notices_undeliverable(notice, ids, reason)`, service_role only, refuses any session, written once, only for a subject in its email's state; the ledger gains `outcome` (`delivered`/`undeliverable`) and `reason` (`content_refused`/`no_recipient`) with an iff CHECK. A transient send failure is still retried.
- **Fairness: per-workspace rank.** Both resolvers order by `row_number() over (partition by recipient workspace order by age)` first, then age -- one slot per workspace per round. Residual: 30+ workspaces of one tenant could fill a batch (7-day bound).
- Integration `tests/integration/email/notice-queue-fairness.test.ts`: 31 poison reminders in A (builder wrapped to refuse "POISON" titles -- since I3 no person's text can), all older than B's one: B is sent in the SAME tick; all 31 end `undeliverable:content_refused`, none sent, none owed. Unit: refusal wiring, a hostile title SENT, a transient failure not terminal. psql § NU (13). Matrix runner census +1.
- Mutants: fair order removed (live, restored) -> 1 red (FAIRNESS); refusal not recorded -> 1 integration + 2 unit red.

### Minors
- **m1** fixed: the connection resolver calls `private.organisation_network_presence_active()` on the counterparty (the directory policy's own predicate). psql NX13-NX13b. Mutant (rolled-back probe, predicate removed): a closed workspace's profile named `M1 B venue` vs `<none>` live.
- **m2** fixed: runner census is **21** (20 + `mark_notices_undeliverable`) at CLAUDE.md and SECURITY.md § 2; psql pins summed: 4018 at 223 migrations.
- **m4** ACCEPTED: forcing `now()` means reissuing the shared incident-alert guard for every writer (fixtures back-date `notified_at`) plus a full re-run; ms-level drift on a server-only column. FOLLOW-UPS.
- **m5** fixed: several recipients are Bcc'd, To = the sender; one message, one stamp. Mutants: deliverEach always To -> 1 red; send.ts To=bcc list -> 1 red.
- **m6** ACCEPTED: the service client is shared with the long-running export/erasure/retention runners, so a blanket fetch timeout would break them; a per-caller one changes the 440 s arithmetic (~520 s). FOLLOW-UPS.

### Gates
- `pnpm lint`, `next typegen` + `pnpm typecheck`: clean.
- `tests/unit`: 2515, 1 red = `no-private-table-in-network-path` DENOMINATOR at 5.86 s vs a 5 s timeout under load (part A saw the same); 14/14 alone.
- Reset (223 migrations) + `run-rls-tests.sh`: "All suites passed", EXIT=0, notification stamps 94 as pinned, HTTP all passed; 223 -> 223.
- `vitest` email + rls + network + phase7-permission-matrix: 15 files, 783 passed (matrix 559).
- No e2e (no UI change).

## Fix round 2 (N1, N2, N3)

### N1. Probe first (fresh `db reset`, 223 migrations, before the fix)

The probe ran in one rolled-back transaction.

**Set-up, as `postgres`:**
- Three orgs: forger T, victim X and ally A.
- A Manager in each.
- Three published profiles. X's `contact_email` is at `connections`.
- An honest accepted T->A row.

**Forgery, as `authenticated` with T's claims:** T sent X an honest pending request (born pending, so C1's trigger accepted it), then raw-UPDATEd it.

```
--- BEFORE: forger T reads victim X through the connected view
(0 rows)
--- FORGERY 1: T repoints its own PENDING row to X->T accepted, back-dated responded_at
 b1000000-...-00000000000b | b1000000-...-00000000000a | accepted | 2026-09-26 19:39:03.268336+00 | a1000000-...-00000000000a
UPDATE 1
--- AFTER FORGERY 1: T reads X via the connected view
 Probe Victim X | secret@victim.test
--- FORGERY 2: T repoints its existing ACCEPTED T->A row at X (to_org/to_profile)
ERROR:  new row violates row-level security policy for table "network_connection_requests"
--- FORGERY 2b: or swap it so X is the sender and T the recipient
 b1000000-...-00000000000b | b1000000-...-00000000000a | accepted
UPDATE 1
--- AFTER FORGERY 2b: T reads X via the connected view
 Probe Victim X | secret@victim.test
--- FORGERY 3: sender self-accept of its own pending row (no repoint)
ERROR:  new row violates row-level security policy for table "network_connection_requests"
```

**It leaked, both ways.**
- Pending row: rewritten to "X->T accepted", with `responded_at` back-dated 8 days, which puts it outside the notification window, so nobody is emailed.
- Accepted row: swapped into "X->T".

Repointing only the `to_*` columns away from T is refused, because the new `to_org` is not T's. That makes the swap the working variant.

**After the fix:**
- Every UPDATE that names a party column gets `permission denied` from the grant.
- The sender's in-place accept gets `only the receiving organisation can accept a request` from the trigger.

### N1. Fix: `20261020000000_connection_request_update_is_pinned.sql`

**The trigger.** `bound_update` calls `private.connection_request_bound_update()`, BEFORE UPDATE, SECURITY INVOKER.
- **Who it binds:** every role except `postgres` and `supabase_admin`, the same exemption as `born_pending`.
- **Order:** it sorts first among the BEFORE UPDATE triggers.
- **(a) Party and request columns are pinned.** A change to `id`, `from_/to_organisation_id`, `from_/to_network_profile_id`, `requested_by`, `requested_at` or `created_at` gets 23514.
- **(c) A status change is bound to its side, judged on the OLD row.**
  - `accepted` or `declined`: OLD `to_org` must be in `permitted_organisations('manage_network_connections')` and in `network_publish_organisations()`. These are the recipient policy's terms and the accept action's.
  - `withdrawn`: OLD `from_org` must be in `permitted_organisations('manage_network_connections')`. There is no tier term, as in `authoriseWithdraw`.
- **(b) Response columns are server-stamped.**
  - On a status change, `responded_at := now()` and `responded_by := auth.uid()`, and a foreign `responded_by` is refused.
  - With no status change, any edit to `responded_*` is refused. This closes the m3 remainder.

**The column grant: yes.** `authenticated` now has UPDATE on `(status, responded_at, responded_by)` only, in place of the table-level grant.
- It does not break the actions. `terminal()` in `lib/network/connections.ts` now sends `{status}` alone.
- `responded_*` stay granted. A client that sends them is stamped over, not refused.

**The guard comment:** the transition guard's comment is reissued.

**Still working:** accept, decline, withdraw and the Q79 re-request. Coverage:
- NU4, NP10 and NQ9, NR8/NR8b, NR9;
- PN2 to PN5f in the audit suite;
- the HTTP positive controls;
- `network.spec.ts`.

### N1. Assertions

**psql: `rls_phase6_network.sql` § NQ, before § NU, pin 143 -> 161.**
- **Structure:** NQ0 checks the trigger. NQ0b checks the column grant.
- **The trigger, asked directly.** The table-level grant is lent and each statement expects 23514:
  - NQ1: the swap to accepted, back-dated.
  - NQ2: a repoint with no status change.
  - NQ3: a back-dated `requested_at`.
  - NQ4 and NQ5: the sender accepting or declining its own request.
  - NQ5b: the recipient withdrawing.
  - NQ6: accepting in a colleague's name, sending `responded_at` so that the CHECK cannot be what refuses it.
- **The grant, as shipped:**
  - NQ0c: the lent grant is returned.
  - NQ8: a party-column UPDATE gets 42501.
  - NQ8b: the target row is untouched.
- **The leak:** NQ7 checks the connected view is 0 for the forger.
- **After the honest accept (NP10, sending a back-dated `responded_at`):**
  - NQ9: the stamp.
  - NQ10: re-dating an answered row is refused.
  - NQ11: swapping an accepted row's parties is refused.

**Existing assertions that changed:**
- **NR8:** a withdraw sending status alone is now ok. NR8b checks it was stamped.
- **NU1, NU2 and NU5:** these still ask the policy. The trigger is disabled for exactly those statements, and NU2b and NU5c check it is enabled again.
- **NG3b:** 9 -> 8.
- **Leakage census:** LE1b 11/2/14/27 -> 11/2/15/28, and LE1d gains the function.
- **Audit suite PN5c:** the same-status `responded_at` edit now runs as the exempt owner, because no client can make it any more. PN5d is unchanged.
- **Privilege census:** the `UPDATE|*` entry becomes the three column entries.
- **Docs:** CLAUDE.md total 4018 -> 4036 at 224 migrations. SECURITY.md § 2 and the FOLLOW-UPS m3 entry are corrected.

**HTTP twin, "N1 at the API surface" in `run-rls-tests.sh`:**
- The sender's repoint-to-accepted PATCH gets **403** (the grant).
- The sender's status-only accept gets **400** (the trigger).
- The connected view returns 0.
- ALPHA's accept with a back-dated `responded_at` gets 204, and the row is stored `accepted:true:true:true`: parties unchanged, response stamped by the server.

H4's sender PATCH now expects 400 rather than 403: the trigger refuses before the WITH CHECK is reached.

### N1. Mutation results

**How these were run:** in rolled-back transactions on the probe fixture. The function was rebuilt from the migration with one clause cut, and each NQ statement was run as `authenticated` with the grant lent. I did not do a full-suite rerun for each mutation, because of the 60-minute bound.

| Mutation | Red |
|---|---|
| Trigger dropped | NQ1 **ok(1), leak 1**; the accepted-row swap **ok(1), leak 1**; NQ2/3/4/5b 23514 -> 42501; NQ6 ok; NQ9 unstamped; NQ10 ok. With the grant as shipped, party columns still get 42501 (NQ8, HTTP 403). |
| Clause (a) cut | NQ2 and NQ3 -> 42501; **the sender swapping accepted T->A into X->T: ok(1), leak 1**. Only (a) stops a same-status swap. |
| Clause (b) cut | NQ6 ok; NQ9 `recent=false, responded_by=false`; NQ10 ok. |
| Clause (c) cut | NQ4, NQ5 and NQ5b -> 42501 (the policy as fallback). |
| As shipped | All 23514; NQ9 stamped; leak 0. |

### N2

- **Template:** `task-reminder-template.ts` now quotes the title (`“${title}”.`), so the template's full stop never follows the person's text.
- **Truncation:** `oneLine` neutralises again after truncating, because `…` NFKC-folds to `...`.
- **Tests:** five new unit cases: `go to www`, `Visit WWW`, `www`, full-width `ｗｗｗ`, and a cut just after `www`. Each delivers one link and keeps its words. **All 5 are red with the lib change reverted.**

### N3

FOLLOW-UPS has a new section, "Opened by Phase 8 Task 9b fix round 2". It records that any `build()` throw, including a bad deploy, now permanently drops the notice.

- **Default, as built:** keep the terminal record.
- **Proposed mitigation:**
  - Mark a notice `content_refused` only for a `NoticeContentError` on person-authored fields.
  - Give builder-invariant failures (slug, uuid, date, allowlist) a separate class that is left unstamped and retried.
  - Send a Telegram alert when one tick has several builder throws.

### Gates
- `pnpm lint`, `next typegen` + `pnpm typecheck`: clean.
- Reset (224 migrations) + `run-rls-tests.sh`: "All suites passed", EXIT=0, Phase 6 network 161 as pinned, HTTP all passed (N1 twin 4/4); 224 -> 224. (First run, before the NU/NG3b rework: 4 red = NG3b 9->8, NU1/NU2/NU5 now 23514 from the trigger -- fixed by disabling it for exactly those statements.)
- `vitest` tests/unit + network + email + rls + phase7-permission-matrix: 122 files, 3304 passed (an earlier tests/unit run under the parallel psql load had the known `no-private-table-in-network-path` DENOMINATOR 5 s timeout; green alone and in this run).
- Fresh reset + `tests/e2e/network.spec.ts`: 1 passed (1.1 m).
- Commits: 60f6b2e (N2), bb832e5 (N1), 5990f24 (N3).
