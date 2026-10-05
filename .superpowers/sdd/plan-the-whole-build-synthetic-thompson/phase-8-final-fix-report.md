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
