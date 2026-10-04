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
