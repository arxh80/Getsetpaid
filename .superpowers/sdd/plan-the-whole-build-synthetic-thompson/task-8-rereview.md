# Phase 8 Task 8: fix round 1 re-review

Diff `2a29ddc..3f37b06` (commits `d9be7b2` I3, `ea993f8` M1, `6d3f8f1` I1, `d7f0e3b` I2+M4, `3f37b06` report), reviewed at `3f37b06`.

**VERDICT: MINOR.** I1, I2 and M1 are closed. I3 is closed in the sentences the review named, but one more stale retention count turned up (N4). The fixes add no Critical or Important finding. Four new Minors follow, ranked. The most useful one is N1: the middleware now hides the pages' own guards from every e2e test.

## Constraints

This review was read-only. I ran no reset, no psql runner, no integration tests, no Playwright and no dev server, because the controller holds the shared stack. Commands I did run:
- `git diff`, `grep`, and a sum of the `run_suite` pins;
- `pnpm exec vitest run tests/unit/security/super-page-census.test.ts`, which gave 8/8.

I took the e2e outcomes from the report and did not reproduce them: 24/26, with 25 and 26 reaped by memory pressure.

## Per finding

### I1: CLOSED

- `tests/e2e/support/fixtures.ts:2968-2986` `plantReadyAccountExport()` builds a downloadable job:
  - a real object at `exports/<id>.zip`;
  - `storage_key` set, `status = 'succeeded'`;
  - `expires_at` stamped by the UPDATE trigger, not written by the fixture.
- That makes every row-state branch of `lib/export/download.ts` pass for this row: `:53` (storage_key is a string), `:54` (`archiveIsDownloadable`) and `:66` (`exists`).
- The positive control is real (`phase8-refusal-parity.spec.ts`, the download test). The job's Owner must get a 30x with `Location` matching `/storage/v1/object/sign/exports/`. That value can only come from `createSignedUrl` at `download.ts:83`, which runs after `audit_export_download`. The audit count must be exactly 1.
- Each refused caller is now refused by authorisation, not row state:
  - **anonymous:** bounced by the middleware's signed-out redirect, and refused by `getCurrentUser()` at `download.ts:39` if it got that far;
  - **read_only, admin, no-workspace:** `export_jobs_select_own` returns no row, so the refusal is the `!data` branch at `:53`. The Owner's 302 on the same id proves nothing else could produce it.
- The audit count is re-asserted at 1 after the refusals, so a refused call wrote nothing.
- Cleanup removes the object and the audit row.
- With mutant 10 or a widened SELECT, read_only would now get a 302, and this test would go red.

### I2: CLOSED (with N1 to N3 below)

`lib/supabase/middleware.ts:212-223`:

- **Fails closed.** `if (error || onAllowlist !== true)` rewrites on an RPC error, on `null`, and on any non-`true` value.
- **Signed-out behaviour is unchanged.** The `!isSignedIn` redirect (`:179-191`) runs first, and the new block is guarded by `isSignedIn`. Anonymous `/super/*` still goes to `/login?next=`.
- **The aal1 superuser is not locked out.** The predicate is `public.is_platform_admin()`. Its live definition (`20260827210000_mfa_aal_permission_gate.sql:272-290`) is an `exists` on `platform_admins` with no aal term, the same predicate `lib/admin/superuser.ts:78` asks. So the aal1 superuser is routed normally and meets the app-wide MFA gate as before. Per the report, the `super-permissions` test "superuser BELOW aal2" was among those that passed.
- **Route handlers are exempt correctly.**
  - `SUPER_ROUTE_HANDLER_PATHS` is `^/super/feedback/[^/]+/screenshot/?$`.
  - The new census (`tests/unit/security/super-page-census.test.ts:93-113`) walks `app/(app)/super`. It has a denominator: the screenshot handler must be found. It asserts every `route.*` is exempt and no `page.*` is (the catch-all maps to `/super/<uuid>`, which is not exempt).
  - An empty array makes `isSuperRouteHandler(handler)` false, so the census does go red. That is correct by reading, and the report measured 1 failed / 7 passed.
  - A future route group `(x)` under `/super` would put a literal `(x)` in the walked URL. That fails red, not green, so it is safe.
- **Cost and oracle.**
  - The cost is one extra PostgREST round trip per signed-in `/super` request. The superuser pays twice, because the page's `cache()`d `isSuperuser()` runs in a different request context. That is negligible.
  - There is no new oracle. The RPC tells the caller only whether *they* are on the allowlist, which they already know (the function's own comment says so). A non-admin receives one fixed document whatever the URL.
- **The normaliser is broad but not destructive in practice** (N3).
  - The superuser control asserts that `/super/legal` stays distinct from the ghost after normalisation, and that one URL fetched twice normalises the same.
  - After the rewrite, every refused URL goes through one route by construction. The remaining differences are the requested path, which is the caller's own input, and per-request ids. So the normaliser has little real difference to erase.
- **Measured, by the report.**
  - Before the fix: legal 67,064 bytes vs ghost 59,461; `h-8` counts 20 vs 2; `unknown` present only in the ghost.
  - After the fix: seven interleaved fetches were byte-identical after normalisation.
  - I did not reproduce either measurement.

### I3: CLOSED as scoped; one more stale count (N4)

- I summed the pins myself: 23 `run_suite` calls total **3858**, and the DSR and retention suites are at 228 and 275 (`run-rls-tests.sh:930`, `:1066`).
- `CLAUDE.md:104-112` (the total, the list and the +33), `:131` (the retention history) and `:160` (the DSR suite, now 228) are correct.
- The report's § 7 rows `:364` and `:377` now read 3858 and +33.
- Not caught: `CLAUDE.md:91` still calls the retention suite "the newest, **267 assertions** (… 267 after fix round 2 …)", in the present tense. This is N4.

### M1: CLOSED

- `rls_phase8_permissions.sql:221-229` now pins `42501:consents: a consent can only be recorded from the data subject's own session`.
- That matches the raise at `20260923003000_*.sql:80` character for character, quotes included.
- The suite count is unchanged at 22. The psql runner was not re-run this round. The controller's gate run settles it.

### M4: CLOSED

Both parity loops iterate `ALL_SUPER`, which is `SUPER_PAGE_URLS` plus `?doc=terms`.

### Accepted Minors (M2, M3, M5, M6): the reasons are sound

- **M2** is a 23-RPC pinning job, and no false green has been suspected.
- **M3** is a census redesign.
- **M5** is a history row that is still accurate as history.
- **M6** is covered by the matrix's `relacl`/`attacl` census.

None hides a live hole. I would carry M2 and M3 into FOLLOW-UPS or the next task's brief rather than let them lapse.

## New findings

### N1 (Minor, the most useful one): the middleware now masks every `/super` page's own guard

Before this round, a non-superuser's GET of `/super/legal` reached `isSuperuser()` → `notFound()` in the page itself (e.g. `super/data-requests/page.tsx:27,35`). Every refusal test therefore exercised that guard.

Now every non-allowlisted caller is rewritten before routing. **No e2e test reaches a page's own `isSuperuser()` check, nor its `generateMetadata` title check, as a refused principal.** Delete either from any page and every `super-permissions` and refusal-parity test stays green. That is the "green with the guard removed" class, for a guard the middleware comment calls the real one ("THIS IS PARITY, NOT THE CONTROL").

The data layer is still aal2-gated, so exploiting this needs two faults:
- the page guard is lost;
- the middleware stops rewriting, for example through a matcher regression or a refactor of `isUnder`.

**Fix (cheap):**
- Add a source census to `super-page-census.test.ts`: every `page.*` under `super/` except the catch-all must call `isSuperuser()` in its default export and in any `generateMetadata`.
- Or add an integration test that renders a page with the middleware bypassed.
- Also correct the comment in `middleware.ts`. The pages "decide" only for allowlisted callers now.

### N2 (Minor): the one exempt route handler is still distinguishable from the ghost by shape

- `/super/feedback/<anything>/screenshot` answers the handler's literal 404.
- `/super/<anything>/<x>/screenshot` answers the catch-all's streamed 200.
- So a signed-in caller can confirm that the screenshot route shape exists. It is the only `/super` route that remains enumerable.

This cannot be avoided under the DESIGN.md contract (a route handler keeps its literal 404, and a page streams). The route's existence is also documented publicly in SECURITY.md:152, so the impact is nil. It should still be written down as the known residual, because the I2 claim is that "every /super URL renders the identical document".

### N3 (Minor): `normaliseDocument()`'s id-renumbering regex is wider than flight ids

`(\\n|\$[A-Za-z]?|(?<=[A-Z]))([0-9a-f]+)(?=[:\\])` renumbers any hex-letter run that:
- follows an uppercase letter, `$`, `$X` or `\n`;
- and precedes `:` or `\`.

That includes ordinary text, for example the `eed` in `Feed:`. Two documents differing only in such tokens would normalise to the same thing. That is harmless here, because after the rewrite the refused documents share one route. But a future reuse of this normaliser on two routes that really differ could erase a difference.

**Fix:** anchor the renumbering to flight-row syntax (`\n<id>:` and `"$<id>"` / `"$L<id>"`). The superuser control should stay as it is.

### N4 (Minor): the stale count at `CLAUDE.md:91`

It reads "`rls_phase8_retention.sql` is the newest, **267 assertions**". It should say 275, with RR7a-h added to its history.

## Doc sentences the middleware change makes false or incomplete

1. **`CLAUDE.md:28` (the e2e cell, Phase 8 Task 8 parenthetical).**
   - It says the spec compares each refusal "on status, rendered text and title". It now compares raw HTML too.
   - It says "every `/super` page [was] an existence oracle, closed by `app/(app)/super/[...unknown]/page.tsx`". That is false as stated: the catch-all alone left the raw-HTML oracle, and the middleware rewrite closes it (I2).
   - **Fix:** name `lib/supabase/middleware.ts`'s rewrite, and N2's residual.
2. **`SECURITY.md:729`.** "`phase8-refusal-parity.spec.ts` (9 tests: each Phase 8 refusal compared with the document produced for something that does not exist)" understates it. It now covers all nine `/super` pages, rendered and raw. This is incomplete rather than false.
3. **`SECURITY.md` has no sentence on the new mechanism.**
   - It does not say that `/super` refusals for signed-in non-superusers are now produced by a proxy rewrite to `/super/not-found` before routing, rather than by each page's `notFound()`.
   - § 2's permission-gate bullet still says "Every /super page gates on `isSuperuser()`". That is still true of the code, but it is no longer what a non-superuser meets.
   - **Fix:** add one sentence there, saying the rewrite is parity and not the control, and pointing at N1.
4. **`DESIGN.md` § Error pages** stays true: a route handler keeps its literal 404, and a record-level refusal streams. The `/super` rewrite is not described there and does not need to be, but a one-line mention of a fixed refusal route for `/super` would help a reader find it.
5. **Middleware and proxy headers** (`middleware.ts:24,36`, `proxy.ts`: "nothing here is an authorisation control") stay true, and the new block's comment is consistent with them.

## Still owed (from the report, not a finding of this review)

One clean run of `phase8-refusal-parity`, `super-permissions` and `exports` after a reset. Above all, the screenshot-route test, which is the case the exemption exists for, has not been run since the exemption landed.
