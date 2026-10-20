# Invoices (part 1) SDD ledger

Plan: docs/superpowers/plans/2026-10-20-invoices.md (43cfe4b). Spec a2fe7c8. Founder said "continue" after the plan was presented 2026-10-20 (taken as go).

Task 1: spike implementer dispatched 2026-10-20 (base 43cfe4b; live Brevo send logged as owed: no key in this worktree, main .env.local is hosted-linked and must not be read)
Task 1: complete 2026-10-20 (88657a1, report 3aab77c; coordinator reviewed the small diff inline: attachment spread + test + mutant correct; react-pdf 4.3.0 renders under next dev, 7.6KB/232ms, no serverExternalPackages). Carry forward: live Brevo attachment send OWED (founder; addendum in Task 15); Task 10 PDF route must be route.tsx and stay authenticated (proxy redirects signed-out /api/*); storage-census RUNTIME_DEPENDENCIES gained @react-pdf/renderer.
Task 2: implementer dispatched 2026-10-20 (pure TS, no DB)
Task 2: complete 2026-10-20 (526189a tsconfig ES2020, ce08f96, report a93b2d4; coordinator reviewed the diff inline: case table re-checked by hand, half-up divide correct, mutants recorded). Deferred minors: invoiceTotals sum unguarded past MAX_SAFE_INTEGER; parseSnapshot does not cross-check totals against line sums (DB is the source). Other worktrees need tsconfig.tsbuildinfo deleted after rebasing onto the ES2020 target.
Task 3: HELD until Phase 10 Task 21 finishes (one heavy DB job at a time; Task 3 resets the shared stack). Before dispatch: git rebase origin/launch-hardening (picks up F2 migration 51b5d53 + Task 21).
