# Task 8 — Phase 8 permission tests. Report.

Written incrementally. Branch `worktree-legal-phase`, starting tip `781fce4`
(210 migrations). Baseline measured at the starting tip after a fresh reset:
22 psql suites **3825 / 3825 as pinned, 0 failed**, HTTP **409 PASS / 0 FAIL**
(22:26 → 22:32, six minutes including the reset); permission matrix **447**.

## 1. The inventory, re-derived — and two holes in it

`f63e97d`. Every census the matrix runs is now a function of a connection
(`tests/integration/security/support/catalogue-census.ts`), so the same query
runs against the live catalogue AND on a connection that has just planted
something inside a transaction it rolls back. Each plant must be named, and
nothing else.

**Two denominator holes found by planting, both in the Phase 7 censuses:**

1. **A column-level grant on a relation already registered is invisible.** The
   relation census answers "can a browser reach this relation at all". With
   `grant update (action) on public.consents to authenticated` planted — the
   one append-only ledger in the product, made writable one column at a time —
   the relation census reports no difference and stays green. Phase 8's
   controls are nearly all column grants (the anon eight-column read on
   `legal_documents`, `erasure_jobs`' one-column INSERT, `export_jobs`'
   two-column INSERT, the DSR seam's two-column `service_role` UPDATE, the
   `documents` retention-clock narrowing), so this census could not see Phase 8.
   **Closed** by a pinned census of every privilege on `public` — table and
   column level, `anon`/`authenticated`/`service_role`/PUBLIC, sequences
   included — 203 entries measured at 210 migrations
   (`support/privilege-census.ts`). The plant now reds as exactly
   `consents|authenticated|UPDATE|action`.
2. **An overload of a registered RPC name is invisible.** The RPC census keys
   on `proname`. A planted `public.record_consent(p_user_id uuid, p_purpose
   text)` — a second, forgeable entry point beside the real one — leaves the
   name set unchanged. PostgREST resolves an RPC by its argument names, so it
   is separately callable. **Closed** by an overload census (any exposed name
   with more than one signature is red) and a signature-keyed census over
   every exposed schema.

**A third, smaller one:** the RPC census hardcoded `public`; `graphql_public`
is also exposed by `config.toml`. The exposed schemas are now read from
`config.toml`, and a plant that exposes a third schema with a function granted
to `anon` is named by the derived census and missed by the old one (measured).

**New censuses, each with a plant that reds by name:** the `service_role`
runners' 14 signatures, each with its reason; the destructive primitives
(`private.erase_*`, `purge_*`, `sweep_*`, `retention_sweep_body` — 11
functions) executable by `postgres` alone; the three buckets (all private), no
PERMISSIVE policy anywhere in `storage`, four RESTRICTIVE fences per bucket;
the one cron job and the five halves of its tick, read out of the tick's own
body (a sixth half would not change the cron row at all). A REACH test asserts
each named Phase 8 surface is in the derived sets: `legal_documents`,
`consents`, `data_subject_requests`, `data_subject_request_notes`,
`export_jobs`, `erasure_jobs`, `retention_runs`, `retention_settings`, the
`exports` bucket, `erase_account`/`erase_organisation`, the retention sweep,
and the Phase 3–6 audit triggers via `private.audit_coverage()` (only
`organisations`, the declared Q189 excusal, is uncovered).

**The `/super` page plant** — `5a58ae3`. The e2e census walked
`app/(app)/super` for `page.tsx` only. Measured in a scratch tree by
`tests/unit/security/super-page-census.test.ts` (which runs in CI; the e2e
census does not): it missed `page.ts`/`.jsx`/`.mdx`, missed a `/super` page in
another route group entirely, and reported URLs that do not exist for a route
group or slot inside `/super`. The derivation now walks the whole app tree and
maps groups and slots away (`tests/support/super-route-census.ts`).

## 2. A gap the registry hid: `erasure_jobs` was never probed

`erasure_jobs` has been in `OWN_ROW_RELATIONS` since Task 5 and had **no
table-layer block**: registered as own-rows, never read as own-rows. It has
one now — a held job the no-workspace principal queued for themself (nothing
in the file runs a runner, and an invariant proves the account still exists),
read by exactly its subject and the aal2 operator, unwritable by every
principal including the operator, a caller-chosen `subject_user_id` refused
by the grant (`no-grant`), and the honest insert from the same principal
admitted and stamped.

## 3. Principals, and the mechanism behind each refusal

Added: **a SUSPENDED workspace's Owner at aal2** (real account, real TOTP
factor, workspace founded through `create_organisation()`, suspended through
the operator's own RPC, with a denominator assertion that all three hold).
The signed-out visitor, the no-workspace user, the data subject (the Read Only
member owns every held request, consent and job) and the superuser at aal1
and aal2 were already there.

**Every superuser-only refusal of a signed-in principal is now asserted to be
the function's OWN guard**, not a missing grant: `mechanismOf()` separates
`no-grant` ("permission denied for function"), `not-exposed` (PGRST202),
`no-session` (28000), `guard` (any other 42501) and `other`, and the message
must be prefixed by the function's name (or, for the three lifecycle RPCs,
their shared helper's). This is the Task 3 DF9 class — a dead guard green
because a grant was absent — closed for all 23 superuser-only RPCs × 7
signed-in principals at once. An anonymous refusal must be `no-grant`,
`not-exposed` or `no-session`, never `guard`.

**What the new principals MAY do** (asserted, not assumed): the suspended Owner
records a consent, files a DSR, exports their account AND their suspended
workspace (`export_organisation_data` survives suspension), is still refused a
workspace they are not in, and reads no erasure blocker (sole Owner of an
empty workspace — it goes with them). The aal1 superuser records a consent and
files a request of their own, and is refused operating on it by the guard.
The data subject withdraws their own request; an Owner, the suspended Owner
and the aal2 operator are each refused withdrawing it.

Matrix **447 → 548** (run on its own against the live stack, 548 passed).


### 3b. Principals × Phase 8 surfaces, and the mechanism behind each answer

Nine principals: **A** anonymous, **N** no workspace, **D** the data subject
(the Read Only member who owns every held request, consent and export job),
**O** Org Owner at aal2, **I** that Owner under a live impersonation session,
**B** Owner with a Pro billing override, **S** Owner of a SUSPENDED workspace at
aal2 (new), **U1** platform superuser at aal1, **U2** at aal2. Where each answer
is asserted is named in the right-hand column.

| Surface | A | N, D, O, I, B, S | U1 | U2 | Where |
|---|---|---|---|---|---|
| 10 Phase 8 superuser-only RPCs (5 legal, 3 DSR, `start_erasure_for_request`, `set_retention_enabled`) | refused: `no-grant`/`not-exposed`/`no-session`, never `guard` | refused by the function's OWN guard (message prefixed by its name), no side effect, no audit row, row-state invariant held | refused by guard (aal2 term) | **permitted** (positive control, same args) | matrix LAYER 1 |
| `legal_documents` read | the 15 current published versions, 8 columns | same | same | same | matrix; psql legal § LA; HTTP |
| `legal_documents` write | refused | refused | refused | **refused** (only the RPCs write) | matrix; psql § LI as `postgres` |
| `consents`, `data_subject_requests` read | refused (`no-grant`) | own rows only (D reads the held row; others 0) | own rows | **all** (oversight) | matrix |
| `data_subject_request_notes` read | refused | **0 rows, the requester D included** (Q103) | 0 | all | matrix; psql § DN |
| `export_jobs` read | refused | own only | own | **0** (no oversight, Q165) | matrix |
| `erasure_jobs` read (new block) | refused (`no-grant`) | own only (N is the subject) | own | **all** (oversight) | matrix, new |
| any write to the four registers above | refused | refused (md5 of the table unchanged) | refused | refused | matrix |
| `record_consent`, `submit_data_subject_request` | refused (no-session class) | **permitted, for themself** — S (suspended) and N measured | **permitted, for themself** | permitted | matrix, new |
| `withdraw_data_subject_request` | refused | D permitted on their own; O, S refused on D's | — | **refused on D's** | matrix, new |
| workspace export insert | refused | O/B for their own org; **S permitted for the suspended org** (survives suspension); S refused for org A | — | — | matrix, new; e2e (suspended Owner sees the control) |
| `audit_export_download` | refused | refused (`not_your_export`) except D, refused `export_has_no_archive` | refused | refused | matrix |
| `my_erasure_blockers` | no rows | own only; S reads none (empty sole-owned workspace goes with them) | own | own | matrix, new |
| `retention_runs`/`retention_settings` | refused | 0 rows, no write | 0 | read only | matrix |
| `/super/legal`, `/super/data-requests` | bounce to /login | **streamed not-found identical to a /super URL that does not exist** (D, O, N, S measured; I/B are O) | MFA challenge persists | renders | super-permissions; phase8-refusal-parity |
| `/account/{privacy,data-requests,exports,erase}` | bounce identical to a ghost /account URL | **reachable**, S included while suspended | — | — | phase8-refusal-parity |
| `/[orgSlug]/settings/export` | — | foreign slug = ghost slug, literal 404; own org reachable | — | — | phase8-refusal-parity; exports.spec |
| `/account/exports/[id]/download` | redirect identical to a ghost id | literal 404 identical to a ghost id (D-owned job probed by others) | — | — | phase8-refusal-parity; exports.spec |
| `/api/{exports,erasure,retention}/run` | 404 | 404 (read_only, owner) | — | **404** (a session buys nothing) | super-permissions |
| server-only RPCs (14, `service_role`) | not grantable to any API role (census) | — | — | — | matrix GATE 0 |
| destructive primitives (11, `private`) | executable by `postgres` alone | — | — | — | matrix GATE 0 |

## 4. Refusal parity on every Phase 8 page — and an oracle it found

`tests/e2e/phase8-refusal-parity.spec.ts` compares each refusal with the
document a thing that DOES NOT EXIST produces — status, rendered text and
title — which `super-permissions.spec.ts` never did.

**FINDING (Important, fixed here because it is one file and obviously right):
every `/super` page was an existence oracle.** A refused real `/super` page is
the streamed not-found: HTTP **200**, `app/(app)/not-found.tsx` inside the
signed-in shell, titled `Not found · GetSetPaid`. A `/super` URL matching no
route was the ROOT `app/not-found.tsx`: HTTP **404**, no shell, titled
`GetSetPaid`. All three channels differed, measured for read_only, owner, the
no-workspace user and a suspended workspace's manager — so any signed-in
account could list the operator console's pages. `super-permissions.spec.ts`'s
header says the design prevents exactly this ("a 403 confirms the page exists,
which is an enumeration oracle for the operator's console"); its refusal check
could not see it because it never looked at a page that does not exist.
Present since Phase 7 Task 1, on every `/super` page. Closed by
`app/(app)/super/[...unknown]/page.tsx`, a catch-all that `notFound()`s below
the existing `super/loading.tsx` boundary with the refused pages' title;
declared in the census as the one non-surface.

The other parity measurements, all green: `/[orgSlug]/settings/export` under a
real foreign slug equals a slug nobody has (literal 404 both); the export
download route for a colleague's real queued job equals a ghost id for
read_only, admin and the no-workspace user (literal 404, identical body), and
for anonymous (identical redirect once the requested id — the caller's own
input — is normalised); each `/account` page signed out bounces exactly as a
ghost `/account` page does. And the suspended-workspace half: a suspended
workspace's Manager reaches all four `/account` pages and its Owner is offered
the workspace export — the first browser pointed at either while a workspace
was actually suspended.

## 5. The seams that ship closed

Brief requirement 6. Each row needs a test that the seam really is closed and
a test that it opens correctly when flipped. Taken from the tree, not from the
commit messages.

| Seam | Closed: measured by | Opens when flipped: measured by | Both halves? |
|---|---|---|---|
| **`document_versions` has no write path** (Phase 4, versioning is Release 1.1) | `rls_phase8_permissions.sql` § DV1-DV4 (`:109`-`:122`): no write privilege for any API role or `service_role`, table or column level; no write policy; RLS on; a real Owner holding `manage_documents` (DV0d positive control, `:101`) is refused an INSERT of a version of their own document | § DV5-DV11 (`:139`-`:167`): one INSERT grant and one write policy shaped like `documents`', the smallest change Release 1.1 would make. The Owner versions their own document (DV5). The **composite tenant FK** refuses a version pointing at BETA's document (DV6), the policy refuses one filed under BETA (DV7), the existing SELECT policy reads it back (DV8) and keeps it from BETA's Owner (DV9), and the audit-coverage census **names the new client write** straight away (DV10). § DV12-DV15 (`:178`-`:184`) close it again and assert the table is back as it was found | **Yes** (`a6685bf`; 19 assertions, re-runnable) |
| **Fulfilment predicate**, `private.dsr_fulfilment_job_ready()`: one line per job kind; a kind with no job stays dormant | `rls_phase8_data_subject_requests.sql` DF8 (`:229`): `nonsense` (a right no job fulfils) answers `false`. DF8a (`:233`): the old single-boolean predicate no longer exists. DF14/DF15 (`:837`/`:839`): with only one line awake, the other right is still closable by hand and rectification is never gated | DF12-DF19 (`:833`-`:847`): each line is flipped **on its own** inside `begin` (`:764`) … `rollback` (`:827`), so a request cannot be closed until its job has run (DF12, DF18), and **is** admitted once the sessionless job records the seam (DF16/DF17, DF19). DF20 (`:850`) checks the rollback restored the real function. The live awake state has its own checks: `rls_phase8_exports.sql` XS1/XS8/XS13 (`:875`/`:919`/`:952`) and `rls_phase8_erasure.sql` ES1/ES6/ES9 (`:1568`/`:1625`/`:1655`). Mutant 09a, which puts both lines back to dormant, reds 16 of these | **Yes** |
| **Fulfilment seam write is server-only** (`fulfilment_*` columns, no person on the session) | DF9 (`:637`): the grant refuses PostgREST's role. DF9a-e (`:648`-`:717`): **the guard itself** refuses the operator, the requester, a bare `authenticated` role and `anon`, measured with the grant and policy opened inside a rolled-back transaction | DF9g (`:720`): through the same opened grant, a write the trigger permits does land. DF9h (`:722`): `service_role` with no person is admitted. DF9j/DF9k (`:733`/`:738`): the sessionless job records it, stamped with the database clock. DF10 (`:756`): the operator's fulfilment is then admitted. Mutant 09b reds DF9a-e | **Yes** |
| **Retention kill switch** (`retention_settings.enabled`, `.audit_purge_enabled`). It **ships ON** (`20261003001000_retention_runs_and_kill_switch.sql:55,57`, default `true`), so "closed" here means switched off | `rls_phase8_retention.sql` RR7 (`:2138`): with the job off, a run is **recorded** as `refused/retention_disabled`. RR8f (`:2190`): a switch thrown after a run started stops it before the next object is named. RA7/RA8 (`:810`/`:812`): the audit switch alone stops the purge and leaves every other sweep running. RR6 (`:2134`): the switch RPC is superuser-only, even for `postgres` | Every live run in the file runs with it on (RR9 `:2211` onward). The matrix's positive control calls `set_retention_enabled(true, true)` as the aal2 operator (`phase7-permission-matrix.test.ts:893`), and its invariant asserts that a refused principal left both switches on (`:880`) | **Half. FINDING (Important):** the OFF state is only ever reached by a direct `update public.retention_settings` as `postgres` (`:2137`, `:2189`, `:809`). Nothing throws the switch off **through `public.set_retention_enabled()`**, the operator's only path (`lib/admin/retention-actions.ts:84`), and then watches a run refuse. The one call with `false` (RR6) is a refusal. If the RPC wrote the wrong column, or ignored `p_enabled`, the operator would press "off" and the job would keep deleting, and every layer would stay green. **CLOSED (follow-up, `8b439ef`):** `rls_phase8_retention.sql` RR7a-RR7h (after RR7) throw the switch off **through `set_retention_enabled(false, true, ...)` as the aal2 superuser**, read the config row (off, reason, `updated_by`), watch a run refuse `retention_disabled`, read the `retention_settings.changed` audit row (true>false), then turn it back on through the RPC and watch a dry run be admitted and complete. Mutant 16 (the RPC ignores `p_enabled`) reds RR7b-RR7e and RR7h directly, plus 22 downstream (27 psql) |

Not a seam in the brief's sense, but noted: `/api/{exports,erasure,retention}/run`
are refused to every session (404, `super-permissions.spec.ts`). Their open half is
the bearer-secret runner path, which `tests/integration/{export,erasure,retention}`
exercise against the real runner functions.

## 6. Mutations

**Method.** `supabase/tests/mutations/run-mutation.sh <mutant> <out> all` runs
each mutant in four steps:

1. `npx supabase db reset --local`.
2. Apply the mutant with `psql -v ON_ERROR_STOP=1`. A mutant that does not apply
   counts as a harness failure, never a green. None failed to apply.
3. Run the **whole** `bash supabase/tests/run-rls-tests.sh` (all 23 psql suites,
   then the HTTP block).
4. Run an integration subset: the permission matrix, plus
   `tests/integration/{legal,export,erasure,retention,admin}` and
   `security/crm-audit-no-content-leak-p3-6.test.ts`. That is 14 files and 690 tests.

The summary step reads every red assertion out of each suite's results table, every
pinned-total mismatch and `psql ... ERROR` line, every red HTTP check and every
failed vitest test.

Each mutant is the **live** `pg_get_functiondef()` at 210 migrations with one
change, or one grant, policy or trigger change. It is never a migration, and the
next reset removes it. The batch driver is `mutation-results/run-all.sh`, which
is resumable and finishes with a reset.

**Timing**, from `mutation-results/progress.log`: 2026-10-04 00:42:19 → 04:39:47
for the 36 mutants, then the final reset (ALL DONE 04:40:33). The two
follow-up mutants (05c, 16) were run later with phases `prep`, `psql`,
`summary` only (no vitest), 210/210 migrations each. That is about
6.6 minutes each on average: about 3m08s for the shortest (12a, 13, which stopped
early, see below) and 8m14s for the longest (05b).

**Migrations: 210 before and 210 after for every one of the 36**, read from
`supabase_migrations.schema_migrations` after each reset.

**e2e was not run per mutant.** A cold `pnpm test:e2e` takes about 47 minutes
on this machine, so 36 runs would be about 28 hours on the one shared stack. Every
guard mutated here is a database rule. The e2e assertions on these surfaces
(refusal parity, the exports, erasure and DSR walks) reach the guards through
the same RPCs and policies that the psql, HTTP and integration layers already
probe directly, so a browser run per mutant would mostly re-measure that, slowly.
The e2e layer's own question is whether the page refuses with the right document.
`phase8-refusal-parity.spec.ts` measures that against the unmutated stack.

**Denominator.** `00-control` (no change) is **green in every layer**: runner
exit 0, every psql suite at its pinned total, HTTP 409 PASS / 0 FAIL, integration
690/690. So any red below comes from the mutant, not the harness.

**Three runs stopped early, so their counts are lower bounds.** For 05a, 12a and
13 the runner exited 3: a fixture statement errored, so the script stopped
before reaching the remaining suites and the HTTP block.

- 05a stopped at `rls_phase8_exports.sql:910` ("no rows returned for `\gset`").
  The erasure, retention and permissions suites and **HTTP did not run**.
- 12a and 13 stopped inside `rls_phase8_erasure.sql` (`:1116` duplicate live
  erasure job; `:1459` feedback FK to an account already deleted).
  The retention and permissions suites and **HTTP did not run**.

For these three, an HTTP "0" means "not measured", not "green". All three are
still red in psql on their own guard before the stop.

**Result: every one of the 35 mutants is red in at least one layer, and in every
one at least one red is a psql assertion. Except 05a (see the findings), that red
is on the guard's own behaviour. No Critical false green.** Counts are red
assertions per layer, taken from `mutation-results/<name>.summary`. "Integ" counts
failed vitest tests.

| Mutant | Guard it removes (from the mutant's header) | psql | HTTP | Integ | Representative red assertions |
|---|---|---|---|---|---|
| 00-control | none: the harness denominator | 0 | 0 | 0 | (all green) |
| 01-legal-immutability | `private.legal_documents_guard`: a published or superseded version's text becomes editable | 8 | 0 | 0 | lg LI1-LI4 "postgres cannot change the body/title/date/published_at of the published version", LI10, LZ1 |
| 02-legal-anon-column-grant | anon's eight-column SELECT on `legal_documents` widened to table level | 5 | 2 | 4 | lg LG3, LA5-LA8; HTTP "anon select=* is refused → 401" (got 200), "anon cannot select the reviewer name"; matrix "EVERY privilege on `public`", "'anonymous' cannot name the reviewer or the status" |
| 03-consents-append-only | `private.consents_guard` lets every UPDATE and DELETE through | 17 | 0 | 0 | cs CH9 "postgres cannot UPDATE a consent (the guard, not a grant)", CH10, CH11, CD8 "a trigger-issued DELETE … refused by the consents guard" |
| 04a-consent-attribution-trusts-client | `private.consents_before_insert` keeps a caller-supplied `user_id` | 14 | 0 | 1 | cs CW15 "it is pstd1's …" (the forged CW14 row, rewritten), CR0, CA4 "the actor is the person whose consent it is"; integ: catalogue body binding only |
| 04b-consent-attribution-sessionless | the same trigger's no-session refusal | 2 | 0 | 1 | cs CW13 "postgres with no session cannot record a consent", pm DR3; integ: body binding only |
| 05a-dsr-attribution-trusts-client | `private.data_subject_requests_before_insert` keeps a caller-supplied `user_id` | 30 + **118 ERROR lines; 142 of 225 recorded** | not run | 1 (+548 skipped) | dsr DW2 "POSITIVE: pstd1 makes an access request" (`denied(23503)`), DW10, then cascade; the matrix file failed in setup. **Collateral only, see findings** |
| 05c-dsr-attribution-trusts-valid-client (follow-up) | the same trigger trusts a caller's `user_id` whenever it names a REAL account (so the RPC's placeholder is still overwritten and the honest path works) | 1 | 0 | not run | dsr DW4b "a forged row WITH A SESSION ... is stored as pstd1's". The only red: before DW4a-c this mutant would have survived every layer |
| 05b-dsr-attribution-sessionless | the same trigger's no-session refusal | 1 | 0 | 1 | pm DR1 "a sessionless postgres INSERT naming a real user is refused BY THE SESSION RULE (42501)"; integ: body binding only |
| 06-dsr-transition-table | `private.dsr_transition_allowed` allows every (from, to) pair | 5 | 0 | 2 | dsr DT5 "in_progress → open refused", DT6 no-op, DT7, DT19 "terminal is terminal"; integ "answers as dsrTransitionAllowed() does, for EVERY pair" |
| 07a-dsr-who-withdraw-leg | before-update trigger: anyone may withdraw | 4 | 0 | 0 | dsr DT13b "the TRIGGER refuses the OPERATOR withdrawing on the requester's behalf", DT13c, DT15, DT16 |
| 07b-dsr-who-operator-leg | before-update trigger: anyone may progress a request | 2 | 0 | 0 | dsr DT13a "the TRIGGER refuses the REQUESTER closing their own request", er ES4c |
| 08-dsr-operator-notes-boundary | a second permissive SELECT policy on the operator notes | 4 | 4 | 8 | dsr DG4, DN5 "THE REQUESTER READS ZERO NOTES", DN5a/b; HTTP "carol reads ZERO operator notes" (got 1), the embed/COUNT/RECENT reads; matrix: 7 principals "reads an operator note only if …" plus the note-read RPCs |
| 09a-fulfilment-seam-dormant | `private.dsr_fulfilment_job_ready` back to false/false | 16 | 0 | 0 | dsr DF8, DD1a; xp XS1, XS8 "THE CONSTRAINT BITES", XS13, XS16; er ES1, ES6 |
| 09b-fulfilment-seam-server-only | before-update trigger: the fulfilment record writable from a person's session | 5 | 0 | 0 | dsr DF9a-DF9e "THE GUARD refuses the OPERATOR / the REQUESTER / the role alone / anon" |
| 10-export-download-authorisation | `audit_export_download` loses its IDOR term (`requested_by = auth.uid()`) | 4 | 0 | 7 | xp XD2 "IDOR: another Admin of the same workspace", XD3, XD5, XD7; matrix: 7 principals "cannot audit-and-download a job that is not theirs" |
| 11-export-private-note-exclusion | `private.export_read_page_as_requester` re-owned by `postgres` (a BYPASSRLS definer) | 2 | 0 | 1 | xp XP5 "a colleague's PRIVATE note is NOT in the Owner's export", XP7; integ export/runner "THE RULE Q54 CLOSED" |
| 12a-erasure-last-owner-guard | `private.assert_account_is_erasable` answers "erasable" for everyone | 12 (lower bound) | not run | 2 | er EL3 "the guard REFUSES the erasure itself", EL4a/b, EL5, EN3; integ erasure/runner (refusal recorded as failed) |
| 12b-membership-keeps-an-owner | `private.membership_keeps_an_owner` lets every change through | 19 | 0 | 0 | er EM4-EM9 "demoting/removing the SOLE owner is refused"; harness D1a, D5a; rt RQ2 "a direct `delete from auth.users` REFUSES" |
| 13-tombstone-rewrite-deletes | `private.erase_account` step 7 deletes the referencing rows instead of re-pointing them | 13 (lower bound) | not run | 0 | er EE24 "actor_user_id is the tombstone, and the rows are still there", EE25-EE29, EE35, ER2-ER5 |
| 16-retention-rpc-ignores-enabled (follow-up) | `public.set_retention_enabled` keeps the current `enabled` and ignores `p_enabled` | 27 | 0 | not run | rt RR7b "THE OPERATOR turns the job OFF through set_retention_enabled(false, ...)", RR7c (the row), RR7d (the run refuses), RR7e (the audit row), RR7h; then the live run RR7d opened cascades through RR8-0 … RN13 |
| 14-retention-audit-floor | `private.purge_audit_events` skips the one-year hard floor | 7 | 0 | 0 | rt RA4 "the purge REFUSES it rather than deleting a year of evidence", RA5, RA9-RA12 |
| 15-01 … 15-16 (16 mutants) | the Task 7 audit triggers dropped from one table each: `document_links`, `documents`, `event_lineup`, `events`, `financial_entries`, `meeting_links`, `meetings`, `merge_candidates`, `network_links`, `network_profiles`, `note_links`, `notes`, `organisation_memberships`, `organisation_subscriptions`, `task_links`, `tasks` | 10-23 each | 0 | 6-12 each | c7 census (PA2, PC1, PC3) **plus a behavioural row on every one**: PI1b-PI13b "<table>: 1 <target>.created …", PU*b ".updated", PD20/PD31 soft-delete and restore, PM1b-PM5b (memberships, subscriptions), PM6b/PQ2c/PQ5 (merge candidates), nw NX4/NX5d (network); er EP* where the table carries a person id. Integ: `audit-actions-match-db`, `crm-audit-coverage-census`, the matrix REACH test; plus `crm-audit-no-content-leak-p3-6` for 10 of the 16 |

psql / integration reds for the 16 CRM-audit mutants: 15-01 12/6, 15-02 20/9,
15-03 14/11, 15-04 21/12, 15-05 18/10, 15-06 12/6, 15-07 18/10, 15-08 18/6,
15-09 19/6, 15-10 23/9, 15-11 12/6, 15-12 19/12, 15-13 21/9, 15-14 10/6,
15-15 13/10, 15-16 20/12.

### Findings from the mutation table

- **No Critical false green.** All 35 non-control mutants are red. 00-control
  is green in every layer.
- **IMPORTANT: 05a (the DSR attribution trigger trusting a caller's `user_id`)
  is caught only as collateral.**
  - Its reds come from the **honest path breaking**. `public.submit_data_subject_request()`
    inserts a placeholder `user_id` and relies on the trigger to overwrite it
    (`20260924000000_data_subject_requests.sql`, from `:884`). With the trigger
    trusting the caller, the placeholder hits the FK (`DW2 … denied(23503)`),
    the `\gset` that DW2 feeds fails, and 118 later statements error out. The
    suite then records 142 of its pinned 225, and the matrix file dies in
    setup (548 skipped).
  - No assertion carries a **forged `user_id` through the trigger with a
    session attached** and checks that it was rewritten. DW4 is refused by the
    missing INSERT grant before the trigger runs. The consents suite does have
    this assertion (CW14/CW15), and 04a reds it directly.
  - A subtler mutant would probably survive every layer. One example: trust a
    supplied id unless it is the RPC's placeholder.
  - This is also a requirement 5 gap: the rule is never asked directly.
    Reported, not patched. The fix is a DSR twin of CW14 in § DW.
  - **CLOSED (follow-up, `8b439ef`).** `rls_phase8_data_subject_requests.sql`
    DW4a-DW4c: postgres carrying pstd1's session inserts a row naming pstd2
    (DW4a: a real account, so the FK cannot refuse), a forged email and
    `fulfilled`; DW4b asserts it is stored as pstd1's, with pstd1's email,
    `open`; the insert is undone in a subtransaction (DW4c: nothing left).
    The subtler mutant predicted above, 05c (trust a supplied id whenever it
    names a real account), was written and run: it reds **only** DW4b, so
    before this assertion it would have survived every layer.
- **Caught, but before this task only by a text binding (now closed).** 05b
  (the DSR no-session refusal) at first reddened **no behavioural assertion in
  any layer**. Only `catalogue-bindings-match-db`'s body-equality check noticed
  the changed function text. The one sessionless probe was `anon`, which the
  grant refuses first. A sessionless `postgres` write is still refused without
  the rule, by the next check (`no_account_email`, 22023), so a second guard
  was producing the first one's outcome. `rls_phase8_permissions.sql` § DR
  (DR1-DR3, `:213`-`:221`, committed in `24bfb95`) now asks the rule as itself,
  by its own SQLSTATE and sentence, and 05b reds DR1. 04b already had CW13;
  DR3 adds the consent twin.
- **Integration reds that are text bindings, not behaviour.** For 04a, 04b and
  05b, the only integration red is `catalogue-bindings-match-db` ("one deployed
  definition, equal to the migration walk"). That check reds on *any* change to
  the function body, so it proves nothing about the guard's behaviour.
  Behaviourally, integration and HTTP are **blind** to these three. Their
  behavioural kill is psql only.
- **psql-only kills, where integration and HTTP see nothing:** 01 legal
  immutability, 03 consents append-only, 07a/07b DSR who-may-do-it, 09a/09b
  fulfilment seam, 12b membership keeps an owner, 13 tombstone rewrite, 14
  retention audit floor, plus 04a/04b/05b behaviourally. These guards are only
  reachable as `postgres`, from inside a definer, or through a runner the
  integration subset does not drive with the guard in question, so psql is the
  layer that sees them. That is expected rather than a defect, but the psql
  suite is the **only** line for them, and CI does not run it (`CLAUDE.md` § CI).
- **HTTP reds only two mutants:** 02 (anon column grant) and 08 (operator notes
  policy). Both are about what a PostgREST read returns, which is the HTTP
  block's whole subject. (It was not reached for 05a, 12a or 13.)
- **CRM audit triggers: integration catches 6 of 16 only by census.**
  - For `document_links`, `meeting_links`, `note_links`, `merge_candidates`,
    `network_links` and `organisation_subscriptions`, every integration red is
    the catalogue/coverage census or the matrix REACH test.
    `crm-audit-no-content-leak-p3-6` has no behavioural test that writes to those tables.
  - psql catches all 16 behaviourally.
  - The three link tables share **one** aggregate assertion, PI7b-10b "the four
    links: one .created each", plus the shared PD20/PD31. That is still a
    behavioural kill, but it is not per-table: one label covers four guards.
    Minor.

## 7. Counts, re-measured

Each count was measured at 210 migrations, from the files listed. None was
carried forward.

| What | Was (where) | Is | How measured |
|---|---|---|---|
| psql suite files | "twenty-two" (CLAUDE.md, twice) | **23** | `ls supabase/tests/*.sql \| wc -l` = 23; `grep '^run_suite "' supabase/tests/run-rls-tests.sh` = 23 |
| pinned psql total | "TWENTY-TWO numbers … total 3825" (CLAUDE.md) | **3858**: the 22 before + `rls_phase8_permissions.sql` **22** (19 DV + 3 DR) + DSR 225 -> **228** (DW4a-c) + retention 267 -> **275** (RR7a-h). *Fix round 1 (review I3): this row said 3847, measured before `8b439ef` moved the two pins.* | sum of the 23 `run_suite` pins; in the 00-control run, every suite sat at its pin |
| HTTP checks | 409 (baseline above) | **409**, unchanged | 409 `PASS` lines in `00-control.psql.log`, 0 `FAIL` |
| permission matrix tests | "447 since Phase 8 Task 6" (CLAUDE.md); "290 since Phase 8 Task 1" (SECURITY.md § 2); "224 assertions" given as the current figure (SECURITY.md § 11) | **548** | vitest: `phase7-permission-matrix.test.ts (548 tests)` in `00-control.vitest.log` |
| matrix principals | "seven principals" (SECURITY.md § 2, § 11) | **9**: 8 in `PRINCIPALS` (`:361`) + `superuserAal2` | read from the file |
| matrix surfaces | "thirteen superuser-only RPCs, five member-reachable, seven tables" (SECURITY.md § 2, § 11) | **23** superuser-only RPCs, **12** member-reachable, **15** relations (9 platform + 1 public-read + 4 own-rows + 1 superuser-only), **14** server-only runners | the `fn:` entries in `SUPERUSER_ONLY_RPCS` (`:456`-`:931`); the keys of `MEMBER_REACHABLE_RPCS` (`:940`-`:990`); `PHASE7_TABLES`, `PUBLIC_READ_RELATIONS`, `OWN_ROW_RELATIONS`, `SUPERUSER_ONLY_RELATIONS`; `SERVER_ONLY_RPCS` |
| superuser-only RPCs in this report's § 3 | "24" | **23** | as above. Corrected in § 3 |
| `super-permissions.spec.ts` tests | "12 tests" (SECURITY.md § 2, § 11; CLAUDE.md, twice) | **14** | `npx playwright test --list` |
| `/super` pages | "seven `/super` pages" (SECURITY.md § 2, § 11) | **9** pages, plus 1 declared non-surface catch-all (`[...unknown]`, `d50140c`) | `find "app/(app)/super" -name 'page.*'` = 10 |
| e2e total | "164 tests in 27 files" (CLAUDE.md) | **173 in 28** (`phase8-refusal-parity.spec.ts`, 9 tests, is the 28th) | `npx playwright test --list` |
| axe scan sites | (CLAUDE.md's formula) | **unchanged**: Task 8 added no scan | `grep -c "await scan(\|new AxeBuilder" tests/e2e/*.spec.ts`; `phase8-refusal-parity.spec.ts` has 0 |

**What this task adds:**

- psql: +1 suite, +33 assertions (3825 → 3858): 22 in the new suite, 3 (DW4a-c) in the DSR suite, 8 (RR7a-h) in the retention suite. *(Said +22 / 3847 until fix round 1, review I3.)*
- Permission matrix: 447 → 548 (+101).
- e2e: +1 file and +9 tests (refusal parity). `super-permissions.spec.ts` now has 14.
- Unit: `super-page-census.test.ts`, which runs in CI.

The matrix now covers 9 principals over 35 RPCs (23 superuser-only + 12
member-reachable) and 15 relations, plus census rows for the 14 server-only
runners and the 11 destructive primitives.

## 8. Gates (run by the controller, tip `0ccd3a6`, 2026-10-04)

All five, each long gate on its own fresh `db reset --local`, 210 migrations
before and after:

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `npx next typegen` + `pnpm typecheck` | clean |
| reset + `run-rls-tests.sh` | 23 suites at their pins, **3858** recorded (DSR 225 -> 228, retention 267 -> 275 this task), API surface all checks passed, "All suites passed" (6.1 min) |
| reset + `pnpm test` | **152 files / 3414 tests passed** (238 s) |
| reset + `pnpm test:e2e` | **173 passed, 0 failed, 0 flaky** (21.0 m, detached) |

The `[admin] ... failed: caller is not the platform superuser at aal2` lines in
the e2e server log are the refusals the permission specs exercise, not errors.

**Follow-up F-T8-1:** `tests/unit/network/no-private-table-in-network-path.test.ts`
"DENOMINATOR: what the network-path filter DROPPED is pinned" ran ~5.05 s
against vitest's 5 s default under full parallel load on this machine (1.1 s
alone); green in this gate run. Give that test an explicit timeout or make it
cheaper; never add retries.

## Fix round 1

Commits `d9be7b2` (I3), `ea993f8` (M1), `6d3f8f1` (I1), `d7f0e3b` (I2 + M4), on `worktree-legal-phase`, pushed. 210 migrations before and after (`supabase_migrations.schema_migrations` = 210 after the pre-run reset).

**I1 (`6d3f8f1`).** The download-route parity test now plants a downloadable account export: `plantReadyAccountExport()` in `tests/e2e/support/fixtures.ts`. It inserts through the register's INSERT trigger, uploads an empty-but-valid zip to `exports/<id>.zip`, and walks queued, then running, then succeeded through the UPDATE trigger, which stamps `completed_at` and `expires_at` itself. The new positive control: the job's Owner gets a 302 whose `Location` is `/storage/v1/object/sign/exports/...`, and exactly one `export_job.downloaded` audit row is written. After that, anonymous, read_only, admin and no-workspace each compare the real id with the ghost id (status, normalised body, `Location`). The audit count must still be 1 at the end. Cleanup removes the object and the audit row (`deleteExportJobAndArchive`). Nothing was weakened, and the literal-404 expectations stand.

**I2 (`d7f0e3b`). Measured first, then fixed.**
- **Before the fix**, signed in as read_only, raw `GET` of each page, all HTTP 200:
  - Sizes: `/super/legal` 67,064 bytes, `/super/data-requests` 70,228, `/super` 59,211, the ghost 59,461.
  - `h-8` skeleton classes: 20 in legal, 4 in data-requests, 2 in the ghost.
  - The catch-all's `unknown` param appeared in the ghost only (2 hits, 0 in each real page).
  - So the reviewer's inference holds: the raw HTML identified the route.
- **The fix.** `lib/supabase/middleware.ts` rewrites every signed-in `/super` request to the fixed `/super/not-found` (served by the `[...unknown]` catch-all) when the caller is not on the allowlist.
  - The allowlist check is `public.is_platform_admin()`, the predicate `isSuperuser()` uses. It is not aal-gated, so the superuser at aal1 is still routed normally and the pages decide.
  - An RPC error fails closed, into the rewrite.
  - The pages keep their own `isSuperuser()` checks. This is parity, not the control.
  - The first e2e run caught a regression: the rewrite would have turned `/super/feedback/[id]/screenshot` (a route handler with a literal 404) into a streamed 200. `/super` route handlers are now exempt via `SUPER_ROUTE_HANDLER_PATHS`.
  - A new unit test in `super-page-census.test.ts` walks every `route.*` and `page.*` under `app/(app)/super`. Each handler must be exempt and no page may be. With the exemption regex removed, that test goes red (1 failed / 7 passed).
- **After the fix:**
  - Seven fetches in interleaved order: ghost, legal, ghost, data-requests, `/super`, a second ghost name, legal. All are byte-identical after `normaliseDocument()`.
  - `normaliseDocument()` strips only what differs between two fetches of the same URL:
    - the nonce;
    - `__next_r`;
    - the `"c":[...]` echo of the requested path;
    - dev-only `<id>:D"$<id>"` debug rows, whose count varied even between two fetches of one ghost;
    - flight row ids, renumbered by first appearance.
  - New assertions in `phase8-refusal-parity.spec.ts`:
    - for each of the 4 principals, raw status and normalised HTML must equal the ghost's, fetched beside each page;
    - a superuser control: the normaliser must still tell `/super/legal` from the ghost, and must give the same result for two fetches of one URL.

**M4 (`d7f0e3b`).** Both the rendered and the raw parity loops now iterate all 9 pages in `SUPER_PAGE_URLS`, plus `/super/legal?doc=terms`.

**I3 (`d9be7b2` and this file).** Re-summed from the 23 `run_suite` pins: **3858** (88 183 694 187 91 11 151 127 214 121 89 56 182 151 128 204 168 143 **228** 137 208 **275** 22). Corrected:
- CLAUDE.md's total and list;
- the retention history (now "275 since Phase 8 Task 8");
- the DSR prose (**228**);
- § 7's row, and the delta, which is **+33** (22 in the new suite + 3 DW4a-c + 8 RR7a-h).

SECURITY.md carried none of these numbers (grep for 3847/3825/225/267 found nothing).

**Minors.**
- **M1, fixed (`ea993f8`).** DR3 now pins `42501:consents: a consent can only be recorded from the data subject's own session`. That is the latest definition (`20260923003000`), checked live: a sessionless postgres insert raises exactly that. The suite count is unchanged at 22. The psql runner was **not** re-run this round.
- **Accepted, with reasons:**
  - M2, pinning the guard sentence per RPC: about 23 RPCs, which is not a one-line change. The reviewer's own reading found no false green.
  - M3, the destructive-primitive census: replacing the name regex with a full pinned set is a census redesign.
  - M5, re-running mutant 05a: a mutation batch run. The row stays accurate as history.
  - M6, `aclexplode` in DV1/DV12: defence in depth only, and the matrix's privilege census already reads `relacl`/`attacl`.

**Gates this round:**
- `pnpm lint`: clean. `npx next typegen` + `pnpm typecheck`: clean.
- `pnpm exec vitest run tests/unit`: 101 files / 2285 tests, all pass. One earlier run, made while the e2e dev server was compiling, had a load timeout in `no-private-table-in-network-path.test.ts`; it passed alone and in the full rerun.
- **e2e, partial and still owed.** `phase8-refusal-parity.spec.ts`, `super-permissions.spec.ts` and `exports.spec.ts` were run before the route-handler exemption existed. Results:
  - **24 of 26 passed.** These include every refusal-parity test (the raw-HTML parity for all 4 principals, the downloadable-export parity, and the superuser normaliser control), all 3 exports tests, and super-permissions 13-24.
  - Tests 25 (the screenshot route) and 26 (the service-role key scan) died with `Target crashed` / worker exit `3221225794`. Claude Code reaped the run because the system was critically low on memory. Those are not assertion failures.
  - The exemption was added after that run; it only narrows the rewrite. Because of the memory reaper, the run was not relaunched.
  - **Owed:** one run of the three specs (fresh reset first), above all the screenshot-route test.

## Fix round 2

Commits on `worktree-legal-phase`, each pushed: `f1947f9` (N1), `5c1b5e7` (the gate red + N3), `904b8f1` (N2 + SECURITY.md), `95fd5f2` (CLAUDE.md:28 and :91 / N4).

**The red (owner, `/super/legal?doc=terms` vs the ghost, raw HTML) was the test's normaliser, not the product: case (a).**
- The stack trace in the HTML is React's dev-only `<template data-dgst="NEXT_HTTP_ERROR_FALLBACK;404" data-msg data-stck data-cstck>` ("Switched to client rendering because the server rendering errored"). It is emitted by the streamed `notFound()` under `loading.tsx`. Production emits `data-dgst` alone. It is byte-identical across refused URLs, because the rewrite sends them all to one route.
- The diff only looked as if it were inside that stack, because the rest of the document follows on the same physical line. The real 71 differences were all in the flight data: `"$@113"` vs `"$f@108"` and the like, in the dev-only owner/debug-stack slots of React elements, with the same structure on both sides.
- **Cause.** The old `\$[A-Za-z]?` read the first hex digit of a plain reference as a type prefix: `"$f3"` became `$f` + `3`, while `"$e9"` stayed whole. Dev debug rows shift every id between requests, so whether an id began with a-f decided the outcome.
- **The first fix was not enough.** A first narrowing (row ids only after `\n`) reddened 2 of 23 tests. Rows after a length-prefixed `T` text row have no separator; the old `(?<=[A-Z])` term had been catching the `Z` that ends an SVG path.
- **Final normaliser.** It renumbers only:
  - ids at a real row start: after an unescaped `\n`, after `[1,"`, or at the exact end of a `T` row, located by decoding escapes and counting UTF-8 bytes;
  - whole escaped `"$<id>"` references, whose optional prefix is `@` or a non-hex letter.
- **N3 is closed by the same change:** `userId` is no longer rewritten.
- **Offline evidence, from 83 dumped responses:**
  - id-shift invariance (shift every flight id by k, which is what extra debug rows do) was broken in 140 of 140 (document, k) pairs under the old normaliser, and in 0 under the new one;
  - every principal's 20 refused documents normalise to one;
  - the superuser's legal page still differs from the ghost.

**N1.** `super-page-census.test.ts` gains 3 tests:
- the denominator (9 pages);
- each default export's first await must be `if (!(await isSuperuser())) notFound();`;
- each `generateMetadata()` must be gated on `isSuperuser()` with the catch-all's refused title, and no page may have a static `metadata`.

Mutation proof: deleting the page guard from `/super/legal`, then its metadata gate, each gave 1 failed / 10 passed. Both were restored. The middleware comment now says the pages decide only for allowlisted callers.

**N2.** SECURITY.md's refusal-parity entry now says three things:
- it compares raw HTML across all nine pages;
- signed-in non-superuser `/super` refusals are produced by the `lib/supabase/middleware.ts` rewrite, which is parity and not the control;
- the screenshot-route shape residual is accepted.

**Docs.**
- CLAUDE.md:28 names the raw-HTML comparison and says the catch-all closed only the rendered half and the middleware rewrite closes the rest. It also names the census and the residual.
- CLAUDE.md:91: 267 -> 275, re-checked against `run_suite ... rls_phase8_retention.sql rt 275`.

**Gates.**
- `pnpm lint` clean; `npx next typegen` + `pnpm typecheck` clean.
- `vitest run tests/unit`: 101 files / 2288 tests.
- e2e, each run after its own `db reset`:
  - parity + super-permissions: **23/23**;
  - parity alone: **9/9** and **9/9**;
  - plus an earlier diagnostic run of parity alone, which dumped raw HTML: **9/9**.
- Ended with `npx supabase db reset --local`; no node or chromium left running.
