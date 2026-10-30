# Task 2 report: pure invoice logic

Status: DONE_WITH_CONCERNS (one plan defect fixed, see below)

## Built
lib/invoices/{arithmetic,snapshot,status}.ts and tests/unit/invoices/{arithmetic-cases.ts,arithmetic.test.ts,snapshot.test.ts}, exactly as the brief's code.

## Case table
All 12 expected values re-derived by hand before any run: 2.50x333=832.5->833, VAT 166.6->167; 0.50x1=0.5->1, VAT 0.2->0; 3x1999=5997, VAT 299.85->300; 1x2 @5% = 0.1->0; 1x10 @5% = 0.5->1 (VAT half-up); 12.34x5678=70066.52->70067, VAT 14013.4->14013; the rest are exact. No row needed changing.

## TDD
RED: `pnpm exec vitest run tests/unit/invoices` -> both files "Cannot find package '@/lib/invoices/...'" (2 failed files, no tests).
GREEN: 22 tests pass (19 arithmetic, 3 snapshot).

## Mutants (both reverted, verified)
1. divideHalfUp -> `n / d` (floor): red on 2.50x333, 0.50x1, 3.00x1999 @5%, 1.00x10 @5%, 12.34x5678 (5 case rows).
2. formatInvoiceNumber -> `String(n).padStart(4,"0").slice(-4)`: red on "expected 'INV-2345' to be 'INV-12345'".

## Plan defect fixed
tsconfig `target: ES2017` rejects BigInt literals (TS2737; 13 in arithmetic.ts, 6 in the test), so the brief's code cannot pass `pnpm typecheck`. Fix: `target` -> `ES2020` in tsconfig.json (own commit 526189a). noEmit + Next/SWC, so type-check only. Later tasks (the editor's live preview) need literals too. Note: a stale gitignored tsconfig.tsbuildinfo kept reporting the old errors after the change; deleting it fixed it (incremental cache, not a real error). Other worktrees may need the same if they rebase onto this.

## Gates
pnpm lint clean; pnpm typecheck clean; pnpm exec vitest run tests/unit: 120 files, 2788 tests pass.

## Commits
526189a tsconfig: target ES2020 so BigInt literals typecheck
ce08f96 Invoices: line/VAT arithmetic, numbering and snapshot parsing (pure)

## Concerns
- tsconfig is a repo-wide file; CI's `tsc` will see ES2020 (harmless: noEmit).
- invoiceTotals sums with plain Number; fine under the 2^53 per-line guard for any realistic invoice, not asserted for sums.
