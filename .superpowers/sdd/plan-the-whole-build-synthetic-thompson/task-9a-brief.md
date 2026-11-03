# Task 9a — Founder rulings 2026-09-30: hosting, region, and four small rulings

These are the founder's direct answers from 2026-09-30. They are rulings, not defaults. Cite "founder 2026-09-30" in every comment, doc line and commit.

Read these first:
- `progress.md` § "Standing lessons" (all of them)
- `DECISIONS-QUEUE.md` § FOUNDER ANSWERS — 2026-09-30
- the Task 4, 5 and 6 reports, for the surfaces this task touches
- `SECURITY.md`

## Requirements

1. **Q142: the app host is an IONOS VPS.** IONOS SE is a German company. The region is "most likely UK" and the server has not been bought yet.
   - Add IONOS to both `docs/sub-processors.md` and `lib/legal/sub-processors.ts`.
   - Mark the region explicitly as PENDING. Do not guess it.
   - The two files must agree. Find the test that binds them, or add one.
   - Remove any assumption the docs make about Vercel or another host.
2. **Q145: the production Supabase region is Ireland (eu-west-1).** Drop the "(deployment setting)" region marker from the database and storage rows.
3. **Republish the legal pages whose text changes.** That means Privacy, DPA, Security and Sub-processors, whichever of them mention hosting or region.
   - Publish each as a NEW immutable version through the shipped publish path. Never edit a published row.
   - If the Q187 v6 wording is still owed, include it in this publish.
4. **Q167 (changed): the account export includes the operator's break-glass reason and the superuser's identity** for every impersonation session that touched the data subject.
   - Update the export contract and the manifest.
   - Update the tests that currently assert this data is absent.
5. **Q184: build the release valve for the audit-purge ceiling.**
   - Superuser only, gated by step-up (aal2).
   - Audited, with a mandatory reason.
   - Lasts **3 days**, then reverts on its own through read-time expiry, like every other override.
   - Mutation-test it.
6. **Q185: a document purged by retention shows "File deleted under the retention policy on <date>"** in place of its Restore control. The server must also refuse Restore on it; hiding the control is not enough.
7. **Q113: uploads are limited to 10 per hour per user, and the 25 MiB cap stays. The limit is enforced at the write.**
   - Add an `uploads` category to the `lib/security/rate-limit.ts` family.
   - The refusal must happen before any byte reaches Storage.
   - Add a test that the 11th upload in an hour is refused and that nothing was stored.

## Discipline

- **Mutation-test every new guard.** Remove it, then record which assertions go red and in which layer. A guard whose removal turns nothing red is a Critical false green.
- **Migrations:** add new ones after the current tip only. Never edit a shipped migration.
- **Registries:** update the pinned psql totals, the permission-matrix inventory and the audit action catalogue for anything new.
- **Gates:** run all five.
  - Run the psql suite TWICE on the same database (lesson 11).
  - Launch e2e detached, and check the log's mtime before trusting it.
- **Commits:** one logical change per commit. Commit and push each one.
- **Report** to `task-9a-report.md`: what changed, the gate numbers, the mutations, and any new Q numbers. The next free number is Q188 unless the queue already goes higher.
