# Task 4 report: draft RPCs, save and soft-delete

Status: DONE (one plan test defect fixed, three assertions added beyond the plan)

Commit: 37c5e90 (base f11ea54).

## Built
- `supabase/migrations/20261107001000_invoice_draft_rpcs.sql` (renumbered from 20261106001000): `public.save_invoice_draft(...)` and `public.delete_invoice_draft(uuid)`, as in the plan text. Both are SECURITY DEFINER with `search_path = ''`. Execute is revoked from public, anon, authenticated and service_role, then granted to authenticated only (ID6).
- `supabase/tests/rls_invoices.sql` § ID: 32 assertions. Pin 87 -> 119, measured with `grep -c '^select inv.val('`.
- `tests/integration/security/phase7-permission-matrix.test.ts`: `MEMBER_REACHABLE_RPCS` += save_invoice_draft, delete_invoice_draft. No other census went red. lifecycle-matches-db and the psql prosecdef checks stayed green.

## TDD
- RED: the suite halted at the first `save_invoice_draft ... \gset`, `function ... does not exist`.
- First run after the migration: 115/1. ID18 was red. This was a plan defect: `(select id from public.events where organisation_id = org_b)` ran as A's caller, read null under RLS, and SAVED a draft with no event. Fixed with a fixture event `ev_b`, named by its literal id.

## Beyond the plan
- ID30/ID31: with no session, save and delete are refused `28000:not_authenticated`. Without this, the session guard had no observable test (mutant M15/M16).
- ID32: another workspace's company as recipient. ID10 covered only the contact half of the recipient check.

## Mutants (each applied live, suite run, original restored, all green after)
M1 save plan check -> ID22, ID24 | M2 VAT normalisation -> ID25 | M3 `category = 'income'` -> ID7 | M4 `status = 'draft'` in the save update -> ID15 (now invoice_is_frozen) | M5 100-line cap -> ID11 | M6 quantity shape regex -> ID12 (1.005 saved) | M7 line exception mapping -> ID13, ID14 (raw 23514) | M8 one-recipient check -> ID9 (raw 23514) | M9a contact org scope -> ID10 (23503) | M9b company org scope -> ID32 (23503) | M10 event-live check -> ID18 (23503) | M11 entry-on-this-event -> ID8 | M12 save update org scope -> ID16 (it OVERWROTE B's draft from A) | M13 save update deleted_at -> ID28 | M14 save permission -> ID17, ID19, ID20 | M15 save session guard -> ID30 | M16 delete session guard -> ID31 | M17 delete permission -> ID21 | M18 delete plan check -> ID23 | M19 delete draft-only -> ID29 (freeze answers instead).
My first M9 attempt (`if false and (A) or (B)`) survived because of operator precedence, not because the guard was missing. I replaced it with M9a/M9b.

## Gates
- lint clean; typecheck clean.
- psql after a fresh reset: every suite "as pinned", "All suites passed", exit 0 (INVOICES 119).
- `pnpm test` after a fresh reset: 186 files passed, 1 skipped; 4136 tests passed, 5 skipped.
- Test logins recreated.

## Concerns / not covered
- A `financial_entry_id` that is not a uuid string raises a raw 22P02 with no hint, because the cast sits outside the line exception block. It is still a refusal, but the server action will need a generic sentence for it. Same for a gross total that overflows bigint.
- A recipient that is soft-deleted, as opposed to one in another workspace, has no assertion of its own. The `deleted_at is null` clause has no mutant.
- An unregistered seller's line with an unknown vat_rate is silently stored as 'none'. That is harmless (no VAT is charged), but the line is not refused.
- The same income entry can be pulled into two drafts. Task 13/6 may want to address this.
