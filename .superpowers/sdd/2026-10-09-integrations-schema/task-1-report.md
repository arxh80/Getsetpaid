# Phase 9 Task 1 report: integration tables, catalogue, RLS and grants

Status: DONE_WITH_CONCERNS (concerns at the end; none blocks Task 2).

## What was built

`supabase/migrations/20261030000000_integration_tables.sql`:

1. `private.integration_providers()`. IMMUTABLE, 8 rows, all `live = false`, EXECUTE revoked from public/anon/authenticated/service_role.
2. The permission key `manage_integrations` (`survives_suspension = false`), seeded to owner and admin.
3. `public.integration_connections` and `public.integration_sync_runs`, built verbatim from the brief. The FK indexes are named explicitly, and each table has a `comment on table`.
4. `private.integration_connections_guard()`, a BEFORE INSERT OR UPDATE trigger. It refuses a provider outside the catalogue (23514, hint `unknown_integration_provider`) and any move out of `revoked` (23514, hint `revoked_is_terminal`). **It is SECURITY DEFINER, not invoker** (see deviation 2).
5. The `stamp_attribution` trigger (`private.stamp_row_attribution()`) on `integration_connections`.
6. RLS is enabled and forced on both tables. `revoke all` goes from public, anon, authenticated and service_role, then `grant select` to authenticated. The two policies are the brief's.
7. Additive rebuilds from the live `pg_get_functiondef`, so a new tenant table does not break existing jobs (deviation 1):
   - `private.retention_subjects()`: both tables are added as `cascades`, marked INTERIM until Task 3 adds the 90-day and 2-year classes.
   - `private.fkless_identifier_columns()`: `integration_connections.token_secret_id` is added as `other` / `not_a_person`.
   - `private.export_catalogue()`: three INTERIM `excused` rows (workspace: both tables; account: `integration_connections`). Task 3 turns them into exports.

## Answers to the controller's checks

- **`permitted_organisations(text)` in a policy.** The live definition (newest rebuild 20261027000000) returns `setof uuid`. It is called in policies exactly as `organisation_id in (select private.permitted_organisations('view_crm'))` (for example `20260828120500_crm_policy_helpers.sql:300`). The brief's policy SQL is correct as written. It inherits the lifecycle rule (`deleted_at is null or survives_suspension`, plus the closure-backup marker) and the MFA gate (owner/admin/finance need aal2). IR7 measures the MFA part.
- **The writable-workspace and view_crm conventions.** Task 1 is read-only, so no write gate applies. The person-scoped branch keys on `view_crm`, which is the house read key (`survives_suspension = true`). `manage_integrations` does not survive suspension, so a suspended or closed workspace's Owner loses the workspace-scoped read. A person keeps reading their own person-scoped row. Reads are not tier-gated, so a Free workspace keeps reading its rows (IR6).
- **`stamp_row_attribution()` under a definer RPC.** It is SECURITY INVOKER and exempts `current_user in (postgres, supabase_admin)`. Inside a postgres-owned SECURITY DEFINER function, `current_user` is postgres, so **the trigger is a no-op for Task 2's RPCs**. It does not break them (IT12 measures a definer insert landing), but it does not stamp `created_by` either. **Task 2's RPCs must set `created_by := auth.uid()` (and `revoked_by`) themselves.** The trigger stays attached as the rail for any future non-owner write path, and IT13/IT14 prove it binds one.

## Assertions (`supabase/tests/rls_phase9_integrations.sql`, schema `ig`, pinned at 43)

The helpers are copied from `rls_phase8_closure_backup.sql`. Every refusal is caught inside `ig.val` and recorded as `denied(sqlstate[:hint])`, so it can never surface as a psql ERROR line. The suite removes its own fixtures, so it is re-runnable.

| ID | Proves |
|---|---|
| IT1 | Both tables exist. |
| IT2 / IT3 | `relrowsecurity` / `relforcerowsecurity` are true on both. |
| IT4 | authenticated holds no INSERT/UPDATE/DELETE/TRUNCATE on either table (8 checks, 0 held). |
| IT5 | anon and service_role hold nothing on either table, at table or column level. |
| IT6 | Positive control: authenticated holds SELECT on both. |
| IT7 | No provider is live. |
| IT8 | The catalogue is exactly the 8 named provider/category pairs. |
| IT8b | No client role can execute the catalogue. |
| IT9a | `status = 'bogus'` is refused with 23514 (CHECK). |
| IT9b / IT9c | A provider outside the catalogue is refused on INSERT and on UPDATE (23514, `unknown_integration_provider`). |
| IT9d | A free-text `error_code` is refused with 23514. |
| IT9e | A sync run cannot point at another organisation's connection (23503, composite FK). |
| IT9f | A second live connection with the same provider and scope is refused (23505, partial unique index). |
| IT9g | A revoked row that still carries `token_secret_id` is refused with 23514. |
| IT10 | revoked to active is refused (23514, `revoked_is_terminal`), even as postgres with `revoked_at` cleared. |
| IT10b | Positive control: active to error still works. |
| IT11 | `manage_integrations` does not survive suspension, and its roles are exactly admin and owner. |
| IT12 | A postgres-owned SECURITY DEFINER insert (Task 2's shape) lands, with `created_by` null (not stamped). |
| IT13 | The attribution trigger is attached, enabled, BEFORE INSERT and UPDATE. |
| IT14 | A non-owner INSERT naming another user as `created_by` is refused by the rail (23514, `attribution_is_the_sessions`). INSERT is lent to authenticated inside a rolled-back transaction, and the result is re-recorded after the rollback (the KT pattern). |
| IR1a/b | A's Owner (aal2) reads A's 2 connections and 2 sync runs, and none of B's or F's. |
| IR2a/b | A's Admin: the same. |
| IR3a/b | A's Manager reads only their own person-scoped connection and its run. |
| IR4a/b | A's Read Only reads nothing. |
| IR5a/b | B's Owner reads only B's rows, never A's. |
| IR6a/b | F's Owner (Free tier) still reads F's rows: a downgrade hides nothing. |
| IR7 | A's Owner at aal1 reads no workspace-scoped connection, because the permission is MFA-gated. |
| IB1–IB3 | A forged INSERT, UPDATE (planting a `token_secret_id`) or DELETE on connections as A's Owner fails with 42501 (missing grant). |
| IB4a–c | The same three on sync runs. |
| IB5 | Counts are unchanged (4/4), no run was written, and no `token_secret_id` was planted. |
| IZ1 | Housekeeping left no integration rows. |

The Free-tier persona (org F) only appears in IR6. The brief named the persona but gave it no assertion.

## Mutations (run by hand against the suite; Task 5 owns the scripted set)

| Mutant | Reds |
|---|---|
| M1: drop the guard trigger | IT9b, IT9c, IT10 (plus IR1a, IR2a, IB5 from the leaked bogus row) |
| M2: grant INSERT/UPDATE/DELETE to authenticated | IT4, IB1, IB2, IB3, IB4a–c |
| M3: connections policy `using (true)` | IR1a through IR7 (all 13) |
| M4: connections policy keyed on `view_crm` only | IR3a, IR3b, IR4a, IR4b |
| M5: sync-runs policy `using (true)` | IR1b, IR2b, IR3b, IR4b, IR5b, IR6b |
| M6: one provider `live = true` | IT7 |
| M7: `no force row level security` on sync runs | IT3 |
| M8: drop the `stamp_attribution` trigger | IT13 (and IT14 becomes `denied(42501)`) |

M8 reddened nothing before IT13/IT14 existed. That gap is why they were added.

## Censuses changed, and why

- `supabase/tests/run-rls-tests.sh`: registers `run_suite "PHASE 9 INTEGRATIONS" rls_phase9_integrations.sql ig 43` after the closure-backup suite, with its diagnostic block.
- `tests/integration/security/phase7-permission-matrix.test.ts`: both tables added to `PRE_PHASE7_RELATIONS`. They are tenant tables, not platform ones, and the comment gives the reason.
- `tests/integration/security/support/privilege-census.ts`: two declared entries, `integration_connections|authenticated|SELECT|*` and `integration_sync_runs|authenticated|SELECT|*`. Task 2 will narrow the first to column grants.
- `tests/integration/export/completeness-census.test.ts`: both tables added to `WORKSPACE_EXCUSED`, `integration_connections` added to `ACCOUNT_EXCUSED` (all INTERIM), and the base-table literal moved from 54 to 56.
- `lib/export/contract.ts` `WORKSPACE_EXCLUDED_TABLES`: two INTERIM phrases ("connections to other services, which cannot be made yet", "the history of those connections"). `excluded-tables-match-db.test.ts` requires the workspace export page to name every excused table. Task 3 removes them.
- Retention roll and FK-less uuid roll: covered in the migration (§6, §7). `retention-matches-db.test.ts` and the erasure runner (`tests/integration/erasure/runner.test.ts`) were red without them. **Every account erasure refused with 55000 the moment `token_secret_id` existed.**
- Needed no change: the RLS-enabled census, the FK-index census, the network-view dependency census (`network_leakage_phase6.sql`) and the closure-backup KS1 pin (35). The tables are excused, not exported, so the pin did not move. All of these stayed green.

## Test runs

- Red first: the suite against the pre-migration DB failed with `relation "public.integration_connections" does not exist`.
- Full runner, after `npx supabase db reset --local` each time:
  - run 1, suite at 41: `All suites passed.`, 27 pinned suites, 4318 assertions;
  - run 2, suite at 41: the same;
  - run 3, final suite at 43: `All suites passed.`, 27 suites, **4320 assertions**, exit 0.
- The suite alone, twice more on the same DB after run 3: `rerun 1: errors=0 43 | 0` and `rerun 2: errors=0 43 | 0`. An earlier pair at 41 was also `41 | 0` twice.
- `pnpm exec vitest run tests/unit tests/integration` on a fresh reset: **3814 passed, 1 failed (3815)**. The failure is `tests/unit/legal/storage-census.test.ts` › "no scanned file imports code from a place the scan skips", which times out at the default 5000 ms. With `--testTimeout=60000` it passes (84/84, the test itself took 3916 ms). My diff does not touch what it scans except five lines in `lib/export/contract.ts`. It is a timing flake under load.
- `pnpm exec vitest run tests/unit tests/integration/rls` (the brief's command), before the CRLF fix below: 2757/2757.
- Lint and typecheck: see the addendum.

## Deviations from the brief

1. **Three existing rolls rebuilt in the same migration** (retention subjects, FK-less uuids, export catalogue). Without them, a new tenant table makes the nightly retention sweep refuse (`unclassified_retention_subject`) and every account erasure refuse (`unclassified_fkless_identifier`). The brief only anticipated census tests going red; these are production refusals. The export and retention rows are INTERIM, and Task 3 replaces them with real exports and classes. Task 1 does not export the tables because the workspace export reads under the requester's RLS, and `token_secret_id` must first be column-revoked (Task 2).
2. **The guard is SECURITY DEFINER.** As an invoker trigger it refused any non-owner writer with a bare 42501 on the EXECUTE-revoked catalogue, which hid the attribution rail and its 23514 (measured in IT14). It reads only NEW/OLD and the catalogue.
3. **Extra assertions beyond IT1–IB4:** IT8b, IT9c, IT9e–IT9g, IT10b, IT11–IT14, IR6 (the Free-tier persona), IR7, IB5 and IZ1.
4. **Attribution is a no-op under the definer RPCs** (above). Task 2 must stamp `created_by` and `revoked_by` itself.

## Concerns

- **CRLF checkouts break the retention suite on this machine. This is pre-existing and not caused by Task 1.** `core.autocrlf=true` checks the migrations out with CRLF. Function bodies then carry `\r\n`, and `rls_phase8_retention.sql`'s `replace(... chr(10) ...)` mutants miss. My first full run had 11 red RA/REL assertions (RA3, RA4, RA5, RA9, RA10, RA10a, RA11, REL16, REL17, REL21, REL22). I converted the working-tree copies under `supabase/` to LF with no content change (`git diff --numstat` shows 0/0 on them), and every run since is green. The index is LF, so CI and other checkouts are unaffected. A future session on this machine that sees those 11 reds should LF-normalise `supabase/` before suspecting a regression. A `.gitattributes` `*.sql text eol=lf` would fix it permanently; I left it alone because it is a repo-wide change outside this task.
- The storage-census timeout above is a 5 s default timeout on a CPU-bound walk.
- The INTERIM export copy ("connections to other services, which cannot be made yet") is under the page's "the platform's own records" framing, which is not quite the right category. It is true and transient: Task 3 must remove it when it exports the tables.

## Addendum: lint and typecheck

- `pnpm lint`: clean.
- `pnpm typecheck`: clean (exit 0), after `npx next typegen`. Without typegen it fails with `Cannot find name 'PageProps'` in `app/legal/[slug]/page.tsx`. That is the known missing-`.next/types` condition CLAUDE.md describes, not something this task introduced.
