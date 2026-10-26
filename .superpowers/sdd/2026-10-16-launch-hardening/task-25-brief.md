wrote /c/Users/archi/Documents/Work/Portfolio/Getsetpaid/.claude/worktrees/launch-hardening/.superpowers/sdd/2026-10-16-launch-hardening/task-25-brief.md: 21 lines
 and `app/api/incident-alerts/deliver` each copy `configuredSecret()`, `bearerMatches()` and the 404 refusal. That is security code that must change together.

**Files:** create `lib/security/runner-auth.ts`, exporting `refuseUnlessRunner(request: Request, envName: string): NextResponse | null`; modify the four routes; test with `tests/unit/security/runner-auth.test.ts`. Keep `tests/unit/email/delivery-route.test.ts` and `tests/unit/security/public-paths.test.ts` green unchanged.

- [ ] **Step 1: Failing unit test:**
  - secret unset → 404
  - secret shorter than 32 characters → 404
  - no `Bearer ` prefix → 404
  - wrong secret → 404, including one of a different length
  - right secret → `null`
  - every refusal carries `Cache-Control: no-store`
- [ ] **Step 2:** Move the code into the helper verbatim, and replace each route's copy with one call. Each route keeps its own env name, and its header comment loses only the paragraph restating the shared credential rules, which moves to the helper once.
- [ ] **Step 3: Mutant:** make the helper return `null` always, and the refusal cases go red.
- [ ] **Step 4: Gates.** lint, typecheck, `pnpm exec vitest run tests/unit`. Commit, push.

---


