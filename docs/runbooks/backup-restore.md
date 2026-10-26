# Backup and restore

Targets (PRD § 14): **RPO 24 hours, RTO 4 hours.** RPO is the age of the newest backup at the moment of loss. RTO is the time from "we must restore" to "the app serves the restored data".

## 1. The local drill (engineering, any time)

```bash
npx supabase db reset --local          # the drill needs a freshly reset database
bash scripts/backup-restore-drill.sh
```

The drill runs only against the local stack (`docker exec` into `supabase_db_<project_id>`) and never touches a hosted project. It takes the two halves of a backup, a `pg_dumpall --roles-only` and a `pg_dump --create`, then checks:

0. **Roles, in a fresh cluster.** A throwaway container of the stack's own Postgres image loads the roles dump. `export_reader`, the export runner's RLS identity, must exist there with the source's memberships. It is a cluster role, so a database dump alone never carries it.
1. **Restore in place, the way production is restored.** The service containers pause. The live `postgres` database is renamed to `drill_source`, an empty `postgres` with the source's owner, settings and grants is created in the same command, and the dump is restored into it.
2. **Catalogue.** `pg_policies`, table and function grants (compared as sets, with an implicit owner default equal to an explicit one), `cron.job`, the Vault secret names and the database settings all equal the source's.
3. **Rows.** Every table in `public`, `private`, `auth`, `storage`, `cron` and `vault` has the source's row count, except `cron.job_run_details`: pg_cron logs its own runs into the restored database while the drill runs.
4. **Suites.** The services restart against the restore, and `supabase/tests/run-rls-tests.sh` must print "All suites passed".

The original database is always swapped back (a trap), and the script exits 0 only when every check holds.

**Mutant:** `bash scripts/backup-restore-drill.sh --skip-roles-dump` leaves the roles dump out and must fail at check 0.

### Two things the drill learned (2026-10-26)

- **pg_net's worker segfaults if `postgres` is ever missing.** It reconnects about a second after it is terminated. Finding no `postgres` database, `pg_net 0.20.4` crashed the whole server into recovery, twice. That is why the replacement database is created in the same command as the rename, and why `pg_net`'s extension and grants are restored in a second pass. **A production restore over a live database needs the same care:** never leave the database name missing while the server runs.
- **`pg_restore --create` cannot be used for an in-place restore** for the same reason (it needs the name to be absent). The database-level settings it would carry (`app.settings.*`) and the grants are copied from the source instead, and the drill checks them.

### What a database backup does not cover

- **Storage objects.** The files in the `documents`, `feedback-screenshots` and export buckets are not in any database backup, only their metadata rows (`storage.objects`). The drill proves the metadata; G30 (a Storage backup job) covers the files.
- **Secrets outside the database.** `GETSETPAID_SERVER_REQUEST_SECRET`, the runner secrets, and the Brevo and Telegram credentials live in the host's environment (`SECURITY.md` § 15). Vault secret names survive (check 2). A Vault restore into a different project needs that project's encryption key, which only Supabase holds.

### Runs

| Date (UTC) | Result | Elapsed (local RTO measure) |
|---|---|---|
| 2026-10-26 15:39 | PASSED, all five checks (before the cron run-log exclusion) | 399 s |
| 2026-10-26 15:52 | PASSED, all five checks; mutant `--skip-roles-dump` FAILED on `export_reader` as designed | 383 s |

## 2. The production drill (founder action F2)

Before launch, and then every quarter:

1. In the Supabase dashboard, restore the newest backup of the production project into a **new scratch project** in the same region (eu-west-1). Never restore over production for a drill.
2. Record the backup's timestamp. Its age at the time you start is the measured **RPO**.
3. Point a local checkout at the scratch project (`pnpm dev:hosted` with that project's keys) and sign in as a test account. Open a contact, an event and a document's metadata.
4. Restore one **Storage sample** (one object per bucket) from the Storage backup (G30) into the scratch project, and download it through the app.
5. Record the elapsed time from step 1 to step 4. That is the measured **RTO** and must be under 4 hours.
6. Delete the scratch project.

Record each production drill in the table below. Engineering cannot run this: it needs the founder's dashboard access.

| Date | Backup age (RPO) | Elapsed (RTO) | Storage sample | By |
|---|---|---|---|---|
| (not yet run) | | | | |
