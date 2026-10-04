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
- Known narrative drift not fixed here: CLAUDE.md's "censuses of the 14 `service_role` runners" (Task 8's count) -- the census list is now 20.

### Questions
Q202 recipients; Q203 ledger instead of columns; Q204 the tick's headroom (DECISIONS-QUEUE.md).
