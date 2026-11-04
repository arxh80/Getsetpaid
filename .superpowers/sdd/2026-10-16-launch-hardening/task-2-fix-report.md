# Task 2 fix phase report (the OWASP pass)

Base `4d5a633` (dispatched), resumed twice after session limits. Branch
`launch-hardening`. All four items of the coordinator's ruling are done.

## What was done

1. **Findings F7-F10 written** (`task-2-findings.md`). F7 completed from its
   surviving cells (the project-wide GoTrue email budget, Medium). F8-F10 were
   re-derived, since no `task-2-report.md` exists: F8 login CSRF at
   `/auth/callback` (Low), F9 unmetered invitations (Medium), F10 the invite
   refusal as an enumeration oracle (Low, Task 4's deferred minor). Each has a
   row and a status; residuals are in `SECURITY.md` § 10, F7/F9 owed work in
   `FOLLOW-UPS.md` § Phase 10 Task 2.
2. **Remaining audit scope read** (CRM and admin Server Action bodies; export,
   erasure, retention runners and the delivery route). **No new finding.**
   Evidence is in the findings file's last section (scripted tenant-filter
   check over every `.update(`/`.delete(`; every admin write a definer RPC via
   the caller's client; every runner a 32+-char bearer with constant-time
   compare and 404 either way; export bytes only for clean documents). No new
   Critical or High.
3. **Fixes, test first, each with a mutant:**
   - **F2 (High)** `20261106000000_owner_rows_are_an_owners_to_give.sql`: only
     an active Owner may create, change or remove a membership row whose role
     is owner. One term, `role <> 'owner' or private.is_active_owner(org)`,
     added to INSERT WITH CHECK, UPDATE USING and WITH CHECK, DELETE USING.
     `private.is_active_owner(uuid)` is the interface for Task 21. Q248 queued
     (default implemented).
   - **F3 (High)**: per the ruling, residual plus notifications. GoTrue
     v2.196.0 contains `update_password_require_current_password`, but CLI
     2.116 has no config key for it and its Management API schema does not
     expose it, so it is a residual in `SECURITY.md` § 4 and § 10 with that
     evidence. Notifications: password-changed was **already live** (CLI 2.116
     passes the block; `config.toml`'s comment said "not verified", now
     corrected); MFA factor enrolled and unenrolled added with templates.
     Proved in Mailpit; hosted switches added to § 15.
   - **F5 (Medium)** `safeNextPath` re-checks the rebuilt path.
   - **F6 (Medium)** `authCookieOptions()` gives the server, browser and proxy
     clients `secure: true` in production. `gsp_signup_binding` and
     `gsp_current_org` already set it.
4. **`docs/threat-model.md` (G19)**: eight STRIDE tables (PRD § 10.8 flows),
   every row naming its control and proving test or residual; reference test
   `tests/unit/security/threat-model-references.test.ts`. `docs/launch-gates.md`
   G19 marked closed.

## TDD evidence and mutants

| Fix | RED | GREEN | Mutant |
|---|---|---|---|
| F5 | `pnpm exec vitest run tests/unit/auth/redirects.test.ts`: 5 failed / 6 passed (`expected '//evil.test' to be '/home'`), the pre-fix function | 11 passed | The RED run is the pre-fix function: 5 red |
| F6 | `pnpm exec vitest run tests/unit/security/auth-cookie-secure.test.ts`: 2 failed (`expected undefined to be true` / `false`), no client passed `cookieOptions` | 2 passed | `cookieOptions` deleted from the proxy client in `lib/supabase/middleware.ts`: both red; restored: green |
| F3 | `pnpm exec vitest run --project integration tests/integration/session/security-notifications.test.ts` before the config change: password case passed, MFA case failed `expected [] to include 'A sign-in factor was added ...'` (no mail at all) | after `supabase stop && supabase start` (env shows `GOTRUE_MAILER_NOTIFICATIONS_MFA_FACTOR_{EN,UNEN}ROLLED_ENABLED=true`): 2 passed | The RED run is the config without the blocks. Cheap pin: `tests/unit/security/auth-config.test.ts` asserts all three `enabled = true` with our templates |
| F2 | migration moved aside, `npx supabase db reset --local`, `bash supabase/tests/run-rls-tests.sh`: RLS FOUNDATION 8 failing, O2 self-promotion `ok(1)`, O3 Owner invite `ok(1)`, O4 Owner demotion `ok(1)`, O5 Owner removal `ok(1)`, O6 `1/owner`, O9 `0`; O1 (the Admin's ordinary path) passed | migration restored, fresh reset, runner: FOUNDATION 196/196 (see Gates) | Scratch `f2-mutant.sql`, one rolled-back transaction each: with the fix, the aal2 Admin's self-promotion -> `ERROR: new row violates row-level security policy`; with the UPDATE policy put back to its pre-fix text -> `UPDATE 1` (red) |
| G19 | n/a (new doc) | 10 passed | Doc citation renamed to `redirects-gone.test.ts` and `## 6. Finance` renamed: 2 red; restored: green |

## Side effects found and handled

- **The runner's HTTP block reads carol after `rls_foundation.sql`** and asserts
  she is still `standard_user` (feedback role stamp). The first green run went
  red there because § O recasts her; § O now restores the cast at its end
  (alice first, so the last-owner trigger cannot fire even under a mutant).
- **`rls_phase8_erasure.sql` EM5** expected an aal2 Admin's demotion of the
  sole Owner to reach the last-owner trigger (22023). Under F2 the Admin's
  UPDATE never sees the Owner's row, so it is now `ok(0)` (stricter, one step
  earlier); EM4 keeps the trigger's own refusal and EM9 still proves nothing
  moved. Pin unchanged (212).

## Gates

All on 2026-10-20, with only the founder's dev server (PID 23996) running alongside.

- `pnpm lint`: clean. `pnpm typecheck`: clean.
- `pnpm exec vitest run --project unit`: **121 files, 2792 passed** (idle machine; one earlier run during the psql runner had load timeouts, e.g. `markup-placement` 768 ms > 750 ms, gone on the idle re-run).
- `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh`: **All suites passed; API surface: all checks passed** (FOUNDATION 196, ERASURE 212, every other pin unchanged).
- `npx supabase db reset --local && pnpm exec vitest run --project integration`: **61 files passed, 1 skipped; 1302 passed, 5 skipped** (the clamav-live five). Run straight after the psql runner (no reset) the matrix's "no download was audited by any of that" went red once: the pre-existing order dependence recorded in `FOLLOW-UPS.md`, green after the reset.
- `tests/integration/session/security-notifications.test.ts`: 2 passed (after the stack restart).
- e2e: not run (no page or flow changed; see Concerns).
- Founder test logins re-created with the scratchpad `test-logins.mjs` after the last reset.

## Files changed

- `lib/auth/redirects.ts`, `tests/unit/auth/redirects.test.ts` (F5)
- `lib/supabase/{env,server,client,middleware}.ts`, `tests/unit/security/auth-cookie-secure.test.ts` (F6)
- `supabase/config.toml`, `supabase/templates/mfa-factor-{enrolled,unenrolled}.html`, `tests/unit/security/auth-config.test.ts`, `tests/integration/session/security-notifications.test.ts`, `tests/integration/rls/support/env.ts` (optional `mailUrl`) (F3)
- `supabase/migrations/20261106000000_owner_rows_are_an_owners_to_give.sql`, `supabase/tests/rls_foundation.sql` (§ O), `supabase/tests/run-rls-tests.sh` (FOUNDATION pin 187 -> 196), `supabase/tests/rls_phase8_erasure.sql` (EM5) (F2)
- `docs/threat-model.md`, `tests/unit/security/threat-model-references.test.ts` (G19)
- `SECURITY.md` (§ 4 F3 residual; § 10 five rows: F3, F7, F8, F9, F10; § 15 notifications and `email_sent`), `docs/launch-gates.md`, `FOLLOW-UPS.md`, `DECISIONS-QUEUE.md` (Q248), `task-2-findings.md`

## Concerns

- **Local stack restarted** (`supabase stop && supabase start`) to load the new
  notification config, and reset three times for the psql runs. Founder test
  logins re-created afterwards with the scratchpad `test-logins.mjs`.
- **F7's exploit was not reproduced** (it would lock the shared stack's mail
  for an hour); inferred from config and its comment.
- **F8-F10 are re-derived**, not the audit phase's lost originals.
- **F3 remains a real residual**: a stolen aal2 token can still swap the MFA
  factor; the control is that the holder is told. Re-check GoTrue's
  require-current-password setting when the hosted dashboard exposes it
  (`FOLLOW-UPS.md`).
- e2e not run: no change touches a page, and the membership surfaces e2e
  drives use non-Owner roles.
