# Phase 8 Task 8: Phase 8 permission tests. INDEPENDENT REVIEW.

Range `f63e97d^..5945a45` (11 commits), worktree `legal-phase`, branch
`worktree-legal-phase`, reviewed at `5945a45`. 210 migrations (measured on the
live stack: `supabase_migrations.schema_migrations` = 210, `ls
supabase/migrations` = 210). No migration in the range.

**VERDICT: MINOR.** No Critical. The task does what it exists to do. The
censuses really are functions of a connection, and each plant is asserted to
be named exactly. All 18 function mutants are the live definition plus one
change; I diffed every one of them against `pg_get_functiondef()` myself. The
two collateral-only kills the report found (05a, the kill switch) are closed
by direct assertions that reach the rule without the RPC. Three Important
findings. One is the task's own false-green class, inside the new refusal-parity
spec. One is a residual oracle the `/super` catch-all does not close. One is
count drift that the task's own follow-up commit introduced. All three are
small to fix.

---

## Method and constraints

Read-only on code, per the dispatch. I ran no reset, no psql runner, no
`pnpm test` and no e2e, and started no dev server: ports 3000-3010 were empty
and stayed empty. What I did run:

- **Mutant staleness.** For all 18 `CREATE OR REPLACE FUNCTION` mutants I
  diffed the mutant's body against the live `pg_get_functiondef()` on the
  freshly reset stack (`diff -w`). Every diff is the intended one-line change
  plus a trailing `;`. 07a, 07b and 09b also carry a `§`→`Â§` mojibake inside
  one comment, which is harmless. The changes, as read:
  - 05a: `coalesce(new.user_id, v_uid)`.
  - 05c: overwrite only if the id is null or not a real account.
  - 07a: `if false` replaces `if not v_is_owner`.
  - 07b: `elsif false` replaces `elsif not v_operator`.
  - 09b: `if false` replaces `v_seam_moved and not v_server_session`.
  - 10: the `requested_by = auth.uid()` term is dropped.
  - 12a: `return;` on the first line.
  - 13: the update becomes a delete.
  - 14: `if false` replaces the floor test.
  - 16: `enabled = s.enabled`.

  **None is stale, and each mutates the guard it names.** I also confirmed
  that the 15-xx trigger names exist (`organisation_subscriptions`:
  `audit_insert`, `audit_update`) and that `export_read_page_as_requester` is
  owned by `export_reader` (so mutant 11's re-own to `postgres` is a real
  change).
- `pnpm exec vitest list --project integration` on the matrix: **548**.
  `playwright test --list`: **173 in 28**, and super-permissions **14**.
- `pnpm exec vitest run tests/unit/security/super-page-census.test.ts`: 7/7.
- Pinned totals summed from `run-rls-tests.sh`: **23 suites, 3858**.
- Read the brief, the report, the census modules, the GATE 0 (Phase 8) block,
  the mechanism classifier, `rls_phase8_permissions.sql` in full, the
  DW4a-c/RR7a-h diffs, `phase8-refusal-parity.spec.ts` in full, the catch-all,
  `lib/export/download.ts`, and every mutation `.summary` named below.

Taken from the report and not re-run: the gate results (psql 3858/0, vitest
3414, e2e 173/0), the 36-mutant batch outcomes (I read the summaries, I did
not reproduce them), and that each matrix plant goes green at runtime. I read
those plants' code; I did not execute them.

---

## CRITICAL

None. No guard in the brief's list survives every layer, and 00-control is
green in every layer (`00-control.summary`: runner exit 0, vitest 690/690).

---

## IMPORTANT

### I1: The export-download parity test is refused by row state, not by authorisation

`tests/e2e/phase8-refusal-parity.spec.ts:176-212`. The "real job that is not
yours" is `plantQueuedAccountExport()` (`tests/e2e/support/fixtures.ts`, new):
a queued job with **no `storage_key` and no archive**.
`lib/export/download.ts:53` returns 404 for **any** caller when
`storage_key` is not a string, the job's own Owner included. So "real ==
ghost, literal 404" is produced by the row having nothing to download, before
the caller's identity matters at all. That is the Phase 7 / Task 3 shape the
brief names: a refusal that would stay green with the guard removed.

**Failure scenario:** a migration widens `export_jobs` SELECT to the whole
workspace, or mutant 10 drops the IDOR term. Read_only, admin and the
no-workspace user still get 404 here, because the queued row has no
`storage_key`. The test stays green.

**Mitigation, which is why this is Important and not Critical:**
`exports.spec.ts:161-186` and `:218-223` exercise the IDOR against a REAL
archive, with the Owner's 200 as the positive control and an audit-row count.
So the guard is covered. What is not covered is the parity claim (an identical
body) for a downloadable job, and the report's § 4 sentence presents this test
as that evidence.

**Fix:**
- Plant a `ready`, unexpired job with a real object in the `exports` bucket,
  or reuse the archive `exports.spec` produces.
- Add a positive control: the Owner gets a 302 for the same id.
- Then compare the normalised bodies of the colleague's response and the
  ghost's.
- Without the positive control the test cannot tell "refused" from "nothing
  to serve".

### I2: The `/super` catch-all equalises status, text and title, but not the document (reasoned, not measured)

`app/(app)/super/[...unknown]/page.tsx`. The spec compares `innerText` and
`title` after hydration (`phase8-refusal-parity.spec.ts:30`, `:96-117`). The
reason given is that raw bytes differ anyway (nonce, stream ids), which is
tenant-breakout's argument. That argument holds there because a real record
and a ghost record go through the **same route**. Here the route is the
secret, and two things differ structurally, not by nonce:

1. **The streamed fallback.**
   - Each `/super` page has its own `loading.tsx`, and every one is distinct
     (md5 of all nine differ). For example, `super/legal/loading.tsx` has eight
     `h-8` bones and `super/loading.tsx` has two `h-12`.
   - A refused real page answers 200 *because* its fallback was flushed before
     `notFound()`. The report measured that.
   - So the initial HTML for `/super/legal` carries legal's skeleton, and the
     ghost carries `super/loading.tsx`'s.
2. **The RSC router tree** in the inline flight data names the matched segment:
   `legal` for the real page, and the `[...unknown]` catch-all param for the
   ghost.

**Failure scenario:** any signed-in account runs
`curl -b <cookie> /super/<guess>` and checks whether the body contains the
catch-all's segment or the generic skeleton. That lists the operator console's
pages, which is what the `super-permissions.spec.ts` header says the design
prevents. **The impact is low**: the page names say little, and no data
leaks. But the report's "Closed" overstates it.

I could not measure this without a dev server on the shared port. It is
inferred from Next's streaming model plus the measured 200.

**Fix:**
- Make the refusal happen **before routing** for non-superusers. In the
  middleware, when the path is under `/super/` and the session's user is not
  the platform superuser, rewrite to one fixed not-found route. Every
  `/super/*` URL then renders the identical document modulo nonce.
- Add one raw-body assertion: strip nonces and `$`-ids, then require
  `/super/legal` and `SUPER_GHOST` to have identical HTML structure.

The cheaper half-fix, making every `super/*/loading.tsx` render the same
skeleton, removes channel 1 only.

### I3: The pinned psql numbers in CLAUDE.md are stale, and the report's delta is wrong

The counts commit `bd73952` came **before** `8b439ef`, which moved the DSR pin
225 → 228 and the retention pin 267 → 275. CLAUDE.md was not re-measured
afterwards.

- `CLAUDE.md:104-106` says "TWENTY-THREE numbers … total **3847** … 225, 137,
  208, **267**, 22". The runner's pins sum to **3858** (measured: 88 183 694
  187 91 11 151 127 214 121 89 56 182 151 128 204 168 143 **228** 137 208
  **275** 22).
- `CLAUDE.md:155` still says the DSR file has "**225 assertions**".
- `CLAUDE.md:127` still says retention is "267 since fix round 2".
- `task-8-report.md:364` and `:377` ("+22 assertions (3825 → 3847)")
  contradict the report's own § 8 (3858). The real delta is **+33**: 22 in the
  new suite, 3 for DW4a-c and 8 for RR7a-h.

This is Standing lesson 8 and brief requirement 7 ("never copy a number
forward"), in the task whose job is to correct them.

**Fix:** update those three CLAUDE.md sentences and the report's § 7 rows to
3858 / 228 / 275 / +33.

---

## MINOR

### M1: DR3 asks the consent no-session rule by SQLSTATE alone

`supabase/tests/rls_phase8_permissions.sql:221-226` compares only
`split_part(..., ':', 1) = '42501'`. DR1, its twin, pins the full sentence,
and the header of § DR says "by their own SQLSTATE and sentence". Today this
is not a coincidence: mutant 04b reds DR3, per `04b.summary`. But a later
42501 from another check (the attribution or grant path) would keep it green
with the rule removed. **Fix:** pin the rule's message the way DR1 does.

### M2: The "guard" mechanism is "a 42501 raised by the function", not "the superuser guard"

`tests/integration/security/phase7-permission-matrix.test.ts:2230-2240` accepts
any message prefixed `${fn}:`. That closes the absent-grant class (DF9), which
was its purpose. It does not close the row-state class (Phase 7's
`start_impersonation_session`), and some RPCs raise a second 42501 under the
same prefix. For example, `transition_data_subject_request: only the requester
can withdraw a request` sits next to its `not permitted` guard.

The 10 Phase 8 superuser-only guards were also not mutated in this task. By
reading, I find each would fall through to a differently coded or prefixed
error, so I do not suspect a false green. It is asserted rather than proved.

**Fix:**
- Pin the exact guard sentence or hint per RPC (most carry `caller is not the
  platform superuser at aal2`).
- Or add one mutant per guard family: legal, DSR, erasure, retention.

### M3: The destructive-primitive census is derived from a name regex

`tests/integration/security/support/catalogue-census.ts:224`. A destructive
`private` function named outside `^(erase|purge|sweep)_`, such as a future
`delete_*` or `gc_*`, escapes the postgres-only check. **Fix:** pin the
complete set of `private` functions with a non-postgres EXECUTE grant, rather
than filtering by name.

### M4: Refusal parity covers only the 2 Phase 8 `/super` pages, though the catch-all fixes all 9

`phase8-refusal-parity.spec.ts:75`. The report's finding is that **every**
`/super` page was an oracle. **Fix:** iterate `SUPER_PAGE_URLS` from
`tests/support/super-route-census.ts`. It costs nine page loads per principal.

### M5: 05a's row is not re-measured after DW4a-c

05a's summary predates `8b439ef`. With DW4b in place it should now red
directly, as well as collaterally. The row still reads "Collateral only",
which is accurate history but not current state. **Fix:** re-run 05a with the
`prep,psql,summary` phases, or annotate the row.

### M6: DV1/DV12 read `information_schema.column_privileges`

`rls_phase8_permissions.sql:109`. That view shows only privileges involving a
role that the current user is a member of. A grant made by `supabase_admin`
could be invisible to `postgres`. The matrix's `aclexplode` privilege census
covers the same ground, so this is defence in depth only. **Fix:** use
`aclexplode(relacl)` and `attacl` as the census does.

---

## Requirement by requirement

| Req | Verdict | Verified by me / taken |
|---|---|---|
| 1 Inventory re-derived; plants redden by name | **Met.** RPC, overload, third exposed schema, table, column grant, service_role function, destructive primitive, bucket + permissive policy, and cron + sixth tick half each have `withPlant` assertions requiring EXACTLY the plant. The live gates use the same functions (`publicRpcNames(pool)` `:1725`, `publicRelationsGranted(pool)` `:1838`). The `/super` page plant is in a CI unit test. The privilege census reads `relacl` + `attacl` + PUBLIC + sequences. Two real denominator holes found (column grant, overload). | Code: me. Unit test: run by me (7/7). Matrix plants at runtime: report. |
| 2 Principals × surfaces, with mechanism | **Met.** The suspended Owner at aal2 has a denominator assertion (`:1340`). `mechanismOf` separates no-grant, not-exposed, no-session and guard. See M2 for the limit. | Me (code); 548: me (`vitest list`). |
| 3 Refusal parity | **Partly met.** The `/super` status/text/title gap was real, and the fix is right as far as it goes (I2). The settings/export slug parity is sound and has a positive control. The download-route parity is row-state-produced (I1). | Me (code); outcome: report. |
| 4 Mutation-test the suite | **Met.** 36 mutants, none stale, each red. "Lower bound" is honest for 05a, 12a and 13: each is red on its own guard's assertion before the abort (12a EL3/EL5, 13 EE24, 05a DW2 then DW4b by construction). The abort hides only how many later layers would also have caught it. It does not hide whether the guard is caught, and HTTP is correctly labelled "not run". | Me (staleness diff; summaries read). |
| 5 Ask each rule directly | **Met** after `8b439ef` and `24bfb95`. DW4b goes through the trigger as postgres with a session and a real account named, so the FK cannot refuse. 05c reds only DW4b. DR1 pins the sentence. RR7a-h throw the switch through the RPC, and mutant 16 reds RR7b-e/h. DR3 is weaker (M1). | Me. |
| 6 Seams, both halves | **Met.** `document_versions` DV1-4 / DV5-11 / DV12-15. Fulfilment predicate DF8/DF12-20. Seam write DF9a-e / DF9g-k. Kill switch RR7 + RR7a-h (now through the RPC). Runner routes closed in super-permissions and open in integration. | Me (DV, RR7, DW4); DF line refs: report. |
| 7 Counts | **Mostly met.** 548, 173/28, 14, 9 + 1 pages, 23 files: all verified. Psql total and two pins are stale (I3). | Me. |

**`tl_total` change (`run-rls-tests.sh:2990-3003`): correct.** `-I` issues a
HEAD without waiting for a body. `-D -` puts the headers on stdout while
`-o /dev/null` discards the output proper. `--max-time 30` makes a hang return
an empty range, which the `else` branch counts as a FAIL (`<none>`), so a hang
reds instead of passing. 00-control shows `PASS count=exact works on the view
… 0-3/4`. The WIP commit's "14 HTTP checks red" did not survive a clean reset
(00-control: 409 PASS / 0 FAIL). The progress.md attribution to a leftover
mutant is plausible and unproven.

**Nothing weakened.** Every `-` line in the test diff is an inline query or
walk moved into `catalogue-census.ts` or `super-route-census.ts` with the same
predicate. No `expect` was loosened, and no pin was lowered: DSR and retention
went up, and `pm` went 19 → 22 with three new assertions.

---

## Verdict

**MINOR.**
- **I1** is the class this task exists to catch, so it should be fixed before
  merge. It is a fixture change plus a positive control. It is graded
  Important only because `exports.spec` independently covers the IDOR with a
  real archive.
- **I2** is a residual, low-impact oracle that the report calls closed. Fix
  it or reword the claim.
- **I3** is three CLAUDE.md numbers and two report rows.

With those done, I would expect a re-review to come back READY.
