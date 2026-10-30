# Task 5 report: issue, numbering, snapshot, the concurrency probe

Status: DONE (two plan test defects fixed; Q255 default built)

Commit: 0df1920 (base 67697f7).

## Built
- `supabase/migrations/20261107002000_invoice_issue.sql` (renumbered from 20261106002000): `public.issue_invoice(uuid) returns text`, as in the plan, plus the Q255 default (a). SECURITY DEFINER, `search_path = ''`. Execute is revoked from public, anon, authenticated and service_role, then granted to authenticated only (IS22).
- Q255: after the `invoice_settings` row lock, refuse `22023:invoice_entry_already_invoiced` when any pulled entry on the draft is also on another invoice whose status is issued or paid and which is not deleted. The check sits after the lock so a second issue that waited on the lock reads the first one's commit (READ COMMITTED takes a fresh snapshot per statement).
- `supabase/tests/rls_invoices.sql` § IS: 27 assertions (the plan's 22 plus IS23-IS27 for Q255). Pin 132 -> 159, measured with `grep -c '^select inv.val('`.
- `supabase/tests/invoice_issue_concurrency_probe.sh`, as in the plan (the repo's two-session `docker exec psql` shape, from retention/lifecycle probes). Wired into `run-rls-tests.sh` after the retention probe.
- `phase7-permission-matrix.test.ts`: `MEMBER_REACHABLE_RPCS` += issue_invoice. No other census went red.

## TDD
- RED: the suite halted at IS10's `\gset`, `function public.issue_invoice(unknown) does not exist`. IS1-IS9 were recorded red (42883).
- First run after the migration: 157/2. Both were plan test defects:
  - IS7: `concat_ws` renders a boolean as `t`. Fixed by casting it `::text`.
  - IS8: it read `audit_events` as fin_n, but the table is superuser-read, so 0 rows were visible. It now runs as postgres, after IS9's reset.
- I also gave inv_n3 a line. Without one, mutant 4 was refused by `invoice_has_no_lines` instead of issuing. IS21 now really deletes a line.

## Probe
Session one issues D1 and holds its transaction for 2 s. Half a second later, session two issues D2. Result: PRB-0001 and PRB-0002, next_number 3, PASS.

## Mutants (each applied live, then the original restored; green after)
1. Settings `for update` removed, plus `pg_sleep(1)`: probe FAIL. Session two hit `invoice_number_taken` on PRB-0001.
2. `next_number` advance dropped: IS4 red (the suite halts at IS10's gset on 23505).
3. Plan check -> `if false`: IS18 red (issued INV-0001).
4. Deleted-recipient check -> `false and (...)`: IS19 and IS20 red (issued NUM-0003).
5. Q255 check removed: IS24 to IS27 red.
6. Q255 `in ('issued','paid')` -> `= 'issued'`: IS26 and IS27 red.
7. Q255 status filter -> `true` (any invoice blocks): IS23 and IS25 red.

## Gates
- lint clean; typecheck clean.
- psql after a fresh reset: every suite "as pinned", INVOICES 159, both probes PASS, "All suites passed", exit 0.
- `pnpm test` after a fresh reset: 186 files passed, 1 skipped; 4138 tests passed, 5 skipped.
- Test logins recreated.

## Concerns / not covered
- Q255 under a real race is unproven. Two drafts pulling one entry, issued at once, should serialise on the settings lock. That follows from the check's placement, but no probe drives it.
- A pulled entry that was soft-deleted after drafting is not re-checked at issue (the plan does not ask for it).
- CARRY to the refusals task: `lib/invoices/refusals.ts` does not exist yet. It must map `invoice_entry_already_invoiced` (new here), plus `invoice_entry_pulled_twice`, `invoice_address_invalid` and `invoice_notes_invalid` (Task 4), each with a test.
