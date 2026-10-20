# Invoices (part 1) SDD ledger

Plan: docs/superpowers/plans/2026-10-20-invoices.md (43cfe4b). Spec a2fe7c8. Founder said "continue" after the plan was presented 2026-10-20 (taken as go).

Task 1: spike implementer dispatched 2026-10-20 (base 43cfe4b; live Brevo send logged as owed: no key in this worktree, main .env.local is hosted-linked and must not be read)
Task 1: complete 2026-10-20 (88657a1, report 3aab77c; coordinator reviewed the small diff inline: attachment spread + test + mutant correct; react-pdf 4.3.0 renders under next dev, 7.6KB/232ms, no serverExternalPackages). Carry forward: live Brevo attachment send OWED (founder; addendum in Task 15); Task 10 PDF route must be route.tsx and stay authenticated (proxy redirects signed-out /api/*); storage-census RUNTIME_DEPENDENCIES gained @react-pdf/renderer.
Task 2: implementer dispatched 2026-10-20 (pure TS, no DB)
