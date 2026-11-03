# Task 5 report: docs, mutations, gates

Status: DONE_WITH_CONCERNS (see Concerns).

## Files changed
- `CLAUDE.md` (Current state sentence + "Integrations, as they actually shipped in Phase 9")
- `SECURITY.md` (new § 2 subsection "Integrations: schema only"; § 4 tombstone-actor bullet; § 15 connector launch gate)
- `FOLLOW-UPS.md` (Phase 9 Task 5 section: service_role RPC lifecycle/tier, Admin-named owner, tombstone actor, closed storage-census item)
- `docs/sub-processors.md` (sentence: no row, nothing sent to a vendor)
- `tests/unit/legal/storage-census.test.ts` (30 s explicit timeout on "no scanned file imports code from a place the scan skips"; no retry)
- `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md` (Q236)
- `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/mutation-results/phase9/` (`run.sh`, `mutants.py`, `clean.sql`, `results.txt`, `run.log`, `progress.log`)

## Mutants (ig suite, 195 assertions; applied to the live DB, restored after each)
| Mutant | Red assertions |
|---|---|
| control before | 0 red |
| M01 grant insert to authenticated | IT4, IB1 |
| M02 select policy `using (true)` | IR1a IR1b IR2a IR2b IR3a IR3b IR4a IR4b IR5a IR5b IR6a IR6b IR7 IR8a IR8b IR9a IR9b (17) |
| M03 connect: has_permission removed | IC2, IC2b, IC7, IC7b |
| M04 connect: plan check removed | IC3, IC10b |
| M05 connect: live check removed | IC6, IC6b, IC8, IC9b, IC9z, IC10, IA1 |
| M06 revoke row: Vault delete removed | IV9b, IL1b, IM3, IM8, IM10, IE4, IP3 |
| M07 execute read_integration_token to authenticated | IC0b, IV6b |
| M08 membership trigger removed | IM0, IA1, IM2, IM3, IM6, IM8, IM10, IM10b, IP3 |
| M09 erase_account step removed | IE1, IE2, IE3, IE5, IE6, IE8 |
| M10 export includes token_secret_id | IX1, IX2, IX3, IX4, IX8 |
| M11 revoked_is_terminal removed | IT10, IT10c, IT10c2, IT10c3, IT10e |
| M12 control (no mutation) | 0 red |
| control restored | 0 red |
No mutant survived; no assertion had to be added.

## Gates (final tip after both commits)
- `pnpm lint`: exit 0.
- `npx next typegen && pnpm typecheck`: exit 0.
- `pnpm test` (fresh reset): Test Files 168 passed (168); Tests 3821 passed (3821); exit 0.
- Runner (fresh reset): "All suites passed." exit 0 (27 suites, ig pinned 195; pinned total 4473 per brief).
- `pnpm test:e2e` (fresh reset): 172 passed, 4 failed, 2 did not run, 43.9 min. Free RAM was 0.34 GB when sampled mid-run; failures were 60 s test timeouts / a 15 s request timeout, none in integration code. Isolated re-run of those specs (fresh reset, RAM 6 GB): accessibility.spec.ts:633, data-requests.spec.ts (all 3, incl. the 2 not run), network-leakage.spec.ts:192, network-profile-editor.spec.ts:184: **6 passed (2.0m)**. No config touched.

## Commits
5e397d6 (mutation driver and results), 6edd5e4 (docs + storage-census timeout), plus the report commit.

## Concerns
- e2e not green in a single cold run (RAM-starved, 4 timeouts); green in isolation. None are refusal-parity specs.
- Q236 default (b) is my proposal for the founder; no code change.
- SECURITY.md § 4 is "Authentication and session security"; the audit-actor note lives there per the brief, though § 7 is the audit section.

## Fix round 1
Commits: 96d2e85 (I2, M2, M3: docs follow Q236's default, mutant count, audit-actor note moved to SECURITY.md section 7 with conditional wording), 26a673c (M1, M4: grant wording, Phase 9 clause last in Current state), 008226b (I3, M5: run.sh logs the real rc, subset runs write their own file, README.txt notes DDL restores and explains the 4 s first run: it crashed on a wrong relative suite path, fixed by changing 4 to 5 levels), plus the ledger/report commit.

Gates after the edits (no SQL or tests changed, so vitest and the psql runner were not re-run):
- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0.
- Full cold `pnpm test:e2e` (fresh `npx supabase db reset --local`, no config change, no other playwright process): **178 passed, 0 failed, 0 did not run, 20.6 min**. Free RAM at start 2.69 GB (waited the 30 minutes; it never rose above 2.9 GB because of other load on the machine), 5.21 GB at the end. This supersedes the earlier 172/4/2 run, which ran at 0.34 GB. No isolation re-run was needed.
- progress.md ledger line rewritten to state what actually happened.
