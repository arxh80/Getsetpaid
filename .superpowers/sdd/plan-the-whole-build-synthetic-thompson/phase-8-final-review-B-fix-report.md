# Phase 8 final review B: fix report

2026-10-09 · branch `legal-phase-docs` off `worktree-legal-phase` at `a67f98f` (241 migrations). Docs only. No database was touched and no migration was written.

## Per finding

| Finding | Status | Note |
|---|---|---|
| F1 | **fixed, version owed** | The Brevo Purpose and Personal-data cells now name the Phase 8 notices, using the review's text: DSR received/closed, export-ready, connection-request, task reminder, closure and closure decision. The change is in both `docs/sub-processors.md` and the `register` verbatim copy in `lib/legal/sub-processors.ts`. The public `purpose`/`personalData` wording was rewritten to match, and the drift test is green. **No Subprocessors v4 was published.** The page renders the module, and the version body text does not change. A v4 would move the pins in `rls_phase8_legal.sql` (LF2) and `run-rls-tests.sh` (`lg_same`), and those can't be verified without a DB. It is recorded as owed in FOLLOW-UPS, together with counsel checking the Privacy Notice. |
| F2 | fixed | Twenty-six psql files. The closure-backup suite is at 26. The closure suite is at 181 (final fix round 2, Q229) and was 157 before that. Retention is at 329 (final fix round 1, § SV + RK12a); it was 312 after 9a fix round 1. |
| F3 | fixed | Twenty-six files / twenty-six `run_suite` calls. The pins were re-summed from the runner: 4277 over 26 calls, which matches CLAUDE.md:104. |
| F4 | fixed, **corrected from the review** | The tip is **24**, not 23: final fix round 1 added `record_document_scan_verdict`. The history now reads 24 / 23 (9c job 2) / 21 (9b) in CLAUDE.md and SECURITY.md. |
| F5 | fixed as far as source allows | The last measured run, **596** at 9c job 3a, is recorded, and the total at the tip is marked **not measured** (re-measure command given). SECURITY.md now gives the declared lists counted from source: **28** superuser-only and **13** member-reachable. These are declarations, not a run total. |
| F6 | fixed | Ten `/super` pages in CLAUDE.md and SECURITY.md. SECURITY.md's refusal-parity "all nine pages" also became ten, because that spec walks the same census. |
| F7 | fixed | The text now says "both specs have since run green in the full gate at `b0eac34` (178 passed, 0 failed, 238 migrations)" and "--list at 238". |
| F8 | fixed | SECURITY.md now says `20261024000000` reissued the clock comment (ten deliveries, ~490 s). Checked against the migration. |
| F9 | fixed | In email-setup.md: pg_cron runs every 10 min, with the Vault no-op stated; "Built (Phase 8 Task 9b/9c)" replaces "Deferred"; and the stale "two consumers and nothing else" line is corrected. |
| F10 | fixed | The company is UK-based; the Supabase region is Ireland (eu-west-1). |
| F11 | fixed | § Current state now has a sentence for the 9b notices and Telegram and for 9c Owner closure. |
| F12 | fixed | FOLLOW-UPS has a new section "Phase 8 Tasks 7-9c — owed at the PR". It holds the review's deduplicated list plus the final fix rounds' owed runs: a clean runner pass at 241, and `documents.spec.ts`. |
| F13 | recorded | DECISIONS-QUEUE Q230 and FOLLOW-UPS. The Not-MVP wording was not changed. |
| F14 | recorded | DECISIONS-QUEUE Q231 and FOLLOW-UPS. § Superuser dashboard was not changed, and there is no product change. |
| F15 | fixed | The "`deleted` is not deleted" bullet now describes the Task 6 60-day purge, `delete_closed_workspace()` (Q210) and the Q229 hold, and says reinstate works until the sweep runs. The "machinery that does not exist" sentence was removed. |
| F16 | fixed | § Data exports: the archive bytes are purged by the Task 6 sweep, and the reaper runs after 1 h (Q166). § Erasure: Q174 and the failure email are kept; Q166 and Q175 (90 days for failed jobs, succeeded jobs kept) are stated as closed. This was checked against `20261003002000` and FOLLOW-UPS. |
| F17 | fixed | Both places now say "went live in Phase 8 Task 5". |
| F18 | fixed | The consent parenthetical now says a row is deleted only by the account's own erasure (Q173). |

## Commits (branch `legal-phase-docs`)

- `899aeec` F1
- `c78237e` F2-F7, F11 (counts in CLAUDE.md and SECURITY.md)
- `fe4e81b` F10, F15-F18 (CLAUDE.md stale prose)
- `ed9164e` F8
- `0432e65` F9
- `cbfecbc` F12-F14
- plus this report

## Gates (this worktree)

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `npx next typegen` + `pnpm typecheck` | clean |
| `pnpm exec vitest run tests/unit` | 110 files / 2601 passed |

Not run, by instruction: the DB, the psql runner, integration and e2e. The e2e and vitest headline totals in CLAUDE.md were left alone.

## Unverified / owed

- **Subprocessors v4 is not published.** See F1: no migration was written.
- **The permission-matrix run total at the tip has not been measured** (F5).
