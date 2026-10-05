# Phase 8 final fix report (review A: I1, I2, m1)

2026-10-05 · base `bae744f` (238 migrations) → `ae1daba` (240 migrations). Bounded 60-minute job.

## I1 — malware verdict was client-writable: FIXED (`44c0714`, `20261029000000`)

**Probe, fresh reset at bae744f, aal1 Manager of a paid workspace (verbatim):**

```
insert ... scan_status='pending'                         INSERT 0 1
update ... set scan_status='clean', scanned_at=now()     UPDATE 1
update ... set scan_status='quarantined' (server path)   ERROR: documents.scan_status is terminal and immutable (was clean, tried to set quarantined)
select scan_status='clean' (download gate predicate)     t
insert ... scan_status='clean', scanned_at=now()         INSERT 0 1   (born clean)
```

**Fix:**
- Grants: INSERT is now seven columns with no verdict column, and UPDATE is `deleted_at` only. The Task 6 re-grant had existed only because the app wrote the verdict through the uploader's RLS client. No other client write needs those columns.
- `private.guard_document_scan_verdict()` is SECURITY INVOKER and checks `row_security_active`. For a session writer it requires a document to be born `pending` with a null `scanned_at`, and it refuses any change to `scan_status` or `scanned_at` (42501, `document_scan_verdict_is_the_scanners`).
- The only writer is `public.record_document_scan_verdict(org, doc, status)`:
  - SECURITY DEFINER, executable by `service_role` only.
  - Refuses a session that has a person on it.
  - Moves only a live row, pending → terminal. Anything else gets P0002.
- The app calls it through `lib/crm/scan-verdict.ts`. That file is added to the service-client census and to the matrix's SERVER_ONLY_RPCS.
- The download gate is unchanged.

**Tests:**
- New `rls_phase8_retention.sql` § SV (16 assertions):
  - grant layer
  - trigger asked directly with the grant switched back on
  - the RPC's three rails
  - the server verdict lands once
  - the gate predicate is false for quarantined and pending files
- RK11 and RK12 were rewritten: the session's UPDATE is now refused, and RK12a is the RPC control.
- PU6a and PU6b now check that the session's write is refused, the RPC verdict lands, and no `document.updated` row is written. The verdict write is sessionless, so the PS4/PS5 volume dropped from 56 to 55.

**Mutations** (scratch `mut.sql`, rolled back):

| Mutant | Forged PATCH result |
|---|---|
| Control | refused 42501 by the grant |
| A: grant re-widened | refused 42501 by the trigger |
| B: trigger dropped | refused 42501 by the grant |
| C: both layers removed | **LANDED** |
| RPC called as `authenticated` | refused 42501, no EXECUTE |

Each layer holds on its own.

**Other upload path:** feedback screenshots have no pending window. The server scans first, then makes one INSERT under an unguessable id it chose itself, and the bytes-must-exist rule from `20260911020000` still applies. Not the same shape, so it was left as is.

SECURITY.md §§ 4 and 6 were corrected.

## m1 — forgeable attribution: FIXED (`ae1daba`, `20261029001000`)

**Fix:** one generic trigger, `private.stamp_row_attribution()`, on `financial_entries`, `network_profiles` and `network_links`. It follows the born_pending pattern, with `postgres`/`supabase_admin` exempt, which covers seeds, erasure re-point and cascades.
- INSERT: a `created_by` other than `auth.uid()` is refused, and so is a `created_at` other than `now()` (23514, `attribution_is_the_sessions`). The trigger then stamps both.
- UPDATE: both columns are immutable.
- The app's explicit `created_by: user.id` still lands.

**Tests:** `rls_phase8_crm_audit_p3_6.sql` § AT has 10 assertions. The CRM audit pin went from 204 to 214. The network-leakage census LE1b/LE1d now counts 11/2/16/29 and names the new trigger.

**Mutations:**

| Mutant | Forged `created_by` result |
|---|---|
| Trigger dropped | **LANDED** |
| Body neutered | **LANDED** |
| Control | refused 23514 |

## I2 — closure backup destroyed by the delete's purge: NOT BUILT, queued as **Q229**

The 60-minute bound was spent on I1 and m1. Q229 in DECISIONS-QUEUE records the mechanism and the recommended narrowest default, which is a `closure_backup_owed` hold predicate in `sweep_expired_workspaces()`:
- The purge waits until the backup has been downloaded, or until 30 days after the decision, whichever comes first.
- The backup's `expires_at` must also be raised to at least decision + 30 days.
- The predicate is keyed on state `deleted` plus a succeeded closure backup, so the 60-day undecided purge and the DSR/erasure paths are untouched.

The review's option (c), set null and keep the backup row, is the founder's call. **Still owed before launch.**

## Gates (at ae1daba working tree, before commit)

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `npx next typegen` + `pnpm typecheck` | clean |
| `db reset` + psql/HTTP runner | **"All suites passed."**, runner_rc=0, migrations 240 → 240. Retention 329 as pinned, CRM audit P3-6 214. |
| vitest (`tests/unit`, `tests/integration/documents`, `tests/integration/rls`, phase7 matrix, crm-audit-p3-6, export runner) | 121 files / 3406 passed |
| e2e `documents.spec.ts` | **not run**: free RAM was 2.0 GB, below the 2.5 GB floor. Owed. |

The first runner pass was red in three expected-volume places, and each was fixed before the green run:
- the network census picked up the new trigger
- PS4/PS5 lost one `document.updated` row
- an SV fixture id collided with an existing one

The DB was reset at the end.

# Final fix round 2 (review A: I2 built, I1 HTTP twin)

2026-10-05 · base `614ddd9` (240 migrations) → 241 migrations. Bounded 60-minute job.

## I2 — closure backup destroyed by the delete's purge: BUILT as Q229's default (`d3aae6d`, `20261029002000`, pending founder)

**Rule:** the purge of a workspace deleted through `delete_closed_workspace()` is HELD until its latest closure backup has been downloaded by its requester, or 30 days after the decision, whichever comes first. That backup's `expires_at` is raised so it stays downloadable for the whole hold.

**Built:**
- `private.closure_backup_owed(org)` returns true when all of these hold:
  - lifecycle is `deleted`
  - the latest `closure_backup` job `succeeded` and has not expired
  - there is no `export_job.downloaded` audit row for that job whose actor is its `requested_by`
  - `retention_expires_at > now() - private.closure_backup_hold()`, which is 30 days; the decision dates that column to the decision itself
- `sweep_expired_workspaces()` excludes a held workspace from both loops in the WHERE clause, so a held workspace never takes a slot of `p_limit`. It reports them as `organisations.held_for_backup`.
- `delete_closed_workspace()` raises the succeeded backup's `expires_at` to at least `now() + 30 days` and records `backup_downloadable_until`.
- The raise goes through a new marker-gated exception in `export_jobs_before_update()`:
  - it requires `app.closure_backup_hold` = the job id
  - it moves `expires_at` upwards only, and nothing else on the row may change
  - a finished job is otherwise still refused; CH2d/CH2e check this
- All functions were rebuilt from the live `pg_get_functiondef`.
- **Retention roll:** `private.retention_clock_columns()` gains `export_jobs.requested_at` (classified `clock`; no client can write it). The fixed-point derivation reaches it through the new predicate. The first full runner pass was red without it: RK26 named the column, the clock roll refused the job, the retention suite showed 38 red, and the concurrency probe failed.
- Copy:
  - the `workspace_deleted` email and the close section now say the backup stays downloadable from the account's exports for up to 30 days
  - SECURITY.md § 7 is updated
  - CLAUDE.md's pin total is corrected to 4277
- Q229's status in DECISIONS-QUEUE is "built as default, pending founder".

**Closure suite § CH** (24 assertions, pin 157 → 181). `cw.live_sweep_probe()` runs the REAL live sweep, reads what survived and rolls the sweep back.

| Case | Result |
|---|---|
| E: never downloaded | held (live sweep: org and backup row 1/1) |
| E, 30 days on | purged together with its backup (0/0) |
| F: downloaded through `audit_export_download` | purged at once |
| G: Owner erased (Q206 tombstone) | the former requester's download is refused `not_your_export`, so G is held; purged at 30 days |
| H: undecided, 60-day clock out | `owner_closed`, not held, purged |
| I: Phase 7-shaped delete with an expired old closure backup | not held, purged |
| Reassign and DSR/erasure | untouched |

The decision notices are stamped delivered in the section's own housekeeping, because the first draft saturated the 30-row decision queue on re-runs (CR6/CX5).

**Mutations** (live DB, closure suite rerun, restored):

| Mutant | Red |
|---|---|
| M1: hold removed from the sweep | CH4b, CH5, CH7c (backup gone after the purge) |
| M2: expiry not raised | CH2, CH2c |
| M3: download ignored | CH6b, CH6c |
| M4: no 30-day bound | CH8, CH8b |
| M5: no `deleted` key | CP1, CX5, CH9 |
| Control | 181/0 |

## I1 HTTP twin (owed from round 1)

`run-rls-tests.sh`, Phase 4 API block. A real aal1 Manager session against their own pending upload, planted sessionless:
- PATCH `scan_status='clean'` + `scanned_at` → 403
- PATCH `scanned_at` alone → 403
- the row is still `pending` and unscanned
- POST born `scan_status='clean'` → 403, and no row exists

Positive controls on the same token:
- POST without the verdict → 201, born `pending`, owned by the session
- PATCH `deleted_at` → 204, with the verdict still `pending`

The planted rows are removed afterwards.

## Gates

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `npx next typegen` + `pnpm typecheck` | clean |
| `db reset` + full psql/HTTP runner (241 migrations) | **NOT "All suites passed"** |
| vitest `tests/unit tests/integration/export tests/integration/admin tests/integration/retention` | 118 files / 2677 passed |

Runner detail: every psql suite was at its pin with 0 red (closure 181, retention 329), plus 426 HTTP PASS. The 4 HTTP FAILs were the twin's own value checks: the expectation strings said `t`, and psql's `bool || text` renders `true`. The values the run read were the intended ones (pending/true ×3, true/pending). The strings were corrected after the run and re-checked with a standalone run of the twin's refusal half. **A clean full runner pass is owed** (one more reset + run, about 25 minutes, beyond the bound). The DB was reset at the end.
