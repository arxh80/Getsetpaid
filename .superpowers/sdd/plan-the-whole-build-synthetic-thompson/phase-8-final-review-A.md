# Phase 8 final review A: cross-cutting security sweep

Reviewer A · 2026-10-05 · tip `605620e` · base `origin/main` = `68f96cf` (merge-base `9e8e292`).
This was a static review only. I did not touch a database and ran no tests. The local `main` ref is stale
(`f034723`), so every diff below is taken against `origin/main`.

## Verdict: **MINOR**

There are no Criticals. Two findings are Important: one is the malware gate, the other is the closure backup's
purpose. Each needs either a small additive fix or a founder ruling before launch. Neither blocks the PR on
correctness of what Phase 8 claims. Four findings are Minor.

---

## 1. Migration immutability: CLEAN

- `git diff --name-status origin/main...HEAD -- supabase/migrations` lists 112 rows. Every one is `A`. There is no `M`, `D` or `R`.
- The two-dot diff `origin/main HEAD` shows the same: added files only.

## 2. Secrets: CLEAN

`git log -p origin/main..HEAD` (9.0 MB) returned **0 hits** on all of these:
- Telegram bot token `\d{8,10}:[A-Za-z0-9_-]{35}`
- `sb_secret_` and `sb_publishable_`
- three-part `eyJ…` JWTs
- Brevo `xkeysib-` and `xsmtpsib-`
- `sk_live`/`sk_test`, `AKIA…`, PEM private keys and `ghp_`

No `*_TOKEN`, `*_KEY` or `*_SECRET` assignment carries a value. The only env file is `.env.example`. Its new
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`, `EXPORT_/ERASURE_/RETENTION_RUNNER_SECRET` lines are all empty.

## 3. SECURITY DEFINER sweep: CLEAN

Scope: 110 SECURITY DEFINER functions are created or rebuilt in Phase 8. Each was checked at its latest definition.
- **search_path:** all 110 pin `search_path` to `''` or `pg_catalog`.
- **Default EXECUTE:** the baseline `20260827232507` sets the `public` default-ACL floor to zero, so a new function
  does not arrive executable by anyone.
- **Old overloads:** every superseded overload is `DROP`ped rather than left callable.
  - `delete_closed_workspace(text,text)` (`20261028002000:30`)
  - `transition_data_subject_request(…,uuid)`
  - `closed_workspace_reassign_candidates(uuid)`
  - `retention_object_manifest(integer)`
- **First statement is a guard.** I checked the 22 `authenticated`-granted RPCs. Each opens with a session check, an
  aal2 platform-permission check, or `closure_decision_target()`, which carries that check.
- **Membership re-checked from the row.** `close_my_workspace` reads an active `owner` membership row and does not
  trust a parameter.
- **`private.lifecycle_lock(uuid)`** is granted to `authenticated` and takes `FOR UPDATE` on any organisation row.
  It is guarded by `has_platform_permission('manage_organisation_lifecycle')`, and the `private` schema is not
  exposed to PostgREST.
- **service_role-only functions:** the runner, manifest and `pending_*` functions are `service_role`-only, and the ones
  I sampled refuse a session that has a person on it.

## 4. LESSON 15 sweep: every client-writable table at the tip

**Method.**
- The default-privilege floor is zero (`20260827232507`), so a table is client-writable only where a migration grants
  it. I took every `grant/revoke … insert|update|all … to authenticated|anon` and every
  `create policy … for insert|update|all` across all 238 migrations.
- No policy omits `FOR`, so none defaults to `ALL`.
- `anon` holds no write on any `public` table.
- `storage.objects` carries restrictive deny-all for the client on all three buckets.

### Phase 8 tables, and Phase 8 columns added to older tables

| Table | Client write | Columns the client can name | What pins the rest |
|---|---|---|---|
| `legal_documents`, `consents`, `data_subject_requests`, `data_subject_request_notes`, `retention_settings`, `retention_runs` | **none** (RPC only) | — | `consents_before_insert` stamps the user. Guards refuse UPDATE/DELETE/TRUNCATE. The DSR stamps are service_role column grants, and the trigger refuses any session that has a person on it. |
| `export_jobs` | INSERT `(kind, organisation_id)` | kind, organisation_id | `export_jobs_before_insert` (`20261021000000:82`) overwrites `requested_by`, `requested_aal`, `status` and every outcome column. It nulls the org for `account` and re-checks `export_organisation_data`. `closure_backup` is outside the grant and is also refused unless the `close_my_workspace` GUC, `owner_closed` and `lifecycle_changed_at = now()` all hold. |
| `erasure_jobs` | INSERT `(kind)` | kind | `erasure_jobs_before_insert` (`20260930005000`) forces `subject_user_id := auth.uid()` except on the aal2-operator plus open-DSR path. It also stamps `requested_by`/`aal`/`status`/clocks, refuses `workspace` from any session, and meters the insert. |
| `documents.bytes_purged_at`, `.retention_class` (new) | none | — | Outside both grants (`20261004000000:82-87`). `guard_retention_columns` and the `documents_purged_implies_deleted` CHECK also cover them. |
| `documents.deleted_at` | UPDATE | deleted_at | The trigger overwrites null→value with `now()` and refuses a re-date. `assert_retention_clocks()` refuses the retention job while any client-writable clock is left unpinned. |
| `incident_alerts.telegram_notified_at`, `.auto_resolved_reason`; `export_jobs.ready_notified_at`; `erasure_jobs.failure_notified_at`; DSR `*_notified_at` | service_role column grants only | — | The matrix pins `%notified_at` to service_role. |
| `network_connection_requests` (Phase 6, re-pinned in 9b) | UPDATE `(status, responded_at, responded_by)` | status, responded_* | `bound_update` (`20261020000000`) pins the parties and the request time. It ties each transition to the side that may make it, using OLD, and stamps `responded_*`. |

### Older tables still holding table-level INSERT/UPDATE (Phases 2–6)

**Tables:**
- contacts, companies, agencies, artists, venues, venue_rooms
- artist_representations, artist_fee_history, contact_companies
- custom_field_definitions, custom_field_values
- events, event_lineup, tasks, meetings, notes
- the four `*_links` tables
- financial_entries, network_profiles, network_links
- organisation_memberships, organisation_subscriptions, organisations (U), profiles (U)
- merge_candidates (U)

**What protects them:**
- Policies pin `organisation_id`, using `entity_org_unchanged` on UPDATE.
- `organisation_memberships` pins `invited_by`, `status` and `joined_at`.
- Lifecycle state is pinned by `organisation_lifecycle_guard`.
- Retention clocks are policed by `assert_retention_clocks()`.

**The general gap:** none of these tables has a BEFORE trigger that stamps attribution. That gap appears below as m1.

### Ranked findings from the sweep

**Two ways a client could forge state, by impact:**
1. **I1.** `documents.scan_status` is the malware verdict, and the client can write it.
2. **m1.** `created_by` / `created_at` can be forged on `financial_entries`, `network_profiles` and `network_links`.

**Not exploitable on what I read:**
- Every Phase 8 register: export_jobs, erasure_jobs, consents, DSR, legal_documents, retention.
- Every retention clock.
- Every notification stamp.
- The 9b connection-request fix.

---

## Findings

### Important

**I1. Any `manage_documents` member can mark a file clean before the scanner does**

- **Where:**
  - `supabase/migrations/20261004000000_document_retention_clock_is_the_databases.sql:82-87`. This is Task 6 re-granting
    `scan_status` and `scanned_at` on both INSERT and UPDATE to `authenticated`.
  - `supabase/migrations/20260902031000_document_scan_and_access_audit.sql:187`. The guard allows `pending → clean`.
  - `lib/crm/documents.ts:174-232`. The verdict is written through the user's own RLS client.
- **Failure scenario:**
  1. A Manager uploads an infected file through the app. The server stores the bytes and inserts a `pending` row.
  2. While the scanner runs, the Manager's browser polls their own org's `documents` for `scan_status=eq.pending` and
     sends `PATCH {scan_status:'clean', scanned_at:now}`. That PATCH is allowed: the grant covers it, the UPDATE policy
     admits it, and the guard permits pending→terminal.
  3. The server's `quarantined` update then fails with 23514 ("terminal and immutable"). The action returns a
     generic failure and leaves the bytes in place.
  4. The download gate (`documents.ts:429`) checks only `scan_status === 'clean'`, so it hands the file to every
     colleague.
- **How wide is the window?**
  - With today's synchronous EICAR stub, the window is about two PostgREST round trips.
  - With the real ClamAV or SaaS scanner that `SECURITY.md` § 6 makes a launch gate, it is seconds.
- **Why the reviews missed it:** this pre-dates Phase 8. But Task 6's C1 fix re-derived these exact column grants and
  kept the verdict client-writable. No review or `SECURITY.md` entry records the race: the grep for born-terminal or
  forged-verdict text finds only the grant rationale.
- **Fix (additive):**
  - Remove `scan_status` and `scanned_at` from both `authenticated` grants.
  - Write the verdict as `service_role`, through a column grant or a service_role-only RPC that accepts only
    `pending → terminal`.
  - Extend `guard_document_retention_columns` (it is SECURITY INVOKER, so `row_security_active` is valid there). For a
    session writer it should refuse an INSERT with `scan_status <> 'pending'` and refuse any change to `scan_status`.
  - Add an RK probe for both cases.

**I2. A superuser "delete" destroys the closure backup within about an hour**

- **Where:**
  - `supabase/migrations/20261028002000_closure_delete_needs_a_backup_or_acknowledgement.sql:54-70`. This refuses the
    delete unless the backup `succeeded`.
  - `supabase/migrations/20260927001000_export_jobs_register.sql:82`. `export_jobs.organisation_id … on delete cascade`.
  - `supabase/migrations/20261001004000_workspace_purge_summary.sql:151`. `delete from public.organisations`.
- **Why the guard doesn't do its job:** N3a's stated motive is that the purge "took the workspace, its seven-year
  finance ledger included, with no copy anywhere". The guard treats a `succeeded` backup as that copy, but the backup
  does not outlive the purge.
- **Failure sequence:**
  1. The superuser calls `delete_closed_workspace(...)` with a succeeded backup. This dates `lifecycle_changed_at`
     back one period, so `retention_expires_at < now()`.
  2. The next hourly retention run purges the documents and calls `erase_organisation()`. The hard delete
     **cascades the `closure_backup` export_jobs row**.
  3. The archive becomes an orphan, and the manifest's orphan half deletes it after the `storage_orphan` grace period.
  4. `export_jobs_select_own` has no row to admit, so the closing Owner loses the ability to download it at step 2.
  5. The decision notice can arrive after the backup is already gone.
- **Net effect:** "succeeded" stands in for "a copy exists", but no copy survives the decision unless the Owner had
  already downloaded it.
- **Fix: pick one.**
  - (a) Gate the delete on the backup having been **downloaded** (an `audit_export_download` / `record_export_download`
    row), or on the acknowledgement.
  - (b) Bring the purge forward to `now() + N days`, not to now, and say so in the notice.
  - (c) Keep closure-backup rows through the purge: `on delete set null` for `closure_backup` rows, plus an
    `expires_at`-driven sweep.

  Option (c) changes erasure semantics, so it should go to the founder. As a Q, this is a sibling of Q226/Q228.

### Minor

**m1. Attribution can be forged on three pre-Phase-8 tables**

- **Where:** `financial_entries.created_by` (`20260903000000:125`), `network_profiles.created_by`
  (`20260904000000:204`) and `network_links.created_by` (`:311`). Each is only `default auth.uid()`, under
  table-level INSERT/UPDATE. No policy or BEFORE trigger pins it, and `created_at` is open the same way.
- **Scenario:** a Finance user files an expense line "created by" a colleague. Because the column is a plain FK to
  `auth.users`, they can also name any user id platform-wide.
- **Contained, because:**
  - Task 7 made `audit_events.actor` the authoritative record, and it is non-forgeable.
  - None of these columns is a retention clock.
- **Still wrong, because:**
  - The exports render the column (Task 4).
  - The erasure re-point walks it (Task 5).
  - It is Lesson 15's exact shape.
- **Fix:** add one generic BEFORE INSERT/UPDATE stamp trigger, using the `row_security_active` invoker shape: on
  INSERT, `created_by := auth.uid()` and `created_at := now()`; on UPDATE, both are immutable.

**m2. One tenant can flood task reminders and burn the shared Brevo quota**

- **Where:** `supabase/migrations/20261018000000_notice_queue_cannot_be_poisoned.sql:214`.
- **What's bounded:** the I2 fix made the queue fair across workspaces.
- **What isn't:**
  - There is no per-recipient or per-day cap.
  - Task INSERT is not metered.
- **Scenario:**
  - A member creates thousands of tasks assigned to a colleague, each with `reminder_at = now() - 1 min`.
  - On every tick with no other backlog, that tenant takes all 30 slots.
  - This floods the colleague and exhausts the account-wide Brevo daily quota. The legally deadlined DSR emails and
    incident-alert emails (Task 3/9b) share that quota. Telegram still fires.
- **Fix:** cap reminders per recipient per day in the `pending_*` query, or meter task creation.

**m3. A raw POST can delete an account at aal1**

- **Where:** `erasure_jobs_before_insert` records `requested_aal` but accepts aal1.
- **Scenario:** a stolen aal1 session can queue an irreversible account erasure with one PostgREST POST.
- **Status:** already Q171 (a database-checkable step-up token). Listed here only because the cross-task sweep confirms
  that erasure is the highest-consequence action behind that open item.

**m4. An in-flight export can outlive its requester's erasure**

- **Scenario:** an ordinary export job is running while its requester erases their account. `requested_by` cascades
  the row away mid-run, and the runner's later upload lands as an orphan archive of the erased person's data until the
  orphan grace period passes.
- **Bounded:** the retention orphan sweep removes it.
- **Better:** have `erase_account()` wait while an ordinary export is `running`, as it already does for closure
  backups (Q221).

---

## Cross-task interactions checked and found sound

**Workspace closure:**
- A closure racing a superuser suspend or delete takes the row lock and re-checks state (N1).
- Closing a workspace makes membership writes refuse, because `organisation_is_live`.
- A closed workspace sends no further task or connection emails (`org.deleted_at is null`, network-presence predicate).

**Erasure and DSRs:**
- A DSR routed to a purged workspace keeps its routing (`ON DELETE SET NULL`, with `replica` refused).
- The Owner's erasure waits while their closure backup is building (Q221), and a closure backup survives that erasure
  by being re-pointed at the tombstone.

**Retention:**
- Every retention clock is covered by `assert_retention_clocks()`, which is enforced before any object key is named.

**Export:**
- The closure-backup read marker admits SELECTs in its own transaction only.
