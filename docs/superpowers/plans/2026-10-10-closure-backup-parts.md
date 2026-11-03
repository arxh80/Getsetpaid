# A Closure Backup of Any Size, in Parts (Q228): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Q228 as the founder changed it (2026-10-10):
- a closure backup that would pass a per-archive ceiling is built as several parts instead of failing;
- every part is downloadable and audited;
- Q229's purge hold waits for every part;
- the Owner of a closed workspace whose backup failed sees a **Contact us** button;
- "Delete without a backup" is unchanged.

**Architecture:**
- **Postgres.** A new table, `public.export_job_parts`, holds one row per stored part (SELECT under the parent job's own-row rule, no client write). `public.export_jobs` gains `part_count` and `resume_cursor`, written only by `service_role`. Guards admit exactly two new shapes of write:
  - a closure-only `running -> queued` re-queue, after a part is recorded;
  - a part insert by the server, in order, against a running closure job.
- **The runner.** `lib/export/parts.ts` builds one part per claim, closing the part *before* any ceiling would pass, and re-queues the job with a resume cursor. The last part carries the index.
- **Download and purge.** The download route takes `?part=N`. `audit_export_download` gains `p_part`. `closure_backup_owed()` waits for every part. The retention manifest names parts on expiry and exempts a live job's parts from the orphan sweep.
- **The page.** It lists the parts and shows Contact us.

**Tech Stack:** Supabase Postgres (migrations, RLS, storage), Next.js App Router route handler and server components, Vitest (unit and integration against the local stack), the psql runner `supabase/tests/run-rls-tests.sh`, and Playwright with axe.

**Spec:** `docs/superpowers/specs/2026-10-10-closure-backup-parts-design.md`. Read it first. It is the authority where this plan is terse, except where § Spec corrections below records a code fact that contradicts it.

## Global Constraints

- **Worktree:** `.claude/worktrees/q228-closure-backup-parts`, branch `q228-closure-backup-parts`, off `main` at `a75ef1b`. Work only there.
- **Migrations:** new files start at `20261101000000` (the last on main is `20261030004000`; Q189's `20261031000000` is on its own branch and redefines nothing this plan touches).
- **Shipped migrations are immutable.** Change a function with a new migration that rebuilds it from its **live** `pg_get_functiondef`, with only the stated lines changed. Each task names the migration that last defined every function it rebuilds.
- **Shared database:** one local Supabase stack and dev port 3000 serve every worktree.
  - Before any `npx supabase db reset --local`, psql run or e2e run, check that no `node`/`playwright` process from another worktree is running. If one is, wait or message that session.
  - Never run `pnpm build` or `pnpm start`. They reach the hosted project.
- **Scope:** only `closure_backup = true` jobs are built in parts. Ordinary workspace and account exports keep today's fail-at-ceiling path byte for byte (`buildAndStore` in `lib/export/runner.ts` is not changed). See Q237.
- **Bounded:**
  - every unit of work is one part, under the per-part ceilings `private.export_limits()` returns, and at most 65 535 zip entries;
  - every list is paginated, including the parts list on the page;
  - no total size cap and no cap on the number of parts.
- **Keys carry no user input:**
  - part 1 is `exports/{jobId}.zip`, which is today's key and the job row's `storage_key`;
  - part n ≥ 2 is `exports/{jobId}-part-{n padded to at least 4 digits, never truncated}.zip`.
  - The key shape is a CHECK in the database and mirrored by `exportStorageKey(jobId, part)` in TypeScript.
- **Refusals:** every refusal on the download route is the same literal 404 (`"Not found"`, `Cache-Control: no-store`). That covers a malformed, zero, negative, out-of-range or other person's part.
- **Audit:** no new action name. `export_job.downloaded` gains `after.part` (an integer, 1 for a whole single archive).
- **No record content anywhere new:** not in the audit, the mailto subject (slug and job id only), the cursor or logs.
- **Design:** `DESIGN.md` tokens only. Contact us is a bordered link styled as the `secondary` button variant: square, no shadow, no new colour.
- **Every guard needs a mutant that turns a NAMED assertion red.** A guard whose removal reddens nothing is a CRITICAL finding: add the missing assertion and re-run.
- **Suites:**
  - every psql suite must pass twice in a row on one database;
  - register the new suite in `run-rls-tests.sh` at a pinned, measured total;
  - re-measure every pin you change.
- **Commits:** commit and push after each task's green gates. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JwM2UuhyqqPWkMPZVzf7cD
  ```
- **Questions:** questions for the founder go to `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`. The next free number is **Q239**, because Q237 and Q238 are this spec's own. Each question gets a default, and you implement the default.
- **Ledger:** keep task reports in `.superpowers/sdd/2026-10-10-closure-backup-parts/` (`task-N-report.md`), following the Phase 9 ledger's shape.

## Spec corrections

Each correction is a code fact that contradicts or sharpens the spec. The tasks below are already adapted to it.

1. **Where archives are deleted.** The spec says every place that deletes an archive deletes every part: "the expiry purge, the erasure path, the closure-delete purge and Q229's release". The code has only these deletion paths:
   - **The retention manifest.** `public.retention_object_manifest(uuid, integer)` (last defined `20261005000000:268`) names objects in two places: the `expired_exports` CTE (by `export_jobs.storage_key` past `expires_at`) and the `orphans` CTE (an object no `export_jobs.storage_key` names, older than `storage_orphan`). `lib/retention/runner.ts:256` deletes exactly what it names.
   - **Erasure.** `public.erasure_purge_manifest` (`20261022000000:128`) and `private.erase_account` step 3 (live in `20261030003000:399`) both carry `and not closure_backup` (Q206). Erasure therefore never touches a closure backup or its parts, and needs no change. Task 3's census proves the exclusion instead.
   - **Closure delete and Q229 release.** These delete no object. `erase_organisation` cascades the `export_jobs` row (`20260927001000:82`), which now cascades the part rows, and the objects become orphans for the orphan sweep.
   - **The runner** removes only its own just-uploaded object when stamping fails (`lib/export/runner.ts:320`).
   - **A wrong comment.** The `retention_subjects()` row for `export_jobs` (`20261030003000:1308-1309`) says the bytes are "purged by the export runner's own expiry". That is wrong; it is the retention manifest. Task 1 corrects the text when it rebuilds the function.
2. **CRITICAL, not in the spec: the orphan sweep would delete a live backup's parts.** `storage_orphan` is **1 day** (`20261030003000:1269`). The `orphans` CTE exempts an object only when `export_jobs.storage_key` names it, so every part n ≥ 2 of a 60-day closure backup would be deleted the next day. Task 3 adds `export_job_parts` to the exemption, for jobs that are not `failed`, so a failed job's parts do fall to the sweep. Task 3 also adds expired jobs' parts to `expired_exports`.
3. **Grants.** The spec says service_role gets "INSERT and DELETE only" on `export_job_parts`. A `DELETE ... WHERE job_id = ...` needs SELECT on the column, and the runner reads parts back to delete them and to total them. So service_role gets **SELECT, INSERT, DELETE** (no UPDATE). `authenticated` gets SELECT only. `anon` gets nothing.
4. **Re-queueing is currently illegal.** `private.export_jobs_before_update()` (live in `20261029002000:92`) admits only queued→running→succeeded/failed, and refuses `running → queued` with `illegal_export_transition`. Task 1 admits exactly one new transition: closure-only, after a part row, with `part_count` advanced by one.
   - **The reaper, verified.** `private.reap_stuck_jobs` (`20261003002000:544`) fails `status = 'running' and started_at < now() - 1 hour`. The update trigger stamps `started_at := now()` on every move to `running` (`20261029002000:180-181`), so "stuck" is per claim, as the spec wants.
   - **A re-queued job is never reaped**, and `erase_account` step 2b (`20261030003000:390`) still refuses the Owner's erasure while the backup is queued or running. That is consistent with "not built yet". It is asserted, not changed.
5. **The export catalogue cannot hold `export_job_parts`.**
   - Its only foreign key is to `export_jobs`, so it is in neither foreign-key derivation of `tests/integration/export/completeness-census.test.ts:47-67`. A catalogue row would be reported as `extra`.
   - Its disposition is therefore a `NEITHER_DERIVATION` entry with a reason, and the base-table literal goes from 56 to 57.
   - It is **not** added to `REMAINDER_WITHHELD`: it holds nothing about a person beyond its parent job, which every archive already names as excused.
   - The FK-less identifier roll does not apply, because `job_id` has an FK.
   - `private.audit_coverage()` (`20261006000000`) only sees tables with an FK to `organisations`, so the table is outside its denominator. Task 1 asserts that explicitly.
6. **`audit_export_download` must be dropped, not replaced.**
   - `CREATE OR REPLACE ... (p_job_id uuid, p_part integer default 1)` would create a second overload beside `(uuid)`, and every `p_job_id`-only call would become ambiguous (`42725`). Task 3 drops `(uuid)` and creates `(uuid, integer)`.
   - Two existing references name the old signature and are updated: `supabase/tests/rls_phase8_exports.sql:245` (XG15) and `supabase/tests/mutations/10-export-download-authorisation.sql`, which is regenerated in Task 5.
7. **Starvation (a plan decision the spec left open).** `public.claim_export_job()` (`20260927002000:375`) takes the oldest `requested_at`. A re-queued closure backup is always the oldest, so it would be re-claimed ahead of every other export until all its parts are built. Task 1 orders the queue by `coalesce(started_at, requested_at), seq`: a re-queued job's place is its last claim time, so jobs that were waiting are served in between.
8. **Residual bounds (stated, never hit in practice).** The per-part ceilings are the only ceilings, with two exceptions:
   - one row whose JSON alone exceeds an empty part;
   - an index manifest that exceeds an empty part (more than about 40 MiB of part list).

   Either fails the job with a named reason rather than looping on empty parts. Both are recorded in `FOLLOW-UPS.md` and unit-tested as refusals.
9. **Legacy and planted closure backups have no part rows.** Existing suites plant succeeded closure backups by direct update (`rls_phase8_workspace_closure.sql` CH0a, `tests/e2e/support/fixtures.ts:3059` and others).
   - So `part_count = 0` means "one archive at `storage_key`". The database requires `part_count` to equal the job's part-row count, and does not require part rows on success.
   - Q229 counts parts `1..greatest(part_count, 1)`.
   - A legacy download audit row with no `after.part` counts as part 1.
10. **The key padding must not truncate.** `lpad(n::text, 4, '0')` truncates `12345` to `1234`, which would collide once the part count passes 9 999, and the count is uncapped. The CHECK uses `lpad(n::text, greatest(4, length(n::text)), '0')`. TypeScript uses `String(n).padStart(4, "0")`, which never truncates.
11. **Out of scope, recorded only:**
    - The closure section's copy (`app/(app)/[orgSlug]/settings/export/page.tsx:206-208`) says a deleted workspace's backup "stays downloadable from your account's exports". But `/account/exports` lists only `kind = 'account'` jobs (`app/(app)/account/exports/page.tsx:38`). Task 5 queues this as **Q239** and fixes nothing.
    - The legal page text "The archive is a zip" (`20260927008000:67`) is counsel's to change. Task 5 adds a FOLLOW-UP.
12. **Delete without a backup.** The spec says `delete_closed_workspace()` needs no change. That is confirmed: its refusal is `v_backup_status is distinct from 'succeeded'` (`20261029002000:247`), so a re-queued backup with parts stored is refused unless acknowledged. Task 3 adds the assertions only.

## Pattern files (read before writing)

| Need | Copy the pattern in |
|---|---|
| Table plus RLS plus grants plus comments | `supabase/migrations/20260927001000_export_jobs_register.sql` §§ 2, 7 (`export_jobs_select_own`) |
| Server-session test inside a trigger | `private.export_jobs_before_update()` live text in `20261029002000:92-210` (`v_server_session`) |
| Marker-free, definer, `search_path = ''` trigger guard | `private.integration_connections_guard()` (`20261030003000:54`) |
| Retention roll row | `private.retention_subjects()` live in `20261030003000:1290` (`'cascades'` rows) |
| Rolled-back live-sweep probe that plants `storage.objects` | `supabase/tests/rls_phase8_retention.sql:1300-1345` (RW5a: `raise exception` carries the result out) |
| psql suite shape (helpers, personas, `val`/`try`) | `supabase/tests/rls_phase8_closure_backup.sql:1-80` and `supabase/tests/rls_phase9_integrations.sql` |
| Closing a workspace as an aal2 Owner in a fixture | `tests/e2e/support/fixtures.ts:3104-3147` (`plantOwnerClosedWorkspace`) |
| Planting a ready archive object | `tests/e2e/support/fixtures.ts:3059-3078` (`plantReadyAccountExport`) |
| Opening an archive from the bucket in Vitest | `tests/integration/export/runner.test.ts:65-116` (`readZip`, `fetchArchive`) |
| mailto with the `/legal/contact` fallback | `app/(app)/account/data-requests/page.tsx:71-96` and `lib/legal/contact.ts` |
| Either-branch contact assertion in e2e | `tests/e2e/legal.spec.ts:194-210` |
| Axe scan helper | `tests/e2e/workspace-closure.spec.ts:57-62` |
| Privilege census entries | `tests/integration/security/support/privilege-census.ts:130-145` (export_jobs) |
| Own-row relations in the matrix | `tests/integration/security/phase7-permission-matrix.test.ts:1218-1240` and REACH at `:2100` |
| Mutation driver | `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/mutation-results/phase9/mutants.py` plus `README.txt` |
| Upload caps to pin against the part ceiling | `lib/security/upload-limits.ts:68` (`DOCUMENT_MAX_SIZE_BYTES`) and `lib/feedback/contract.ts:35` (`FEEDBACK_SCREENSHOT_MAX_BYTES`) |

---

### Task 1: The parts table, the job columns and their guards

**Files:**
- Create:
  - `supabase/migrations/20261101000000_closure_backup_parts.sql`
  - `supabase/tests/rls_q228_closure_backup_parts.sql` (schema `qp`; sections QT, QR, QG, QJ, QK, QZ)
- Modify:
  - `supabase/tests/run-rls-tests.sh`: `run_suite "Q228 CLOSURE BACKUP PARTS" rls_q228_closure_backup_parts.sql qp <N>` after the Phase 9 suite, with its own red-section explanation block in the house style.
  - `tests/integration/export/completeness-census.test.ts`: a `NEITHER_DERIVATION.export_job_parts` reason of more than 60 characters, and the base-table literal 56 → 57 with a comment.
  - `tests/integration/security/support/privilege-census.ts`: the `export_job_parts` rows and the two new `export_jobs|service_role|UPDATE|...` rows.
  - `tests/integration/security/phase7-permission-matrix.test.ts`: `export_job_parts` in `OWN_ROW_RELATIONS` (with a comment) and in the REACH list.
  - `tests/integration/admin/crm-audit-coverage-census.test.ts`: one assertion that `private.audit_coverage()` returns no `export_job_parts` row, and that no client role holds a write privilege on it (the spec's "the census proves that").
  - Any other census that reddens on a new table. Run `pnpm exec vitest run tests/unit tests/integration` and the psql runner to find them. Update each one with a reason line and never a bare name.

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `public.export_job_parts(job_id uuid, part_no integer, storage_key text, byte_size bigint, row_count bigint, created_at timestamptz)`, primary key `(job_id, part_no)`.
  - `public.export_jobs.part_count integer not null default 0` and `public.export_jobs.resume_cursor jsonb null`.
  - The guard hints:
    - `export_part_is_server_only` (42501);
    - `export_parts_are_closure_only` (22023);
    - `export_part_needs_a_running_job` (22023);
    - `export_part_out_of_order` (22023);
    - `export_part_of_a_kept_backup` (42501, a DELETE of a non-failed job's part);
    - `export_part_count_mismatch` (22023).
  - The new legal transition, for a server session on a `closure_backup` job only: `running -> queued` when `new.part_count = old.part_count + 1`, `new.part_count` equals the job's part-row count, and `new.resume_cursor is not null`.
  - `public.claim_export_job()`: same signature and return table. It orders by `coalesce(j.started_at, j.requested_at), j.seq`.
  - The key-shape expression, used verbatim by Task 2's TypeScript mirror:
    ```sql
    case when part_no = 1 then 'exports/' || job_id::text || '.zip'
         else 'exports/' || job_id::text || '-part-'
              || pg_catalog.lpad(part_no::text, greatest(4, pg_catalog.length(part_no::text)), '0') || '.zip' end
    ```

- [ ] **Step 1: Write the failing suite.** Use the `rls_phase8_closure_backup.sql` helpers (`qp.record`, `qp.val`, `qp.try`, `qp.ids`), and copy `try` from `rls_phase9_integrations.sql`.
  - **Fixtures, created as `postgres`.**
    - Org P (Starter): Owner P (aal2), Admin P2 and Manager P3.
    - Org Q: Owner Q.
    - A closure backup job J for P, made by closing P through `public.close_my_workspace(p, slug, 'qp')` as Owner P under aal2 claims (the e2e fixture's shape).
    - An ordinary succeeded account export K for Owner P, planted the `plantReadyAccountExport` way (queued → running → succeeded as `postgres` with `storage_key = 'exports/'||id||'.zip'`).
    - Everything else is planted as `postgres` with no claims (a server session).
  - **QT (shape and grants):**
    - QT1: the table exists, with `relrowsecurity` true.
    - QT2: the PK is `(job_id, part_no)`, and the FK to `export_jobs(id)` is `ON DELETE CASCADE` (read `confdeltype = 'c'`).
    - QT3: `authenticated` holds SELECT, and holds no INSERT, UPDATE, DELETE or TRUNCATE at table or column level.
    - QT4: `anon` holds nothing.
    - QT5: `service_role` holds SELECT, INSERT and DELETE, and no UPDATE.
    - QT6: CHECK refusals: `part_no = 0` → 23514; a part-2 key of `exports/<id>.zip` → 23514; a part-1 key carrying `-part-0001` → 23514; `byte_size < 0` → 23514.
    - QT7: part 12345's key is accepted as `-part-12345` and **not** `-part-1234`. Test the CHECK expression directly with a `select` against the expression, without inserting 12 345 rows.
    - QT8: `export_jobs` CHECK refusals: `part_count < 0` → 23514; `part_count > 0` on a non-closure job → 23514; `resume_cursor is not null` on a non-closure job → 23514; `resume_cursor is not null` on a succeeded job → 23514.
    - QT9: `authenticated` holds no INSERT or UPDATE on `part_count` or `resume_cursor`, and `service_role` holds UPDATE on both.
  - **QR (reads and forged writes),** with J holding parts 1 and 2. Plant them as `postgres` in the legal order: claim J → insert part 1 → re-queue → claim → insert part 2.
    - QR1: Owner P sees exactly J's 2 part rows.
    - QR2: Admin P2 of the same workspace sees 0.
    - QR3: Owner Q sees 0.
    - QR4: `anon` is refused or sees 0.
    - QR5a–c: a forged INSERT, UPDATE or DELETE as Owner P fails with 42501, and the row count is unchanged at 2.
  - **QG (the part guards):**
    - QG1: an INSERT under Owner P's claims, with INSERT lent to `authenticated` inside a rolled-back transaction (the IT14 pattern), is refused `export_part_is_server_only`. Re-record the result after the rollback.
    - QG2: an insert for K (not a closure job) → `export_parts_are_closure_only`.
    - QG3: an insert for J while J is `queued` → `export_part_needs_a_running_job`.
    - QG4: re-queue J at `part_count = 2` and claim it again. With J running and `part_count = 2`, inserting `part_no = 4` → `export_part_out_of_order`, and `part_no = 2` again → 23505 (PK).
    - QG5: positive control: `part_no = 3` lands.
    - QG6: the DELETE guard:
      - deleting a part of a **succeeded** closure job → `export_part_of_a_kept_backup` (plant a second closure job J2 in a second closed org R that has succeeded with 2 parts);
      - deleting a part of J while it is running → `export_part_of_a_kept_backup`;
      - QG6b: after J is failed, deleting its parts succeeds.
    - QG7: deleting the job row cascades its parts, with zero rows left. The guard admits a cascade (no parent row visible).
  - **QJ (the job transitions):**
    - QJ1: positive control: on J (running, 1 part, `part_count = 0`), the update `status = 'queued', part_count = 1, resume_cursor = '{"v":1}'` succeeds. `started_at` is unchanged, and `storage_key`/`completed_at` are null.
    - QJ2: the same `running → queued` on a running ordinary job → `illegal_export_transition`.
    - QJ3: `part_count = 2` with only 1 part row → `export_part_count_mismatch`.
    - QJ3b: `resume_cursor` null on re-queue → `illegal_export_transition`.
    - QJ4: the same update under Owner P's claims → `export_outcome_is_server_only`.
    - QJ5: a running closure job with 2 part rows stamped `succeeded` with `part_count = 1` → `export_part_count_mismatch`. With `part_count = 2`, `storage_key` part 1's key and `resume_cursor` set to null, it succeeds.
    - QJ5b: success with `resume_cursor` still non-null → 23514 (the QT8 CHECK).
    - QJ5c: a legacy-shaped success (0 parts, `part_count = 0`) still succeeds. That is the planted-fixture shape (Spec correction 9).
    - QJ6 (fairness): with a re-queued closure job whose `started_at = now()` and an ordinary job requested 1 minute ago (backdate `requested_at` with `session_replication_role = replica` for that one fixture statement, then back to `origin`), `public.claim_export_job()` as `postgres` returns the ordinary job first. Do this inside a savepoint and roll back.
    - QJ6b: with the closure job's `started_at` 2 minutes ago, it is returned first. That is the denominator: the order is not simply "ordinary first".
  - **QK (the reaper, Spec correction 4):** run `private.reap_stuck_jobs(false, 50)` inside a savepoint. Read the statuses and raise them out (the RW5a pattern), then roll back.
    - QK1: a closure job **queued** between claims whose `started_at` and `requested_at` are 3 hours ago (backdated as in QJ6) is not reaped.
    - QK2: a closure job **running** with `requested_at` 3 hours ago and `started_at` 1 minute ago is not reaped. This is the whole-backup-longer-than-an-hour case.
    - QK3: positive control: a running job with `started_at` 2 hours ago is failed with the reaper's reason.
    - QK4: claiming a queued job re-stamps `started_at` to `now()`.
  - **QE (erasure waits, asserted rather than changed):** QE1: `private.erase_account(owner P)` while J is queued with parts stored is refused `closure_backup_not_built` (55000). Roll it back.
  - **QZ (housekeeping):** QZ1: no `qp` fixture rows are left in `export_jobs`, `export_job_parts`, `organisations` or `storage.objects`.

- [ ] **Step 2: Run it and see it red.** `npx supabase db reset --local`, then `bash supabase/tests/run-rls-tests.sh`. Expect the new suite to be red at QT1, because the relation does not exist.

- [ ] **Step 3: Write the migration.** Its header names every rebuilt function's source:
  - `private.export_jobs_before_update()` from `20261029002000:92`;
  - `public.claim_export_job()` from `20260927002000:375`;
  - `private.retention_subjects()` from `20261030003000:1290`.

```sql
-- 1. THE JOB COLUMNS.
alter table public.export_jobs
  add column part_count integer not null default 0,
  add column resume_cursor jsonb;
alter table public.export_jobs
  add constraint export_jobs_part_count_shape check (
    part_count >= 0
    and (closure_backup or part_count = 0)
    and (resume_cursor is null or (closure_backup and status in ('queued', 'running'))));
comment on column public.export_jobs.part_count is '...';   -- closure backups only; equals the job's export_job_parts rows; 0 = one archive at storage_key (legacy/single)
comment on column public.export_jobs.resume_cursor is '...'; -- the runner's opaque resume point between claims; never a person's data, never read by a client
grant update (part_count, resume_cursor) on public.export_jobs to service_role;

-- 2. THE PARTS TABLE.
create table public.export_job_parts (
  job_id      uuid    not null references public.export_jobs (id) on delete cascade,
  part_no     integer not null,
  storage_key text    not null,
  byte_size   bigint  not null,
  row_count   bigint  not null,
  created_at  timestamptz not null default now(),
  primary key (job_id, part_no),
  constraint export_job_parts_part_no check (part_no >= 1),
  constraint export_job_parts_counts check (byte_size >= 0 and row_count >= 0),
  constraint export_job_parts_storage_key_shape check (storage_key =
    case when part_no = 1 then 'exports/' || job_id::text || '.zip'
         else 'exports/' || job_id::text || '-part-'
              || pg_catalog.lpad(part_no::text, greatest(4, pg_catalog.length(part_no::text)), '0')
              || '.zip' end)
);
-- No separate job_id index: the primary key's leading column is the FK's index.
comment on table public.export_job_parts is '...';

alter table public.export_job_parts enable row level security;
create policy export_job_parts_select_own on public.export_job_parts
  for select to authenticated
  using (exists (select 1 from public.export_jobs j where j.id = export_job_parts.job_id));
-- The subquery runs under the CALLER's RLS on export_jobs, i.e. export_jobs_select_own
-- (requested_by = auth.uid()): the rule is reused, not restated.
comment on policy export_job_parts_select_own on public.export_job_parts is '...';
revoke all on public.export_job_parts from public, anon, authenticated, service_role;
grant select on public.export_job_parts to authenticated;
grant select, insert, delete on public.export_job_parts to service_role;
```

  Then, in the same file:
  - **`private.export_job_parts_guard()`.** SECURITY DEFINER, `set search_path = ''`, BEFORE INSERT OR DELETE FOR EACH ROW, EXECUTE revoked from every API role.
    - Server session: `v_server_session := auth.uid() is null and coalesce(current_setting('role', true), '') in ('postgres','service_role','none','')`. Outside it, raise `export_part_is_server_only` (42501).
    - INSERT: lock the parent with `select ... from public.export_jobs where id = new.job_id for update`.
      - not `closure_backup` → `export_parts_are_closure_only`;
      - `status <> 'running'` → `export_part_needs_a_running_job`;
      - `new.part_no <> part_count + 1` → `export_part_out_of_order`;
      - `new.created_at := now()`.
    - DELETE: read the parent.
      - not found → return `old`, because this is the cascade from the parent's own delete;
      - `status <> 'failed'` → `export_part_of_a_kept_backup` (42501);
      - otherwise return `old`.
  - **`private.export_jobs_before_update()`.** Rebuilt from its live text with three changes and nothing else:
    1. Insert the re-queue clause just before the legal-transition check:
       ```sql
       if old.status = 'running' and new.status = 'queued' then
         if not (old.closure_backup and new.resume_cursor is not null
                 and new.part_count = old.part_count + 1) then
           raise exception 'export_jobs: a job cannot go from running to queued' using errcode = '22023', hint = 'illegal_export_transition';
         end if;
         if new.part_count <> (select pg_catalog.count(*) from public.export_job_parts p where p.job_id = old.id) then
           raise exception 'export_jobs: part_count does not match the stored parts' using errcode = '22023', hint = 'export_part_count_mismatch';
         end if;
         new.started_at := old.started_at; new.completed_at := null; new.expires_at := null;
         return new;
       end if;
       ```
    2. On a transition to `succeeded` only, require `new.part_count = (count of the job's part rows)`, refusing with `export_part_count_mismatch`. This is what makes a success with a lagging `part_count` impossible (QJ5).
       - **Never on a transition to `failed`.** A part row can be stored and the re-queue then fail, which leaves `part_count` one behind. If `failed` were checked too, both the runner's fail-update and `private.reap_stuck_jobs()` would raise, and a raise in the reaper aborts the whole retention run.
       - Add **QJ7**: a running closure job with 1 part row and `part_count = 0` can still be marked `failed`, and the reaper fails such a job when `started_at` is 2 hours old. Run it in a savepoint.
    3. Do not clear `resume_cursor` on success. The QT8 CHECK refuses a success that still carries one (QJ5b), and the runner's success update sets it to null itself.
  - **`public.claim_export_job()`.** Rebuilt with the `order by` line only: `order by coalesce(j.started_at, j.requested_at), j.seq`. Keep the comment, and add one sentence about Q228's fairness.
  - **`private.retention_subjects()`.** Rebuilt, with one row added: `('export_job_parts', 'cascades', null, 'FK to public.export_jobs, ON DELETE CASCADE: a part row goes with its job. Its OBJECT is named by public.retention_object_manifest() on expiry, and is an orphan once its job is failed or gone.')`. Correct the `export_jobs` row's last sentence to "The archive bytes are purged by the retention runner from public.retention_object_manifest() (expiry and orphans)."
  - **Self-checks** that refuse the migration (`do $$ ... raise exception ... $$`):
    - `private.assert_retention_roll()` passes;
    - the two new hints are present in the trigger source.

- [ ] **Step 4: Run the runner twice on one database.** Expect "All suites passed" both times, with the new pin set to the measured count. Every existing suite must stay at its pin: the exports, closure and closure-backup suites plant succeeded jobs with 0 parts (Spec correction 9). If one reddens, fix the guard, never the fixture, unless the fixture is writing a shape the spec forbids.
- [ ] **Step 5: Run the censuses.** `pnpm exec vitest run tests/unit tests/integration/export tests/integration/security tests/integration/admin tests/integration/rls`. Expect green after the census edits in **Files**. Then run `pnpm lint` and `pnpm typecheck`.
- [ ] **Step 6: Mutants owed (run by hand now; Task 5 scripts them).** Each must red the named assertion:
  - M01: policy `using (true)` → QR2, QR3.
  - M02: `grant insert, delete on public.export_job_parts to authenticated` → QT3, QR5a, QR5c.
  - M03: drop the server-session check in the parts guard → QG1.
  - M04: drop the `part_count + 1` check → QG4.
  - M05: drop the `running` check → QG3.
  - M06: DELETE guard admits any status → QG6.
  - M07: re-queue clause without `old.closure_backup` → QJ2.
  - M08: drop the part-count comparison → QJ3 and QJ5.
  - M08b: extend the comparison to `failed` → QJ7.
  - M09: `claim_export_job` ordered by `requested_at` again → QJ6.
  - M10: drop `export_job_parts_storage_key_shape` → QT6 and QT7.
  - M11: drop `export_jobs_part_count_shape` → QT8 and QJ5b.

  Record them in `task-1-report.md`.
- [ ] **Step 7: Commit and push.** Message: "Add closure backup parts: the table, the job columns, the re-queue and their guards".

---

### Task 2: The parted builder (zip, contract, runner)

**Files:**
- Modify:
  - `lib/export/contract.ts`;
  - `lib/export/zip.ts`;
  - `lib/export/runner.ts` (dispatch, failure cleanup and the limits override only; `buildAndStore` is untouched).
- Create:
  - `lib/export/parts.ts` (`import "server-only"`);
  - `tests/unit/export/parts-contract.test.ts`;
  - `tests/integration/export/closure-parts.test.ts`;
  - `tests/unit/export/export-bucket-removal-census.test.ts`.
- Extend: `tests/unit/export/zip.test.ts`.

**Interfaces:**
- Consumes (Task 1):
  - the tables and columns;
  - the legal re-queue `update export_jobs set status='queued', part_count=n, resume_cursor=<json> where id=...` from the runner's `service_role` client;
  - parts inserted while the job is `running`, in order;
  - the key-shape expression.
- Produces:
  - In `lib/export/contract.ts`:
    - `exportStorageKey(jobId: string, part: number = 1): string`. Part 1 is unchanged. n ≥ 2 gives `exports/${jobId}-part-${String(n).padStart(4, "0")}.zip`. It throws on a non-uuid id or a part that is not a positive safe integer.
    - `CLOSURE_PARTS_MANIFEST_VERSION = 3` (ordinary archives stay 2).
    - `export type PartCloseReason = "rows_per_table" | "total_rows" | "bytes" | "entries" | "final"`.
    - `export interface PartSlice { table: string; file: string; firstKey: string; lastKey: string; rows: number }`.
    - `export interface PartSummary { part: number; key: string; bytes: number; rows: number; slices: PartSlice[]; files: number; closedBy: PartCloseReason }`.
    - `export interface ClosurePartManifest extends Omit<ExportManifest, "schemaVersion"> { schemaVersion: 3; part: number; slices: PartSlice[] }`.
    - `export interface ClosureIndexManifest extends Omit<ExportManifest, "schemaVersion"> { schemaVersion: 3; parts: PartSummary[]; indexPart: number }`.
    - `export interface ResumeCursor` (`v: 1`):
      - `phase: "tables" | "files" | "index"`;
      - `planIndex: number`;
      - `after: string`, the key last written, `""` at a table's start;
      - `tableRowsSoFar: number`;
      - `rowCounts: Record<string, number>`;
      - `withheld: ExportWithholding[]`;
      - `files: { path: string; bytes: number }[]`;
      - `parts: PartSummary[]`;
      - `generatedAt: string`.
    - `parseResumeCursor(value: unknown): ResumeCursor | null`, which is strict: wrong version, a negative number, or an unknown phase gives `null`.
    - `parsePartParam(raw: string | null): number | null`. `null` gives 1. `/^[1-9][0-9]{0,8}$/` gives that number. Anything else gives `null`.
  - In `lib/export/zip.ts`:
    - `new ZipWriter(byteCeiling: number, entryCeiling: number = 65_535)`, with `entryCeiling` capped at 65 535;
    - `wouldFit(name: string, rawBytes: number, reserveBytes = 0, reserveEntries = 0): boolean`;
    - the existing `hold`/`addEntry`/`finish` behaviour unchanged.
  - In `lib/export/parts.ts`:
    - `buildNextClosurePart(supabase: ServiceClient, job: ClaimedClosureJob, limits: Limits): Promise<{ final: boolean; part: number }>`;
    - `removeClosureParts(supabase: ServiceClient, jobId: string): Promise<void>`;
    - `export const PART_MANIFEST_BASE_RESERVE = 65_536`.
  - In `lib/export/runner.ts`:
    - `runPendingExportJobs(options?: { limitsOverride?: Partial<Limits & { max_entries: number }> }): Promise<RunnerOutcome>`;
    - `effectiveLimits(db: Limits, override?: Partial<...>): Limits & { max_entries: number }`, exported for the unit test. **Every field is the minimum of the database's and the override's**, so an override can only tighten.
    - `RunnerOutcome` gains `readonly requeued: number`.

- [ ] **Step 1: Write the failing unit tests.**
  - **`zip.test.ts`, new `describe("wouldFit")`:**
    - `wouldFit` is true exactly up to the byte where `addEntry` + `finish()` would land at `byteCeiling`. Fill a writer with entries, then assert `wouldFit(name, n)` is true, add it, and `finish()` does not throw. For `n + 1` on a fresh copy, `wouldFit` is false.
    - It counts the central-directory bytes of entries already added. The mutant T1 (ignoring them) must red this.
    - It refuses when `entryCount + 1 + reserveEntries > entryCeiling`.
    - `new ZipWriter(1e6, 3)` lets 3 entries in, and `wouldFit` refuses the 4th.
    - `new ZipWriter(1e6, 70000)` is capped at 65 535.
  - **`parts-contract.test.ts`:**
    - `exportStorageKey(id)` equals `exports/${id}.zip`;
    - `exportStorageKey(id, 2)` ends `-part-0002.zip`;
    - `exportStorageKey(id, 12345)` ends `-part-12345.zip`;
    - part 0, -1 and 1.5 throw;
    - **binding test:** for parts 1, 2, 9999, 10000 and 123456, the TypeScript key equals the database CHECK expression. Evaluate the SQL expression from Task 1 against the local stack with `pg`, in an integration-flavoured block guarded the way the other `tests/unit` files that touch the stack are, or move this case into `closure-parts.test.ts`;
    - `parsePartParam`: `null`→1, `"1"`→1, `"12"`→12, `"0"`, `"-1"`, `"01"`, `"1.0"`, `"1e3"`, `" 2"`, `"abc"` and `"1234567890"` (10 digits) all → `null`;
    - `parseResumeCursor` round-trips a valid cursor and rejects each malformed field;
    - `effectiveLimits(db, { max_archive_bytes: db.max_archive_bytes * 2 })` keeps the database's value, and `{ max_archive_bytes: 1000 }` gives 1000. That is mutant T4's assertion;
    - **the ceiling pin (spec § 2):**
      - `DOCUMENT_MAX_SIZE_BYTES + PART_MANIFEST_BASE_RESERVE + 30 + 46 + 2 * 1024 + 22 < EXPORT_LIMITS.maxArchiveBytes` (the 1024 is the longest sanitised document path, measured from `sanitiseFilename`'s cap);
      - the same with `FEEDBACK_SCREENSHOT_MAX_BYTES`;
      - the message names the upload cap, so raising it past the part ceiling is red rather than an unbuildable backup.
  - **`export-bucket-removal-census.test.ts`** (source-reading, like `tests/unit/security/storage-client-census.test.ts`):
    - every `.remove(` reachable on the `exports` bucket in `lib/**` and `app/**` is either inside `removeClosureParts` / `lib/export/parts.ts`, or is the runner's single just-uploaded-key cleanup at the stamp failure in `buildAndStore` (named with its reason);
    - `lib/retention/runner.ts` removes only keys the database named, matched by its `removeObjects(manifest)` shape.

- [ ] **Step 2: Write the failing integration test** `tests/integration/export/closure-parts.test.ts`. Imports and setup follow `runner.test.ts`.
  - **Fixture helper `seedClosableWorkspace(label)`** creates an org with:
    - an Owner (aal2 claims available) and a Manager;
    - 9 contacts, 4 companies, 3 company notes and 1 Owner-private note;
    - 3 clean documents whose objects are uploaded to the `documents` bucket, each about 96 KiB of incompressible random bytes;
    - 1 quarantined document.
  - **The reference:** before closing, insert an ordinary workspace export as the Owner (`set local role authenticated` plus aal2 claims, insert `(kind, organisation_id)`) and run `runPendingExportJobs()` with no override until it succeeds. Open its single archive with `readZip`.
  - **Then close** through `public.close_my_workspace` as the Owner. The closure job is queued.
  - **Build** with `runPendingExportJobs({ limitsOverride })`, looping (at most 500 calls) until the job is `succeeded` or `failed`.
  - **Five cases, each its own seeded workspace:**
    - **C1** rows per table: `{ max_rows_per_table: 3 }`;
    - **C2** total rows: `{ max_total_rows: 7 }`;
    - **C3** bytes: `{ max_archive_bytes: 160 * 1024 }`;
    - **C4** entries: `{ max_entries: 6 }`;
    - **C5** all four at once.
  - **For each case assert:**
    - (a) the job succeeded, and `part_count` is at least 2 and equals the `export_job_parts` row count;
    - (b) part keys are `exportStorageKey(job, n)` for n = 1..part_count, and part 1 is the job's `storage_key`;
    - (c) every part object opens with `readZip`, carries `manifest.json` with `schemaVersion: 3` and its own `part`, and **no part breaks a ceiling**:
      - rows of any one table in the part are at most the per-table ceiling;
      - the part's total rows are at most the total ceiling;
      - the object's byte length is at most the bytes ceiling;
      - the entry count is at most the entry ceiling;
    - (d) **the ceiling actually bound:** the index's `parts[].closedBy` contains that case's reason (C1 `rows_per_table`, C2 `total_rows`, C3 `bytes`, C4 `entries`; C5 at least two). That is the denominator: a build that never split would pass (c);
    - (e) **union equals source:** for every `tables/<t>.json` in the reference, the concatenation of that file's slices across parts, ordered by part, has:
      - the same key set as the reference;
      - no duplicate key;
      - none missing;
      - deep-equal rows for every table except `organisations`, whose lifecycle columns moved at closure (compare its key set only);
    - (f) every clean document's bytes appear in exactly one part, byte for byte equal to the upload, and the quarantined one is withheld in the index and in exactly one part manifest;
    - (g) slice manifests: each `PartSlice.rows` equals its file's array length, and `firstKey`/`lastKey` are that file's first and last key;
    - (h) the job row: `byte_size` is the sum of part `byte_size`s and of the real object lengths, `row_count` is the sum of part `row_count`s, `table_count` is the reference's table count, `manifest.parts.length = part_count`, and `manifest.indexPart = part_count`.
  - **C6 (one claim, one part):** with `{ max_rows_per_table: 3 }`, call `runPendingExportJobs` once while asserting `claimed ≤ 3`. After that call the job is `queued` or `succeeded`, `part_count` is at most `claimed`, and while queued `resume_cursor` is not null.
  - **C7 (failure cleans up):** with `{ max_archive_bytes: 120 * 1024 }` (the bytes C3 already proved split) and one document re-uploaded at 200 KiB (larger than any part can hold):
    - the job ends `failed`, with a `failure_reason` that names the unit larger than a part;
    - **no** object `exports/<job>*.zip` remains in the bucket (list by prefix);
    - zero `export_job_parts` rows remain;
    - at least one part had been stored before the failure (read the `export_job_parts` count after the first claim, before the failure). That is the denominator: cleanup that had nothing to clean proves nothing.
  - **C8:** an ordinary workspace export and an account export built in the same file still produce one archive with `schemaVersion` 2 and `part_count = 0`. The fail-at-ceiling path is unchanged: an ordinary job under the `{ max_rows_per_table: 3 }` override **fails** with today's sentence.
  - **Teardown:** remove the seeded orgs, their documents' objects and every `exports/<job>*` object the test created.

- [ ] **Step 3: Run both and see them red.** `pnpm exec vitest run tests/unit/export tests/integration/export/closure-parts.test.ts`.

- [ ] **Step 4: Implement.**
  - **`zip.ts`.**
    - Track `directoryBytes` (46 + name bytes per entry) incrementally in `addEntry`.
    - `wouldFit(name, rawBytes, reserveBytes, reserveEntries)` is true when both hold:
      - `size + held + 30 + nameLen + rawBytes + directoryBytes + 46 + nameLen + 22 + reserveBytes <= byteCeiling`;
      - `entries.length + 1 + reserveEntries <= entryCeiling`.

      The raw size is an upper bound, because a stored payload is never larger than its input. `addEntry` keeps its own hard checks, now against `entryCeiling`.
  - **`contract.ts`:** the Produces list above.
  - **`parts.ts`, `buildNextClosurePart`:**
    1. Read the cursor: `parseResumeCursor(job.resume_cursor)`, or a fresh cursor when `part_count = 0`. A corrupt cursor throws.
    2. Read the plan (`export_plan`). A fresh cursor seeds `withheld` with `REMAINDER_WITHHELD`, every excused table and the audit-payload line, exactly as `buildAndStore` does.
    3. Open `new ZipWriter(limits.max_archive_bytes, limits.max_entries)` for part `n = job.part_count + 1`.
    4. **Tables phase.** For each exported table from `planIndex`, read pages from `cursor.after` with `p_limit = min(page_size, max_rows_per_table - rowsOfThisTableInPart, max_total_rows - rowsInPart)`. Serialise row by row. Before appending a row, check `wouldFit("tables/<t>.json", heldSliceBytes + piece + tail, manifestReserve, 1)`. When a ceiling would pass:
       - close the slice at the previous row: write the entry, record a `PartSlice`, set `cursor.after` to that row's key;
       - close the part with `closedBy` set to the binding ceiling.

       A table that ends inside the part writes its slice and moves on. Rows of a page beyond the cut are discarded and re-read next claim from `after` (keyset).
    5. **Files phase** (closure backups are workspace exports, so documents only). Re-read `documents` through `export_read_page` from `cursor.after` (keyset). For a non-clean document, append a withheld entry, counted into the part manifest reserve. For a clean one, download the bytes:
       - if `wouldFit(path, bytes.length, reserve, 1)` is false, close the part (`bytes` or `entries`);
       - if the part is still empty, **throw** `"documents/<id> is larger than one part of the backup can hold"` (Spec correction 8).
    6. **Empty-part guard.** If a part would close with nothing written in it, throw a named error instead. A row larger than a part is the same refusal.
    7. **Manifest reserve.** Start at `PART_MANIFEST_BASE_RESERVE`. Add `Buffer.byteLength(JSON.stringify(entry, null, 2)) + 8` for every slice, file and withheld entry added to this part's manifest. At close, assert the real manifest fits. If it does not, that is a bug: throw.
    8. **Close a part:**
       - add `manifest.json` (`ClosurePartManifest`);
       - `finish()`;
       - upload to `exportStorageKey(job.id, n)` (upsert);
       - insert the `export_job_parts` row (`byte_size` is the archive length, `row_count` the part's rows);
       - push a `PartSummary` into `cursor.parts`.
    9. **Plan exhausted.** Build the `ClosureIndexManifest`:
       - all parts plus this one;
       - `rowCounts` totals, the union of `withheld`, and the notes `buildAndStore` writes;
       - one more note: "This backup is N parts. Together they are the whole backup; this part (N) holds the index.".

       If the index's reserve does not fit the current part, close the current part with the ceiling that bound it (`bytes` or `entries`) and put the index alone in part n+1, whose `closedBy` is `final`. If the index does not fit an empty part, throw (Spec correction 8). Write the index into the final part's `manifest.json`. Return `{ final: true }`.
    10. **Not exhausted:** return `{ final: false }`, with the updated cursor kept by the caller.
  - **`runner.ts`.**
    - After a claim, read `closure_backup, part_count, resume_cursor` for the job: `supabase.from("export_jobs").select(...).eq("id", job.id).single()`, which `service_role` holds SELECT for.
    - **A closure job** goes to `buildNextClosurePart`:
      - not final: `update({ status: "queued", part_count: n, resume_cursor: cursor })`, then `requeued += 1`;
      - final: `update({ status: "succeeded", storage_key: exportStorageKey(job.id), byte_size: sum, row_count: sum, table_count, manifest: index, part_count: n, resume_cursor: null })`.
    - **On any throw for a closure job:**
      - mark it failed (existing code);
      - then `removeClosureParts(supabase, job.id)`, which removes the keys `exportStorageKey(job.id, k)` for k = 1..(stored parts + 1, to cover the in-flight upload) in chunks of 100, then deletes the part rows. The Task 1 guard now admits that, because the job is failed.
      - Cleanup errors are logged, never thrown: a failed job's parts are orphans the 1-day sweep takes (Task 3).
    - **Ordinary jobs:** `buildAndStore`, unchanged.
    - `limitsOverride` goes through `effectiveLimits`. `app/api/exports/run/route.ts` and `nudgeExportRunner` pass nothing.
- [ ] **Step 5: Run until green.** `pnpm exec vitest run tests/unit/export tests/integration/export`, `pnpm lint` and `pnpm typecheck`. The existing `runner.test.ts` must stay green unchanged.
- [ ] **Step 6: Mutants owed (by hand now; Task 5 records them):**
  - T1: `wouldFit` ignores `directoryBytes` → `zip.test.ts` "counts the central directory".
  - T2: the builder ignores `max_rows_per_table` in `p_limit` and in the cut → C1 (c) and (d).
  - T3: the failure path skips `removeClosureParts` → C7.
  - T4: `effectiveLimits` takes the max → the unit "an override cannot loosen".
  - T5: the cut sets `after` to the page's last key instead of the last written row's → C1 (e), with rows missing.
  - T6: the re-queue omits `resume_cursor` → C6. The database refuses `illegal_export_transition`, so the job fails.
- [ ] **Step 7: Commit and push.** Message: "Build a closure backup in parts, one bounded part per claim".

---

### Task 3: Download a part, audit it, hold the purge for every part, purge every part

**Files:**
- Create:
  - `supabase/migrations/20261101001000_closure_backup_parts_download_and_purge.sql`;
  - `tests/integration/export/export-bucket-functions-census.test.ts`.
- Modify:
  - `supabase/tests/rls_q228_closure_backup_parts.sql`: sections QD, QO, QX and QM;
  - `supabase/tests/run-rls-tests.sh`: the new pin and red-section lines;
  - `supabase/tests/rls_phase8_exports.sql`: XG15 names `public.audit_export_download(uuid,integer)`, and a new XG15b asserts that `to_regprocedure('public.audit_export_download(uuid)') is null`; re-pin `xp`;
  - `lib/export/download.ts`;
  - `app/(app)/account/exports/[jobId]/download/route.ts`;
  - `tests/integration/security/phase7-permission-matrix.test.ts`: re-run it, and update any signature-keyed census of authenticated-executable functions to `(p_job_id uuid, p_part integer)` if one keys on the signature.

**Interfaces:**
- Consumes: Task 1's tables and Task 2's `exportStorageKey(jobId, part)` and `parsePartParam`.
- Produces:
  - `public.audit_export_download(p_job_id uuid, p_part integer default 1) returns void`, with EXECUTE for `authenticated` only. The `(uuid)` form no longer exists. Its new refusal, after the existing four, is `export_part_not_found` (22023), raised when `p_part is null or p_part < 1`, or when `p_part > 1` and no part row `(p_job_id, p_part)` exists. It audits `after = {kind, part}`.
  - `private.closure_backup_owed(uuid)`: the same signature.
  - `public.retention_object_manifest(uuid, integer)`: the same signature.
  - `issueExportDownloadUrl(jobId: string, part: number = 1): Promise<ExportDownloadOutcome>`.

- [ ] **Step 1: Write the failing sections.** Fixtures:
  - J3, a succeeded 3-part closure backup of a closed org S owned by Owner S. Plant it in the legal order as `postgres` (claim, part, re-queue, three times, then succeed with `part_count = 3`). Plant the part objects as `storage.objects` rows only where a section needs them.
  - K, the ordinary succeeded account export.
  - **QD (the audit RPC), as Owner S unless stated:**
    - QD1: `audit_export_download(J3)` succeeds, and the newest audit row has `after = {"kind":"workspace","part":1}`.
    - QD2: part 2 succeeds with `after.part = 2`.
    - QD3: K with no part gives `after.part = 1`.
    - QD4: part 4 → `export_part_not_found`; part 0 and part −1 → `export_part_not_found`; `p_part => null` → `export_part_not_found`; K part 2 → `export_part_not_found`.
    - QD5: Admin S2 of the same workspace, part 2 → `not_your_export`. That is the IDOR term, not the part check, and it is the reason this suite has a second member.
    - QD6: an expired J3 → `export_archive_expired`; a failed job → `export_has_no_archive`. Both are rolled back.
    - QD7: each refusal wrote no audit row (the count is unchanged across QD4–QD6).
    - QD8: EXECUTE is `authenticated` only, and the `(uuid)` overload is gone.
  - **QO (Q229 waits for every part).** Delete S through `delete_closed_workspace` as the aal2 superuser (the CH1 pattern).
    - QO1: no downloads → `closure_backup_owed(S)` is true.
    - QO2: after parts 1 and 2 → still true. That is mutant M12's assertion.
    - QO3: after part 3 → false.
    - QO4: a legacy closure backup (0 parts, planted `succeeded` as CH0a does) with one download audit row that has **no** `part` key → false.
    - QO5: parts 1–3 downloaded by Admin S2 (planted audit rows with `actor_user_id = S2`) do not release it; still true.
    - QO6: 30 days after the decision (backdate `retention_expires_at` the CH8 way) → false, whatever was downloaded.
    - QO7: a live sweep probe (`cw.live_sweep_probe` shape, rolled back) holds S while it is owed and purges it once QO3 holds.
  - **QX (delete without a backup, spec § 7):** org T, closed, with its closure backup re-queued with 2 parts stored:
    - QX1: `delete_closed_workspace('t', 'r')` → `decision_backup_not_succeeded`;
    - QX2: with `true`, it proceeds, and the audit row has `backup_status = 'queued'` and `acknowledged_no_backup = true`;
    - QX3: T's backup `expires_at` was not raised. The raise is for a succeeded backup only.
  - **QM (the retention manifest).** Use the RW5a probe pattern: plant `storage.objects` rows with `created_at = now() - interval '2 days'`, `start_retention_run(true)`, read `retention_object_manifest(run, 500)`, raise the result out, and roll back.
    - QM1: J3 expired (`expires_at` in the past) → all 3 part keys named, reason `export_expired`, each once.
    - QM2: J3 unexpired and succeeded → none of its 3 keys named, either as `export_expired` or as `orphan`. That is mutant M14's assertion and the CRITICAL one (Spec correction 2).
    - QM3: a re-queued closure job's 2 part objects → not named.
    - QM4: a failed closure job with 2 part rows left behind → both keys named `orphan`.
    - QM5: an object `exports/<random uuid>-part-0002.zip` that no row names → named `orphan`. That is the positive control that the orphan half still runs.
    - QM6: the erasure manifest for Owner S's account (`erasure_purge_manifest` on a planted account erasure job) names none of J3's keys. Q206 is unchanged.

- [ ] **Step 2: Run them and see them red.** QD1 fails because `p_part` does not exist, and QO2 and QM2 must be red against the old functions.
- [ ] **Step 3: Write the migration.** The header names the sources:
  - `audit_export_download` from `20260927005000:26`;
  - `closure_backup_owed` from `20261029002000:55`;
  - `retention_object_manifest` from `20261005000000:268`.

  **`audit_export_download`:**
  ```sql
  drop function public.audit_export_download(uuid);
  create function public.audit_export_download(p_job_id uuid, p_part integer default 1)
  returns void language plpgsql volatile security definer set search_path = '' as $$
  declare v_job public.export_jobs%rowtype;
  begin
    -- (1)-(4) verbatim from 20260927005000: no session 28000; not_your_export; export_has_no_archive; export_archive_expired
    if p_part is null or p_part < 1
       or (p_part > 1 and not exists (select 1 from public.export_job_parts p
                                       where p.job_id = v_job.id and p.part_no = p_part)) then
      raise exception 'audit_export_download: that export has no such part'
        using errcode = '22023', hint = 'export_part_not_found';
    end if;
    perform private.log_audit_event(
      p_action => 'export_job.downloaded', p_target_type => 'export_job',
      p_organisation_id => v_job.organisation_id, p_target_id => v_job.id,
      p_after => pg_catalog.jsonb_build_object('kind', v_job.kind, 'part', p_part));
  end $$;
  revoke all on function public.audit_export_download(uuid, integer) from public, anon, service_role;
  grant execute on function public.audit_export_download(uuid, integer) to authenticated;
  comment on function public.audit_export_download(uuid, integer) is '...';
  ```

  **`private.closure_backup_owed`.** Rebuilt; the lateral also selects `j.part_count`, and the final `not exists` is replaced by:
  ```sql
  and exists (
    select 1 from pg_catalog.generate_series(1, greatest(b.part_count, 1)) n
     where not exists (
       select 1 from public.audit_events a
        where a.organisation_id = o.id
          and a.action = 'export_job.downloaded'
          and a.target_type = 'export_job'
          and a.target_id = b.id
          and a.actor_user_id = b.requested_by
          and (case when (a.after ->> 'part') ~ '^[0-9]{1,9}$'
                    then (a.after ->> 'part')::integer else 1 end) = n))
  ```
  Reissue its `comment on function` with the Q238 default in words. Keep the EXECUTE revoke.

  **`public.retention_object_manifest`.** Rebuilt with two changes and nothing else:
  - `expired_exports` gains `union all select 'exports', p.storage_key, 'export_expired', j.expires_at from public.export_job_parts p join public.export_jobs j on j.id = p.job_id where p.part_no >= 2 and j.expires_at is not null and j.expires_at < now()`. Part 1's key is the job's `storage_key`, already named.
  - `orphans` gains `and not exists (select 1 from public.export_job_parts p join public.export_jobs j on j.id = p.job_id where p.storage_key = s.name and s.bucket_id = 'exports' and j.status <> 'failed')`.

  Reissue the function comment: six sources, and the parts sentence.
  - If `private.assert_retention_clocks()` or `rls_phase8_retention.sql` RK26 names a new date column reached by these functions, classify it in `private.retention_clock_columns()` (live in `20261030003000:1553`) in this migration, with a `clock`/`not_a_clock` reason. It should name none: the new reads are `part_count`, `storage_key`, `status` and `after`.
- [ ] **Step 4: Change the route and the download path.**
  - **`route.ts`:** `GET(request, ctx)` reads `new URL(request.url).searchParams.get("part")` and calls `parsePartParam`. `null` gives the literal 404 before any lookup. Otherwise it calls `issueExportDownloadUrl(jobId, part)`. Update the header comment's 404 list to "a malformed, zero or missing part".
  - **`download.ts`:** add `part` to the signature. After the job is loaded through the caller's RLS client and `archiveIsDownloadable` holds:
    - for `part === 1`, the key is `data.storage_key`, as today;
    - for `part >= 2`, read `supabase.from("export_job_parts").select("storage_key").eq("job_id", jobId).eq("part_no", part).maybeSingle()` through the **same RLS client**. Never the service client: that is mutant T7. No row gives 404.

    Then `exists()`, then `rpc("audit_export_download", { p_job_id: jobId, p_part: part })`, then sign, in the same order as today. The audit RPC's `export_part_not_found` is unreachable after the RLS read, but if it is ever raised it maps to the 500 branch like any other audit fault. Do not turn it into a 404.
- [ ] **Step 5: Write `export-bucket-functions-census.test.ts`.**
  - Query `pg_proc` for every function in `public`/`private` whose `prosrc` contains `'exports'` and `storage_key`. Assert that the set is exactly the declared roll, each with a reason:
    - `retention_object_manifest`: it names `export_job_parts`;
    - `erasure_purge_manifest` and `erase_account`: each carries `not e.closure_backup` / `not j.closure_backup`, and parts exist only for closure backups (Task 1's CHECK);
    - any other function the query finds, which you add only with a reason.
  - For the first, assert that `prosrc` contains `export_job_parts`. For the other two, assert that it contains `closure_backup`.
  - **Denominator:** the roll is not empty, and `retention_object_manifest` is in it.
- [ ] **Step 6: Run everything twice on one database.** Run the psql runner twice, then `pnpm exec vitest run tests/integration/security tests/integration/export tests/integration/retention`, `pnpm lint` and `pnpm typecheck`.
- [ ] **Step 7: Mutants owed:**
  - M12: `closure_backup_owed` checks part 1 only, i.e. the old predicate → QO2.
  - M13: `closure_backup_owed` drops `actor_user_id = b.requested_by` → QO5.
  - M14: drop the parts term from `orphans` → QM2 and QM3.
  - M15: drop the expired-parts union → QM1.
  - M16: the orphan exemption also keeps failed jobs' parts → QM4.
  - M17: `audit_export_download` drops the part-exists check → QD4.
  - M18: `audit_export_download` drops `requested_by = auth.uid()` (this replaces the stale `mutations/10`) → QD5, plus the matrix "cannot audit-and-download a job that is not theirs".
  - T7 (e2e, Task 4 measures it): `download.ts` reads the part row with the service client → `closure-backup-parts.spec.ts` "an Admin of the same workspace gets the same 404 for part 2".
- [ ] **Step 8: Commit and push.** Message: "Download and audit each part, hold the purge for every part, purge every part".

---

### Task 4: The page: the parts list and Contact us

**Files:**
- Modify:
  - `lib/export/jobs.ts`;
  - `components/account/export-job-list.tsx`;
  - `app/(app)/[orgSlug]/settings/export/page.tsx`;
  - `lib/org/closure-contract.ts` (the copy and the mailto builder; a pure module);
  - `tests/e2e/support/fixtures.ts`.
- Create:
  - `tests/e2e/closure-backup-parts.spec.ts`;
  - `tests/unit/org/closure-contact.test.ts`.

**Interfaces:**
- Consumes: Task 3's route `GET /account/exports/{jobId}/download?part=N` and Task 1's tables.
- Produces:
  - In `lib/export/jobs.ts`:
    - `OwnExportJob` gains `closureBackup: boolean` and `partCount: number`;
    - `getLatestClosureBackup(organisationId: string): Promise<OwnExportJob | null>`: own RLS, `closure_backup`, newest first, limit 1, and it throws on a query error like `getOwnExportJobs`;
    - `getExportJobParts(jobId: string, fromPart: number, limit = PARTS_PAGE_SIZE): Promise<{ parts: { part: number; byteSize: number }[]; nextFrom: number | null }>`: own RLS, keyset `part_no >= fromPart order by part_no limit limit + 1`;
    - `PARTS_PAGE_SIZE = 50`.
  - In `lib/org/closure-contract.ts`:
    - `CLOSURE_BACKUP_FAILED_LINE = "Your backup could not be built. Contact us and we will help you get a copy of your data."`;
    - `closureBackupHelpHref(address: string | null, slug: string, jobId: string): string`. With an address it returns `mailto:${address}?subject=${encodeURIComponent(`Closure backup failed: ${slug} (job ${jobId})`)}`. Without one it returns `/legal/contact`.
    - `PARTS_TOGETHER_LINE(n: number): string`, which gives "These {n} parts together are the whole backup. Part {n} holds the index (its manifest.json lists every part)."
  - `ExportJobList` gains an optional prop `parts?: Record<string, { parts: readonly { part: number; byteSize: number }[]; nextFrom: number | null; total: number }>` and an optional `partsHref?: (jobId: string, from: number) => string`.

- [ ] **Step 1: Write the failing unit test** `closure-contact.test.ts`:
  - `closureBackupHelpHref("help@example.com", "acme", id)` is exactly `mailto:help@example.com?subject=Closure%20backup%20failed%3A%20acme%20(job%20<id>)`;
  - `closureBackupHelpHref(null, ...)` is `/legal/contact`;
  - the subject carries only the slug and the id.
- [ ] **Step 2: Write the failing e2e spec** `closure-backup-parts.spec.ts`, serial, with its own world.
  - **Fixture extension.** `plantOwnerClosedWorkspace(label, owner, member, opts?: { backup?: "failed" | "two_parts" })`. Inside the **same transaction** as the close, after `reset role` and `select set_config('request.jwt.claims', '', true)`, so no runner nudge or cron tick can race it:
    - `failed`: `update export_jobs set status='failed', failure_reason='E2E: the backup could not be built' where id = <job>`. A queued → failed move is legal for a server session.
    - `two_parts`: claim it (`status='running'`), insert part 1, re-queue (`queued`, `part_count 1`, `resume_cursor '{"v":1}'`), set `running`, insert part 2, then succeed with `storage_key` part 1, `part_count 2`, `byte_size`, `row_count`, `table_count 0` and `manifest` set to a minimal index `{"schemaVersion":3,"parts":[...],"indexPart":2,"withheld":[],"notes":[]}`.
    - After commit, upload two tiny valid zips (the `plantReadyAccountExport` empty-zip bytes) to both keys.
    - Teardown removes both objects and the download audit rows.
  - **Test 1, failed backup:**
    - Owner (world owner, real TOTP sign-in) opens `/<failedSlug>/settings/export`.
    - `getByTestId("closure-backup-failed")` contains `CLOSURE_BACKUP_FAILED_LINE`.
    - The link `getByRole("link", { name: "Contact us" })` has an `href` that is EITHER `mailto:` with `subject=` containing the slug and the job id, OR `/legal/contact` (the `legal.spec.ts:194` either-branch pattern).
    - Axe scan in this state.
    - **The denominator:** on `/<twoPartSlug>/settings/export` (a succeeded backup), the Contact us link count is 0.
    - The world Manager (`member`), on `/<failedSlug>/settings/export`, sees no Contact us (count 0) while the page renders its h1.
  - **Test 2, two parts:**
    - Owner opens `/<twoPartSlug>/settings/export`.
    - Two links, `getByTestId("export-part-download")`, with texts matching `/^Part 1 of 2/` and `/^Part 2 of 2/`.
    - `PARTS_TOGETHER_LINE(2)` is visible.
    - Axe scan in this state.
    - `page.request.get(".../download?part=2", { maxRedirects: 0 })` → 302, with a `Location` on the storage host, and `countExportDownloadAudit(job)` goes up by exactly 1. Assert the new row's `after ->> 'part'` = `'2'` through a new fixture `exportDownloadParts(jobId): Promise<number[]>`.
    - **404 parity:**
      - `?part=0`, `?part=3`, `?part=abc`, `?part=` and `?part=-1` each return status 404 with the body `"Not found"`, identical to the ghost job id `00000000-0000-4000-8000-000000000000` with `?part=2`;
      - the audit count is unchanged after all six;
      - the world Admin (or Manager), signed in in a second context, requests `?part=2` on the Owner's job and gets the same 404 body, and the audit count is unchanged. That is mutant T7's assertion.
    - A single-part succeeded job (any existing ordinary export of the world) still renders "Download the archive" and no parts line (the "exactly as today" half).
- [ ] **Step 3: Run them and see them red.** `pnpm exec vitest run tests/unit/org/closure-contact.test.ts`, then the single spec: `pnpm exec playwright test tests/e2e/closure-backup-parts.spec.ts`. Check first that no other worktree's dev server or Playwright is running.
- [ ] **Step 4: Implement.**
  - **`jobs.ts`:** add `closure_backup, part_count` to `COLUMNS` and to the mapping, plus the two readers above. Both are bounded (`limit 1`; `limit + 1`).
  - **`page.tsx`:**
    - Read `searchParams` (`PageProps` carries it) for `partsFrom`, validated by `parsePartParam` and defaulting to 1.
    - `const latestClosure = isOwner && ownerClosed ? await getLatestClosureBackup(org.id) : null`. Fetch with `Promise.all` alongside the job list, so there is no waterfall.
    - For every listed job with `partCount > 1` (at most `OWN_EXPORT_LIMIT`), `getExportJobParts(job.id, partsFrom)`, also in `Promise.all`. Pass the results to `ExportJobList`.
    - In the `ownerClosed` statement block, when `latestClosure?.status === "failed"`, render `<div data-testid="closure-backup-failed">` with the line plus an `<a>` "Contact us". Its `href` is `closureBackupHelpHref(supportContact().address, org.slug, latestClosure.id)`, and its classes copy the `secondary` button variant (`inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink hover:border-ink hover:bg-shell`), with a comment pointing at `components/ui/button.tsx`. No `target`, no new colour.
    - Import `supportContact` from `@/lib/legal/contact` (server-only, which is fine in this server component).
  - **`export-job-list.tsx`.** When `job.partCount > 1` and the job is downloadable, render:
    - a `<ol>` of `<li><Link href={`/account/exports/${job.id}/download?part=${p.part}`} prefetch={false} data-testid="export-part-download">Part {p.part} of {job.partCount} · {humanBytes(p.byteSize)}</Link></li>`, with `tabular-nums` on the numbers;
    - then `PARTS_TOGETHER_LINE(job.partCount)`;
    - and, if `nextFrom`, a link "Show parts {nextFrom} to {min(nextFrom+49, partCount)}" to `partsHref(job.id, nextFrom)`.

    Otherwise render exactly today's single "Download the archive" link.
  - **Verify, do not widen:** load the page for a workspace in lifecycle `deleted` (a closure-deleted one, through the fixture plus `delete_closed_workspace`) as its Owner. If it does not render the backup, record that in the task report and in Q239's text (Spec correction 11). Do not change routing.
- [ ] **Step 5: Run until green.**
  - `npx next typegen`, then `pnpm typecheck`, `pnpm lint` and the unit test.
  - The new spec, alone, then together with `workspace-closure.spec.ts`, `exports.spec.ts`, `super-closures.spec.ts` and `phase8-refusal-parity.spec.ts`.
- [ ] **Step 6: Run the review skills** on the diff: `web-design-guidelines` and `accessibility-compliance` (WCAG 2.2 AA: the link name, focus ring, contrast through tokens, and that the parts list is a real list). Fix whatever they find before committing.
- [ ] **Step 7: Commit and push.** Message: "List a closure backup's parts and offer Contact us when it failed".

---

### Task 5: Docs, the questions, the mutation run and the full gates

**Files:**
- Modify:
  - `CLAUDE.md`:
    - § Current state: one sentence for Q228;
    - the e2e row of the gates table: the new spec, its two axe scans, and the new test total, measured;
    - a short "Closure backups, as they shipped for Q228" paragraph covering:
      - parts only for closure backups (Q237);
      - per-part ceilings with no total;
      - one part per claim;
      - Q238's "every part";
      - Contact us is a link, not a form;
      - the orphan-sweep exemption;
      - the two residual bounds (Spec correction 8).
  - `SECURITY.md`: the export/closure paragraph (the § beside line 338). State the part download's authorisation order, the dropped `(uuid)` overload, the orphan exemption and why it is CRITICAL, and the Q229 change.
  - `FOLLOW-UPS.md`, a Q228 section:
    - the legal page sentence "The archive is a zip" is now inexact for a multi-part closure backup and is counsel's to change (`20260927008000:67`);
    - the two residual bounds;
    - a failed backup still cannot be re-queued (unchanged, Q228 (c)).
  - `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`:
    - **Q237** and **Q238**, as written in the spec, with their defaults;
    - **Q239**: the closure copy promises `/account/exports`, which lists no closure backup. Default: keep the copy and list a requester's closure backups on `/account/exports` in a later branch;
    - Q228's status line becomes "BUILT on `q228-closure-backup-parts`".
  - `supabase/tests/mutations/10-export-download-authorisation.sql`: regenerate it from the live `(uuid, integer)` definition with the IDOR term removed (M18), keeping the header shape.
- Create:
  - `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/mutation-results/q228/mutants.py`, `clean.sql`, `README.txt` and `results.txt`, modelled on `mutation-results/phase9/`.

- [ ] **Step 1: The mutation run.**
  1. Reset the database.
  2. Run the control: the `qp` suite green, at its pin.
  3. For each SQL mutant M01–M18, apply it to the live database (latest `pg_get_functiondef` with one change, or one DDL statement), run the `qp` suite (plus `xp` for M18, and the closure suite `cw` for M12 and M13), record the named red assertions, and restore it in `finally`.
  4. Run the control again. It must be 0 red before and after.

  For the TypeScript mutants:
  - T1–T6: edit the source, run the named Vitest file, and revert with `git checkout -- <file>`;
  - T7: apply it and run only `closure-backup-parts.spec.ts`.

  Record each mutant as `mutant | change | red assertions`. **A mutant that reddens nothing is CRITICAL:** add the missing assertion, re-pin, and re-run that mutant before going on.
- [ ] **Step 2: The five gates, each preceded by a reset where the database matters.** Run them detached with `nohup`, write logs to the ledger directory, and read the logs. Check for other worktrees' processes first.
  - `pnpm lint`;
  - `npx next typegen && pnpm typecheck`;
  - `npx supabase db reset --local && pnpm test`;
  - `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh`, twice in a row without a reset between the two runs of the same suites (every suite must re-run cleanly);
  - `npx supabase db reset --local && pnpm test:e2e`.

  A refusal-parity or palette timeout under memory pressure is re-run in isolation and recorded. It is never retried in config.
- [ ] **Step 3: Write `task-5-report.md`.** Include the gate totals, the mutation table, the final pins and any Q added. Append the Q228 line to `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/progress.md`.
- [ ] **Step 4: Commit and push.** Message: "Document Q228, queue Q237-Q239 and record its mutation results".
