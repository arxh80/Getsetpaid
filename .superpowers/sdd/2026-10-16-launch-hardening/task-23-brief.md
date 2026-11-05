wrote /c/Users/archi/Documents/Work/Portfolio/Getsetpaid/.claude/worktrees/launch-hardening/.superpowers/sdd/2026-10-16-launch-hardening/task-23-brief.md: 27 lines
tarter, 20 for Pro, `20260826151656_foundation_schema.sql:130`) is read by nothing except the tier tests and the health page. `uploadDocumentAction` (`lib/crm/documents.ts:148-170`) stores bytes with no quota check. One Starter user can upload 10 files of 25 MiB per hour, about 6 GiB a day, and nothing refuses. `SECURITY.md:246` relies on this quota as the bound on upload abuse.

**Files:**
- Create: `supabase/migrations/<next timestamp>_storage_quota_is_enforced.sql`
- Modify: `lib/crm/documents.ts` (map the new refusal to a sentence), a psql suite (the documents/file suite that already covers `public.documents`, with its pin), `SECURITY.md` § 5 (line 246) and § 6, `docs/launch-gates.md` (new row **G35, Medium**)
- Test: the psql assertions, and `tests/integration/documents/upload-quota.test.ts`

**Coordinator decisions:**
1. **One `BEFORE INSERT` trigger on `public.documents` is the control.** It binds every writer, and `uploadDocumentAction` already removes the stored bytes when the row insert fails. The trigger:
   - takes `pg_advisory_xact_lock` on the organisation, so two parallel uploads cannot both pass the last free bytes
   - compares the workspace's existing `size_bytes` total plus `new.size_bytes` against the EFFECTIVE plan's limit (`private.effective_organisation_plan()`, so billing overrides count)
   - raises 42501 with hint `storage_quota_exceeded` when the total would pass the limit
   
   Count soft-deleted documents too, because their bytes stay until the retention sweep (Q52). A NULL limit means unlimited.
2. No app-side pre-check. An over-quota upload still sends its bytes to Storage once and then removes them, which is bounded by the 10-per-hour upload budget. Mark this in the action with `shortcut: an over-quota upload transfers its bytes once before the refusal, bounded by the 10/hour budget; add a pre-check RPC if storage egress cost shows up`.
3. A downgrade never deletes. An organisation over its new limit keeps every file, and only new uploads are refused. Feedback screenshots and export archives are not counted (they are platform-scoped and short-lived).
4. **The custom-field limit race, in the same task:** `private.enforce_custom_field_limit()` (`20260829010500`, whose header says "IT DOES NOT SERIALISE") gets the same per-organisation advisory lock before its count. Rebuild it from the live `pg_get_functiondef`.

- [ ] **Step 1: Failing tests.** psql: a Starter workspace at (limit − 1 byte) inserting a 2-byte document is refused with the hint; at the limit exactly, a 0-byte insert is accepted; a Pro workspace (or a billing override to Pro) is accepted; a soft-deleted document still counts. Integration: the real `uploadDocumentAction` over quota returns the quota sentence, and neither a row nor an object remains. Red first.
- [ ] **Step 2: The migration and the sentence.**
- [ ] **Step 3: Mutants.** Drop the trigger, and the psql refusal goes red. For the lock: if a concurrent test in the house style (see the rate-limit concurrency test cited in `20260909090000`) can show the race without the lock, use it as the mutant. Otherwise assert the lock's presence from `pg_get_functiondef`, and say so in the report.
- [ ] **Step 4: Gates.** Fresh reset + full psql runner, lint, typecheck, `pnpm test`, `documents.spec.ts` with `--workers=1`. Docs. Commit per logical change, push.

---

