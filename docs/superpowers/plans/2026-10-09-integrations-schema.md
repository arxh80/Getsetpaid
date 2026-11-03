# Phase 9 Integrations Schema: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the storage and access-control foundation for future third-party connectors, with no live connector:
- two tables;
- Vault-held tokens;
- RPC-only writes;
- full privacy-lifecycle wiring;
- tests that go red when any guard is removed.

**Architecture:**
- Postgres is the whole feature. The two tenant tables carry SELECT-only RLS and no client write grants.
- Every write is a SECURITY DEFINER RPC that checks the full permission chain.
- Tokens live in `vault.secrets` and are reachable only through one `service_role`-only RPC.
- A provider catalogue with every entry `live = false` makes connection creation impossible at MVP. That is deliberate.

**Tech Stack:** Supabase Postgres (migrations, RLS, Vault), psql suites run by `supabase/tests/run-rls-tests.sh`, Vitest unit/integration census tests.

**Spec:** `docs/superpowers/specs/2026-10-09-integrations-schema-design.md`. Read it first; it is the authority where this plan is terse.

## Global Constraints

- **Worktree:** `.claude/worktrees/integrations-phase`, branch `worktree-integrations-phase`. Migrations start at `20261030000000`; the last existing one is `20261029002000`.
- **Shared DB:** one local Supabase stack on port 54321 and dev port 3000 serves every worktree.
  - Before any `npx supabase db reset --local` or e2e run, check that no `node`/`playwright` process from another worktree is running.
  - Never run `pnpm build` or `pnpm start`; they reach the hosted project.
- **Write paths:** no client INSERT, UPDATE or DELETE grant on `integration_connections` or `integration_sync_runs`. All writes go through RPCs.
- **Tokens:** never in a table column, an audit payload, an export, a log or an error message.
- **No live provider:** every provider in `private.integration_providers()` has `live = false`. Nothing in this phase may set one true.
- **Downgrade:** it never deletes data. Free tier refuses new connects, and existing rows stay readable.
- **Shipped migrations are immutable.** Change a function by a new migration that rebuilds it from the live `pg_get_functiondef`, never by editing an old file.
- **Suites:** every psql suite must pass twice in a row on one database (Phase 8 lesson 11). Register each one in `run-rls-tests.sh` at a pinned assertion total.
- **Mutations:** every guard needs a mutant that reds a named assertion. A guard whose removal reds nothing is a CRITICAL finding.
- **Commits:** commit and push after each step group. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Job length:** each task is bounded to about 60 minutes of agent work. Long measurement runs go to a detached `nohup` script that logs to a file; the controller reads the log.
- **Questions:** anything that needs the founder goes to `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md` as the next Q (**Q232** onward), with a default that you then implement.

## Pattern files (read before writing)

| Need | Copy the pattern in |
|---|---|
| Permission key seed | `supabase/migrations/20260927000000_export_jobs.sql:76-84` |
| Starter+ entitlement gate | `private.crm_write_organisations()` (`20260908000000_switch_on_subscription_entitlement_gate.sql`) |
| Lifecycle refusal (suspended / owner_closed) | the newest rebuild of `private.permitted_organisations()` and the Task 9c refusals in `20261022001000_superuser_decides_a_closed_workspace.sql` |
| Attribution trigger | `private.stamp_row_attribution()` (`20261029001000_attribution_is_the_sessions.sql`) |
| Verdict-style "only the server writes this" rail | `20261029000000_scan_verdict_is_the_scanners.sql` (`record_document_scan_verdict`, the `row_security_active` check) |
| Vault create/read | `20261003005000_retention_clock.sql` (`vault.create_secret`, `vault.decrypted_secrets`) |
| Audit action catalogue (DB) | the newest migration that inserts into the action catalogue (grep `audit_action` in `20261027002000_closure_candidates_read_is_audited.sql`) |
| Erasure steps | `public.erase_account()`, newest rebuild in `20261007000000_erasure_scrubs_ids_inside_audit_payloads.sql` |
| Org purge | `private.erase_organisation()`, newest rebuild in `20261001004000_workspace_purge_summary.sql` |
| Retention classes | `private.retention_periods()` (`20261003002000_retention_sweeps.sql` and later rebuilds) |
| psql suite shape | `supabase/tests/rls_phase8_closure_backup.sql` (small, current) |
| Service-client census | `tests/unit/email/service-client-census.test.ts` |
| Permission matrix | `tests/integration/security/phase7-permission-matrix.test.ts` (`SERVER_ONLY_RPCS`) |

---

### Task 1: Tables, catalogue, RLS and grants

**Files:**
- Create: `supabase/migrations/20261030000000_integration_tables.sql`
- Create: `supabase/tests/rls_phase9_integrations.sql` (sections IT, IR, IB)
- Modify: `supabase/tests/run-rls-tests.sh`, which registers `run_suite "PHASE 9 INTEGRATIONS" rls_phase9_integrations.sql ig <N>` after the closure-backup suite.
- Modify: whatever census goes red on a new tenant table. Run `pnpm exec vitest run tests/unit` and the psql runner to find them: the RLS-enabled census, the FK-index census, the tenant-table/org-path census, the network-view dependency census (`rls_phase6_network_leakage.sql`) and the workspace-export table pin. Update each with the two new tables, and with an exact reason where a census needs one.

**Interfaces produced:**
- `private.integration_providers()` returns `table(provider text, category text, live boolean)`. It is IMMUTABLE and contains 8 rows: `google_gmail` email, `google_calendar` calendar, `microsoft_365_mail` email, `microsoft_365_calendar` calendar, `skiddle` ticketing, `fatsoma` ticketing, `xero` accounting, `quickbooks` accounting. All have `live = false`.
- Permission key `manage_integrations`, `survives_suspension = false`, seeded to `owner` and `admin`.
- Tables `public.integration_connections` and `public.integration_sync_runs`, with the columns given below.

- [ ] **Step 1: Write the failing suite sections.** Use the `rls_phase8_closure_backup.sql` shape: the same assertion helper, fixtures created as `postgres`, then `set local role authenticated` with JWT claims per persona. Personas:
  - Owner, Admin, Manager and Read Only of org A, on Starter;
  - Owner of org B;
  - Owner of org F, on Free.

  Assertions:
  - **IT1–IT6:** both tables exist, `relrowsecurity` and `relforcerowsecurity` are true, and `has_table_privilege('authenticated', t, 'INSERT')`, `'UPDATE'` and `'DELETE'` are all **false** on both. `anon` has no privilege at all.
  - **IT7:** `select count(*) from private.integration_providers() where live` = 0. IT8: the catalogue has exactly 8 rows.
  - **IT9:** the CHECK constraints reject `status = 'bogus'`, a `provider` outside the catalogue (via the validating trigger), and a sync run's `error_code = 'free text'`. Test each as `postgres` with `exception when check_violation`.
  - **IT10:** `revoked` is terminal. As `postgres`, an UPDATE from `revoked` to `active` raises `revoked_is_terminal`.
  - **IR1–IR6 (read):** with one connection in A and one in B, planted as `postgres`:
    - A's Owner and Admin see A's row and not B's.
    - A's Manager sees nothing, unless they are the `owner_user_id` of a person-scoped row, which they see.
    - A's Read Only sees nothing.
    - B's Owner never sees A's row.
    - Sync runs follow the same visibility.
  - **IB1–IB4 (breakout):** a forged INSERT, UPDATE or DELETE as A's Owner on each table fails with 42501, the privilege error, and the row counts are unchanged.

- [ ] **Step 2: Run it and see it fail.** `npx supabase db reset --local`, then `bash supabase/tests/run-rls-tests.sh`. Expect the new suite to fail at IT1, because the relation does not exist.

- [ ] **Step 3: Write the migration.**

```sql
-- Phase 9 Task 1: integration tables. Schema only -- no provider is live (founder 2026-10-09).
create or replace function private.integration_providers()
returns table (provider text, category text, live boolean)
language sql immutable set search_path = '' as $$
  values ('google_gmail','email',false), ('google_calendar','calendar',false),
         ('microsoft_365_mail','email',false), ('microsoft_365_calendar','calendar',false),
         ('skiddle','ticketing',false), ('fatsoma','ticketing',false),
         ('xero','accounting',false), ('quickbooks','accounting',false)
$$;
revoke all on function private.integration_providers() from public, anon, authenticated;

insert into public.permissions (key, survives_suspension, description) values
  ('manage_integrations', false,
   'Connect, revoke and read third-party integrations for a workspace. Owner and Admin. No provider is live at MVP (Phase 9, founder 2026-10-09).')
on conflict (key) do nothing;
insert into public.role_permissions (role_key, permission_key) values
  ('owner','manage_integrations'), ('admin','manage_integrations')
on conflict do nothing;

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  provider text not null,
  owner_user_id uuid null references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','active','error','revoked')),
  scopes text[] not null default '{}',
  token_secret_id uuid null,
  token_expires_at timestamptz null,
  last_synced_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null references auth.users(id) on delete set null,
  unique (organisation_id, id),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (status <> 'revoked' or token_secret_id is null)
);
create unique index integration_connections_one_live
  on public.integration_connections (organisation_id, provider,
     coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'revoked';
create index on public.integration_connections (owner_user_id);
create index on public.integration_connections (created_by);
create index on public.integration_connections (revoked_by);

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  connection_id uuid not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  items_read integer not null default 0 check (items_read >= 0),
  items_written integer not null default 0 check (items_written >= 0),
  error_code text null check (error_code in ('auth_expired','rate_limited','provider_unavailable','scope_missing','internal')),
  foreign key (organisation_id, connection_id)
    references public.integration_connections (organisation_id, id) on delete cascade,
  check ((status = 'failed') = (error_code is not null)),
  check ((status = 'running') = (finished_at is null))
);
create index on public.integration_sync_runs (organisation_id, connection_id);
create index on public.integration_sync_runs (connection_id);
```

  Then, in the same file:
  - A BEFORE INSERT OR UPDATE trigger, `private.integration_connections_guard()`. It refuses a provider that is not in the catalogue (`unknown_integration_provider`, 23514) and any move out of `revoked` (`revoked_is_terminal`, 23514).
  - The attribution trigger: `create trigger ... before insert or update on public.integration_connections for each row execute function private.stamp_row_attribution();`. Check the pattern migration for its exact trigger name and argument convention.
  - `alter table ... enable row level security; alter table ... force row level security;` on both tables.
  - `revoke all on both tables from public, anon, authenticated;` then `grant select on both tables to authenticated;`. `token_secret_id` stays readable here because it is only a uuid, and Task 2's Step 3 revokes it at column level.
  - The policies:

```sql
create policy integration_connections_select on public.integration_connections
  for select to authenticated using (
    organisation_id in (select private.permitted_organisations('manage_integrations'))
    or (owner_user_id = (select auth.uid())
        and organisation_id in (select private.permitted_organisations('view_crm')))
  );
create policy integration_sync_runs_select on public.integration_sync_runs
  for select to authenticated using (
    exists (select 1 from public.integration_connections c
            where c.organisation_id = integration_sync_runs.organisation_id
              and c.id = integration_sync_runs.connection_id)
  );
```

- [ ] **Step 4: Run the suite until it is green, then run it a second time on the same database.** Expect "All suites passed" both times, with the pin set to the real count.
- [ ] **Step 5: Run the unit and integration censuses.** Run `pnpm exec vitest run tests/unit tests/integration/rls` and update each census that names tenant tables, with a reason line for each.
- [ ] **Step 6: Commit.** Message: "Add the integration tables: Vault-ready, RPC-only writes, no live provider".

---

### Task 2: RPCs, Vault and the audit actions

**Files:**
- Create: `supabase/migrations/20261030001000_integration_rpcs.sql`
- Modify: `supabase/tests/rls_phase9_integrations.sql`, adding sections IC, IV, IS and IA.
- Modify: `supabase/tests/run-rls-tests.sh`, adding the HTTP twin to the API block (copy the Task 8/9 "real aal1 session" pattern).
- Modify: `tests/integration/security/phase7-permission-matrix.test.ts`, adding the three service-role RPCs to `SERVER_ONLY_RPCS` and the two member RPCs to the member-reachable list.
- Modify: the audit action catalogue tests (`audit-actions-match-db.test.ts`, wherever it lives).

**Interfaces consumed:** Task 1's tables, catalogue and `manage_integrations`.

**Interfaces produced** (exact signatures; all `security definer set search_path = ''`):

| Function | Who may execute | Behaviour |
|---|---|---|
| `public.connect_integration(p_org uuid, p_provider text, p_owner_user_id uuid default null) returns uuid` | `authenticated` | Refusal order: `not_authenticated` → `forbidden` (no `manage_integrations` in `p_org`, by `has_permission`) → `plan_does_not_include_integrations` (org not in `private.crm_write_organisations()`) → `workspace_not_writable` (suspended or owner_closed, using the same predicate the CRM write policies use) → `unknown_integration_provider` → `integration_provider_not_live` → `owner_not_a_member` (when `p_owner_user_id` is not an active member). Inserts a `pending` row and audits `integration.connected`. **At MVP every real call ends at `integration_provider_not_live`.** |
| `public.revoke_integration(p_org uuid, p_connection_id uuid) returns void` | `authenticated` | Allowed for `manage_integrations` in `p_org`, or for the connection's `owner_user_id`. Works on a suspended or closed workspace. Locks the row `for update`. Idempotent on an already-revoked row: returns without a second audit. Otherwise deletes the Vault secret (`delete from vault.secrets where id = token_secret_id`), sets `status='revoked'`, `token_secret_id=null`, `revoked_at=now()`, `revoked_by=auth.uid()`, and audits `integration.revoked` with payload `{provider, owner_scoped: bool}`. |
| `public.store_integration_token(p_connection_id uuid, p_secret jsonb, p_expires_at timestamptz) returns void` | `service_role` only | Refuses when `auth.uid() is not null` (`not_a_server_session`). Needs status `pending`, `active` or `error`. Creates a secret with `vault.create_secret(p_secret::text, 'integration:'||p_connection_id)` or updates it with `vault.update_secret`. Sets `active` and `token_expires_at`. Audits `integration.token_stored`; the payload holds the provider only. |
| `public.read_integration_token(p_connection_id uuid) returns jsonb` | `service_role` only | Refuses a person session. Needs status `active`. Reads `vault.decrypted_secrets`. |
| `public.record_integration_sync_run(p_connection_id uuid, p_run_id uuid, p_status text, p_items_read int, p_items_written int, p_error_code text) returns uuid` | `service_role` only | With `p_run_id` null it opens a `running` row; otherwise it closes that row. A `failed` close sets the connection to `error` and audits `integration.sync_failed` with `{provider, error_code}`. A `succeeded` close sets `last_synced_at`. |

Errors use `raise exception ... using errcode = '42501'` (forbidden/plan/not-writable/not_a_server_session) or `'22023'`/`'P0002'`, matching the scan-verdict migration's convention, with the hint carrying the token in the table above.

- [ ] **Step 1: Write the failing sections.**
  - **IC (connect rails), one assertion per refusal in the order above:**
    - Manager → forbidden;
    - Free Owner → plan;
    - suspended org Owner → not writable (suspend via the existing superuser RPC as `postgres`, or set lifecycle directly as `postgres`);
    - `'nope'` → unknown;
    - `'google_gmail'` → not_live;
    - B's Owner on A → forbidden.
  - **IC9 (positive control):** inside a savepoint, as `postgres`, `create or replace private.integration_providers()` with `skiddle` live. Call connect as A's Owner, assert one pending row and one `integration.connected` audit row, then `rollback to savepoint`. The label must state that this is the only route to a row at MVP.
  - **IC10 (downgrade keeps data):** a connection planted in an org that is then moved to Free (as `postgres`) is still SELECTable by its Owner, and connect is refused with `plan_does_not_include_integrations`.
  - **IC11 (closed workspace):** `revoke_integration` succeeds on a suspended org.
  - **IV (Vault):**
    - as `service_role` with no `sub`, `store_integration_token` on a planted pending row → status `active` and a `vault.secrets` row exists;
    - `read_integration_token` returns the jsonb;
    - as `authenticated` (A's Owner), both RPCs are refused 42501 by EXECUTE;
    - `select from vault.decrypted_secrets` and `select from vault.secrets` as `authenticated` are refused;
    - no `integration_connections` column contains the token text (`row_to_json(c)::text not like '%tok_%'`);
    - `revoke_integration` deletes the secret: `count(*) from vault.secrets where id = <old id>` = 0;
    - a second revoke writes no second audit row.
  - **IS (sync):** open → close succeeded sets `last_synced_at`; close failed sets the connection to `error` and writes one `integration.sync_failed` row; a free-text error code is refused.
  - **IA (audit):** for every integration audit row written by IC/IV/IS, `payload::text` contains neither the secret uuid nor the token string.

- [ ] **Step 2: Run it.** Expect red at the first IC assertion (the function does not exist).
- [ ] **Step 3: Write the migration.** Write it from the table above.
  - Add the four actions to the database audit catalogue, the way the pattern migration does.
  - `revoke execute ... from public, anon, authenticated` on the three server RPCs, then `grant execute ... to service_role`.
  - `revoke all ... from public, anon`, then `grant execute ... to authenticated` on the two member RPCs.
  - Also `revoke select (token_secret_id) on public.integration_connections from authenticated`. Column-level: re-grant SELECT on every other column explicitly, because a table-level grant would override the column revoke. Add **IT11:** `has_column_privilege('authenticated','public.integration_connections','token_secret_id','SELECT')` = false.
- [ ] **Step 4: Add the HTTP twin.** With a real aal1 Owner token for org A:
  - `POST /rest/v1/integration_connections` gets 401/403 and no row is created;
  - `PATCH` on a planted row gets 401/403 or touches 0 rows, and the row is unchanged;
  - `POST /rest/v1/rpc/read_integration_token` gets 403 or 404;
  - `POST /rest/v1/rpc/connect_integration` with `google_gmail` gets 4xx with `integration_provider_not_live` in the body.

  Positive control: `GET /rest/v1/integration_connections?select=id,provider,status` returns 200 with the planted row. Remove the planted rows afterwards.
- [ ] **Step 5: Run the full runner twice on one database, then the censuses.** Run `pnpm exec vitest run tests/unit tests/integration/security`. Expect everything green, with the matrix counting the new RPCs.
- [ ] **Step 6: Commit.** Message: "Add the integration RPCs: tokens in Vault, readable only by the server".

---

### Task 3: Privacy and lifecycle wiring

**Files:**
- Create: `supabase/migrations/20261030002000_integrations_in_the_privacy_lifecycle.sql`
- Modify: `supabase/tests/rls_phase9_integrations.sql`, adding sections IM, IE, IP, IX and IN.
- Modify, wherever each goes red:
  - the erasure suite's census of FK-less uuid columns;
  - `private.audit_payload_person_columns()`;
  - the retention class census;
  - the export table pin, in both the account export and the workspace export;
  - `lib/` export manifest code, if the export's table list is defined in TypeScript (grep `export_jobs` builders under `lib/export`).

**Interfaces consumed:** Task 2's `revoke_integration` internals. Factor the "delete secret, mark revoked" body into `private.revoke_integration_row(p_connection_id uuid, p_actor uuid, p_reason text)` so the trigger and erasure paths reuse it. Rebuild `revoke_integration` to call it, from its live definition.

- [ ] **Step 1: Write the failing sections.**
  - **IM (membership removal):** A's Manager owns a person-scoped connection with a stored secret, planted as postgres and service_role. Remove their membership through the product path (the existing remove-member RPC, or a DELETE as postgres if that is what the RPC does).
    - The connection becomes `revoked`, and its secret is gone.
    - A workspace-scoped connection they `created_by` stays active.
  - **IE (erasure):** run `erase_account()` for a person who owns a person-scoped connection in A and created a workspace-scoped one in A.
    - The person-scoped row and its runs are deleted, and its secret is gone.
    - The workspace-scoped row's `created_by` points at the tombstone.
    - Step 10b's "no id survives" scan passes.
    - The audit payloads hold no surviving id of theirs.
  - **IP (org purge):** `private.erase_organisation(A)` leaves 0 rows in both tables for A and 0 Vault secrets named `integration:<A's connection ids>`.
  - **IX (exports):** a workspace export job for A contains `integration_connections` and `integration_sync_runs`, with no key named `token_secret_id`; check the built archive's JSON the way `rls_phase8_exports.sql` does. An account export contains only the person's own person-scoped connections.
  - **IN (retention):** `private.retention_periods()` has the `integration_sync_run` class at 90 days and `integration_connection_revoked` at 2 years. A sync run with `finished_at` 91 days ago is swept, and one at 89 days is kept. The sweep runs through the real live sweep inside a savepoint, the way `cw.live_sweep_probe()` does.

  Network: add **IN9** to `rls_phase6_network_leakage.sql`'s dependency-set assertion, so that neither view depends on the new tables. If the existing pinned set already proves that, record that it does and add nothing.
- [ ] **Step 2: Run it and see it red.**
- [ ] **Step 3: Write the migration.** Each function below is rebuilt from its live `pg_get_functiondef`, with only the stated lines added:
  - `private.revoke_integration_row` (new);
  - an AFTER DELETE/UPDATE trigger on the membership table that revokes the departing person's person-scoped connections in that organisation;
  - `erase_account()`: a new step, placed before the auth.users delete, that calls `revoke_integration_row` for each of the person's connections and then deletes them and their runs. The `created_by`/`revoked_by` re-point is covered by the existing generic re-point, if it is generic; otherwise add the two columns;
  - `erase_organisation()`: deletes the org's Vault secrets before the cascade;
  - the export builders' table lists, with `token_secret_id` excluded by name;
  - `private.retention_periods()`: plus the two classes, and the sweep that applies them.
- [ ] **Step 4: Runner twice on one DB, then `pnpm test`.** Expect "All suites passed" both times and vitest green.
- [ ] **Step 5: Commit.** Message: "Wire integrations into erasure, purge, export and retention".

---

### Task 4: Discovery document (research only, no DB; can run in parallel with Tasks 1–3)

**Files:**
- Create: `docs/integrations-discovery.md`
- Modify: `DECISIONS-QUEUE.md`, adding the next free Q, "Which connector is first after launch?", with this document's recommendation as the default.

- [ ] **Step 1:** For each of Gmail, Google Calendar, Microsoft 365 mail and calendar (Graph), Skiddle, Fatsoma, Xero and QuickBooks, use web search to record:
  - whether a documented public API exists, with a URL;
  - the auth model and the narrowest scopes the PRD § 13 use case needs;
  - partner or licensing gates (Google's restricted-scope security assessment for Gmail, a Skiddle/Fatsoma partner agreement, the Xero app partner tier);
  - the vendor's data residency or transfer basis (UK/EU, or needs IDTA/SCCs);
  - whether it would add a sub-processor row.

  Every fact gets its source link and "checked 2026-10-09". Where a vendor publishes nothing, say so plainly. Do not infer.
- [ ] **Step 2:** End with a ranked recommendation for the first post-launch connector, with one paragraph of reasoning, and list what the founder must do first (app registration, security assessment, a DPA).
- [ ] **Step 3: Commit.** Message: "Document the integration candidates for the first post-launch connector".

---

### Task 5: Docs, mutations, gates

**Files:**
- Modify:
  - `CLAUDE.md`: § Current state, plus a new "Integrations, as they actually shipped in Phase 9" paragraph covering schema only, no live provider, tokens in Vault, RPC-only writes, the Starter+ gate, and that `connect_integration` always refuses today;
  - `SECURITY.md`: §§ 2, 4 and 15. A real connector is a launch-gate-style item: per-vendor DPA, IDTA check, OAuth app review;
  - `FOLLOW-UPS.md`: a Phase 9 section;
  - `docs/sub-processors.md`: **no** row, because nothing is sent to a vendor. Add a sentence saying so.
- Create:
  - `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/mutation-results/phase9/run.sh`, a detached, resumable mutation driver modelled on `mutation-results/run-all.sh`;
  - its results file.

- [ ] **Step 1: Mutations.** Apply each mutant inside `begin ... rollback` on a reset DB, or restore with a reset, and record the named red assertions:
  1. grant `insert` on connections to authenticated;
  2. drop the select policy and recreate it as `using (true)`;
  3. remove the `has_permission` check from connect;
  4. remove the plan check;
  5. remove the `live` check;
  6. remove the Vault delete in `revoke_integration_row`;
  7. grant execute on `read_integration_token` to authenticated;
  8. remove the membership trigger;
  9. remove the erasure step;
  10. include `token_secret_id` in the export;
  11. remove the `revoked_is_terminal` guard;
  12. a control with no mutation.

  Each must red at least one named IG assertion, and the control must be fully green. A mutant that reds nothing is a CRITICAL finding: add the missing assertion and re-run that mutant.
- [ ] **Step 2: Run the five gates.** `pnpm lint`; `npx next typegen && pnpm typecheck`; `npx supabase db reset --local && pnpm test`; reset plus `bash supabase/tests/run-rls-tests.sh`; reset plus `pnpm test:e2e`. Run them detached and read the logs.
  - No e2e spec changes, but the full suite must still pass. A refusal-parity timeout under RAM below 1 GB is re-run in isolation, never retried in config.
- [ ] **Step 3: Commit and push.** Message: "Document Phase 9 and record its mutation results". Append the Phase 9 line to `progress.md`.
