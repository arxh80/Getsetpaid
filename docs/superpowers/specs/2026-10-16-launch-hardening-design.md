# Phase 10 — Launch hardening (design)

**Status:** written 2026-10-16 by the coordinator while the founder is away (standing instruction: run every phase unattended; questions go to `DECISIONS-QUEUE.md` with a default that is implemented). Approval is queued as **Q243** with default "proceed as written".

## What the PRD asks

PRD § Delivery phases: **Launch hardening — "Pen test, performance, accessibility, backup restore" — exit: "All launch gates passed."** PRD § Success metrics: **"Zero known critical tenant-isolation vulnerabilities at launch; all high-severity findings remediated."** `SECURITY.md` § 11 lists the gates:

1. RLS integration tests across roles, tenants and network visibility.
2. API tests for validation, parameterisation, pagination and rate limiting.
3. Security tests: XSS, SQL injection, IDOR/BOLA, CSRF, session fixation/hijacking, insecure file access, privilege escalation, tenant breakout.
4. Accessibility: automated tooling plus keyboard/screen-reader spot checks.
5. Dependency, secret and license scanning in CI.
6. Manual review of every privileged function and every use of a service-role key.
7. Pre-production backup restore test.
8. Independent penetration test before general availability.

## The shape of the phase: remediation-driven

Phases 1–9 already built most of the evidence (28 psql suites, 4012 vitest tests, 181 Playwright tests, the permission matrix, censuses for the service-role and storage clients, axe scans). Phase 10 does not rebuild it. It:

1. **Inventories** every gate against the evidence that exists, mechanically where possible (route census vs axe scans, list reads vs bounds, rate limits vs tests, SECURITY DEFINER functions vs the matrix), and grades each gap.
2. **Attacks** the product with the two pinned audit skills: `owasp-security-check` over the code, and `supabase-audit-rls` against the **local** stack with the **anon key only**.
3. **Remediates** every Critical and High finding with a failing test first, the fix, and a mutant that proves the test bites. Medium and Low findings are fixed when cheap, otherwise recorded in `FOLLOW-UPS.md`.
4. **Publishes** `docs/launch-gates.md`: one row per gate with its status (MET / PARTIAL / OPEN / FOUNDER ACTION), its evidence and the command that re-measures it.
5. **Queues the founder actions** an agent cannot do and must never simulate: the third-party penetration test, the production backup-restore drill, counsel sign-off on the legal pages, ICO registration, the EU Art 27 representative, the DPIA and ROPA, signed DPAs, and the hosted-project configuration in `SECURITY.md` § 15. Each gets a lead time.

## What it does not do

- No new product features. A gap that needs a feature is a founder question, not a build.
- Nothing runs against a hosted Supabase project, and `pnpm build`/`pnpm start` are never run (they resolve to the hosted project).
- No performance work beyond measurement and missing indexes: the gate is "no list read is unbounded and every list read is index-backed at realistic volume", measured with `EXPLAIN` on seeded data. Page-speed budgets need a production build on real hosting; that is a founder-side measurement after deploy.
- Backup restore is proven **locally** (dump, restore into a fresh local stack, re-run the RLS suite against the restore). The production drill (Supabase PITR or a daily backup restored to a scratch project inside the RTO of 4h) is a founder action.

## Constraints every task inherits

- The local Supabase stack and port 3000 are shared across worktrees; check for other sessions' node/playwright/psql before any reset, psql, integration or e2e run. One heavy job at a time.
- The Docker VM is capped at 2 GB: never start ClamAV or extra containers locally.
- The machine runs short of memory under full e2e: run e2e specs in groups, each with a fresh dev server; Claude Code reaps background shells under memory pressure but not their children, so stop orphaned processes by PID.
- `supabase-audit-rls`: never production, anon key only, its context and log files stay gitignored, findings go to `SECURITY.md` § 10.
- Commit and push after every change; one logical change per commit; never commit secrets or `.env` files.
- Q243 is this design's approval; the next free founder question for a task is **Q244**.
