wrote /c/Users/archi/Documents/Work/Portfolio/Getsetpaid/.claude/worktrees/launch-hardening/.superpowers/sdd/2026-10-16-launch-hardening/task-22-brief.md: 22 lines
ion is available to every user." Nothing of the kind exists. `signOutAction` (`lib/auth/actions.ts:359`) ends only the current browser (`scope: "local"`), and its own comment calls "sign out everywhere" a separate action that was never built. PRD § 6.1 asks for "Session management screen showing active sessions/devices with remote revocation". Case: a laptop stolen while signed in stays signed in for up to 12 hours (the timebox), and the user has no way to end it.

**Files:**
- Modify: `lib/auth/actions.ts` (`signOutEverywhereAction`), one account page to host the button (the account area today is `/account/privacy`, `/account/data-requests`, `/account/erase` and `/account/exports`; put it where the account nav makes it findable, and add a nav entry only if no page fits), `SECURITY.md` § 4 (line 198 rewritten to the as-built), `docs/launch-gates.md` (new row **G34, High**)
- Test: `tests/integration/session/sign-out-everywhere.test.ts`, and an e2e case in `tests/e2e/keyboard.spec.ts` or a new small spec

**Coordinator decisions:**
1. `signOutEverywhereAction` calls `supabase.auth.signOut({ scope: "global" })` and redirects to `/login`. It needs no step-up, because signing out cannot harm the account.
2. The per-device LIST is not built at MVP. Reading `auth.sessions` needs a definer RPC and a page, while the button alone answers "a device was stolen". Queue the founder question "is Sign out everywhere enough for PRD § 6.1's session screen at MVP? (default: yes, the device list is deferred)". Rewrite `SECURITY.md:198` to say exactly that.
3. State the residual in § 4: an access token already issued stays valid until it expires (`jwt_expiry` in `supabase/config.toml`; read the value). Only refresh is revoked.

- [ ] **Step 1: Failing tests.** Integration: sign the same user in twice (two clients), call global sign-out from one, and the other's `refreshSession()` fails (`refresh_token_not_found` or the pinned GoTrue's equivalent). e2e: two browser contexts signed in as one user; context A clicks "Sign out everywhere"; context B's next navigation after its access token is refreshed lands on `/login`. Use the fixtures' existing way to force a refresh if there is one, otherwise assert at the integration layer only and say so.
- [ ] **Step 2: The action and the button.**
- [ ] **Step 3: Mutant.** Change `global` to `local`, and the integration test goes red.
- [ ] **Step 4: Gates.** lint, typecheck, `pnpm test`, the touched e2e spec. Docs. Commit, push.

---

