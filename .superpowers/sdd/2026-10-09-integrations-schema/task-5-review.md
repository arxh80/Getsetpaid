# Task 5 review (base 1a50967, head 5666782; Task 5 commits 5e397d6, 6edd5e4, 5666782)

### Spec Compliance
- ✅ CLAUDE.md § Current state now mentions Phase 9, and the new "Integrations, as they actually shipped in Phase 9" paragraph is there (diff CLAUDE.md hunk at line 424). It covers schema only, no live provider, Vault, RPC-only writes, the Starter+ gate and "connect always refuses". I checked the claims against the migrations: `integration_provider_not_live` is at `20261030001000_integration_rpcs.sql:138`, and the refusal order includes `workspace_not_writable` (same file, line 174). Retention is 90 days for sync runs and 2 years for revoked connections (`20261030003000...:41-42`, `:1461`).
- ✅ SECURITY.md has the § 2 "Integrations: schema only" subsection, the § 4 tombstone-actor bullet and the § 15 connector launch gate, which names the DPA, IDTA/SCCs and OAuth app review.
- ✅ FOLLOW-UPS.md has a "Phase 9 Task 5 -- owed" section.
- ✅ docs/sub-processors.md has no row, plus a sentence explaining why.
- ✅ The mutation driver (`mutation-results/phase9/run.sh` and `mutants.py`) and its results (`results.txt`) exist. All 11 listed guards have a mutant, plus a control. Every mutant reds named IG assertions, and the control is 195/0 before, as M12, and after.
- ⚠️ The mutants were not applied the way the brief says. The brief asks for "begin ... rollback on a reset DB, or restore with a reset". The driver applies each mutant to the live DB and restores it with DDL (`mutants.py:298-316`). See Important I3. It is not a defect in the result.
- ❌ The brief says the full e2e suite "must still pass". The single cold run had 4 failures and 2 tests that did not run. Its isolation exception covers only *refusal-parity* timeouts, and the report itself says none of these were refusal-parity. See Important I1.
- ⚠️ Commit message differs from the brief ("Document Phase 9 and record its mutation results"). This is cosmetic.

### Strengths
- The mutants are surgical. `rep()` asserts that exactly one match is replaced, `cut()` raises when a marker is missing, and a guard catches a mutant that did not apply (`mutants.py:255-262, 310`). So a function mutant cannot quietly become a no-op.
- Restoring from `pg_get_functiondef` uses CREATE OR REPLACE, which keeps the owner, ACL, SECURITY DEFINER and `search_path`.
- I checked whether dropping and recreating the policy (M02) and the trigger (M08) loses anything. Neither object has a `comment on` statement in any migration (grep of `supabase/migrations/` found none), so the recreate is lossless for what the catalogue holds. The suite also re-measures grants and policies itself (IT4, IC0b, IR*), so the control-after run is meaningful evidence.
- Each red exercises its guard directly:
  - M03 reds IC2/IC2b/IC7/IC7b.
  - M04 reds IC3.
  - M05 reds IC6.
  - M06 reds IV9b/IL1b by id and by name.
  - M07 reds IV6b.
  - M11 reds IT10 and the whole-row freeze, IT10e.
  - M10 reds both the positive control and IX2, so it is caught twice, by the export catalogue and by the column grant.
- Runner total: summing the 27 `run_suite` pins in `supabase/tests/run-rls-tests.sh:206-1241` gives exactly **4473**: 88+183+694+187+91+11+151+161+218+121+89+56+191+151+128+214+171+143+228+138+212+329+22+94+181+26+195. The report's figure is correct; the implementer just could not reproduce the sum.
- The storage-census fix is a per-test 30 s limit with a comment, with no retry and no global change (`tests/unit/legal/storage-census.test.ts:775-777`). That complies.
- Q236 is well formed. It states the risk, gives two options and a default ((b), which restricts `p_owner_user_id` to the caller), and names a revisit trigger (Q232's connector).

### Issues

#### Critical (Must Fix)
None. Every listed guard has a mutant that reds at least one named assertion, and the control is green before and after.

#### Important (Should Fix)
- **I1. The e2e gate is not met as the brief defines it.** In the task-5-report.md Gates section and progress.md line 79, the full cold run was 172 passed, 4 failed and 2 did not run. The brief allows an isolated re-run only for refusal-parity timeouts under 1 GB, and these were not refusal-parity specs.
  - `data-requests.spec.ts` drives DSR export and erasure. Phase 9 Task 3 changed both `private.export_catalogue()` and `private.erase_account()`. So "none in integration code" is narrowly true, but that spec does exercise Phase-9-modified functions.
  - The isolated green (6/6 at 6 GB) makes a functional regression unlikely. Still, the ledger line "gates green" overstates what happened.
  - Fix: re-run the full `pnpm test:e2e` cold, after a fresh reset, with adequate free RAM (no config change) before the phase PR. Record the result, and reword progress.md to "e2e: 4 RAM timeouts, green in isolation; full cold re-run owed".
- **I2. The docs contradict Q236's own default.** In DECISIONS-QUEUE.md, Q236 defaults to (b): restrict `p_owner_user_id` to the caller. But three docs describe option (a), binding the OAuth callback to `owner_user_id`, as the required fix:
  - SECURITY.md § 2, gap 2 (diff line 511-514);
  - FOLLOW-UPS.md, Phase 9 Task 5, bullet 2 (diff line 461);
  - CLAUDE.md, the integrations paragraph's last bullet, which is neutral but points at them.

  A reader of SECURITY.md would build (a). Fix: in SECURITY.md and FOLLOW-UPS.md, say "Q236, default (b): restrict `p_owner_user_id` to the caller; (a) is the alternative", or else change the default.
- **I3. run.sh's completion log cannot report a failure.** `run.sh:385` has `echo "$(date '+%F %T') END exit=$?"`. The `$?` is expanded after the `$(date)` substitution, so it always reports date's exit status, 0. I measured it: `false; echo "$(date +%T) exit=$?"` prints `exit=0`.
  - progress.log's first run (16:59:21 to 16:59:25, 4 s, "exit=0") is therefore unexplained. It may well have crashed.
  - The evidence that counts is results.txt, which is coherent. But this project has a standing false-green rule, and a detached driver whose only completion signal is constant is exactly that shape.
  - The deviation from the brief's "rollback or reset" restore is acceptable only because every gate after it began with a fresh reset. It needs to be said in the results, not assumed.
  - Fix: capture `rc=$?` right after `python`, then `echo "... END exit=$rc"`. Also add a line to results.txt or README noting that restores were by DDL and that a reset followed before the gates.

#### Minor (Nice to Have)
- **M1.** CLAUDE.md integrations paragraph, "Writes are RPC-only" bullet (diff line 428): it says `authenticated` has *column-level* SELECT on both tables. Only `integration_connections` is column-level (`20261030001000_integration_rpcs.sql:529-532`). `integration_sync_runs` keeps a table-level `grant select` (`20261030000000_integration_tables.sql:185`, and no later migration changes it). Fix: say "column-level on connections, table-level on sync runs (no secret column)".
- **M2.** SECURITY.md § 2 (diff line 499-502) says there are twelve mutants, "each of which turns at least one named assertion red". The twelfth is the control, which by design reds nothing. Fix: "eleven mutants plus a control".
- **M3.** The SECURITY.md § 4 placement (diff line 536-542). § 4 is "Authentication and session security", and the tombstone-actor note concerns audit attribution, which is § 7 "Audit logging" (`SECURITY.md:264`). The brief named §§ 2, 4 and 15 but did not dictate where this note goes. Fix: move it to § 7, or keep a one-line cross-reference in § 4. The wording "revokes performed by the membership trigger" is also only conditionally true: with an Owner on the session, the trigger audits the Owner (IM6), and the tombstone is used only with no session (IM0). The leading "when the caller is not a person" covers this, but naming IM0/IM6 would remove the ambiguity.
- **M4.** In CLAUDE.md § Current state (diff line 402), the Phase 9 clause sits between Phase 6 and Phase 7, which breaks the chronological chain. Fix: move it to the end, after Phase 8 Task 9c.
- **M5.** `mutants.py:318`: a resumed run (`run.sh M05 M06`) overwrites results.txt with only those mutants' lines. That undercuts "resumable". Fix: append, or write `results-<args>.txt`.

### Assessment
**Task quality:** Needs fixes

**Reasoning:** The mutation work is sound. All 11 guards are killed by named assertions, the control is green on both sides, and the 4473 pin sum checks out. However, the brief's e2e gate was not met in a single full run. SECURITY.md and FOLLOW-UPS.md also prescribe the opposite fix to Q236's stated default, and the driver's exit log is a constant 0.
