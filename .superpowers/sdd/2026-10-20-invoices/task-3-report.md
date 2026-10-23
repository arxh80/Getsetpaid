# Task 3 report: the four tables, the freeze, the SQL arithmetic, the censuses

Status: DONE_WITH_CONCERNS (two plan defects fixed, three censuses the plan missed declared; see below)

Commit: 914579d (base 073089e).

## Built
- `supabase/migrations/20261107000000_invoice_tables.sql` (renumbered from the plan's 20261106000000): the four tables, constraints, indexes, RLS forced, SELECT-only grant to authenticated, the two freeze triggers, `set_updated_at` on two tables, `private.invoice_line_amounts`, `private.format_invoice_number`, `private.build_invoice_snapshot`; and `private.platform_audit_actions()`, `private.retention_subjects()`, `private.export_catalogue()` rebuilt from live `pg_get_functiondef` (each diffed line-for-line IDENTICAL to its latest defining migration first) with only the invoice rows added. Q-numbers cited as Q252 (plan-Q250).
- `supabase/tests/rls_invoices.sql` (70 assertions, pin 70) and `tests/unit/invoices/arithmetic-cases-match-sql.test.ts`.

## TDD
- Binding test RED (ENOENT) before the SQL file existed; GREEN after.
- Suite RED before the migration: `relation "public.invoice_settings" does not exist` at the first fixture.
- First run after the migration: 67/3. Fixed: IT6/IF15 (plan defect: `text || "char"` is ambiguous, 42725; cast `polcmd::text`, `tgenabled::text`); IF5 (plan defect: the freeze checked frozen content before the transition, so issued -> draft answered `invoice_is_frozen`; the transition check now runs first and the dead `else` branch is gone). Then 70/0.

## Mutants (each applied live, suite run, reverted)
1. `'snapshot'` added to `v_moving` -> IF2 red.
2. DELETE guard -> `if false` -> IF11 red (and IF12, whose row IF11 then deleted).
3. Remove `pg_trigger_depth() > 1` from `invoice_lines_freeze()` -> **stayed GREEN** (plan expected IF16). The purge cascade deletes the invoice before its lines, so the line trigger reads no invoice (`v_status is null`) and admits the delete. The branch is defensive only. Substitute 3b: drop the depth clause from `invoices_freeze()`'s DELETE guard -> IF16 red (`denied(42501:invoice_is_frozen)`), IF17 red (1/1/1/1).
4. `invoices_select_view_finance using (true)` -> IR1-IR9 red.
5. `grant update on public.invoices to authenticated` -> IT3, IB2 red.
6. `0.20` -> `0.2001` -> IA1 red (2 of 12 wrong).
7. SQL case row 833 -> 832 -> binding test red.

## Census entries
As planned: L6 34->36; IN10 added (leak pin 225->226); closure backup seed + KS1 37->41 + housekeeping; PLATFORM_AUDIT_ACTIONS +7; PRE_PHASE7_RELATIONS +4; completeness census +4 exported, +2 account-excused, base tables 57->61.
NOT in the plan, red until declared: `rls_phase8_crm_audit_p3_6.sql` PA6c 172->179; `rls_phase8_erasure.sql` EB1/EB2 13->17 NO-ACTION FKs to auth.users (invoices.created_by/paid_by/voided_by, invoice_sends.sent_by); `tests/integration/admin/audit-actions-match-db.test.ts` 172->179; `tests/integration/security/support/privilege-census.ts` +4 `<table>|authenticated|SELECT|*`.

## Gates
- lint clean; `next typegen` ok; typecheck clean.
- psql after fresh reset: all 29 suites "as pinned", "All suites passed", exit 0 (INVOICES 70).
- `pnpm test` after a fresh reset: 186 files passed, 1 skipped; 4133 tests passed, 5 skipped.
- Test logins recreated (test-logins.mjs from scratchpad 8b2911e1...).

## Concerns
- `pnpm test` run straight after the psql script (no reset between) failed `phase7-permission-matrix > export_jobs > no download was audited` (got 1): a psql suite (exports / closure / q228) leaves one `export_job.downloaded` audit row with a deleted actor and null org. It is not from this change and passes on a fresh reset. Gate order matters.
- The erasure re-point through the freeze is proved only by IF14 (direct update). erase_account on an issued invoice is Task 6's § IE.
- SECURITY.md / FOLLOW-UPS.md not touched (the plan does not ask for it in Task 3).
