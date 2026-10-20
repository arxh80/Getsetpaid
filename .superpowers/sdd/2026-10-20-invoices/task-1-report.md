# Task 1 report: react-pdf spike + Brevo attachment support

Status: DONE_WITH_CONCERNS (live Brevo send OWED, by coordinator instruction)

## Implemented
- `@react-pdf/renderer` pinned exact `4.3.0` (pnpm wrote no caret). `pnpm audit --audit-level high` exits 0; the only advisory is `vite` (pre-existing, 1 high already ignored), none in react-pdf.
- Fonts: `lib/invoices/pdf/fonts/SourceSerif4-Regular.ttf`, `SourceSerif4-Bold.ttf` (static TTF from adobe-fonts/source-serif 4.005R Desktop zip, `file` = TrueType Font data), `OFL.txt` (the release LICENSE.md, SIL OFL 1.1).
- `lib/email/send.ts`: `EmailAttachment { name, contentBase64 }`, `SendEmailInput.attachments?`, Brevo body `attachment: [{ name, content }]`, omitted when empty.
- `tests/unit/email/send.test.ts`: new attachment test.
- `tests/unit/legal/storage-census.test.ts`: added `@react-pdf/renderer` to `RUNTIME_DEPENDENCIES` (census test fails on any new runtime dependency otherwise). Not in the brief; required by the unit gate.

## Spike (next dev, port 3100)
- `serverExternalPackages` NOT needed; `next.config.ts` untouched. Turbopack bundled react-pdf, fontkit and yoga with no warnings.
- `GET` -> `200 application/pdf`, starts `%PDF-`, **7 609 bytes**, render (renderToBuffer) **232 ms** warm; first request 18.9 s (cold compile of the route + react-pdf, dev only).
- Size is below the brief's 10 000 expectation because react-pdf SUBSETS fonts. Embedded: `BaseFont /JIRVTG+SourceSerif4-Bold` and `/YNJGMS+SourceSerif4-Regular` (both present), 1 page. Text extraction (pypdf) returns `INV-0001`, `<script>alert(1)</script>` as literal text and `£1,234.56` (the `£`/em-dash only looked garbled in the terminal codepage; `'£' in text` is True). Not eyeballed visually.
- Server stopped by PID (38640 tree); nothing left listening on 3100. Spike route deleted, never committed.

## Findings for later tasks (plan defects, measured)
1. **A route handler containing JSX must be `route.tsx`.** The plan's spike is `route.ts` and fails with "Expected '>', got 'ident'". Task 10's PDF route needs `.tsx` (or `createElement`).
2. **`proxy.ts` redirects signed-out requests under `/api/*` to /login (307)** unless the prefix is in `PUBLIC_PATHS`. I ran the spike at `/api/exports/spike-invoice-pdf` (public prefix) to reach it unauthenticated. The real invoice PDF route is authenticated, so it should NOT be added to PUBLIC_PATHS.
3. **The plan's attachment test reused one `mockResolvedValue(new Response(...))` for two sendEmail calls**, so the second call died with "Body is unusable: Body has already been read". The committed test uses `mockImplementation(async () => new Response(...))`.
4. `.next/dev/types` kept a stale reference to the deleted spike route and broke `pnpm typecheck`; fixed with `rm -rf .next/dev && npx next typegen` (gitignored, nothing committed).

## TDD evidence
- RED (before implementation): `pnpm exec vitest run tests/unit/email/send.test.ts` -> `Tests 1 failed | 11 passed (12)`, `expected undefined to deeply equal [ { name: 'INV-0001.pdf', content: 'JVBERi0=' } ]`. (First attempt of the plan's test failed for finding 3 instead; test corrected, then the above RED/GREEN.)
- GREEN: `Tests 12 passed (12)`.
- Mutant: deleted the `...(input.attachments && ...)` spread from `sendEmail` -> `Tests 1 failed | 11 passed (12)`, `AssertionError: expected undefined to deeply equal [ { name: 'INV-0001.pdf' ...`. Restored -> 12 passed.

## Gates
- `pnpm lint` clean; `pnpm typecheck` clean (after typegen); `pnpm exec vitest run tests/unit` -> 118 files, 2766 tests passed.
- No db reset, psql, integration or e2e run (per instruction).

## Owed
- **Brevo live attachment proof (Step 8): OWED, founder action.** No Brevo key in this worktree; none sourced. Proven so far: payload shape by unit test and a valid PDF produced. To close: send a rendered PDF with `attachment:[{name,content}]` via the Step 8 curl using the founder's key; carry "Brevo attachment proof owed" into Q248's addendum (Task 15).

## Files
package.json, pnpm-lock.yaml, lib/invoices/pdf/fonts/{SourceSerif4-Regular.ttf,SourceSerif4-Bold.ttf,OFL.txt}, lib/email/send.ts, tests/unit/email/send.test.ts, tests/unit/legal/storage-census.test.ts. Untracked/ignored: `.env.development.local` (copied from the launch-hardening worktree, local stack only, `git check-ignore` confirmed, not committed).

## Concerns
- Local env file copy remains in this worktree (ignored); delete it if you want it gone.
- Dev-mode timing only; production (`next start`) cold behaviour unmeasured because `pnpm build` is forbidden here.
