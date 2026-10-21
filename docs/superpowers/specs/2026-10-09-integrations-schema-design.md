# Phase 9: Integrations, schema and discovery only

Founder sign-off on 2026-10-09: **no live connector ships before launch**. Design approved as written.

## Goal

Lay the storage and access-control foundation that every future connector needs: Gmail and Microsoft 365, Google and Microsoft calendars, Skiddle and Fatsoma, Xero and QuickBooks (PRD § 13). Nothing here talks to a third party. The phase is done when:
- the two PRD § 11 tables exist;
- a token can never be read by any client role;
- tenant isolation, erasure, export and retention all account for the new tables;
- each guard is proven by a test that goes red when the guard is removed.

## Out of scope

- Any OAuth flow, connector, webhook, background sync or UI page.
- A ticket-URL field on events. The founder declined it for this phase.
- Merging `infra-parallel-stacks`. RAM on this machine cannot hold two stacks.

## Token storage: Supabase Vault

- A connection's credential bundle (access token, refresh token and the provider's own metadata) is one JSON text stored with `vault.create_secret()`.
- `integration_connections.token_secret_id` holds only the secret's uuid.
- Rejected alternatives:
  - App-level AES-GCM: an env key, rotation work, and ciphertext ending up in exports.
  - pgsodium TCE: deprecated.
- Vault is already the repository's pattern for runner secrets.

## Tables

### `public.integration_connections`

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `organisation_id uuid not null` | FK to organisations, indexed |
| `provider text not null` | Must be in `private.integration_providers()`, a SQL catalogue function. It lists the PRD candidates (`google_gmail`, `google_calendar`, `microsoft_365_mail`, `microsoft_365_calendar`, `skiddle`, `fatsoma`, `xero`, `quickbooks`), each flagged `live = false`. The connect RPC refuses a provider that is not live, so **at MVP no connection can be created except by a test running as `postgres`**. |
| `owner_user_id uuid null` | A person-scoped connection, such as a mailbox. Null means workspace-scoped. Must be an active member at connect time (see Membership removal). |
| `status text not null` | `pending`, `active`, `error` or `revoked`. Born `pending`. `revoked` is terminal. |
| `scopes text[] not null default '{}'` | |
| `token_secret_id uuid null` | Vault secret. Null once revoked. |
| `token_expires_at timestamptz null` | |
| `last_synced_at timestamptz null` | |
| `created_by`, `created_at` | Stamped by `private.stamp_row_attribution()`, the Phase 8 trigger |
| `revoked_at`, `revoked_by` | |

- Unique: one non-revoked connection per (organisation, provider, coalesce(owner_user_id, nil uuid)).

### `public.integration_sync_runs`

| Column | Notes |
|---|---|
| `id`, `organisation_id`, `connection_id` | Tenant-scoped composite FK to the connection, indexed |
| `started_at`, `finished_at` | |
| `status` | `running`, `succeeded` or `failed` |
| `items_read`, `items_written` | non-negative ints |
| `error_code text null` | Must be in an allowlist (`auth_expired`, `rate_limited`, `provider_unavailable`, `scope_missing`, `internal`). **No free-text error and no provider payload column**, because a provider response can carry personal data. |

## Access

- New permission key `manage_integrations`, seeded to `owner` and `admin`.
- SELECT on connections is allowed to:
  - a member with `manage_integrations`;
  - the `owner_user_id` themself.
- SELECT on sync runs follows the parent connection.
- **There is no client INSERT, UPDATE or DELETE grant on either table.** Every write goes through SECURITY DEFINER RPCs that check the full permission chain (platform ∩ entitlement ∩ role ∩ scope):
  - `connect_integration(org, provider, owner_user_id)` creates a `pending` row, and refuses a non-live provider.
  - `revoke_integration(org, connection_id)`, for `manage_integrations` or the owner. It deletes the Vault secret, nulls `token_secret_id`, and sets `revoked` and the stamps.
  - service_role only:
    - `store_integration_token(connection_id, secret_json, expires_at)` creates or replaces the Vault secret, then moves `pending`/`error` to `active`;
    - `read_integration_token(connection_id)` is the one decrypting path; it refuses a session that has a person on it;
    - `record_integration_sync_run(...)` opens and closes runs.
- **Entitlement:** Starter and Pro may connect; Free may not. A downgrade keeps the rows readable and refuses new connects. It never deletes anything.
- A suspended or owner-closed workspace refuses connects and token writes but still allows revoke, matching the lifecycle rules already in force.

## Privacy and lifecycle wiring

- **Erasure (`erase_account`):** deletes the person's person-scoped connections, together with their Vault secrets, plus their sync runs. Workspace-scoped connections they created are re-pointed to the tombstone, through the existing `created_by` re-point. Both new tables go into the FK-less uuid roll and the audit-payload person-column census.
- **Membership removal:** when a person leaves a workspace, their person-scoped connections in that workspace are revoked and the secrets deleted, by a trigger on the membership delete or deactivate. `owner_user_id` is therefore a plain FK to `auth.users`, kept consistent by that trigger, not a composite FK that would block the removal.
- **Workspace purge (`erase_organisation`):** deletes all connections, their secrets and their runs.
- **Exports:**
  - The workspace export carries connection metadata (provider, status, scopes, dates) and sync runs, never `token_secret_id` or a token.
  - The account export carries the person's own connections.
  - The export table pin moves accordingly.
- **Retention:** sync runs are kept 90 days, as a new class in `private.retention_periods()`. Revoked connections are kept 2 years, under the inactive-data default.
- **Audit:** the actions `integration.connected`, `integration.token_stored`, `integration.revoked` and `integration.sync_failed` are added to the database action catalogue. A payload never contains a token or a secret id.
- **Network:** no change. A census asserts that neither view's dependency set includes the new tables.

## Discovery document

`docs/integrations-discovery.md` covers each PRD candidate:
- whether a documented public API exists;
- auth model (OAuth scopes);
- licensing or partner terms;
- data residency of the vendor;
- whether it would be a new sub-processor.

Every claim carries a source link and the date it was checked. It closes with a recommended first connector for after launch. Research only: no code.

## Testing

- **New psql suite `rls_phase9_integrations.sql`,** registered in `run-rls-tests.sh` at a pinned total. It covers:
  - tenant breakout on both tables, across roles;
  - a token unreadable by `anon`, `authenticated` (any role) and a member of the owning org, with `vault.decrypted_secrets` unreachable;
  - each RPC's rails (wrong org, wrong role, Free tier, non-live provider, suspended, a person session calling a service_role RPC);
  - the status machine (`revoked` terminal);
  - revoke deletes the secret;
  - erasure and purge delete secrets;
  - export excludes token fields.
- **HTTP twin over real PostgREST:** forged INSERT and PATCH get 403, and a token read via RPC gets 403/42501.
- **Existing censuses extended:**
  - the RLS-enabled census;
  - FK indexes;
  - the service-client census;
  - the matrix's `SERVER_ONLY_RPCS`;
  - the audit action catalogue;
  - retention classes;
  - the export table pin;
  - the network-view dependency sets.
- **Mutations:** drop each guard in turn (grant, policy, RPC check, provider liveness, Vault delete on revoke, erasure step) and confirm a named assertion goes red.
- **The five gates at the end.** There is no new page, so there is no new e2e or axe scan.
