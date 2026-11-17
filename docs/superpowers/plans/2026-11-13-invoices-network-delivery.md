# Invoices (part 3 of 3): Network Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Pro workspace that has issued an invoice to a CRM company can deliver it, with one button, into that company's own GetSetPaid workspace when the two are connected on the network, and the receiver's `view_finance` members read it in a read-only inbox (view, PDF, Pay by card) and get one email.

**Architecture:** One new two-tenant table, `invoice_deliveries`, written only by two `SECURITY DEFINER` RPCs and readable by the sender only. The receiver reads through one definer view, `received_invoices`, whose WHERE clause is `private.permitted_organisations('view_finance')` plus the server request mark, with its column list and `pg_depend` set pinned by psql. Eligibility (Pro, issued or paid, a live manual link, a live published foreign profile, an accepted connection) lives in **one** private SQL function that both the deliver RPC and the page's state RPC call. The email reuses part 1's audit-row notice loop.

**Tech Stack:** Next.js 16 App Router (Server Actions, route handlers), React 19, Supabase Postgres (RLS, definer RPCs, a definer view, triggers), Vitest 4, Playwright, psql suites under `supabase/tests/`.

**Spec:** `docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md` (founder-approved 2026-11-13; the source of truth).
**Ledger:** `.superpowers/sdd/2026-11-13-invoices-network/progress.md` (add with `git add -f`).

## Global Constraints

- Branch `invoicing-network`, worktree `.claude/worktrees/invoicing-network`, rebased onto `main` (`5eea055`). The PR targets `main`. Merging to `main` needs the founder's explicit approval.
- New migrations take timestamps after the newest on `main`, `20261116004000_idle_limit_covers_a_never_refreshed_session.sql`. This plan uses `20261117000000` … `20261117003000`. If `main` gains a later migration before merge, rename ours forward.
- **Never** run `pnpm build` or `pnpm start`; never point anything at the hosted project; never read the main checkout's `.env.local`.
- The local Supabase stack and port 3000 are shared across worktrees. Before any `db reset`, psql suite, integration run or e2e run, check for other sessions' processes (`tasklist | grep -i -E "node|playwright|psql"`). If another session is running a heavy job, wait. One heavy job at a time. psql: `docker exec supabase_db_getsetpaid psql -U postgres ...`.
- Never start ClamAV or any extra container locally (the Docker VM is capped at 2 GB).
- The full e2e suite cannot run on this machine (dev server OOM, ~2.4 GB free). Run **one spec at a time**: `npx playwright test tests/e2e/<spec> --workers=1`, with the dev server started separately in the background and `PLAYWRIGHT_REUSE_SERVER=1`. A worker death, `Target crashed` or `ERR_CONNECTION_REFUSED` is the machine; re-run that spec. **Never** add retries to fix a flake. CI runs the full suite.
- A new worktree needs the gitignored `SECURITY.md` copied in from the main checkout, or `security-md-checklist` unit tests fail: `cp ../../../SECURITY.md .` (never commit it).
- The five gates before a task is done: `npx eslint app lib components tests scripts` (locally, since `pnpm lint` walks `.claude/worktrees`), `pnpm typecheck` (after adding a route, `npx next typegen` first), `pnpm test`, the psql suite (`npx supabase db reset --local` then `bash supabase/tests/run-rls-tests.sh`), and the e2e specs the change can reach.
- **psql pin:** every assertion in the new `supabase/tests/rls_invoice_deliveries.sql` is one line beginning `select idl.val(`. Its `run_suite` pin is `grep -c '^select idl.val(' supabase/tests/rls_invoice_deliveries.sql`, moved in the same commit as the assertions. A new assertion in any other suite moves that suite's pin.
- TDD for every control: write the failing test, watch it fail for the stated reason, implement, watch it pass, then a **mutant** that reverts the control and turns the test red. Record each mutant in the ledger.
- Every refusal assertion is paired with a positive control in the same section (CLAUDE.md § Testing gates).
- Migrations are additive: never edit an applied one. Rebuild an existing function from its live `pg_get_functiondef`, diffed against its latest defining migration first (named in each step), adding only the stated lines.
- Every `SECURITY DEFINER` function sets `search_path = ''`, schema-qualifies everything, and ends with `revoke all on function … from public, anon, authenticated, service_role;` followed by exactly the grants the task names.
- Audit payloads are **name-only** (CLAUDE.md § Non-negotiable rules): the invoice number at most, never an amount, an address, a profile id or the receiving organisation's name. Targets are ids.
- UI: `DESIGN.md` tokens only, square corners, no shadows or gradients, `tabular-nums` on every number, money only through `formatGbp` (`lib/format/money.ts`), dates through `formatDateOnly`/`formatDate`. Every new page has a `loading.tsx`. Outcomes that unmount their form use `components/ui/action-outcome.tsx`.
- A refusal looks like not-found (the streamed not-found contract, `DESIGN.md` § Error pages). Never a 403.
- Commit and push after every change, one logical change per commit (`git pull --rebase` before `git push`). Every commit message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Founder answers of 2026-11-13 are recorded as **Q282** in `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md` (Task 8). New founder questions take Q283 onwards, each with an implemented default.
- Never use bare `git stash`.

## Decisions this plan takes where the spec is silent or meets the codebase

Each is recorded in the task that implements it and reported at the end.

1. **The view's key columns are named `id` and `organisation_id`, not `delivery_id` and `to_organisation_id`.** `lib/list/query.ts` keysets on `id` and puts `.eq("organisation_id", …)` on every list query. With these names the received list goes through the chokepoint unchanged and needs **no** entry in `RELATIONS_WITHOUT_ORGANISATION_ID` (the tenant-boundary exemption set). It is added to `TABLES_WITHOUT_SOFT_DELETE` only. `organisation_id` is the **receiving** workspace: the one whose member is reading.
2. **The view adds `sender_name`** (`snapshot->'seller'->>'name'`), so the list can show and search it without parsing JSON per row. It is already inside `snapshot`, so nothing new is disclosed.
3. **The spec's `paid_at` is `paid_on`** (`invoices.paid_on date`).
4. **The rate limit is a `BEFORE INSERT` trigger modelled on `private.meter_connection_request()`** (`20260909060000`). The spec said "as invoice email is", but invoice email is spent app-side by `sendInvoiceAction`. Category `invoice_delivery`, scope `user`, 30 per 3600 s. It is **not** added to the TypeScript `RateLimitCategory` union: trigger-metered budgets are deliberately left out of it (`lib/security/rate-limit.ts`'s comment). A repeat delivery (the idempotent no-op) inserts nothing and spends nothing.
5. **One eligibility predicate, `private.invoice_delivery_target(p_invoice_id, p_profile_id) returns uuid`** (the receiving organisation, or null). `deliver_invoice` calls it, and so does `public.invoice_delivery_state(p_invoice_id)`, the one read the sender's page makes. The page cannot compute eligibility itself: the sender may not hold `view_network`, and the base `network_profiles` table no longer answers a foreign row (Phase 10 Task 19).
6. **Every refusal of `deliver_invoice` and `withdraw_invoice_delivery` is the same error:** `42501`, hint `invoice_delivery_refused`. Only `not_authenticated` (28000) differs. So a probe cannot tell "not connected" from "no such profile" from "not Pro".
7. **The received PDF download is audited** as `invoice.received_pdf_downloaded`, in the **receiving** organisation, target the delivery id, payload `{number, status}`. This mirrors part 1's `audit_invoice_download`. The spec did not mention it; part 1's route audits before it renders, and the receiver's route keeps that order.
8. **Retention class `cascades`** (composite FK to `public.invoices`, `ON DELETE CASCADE`), like every other invoice child. The financial clock is the invoice's own.
9. **Export:** the workspace export carries `invoice_deliveries` with scope `{from_organisation_id}` (the sender only; spec default 2). The account export excuses it (the account appears only as `delivered_by` / `withdrawn_by`).
10. **Notice recipients** are the active members of the receiving workspace whose role holds `view_finance` (a `role_permissions` join, as `private.permitted_organisations` does), with the tombstone excluded and only while that workspace is not read-only. The window is seven days, like the other audit-row notices.
11. **The withdraw action is gated on `manage_finance` and "not suspended" only, with no Pro check** (spec: a downgraded workspace must still be able to pull back what it sent). The deliver action uses part 1's `authorise()` (manage_finance + Pro + not suspended).
12. **`withdrawn_by` may be null on a withdrawn row** (erasure sets it null), so the pair check is one-way: `withdrawn_by is null or withdrawn_at is not null`.

## File Structure

**Migrations** (`supabase/migrations/`)
- `20261117000000_invoice_deliveries.sql`: the table, RLS, grants, indexes, the `invoice_delivery` budget and its trigger, and the catalogues (audit actions, retention roll, export). (Task 1)
- `20261117001000_invoice_delivery_rpcs.sql`: `private.invoice_delivery_target`, `deliver_invoice`, `withdraw_invoice_delivery`, `invoice_delivery_state`. (Task 2)
- `20261117002000_received_invoices_view.sql`: `public.received_invoices`, `audit_received_invoice_download`. (Task 3)
- `20261117003000_invoice_delivery_notice.sql`: the ledger notice, the rebuilt `mark_notices_delivered` / `mark_notices_undeliverable`, and `pending_invoice_delivery_notifications`. (Task 4)

**psql:** `supabase/tests/rls_invoice_deliveries.sql` (new, schema `idl`). Also modified: `run-rls-tests.sh`, `rls_phase7_rate_limits.sql` (policy count 14 → 15), `network_leakage_phase6.sql` (IN10), `rls_phase8_closure_backup.sql` (seed + KS1).

**Server** (`lib/invoices/`)
- `delivery.ts` (new): `loadDeliveryState(invoiceId)`.
- `received.ts` (new): `RECEIVED_LIST`, `RECEIVED_SELECT`, `mapReceivedRow`, `loadReceivedInvoice(orgId, deliveryId)`.
- `actions.ts` (modified): `deliverInvoiceAction`, `withdrawInvoiceDeliveryAction`.
- `refusals.ts` (modified): `invoice_delivery_refused`.

**Email:** `lib/email/invoice-templates.ts` (`buildInvoiceDeliveredNotice`), `lib/email/invoice-notifications.ts` (`deliverInvoiceDeliveredNotifications`), `app/api/incident-alerts/deliver/route.ts`.

**Routes**
- `app/(app)/[orgSlug]/invoices/received/page.tsx`, `loading.tsx`
- `app/(app)/[orgSlug]/invoices/received/[deliveryId]/page.tsx`, `loading.tsx`
- `app/(app)/[orgSlug]/invoices/received/[deliveryId]/pdf/route.ts`
- Modified: `app/(app)/[orgSlug]/invoices/[invoiceId]/page.tsx`

**Components:** `components/invoices/invoice-delivery-panel.tsx` (new). **Nav:** `lib/nav/areas.ts` (`FINANCE_ITEMS`). **List:** `lib/list/query.ts` (`TABLES_WITHOUT_SOFT_DELETE`).

**Tests**
- Unit: `tests/unit/invoices/received-list.test.ts`, `tests/unit/invoices/delivery-actions.test.ts` (new); modified: `tests/unit/email/invoice-templates.test.ts`, `tests/unit/email/invoice-notifications.test.ts`, `tests/unit/email/delivery-route.test.ts`, `tests/unit/invoices/refusals.test.ts`, `tests/unit/forms/action-outcome-census.test.ts`.
- Integration: modified `tests/integration/security/phase7-permission-matrix.test.ts`, `tests/integration/security/support/privilege-census.ts`, `tests/integration/export/completeness-census.test.ts`.
- e2e: `tests/e2e/invoices-network.spec.ts` (new), `tests/e2e/support/fixtures.ts`, `tests/e2e/support/axe-routes.ts`, `tests/e2e/super-permissions.spec.ts` (`ROUTE_HANDLERS`), `tests/e2e/tenant-breakout.spec.ts`.

**Docs:** `docs/as-built.md`, `CLAUDE.md`, `SECURITY.md` (local, gitignored), the decisions queue, the spec (two wording fixes).

---

### Task 1: The table, its budget, and every census it trips

**Files:**
- Create: `supabase/migrations/20261117000000_invoice_deliveries.sql`, `supabase/tests/rls_invoice_deliveries.sql`
- Modify: `supabase/tests/run-rls-tests.sh`, `supabase/tests/rls_phase7_rate_limits.sql`, `supabase/tests/network_leakage_phase6.sql`, `supabase/tests/rls_phase8_closure_backup.sql`, `lib/admin/audit-actions.ts`, `tests/integration/security/phase7-permission-matrix.test.ts`, `tests/integration/security/support/privilege-census.ts`, `tests/integration/export/completeness-census.test.ts`, `docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md`

**Interfaces:**
- Produces (SQL):
  - `public.invoice_deliveries(id uuid pk, invoice_id uuid, from_organisation_id uuid, to_organisation_id uuid, delivered_by uuid, delivered_at timestamptz, withdrawn_at timestamptz, withdrawn_by uuid)`
  - the partial unique index `invoice_deliveries_live_unique (invoice_id, to_organisation_id) where withdrawn_at is null`
  - `rate_limit_policies` row `invoice_delivery` (`user`, 30, 3600) and trigger `meter_invoice_delivery` → `private.meter_invoice_delivery()`
  - audit actions `invoice.delivered`, `invoice.delivery_withdrawn`, `invoice.received_pdf_downloaded`

- [ ] **Step 0: Fix the spec's two wording errors.** In the spec, § Sender side, replace "enforced by a `BEFORE INSERT` trigger on `invoice_deliveries`, as invoice email is." with "enforced by a `BEFORE INSERT` trigger on `invoice_deliveries`, modelled on `private.meter_connection_request()` (invoice email is spent app-side instead)." In § `public.received_invoices`, replace `paid_at` with `paid_on`. Commit: "Spec: the delivery budget's model and paid_on".

- [ ] **Step 1: Write the psql suite's header, fixtures and § DT / § DR / § DB / § DK (they fail: the table does not exist).** Create `supabase/tests/rls_invoice_deliveries.sql`. Copy `rls_invoices_stripe.sql`'s header block (lines 1–90: `\set ON_ERROR_STOP on`, the schema, `results`, `record`, `val`, the grants) with `ist` renamed `idl` everywhere. The header comment lists the sections:

  ```
  -- Task 1 (20261117000000): DT table, grants, policy; DR who reads the base table;
  --                          DB no client writes; DK the catalogues
  -- Task 2 (20261117001000): DD deliver; DW withdraw; DS the page's state; DL the budget
  -- Task 3 (20261117002000): DV the received view; DP the received PDF audit
  -- Task 4 (20261117003000): DN the notice resolver and ledger
  -- Later tasks add their sections ABOVE § DZ.
  ```

  Fixtures (as postgres, every id a fresh uuid from `gen_random_uuid() \gset`, users created as in `rls_invoices_stripe.sql` lines 107–112, every claim `aal2`):

  | Name | What |
  |---|---|
  | `org_s` | sender, **Pro**; `fin_s` (finance), `ro_s` (read_only), `own_s` (owner) |
  | `org_r` | receiver, **Starter** (proves "any tier"); `fin_r` (finance), `bk_r` (booker: no `view_finance`), `own_r` (owner) |
  | `org_t` | a third workspace, Pro; `fin_t` (finance); connected to nobody |
  | `org_u` | linked but **not** connected, Pro; `fin_u` |
  | `org_x` | Starter **sender**; `fin_x`; connected to `org_r` |
  | `prof_s`, `prof_r`, `prof_u`, `prof_x`, `prof_t` | one published profile each in S, R, U, X, T (`entity_kind 'company'`, `entity_id gen_random_uuid()`, `status 'published'`, `display_name` = `'IDL ' || org letter`) |
  | `prof_rd` | a **draft** profile in R |
  | `com_s`, `com_x` | a company in S and in X |
  | `con_s` | a contact in S |
  | links (as postgres) | S: `com_s`→`prof_r`, `com_s`→`prof_u`, `com_s`→`prof_rd`. X: `com_x`→`prof_r` |
  | accepted requests | S↔R (from S, profiles `prof_s`→`prof_r`) and X↔R (from R, `prof_r`→`prof_x`), both `status 'accepted'`, `responded_at now()` |
  | invoices in S | `inv_i` issued to `com_s`, `inv_p` paid to `com_s`, `inv_v` void to `com_s`, `inv_d` draft to `com_s`, `inv_c` issued to `con_s` |
  | invoice in X | `inv_x` issued to `com_x` |
  | settings | `invoice_settings` rows for S and X (business name `IDL Sender Ltd` / `IDL Starter Ltd`, an address) |

  Build the invoices exactly as `rls_invoices_stripe.sql` lines 150–167 does (drafts, one line each, totals, then the flip to issued with `private.build_invoice_snapshot`), numbered `inv_i` `IDL-0001`, `inv_p` `IDL-0002`, `inv_v` `IDL-0003`, `inv_c` `IDL-0004` and, in X, `inv_x` `IDL-0001`. For `inv_p` set `status='paid', paid_on=current_date, paid_by=:'fin_s', paid_via='manual'` in a second update. For `inv_v` set `status='void', voided_at=now(), voided_by=:'fin_s', void_reason='Wrong amount'`. Seed one Stripe account row for S (`acct_IDL…`, `charges_enabled true`, `linked_by fin_s`) so § DV can see `card_payment_enabled`.

  Sections, each assertion one line beginning `select idl.val(`:
  - **§ DT:**
    - DT1 the table exists and RLS is enabled: `select relrowsecurity::text from pg_class where oid = 'public.invoice_deliveries'::regclass` → `true`.
    - DT2 `authenticated` holds SELECT only (the ST3 expression from `rls_invoices_stripe.sql`, one table) → `SELECT`.
    - DT3 `anon` and `service_role` hold nothing, table- or column-level (ST4/ST5's expressions) → `0/0`.
    - DT4 exactly one policy, a SELECT: → `invoice_deliveries=r`.
    - DT5 every FK column is the leading column of an index: `select string_agg(a.attname, ',' order by a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.conrelid = 'public.invoice_deliveries'::regclass and c.contype = 'f' and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])` → `<null>`.
    - DT6 the self-delivery check: copy `ist.violated` into the header as `idl.violated`, then `select idl.val('DT6 a workspace cannot deliver to itself', format($$select idl.violated(%L)$$, format('insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id) values (%L, %L, %L)', :'inv_i', :'org_s', :'org_s')), 'violates invoice_deliveries_not_to_self')`.
    - DT7 positive control: the same insert to `org_r` → `written`.
    - DT8 the live unique index: insert a second live row for (`inv_i`, `org_r`) after a first → `unique invoice_deliveries_live_unique`; DT9 control: a second row with `withdrawn_at = now()` set on the first → `written`.
  - **§ DR** (plant one delivery `del_sr` of `inv_i` S→R as postgres, `delivered_by fin_s`): one string per persona, `select count(*)::text from public.invoice_deliveries where id = :'del_sr'`:
    - DR1 `fin_s` → `1`; DR2 `ro_s` → `1` if `read_only` holds `view_finance`, else `0` (check with `select public.has_permission(:'org_s','view_finance')` as `ro_s` first and write the expected value the check gives; record which in the ledger).
    - DR3 `fin_r` (the receiver) → `0`. **The receiver never reads the base table.**
    - DR4 `fin_t` → `0`; DR5 `own_r` → `0`.
  - **§ DB:** as `fin_s`, INSERT, UPDATE (`withdrawn_at = now()`) and DELETE on `invoice_deliveries` each → `denied(42501…)` (use whatever `denied(…)` string the first run prints, and check it is 42501). DB4 control: the same UPDATE as postgres → `1` row. Then, as postgres, **delete `del_sr`**, so Task 2's first delivery is a real one and not the idempotent repeat.
  - **§ DK:**
    - DK1 `private.unclassified_retention_subjects()` is empty → `<null>` (`select string_agg(…)`).
    - DK2 `select treatment from private.retention_subjects() where table_name = 'invoice_deliveries'` → `cascades`.
    - DK3 the three audit actions are in `private.platform_audit_actions()` → `3`.
    - DK4 the export catalogue: `select string_agg(export_kind || ':' || disposition || ':' || coalesce(array_to_string(scope_columns, '/'), '-'), ',' order by export_kind) from private.export_catalogue() where table_name = 'invoice_deliveries'` → `account:excused:-,workspace:exported:from_organisation_id`.
    - DK5 `private.export_catalogue_is_sound()` → `sound`.
    - DK6 the budget: `select max_requests || '/' || window_seconds || '/' || subject_scope from public.rate_limit_policies where category = 'invoice_delivery'` → `30/3600/user`.
    - DK7 the trigger is there: `select tgname from pg_trigger where tgrelid = 'public.invoice_deliveries'::regclass and not tgisinternal` → `meter_invoice_delivery`.
  - **§ DZ housekeeping:** delete, in FK order, every fixture row (deliveries, requests, links, profiles, invoice lines, invoices with the freeze trigger disabled for that one statement exactly as `rls_invoices_stripe.sql` § SZ does, settings, Stripe row, companies, contacts, memberships, subscriptions, organisations, users).

  Add to `run-rls-tests.sh`, after the `INVOICES STRIPE` block, a block in the same shape:

  ```bash
  # ============================================================================
  # INVOICES, PART 3 OF 3 -- NETWORK DELIVERY (20261117000000 onwards; Q282).
  # The two-tenant invoice_deliveries table, the deliver / withdraw RPCs and the
  # page's state read, the received_invoices definer view (the receiver's ONLY
  # read path), the received PDF audit and the delivery notice. Self-contained
  # and re-runnable. Pin: grep -c '^select idl.val(' supabase/tests/rls_invoice_deliveries.sql
  # ============================================================================
  run_suite "INVOICE DELIVERIES" rls_invoice_deliveries.sql idl -
  idl_fails=$SUITE_FAILS
  if [ "$idl_fails" != "0" ]; then
    echo "INVOICE DELIVERIES SUITE FAILED: $idl_fails failing assertion(s)" >&2
    echo "  DR/DV red: A DELIVERED INVOICE IS READABLE OUTSIDE THE TWO WORKSPACES, or" >&2
    echo "  the receiver reads the base tables. DD red: an ineligible delivery got through." >&2
    echo "  DV pin red: the view gained a column or a dependency -- review it as a leak." >&2
    psql_status=1
  fi
  ```

  With `-`, the runner prints the measured count, which becomes the pin in Step 6.

  Run: `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh`. Expected: the new suite fails at DT1 (`relation "public.invoice_deliveries" does not exist`).

- [ ] **Step 2: Write the migration: the table, RLS, grants.**

```sql
-- ===========================================================================
-- INVOICES PART 3 -- TASK 1: invoice_deliveries, ITS BUDGET, AND THE
-- CATALOGUES (spec docs/superpowers/specs/2026-11-13-invoices-network-delivery-design.md).
-- TWO-TENANT, like network_connection_requests: the sender's invoice, the
-- receiver's inbox entry. No client role writes it (Task 2's two RPCs do),
-- and only the SENDER reads it; the receiver reads public.received_invoices
-- (Task 3). It stores no link id and no profile id (Q82): which private
-- record the sender linked is not the receiver's to learn.
-- ===========================================================================

create table public.invoice_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  invoice_id           uuid not null,
  from_organisation_id uuid not null,
  to_organisation_id   uuid not null references public.organisations (id) on delete cascade,
  delivered_by         uuid references auth.users (id) on delete set null,
  delivered_at         timestamptz not null default pg_catalog.now(),
  withdrawn_at         timestamptz,
  withdrawn_by         uuid references auth.users (id) on delete set null,
  constraint invoice_deliveries_invoice_fkey
    foreign key (invoice_id, from_organisation_id) references public.invoices (id, organisation_id) on delete cascade,
  constraint invoice_deliveries_not_to_self check (from_organisation_id <> to_organisation_id),
  constraint invoice_deliveries_withdrawn_pair check (withdrawn_by is null or withdrawn_at is not null)
);

create unique index invoice_deliveries_live_unique
  on public.invoice_deliveries (invoice_id, to_organisation_id) where withdrawn_at is null;
create index invoice_deliveries_from_org_idx  on public.invoice_deliveries (from_organisation_id);
create index invoice_deliveries_to_org_list_idx
  on public.invoice_deliveries (to_organisation_id, delivered_at, id) where withdrawn_at is null;
create index invoice_deliveries_delivered_by_idx on public.invoice_deliveries (delivered_by);
create index invoice_deliveries_withdrawn_by_idx on public.invoice_deliveries (withdrawn_by);

alter table public.invoice_deliveries enable row level security;
-- The SENDER's side only. The receiver never reads this table.
create policy invoice_deliveries_select on public.invoice_deliveries for select to authenticated
  using (from_organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_deliveries from public, anon, authenticated, service_role;
grant select on public.invoice_deliveries to authenticated;

comment on table public.invoice_deliveries is
  'Invoices part 3: one row per delivery of an issued or paid invoice into a connected workspace''s inbox. Two-tenant (from_organisation_id is the sender, to_organisation_id the receiver), like network_connection_requests. Written only by public.deliver_invoice and public.withdraw_invoice_delivery; read by the sender''s view_finance holders; the receiver reads public.received_invoices and never this table. Holds no link id and no network profile id (Q82).';
```

  The `invoice_id` FK is composite and leads with `invoice_id`, so the index on `(invoice_id, to_organisation_id)` serves it; DT5 checks the leading column only, so it passes. If DT5 names `invoice_id`, the partial index is not enough for the planner check; add `create index invoice_deliveries_invoice_idx on public.invoice_deliveries (invoice_id);`.

- [ ] **Step 3: Same migration, the budget and its trigger.** Copy `private.meter_connection_request()` (`20260909060000`, lines 113–223) as `private.meter_invoice_delivery()`, with only these changes:
  - the category is `'invoice_delivery'` everywhere, and the error messages say `invoice_deliveries: you have reached your invoice-delivery limit (% per % seconds)`;
  - the subject is the **user**: `subject_scope = 'user'`, `subject_id = (select auth.uid())`, and the call is `private.record_rate_limit_event('invoice_delivery', 'user', (select auth.uid()), new.from_organisation_id)`;
  - the "meter after authorisation" guard becomes `if new.from_organisation_id not in (select private.permitted_organisations('manage_finance')) then return new; end if;`;
  - the alert's `subject_scope`/`subject_id` follow.

  Then:

```sql
insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('invoice_delivery', 'user', 30, 3600,
        'Invoices delivered into another workspace per user (Invoices part 3, Q282). Enforced at the write by private.meter_invoice_delivery(), modelled on the connection-request meter.');

create trigger meter_invoice_delivery
  before insert on public.invoice_deliveries
  for each row execute function private.meter_invoice_delivery();

revoke all on function private.meter_invoice_delivery() from public, anon, authenticated, service_role;
```

- [ ] **Step 4: Same migration, the catalogues.** Each is rebuilt from its live `pg_get_functiondef`, diffed identical to the named migration first, with only these rows added:
  1. `private.platform_audit_actions()` (latest: `20261110001000_stripe_link_rpcs.sql`). After `('invoice_stripe_account.charges_enabled_changed')` add:
     ```sql
         -- Invoices part 3 (20261117000000; written by Tasks 2 and 3).
         ('invoice.delivered'),
         ('invoice.delivery_withdrawn'),
         ('invoice.received_pdf_downloaded')
     ```
     Mirror them in `lib/admin/audit-actions.ts` after `"invoice_stripe_account.charges_enabled_changed",`:
     ```ts
       // Invoices part 3 (20261117000000). Delivery into a connected workspace.
       // delivered / delivery_withdrawn are the sender's (target: the delivery);
       // received_pdf_downloaded is the RECEIVER's, written in its own workspace.
       "invoice.delivered",
       "invoice.delivery_withdrawn",
       "invoice.received_pdf_downloaded",
     ```
  2. `private.retention_subjects()` (latest: `20261110000000_stripe_tables.sql`). After the `stripe_link_states` row add:
     ```sql
         ('invoice_deliveries', 'cascades', null, 'Composite FK to public.invoices, ON DELETE CASCADE: a delivery lives as long as the sender''s invoice (spec default 1: the receiver reads the sender''s snapshot, nothing is copied).'),
     ```
  3. `private.export_catalogue()` (latest: `20261110000000_stripe_tables.sql`). Add, beside the Stripe rows:
     ```sql
       ('workspace', 'invoice_deliveries', 'exported', null, 'requester_rls', array['from_organisation_id'], 'id', null),
       ('account',   'invoice_deliveries', 'excused', 'Workspace record; the account appears only as delivered_by / withdrawn_by. In the SENDER''s workspace export (spec default 2).', null, null, null, null),
     ```

- [ ] **Step 5: Run the suite, then the censuses.** Expected: § DT, § DR, § DB and § DK pass. Then fix each census exactly as its failure message asks:
  - `rls_phase7_rate_limits.sql`: the policy count `'14'` at lines 224 and 256 (and the comment above 224) becomes `'15'`, naming `invoice_delivery`. Move that suite's pin if you add an assertion; changing an expected value moves nothing.
  - `network_leakage_phase6.sql` IN10: add `'invoice_deliveries'` to both `relname in (...)` lists, widen the regex to `public\.(invoice(s|_lines|_sends|_settings|_stripe_accounts|_card_payments|_pay_sessions|_deliveries)|stripe_events|stripe_platform_settings)`, and the denominator `'0/0/9'` becomes `'0/0/10'`.
  - `rls_phase8_closure_backup.sql`: seed one `invoice_deliveries` row in `ck.seed` (an existing issued invoice of the closing workspace delivered to another fixture workspace; read how `invoice_card_payments` is seeded there and copy it), raise KS1's count by one, and add the housekeeping delete.
  - `pnpm exec vitest run tests/integration/export/completeness-census.test.ts`: add `"invoice_deliveries"` to the workspace exported roll and the account excused roll, in alphabetical position. Add it to the "reaches an organisation through a column that is NOT called organisation_id" list beside `network_connection_requests`.
  - `pnpm exec vitest run tests/integration/security/phase7-permission-matrix.test.ts`: add `"invoice_deliveries"` to `PRE_PHASE7_RELATIONS` beside `invoice_card_payments`, with the comment `// Invoices part 3: the sender reads it; proved in rls_invoice_deliveries.sql § DR/§ DB.` In `support/privilege-census.ts` add `"invoice_deliveries|authenticated|SELECT|*",` beside `invoice_card_payments`. Follow any further message (`ORG_SCOPED_TABLES`, `MEMBER_READABLE`) the way `invoice_card_payments` is declared there.

- [ ] **Step 6: Mutants, pin, gates, commit.**
  - Mutant 1: recreate the policy `using (true)`. DR3 goes red. Revert.
  - Mutant 2: `grant insert on public.invoice_deliveries to authenticated`. DT2 and DB1 go red. Revert.
  - Set the pin to `grep -c '^select idl.val(' supabase/tests/rls_invoice_deliveries.sql`. Full reset, then `bash supabase/tests/run-rls-tests.sh` must report "All suites passed".
  - `pnpm typecheck`, `pnpm exec vitest run tests/unit`, `pnpm exec vitest run tests/integration` (stack: check for other sessions first).
  - Commit "Add invoice_deliveries, its budget and its catalogue rows", plus the trailer, and push.

---

### Task 2: Deliver, withdraw, and the sender page's state read

**Files:**
- Create: `supabase/migrations/20261117001000_invoice_delivery_rpcs.sql`
- Modify: `supabase/tests/rls_invoice_deliveries.sql`, `supabase/tests/run-rls-tests.sh` (pin), `tests/integration/security/phase7-permission-matrix.test.ts`

**Interfaces:**
- Consumes: Task 1's table and trigger.
- Produces (SQL):
  - `private.invoice_delivery_target(p_invoice_id uuid, p_profile_id uuid) returns uuid` (the receiving organisation, or null; no grants)
  - `public.deliver_invoice(p_invoice_id uuid, p_network_profile_id uuid) returns uuid` (the delivery id; authenticated)
  - `public.withdraw_invoice_delivery(p_delivery_id uuid) returns void` (authenticated)
  - `public.invoice_delivery_state(p_invoice_id uuid) returns table (network_profile_id uuid, display_name text, delivery_id uuid, delivered_at timestamptz, can_deliver boolean)` (authenticated)
  - refusal hint `invoice_delivery_refused` (42501)

- [ ] **Step 1: Write the failing psql sections, above § DZ.**
  - **§ DD deliver** (as `fin_s` unless stated; `denied(42501:invoice_delivery_refused)` is written `REF` below, spell it out in the file):
    - DD0 who may EXECUTE the four, and all are definers with an empty `search_path` (copy SL0's expression from `rls_invoices_stripe.sql`, names `deliver_invoice`, `withdraw_invoice_delivery`, `invoice_delivery_state`) → `deliver_invoice=authenticated,invoice_delivery_state=authenticated,withdraw_invoice_delivery=authenticated`. DD0b `private.invoice_delivery_target` is executable by none of the three roles → `0`.
    - DD1 **positive:** `select (public.deliver_invoice(:'inv_i', :'prof_r') is not null)::text` → `true`. Capture the id: `select id as del_ir from public.invoice_deliveries where invoice_id = :'inv_i' and withdrawn_at is null \gset` (as postgres).
    - DD2 the repeat is a no-op returning the same id: `select (public.deliver_invoice(:'inv_i', :'prof_r') = :'del_ir')::text` → `true`; DD3 still one live row and one `invoice.delivered` audit row for it → `1/1`.
    - DD4 the audit row is name-only: `select after::text from public.audit_events where action = 'invoice.delivered' and target_id = :'del_ir'` → `{"number": "IDL-0001"}`.
    - Rule 1: DD5 as `ro_s` → REF. DD6 as `fin_t` (another workspace) → REF.
    - Rule 2: DD7 as `fin_x` delivering `inv_x` to `prof_r` (Starter sender, otherwise eligible) → REF. DD7c **control:** as postgres move `org_x` to `pro`, retry as `fin_x` → `true`; move it back.
    - Rule 2, read-only: DD8 as postgres set `org_s.deleted_at = now()` (and `lifecycle_state` to match the CHECK; read `organisation_lifecycle` for the pair), retry DD1's call with `inv_p` → REF; restore.
    - Rule 3: DD9 `inv_d` (draft) → REF. DD10 `inv_v` (void) → REF. DD11 **control** `inv_p` (paid) → `true`.
    - Rule 4: DD12 `inv_c` (to a contact) → REF. DD13 `inv_i` to `prof_t` (published, in a workspace, but S has **no** link to it) → REF. DD14 the link soft-deleted: as postgres delete DD11's delivery and set `deleted_at` on the `com_s`→`prof_r` link; deliver `inv_p` → REF; restore the link; DD14c control → `true`; as postgres delete that delivery again.
    - Rule 5: DD15 `prof_rd` (draft profile, linked, connected org) → REF. DD16 receiver read-only: as postgres set `org_r.deleted_at`, try → REF; restore.
    - Rule 6: DD17 `prof_u` (linked, live, not connected) → REF. DD17c **control:** as postgres plant an accepted S↔U request, retry → `true`; delete the request and the delivery.
    - DD18 a connection request that is only `pending` does not count: plant S→U `pending`, try → REF; delete it.
    - DD19 no session: `reset request.jwt.claims; set role authenticated;` then call → `denied(28000:not_authenticated)`.
  - **§ DW withdraw:**
    - DW1 as `ro_s` → REF. DW2 as `fin_r` (the receiver) → REF. DW3 as `fin_t` → REF.
    - DW4 **positive** as `fin_s`: `select 'ok' from (select public.withdraw_invoice_delivery(:'del_ir')) s` → `ok` (the idiom `rls_invoices.sql` § IP uses for a `void` RPC); DW5 the row now has `withdrawn_at` and `withdrawn_by = fin_s`, and one `invoice.delivery_withdrawn` audit row → `true/true/1`.
    - DW6 withdrawing again → REF (no live row).
    - DW7 the invoice can be delivered again → `true`, and DW8 a new id ≠ `del_ir` → `true`. Capture it as `del_ir2`.
    - DW9 a **Starter** sender can still withdraw (no tier gate): DD7c left a live delivery of `inv_x` X→R and moved `org_x` back to `starter`; capture its id as postgres, then as `fin_x` withdraw it → `ok`.
  - **§ DS state** (as `fin_s`, after DW7, so `inv_i` has one live delivery to R; first, as postgres, delete every live delivery of `inv_p`):
    - DS1 `select string_agg(coalesce(display_name,'-') || ':' || (delivery_id is not null) || ':' || can_deliver, ',' order by display_name) from public.invoice_delivery_state(:'inv_i')` → `IDL R:true:false`. (U is linked but not connected, so it is absent; the draft profile is absent.)
    - DS2 `inv_p` with no live delivery → `IDL R:false:true`.
    - DS3 `inv_c` (a contact) → `<null>` (no rows).
    - DS4 as `fin_t` on `inv_i` → `<null>` (no `view_finance` in S: empty, not an error).
    - DS5 as `ro_s`: whatever DR2 established `view_finance` to be, rows if it holds it, `<null>` otherwise.
    - DS6 a live delivery whose link was removed afterwards still shows, without a name: soft-delete the `com_s`→`prof_r` link as postgres, then DS1's query → `-:true:false`. Restore the link.
  - **§ DL budget** (the spec's "the 31st delivery in an hour is refused"): as postgres insert ONE row into `rate_limit_counters` for (`category 'invoice_delivery'`, `subject_scope 'user'`, `subject_id fin_s`, `window_start = private.rate_limit_window_start(now(), 3600)`) with `request_count = 30`, i.e. 30 already spent. Then DL1, as `fin_s`: `select idl.val('DL1 the 31st delivery in the hour is refused with 429', format($$select (x like 'denied(PT429:%%')::text from (select idl.try_text(format('select public.deliver_invoice(%%L, %%L)::text', %L, %L)) x) s$$, :'inv_p', :'prof_r'), 'true')`, where `idl.try_text(sql)` is a header helper returning the result or `denied(<sqlstate>:<hint>)` exactly as `idl.val` computes `v_actual` (factor that block out of `idl.val` into `idl.try_text` and call it from both). DL2 **control:** as postgres delete that counter row; as `fin_s` deliver `inv_p` → `true` (`select (public.deliver_invoice(…) is not null)::text`).

  Run: expected failure at DD0 (`function public.deliver_invoice does not exist`).

- [ ] **Step 2: Write the migration.**

```sql
-- ===========================================================================
-- INVOICES PART 3 -- TASK 2: DELIVER, WITHDRAW, AND THE PAGE'S STATE READ.
-- ONE eligibility predicate (plan decision 5), called by the write and by the
-- read the sender's invoice page makes. EVERY refusal is one error (plan
-- decision 6): 42501 / invoice_delivery_refused.
-- ===========================================================================

-- Rules 2 to 6 of the spec, for the CALLER: the invoice's workspace is Pro and
-- not read-only (private.finance_module_organisations() is both), the invoice
-- is issued or paid and to a company, the caller's workspace has a live link
-- from that company to p_profile_id, the profile is published, live and in
-- another workspace that is not read-only, and the two workspaces have an
-- accepted connection either way round. Returns that workspace, or null.
-- Rule 1 (manage_finance) is the caller's to check. Not a definer: it runs
-- with the privileges of the definer that calls it. No grants.
create function private.invoice_delivery_target(p_invoice_id uuid, p_profile_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select p.organisation_id
    from public.invoices i
    join public.network_links l
      on l.organisation_id     = i.organisation_id
     and l.private_entity_type = 'company'
     and l.private_entity_id   = i.recipient_company_id
     and l.network_profile_id  = p_profile_id
     and l.deleted_at is null
    join public.network_profiles p
      on p.id = l.network_profile_id
     and p.status = 'published'
     and p.deleted_at is null
     and p.organisation_id <> i.organisation_id
    join public.organisations o
      on o.id = p.organisation_id
     and o.deleted_at is null
   where i.id = p_invoice_id
     and i.status in ('issued', 'paid')
     and i.recipient_company_id is not null
     and i.organisation_id in (select private.finance_module_organisations())
     and exists (
       select 1 from public.network_connection_requests r
        where r.status = 'accepted'
          and (   (r.from_organisation_id = i.organisation_id and r.to_organisation_id   = p.organisation_id)
               or (r.to_organisation_id   = i.organisation_id and r.from_organisation_id = p.organisation_id)))
   limit 1;
$$;
comment on function private.invoice_delivery_target(uuid, uuid) is
  'Invoices part 3: the workspace p_profile_id belongs to, when the CALLER''s invoice may be delivered there (spec rules 2-6), else null. The one eligibility predicate: public.deliver_invoice and public.invoice_delivery_state both call it. Rule 1 (manage_finance) is the caller''s.';
revoke all on function private.invoice_delivery_target(uuid, uuid) from public, anon, authenticated, service_role;

create function public.deliver_invoice(p_invoice_id uuid, p_network_profile_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_org    uuid;
  v_number text;
  v_to     uuid;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'deliver_invoice: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select i.organisation_id, i.number into v_org, v_number
    from public.invoices i where i.id = p_invoice_id for update;
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'deliver_invoice: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  v_to := private.invoice_delivery_target(p_invoice_id, p_network_profile_id);
  if v_to is null then
    raise exception 'deliver_invoice: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  -- Idempotent: the same invoice to the same workspace is the live row already there.
  select d.id into v_id from public.invoice_deliveries d
   where d.invoice_id = p_invoice_id and d.to_organisation_id = v_to and d.withdrawn_at is null;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by)
  values (p_invoice_id, v_org, v_to, v_uid)
  returning id into v_id;
  perform private.log_audit_event(
    p_action          => 'invoice.delivered',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number));
  return v_id;
end;
$$;
comment on function public.deliver_invoice(uuid, uuid) is
  'Invoices part 3: delivers the caller''s issued or paid invoice into the connected workspace that owns p_network_profile_id (manage_finance, then private.invoice_delivery_target). Every refusal is 42501 invoice_delivery_refused. A repeat returns the live delivery. Audits invoice.delivered (target the delivery, payload the number). Budget: private.meter_invoice_delivery, 30/h/user.';
revoke all on function public.deliver_invoice(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.deliver_invoice(uuid, uuid) to authenticated;

create function public.withdraw_invoice_delivery(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'withdraw_invoice_delivery: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select d.from_organisation_id into v_org from public.invoice_deliveries d
   where d.id = p_delivery_id and d.withdrawn_at is null for update;
  -- No tier gate: a downgraded workspace can still pull back what it sent.
  -- has_permission refuses a read-only workspace (manage_finance does not survive suspension).
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'withdraw_invoice_delivery: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  update public.invoice_deliveries d
     set withdrawn_at = pg_catalog.now(), withdrawn_by = v_uid
   where d.id = p_delivery_id;
  perform private.log_audit_event(
    p_action          => 'invoice.delivery_withdrawn',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => p_delivery_id,
    p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('withdrawn_at')));
end;
$$;
comment on function public.withdraw_invoice_delivery(uuid) is
  'Invoices part 3: the sender pulls back a live delivery (manage_finance, not read-only, no tier gate). Stamps withdrawn_at/by; the receiver''s view drops it at once. Audits invoice.delivery_withdrawn. The invoice may then be delivered again.';
revoke all on function public.withdraw_invoice_delivery(uuid) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_invoice_delivery(uuid) to authenticated;

-- The sender's invoice page reads this and nothing else of the network: one
-- row per live delivery (named by a linked live profile of that workspace if
-- one still exists) and one per eligible profile not yet delivered to. Empty
-- for a caller without view_finance in the invoice's workspace.
create function public.invoice_delivery_state(p_invoice_id uuid)
returns table (network_profile_id uuid, display_name text, delivery_id uuid, delivered_at timestamptz, can_deliver boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.id, i.organisation_id, i.recipient_company_id
      from public.invoices i
     where i.id = p_invoice_id
       and i.organisation_id in (select private.permitted_organisations('view_finance'))
  ),
  candidates as (
    select p.id as profile_id, p.display_name, p.organisation_id as to_org,
           private.invoice_delivery_target(inv.id, p.id) as target
      from inv
      join public.network_links l
        on l.organisation_id = inv.organisation_id
       and l.private_entity_type = 'company'
       and l.private_entity_id = inv.recipient_company_id
       and l.deleted_at is null
      join public.network_profiles p
        on p.id = l.network_profile_id and p.status = 'published' and p.deleted_at is null
  ),
  live as (
    select d.id, d.to_organisation_id, d.delivered_at
      from inv join public.invoice_deliveries d on d.invoice_id = inv.id
     where d.withdrawn_at is null
  )
  select (select c.profile_id   from candidates c where c.to_org = lv.to_organisation_id order by c.display_name limit 1),
         (select c.display_name from candidates c where c.to_org = lv.to_organisation_id order by c.display_name limit 1),
         lv.id, lv.delivered_at, false
    from live lv
  union all
  select c.profile_id, c.display_name, null, null, true
    from candidates c
   where c.target is not null
     and not exists (select 1 from live lv where lv.to_organisation_id = c.target);
$$;
comment on function public.invoice_delivery_state(uuid) is
  'Invoices part 3: what the sender''s invoice page shows -- each live delivery (with the display name of a linked, live profile of that workspace, or null) and each profile the invoice may be delivered to now (can_deliver, from private.invoice_delivery_target). Empty without view_finance in the invoice''s workspace. Exposes only display_name, which is always visible on a published profile (Q71).';
revoke all on function public.invoice_delivery_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.invoice_delivery_state(uuid) to authenticated;
```

  `candidates` exposes only profiles the caller's own workspace linked, and their `display_name`, which is always visible on a published profile (Q71). It never says whether an unconnected profile exists beyond what the caller's own link already says.

- [ ] **Step 3: Run the suite.** Expected: § DD, § DW, § DS and § DL pass. Then run `pnpm exec vitest run tests/integration/security/phase7-permission-matrix.test.ts` and declare the three RPCs in `MEMBER_REACHABLE_RPCS`, after `record_invoice_send`:

```ts
  deliver_invoice:
    "Invoices part 3 Task 2 -- delivers an issued or paid invoice into a connected " +
    "workspace: manage_finance, then private.invoice_delivery_target (Pro, a live " +
    "manual link, a live published foreign profile, an accepted connection). Every " +
    "refusal is one error. Budget 30/h/user at the insert. Asserted in " +
    "rls_invoice_deliveries.sql § DD/§ DL.",
  withdraw_invoice_delivery:
    "Invoices part 3 Task 2 -- the sender pulls back a live delivery; manage_finance, " +
    "no tier gate. Asserted in rls_invoice_deliveries.sql § DW.",
  invoice_delivery_state:
    "Invoices part 3 Task 2 -- the sender's invoice page: live deliveries and the " +
    "profiles it may deliver to now, display names only; empty without view_finance. " +
    "Asserted in rls_invoice_deliveries.sql § DS.",
```

- [ ] **Step 4: Mutants.**
  - Drop the `exists (… accepted …)` term from `private.invoice_delivery_target`. DD17 goes red. Revert.
  - Replace `private.finance_module_organisations()` with `private.permitted_organisations('view_finance')`. DD7 goes red. Revert.
  - Remove the `has_permission(v_org, 'manage_finance')` term from `withdraw_invoice_delivery`. DW2 goes red: the receiver's `fin_r` withdraws the sender's delivery. Revert.

- [ ] **Step 5: Pin, gates, commit.** Re-measure the pin. Full reset and run. `pnpm typecheck`, unit, integration. Commit "Deliver, withdraw and the delivery state RPCs", plus the trailer, and push.

---

### Task 3: The receiver's read path: the view and the received PDF audit

**Files:**
- Create: `supabase/migrations/20261117002000_received_invoices_view.sql`
- Modify: `supabase/tests/rls_invoice_deliveries.sql`, `supabase/tests/run-rls-tests.sh` (pin), `tests/integration/security/phase7-permission-matrix.test.ts`, `tests/integration/security/support/privilege-census.ts`

**Interfaces:**
- Consumes: Task 1's table, Task 2's `del_ir2` fixture.
- Produces (SQL):
  - `public.received_invoices(id uuid, organisation_id uuid, delivered_at timestamptz, invoice_id uuid, sender_name text, number text, status text, issue_date date, due_date date, currency text, net_minor bigint, vat_minor bigint, gross_minor bigint, paid_on date, snapshot jsonb, card_payment_enabled boolean)`, SELECT to `authenticated`
  - `public.audit_received_invoice_download(p_delivery_id uuid) returns void` (authenticated)

- [ ] **Step 1: Write the failing psql sections, above § DZ.** The fixture state is Task 2's: `inv_i` delivered S→R (`del_ir2`). As postgres also deliver `inv_v` S→R (`del_vr`, planted directly) so the void case is visible.
  - **§ DV the view:**
    - DV1 it exists, is a view, `security_invoker` is off and `security_barrier` on: `select (relkind = 'v')::text || '/' || (coalesce(reloptions::text,'') like '%security_barrier=true%')::text || '/' || (coalesce(reloptions::text,'') like '%security_invoker=true%')::text from pg_class where oid = 'public.received_invoices'::regclass` → `true/true/false`.
    - DV2 **the column list is pinned:** `select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'public.received_invoices'::regclass and attnum > 0` → `id,organisation_id,delivered_at,invoice_id,sender_name,number,status,issue_date,due_date,currency,net_minor,vat_minor,gross_minor,paid_on,snapshot,card_payment_enabled`.
    - DV3 **the relation dependencies are pinned** (`pg_depend` through the view's rewrite rule; copy `rls_phase6_network.sql`'s `nw.view_deps` definition into `idl.view_deps`): → `public.invoice_deliveries,public.invoice_stripe_accounts,public.invoices (3)`.
    - DV4 **the function dependencies are pinned:** the same walk with `refclassid = 'pg_catalog.pg_proc'::regclass` → `private.permitted_organisations,private.request_is_from_server`.
    - DV5 grants: `authenticated` SELECT only; `anon` and `service_role` nothing → `SELECT/0/0` (expression as DT2/DT3 against the view).
    - Personas, one string each, `select count(*) filter (where id = :'del_ir2') || '/' || count(*) filter (where id = :'del_vr') from public.received_invoices`:
      - DV6 `fin_r` (receiver Finance, **Starter**) → `1/1`. **The positive control for every refusal below.**
      - DV7 `own_r` → `1/1`.
      - DV8 `bk_r` (no `view_finance`) → `0/0`.
      - DV9 `fin_t` (third workspace) → `0/0`.
      - DV10 `fin_s` (the sender) → `0/0`: the sender reads its own base table, not the inbox.
      - DV11 `fin_r` with the server mark off: `set getsetpaid.from_server = off;` then the query → `0/0`; `set getsetpaid.from_server = on;`.
    - DV12 the row is the receiver's and carries the sender's name: as `fin_r`, `select (organisation_id = :'org_r')::text || '/' || sender_name || '/' || status from public.received_invoices where id = :'del_ir2'` → `true/IDL Sender Ltd/issued`.
    - DV13 the void one stays with status `void` → `void`.
    - DV14 `card_payment_enabled`: `del_ir2` → `true` (issued, live charges-enabled account); `del_vr` → `false`. One string: `true/false`.
    - DV15 a withdrawn delivery leaves the view: as `fin_s` withdraw `del_vr`, then as `fin_r` `select count(*)::text from public.received_invoices where id = :'del_vr'` → `0`.
    - DV16 **the receiver reads no sender table:** as `fin_r`, one string of counts for `inv_i` from `invoices`, `invoice_lines`, `invoice_sends`, `invoice_deliveries`, `invoice_stripe_accounts`, `invoice_card_payments` → `0/0/0/0/0/0`. DV16c control as `fin_s`: `invoices` and `invoice_deliveries` for `inv_i` → `1/1`.
    - DV17 receiver suspended: as postgres set `org_r` read-only, as `fin_r` count → `0` (`view_finance` does not survive suspension); restore; DV17c control → `1`.
  - **§ DP the received PDF audit:**
    - DP1 as `fin_r`: `select 'ok' from (select public.audit_received_invoice_download(:'del_ir2')) s` → `ok`; DP2 the audit row is in R, target the delivery, payload `{number, status}`: `select (organisation_id = :'org_r')::text || '/' || after::text from public.audit_events where action = 'invoice.received_pdf_downloaded' and target_id = :'del_ir2'` → `true/{"number": "IDL-0001", "status": "issued"}`.
    - DP3 as `bk_r` → `denied(42501:forbidden)`. DP4 as `fin_t` → same. DP5 as `fin_s` (the sender) → same. DP6 a withdrawn delivery (`del_vr`) as `fin_r` → same.

  Run: expected failure at DV1 (`relation "public.received_invoices" does not exist`).

- [ ] **Step 2: Write the migration.**

```sql
-- ===========================================================================
-- INVOICES PART 3 -- TASK 3: THE RECEIVER'S ONLY READ PATH.
-- A definer view like public.network_directory: its WHERE is the row gate
-- (a live delivery to a workspace where the caller holds view_finance, and
-- the server request mark), its column list is the column gate, and both are
-- pinned in rls_invoice_deliveries.sql § DV. Never join a private table into
-- it. `id` and `organisation_id` are the delivery id and the RECEIVING
-- workspace (plan decision 1), so lib/list/query.ts's tenant clause applies
-- unchanged.
-- ===========================================================================

create view public.received_invoices
  with (security_invoker = false, security_barrier = true) as
select
  d.id,
  d.to_organisation_id                    as organisation_id,
  d.delivered_at,
  i.id                                    as invoice_id,
  i.snapshot -> 'seller' ->> 'name'       as sender_name,
  i.number,
  i.status,
  i.issue_date,
  i.due_date,
  i.currency,
  i.net_minor,
  i.vat_minor,
  i.gross_minor,
  i.paid_on,
  i.snapshot,
  (i.status = 'issued' and exists (
     select 1 from public.invoice_stripe_accounts a
      where a.organisation_id = i.organisation_id
        and a.ended_at is null
        and a.charges_enabled))           as card_payment_enabled
from public.invoice_deliveries d
join public.invoices i
  on i.id = d.invoice_id
 and i.organisation_id = d.from_organisation_id
where d.withdrawn_at is null
  and d.to_organisation_id in (select private.permitted_organisations('view_finance'))
  and private.request_is_from_server();

comment on view public.received_invoices is
  'Invoices part 3: THE ONLY RECEIVER READ PATH. One row per live delivery into a workspace where the caller holds view_finance (any tier), only on a server-marked request. Definer view (security_invoker off, security_barrier on), like public.network_directory. Columns pinned in rls_invoice_deliveries.sql § DV2: never event_id, notes outside the snapshot, recipient ids, paid_entry_id, void_reason, actor columns, invoice_sends, invoice_lines.financial_entry_id or any Stripe identifier. Dependencies pinned from pg_depend (DV3/DV4). id is the delivery, organisation_id the receiving workspace.';

revoke all on public.received_invoices from public, anon, authenticated, service_role;
grant select on public.received_invoices to authenticated;

create function public.audit_received_invoice_download(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_org    uuid;
  v_status text;
  v_number text;
begin
  if v_uid is null then
    raise exception 'audit_received_invoice_download: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select d.to_organisation_id, i.status, i.number into v_org, v_status, v_number
    from public.invoice_deliveries d
    join public.invoices i on i.id = d.invoice_id and i.organisation_id = d.from_organisation_id
   where d.id = p_delivery_id and d.withdrawn_at is null;
  if v_org is null or not public.has_permission(v_org, 'view_finance') then
    raise exception 'audit_received_invoice_download: the caller may not read this invoice'
      using errcode = '42501', hint = 'forbidden';
  end if;
  perform private.log_audit_event(
    p_action          => 'invoice.received_pdf_downloaded',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => p_delivery_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number, 'status', v_status));
end;
$$;
comment on function public.audit_received_invoice_download(uuid) is
  'Invoices part 3: writes invoice.received_pdf_downloaded in the RECEIVING workspace for a live delivery the caller may read (view_finance there, any tier). Called by the received PDF route before it renders (plan decision 7).';
revoke all on function public.audit_received_invoice_download(uuid) from public, anon, authenticated, service_role;
grant execute on function public.audit_received_invoice_download(uuid) to authenticated;
```

- [ ] **Step 3: Run the suite, then the censuses.** Expected: § DV and § DP pass. Then:
  - `phase7-permission-matrix.test.ts`: add `"received_invoices"` to `PRE_PHASE7_RELATIONS` beside `network_connected_profiles` (`// Invoices part 3: the receiver's definer view; rls_invoice_deliveries.sql § DV.`), and declare `audit_received_invoice_download` in `MEMBER_REACHABLE_RPCS` after `audit_invoice_download`, in its words ("…the received PDF route calls it before rendering; view_finance in the receiving workspace, any tier; refuses a withdrawn delivery and everything outside it. Asserted in rls_invoice_deliveries.sql § DP.").
  - `privilege-census.ts`: `"received_invoices|authenticated|SELECT|*",` beside `network_connected_profiles`.

- [ ] **Step 4: Mutants.**
  - Add `i.event_id` to the view's select list. DV2 goes red. Revert.
  - Replace `permitted_organisations('view_finance')` with `permitted_organisations('view_crm')`. DV8 goes red (the booker reads it). Revert.
  - Drop `and private.request_is_from_server()`. DV11 goes red. Revert.
  - Join `public.invoice_lines` into the view (`left join public.invoice_lines l on false`). DV3 goes red. Revert.

- [ ] **Step 5: Pin, gates, commit.** Re-measure the pin; full reset and run; `pnpm typecheck`, unit, integration. Commit "The received_invoices view and the received PDF audit", plus the trailer, and push.

---

### Task 4: The one email to the receiver

**Files:**
- Create: `supabase/migrations/20261117003000_invoice_delivery_notice.sql`
- Modify: `supabase/tests/rls_invoice_deliveries.sql`, `supabase/tests/run-rls-tests.sh` (pin), `lib/email/invoice-templates.ts`, `lib/email/invoice-notifications.ts`, `app/api/incident-alerts/deliver/route.ts`, `tests/unit/email/invoice-templates.test.ts`, `tests/unit/email/invoice-notifications.test.ts`, `tests/unit/email/delivery-route.test.ts`, `tests/integration/security/phase7-permission-matrix.test.ts`

**Interfaces:**
- Consumes: Task 2's `invoice.delivered` audit rows (target = the delivery id).
- Produces:
  - SQL `public.pending_invoice_delivery_notifications(p_limit integer default 30) returns table (audit_event_id uuid, emails text[], organisation_slug text, organisation_name text, sender_name text, delivered_at timestamptz)` (service_role)
  - notice name `invoice_delivered` in `private.notification_deliveries`
  - TS `buildInvoiceDeliveredNotice(input: InvoiceDeliveredInput): EmailBody`, `INVOICE_NOTICE_ALLOWLIST.invoiceDelivered`
  - TS `deliverInvoiceDeliveredNotifications(limit?: number): Promise<RequesterNoticeResult>`

- [ ] **Step 1: Write the failing template tests.** Append to `tests/unit/email/invoice-templates.test.ts`:

```ts
describe("buildInvoiceDeliveredNotice", () => {
  const input = {
    organisationSlug: "neon-nights",
    organisationName: "Neon Nights Ltd",
    senderName: "Alpha Promotions Ltd",
    deliveredAt: "2026-11-17T12:00:00.000Z",
    siteUrl: "https://app.example.test",
  };

  it("names the sender and the workspace and links ONLY to the received inbox", () => {
    const body = buildInvoiceDeliveredNotice(input);
    expect(body.subject).toBe("[GetSetPaid] New invoice from Alpha Promotions Ltd");
    expect(body.text).toContain("Alpha Promotions Ltd");
    expect(body.text).toContain("neon-nights");
    expect(body.text).toContain("https://app.example.test/neon-nights/invoices/received");
    expect(body.html.match(/href=/g)).toHaveLength(1);
  });

  it("carries no amount, no number and no line detail", () => {
    const body = buildInvoiceDeliveredNotice(input);
    expect(body.text).not.toMatch(/£|INV-|\d+\.\d{2}/);
  });

  it("refuses an input key outside the allowlist and a bad slug", () => {
    expect(() => buildInvoiceDeliveredNotice({ ...input, number: "INV-0001" } as typeof input)).toThrow();
    expect(() => buildInvoiceDeliveredNotice({ ...input, organisationSlug: "../x" })).toThrow();
  });

  it("neutralises a link smuggled into the sender name", () => {
    const body = buildInvoiceDeliveredNotice({ ...input, senderName: "Evil https://evil.example/x" });
    expect(body.html.match(/href=/g)).toHaveLength(1);
  });
});
```

  Read the existing `buildStripeAccountChangedNotice` tests above it first and use the same `subject`/`text`/`html` field names and the same link-count assertion they use; if `EmailBody` names them differently, follow it. Run: `pnpm exec vitest run tests/unit/email/invoice-templates.test.ts`. Expected: FAIL, `buildInvoiceDeliveredNotice` is not exported.

- [ ] **Step 2: Implement the builder.** In `lib/email/invoice-templates.ts`, add `invoiceDelivered: ["organisationSlug", "organisationName", "senderName", "deliveredAt", "siteUrl"],` to `INVOICE_NOTICE_ALLOWLIST`, then after `buildStripeAccountChangedNotice`:

```ts
export interface InvoiceDeliveredInput {
  readonly organisationSlug: string;
  readonly organisationName: string;
  readonly senderName: string;
  readonly deliveredAt: string;
  readonly siteUrl: string;
}

/** Invoices part 3: an invoice arrived in the receiving workspace. The sender's name only: no amount, number or line. */
export function buildInvoiceDeliveredNotice(input: InvoiceDeliveredInput): EmailBody {
  assertInputAllowlisted("invoiceDelivered", INVOICE_NOTICE_ALLOWLIST.invoiceDelivered, input);
  const slug = slugOrRefuse("invoiceDelivered", input.organisationSlug);
  const sender = oneLine(input.senderName, 120) || "A connected workspace";
  const name = oneLine(input.organisationName, 120);
  const label = name ? `“${name}” (${slug})` : slug;
  const link = `${origin(input.siteUrl)}/${slug}/invoices/received`;
  const body = render(
    `[GetSetPaid] New invoice from ${sender}`,
    [
      `${sender} sent an invoice to the workspace ${label} on ${ukDateTime(input.deliveredAt)}.`,
      "Open your received invoices to read it, download the PDF, or pay it.",
    ],
    link,
    "Open received invoices",
  );
  assertOnlyLink("invoiceDelivered", body, link);
  return body;
}
```

  Run the template tests. Expected: PASS. If the "neutralises a link" test fails, check how `oneLine` and `render` treat a URL in the other builders' tests and match them (the subject also carries `sender`; if `render` escapes only the body, pass the subject through the same helper the body uses).

- [ ] **Step 3: Write the failing psql section § DN, above § DZ.** As postgres, clear any `invoice_delivered` ledger rows for the fixtures first.
  - DN0 `pending_invoice_delivery_notifications` is executable by `service_role` only, definer, empty `search_path` (SL0's expression) → `pending_invoice_delivery_notifications=service_role`.
  - DN1 as postgres (no session): `select string_agg(organisation_slug || ':' || sender_name || ':' || array_to_string(emails, '+'), ',') from public.pending_invoice_delivery_notifications(30) where audit_event_id in (select id from public.audit_events where action = 'invoice.delivered' and target_id = :'del_ir2')` → the expected string computed first as postgres: `select (select slug from public.organisations where id = :'org_r') || ':IDL Sender Ltd:' || (select string_agg(email, '+' order by email) from auth.users where id in (:'fin_r', :'own_r')) as dn1_want \gset`, then compare to `:'dn1_want'`. **Not** `bk_r` (no `view_finance`), not any S member.
  - DN2 as `fin_r` (a session) → `denied(42501:notification_stamp_is_server_only)`.
  - DN3 after `select public.mark_notices_delivered('invoice_delivered', array[<that audit id>])` (as postgres) → `1`, DN1's query → `<null>`.
  - DN4 the stamp refuses a `invoice.delivery_withdrawn` audit id under this notice → `0`.
  - DN5 a receiver that went read-only gets nothing: plant a fresh delivery row plus a matching `invoice.delivered` audit row (insert directly as postgres), set `org_r` read-only, DN1-style count → `0`; restore; DN5c control → `1`.

  Run: expected failure at DN0.

- [ ] **Step 4: Write the migration.** Model it on `20261110001000_stripe_link_rpcs.sql` §§ 1 and 7.
  1. Widen the ledger: drop and re-add `notification_deliveries_notice_check` with `'invoice_delivered'` appended, and `notification_deliveries_one_subject` with `'invoice_delivered'` added to the audit-subject list. Copy both constraints' current text from `20261110001000` lines 23–37 and add only that name.
  2. Rebuild `public.mark_notices_delivered` and `public.mark_notices_undeliverable` from their live definitions (latest: `20261110001000`), adding one branch to each, after the `invoice_stripe_account_changed` branch, in that branch's exact shape with `and a.action = 'invoice.delivered'`.
  3. The resolver:

```sql
create or replace function public.pending_invoice_delivery_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, emails text[], organisation_slug text, organisation_name text,
               sender_name text, delivered_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_invoice_delivery_notifications: read by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;
  return query
    select a.id,
           (select pg_catalog.array_agg(u.email::text order by u.email)
              from public.organisation_memberships m
              join public.role_permissions rp
                on rp.role_key = m.role and rp.permission_key = 'view_finance'
              join auth.users u on u.id = m.user_id
             where m.organisation_id = d.to_organisation_id
               and m.status = 'active'
               and u.id <> private.erased_user_id()
               and u.email is not null),
           o.slug, o.name,
           i.snapshot -> 'seller' ->> 'name',
           d.delivered_at
      from public.audit_events a
      join public.invoice_deliveries d on d.id = a.target_id
      join public.invoices i on i.id = d.invoice_id and i.organisation_id = d.from_organisation_id
      join public.organisations o on o.id = d.to_organisation_id and o.deleted_at is null
     where a.action = 'invoice.delivered'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and d.withdrawn_at is null
       and not exists (select 1 from private.notification_deliveries nd
                        where nd.audit_event_id = a.id and nd.notice = 'invoice_delivered')
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;

comment on function public.pending_invoice_delivery_notifications(integer) is
  'service_role only: invoice.delivered audit rows from the last seven days, still live and not yet in the notice ledger, each with the RECEIVING workspace''s current view_finance holders'' addresses (tombstone excluded; nothing while that workspace is read-only), its slug and name, and the sender''s business name from the snapshot. No amount, number or line. lib/email/invoice-notifications.ts sends one email per row on the delivery tick.';
revoke all on function public.pending_invoice_delivery_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.pending_invoice_delivery_notifications(integer) to service_role;
```

  Run the suite. Expected: § DN passes. Declare the resolver in `phase7-permission-matrix.test.ts` `SERVER_ONLY_RPCS`, after `pending_invoice_stripe_account_notifications(p_limit integer)`, in its words ("Invoices part 3 Task 4 -- the delivery tick reads invoice.delivered rows and the RECEIVING workspace's view_finance addresses; refuses any session").

- [ ] **Step 5: Write the failing sender test.** Append to `tests/unit/email/invoice-notifications.test.ts`, following the `deliverInvoiceStripeAccountNotifications` block (read it first; reuse its `db`, `events`, `send` harness):

```ts
describe("deliverInvoiceDeliveredNotifications", () => {
  const delivered = (id: string, emails: string[] | null) => ({
    audit_event_id: id,
    emails,
    organisation_slug: "neon-nights",
    organisation_name: "Neon Nights Ltd",
    sender_name: "Alpha Promotions Ltd",
    delivered_at: "2026-11-17T12:00:00.000Z",
  });

  it("reads the resolver, sends one email per row, and stamps it under invoice_delivered", async () => {
    db.rows = [delivered("a1", ["fin@r.example", "owner@r.example"])];
    send.fn.mockResolvedValue({ ok: true, messageId: "m-1" });
    await expect(deliverInvoiceDeliveredNotifications()).resolves.toEqual({ outcome: "delivered", sent: 1, failed: 0, deferred: 0 });
    expect(events.log).toEqual([
      "rpc:pending_invoice_delivery_notifications",
      "send:fin@r.example+owner@r.example",
      "stamp:invoice_delivered:a1",
    ]);
  });

  it("is nothing_pending when the resolver returns nothing", async () => {
    await expect(deliverInvoiceDeliveredNotifications()).resolves.toEqual({ outcome: "nothing_pending" });
  });
});
```

  Match the exact result shape (`deferred` and so on) to what the Stripe block's first test expects. Run: FAIL, not exported.

- [ ] **Step 6: Implement the sender and wire the tick.** In `lib/email/invoice-notifications.ts`, import `buildInvoiceDeliveredNotice` and add:

```ts
interface InvoiceDeliveredRow extends NoticeRow {
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly sender_name: string | null;
  readonly delivered_at: string;
}

/** Invoices part 3: one email per delivery to the receiver's view_finance holders. */
export function deliverInvoiceDeliveredNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  return deliverAuditNotices<InvoiceDeliveredRow>({
    resolver: "pending_invoice_delivery_notifications",
    notice: "invoice_delivered",
    label: "invoice delivered notice",
    limit,
    // FIVE FIELDS, by name -- never a spread of the row.
    build: (row, origin) =>
      buildInvoiceDeliveredNotice({
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        senderName: row.sender_name ?? "",
        deliveredAt: row.delivered_at,
        siteUrl: origin,
      }),
  });
}
```

  Update the file's header comment to name the third notice and `20261117003000`. In `app/api/incident-alerts/deliver/route.ts`, import it, add `const invoiceDeliveries = await settle(deliverInvoiceDeliveredNotifications);` after `invoiceStripeAccounts`, and add `invoiceDeliveries` everywhere `invoiceStripeAccounts` appears in that file (the `unavailable` list and the response body). In `tests/unit/email/delivery-route.test.ts`, add `deliverInvoiceDeliveredNotifications: () => deliver.delivered(),` beside line 45 and extend `deliver` and any expected response object the same way `stripe` is.

  Run: `pnpm exec vitest run tests/unit/email`. Expected: PASS.

- [ ] **Step 7: Mutants, pin, gates, commit.**
  - Drop the `role_permissions` join from the resolver's email subquery. DN1 goes red (`bk_r`'s address appears). Revert.
  - In the builder, add `${input.senderName}` to the link. The "links ONLY" test goes red. Revert.
  - Re-measure the pin; full reset and run; typecheck, unit, integration. Commit "Email the receiving workspace when an invoice is delivered", plus the trailer, and push.

---

### Task 5: The sender's side of the invoice page

**Files:**
- Create: `lib/invoices/delivery.ts`, `components/invoices/invoice-delivery-panel.tsx`, `tests/unit/invoices/delivery-actions.test.ts`
- Modify: `lib/invoices/actions.ts`, `lib/invoices/refusals.ts`, `app/(app)/[orgSlug]/invoices/[invoiceId]/page.tsx`, `tests/unit/invoices/refusals.test.ts`, `tests/unit/forms/action-outcome-census.test.ts`

**Interfaces:**
- Consumes: Task 2's `invoice_delivery_state`, `deliver_invoice`, `withdraw_invoice_delivery`.
- Produces:
  ```ts
  // lib/invoices/delivery.ts
  export interface DeliveryStateRow {
    networkProfileId: string | null;
    displayName: string | null;
    deliveryId: string | null;
    deliveredAt: string | null;
    canDeliver: boolean;
  }
  export async function loadDeliveryState(invoiceId: string): Promise<DeliveryStateRow[]>;
  // lib/invoices/actions.ts ("use server")
  export async function deliverInvoiceAction(prev: FormState, formData: FormData): Promise<FormState>;           // orgSlug, invoiceId, profileId
  export async function withdrawInvoiceDeliveryAction(prev: FormState, formData: FormData): Promise<FormState>;  // orgSlug, invoiceId, deliveryId
  // components/invoices/invoice-delivery-panel.tsx
  export function InvoiceDeliveryPanel(props: { orgSlug: string; invoiceId: string; rows: DeliveryStateRow[]; canDeliver: boolean; canWithdraw: boolean }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing action tests.** Create `tests/unit/invoices/delivery-actions.test.ts`, with the mocking shape of `tests/unit/invoices/send-action.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  canWrite: true,
  manageFinance: true,
  suspended: false,
  rpcError: null as { code?: string; hint?: string | null; message: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.log.push(`revalidate:${p}`) }));
vi.mock("@/lib/auth", () => ({
  getCurrentOrg: async () => ({ id: "org-1", slug: "neon", name: "Neon", isSuspended: h.suspended }),
}));
vi.mock("@/lib/crm/finance-access", () => ({
  getFinanceWriteAccess: async () => (h.canWrite ? { canWrite: true } : { canWrite: false, explanation: "Invoicing is a Pro feature." }),
}));
vi.mock("@/lib/auth/permissions", () => ({ hasPermission: async () => h.manageFinance }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.log.push(`rpc:${name}:${Object.values(args).join(",")}`);
      return { data: h.rpcError ? null : "d-1", error: h.rpcError };
    },
  }),
}));

import { deliverInvoiceAction, withdrawInvoiceDeliveryAction } from "@/lib/invoices/actions";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const DELIVER = { orgSlug: "neon", invoiceId: "inv-1", profileId: "prof-1" };
const WITHDRAW = { orgSlug: "neon", invoiceId: "inv-1", deliveryId: "d-1" };

beforeEach(() => {
  h.log = [];
  h.canWrite = true;
  h.manageFinance = true;
  h.suspended = false;
  h.rpcError = null;
});

describe("deliverInvoiceAction", () => {
  it("calls deliver_invoice with the invoice and the profile, then revalidates the invoice page", async () => {
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.message).toMatch(/^Delivered/);
    expect(h.log).toEqual(["rpc:deliver_invoice:inv-1,prof-1", "revalidate:/neon/invoices/inv-1"]);
  });
  it("refuses without finance write access and calls nothing", async () => {
    h.canWrite = false;
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toBe("Invoicing is a Pro feature.");
    expect(h.log).toEqual([]);
  });
  it("turns the one refusal hint into its sentence", async () => {
    h.rpcError = { code: "42501", hint: "invoice_delivery_refused", message: "refused" };
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toMatch(/can’t be delivered/);
  });
  it("turns the hourly budget into its own sentence", async () => {
    h.rpcError = { code: "PT429", hint: "600", message: "limit" };
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toMatch(/an hour/);
  });
});

describe("withdrawInvoiceDeliveryAction", () => {
  it("withdraws on a Starter workspace too: manage_finance is enough", async () => {
    h.canWrite = false;
    const state = await withdrawInvoiceDeliveryAction({}, form(WITHDRAW));
    expect(state.message).toMatch(/^Withdrawn/);
    expect(h.log).toEqual(["rpc:withdraw_invoice_delivery:d-1", "revalidate:/neon/invoices/inv-1"]);
  });
  it("refuses without manage_finance, or when suspended", async () => {
    h.manageFinance = false;
    expect((await withdrawInvoiceDeliveryAction({}, form(WITHDRAW))).error).toBeTruthy();
    h.manageFinance = true;
    h.suspended = true;
    expect((await withdrawInvoiceDeliveryAction({}, form(WITHDRAW))).error).toBeTruthy();
    expect(h.log).toEqual([]);
  });
});
```

  Find the module `hasPermission` is imported from in `lib/nav/sidebar-groups.ts` and use that path in the mock. Run: FAIL, the actions are not exported.

- [ ] **Step 2: Implement the actions and the refusal sentence.** In `lib/invoices/refusals.ts` add:

```ts
  invoice_delivery_refused: "This invoice can’t be delivered there. It must be issued or paid, to a company you have linked to a connected workspace’s network profile. Reload the page to see where it stands.",
```

  and update `tests/unit/invoices/refusals.test.ts`'s hint list if it pins one. In `lib/invoices/actions.ts`, import `hasPermission` (same path as above), then append:

```ts
const DELIVERY_BUDGET_MESSAGE = "You’ve delivered 30 invoices in the last hour. Try again in an hour.";

export async function deliverInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const invoiceId = field(formData, "invoiceId");
  const profileId = field(formData, "profileId");
  if (!invoiceId || !profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("deliver_invoice", { p_invoice_id: invoiceId, p_network_profile_id: profileId });
  if (error) {
    if (error.code === "PT429") return { error: DELIVERY_BUDGET_MESSAGE, values: echoedValues(formData) };
    return refused(error, "deliver", formData);
  }
  revalidatePath(`/${auth.org.slug}/invoices/${invoiceId}`);
  return { message: "Delivered. It is in their received invoices now, and their finance team has been emailed." };
}

// No Pro check (plan decision 11): a downgraded workspace can still pull back what it sent.
export async function withdrawInvoiceDeliveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = echoedValues(formData);
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org || org.isSuspended || !(await hasPermission(org.id, "manage_finance"))) {
    return { error: REFUSED_MESSAGE, values };
  }
  const invoiceId = field(formData, "invoiceId");
  const deliveryId = field(formData, "deliveryId");
  if (!invoiceId || !deliveryId) return { error: FAILED_MESSAGE, values };
  const supabase = await createClient();
  const { error } = await supabase.rpc("withdraw_invoice_delivery", { p_delivery_id: deliveryId });
  if (error) return refused(error, "withdraw delivery", formData);
  revalidatePath(`/${org.slug}/invoices/${invoiceId}`);
  return { message: "Withdrawn. It is no longer in their received invoices." };
}
```

  Run the action tests. Expected: PASS. Check `CurrentOrg` really carries `isSuspended` (`lib/crm/finance-access.ts:118` reads it).

- [ ] **Step 3: The state loader.** Create `lib/invoices/delivery.ts`:

```ts
import "server-only";
// The sender's invoice page reads the network through ONE RPC
// (public.invoice_delivery_state, Invoices part 3): live deliveries and the
// profiles it may deliver to now. A failure shows nothing, never a guess.
import { createClient } from "@/lib/supabase/server";

export interface DeliveryStateRow {
  networkProfileId: string | null;
  displayName: string | null;
  deliveryId: string | null;
  deliveredAt: string | null;
  canDeliver: boolean;
}

export async function loadDeliveryState(invoiceId: string): Promise<DeliveryStateRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_delivery_state", { p_invoice_id: invoiceId });
  if (error) {
    console.error("[invoices] delivery state lookup failed:", error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    networkProfileId: (r.network_profile_id as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    deliveryId: (r.delivery_id as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    canDeliver: r.can_deliver === true,
  }));
}
```

- [ ] **Step 4: The panel.** Create `components/invoices/invoice-delivery-panel.tsx`. Delivering and withdrawing each revalidate the page into a tree without the form that was pressed, so both report through `useReportedAction` and the page wraps the panel in `<ActionOutcome>` (the rule `tests/unit/forms/action-outcome-census.test.ts` enforces).

```tsx
"use client";

import { useActionState } from "react";
import { deliverInvoiceAction, withdrawInvoiceDeliveryAction } from "@/lib/invoices/actions";
import type { DeliveryStateRow } from "@/lib/invoices/delivery";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { formatDate } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// INVOICES PART 3: deliver an issued or paid invoice into a connected
// workspace, or withdraw a delivery. Renders NOTHING when there is nothing to
// show: an invoice to a contact, or to an unlinked or unconnected company,
// gets no hint and no suggestion to link (linking stays manual-only).
// Both forms report to the page's <ActionOutcome> region: each one's
// submission revalidates the page into a tree without it.

function DeliverForm({ orgSlug, invoiceId, row }: { orgSlug: string; invoiceId: string; row: DeliveryStateRow }) {
  const reported = useReportedAction(deliverInvoiceAction);
  const [, action, pending] = useActionState(reported, EMPTY_FORM_STATE);
  return (
    <form action={action}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="profileId" value={row.networkProfileId ?? ""} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Delivering…">
        Deliver to {row.displayName}
      </Button>
    </form>
  );
}

function WithdrawForm({ orgSlug, invoiceId, row }: { orgSlug: string; invoiceId: string; row: DeliveryStateRow }) {
  const reported = useReportedAction(withdrawInvoiceDeliveryAction);
  const [, action, pending] = useActionState(reported, EMPTY_FORM_STATE);
  return (
    <form action={action}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="deliveryId" value={row.deliveryId ?? ""} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Withdrawing…">
        Withdraw
      </Button>
    </form>
  );
}

export function InvoiceDeliveryPanel({
  orgSlug,
  invoiceId,
  rows,
  canDeliver,
  canWithdraw,
}: {
  orgSlug: string;
  invoiceId: string;
  rows: DeliveryStateRow[];
  /** manage_finance + Pro + not suspended (getFinanceWriteAccess). */
  canDeliver: boolean;
  /** manage_finance + not suspended; no tier gate. */
  canWithdraw: boolean;
}) {
  const delivered = rows.filter((r) => r.deliveryId !== null);
  const offers = canDeliver ? rows.filter((r) => r.canDeliver && r.networkProfileId !== null) : [];
  if (delivered.length === 0 && offers.length === 0) return null;
  return (
    <section aria-labelledby="deliver-heading" className="flex max-w-prose flex-col gap-3">
      <h3 id="deliver-heading" className="text-lg font-bold text-ink">Deliver in GetSetPaid</h3>
      {delivered.map((row) => (
        <div key={row.deliveryId} className="flex flex-wrap items-center gap-3">
          <p className="text-base text-ink">
            Delivered{row.displayName ? <> to {row.displayName}</> : null} on{" "}
            <time dateTime={row.deliveredAt ?? undefined} className="tabular-nums">
              {row.deliveredAt ? formatDate(row.deliveredAt) : ""}
            </time>
            .
          </p>
          {canWithdraw ? <WithdrawForm orgSlug={orgSlug} invoiceId={invoiceId} row={row} /> : null}
        </div>
      ))}
      {offers.length > 0 ? (
        <>
          <p className="text-base text-ink-muted">
            Put this invoice straight into their GetSetPaid workspace. Their finance team can read it, download it and pay it there.
          </p>
          {offers.map((row) => (
            <DeliverForm key={row.networkProfileId} orgSlug={orgSlug} invoiceId={invoiceId} row={row} />
          ))}
        </>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: Mount it on the invoice page.** In `app/(app)/[orgSlug]/invoices/[invoiceId]/page.tsx`:
  - import `loadDeliveryState`, `InvoiceDeliveryPanel`, `ActionOutcome` and `hasPermission`;
  - in the non-draft branch, load in parallel: `const [sends, delivery, canManageFinance] = await Promise.all([loadInvoiceSends(org.id, invoice.id), loadDeliveryState(invoice.id), hasPermission(org.id, "manage_finance")]);` (replacing the single `sends` await);
  - inside the Actions `<section>`, after the "Send by email" block and only when `invoice.status === "issued" || invoice.status === "paid"` (a void invoice may still show a live delivery: render the panel for `void` too when `delivery.some((r) => r.deliveryId)`), render:
    ```tsx
    <ActionOutcome testId="delivery-outcome">
      <InvoiceDeliveryPanel
        orgSlug={org.slug}
        invoiceId={invoice.id}
        rows={delivery}
        canDeliver={access.canWrite && invoice.status !== "void"}
        canWithdraw={canManageFinance && !org.isSuspended}
      />
    </ActionOutcome>
    ```
  - Add `"components/invoices/invoice-delivery-panel.tsx"` to the unmounting-forms list in `tests/unit/forms/action-outcome-census.test.ts`, with the comment `// Invoices part 3 Task 5. Delivering or withdrawing revalidates the invoice page into a tree without the pressed form.`

- [ ] **Step 6: Gates and commit.** `npx eslint app lib components tests scripts`, `pnpm typecheck`, `pnpm exec vitest run tests/unit`. Start the dev server and open an issued invoice as the e2e demo's Finance user (or wait for Task 7's spec) to see the panel render nothing for an unlinked company. Commit "Deliver and withdraw on the invoice page", plus the trailer, and push.

---

### Task 6: The receiver's inbox, detail page and PDF

**Files:**
- Create: `lib/invoices/received.ts`, `tests/unit/invoices/received-list.test.ts`, `app/(app)/[orgSlug]/invoices/received/page.tsx`, `app/(app)/[orgSlug]/invoices/received/loading.tsx`, `app/(app)/[orgSlug]/invoices/received/[deliveryId]/page.tsx`, `app/(app)/[orgSlug]/invoices/received/[deliveryId]/loading.tsx`, `app/(app)/[orgSlug]/invoices/received/[deliveryId]/pdf/route.ts`
- Modify: `lib/list/query.ts` (`TABLES_WITHOUT_SOFT_DELETE`), `lib/nav/areas.ts` (`FINANCE_ITEMS`), `tests/e2e/super-permissions.spec.ts` (`ROUTE_HANDLERS`)

**Interfaces:**
- Consumes: Task 3's view and `audit_received_invoice_download`; `payLinkUrl(invoiceId)` from `lib/stripe/pay-link.ts`; `renderInvoicePdf(snapshot, { status, payUrl })` from `lib/invoices/pdf/render`; `parseSnapshot`; `InvoiceView`; `InvoiceStatusChip`.
- Produces:
  ```ts
  // lib/invoices/received.ts
  export const RECEIVED_SELECT: string;
  export interface ReceivedRow { id: string; senderName: string | null; number: string; status: "issued" | "paid" | "void"; issueDate: string; dueDate: string; grossMinor: number; deliveredAt: string }
  export function mapReceivedRow(row: Record<string, unknown>): ReceivedRow;
  export const RECEIVED_LIST: ListSpec<"delivered", "status">;
  export interface ReceivedDetail extends ReceivedRow { invoiceId: string; snapshot: unknown; cardPaymentEnabled: boolean }
  export async function loadReceivedInvoice(organisationId: string, deliveryId: string): Promise<{ outcome: "loaded"; invoice: ReceivedDetail } | { outcome: "missing" } | { outcome: "unavailable" }>;
  ```

- [ ] **Step 1: Write the failing list test.** Create `tests/unit/invoices/received-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RECEIVED_LIST, RECEIVED_SELECT, mapReceivedRow } from "@/lib/invoices/received";

describe("RECEIVED_LIST", () => {
  it("sorts newest delivery first on the receiver's list index, and filters by the three statuses a delivery can have", () => {
    expect(RECEIVED_LIST.sort.delivered.column).toBe("delivered_at");
    expect(RECEIVED_LIST.sort.delivered.backedBy).toBe("invoice_deliveries_to_org_list_idx");
    expect(RECEIVED_LIST.sort.delivered.defaultDirection).toBe("desc");
    expect(RECEIVED_LIST.filters.status.choices.map((c) => c.value)).toEqual(["any", "issued", "paid", "void"]);
  });
  it("selects only view columns the list shows, never the snapshot", () => {
    expect(RECEIVED_SELECT).toBe("id, sender_name, number, status, issue_date, due_date, gross_minor, delivered_at");
  });
  it("maps a row", () => {
    expect(
      mapReceivedRow({ id: "d", sender_name: "Alpha", number: "INV-0001", status: "issued", issue_date: "2026-11-01", due_date: "2026-12-01", gross_minor: 12000, delivered_at: "2026-11-17T10:00:00Z" }),
    ).toEqual({ id: "d", senderName: "Alpha", number: "INV-0001", status: "issued", issueDate: "2026-11-01", dueDate: "2026-12-01", grossMinor: 12000, deliveredAt: "2026-11-17T10:00:00Z" });
  });
});
```

  Run: FAIL, module not found.

- [ ] **Step 2: Implement `lib/invoices/received.ts`.** Model it on `lib/invoices/list.ts` and `loadInvoice` in `lib/invoices/queries.ts`:

```ts
import "server-only";
// THE RECEIVED INVOICES (Invoices part 3): read ONLY through the definer view
// public.received_invoices, whose `id` is the delivery and `organisation_id`
// the RECEIVING workspace (plan decision 1), so lib/list/query.ts's tenant
// clause applies unchanged. Any tier: view_finance in this workspace.
import { defineListSpec } from "@/lib/list/spec";
import { createClient } from "@/lib/supabase/server";
import { INVOICE_STATUS_LABELS } from "@/lib/invoices/status";

export const RECEIVED_SELECT = "id, sender_name, number, status, issue_date, due_date, gross_minor, delivered_at";

const RECEIVED_STATUSES = ["issued", "paid", "void"] as const;
type ReceivedStatus = (typeof RECEIVED_STATUSES)[number];

export interface ReceivedRow {
  id: string;
  senderName: string | null;
  number: string;
  status: ReceivedStatus;
  issueDate: string;
  dueDate: string;
  grossMinor: number;
  deliveredAt: string;
}

export function mapReceivedRow(row: Record<string, unknown>): ReceivedRow {
  return {
    id: String(row.id),
    senderName: (row.sender_name as string | null) ?? null,
    number: String(row.number),
    status: row.status as ReceivedStatus,
    issueDate: String(row.issue_date),
    dueDate: String(row.due_date),
    grossMinor: Number(row.gross_minor),
    deliveredAt: String(row.delivered_at),
  };
}

export const RECEIVED_LIST = defineListSpec({
  entity: "received_invoices",
  noun: { one: "received invoice", many: "received invoices" },
  searchColumn: "sender_name",
  searchLabel: "Search by sender",
  sort: {
    delivered: {
      column: "delivered_at",
      label: "Received",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "invoice_deliveries_to_org_list_idx",
    },
  },
  defaultSort: "delivered",
  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...RECEIVED_STATUSES.map((s) => ({ value: s, label: INVOICE_STATUS_LABELS[s] })),
      ],
    },
  },
});

export type ReceivedSortKey = keyof (typeof RECEIVED_LIST)["sort"];
export type ReceivedFilterKey = keyof (typeof RECEIVED_LIST)["filters"];

export interface ReceivedDetail extends ReceivedRow {
  invoiceId: string;
  snapshot: unknown;
  cardPaymentEnabled: boolean;
}

export async function loadReceivedInvoice(
  organisationId: string,
  deliveryId: string,
): Promise<{ outcome: "loaded"; invoice: ReceivedDetail } | { outcome: "missing" } | { outcome: "unavailable" }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("received_invoices")
    .select(`${RECEIVED_SELECT}, invoice_id, snapshot, card_payment_enabled`)
    .eq("organisation_id", organisationId)
    .eq("id", deliveryId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error("[invoices] received invoice lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };
  const row = data as Record<string, unknown>;
  return {
    outcome: "loaded",
    invoice: {
      ...mapReceivedRow(row),
      invoiceId: String(row.invoice_id),
      snapshot: row.snapshot,
      cardPaymentEnabled: row.card_payment_enabled === true,
    },
  };
}
```

  If `defineListSpec`'s `entity` is typed against a closed union, add `"received_invoices"` to it. If the spec type rejects a filter choice list that differs from `INVOICE_STATUSES`, keep this one: the three statuses are the truth for a delivery. Run the test. Expected: PASS.

- [ ] **Step 3: The list chokepoint and nav.** In `lib/list/query.ts`, add to `TABLES_WITHOUT_SOFT_DELETE`:

```ts
  // ADDED BY INVOICES PART 3. `public.received_invoices` is a definer VIEW and
  // projects no `deleted_at`: its own WHERE drops a withdrawn delivery, once,
  // for every reader, and an issued invoice is never deleted. It DOES project
  // `organisation_id` (the receiving workspace), so it is NOT in
  // RELATIONS_WITHOUT_ORGANISATION_ID: the tenant clause applies as usual.
  "received_invoices",
```

  In `lib/nav/areas.ts`, `FINANCE_ITEMS` becomes:

```ts
export const FINANCE_ITEMS: readonly NavArea[] = [
  { path: "invoices", label: "Invoices", sub: "Bill and get paid" },
  { path: "invoices/received", label: "Received", sub: "Invoices sent to you" },
  { path: "settings/invoicing", label: "Invoice settings", sub: "Business and bank details" },
] as const;
```

  The group is already gated on `view_finance` on every tier. Run `pnpm exec vitest run tests/unit/nav` and fix any pinned item list it holds.

- [ ] **Step 4: The list page.** Create `app/(app)/[orgSlug]/invoices/received/page.tsx` by copying `app/(app)/[orgSlug]/invoices/page.tsx` and changing only:
  - the metadata title `Received invoices · ${org.name} · GetSetPaid`;
  - the gate: `getFinanceReadAccess(org)` only (no write access, no "New invoice" button);
  - the heading `Received invoices`, and a back link to `/${org.slug}/invoices` labelled "Invoices";
  - `basePath = /${org.slug}/invoices/received`;
  - `fetchListPage<ReceivedRow, ReceivedSortKey, ReceivedFilterKey>({ spec: RECEIVED_LIST, params, organisationId, table: "received_invoices", select: RECEIVED_SELECT, mapRow: mapReceivedRow, applyFilters: (q, f) => (f.status !== "any" ? q.eq("status", f.status) : q) })`;
  - the columns: Sender (`row.senderName ?? <Absent label="No name" />`), Invoice (a link to `/${orgSlug}/invoices/received/${row.id}`, `tabular-nums`), Issued (`formatDateOnly`, numeric), Due (`formatDateOnly`, numeric), Total (`formatGbp`, numeric), Status (`InvoiceStatusChip`), Received (`formatDateTime`, `sortKey: "delivered"`, numeric, secondary);
  - the empty state:
    ```tsx
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">No invoices received yet</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        When a workspace you are connected to on the network sends you an invoice through GetSetPaid, it appears here. You can read it, download the PDF and pay it. Nothing is added to your own finance.
      </p>
    </div>
    ```

  Create `loading.tsx` beside it by copying `app/(app)/[orgSlug]/invoices/loading.tsx`.

- [ ] **Step 5: The detail page.** Create `app/(app)/[orgSlug]/invoices/received/[deliveryId]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess } from "@/lib/crm/finance-access";
import { loadReceivedInvoice } from "@/lib/invoices/received";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { payLinkUrl } from "@/lib/stripe/pay-link";
import { Alert } from "@/components/ui/alert";
import { InvoiceView } from "@/components/invoices/invoice-view";
import { InvoiceStatusChip } from "@/components/invoices/invoice-status-chip";
import { formatDateTime } from "@/lib/format/date";

// A RECEIVED invoice (Invoices part 3), read-only, from the sender's snapshot
// through public.received_invoices. view_finance in THIS workspace, any tier.
// Wrong role, wrong workspace, withdrawn and unknown are all the same not-found.
export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices/received/[deliveryId]">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Received invoice · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function ReceivedInvoicePage({ params }: PageProps<"/[orgSlug]/invoices/received/[deliveryId]">) {
  const { orgSlug, deliveryId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();
  const result = await loadReceivedInvoice(org.id, deliveryId);
  if (result.outcome === "unavailable") {
    return <Alert tone="error">We couldn’t load this invoice just now. Refresh the page to try again.</Alert>;
  }
  if (result.outcome === "missing") notFound();
  const invoice = result.invoice;
  const snapshot = parseSnapshot(invoice.snapshot);
  const payUrl = invoice.cardPaymentEnabled && invoice.status === "issued" ? payLinkUrl(invoice.invoiceId) : null;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted">
        <Link href={`/${org.slug}/invoices/received`} className="text-primary underline underline-offset-4 hover:text-ink">Received invoices</Link>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink tabular-nums">Invoice {invoice.number}</h1>
        <InvoiceStatusChip status={invoice.status} />
      </div>
      <p className="text-base text-ink-muted">
        From {invoice.senderName ?? "a connected workspace"}, received{" "}
        <time dateTime={invoice.deliveredAt} className="tabular-nums">{formatDateTime(invoice.deliveredAt)}</time>.
        This is their copy; nothing has been added to your finance.
      </p>
      {snapshot ? (
        <InvoiceView snapshot={snapshot} />
      ) : (
        <Alert tone="error">This invoice could not be read. Contact the sender.</Alert>
      )}
      <section aria-labelledby="received-actions-heading" className="flex flex-wrap gap-3 border-t border-rule pt-6">
        <h2 id="received-actions-heading" className="sr-only">Actions</h2>
        <a
          href={`/${org.slug}/invoices/received/${invoice.id}/pdf`}
          download
          className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink hover:border-ink hover:bg-shell"
        >
          Download PDF
        </a>
        {payUrl ? (
          <a
            href={payUrl}
            className="inline-flex h-11 items-center justify-center border border-primary bg-primary px-4 text-base font-semibold text-on-primary hover:border-ink hover:bg-ink"
          >
            Pay by card
          </a>
        ) : null}
      </section>
    </div>
  );
}
```

  The `href` is our own signed `/pay/<id>.<sig>` URL from `payLinkUrl`, the same link the PDF carries; no user text reaches it. Create its `loading.tsx` by copying `app/(app)/[orgSlug]/invoices/[invoiceId]/loading.tsx`.

- [ ] **Step 6: The PDF route.** Create `app/(app)/[orgSlug]/invoices/received/[deliveryId]/pdf/route.ts` by copying `app/(app)/[orgSlug]/invoices/[invoiceId]/pdf/route.ts` with these changes: the param is `deliveryId`; the lookup is `loadReceivedInvoice(org.id, deliveryId)` after `getFinanceReadAccess(org)` (both refusals → the same `404`); the audit is `supabase.rpc("audit_received_invoice_download", { p_delivery_id: deliveryId })` (create the client with `createClient()`); the render passes `payUrl: invoice.cardPaymentEnabled && invoice.status === "issued" ? payLinkUrl(invoice.invoiceId) : null`. Keep the header comment's "THE ORDER IS THE CONTROL" paragraph, reworded for the receiver. Add to `ROUTE_HANDLERS` in `tests/e2e/super-permissions.spec.ts`:

```ts
  "app/(app)/[orgSlug]/invoices/received/[deliveryId]/pdf/route.ts":
    "session + org membership + view_finance in the RECEIVING workspace through the definer view public.received_invoices (another workspace's, a withdrawn and an unknown delivery are the same 404), audited before the PDF is rendered -- probed in invoices-network.spec.ts",
```

- [ ] **Step 7: Gates and commit.** `npx next typegen`, then `pnpm typecheck`, `npx eslint app lib components tests scripts`, `pnpm exec vitest run tests/unit`, and `pnpm exec vitest run tests/integration/list` (the soft-delete census checks `received_invoices` really has no `deleted_at` and really has `organisation_id`; the stack must be up). Commit "The received invoices inbox, detail page and PDF", plus the trailer, and push.

---

### Task 7: The network golden path, the scans and the breakout probes

**Files:**
- Create: `tests/e2e/invoices-network.spec.ts`
- Modify: `tests/e2e/support/fixtures.ts`, `tests/e2e/support/axe-routes.ts`, `tests/e2e/tenant-breakout.spec.ts`

**Interfaces:**
- Consumes: the e2e world. `orgId`/`orgSlug` (alpha; its Owner is `users.owner`) and `proOrgId`/`proOrgSlug` (beta, Pro; Finance `users.finance`) already have an **accepted** connection (fixtures.ts ~line 2588) and alpha's published profile `networkAlphaProfileId`.
- Produces (fixtures):
  ```ts
  export const DELIVERY_COMPANY_NAME = "E2E Network Customer Ltd";
  // E2eWorld gains:
  deliveryCompanyId: string;          // a company in proOrg, linked (network_links) to networkAlphaProfileId
  networkAlphaProfileName: string;    // the display name the Deliver button shows
  ```

- [ ] **Step 1: Fixtures.** In `setUpWorld`, after the accepted connection is planted, insert a company `DELIVERY_COMPANY_NAME` in `proOrgId` (copy how `PRO_SUPPLIER_NAME`'s row is inserted, ~line 2411, but into `public.companies`), and a `network_links` row: `(organisation_id = proOrgId, network_profile_id = networkAlphaProfileId, private_entity_type = 'company', private_entity_id = deliveryCompanyId, created_by = users.finance.id)`. Expose `deliveryCompanyId` and alpha's profile display name on the world. `tearDownWorld` already deletes the orgs; check that `invoice_deliveries` cascades with them (it does, through the invoice), and that the link goes with `proOrg` (FK cascade).

- [ ] **Step 2: Write the spec.** Create `tests/e2e/invoices-network.spec.ts` (serial; one world), the seventh golden-path sibling:

```ts
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { countAuditRows, DELIVERY_COMPANY_NAME, setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// INVOICES, PART 3 -- NETWORK DELIVERY, walked in a real browser. The seventh
// sibling of the golden path: the Pro workspace's Finance user drafts and
// issues an invoice to a company it has linked to a connected workspace's
// profile, delivers it, and the RECEIVING workspace's Owner reads it in the
// inbox, downloads the PDF; then the sender withdraws it and the receiver's
// page becomes not-found. Serial: the steps share one world and one invoice.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;
let invoiceId = "";
let deliveryId = "";

test.beforeAll(async () => {
  world = await setUpWorld();
});
test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
}
```

  Read `tests/e2e/accessibility.spec.ts` for the exact `scan` helper and tags this suite uses, and copy that instead of the sketch above if it differs. Then the tests, in order:

  1. **"the sender issues an invoice to a linked company"**: `signIn(page, world, "finance")`; go to `/${world.proOrgSlug}/invoices/new`; fill it exactly as `invoices.spec.ts`'s first test does, but choose `DELIVERY_COMPANY_NAME` as the recipient; Save draft; capture `invoiceId` from the URL; press Issue (copy the issue step from `invoices.spec.ts`); expect the heading `Invoice <number>`.
  2. **"the sender delivers it in GetSetPaid, keyboard only"**: on the issued invoice, expect the region `Deliver in GetSetPaid`; reach the button `Deliver to <alpha profile name>` with `Tab` presses only (loop `page.keyboard.press("Tab")` until `page.locator(":focus")` has that accessible name, at most 60 presses), press `Enter`; expect `getByTestId("delivery-outcome")` to contain `Delivered`; expect the text `Delivered to <alpha profile name> on`. Assert `await countAuditRows("invoice.delivered", deliveryId)` is `1` after reading `deliveryId` from the database (add a tiny fixture helper `liveDeliveryId(invoiceId)` beside `countAuditRows` in `fixtures.ts`, a one-row select on `invoice_deliveries`). `scan(page)`.
  3. **"an invoice to a contact shows no delivery control"**: open `/${world.proOrgSlug}/invoices/${world.proIssuedInvoiceId}` (issued to a contact); expect no region named `Deliver in GetSetPaid`. **Control:** step 2's page did show it.
  4. **"the receiver reads it in the inbox, opens it and downloads the PDF"**: new context; `signIn(page, world, "owner")` (if `E2eRole` lacks `owner`, use `signInByEmail(page, world.users.owner.email, world.totpSecrets.owner)`); the sidebar has a `Received` link; open `/${world.orgSlug}/invoices/received`; the row shows the sender's business name, the number and the total with `tabular-nums`; `scan(page)`; open it; expect `Invoice <number>` and `From`; `scan(page)`; `const pdf = await page.request.get(\`/${world.orgSlug}/invoices/received/${deliveryId}/pdf\`)` → status 200, content type `application/pdf`; and `countAuditRows("invoice.received_pdf_downloaded", deliveryId)` is `1`.
  5. **"refusal parity on the received routes"**, each a `Page not found` with status 200 or 404 and no redirect to `/login`, and each `/pdf` a 404:
     - as `finance` (the **sender**), `/${world.proOrgSlug}/invoices/received/${deliveryId}`: the delivery is not to this workspace;
     - as `manager` (a member of alpha, the receiver, with no `view_finance`), `/${world.orgSlug}/invoices/received/${deliveryId}`, and the inbox `/${world.orgSlug}/invoices/received` itself.

     Check in `fixtures.ts` that `users.manager` is a member of `orgId` before writing this; if not, use whichever alpha member lacks `view_finance`. **Control:** step 4's same URLs as alpha's Owner returned 200.
  6. **"the sender withdraws it and the receiver sees not-found"**: as `finance`, open the invoice, press `Withdraw` (keyboard: focus it with Tab, press Enter); expect `Withdrawn`; the Deliver button is offered again. As the Owner, `/${world.orgSlug}/invoices/received/${deliveryId}` renders `Page not found`; the inbox's empty state reads `No invoices received yet`.

- [ ] **Step 3: Declare the new routes in the scan census and the breakout spec.** In `tests/e2e/support/axe-routes.ts` `SCANNED_ELSEWHERE`, add:

```ts
  // Invoices part 3: scanned as the RECEIVING workspace's Owner.
  { route: "/[orgSlug]/invoices/received", spec: "invoices-network.spec.ts" },
  { route: "/[orgSlug]/invoices/received/[deliveryId]", spec: "invoices-network.spec.ts" },
```

  In `tests/e2e/tenant-breakout.spec.ts`, beside the invoice probes at ~line 924, add one probe: as the world's breakout principal, `expectRefused(page, \`/${world.proOrgSlug}/invoices/received/${randomUUID()}\`)` and the `/pdf` of the same path is a 404. **Control** is the existing invoice probe beside it.

- [ ] **Step 4: Run, one spec at a time.** Start the dev server in the background (`pnpm dev`), then with `PLAYWRIGHT_REUSE_SERVER=1`:
  - `npx playwright test tests/e2e/invoices-network.spec.ts --workers=1`
  - `npx playwright test tests/e2e/invoices.spec.ts --workers=1` (the fixture change must not break the sixth sibling)
  - `npx playwright test tests/e2e/super-permissions.spec.ts --workers=1` (the route-handler census)
  - `npx playwright test tests/e2e/tenant-breakout.spec.ts --workers=1`
  - `npx playwright test tests/e2e/accessibility.spec.ts --workers=1` (the axe route census)

  Each must pass. A machine failure (`Target crashed`) is re-run, never retried in code.

- [ ] **Step 5: Mutant, then commit.** Make `received/[deliveryId]/page.tsx` skip `getFinanceReadAccess` and make the view's WHERE use `view_crm` locally (do **not** commit either): step 5's refusal parity with a non-finance principal goes red. Revert both. Commit "The network delivery golden path, its scans and breakout probes", plus the trailer, and push.

---

### Task 8: Record it, and the final gate run

**Files:**
- Modify: `docs/as-built.md`, `CLAUDE.md`, `SECURITY.md` (local only, gitignored; never commit), `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`

- [ ] **Step 1: The decisions queue.** Append **Q282 -- Invoices part 3: network delivery, founder answers 2026-11-13**: the three answers from the spec's table, the three accepted defaults, and this plan's twelve decisions, each one line, marked "implemented". Any question the build raised that only the founder can answer takes Q283 onwards, each with the default implemented.

- [ ] **Step 2: `docs/as-built.md`.** Add "Invoices part 3 (network delivery), as it actually shipped", in the house style of the part 2 section: the table and who reads it; the four RPCs and the one predicate; the view, its pinned columns and dependencies, and that it is the receiver's only read path; the received PDF audit; the email; the budget; the deliberate gaps (no booking as a cost, no acknowledge, no unread count, no copy after the sender's purge, not in the receiver's export); the psql section letters.

- [ ] **Step 3: `CLAUDE.md`.** One sentence each, nothing more:
  - § Current state, after the Invoices part 2 paragraph: "**Invoices part 3** (Q282): a Pro sender delivers an issued or paid invoice into a connected workspace through its manual company link; the receiver's `view_finance` holders, on any tier, read it in a read-only inbox (`/[orgSlug]/invoices/received`) through the definer view `received_invoices`, and get one email. Detail in `docs/as-built.md`."
  - § Scope discipline, the Finance line: "part 3 network delivery shipped" in place of "part 3 network delivery follows".
  - § The private/network split, after "The two views are the only foreign read path": add "`received_invoices` is the third definer view and the only path by which one workspace reads another's invoice; its columns and `pg_depend` set are pinned in `rls_invoice_deliveries.sql` § DV."

- [ ] **Step 4: `SECURITY.md`** (local). Add the new cross-tenant read path to the section that lists the network views (read it first; follow its shape): what crosses, the row gate, the column gate, the server mark, the budget, and where each is tested. Do not commit it.

- [ ] **Step 5: The final gate run.** Check for other sessions first. Then, in order:
  1. `npx eslint app lib components tests scripts`
  2. `npx next typegen && pnpm typecheck`
  3. `pnpm test`
  4. `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh` → "All suites passed"
  5. The e2e specs this change reaches, one at a time: `invoices-network`, `invoices`, `invoices-card`, `tenant-breakout`, `super-permissions`, `accessibility`, `keyboard`, `network-connections`, `network-leakage`.
  6. Measure, don't increment: `npx playwright test --list | tail -1` and `grep -c "await scan(\|new AxeBuilder" tests/e2e/*.spec.ts`, for the PR body.

- [ ] **Step 6: Commit, push, PR.** Commit "Record invoices part 3: as-built, CLAUDE.md and Q282", plus the trailer, and push. Open the PR to `main` with `gh pr create`: what it does, the twelve plan decisions, what was run locally and what is left to CI, the founder's open questions (if any). No template placeholder lines. The body ends with exactly:

  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

  Do not merge: merging to `main` needs the founder's approval.
