# Phase 9 Task 2 report: integration RPCs, Vault tokens, audit actions, HTTP twin

Status: DONE_WITH_CONCERNS (concerns at the end; none blocks Task 3).

## What was built

`supabase/migrations/20261030001000_integration_rpcs.sql`:

1. `private.integration_role_held(p_org)`. TRUE when the session is an active member whose role grants `manage_integrations`, with the MFA gate applied but the workspace lifecycle IGNORED. `has_permission()` is false for every non-surviving key on a wound-down workspace. Without this helper, a suspended Owner would be told `forbidden` and could not revoke anything. EXECUTE is revoked from every client role.
2. `public.connect_integration(p_org, p_provider, p_owner_user_id default null) returns uuid`, executable by authenticated. Refusal order:
   - `not_authenticated` (28000);
   - `forbidden` (42501): `has_permission`, or the role test on a wound-down workspace;
   - `plan_does_not_include_integrations` (42501): `crm_write_organisations()`, plus `effective_organisation_plan()` for a wound-down workspace, because the former drops one;
   - `workspace_not_writable` (42501): `deleted_at is null`, the same predicate the CRM write path uses; the organisations CHECK binds it to `lifecycle_state = 'active'`;
   - `unknown_integration_provider` (22023);
   - `integration_provider_not_live` (22023);
   - `owner_not_a_member` (22023).

   It inserts a `pending` row with `created_by := auth.uid()` set explicitly. A second connect for the same scope gets 23505 `integration_already_connected`. It audits `integration.connected` with `{provider, owner_scoped}`.
3. `public.revoke_integration(p_org, p_connection_id)`, executable by authenticated. Allowed for a `manage_integrations` holder (by `has_permission` OR the role test, so it works on a suspended or closed workspace) or for the connection's `owner_user_id`. It locks the row `for update`. On an already-revoked row it returns quietly, with no second audit. Otherwise it:
   - deletes the Vault secret;
   - sets `status = 'revoked'`, `token_secret_id = null`, `revoked_at = now()` and `revoked_by := auth.uid()` (set explicitly);
   - audits `integration.revoked` with `{provider, owner_scoped}`.

   A caller who is neither gets 42501 `forbidden` whether or not the id exists, so the call is no oracle. A holder naming an unknown id gets P0002 `integration_connection_not_found`.
4. `public.store_integration_token(p_connection_id, p_secret jsonb, p_expires_at)`, service_role only. It refuses a person session (`not_a_server_session`, the scan-verdict check), a non-object secret, and a revoked row. It creates the secret with `vault.create_secret(p_secret::text, 'integration:'||id)` or rotates it in place with `vault.update_secret`, then sets `status = 'active'` and `token_expires_at`. It audits `integration.token_stored` with `{provider}` only.
5. `public.read_integration_token(p_connection_id) returns jsonb`, service_role only. It refuses a person session and needs status `active` with a secret; otherwise it returns P0002 `integration_connection_not_active`. It reads `vault.decrypted_secrets`.
6. `public.record_integration_sync_run(...) returns uuid`, service_role only. With `p_run_id` null it opens a `running` row, and only on an `active` or `error` connection. Otherwise it closes that running row:
   - `succeeded` sets `last_synced_at`;
   - `failed` sets the connection to `error` and audits `integration.sync_failed` with `{provider, error_code}`.

   `p_error_code` is checked against the closed vocabulary BEFORE the CHECK sees it (22023 `unknown_sync_error_code`, value not echoed). The reason: a CHECK violation's DETAIL prints the failing row, and a provider error string could carry a token. Closing a run that is not running gives P0002 `sync_run_not_running`. A failed close without a code, or a succeeded close with one, gives 22023 `sync_run_error_code_mismatch`.
7. **Sessionless audit.** `token_stored` and `sync_failed` have nobody on the session, and `log_audit_event()` raises 28000 without an `auth.uid()`. Both RPCs therefore INSERT into `public.audit_events` directly, with the Q130 tombstone (`private.erased_user_id()`) as actor. This is the `retention.swept` pattern.
8. **The guard, rebuilt from live** (Task 1 review M5). It now refuses ANY update of a revoked row (23514 `revoked_is_terminal`), with one exception: a foreign key nulling `owner_user_id`, `created_by` or `revoked_by`. Without the exception, deleting or erasing the account that revoked a connection is refused, because those three FKs are `ON DELETE SET NULL`. Measured: mutant M22 reddens IT10d.
9. **`token_secret_id` withheld from `authenticated`.** The table-level SELECT is revoked and SELECT is granted on the 12 other columns by name. `select *` from a client is now refused (42501), and naming the columns works. IT15, IV7c/d/e and the HTTP twin measure both.
10. **The DB audit catalogue** (`private.platform_audit_actions()`) is rebuilt from live with four names appended: `integration.connected`, `.revoked`, `.token_stored` and `.sync_failed`.

## Assertions added to `supabase/tests/rls_phase9_integrations.sql` (pinned 56 → 136)

New fixtures:
- `mgr2_a`, a second Manager in A (the original Manager's membership is deleted by IR9);
- org S (Starter) with Owner `owner_s` and connection `conn_s`, suspended as postgres;
- `conn_p`, a person-scoped connection owned by `mgr2_a`;
- `conn_v`, a pending connection used for the Vault checks.

New helpers:
- `ig.probe_delete_user` deletes an account and undoes it;
- `ig.err_text` returns the full message, detail and hint of a refusal.

| ID | Proves |
|---|---|
| IT6 (changed) | The positive control for connections is now `has_any_column_privilege`, because the table-level grant is gone. |
| IT15 | `has_column_privilege('authenticated', …, 'token_secret_id', 'SELECT')` = false. (The brief calls this IT11, but IT11 was already taken by Task 1.) |
| IT15b | All 12 other columns are selectable, and no table-level SELECT remains. |
| IT10c / c2 / c3 | A revoked row refuses an update of `scopes` and of `last_synced_at`, and refuses re-pointing `revoked_by` at another person, even as postgres. |
| IT10d | Positive control: deleting the account that revoked a connection still works (the FK SET NULL passes the guard). |
| IC0 / IC0b | EXECUTE: connect and revoke are open to authenticated and not to anon; store, read and sync are open to service_role alone (9 checks). |
| IC1 | `not_authenticated`: a session with no sub. |
| IC2 / IC2b | `forbidden`: A's Manager; A's Owner at aal1 (MFA gate). |
| IC3 | `plan`: F's Owner (Free). |
| IC4 / IC4b | `workspace_not_writable`: S's Owner while S is suspended, and while S is `owner_closed`. |
| IC5 | `unknown`: `'nope'`. |
| IC6 / IC6b | `integration_provider_not_live`: `google_gmail` as the Owner, `xero` as the Admin. |
| IC7 / IC7b | `forbidden`: B's Owner on A; a workspace that does not exist. |
| IC8 | No refused connect wrote a row or an audit row. |
| IC9 / IC9a–e | **The only route to a row at MVP**: `skiddle` is made live inside a transaction that is rolled back. The Owner connects. One pending row has `created_by` = the caller. A second connect gets 23505 `integration_already_connected`. A person-scoped connect for someone outside A gets `owner_not_a_member`, and one for an active member lands. There is one `integration.connected` row per landed connect, with payload `{provider, owner_scoped}`. Results are carried across the rollback (KT pattern). |
| IC9z | The rollback took the row, the audit rows and the live provider with it (IT7 still holds). |
| IC10 / IC10b | Downgrade to Free: the Owner still SELECTs both of A's connections, and connect is refused on the plan. |
| IC11 / a / a2 / b / c | On suspended S: B's Owner is refused, with the same refusal for a made-up id. S's Owner revokes, and `revoked_by` = the caller. An unknown id in their own workspace gives `not_found`. |
| IC12 / a / b | A Read Only member cannot revoke the Manager's person-scoped connection. The Manager, who has no `manage_integrations`, revokes their own, and `revoked_by` = the Manager. |
| IV1 / IV2 / IV3 | service_role with no sub stores a token on a pending row and reads it back. The row becomes `active` with an expiry, and a `vault.secrets` row named `integration:<id>` holds the token. |
| IV4 / IV4b / IV3b | A second store rotates the token in place: same secret id, the new token is read. |
| IV4c | An `error` connection that still holds a token is not read (the status check). |
| IV5 / b / c | A service_role session WITH a sub is refused `not_a_server_session` by store, read and sync: the RPC's own rail, not EXECUTE. |
| IV6 / b / c | A's Owner (aal2) cannot EXECUTE store, read or sync (42501). |
| IV7 / b | Authenticated cannot read `vault.decrypted_secrets` or `vault.secrets`. |
| IV7c / d / e | `token_secret_id` and `select *` are refused (42501 missing_grant); the explicit column list works. |
| IV8 | No `integration_connections` row's `row_to_json` contains `tok_`. The denominator is 1 row holding a secret. |
| IV9 / b / c | The Owner revokes. The Vault secret count for the old id is 0. The row is revoked with no secret, and `revoked_by` = the Owner. |
| IV10 / b | A second revoke is a no-op: one `integration.revoked` row, payload `{"provider":"fatsoma","owner_scoped":false}`. |
| IV11 / b | A revoked connection's token cannot be read (P0002) or stored again (22023). |
| IV12 | Two `token_stored` rows, both with the tombstone as actor; the payload is `{"provider":"fatsoma"}` only. |
| IS1 / IS2 / IS2b | Open, then close succeeded with 5 read and 3 written. The run is finished, and the connection's `last_synced_at` is set. |
| IS3 / b / c / d | Open, then close failed with `rate_limited`. The connection goes to `error`, and one `sync_failed` row is written (tombstone actor, `{provider, error_code}`). |
| IS4 | A run on an `error` connection still opens (a retry). |
| IS5 / IS5b | A free-text error code is refused with 22023 `unknown_sync_error_code`, and the refusal's message, detail and hint do not echo the value. |
| IS6 / IS7 / IS8 | A failed close without a code, a close of an already-closed run, and an open on a revoked connection are each refused. |
| IS9 | The refused closes changed nothing. |
| IA1 | Denominator: revoked=3, sync_failed=1, token_stored=2 audit rows. IC9's rows are rolled back and checked inside IC9b. |
| IA2 | None of them holds the secret uuid or `tok_`. |
| IZ1 (extended) | Housekeeping also removes org S, the two new users and any `integration:` Vault secret. |

**The bug the suite caught.** The first build of `revoke_integration` let B's Owner revoke S's workspace-scoped connection (IC11a red). The check `not (v_role or v_c.owner_user_id = v_uid)` evaluates to NULL when `owner_user_id` is null, and an IF treats NULL as false. Fixed with `coalesce(…, false)`; mutant M8 restores the bug and reddens IC11a and IC11b.

## Mutants (scripted: each applied to the live DB, the suite run, the original re-applied)

| Mutant | Reds |
|---|---|
| M1 connect: forbidden check removed | IC2, IC2b, IC7, IC7b |
| M2 connect: lifecycle-blind role branch removed | IC4, IC4b |
| M3 connect: plan check removed | IC3, IC10b |
| M4 connect: writable check removed | IC4, IC4b |
| M5 connect: live check removed | IC6, IC6b, IC8, IC9b, IC9z, IC10, IA1 |
| M6 connect: owner_not_a_member removed | IC9d, IC9b |
| M7 connect: created_by not stamped | IC9a |
| M8 revoke: coalesce dropped (the measured bug) | IC11a, IC11b |
| M9 revoke: owner branch removed | IC12, IC12b, IA1 |
| M10 revoke: has_permission only | IC11, IC11c, IC11b, IA1 |
| M11 revoke: idempotent early return removed | IV10 |
| M12 revoke: Vault secret not deleted | IV9b |
| M13 revoke: revoked_by not stamped | IC11b, IC12b, IV9c |
| M14 store: person-session check removed | IV5, IV12, IA1 |
| M15 read: person-session check removed | IV5b |
| M16 sync: person-session check removed | IV5c |
| M17 sync: error_code pre-validation removed | IS5, IS5b |
| M18 sync: failed close leaves the connection active | IS3c |
| M19 sync: succeeded close leaves last_synced_at | IS2b |
| M20 store: secret id put in the audit payload | IV12, IA2 |
| M21 guard: revoked is terminal for status only (Task 1 shape) | IT10c, IT10c2, IT10c3 |
| M22 guard: FK set-null exemption removed | IT10d |
| M23 grants: table-level SELECT restored | IT15, IT15b, IV7c, IV7d |
| M24 grants: store executable by authenticated | IC0b, IV6 |
| M25 grants: connect executable by anon | IC0 |
| M26 read: status check removed | IV4c (this mutant reddened NOTHING until IV4c was added) |
| M27 store: revoked check removed | IV11b |
| M28 sync: a close of a non-running run allowed | IS7 |
| M29 sync: an open on any status allowed | IS8 |
| M30 sync: failed close not audited | IS3d, IS9, IA1 |
| M31 connect: no audit | IC9b |

The suite was green (136/0) after the restore.

## Censuses and tests changed

- `supabase/tests/run-rls-tests.sh`:
  - the pin moves 56 → 136, and the diagnostic block names IC, IV, IS and IA;
  - **HTTP twin** (end of the API block, 17 checks). It uses a fresh password-grant Owner token (`$IGA1`, aal1; `$OWN` was revoked when `$OWN2` verified the first factor) and the TOTP-elevated `$OWN2`:
    - POST `integration_connections` is refused 403 for both tokens, and the row does not exist;
    - PATCH (planting a secret id, or setting status) is refused 403 for both, and the row is unchanged;
    - `rpc/read_integration_token` gets 403 for both;
    - `rpc/connect_integration` with `google_gmail` gets 400 with `integration_provider_not_live` for the aal2 Owner, and 403 with `"hint":"forbidden"` for the aal1 Owner (the MFA gate). No row and no audit row were written;
    - positive control: GET `select=id,provider,status` returns the planted row (`xero`); GET `select=token_secret_id` and `select=*` both get 403;
    - the planted rows are removed and the removal is asserted.
- `supabase/tests/rls_phase8_crm_audit_p3_6.sql` PA6c: the derived catalogue count 167 → 171. It was the one red in full-runner run 1, and that is why the file changed.
- `lib/admin/audit-actions.ts` `PLATFORM_AUDIT_ACTIONS`: the four names, in the same order as the DB copy (`tests/unit/admin/audit-action-catalogue.test.ts` asserts the order).
- `tests/integration/admin/audit-actions-match-db.test.ts`:
  - the catalogue pin moves 167 → 171;
  - the direct-insert writer roll gains `public.record_integration_sync_run` and `public.store_integration_token`.
- `tests/integration/security/phase7-permission-matrix.test.ts`: `SERVER_ONLY_RPCS` gains the three service-role signatures, and `MEMBER_REACHABLE_RPCS` gains `connect_integration` and `revoke_integration`, each with its reason.
- `tests/integration/security/support/privilege-census.ts`: `integration_connections|authenticated|SELECT|*` becomes 12 column entries.

## Commands and totals

- Red first: the extended suite against the pre-migration DB recorded 65 passed and 70 failed. The first red is IT15, and IC1 onwards fail on the missing function.
- Full runner, `npx supabase db reset --local` before each run, in the foreground:
  - run 1: one red (PA6c, the catalogue pin; fixed above);
  - run 2: exit 0, `All suites passed.`, 27 pinned suites, **4413 assertions**, `PHASE 9 INTEGRATIONS: 136 assertions recorded, as pinned.`, `API surface: all checks passed.`;
  - run 3 (fresh reset again): exit 0, `All suites passed.`, 27 suites, **4413 assertions**, API surface all passed.
- The suite alone, twice more on the same DB after run 2: `136 | 0` both times, with no ERROR lines.
- `pnpm exec vitest run tests/unit tests/integration/security` on a fresh reset: **117 files, 3274 tests passed, 0 failed** (exit 0). Plus `tests/integration/admin` (the audit catalogue's live binding): 3 files, 23/23. One earlier run on a DIRTY database (not reset after a runner) showed `export_jobs ... no download was audited` red (1 vs 0). That is a leftover from the runner's own export rows, and it was green on the fresh reset.
- `pnpm lint`: clean (exit 0). `npx next typegen && pnpm typecheck`: clean (exit 0).

## Deviations from the brief

1. **IT11 is named IT15**, because Task 1 already uses IT11. IT6 changed to `has_any_column_privilege`.
2. **The refusal order holds on a wound-down workspace only because of `integration_role_held`.** The brief's own pattern made `workspace_not_writable` unreachable: `has_permission` is false for `manage_integrations` (not surviving) and `crm_write_organisations()` drops a workspace whose `deleted_at` is set, so a suspended Owner would have hit `forbidden`. The helper, plus `effective_organisation_plan()` for the plan step, keeps the documented order.
3. **The IV8 LIKE pattern is escaped** (`'%tok\_%'`). Unescaped, `_` matches any character, and `"token_secret_id"` / `"token_expires_at"` (column NAMES in `row_to_json`) would match, so the brief's literal pattern could never pass.
4. **Sessionless audit rows use the tombstone actor** via a direct insert. `log_audit_event()` cannot be used without a person on the session. The brief says to audit but not how.
5. **`p_error_code` is validated in the RPC** rather than left to the CHECK, so a refused value is never echoed in an error (IS5b).
6. **Extra refusal hints the brief did not name:** `not_authenticated` uses 28000 (the `log_audit_event` convention), plus `integration_already_connected`, `integration_connection_not_found`, `integration_connection_revoked`, `integration_connection_not_active`, `integration_secret_invalid`, `integration_secret_missing`, `unknown_sync_error_code`, `sync_run_opens_running`, `sync_run_closes_terminal`, `sync_run_error_code_mismatch` and `sync_run_not_running`.
7. **The guard's FK exemption** (a revoked row may have its three person columns nulled). Without it, erasure breaks; IT10d and mutant M22 cover it.
8. **The HTTP twin uses both an aal1 and an aal2 Owner.** An aal1 Owner holds no `manage_integrations` (MFA-gated, IR7), so with aal1 alone connect answers `forbidden`, never `integration_provider_not_live`, and the positive-control GET returns nothing. Both outcomes are asserted.
9. No founder question was raised; nothing needed one.

## Concerns

- **`read_integration_token` needs `active` (per the brief), but a sync can open on an `error` connection.** After any failed sync the connection is `error` and its token is unreadable until a new token is stored, so an automatic retry after `rate_limited` cannot work. This is harmless today (no live provider). Decide before the first connector whether a read on `error` is allowed, or whether a failure should leave the status alone for transient codes.
- **`service_role` already holds `USAGE` on `vault` and SELECT on `vault.secrets`** (the Supabase default, measured). The RPCs are therefore the sanctioned path for the server, not the only one. The browser has no path (IV7, IV7b).
- **The token travels as an RPC argument.** If Postgres statement logging (`log_statement = all`) were ever enabled on the hosted project, `p_secret` would appear in the logs. The default is off. This is worth a line in SECURITY.md when the first connector lands.
- **A workspace purge cascades the connection rows but not their Vault secrets.** Task 3 owns this (it is noted in the retention roll), so orphaned secrets are possible until then. There are none today, because no provider is live.
- **A person who has left a workspace can still revoke their own person-scoped connection,** if they know its id. Revoking only reduces access, so this was left deliberately.

## Fix round 1 (review: task-2-review.md)

The fixes are in a new migration, `supabase/migrations/20261030002000_integration_rpcs_fix_round_1.sql`. It is rebuilt from the live `pg_get_functiondef`, and no shipped file was edited.

### C1 (Critical): nothing tested the role half of `not_a_server_session`

Each of the three server RPCs refuses a person's session in two halves: a `sub` check and a role check. IV5–IV5c only proved the `sub` half. No code changed; the role half now has assertions:

- **IV5d / IV5e / IV5f.** Inside a rolled-back transaction, EXECUTE on store, read and sync is lent to `anon`. `anon` then calls each one with no `sub`, and each answers `denied(42501:not_a_server_session)`. The results are carried across the rollback, the same way IC9's are.
- **IV5g.** After the rollback, `anon` executes none of the three, so the lent grants are gone.

### m4: the revoked-row freeze now fails closed

The guard used to compare ten columns by name. It now compares `to_jsonb(new)` and `to_jsonb(old)`, each minus `owner_user_id`, `created_by` and `revoked_by`. Those three may still only change to NULL.

- **IT10e.** Inside a rolled-back transaction, a column `ig_probe` is added. An UPDATE of that column on a revoked row is refused with `revoked_is_terminal`. The result is carried across the rollback.

### m6: a dangling `token_secret_id` now gets a new secret

Before this fix, a store over a missing secret updated nothing and still set the row `active`.

**I chose to recreate the secret, not to raise.** A store is the server handing over a fresh, legitimately obtained token, so recreating keeps "active means a readable secret exists" true. Raising would leave the connection stuck until someone revokes and reconnects. It would also protect nothing: only `service_role` or `postgres` can delete a secret out of band.

The store also clears any leftover secret stored under the connection's own name, because the name is unique and the new secret needs it.

- **IV4e / IV4f / IV4g.** The secret is deleted out of band. The next store succeeds, the new token reads back, and the row names a new secret that exists.
- **IV4h / IV4i.** The row's secret id is lost while a secret under the connection's name survives. The store still succeeds, and exactly one secret is left under that name: the one the row names, holding the new token.
- IV12 and IA1 now count 4 `token_stored` rows instead of 2.

### m7: `private.integration_role_held` is now SECURITY INVOKER

Its only callers are `connect_integration` and `revoke_integration` (checked by grep), and both are definers owned by postgres. EXECUTE stays revoked from every client role.

As expected, making it a definer again reddens nothing: invoker is the narrower setting, but nothing depends on it. It is listed below for completeness.

### Red before the fix

Against the pre-fix migration, four assertions were red: IT10e, IV4f, IV4g and IV4i. IV5d/e/f passed, because the role half already existed in the code; it simply had no test.

### Mutants

Each mutant was applied to the live functions (both migrations applied in order, then the last definition mutated), the suite was run, and the original was restored.

| Mutant | Assertions that went red |
|---|---|
| C1a store: role half dropped | IV5d |
| C1b read: role half dropped | IV5e |
| C1c sync: role half dropped | IV5f |
| m4 guard back to the named-column list | IT10e |
| m4b FK set-null exemption removed (new guard) | IT10d |
| m6 existence check dropped | IV4f, IV4g, IV4i |
| m6b leftover same-name secret not cleared | IV4h, IV4i, IV12, IA1 |
| m7 back to SECURITY DEFINER | none (expected: see m7 above) |

After the restore, every assertion was green.

### Runs

- **Suite alone, twice on one database** (with the migration applied): 146/0 both times. After full-runner run 4 below, twice more on that same database: 146/0 both times, with no ERROR lines.
- **Full runner** after a fresh `npx supabase db reset --local`, in the foreground: exit 0, `All suites passed.`, 27 suites, **4423 assertions**, `PHASE 9 INTEGRATIONS: 146 assertions recorded, as pinned.`, and all API-surface checks passed. `run-rls-tests.sh` now pins the suite at 146 instead of 136.
- **`pnpm exec vitest run tests/unit tests/integration/security`** after a fresh reset: 117 files, **3275/3275 passed**, exit 0.
- No TypeScript changed in this round.
