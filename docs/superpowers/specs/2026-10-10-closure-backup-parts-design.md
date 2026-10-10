# A closure backup of any size, in parts (Q228) — design

**Status:** design, 2026-10-10. Founder ruling Q228 CHANGED (2026-10-10). Built under the SDD loop on branch `q228-closure-backup-parts` off `main` (`a75ef1b`). New migrations sort after `20261031000000` (Q189's), starting at `20261101000000`.

## What the founder asked for

1. **A "Contact us" button** on the Owner's closure screen when the closure backup has failed. It points to the single support contact (`SECURITY.md` § 13).
2. **The Owner can download a backup of any size.** CLAUDE.md's "exports are async and bounded" rule still holds. The planned shape is a **multi-part** closure backup: every part stays within today's per-archive ceilings, the number of parts is not capped, and each part is downloadable and audited the same way. A size ceiling never fails the backup; the backup is split instead.
3. **Keep "Delete without a backup"**: the audited acknowledgement already built in `20261028002000`.

## Today

- **One closure backup is one `export_jobs` row** (`kind = 'workspace'`, `closure_backup = true`). It is built by `lib/export/runner.ts` `buildAndStore()` into **one** zip at `exportStorageKey(jobId)`.
- **The build fails at any of the `private.export_limits()` ceilings:**
  - 50 000 rows in one table;
  - 500 000 rows in total;
  - 40 MiB of archive (`ZipWriter`);
  - 65 535 zip entries.
- **A job is built in one claim.** The 60-second wall-clock budget is checked only between jobs.
- **The Owner downloads** through `GET /account/exports/[jobId]/download` (`lib/export/download.ts`). That route checks RLS (`export_jobs_select_own`), expiry and object existence, and audits `export_job.downloaded` through `public.audit_export_download()`. Only then does it mint a 60-second signed URL.
- **Q229's purge hold** (`private.closure_backup_owed()`) keeps a deleted closed workspace's backup until the requester has downloaded it (an `export_job.downloaded` row by them) or 30 days have passed.
- **The Owner's closure screen** is `/[orgSlug]/settings/export`, which stays readable in an `owner_closed` workspace. Its job list (`components/account/export-job-list.tsx`) shows the closure backup, including a failed one and its `failure_reason`.

## Design

### 1. Scope: closure backups only

**Only a `closure_backup = true` job is built in parts.** Ordinary workspace and account exports keep today's fail-at-ceiling behaviour.

There are two reasons:

- **The data is stable.** A closure backup reads a workspace that is closed and read-only for everyone, so parts built across several runner claims describe one consistent state. An ordinary export of a live workspace built over several claims would not.
- **This is what Q228 asked for.**

**Q237** queues whether ordinary exports should follow. Default: no.

### 2. A part is today's archive, bounded by today's ceilings

- **Each part is a complete zip.** It carries its own `manifest.json`, so a part opened alone says what it is.
- **Each part is bounded by the same ceilings**, read from `private.export_limits()`:
  - at most `max_rows_per_table` rows of any one table;
  - at most `max_total_rows` rows;
  - at most `max_archive_bytes` bytes;
  - at most 65 535 entries.
- **The writer closes a part BEFORE a ceiling would be passed**, instead of throwing. The next part starts where it stopped.
- **A table larger than the per-part row ceiling is split** at keyset boundaries into `tables/<table>.json` slices, one per part. The part manifest names the slice by its first and last key and its row count.
- **A document's bytes are never split.** `DOCUMENT_MAX_SIZE_BYTES` (25 MiB) is below `max_archive_bytes` (40 MiB), so one file always fits in a fresh part. A unit test pins `DOCUMENT_MAX_SIZE_BYTES + manifest headroom < max_archive_bytes`, so raising the upload cap past the part ceiling is red rather than an unbuildable backup. The feedback-screenshot cap is pinned the same way.
- **The per-part ceilings are the only ceilings.** There is no total size cap and no cap on the number of parts.

### 3. One part per claim: resumable and bounded

- **A claim builds at most one part, then puts the job back.** The runner claims a closure-backup job, builds and stores the next part, records it, and returns the job to `queued` with a persisted resume cursor. The same runner invocation may claim it again within its job and wall-clock budgets, so a small backup still finishes in one invocation.
- **Every unit of work is bounded:** one part, under the ceilings above. That is what keeps "async and bounded" true with no total cap.
- **New `export_jobs` columns, written only by service_role through the existing grant pattern:**
  - `part_count int`: parts stored so far;
  - `resume_cursor jsonb`: the plan index, the key to read after, rows of the current table already written, and the running totals.
- **The final part is the one whose plan is exhausted.** Storing it stamps the job `succeeded` with these totals:
  - `byte_size`: the sum over parts;
  - `row_count`: the sum over parts;
  - `table_count`;
  - `manifest`: the **index**, listing every part with its key, bytes, rows and the tables and slices it holds, plus the usual `withheld` and `notes`.
- **The stuck-job reaper (`private.reap_stuck_jobs()`) must not fail a healthy multi-part job.** Each claim re-stamps `started_at`, so "stuck" means one claim running over an hour, never a whole backup over an hour. The plan's task must verify this against the reaper's actual predicate.
- **A failure while building one part fails the whole job**, as today. The parts already stored are deleted, so no partial backup is presented as a backup. Resuming a failed job is out of scope, consistent with Q228 (c), which has no re-queue.

### 4. Where parts live

**New table `public.export_job_parts`:**

| Column | Type | Notes |
|---|---|---|
| `job_id` | uuid | FK `export_jobs` ON DELETE CASCADE |
| `part_no` | int | ≥ 1 |
| `storage_key` | text | |
| `byte_size` | bigint | |
| `row_count` | bigint | |
| `created_at` | timestamptz | |

- **Constraints:** primary key `(job_id, part_no)` and an index on `job_id`. The FK has its own index through the primary key's leading column.
- **RLS is on before any grant.**
  - **SELECT:** only when the parent job is the caller's own (`export_jobs.requested_by = auth.uid()`). This is the same rule as `export_jobs_select_own`, which the policy reuses rather than restates where it can.
  - **No client write.** service_role gets INSERT and DELETE only.
- **Storage keys** are `exportStorageKey(jobId)` for part 1, so a single-part closure backup is byte-for-byte where it is today, and `exportStorageKey(jobId, n)` (a `-part-NNNN` suffix) for n ≥ 2. They are derived and never user-supplied.
- **The job row's `storage_key` stays part 1's key.** Every existing reader (the download route, the ready-notification, `/super/closures`) keeps working for part 1 with no change.
- **Every place that deletes or expires an export archive deletes every part's object:** the expiry purge, the erasure path, the closure-delete purge and Q229's release. Each one is found and changed. A census test asserts that no code path removes `exportStorageKey(job)` without also removing the parts.
- **`export_job_parts` joins every catalogue a new table must join:**
  - the privilege census;
  - the RLS-on census;
  - the audit coverage census (it has no client write, so it is outside the denominator, and the census proves that);
  - the export catalogue (a declared disposition);
  - the retention catalogue (it cascades with its job);
  - the FK-less identifier roll, if it applies.

### 5. Downloading a part

- **`GET /account/exports/[jobId]/download?part=N`** with N ≥ 1 and no `part` meaning 1. It uses the same handler and the same order as today: identity, then RLS read of the job and the part row, then succeeded and not expired, then the object exists, then the audit row, then a 60-second signed URL.
- **Every refusal is the indistinguishable 404**, including a part number that does not exist, is malformed, or is out of range.
- **The audit row is `export_job.downloaded` with `after.part = N`.** `public.audit_export_download(p_job_id uuid, p_part int default 1)` is the same function with one more argument. It re-asks `requested_by = auth.uid()` and that the part exists. This is not a new action name.
- **Q229's "downloaded" means every part downloaded at least once.** `private.closure_backup_owed()` holds the purge until the requester has an `export_job.downloaded` row for each `part_no` 1..`part_count`, or the 30-day hold has passed. **Q238** queues this. Default as described: anything less would release the purge after the Owner took part 1 of 12.
- **The job list shows one download link per part** for a multi-part closure backup ("Part 3 of 12 · 38.2 MB"), each a plain link to the route, plus one line saying the parts together are the whole backup and which part holds the index. A single-part backup renders exactly as today.

### 6. "Contact us" on a failed closure backup

- **When it shows:** on `/[orgSlug]/settings/export`, when the workspace is `owner_closed` and its latest closure backup is `failed`. The closed-workspace statement then gains a short line ("Your backup could not be built. Contact us and we will help you get a copy of your data.") and a **Contact us** button.
- **Where it points:** `mailto:` the support contact from `lib/legal/contact` (`supportContact()`), with the subject pre-filled with the workspace slug and the job id. Identifiers only, no record content.
- **When no contact is configured,** it falls back to `/legal/contact`, the same pattern `/account/data-requests` uses.
- **Only the Owner sees it,** under the same `isOwner` term as the closure section. An impersonating superuser does not.
- **It is a link, not a form.** Nothing is written and there is nothing to audit.
- **Styling:** `DESIGN.md` tokens; a bordered button, with no new colour.

### 7. "Delete without a backup" stays

- **No change to `delete_closed_workspace()`'s acknowledgement path.**
- **A multi-part backup counts as `succeeded` only when its last part is stored.** A closure backup still being built (`queued`, with parts already stored) is refused the same way a running one is today (`decision_backup_not_succeeded`), unless the superuser acknowledges.
- **The closure suite gains assertions** that the checkbox path still works and that an in-progress multi-part backup is treated as not succeeded.

### 8. What is unchanged

- **Every row in every part is still read under the closing Owner's rights** through `public.export_read_page()`, with the closure marker as today. Parts change how the rows are written, never which rows exist.
- **The account export and the ordinary workspace export are unchanged.**
- **No new audit action names.** `export_job.downloaded` gains a `part` key in `after`.

## Testing

- **psql** (a new suite `rls_q228_closure_backup_parts.sql`, or new sections in the closure suite, whichever the plan finds cleaner, each pinned):
  - the `export_job_parts` RLS: own job yes; another person's no; no client write;
  - `audit_export_download` with a part, and its refusals;
  - `closure_backup_owed` releasing only when every part has been downloaded;
  - the resume-cursor columns' grants;
  - the reaper's treatment of a re-claimed job;
  - the delete-without-backup path with an in-progress multi-part backup;
  - the purge path removing part rows.
- **Every guard gets a mutant** that turns a named assertion red.
- **Vitest:**
  - `ZipWriter` closing a part before each ceiling;
  - a planted closure backup over every ceiling (rows per table, total rows, bytes, entries), built end to end against the local stack with small ceilings injected, producing N parts whose union equals the source rows exactly, with no duplicates and none missing across slice boundaries;
  - the download route's part handling and 404 parity;
  - the storage-key derivation;
  - the census for archive deletion.
- **Playwright:**
  - the Owner of a closed workspace with a failed closure backup sees Contact us and its `mailto:`;
  - a multi-part backup lists each part and downloads part 2 (a 302 to a signed URL);
  - the axe scan of the page in both states.

## Questions queued (DECISIONS-QUEUE)

- **Q237:** should ordinary exports also split into parts? Default: no; only closure backups (stable data).
- **Q238:** what does "downloaded" mean for Q229's purge hold on a multi-part backup? Default: every part downloaded at least once, or the 30-day hold has passed.
