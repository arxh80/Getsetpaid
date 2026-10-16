# Q228 Task 5 report: docs, Q237-Q239, the mutation run and the full gates

**Status:** DONE_WITH_CONCERNS. Every mutant is red and every gate passed, but two things are not as clean as the brief words them: the full e2e run lost 10 files to a transient database health failure (all 181 tests passed across that run plus an isolated re-run), and 10 pre-existing psql suites, the exports suite among them, do not re-run cleanly on one database (none changed by this branch; the Q228 suite does re-run cleanly). Details under Step 2.
**Commits** (all pushed to `origin/q228-closure-backup-parts`):
- `ba2709c` Document Q228: closure backups in parts, the part download, the orphan exemption (CLAUDE.md, SECURITY.md, FOLLOW-UPS.md)
- `e1e8358` Queue Q237-Q239 and mark Q228 built on its branch (DECISIONS-QUEUE.md)
- `0962d6c` Record Q228's mutation run: M01-M18 and T1-T6, every one red (mutation-results/q228)
- `33284a9` Record which psql suites do not re-run on one database, measured (FOLLOW-UPS.md)
- the ledger commit that carries this report

The brief's Step 4 names one commit ("Document Q228, queue Q237-Q239 and record its mutation results"). It is split into the logical commits above, as the controller asked (one logical change per commit). No code, SQL or test file changed in this task.

## What changed

- **`CLAUDE.md`**
  - § Current state gains one Q228 clause: a closure backup of any size, built one bounded part per claim, listed and downloaded part by part, with Contact us when it fails.
  - The e2e gate row: the headline total is now **181 tests in 31 files** (by `npx playwright test --list` at 249 migrations; 178 in 30 before). A new sentence describes `closure-backup-parts.spec.ts` (3 tests, serial) and its **two axe scans through one `new AxeBuilder` site**: the failed-backup page with Contact us in the tree, and the two-part page with the parts list in the tree.
  - New paragraph "**Closure backups, as they shipped for Q228**" (in § Domain entities, after the Phase 9 integrations paragraph), seven bullets: parts only for closure backups (Q237); per-part ceilings with no total; one part per claim (ids-only cursor, Q240; fair queue; per-claim reaper; failure removes the parts; no re-queue, Q228 (c)); Q238's "every part"; Contact us is a link, not a form; the orphan-sweep exemption; the two residual bounds (Spec correction 8).
- **`SECURITY.md`** § 7, beside the N1-N3/Q229 paragraph: a new "A closure backup of any size, in parts (Q228)" paragraph with the part download's authorisation order (parse before lookup; RLS job read; downloadable; part row through the SAME RLS client, never the service client; `exists()`; the definer audit RPC re-asking ownership before the part; then the signed URL; every refusal the literal 404, an audit fault a 500), the dropped `(uuid)` overload and why (`42725` ambiguity; XG15b; mutant 10 regenerated), the orphan exemption and why it was CRITICAL (1-day grace; QM2 measured `-|orphan|orphan` before the migration), and the Q229 change (every part, QO2/QO3b/QO5), plus the parts table's grants, guard and key shape.
- **`FOLLOW-UPS.md`**: a new "Q228 ... -- owed" section: the legal "The archive is a zip" sentence is counsel's to change (`20260927008000_legal_pages_describe_export.sql:67`); the two residual bounds; a failed backup still cannot be re-queued; Q239; Task 4's untested `!org.isImpersonated` half, the missing `lib/supabase/admin.ts` importer census, the unexplained cold-start 404 (cbp9), and the two `exports` objects `exports.spec`/`workspace-closure.spec` leave per run; and the matrix order dependency ("no download was audited", pre-existing since Task 1).
- **`DECISIONS-QUEUE.md`**: a new section "Q237-Q239 -- Q228 Task 5"; Q228's founder-ruling status line now reads "**Q228: CHANGED, BUILT on `q228-closure-backup-parts`**"; the "(Q237-Q239 are reserved ...)" note in the Q240-Q241 section now points at the new section. Q240 and Q241 were not renumbered.
  - **Q237** -- should ordinary exports also split into parts? Default: no, closure backups only (a live workspace exported over several claims mixes moments). As built.
  - **Q238** -- what "downloaded" means for Q229's hold on a multi-part backup. Default: every part `1..greatest(part_count, 1)` downloaded at least once by the requester, or 30 days. As built.
  - **Q239** -- the closure copy promises `/account/exports`, which lists only `kind = 'account'` jobs. Default (a): keep the copy and list a requester's closure backups (with parts) on `/account/exports` in a later branch. Nothing changed here.
- **`supabase/tests/mutations/10-export-download-authorisation.sql`**: **no change needed.** It was already regenerated from the live `(uuid, integer)` definition in Task 3 fix round 1 (`3638cda`, controller ruling). This task's driver diffed it against the live `pg_get_functiondef` at 249 migrations: exactly one line differs (`where j.id = p_job_id and j.requested_by = (select auth.uid());` -> `where j.id = p_job_id;`), and applied it reddens what M18 must (below). Its header says "at 248 migrations"; the one migration since (Q189's `20261031000000`) does not touch this function.
- **`mutation-results/q228/`**: `mutants.py` (rewritten: M01-M18 plus Task 1's extras, T1-T6), `clean.sql` (new), `README.txt` (rewritten), `results.txt` (this run), `results-task1.txt` (Task 1's own 82-assertion run, renamed so it is kept), `progress.log`.

## Step 1: the mutation run

**Setup.** `npx supabase db reset --local` (249 migrations), then `bash supabase/tests/run-rls-tests.sh`: exit 0, "All suites passed". Then `python mutants.py` (`results.txt`). Every SQL mutant was applied to the live database and restored in a `finally` from the definition captured before any mutant ran. M12-M18 apply the committed files `21a`-`21f` and `10` as they are, after a diff against the live definition shows each differs by its one stated change only (the "-- Mnn file ... vs live" lines in `results.txt`). This is the scripted re-measurement of Task 3's quick-driver evidence for `21a`-`21f`. The T mutants were edited in place, run, and reverted with `git checkout -- <file>`; the driver ends by asserting `git status lib/` is clean (it was).

**Controls.**

| Control | qp | cw | xp | matrix filter |
|---|---|---|---|---|
| before | 114 / 0 red | 181 / 0 red | 139 / 3 red (XD7, XD8, XZ4) | 9 passed, 0 failed |
| restored | 114 / 0 red | 181 / 0 red | 139 / 3 red (XD7, XD8, XZ4) | -- |

The three xp reds are the same in both controls and are not Q228's; see "xp on a second run" below. M18's xp result is read against them.

**The table.** Every mutant reddens the assertion(s) the plan names ("EXPECTED-RED all present" for each in `results.txt`). **No mutant survived, so no assertion had to be added and no pin changed.**

| mutant | change | red assertions |
|---|---|---|
| M01 | `export_job_parts_select_own` recreated `using (true)` | QR1, **QR2**, QR2b, **QR3**, QR3b |
| M02 | `grant insert, delete on export_job_parts to authenticated` | **QT3, QR5a, QR5c** |
| M03 | part guard: the server-session check dropped | **QG1**, QG6e |
| M04 | part guard: the `part_count + 1` order check dropped | **QG4**, QG4c |
| M05 | part guard: the `running` check dropped | **QG3** |
| M06 | part guard: a delete admitted whatever the job's status | **QG6**, QG6c, QG6d |
| M07 | re-queue clause without `old.closure_backup` | **QJ2** |
| M08 | both part-count comparisons dropped | **QJ3, QJ5** |
| M08a | the re-queue comparison only | **QJ3** |
| M08c | the success comparison only | **QJ5** |
| M08b | the success comparison extended to `failed` | **QJ7**, QJ7b, QJ7c |
| M09 | `claim_export_job` ordered by `requested_at` again | **QJ6** |
| M10 | `export_job_parts_storage_key_shape` dropped | **QT6b, QT6c, QT7b, QT7c** |
| M11 | `export_jobs_part_count_shape` dropped | **QT8a, QT8b, QT8c, QT8d, QJ5b** |
| M11b | a failure no longer clears `resume_cursor` (Task 1's M12, renumbered) | QG-fixture, QG6b, QG6b2, **QK3**, **QJ7c**, QM4 |
| M12 (`21a`) | `closure_backup_owed`: the pre-Q228 predicate, any one download releases | **QO2**, QO3b; cw 181/0 |
| M13 (`21b`) | `closure_backup_owed`: `actor_user_id = requested_by` dropped | **QO5**; cw 181/0 |
| M14 (`21c`) | manifest: the parts term dropped from `orphans` | QM1, **QM2, QM3** |
| M15 (`21d`) | manifest: the expired-parts union dropped | **QM1** |
| M16 (`21e`) | manifest: the orphan exemption also keeps a failed job's parts | **QM4** |
| M17 (`21f`) | `audit_export_download`: the part-exists check dropped | **QD4a**, **QD4e**, QD7 |
| M18 (`10`) | `audit_export_download`: `requested_by = auth.uid()` dropped | qp **QD5**, QD7; xp XD2, XD3, XD5 (beyond the control's XD7/XD8/XZ4); matrix **"cannot audit-and-download a job that is not theirs": 7 failed** (impersonatedOrgOwner, noOrganisation, orgOwner, overriddenOrgOwner, superuserAal1, superuserAal2, suspendedMember) |
| T1 | `wouldFit` ignores `directoryBytes` | `zip.test.ts`: 3 failed, including **"counts the central directory of the entries already added (mutant T1)"** |
| T2 | `leftInTable = MAX_SAFE_INTEGER - rows` (the per-table ceiling ignored in page size and cut) | `closure-parts -t C1`: **(a), (c), (d), (e)** |
| T3 | the failure path skips `removeClosureParts` | `-t C7`: **C7** |
| T4 | `effectiveLimits` takes `Math.max` | `parts-contract.test.ts`: **"an override cannot loosen a ceiling (mutant T4)"**, "but can tighten every one" |
| T5 | on a cut, `cursor.after` = the page's last key | `-t C3`: **(e), (h)** |
| T6 | the re-queue omits `resume_cursor` | `-t C6`: **C6** (the database refuses `illegal_export_transition` and the job fails) |
| T7 | `download.ts` reads the part row with the service client | **EQUIVALENT in e2e**, recorded from Task 4 and not re-run: 3/3 green, because the job lookup through RLS comes first and the part query filters on that job. **Killed** by `tests/unit/email/service-client-census.test.ts` "and nothing else". T7-wide (both lookups through the admin client) reds "a colleague downloaded the Owner's part" (a 500 from the audit RPC). |

Bold = the assertion the plan names. M11b reddening QM4 too is expected: QM4's probe fails J4 with a cursor, which the CHECK then refuses.

## Step 2: the five gates (final tip `33284a9`; no code changed since `c89826e`)

Before each gate I checked that no other session's node, playwright or psql process was running; none was at any point. Where the database matters, each gate was preceded by `npx supabase db reset --local` (249 migrations each time). Logs are in this ledger directory (`t5-*.log`, `t5-gate-*`).

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0, at the start (`t5-lint.log`) and again at the final tip (`t5-lint-final.log`) |
| `npx next typegen && pnpm typecheck` | exit 0, both times (`t5-typecheck.log`, `t5-typecheck-final.log`) |
| `npx supabase db reset --local && pnpm test` | exit 0. **Test Files 174 passed, 1 skipped (175); Tests 3983 passed, 5 skipped (3988)**, 335 s. The skipped file is `tests/integration/security/clamav-live.test.ts`: 5 opt-in live ClamAV tests, owed on the first server per Q42. No flake, so no re-run was needed. |
| `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh` | exit 0, **"All suites passed"**. All 28 psql suites were "recorded, as pinned" (**4 616 assertions** by the pins), and "API surface: all checks passed". |
| the same suites a second time, no reset between | See "Run twice" below. **qp 114/0, cw 181/0, ck 26/0 and rt 329/0** re-ran clean, and 11 more with them. **10 pre-existing suites did not re-run clean**; this branch changed none of them. |
| `npx supabase db reset --local && pnpm test:e2e` | **Full run: 114 passed, 10 failed, 57 did not run** (26.4 min).<br>Every failure is a `beforeAll` hook, from test 115 onward: 8 timed out at 60 s, and 2 got `supabase_db_getsetpaid container is not ready: unhealthy` from `supabase status`. Host free RAM was 1.6 GB, and storage, studio, analytics and inbucket also reported unhealthy. The DB's postmaster start time was my own reset, so no other session touched it. The 57 "did not run" are the rest of those 10 files.<br>**Isolated re-run** of the 10 files, on a fresh reset with the stack healthy: **67 passed (12.2 min)**. The files were `operations`, `organisation-lifecycle`, `overrides`, `phase8-refusal-parity`, `platform-health`, `storage-census`, `super-closures`, `super-permissions`, `tenant-breakout` and `workspace-closure`.<br>So **all 181 tests passed** across the two runs, with no assertion failure in either. `closure-backup-parts.spec.ts` passed 3/3 in the full run (tests 40-42), including the part-2 302, so Task 4's cold-start 404 (cbp9) did not recur.<br>No config was touched and no retry was added. Afterwards I checked that no dev server or Playwright process of mine survived; port 3000 was free. |

### Run twice: what re-runs and what does not

`run-rls-tests.sh` refuses a second run on a used database. Its preflight explains why: `schema_invariants`, `rls_foundation` and `rls_phase2_crm` build the shared fixtures and never tear them down, by design. A copy with the preflight disabled aborts in `rls_foundation` on a duplicate slug (`t5-rls-pass2.log`).

So the second run replays every OTHER `run_suite` call, in the runner's order and with its variable sets, on the database the clean run had just passed on. The script is `t5-second-pass.py` in this directory (`python t5-second-pass.py <worktree> <out>`); its output is `t5-gate-rls-run2.txt`. 25 suites were replayed:

- **Clean on the second run (15):** file access, impersonation, rate limits, feedback, Phase 7 CRM audit, Phase 8 CRM audit P3-6, legal, consents, data subject requests, retention (329), notification stamps, **workspace closure (181)**, **closure backup completeness (26)**, integrations (199), and **Q228 closure backup parts (114)**. The qp suite also ran clean a third time and more, during the mutation run and the attribution check.
- **Not clean (10).** All are pre-existing, and this branch changed none of them. `git diff a75ef1b..HEAD -- supabase/tests/` touches only the Q228 suite, the exports suite's XG7/XG15/XG15b, `rls_phase8_crm_audit_p3_6.sql` (clean here), the runner and the mutation files. The ten:
  - `rls_phase3_events`, `rls_phase4_operations`, `rls_phase5_finance` and `rls_phase6_network` abort on a duplicate primary key (fixed fixture uuids) and record 0 assertions.
  - `network_leakage_phase6` shows the 8 reds already in `FOLLOW-UPS.md` § Phase 9 Task 3.
  - `rls_phase7_lifecycle` LA1, `rls_phase7_overrides` OB5/OH1/OI4/OI11, `rls_phase8_erasure` EE49/ER5/EZ5 and `rls_phase8_permissions` DV0c/DV11/DV14 are global audit or `document_versions` counts, disturbed by later suites or the HTTP block.
  - **`rls_phase8_exports` XD7/XD8/XZ4.** The suite counts every `export_job.*` audit row in the database, and deletes them all at its end. Before its second run the database held 10 `export_job.requested` rows and 1 `export_job.downloaded` row whose organisation and actor were gone, plus 2 `export_job.requested` rows by the erasure tombstone. Measured: one `rls_phase8_workspace_closure` run moves the counts (requested/downloaded/all rows) from 10/1/586 to 20/2/642, while one Q228 suite run moves the audit log by **0** rows (10/1/586 before and after). The source is therefore the workspace-closure suite, unchanged since Phase 8, not Q228.

These are recorded in `FOLLOW-UPS.md` § Q228 with the fix shape: random fixture ids, counts taken relative to a snapshot at the start of the suite, and deletes scoped to the suite's own rows. I did not fix them here: all ten suites are outside this branch's scope.

## Final pins

No pin changed in this task. `run-rls-tests.sh`: `qp` 114 (Q228 CLOSURE BACKUP PARTS), `xp` 139 (PHASE 8 EXPORTS), `cw` 181 (PHASE 8 WORKSPACE CLOSURE), `ck` 26, `rt` 329, `ig` 199; every other suite unchanged from main. All measured as pinned on the fresh-reset run above.

## Questions added

Q237, Q238, Q239 (DECISIONS-QUEUE, defaults as built or as owed above). Q240 and Q241 already existed (Task 2) and were not renumbered.

## Owed / concerns

1. **The full e2e run was not green in one go.** A transient database health failure took out 10 files' `beforeAll` hooks. The isolated re-run of those files was 67/67, so all 181 tests have passed on this tip, but not in a single cold run. This is the same class of failure as Phase 8/9's memory-pressure runs, and nothing in the failures touches Q228 code.
2. **"Every psql suite passes twice in a row on one database" does not hold for 10 pre-existing suites**, the exports suite among them (above). Every re-runnable suite this branch changed or added re-runs clean, except the exports suite, whose three reds come from the unchanged workspace-closure suite's leftover audit rows. Owed in `FOLLOW-UPS.md` § Q228. Whether to fix it on this branch is the controller's call; the default here is that it is not in Q228's scope.
3. **M12 and M13 redden nothing in the workspace-closure suite** (cw 181/0 under both). This is expected, not a gap. The closure suite's Q229 section uses single-part backups downloaded by their requester, where the pre-Q228 and Q228 predicates agree. The Q228 suite's QO2/QO3b/QO5 are the assertions that tell them apart, and they are red.
4. **Mutant 10's header says "at 248 migrations".** I verified it against the live definition at 249 (the one newer migration does not touch the function) and left the header as is, rather than churn a file whose content is correct.
5. **Carried from Task 4** into `FOLLOW-UPS.md` § Q228, not fixed:
   - the Contact us gate's `!org.isImpersonated` half is untested;
   - `lib/supabase/admin.ts` has no importer census;
   - the cbp9 cold-start 404 (it did not recur in this run);
   - the two `exports` objects that `exports.spec` and `workspace-closure.spec` leave per run.
6. **The ledger's deferred minors from Tasks 1-4** remain for the final review; none was in this task's brief.
