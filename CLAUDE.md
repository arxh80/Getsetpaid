# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**GetSetPaid** — a UK-first, multi-tenant CRM for the live events industry (promoters, venues, booking agents, DJs/artists, suppliers). It combines a **private per-company CRM** with a **controlled industry network**, so each business keeps its operational data private while being able to discover and connect with other industry entities.

Core workflow the product exists to serve:
`relationship → enquiry/hold → booking/event → delivery → settlement/history`

**`getsetpaid_crm_prd.docx` in the repo root is the source of truth.** Read the relevant section before implementing a feature — it defines entities, roles, security controls and acceptance criteria in detail. This file is a summary, not a replacement.

The PRD is a binary docx and no text version is committed. To read it, run `python scripts/read-prd.py` (see below), or unzip `word/document.xml` and strip the tags.

## Current state

The Next.js app and the Supabase schema are scaffolded (auth, orgs, list infrastructure, core CRM writes, since Phase 3 events with their lineup, since Phase 4 operations: tasks, meetings, notes and documents behind a private-bucket, malware-scanned file pipeline, since Phase 5 event-level finance, and — since Phase 6 — **the network**: publishable profiles for companies/artists/venues/agencies, a browsable directory, request-to-connect, and an explicit, manual private-record-to-network-identity link). The PRD, the design and security docs and the pinned agent skills (`skills-lock.json` + `.agents/skills/`) sit alongside them.

**The gates. Run all five before claiming a change is done:**

| Command | What it is |
|---|---|
| `pnpm lint` | ESLint (`eslint`). |
| `pnpm typecheck` | `tsc --noEmit`. CI runs this too (below), but **nothing on this machine does** — there is no git hook, and `pnpm build` is forbidden in a worktree pointed at the local stack. Several exhaustiveness guards (the `switch` with no `default` in `lib/crm/contacts.ts`, `lib/crm/companies.ts` and `lib/crm/actions.ts`) are compile-time only, so skipping this locally means finding out on a push at best. |
| `pnpm test` | Vitest, unit and integration (`vitest run`). |
| `pnpm test:rls` | The RLS integration tests (`vitest run tests/integration/rls`), included in `pnpm test`. |
| `pnpm test:e2e` | Playwright (`playwright test`) — the Phase 2, Phase 3, Phase 4, Phase 5 and Phase 6 golden paths (`operations.spec.ts` walks a task to its event timeline and the note-visibility payoff; `documents.spec.ts` walks the clean/quarantine file pipeline; `finance.spec.ts` walks a Finance user through a budgeted fee, an actual income and the gross/expense/net summary, and the Starter-tier read-only refusal; `network.spec.ts` walks a Manager publishing a venue with two network-level fields and one connections-level field, a second organisation discovering it in the directory, sending and having a connection request accepted, seeing the connections-level field resolve, and linking the profile to its own private company record), tenant/role/tier breakout and record scope (since the loading-skeletons pass, a *record*-level refusal under a valid slug is asserted as the **streamed not-found contract** — HTTP 404 or a streamed 200 with the identical "Page not found" document, never 403, with the enumeration-oracle property measured directly by tenant-breakout's REFUSAL PARITY test; workspace-slug refusals and route handlers still assert the literal 404 — see `DESIGN.md` § Error pages; the Phase 6 network block: a foreign tenant's draft profile refuses identically and never surfaces in that tenant's own directory search; a Free-tier organisation's disabled "Request connection" control refuses server-side even with the `disabled` attribute stripped, with the sent-request row count in the database asserted unchanged around the click), and the axe accessibility scan (one test per page, **25 scans over 24 pages** — the event detail page is scanned twice, once as a Manager with no finance panel and once as a Finance user with it; Phase 6 adds five scans over five new pages: the network directory, a published profile viewed by a foreign organisation, this workspace's own network-profiles list, the populated publish-field editor, and the connection-requests page). Against a real browser and the local stack. **80 tests, run cold on its own dev server. Prerequisite:** `npx playwright install chromium` once per machine. It starts its own dev server; set `PLAYWRIGHT_REUSE_SERVER=1` only to reuse one on port 3000 that you know is current. |

The psql/HTTP RLS suite is separate and needs a fresh database:
`npx supabase db reset --local` then `bash supabase/tests/run-rls-tests.sh`. It
refuses to run twice without a reset in between.

**CI runs a subset, and knowing which subset is the point.**
`.github/workflows/ci.yml` runs on every pull request, and on pushes to
`main` only, in two jobs:
`pnpm lint`, `npx next typegen`, `pnpm typecheck` and
`pnpm exec vitest run tests/unit`; and `pnpm audit --audit-level high` plus a
gitleaks secret scan. (`next typegen` is there for the same reason it is named
above — a clean checkout has no `.next/types/`, so `tsc` cannot find
`PageProps`.) It does **not**
run `tests/integration`, the psql/HTTP suite or Playwright — all three need a
running Supabase stack (`npx supabase start` plus a reset), which is a
container pull and minutes per run, and is a deliberate decision nobody has
made yet. **So a green tick on CI is not a green phase**, and the
tenant-boundary suites `CLAUDE.md` § Testing gates calls the ones that "matter
most" still run only on a developer's machine. Every action in that workflow is
pinned to a full commit SHA; bump one by looking the new SHA up with
`gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and updating the `# vX.Y.Z`
trailer beside it.

`pnpm build` and `pnpm start` resolve to the **hosted** project and must not be
run from a worktree that is deliberately unlinked from it.

**After adding or renaming a route, run `npx next typegen` before
`pnpm typecheck`.** Next.js types `PageProps<"/some/route">` against a
generated manifest in `.next/types/`, and `pnpm build` — the usual thing that
regenerates it — is forbidden here. Without it a new page fails with
`Type '"/[orgSlug]/…"' does not satisfy the constraint 'AppRoutes'`, which
looks like a mistake in the page and is not. `pnpm dev` regenerates it too;
`next typegen` is the version that does not start a server.

Skills are pinned project-level so every agent and every machine gets the same set: restore with `npx skills experimental_install`, check updates with `npx skills check`. The roster and what each one is for live in `DESIGN.md` § "Build-time design tooling".

## Git workflow (required)

This repo is linked to a GitHub remote. **Commit and push after every change.**

- One logical change per commit; do not batch unrelated work into a single commit.
- Commit as soon as a change is complete and verified — not at the end of a long session.
- Push immediately after committing (`git push`), so the remote always reflects local state.
- Never leave the working tree dirty at the end of a task.
- Work on a branch and open a PR when the change is non-trivial; never commit feature work directly to the default branch.
- Never commit secrets, `.env` files, Supabase service-role keys, or the contents of private buckets.

## Architecture

**Backend:** Supabase — PostgreSQL is the system of record, Supabase Auth for identity, Supabase Storage (private buckets only) for documents, RLS for row access.

**Frontend:** Next.js (React). Desktop-first responsive web app; no native mobile for MVP.

### Tenancy model

`Organisation` is the tenant. Users belong to one or more organisations via `organisation_memberships` **from MVP** — the workspace switcher ships at launch, not deferred. Every tenant-owned table must have a reliable row → organisation path, and RLS derives the current user from the authenticated session and checks membership **in the database**. Never trust a client-supplied organisation ID.

### The private/network split (highest-risk boundary)

Network identities and tenant-private records are **separate concepts in separate tables** (`network_profiles`, `network_links` vs. the tenant tables). Matching a private contact to a network identity must never expose private notes, ratings, financials, documents or activity. Discovery queries read only explicitly published fields, and publishing is opt-in per field. Do not join private tables into public discovery paths without an explicit, tested policy.

**Discovery model: request-to-connect.** Published fields make a profile discoverable, but private/network data (ratings, history, financials, notes) never unlocks until both sides accept an explicit connection request. No public, logged-out profiles at MVP.

**Ratings are permanently private in v1.** They never leave the rating organisation's tenant — not even as an anonymised aggregate on a network profile. Revisit only as a deliberate future decision, not an MVP default.

### Domain entities

Organisation, User, Contact, Company, Artist/DJ, Agency, Venue (+ rooms), Supplier, Event (+ lineup), Tour, Offer/Hold/Booking, Task, Meeting, Note, Email activity, Document (+ versions), Financial entry, Relationship, Rating, Network profile, Audit event, Notification, Consent, Data subject request, Integration connection, Feedback.

Full baseline table list is in PRD §11.

**Events, as they actually shipped in Phase 3** — stated here because three of these read as features and are not:

- `events.status` carries all eight PRD values including `hold`, `confirmed`, `on_sale` and `sold_out`. They are **labels on one column**, with no transition rules, no state machine and no derived behaviour. Offers/holds/bookings remain out of MVP scope, and a status value is not that workflow arriving early. `public.event_status_changes` records transitions (founder Q33) and validates none of them.
- **Events are not dedup-screened and not mergeable.** `merges.entity_type` and `merge_candidates.entity_type` deliberately exclude `'event'`, and `createEventAction` does not call `screenAfterCreate`: an event's name is not identifying (a recurring club night shares its name with every instalment by design) and `public.events` has no `email` column, so the only auto-merge signal is unreachable by construction.
- **A lineup artist is always a real `artists` row** (`event_lineup.artist_id` is `NOT NULL` with a tenant-scoped composite FK); there is no free-text artist. **`venue_id` is nullable** — an event routinely exists before the venue is confirmed.

**Operations, as they actually shipped in Phase 4** — tasks, meetings, notes and documents, each a top-level tenant entity that attaches to CRM records through its own per-entity `*_links` table (Q22). Four things read as gaps and are deliberate:

- **Note visibility is binary** (`notes.visibility` is `private` or `company`, nothing finer): a `private` note reaches only its author; a `company` note is readable by the whole workspace but **editable only by its author** (founder Q54 — the UPDATE `USING` clause carries owner-scope, which closes a proven company-note theft path). Team/role-scoped or per-user sharing is a real feature (Q44), not shipped.
- **A task's `reminder_at` is stored (constrained `<= due_at`) but never delivered** — there is no notification subsystem at MVP (Q45). Setting a reminder is silent.
- **The malware scanner is a local EICAR stub**, not a real engine. `getScanner()` defaults to a stub that quarantines an EICAR-marked file end to end; `clamav`/SaaS names resolve to an **unconfigured adapter that throws**. The stub proves the pipeline (upload → scan → quarantine → the download gate refuses a non-`clean` document with 409); it does **not** prove real-malware detection. Wiring a real scanner is a launch gate (Q42, `SECURITY.md` § 6).
- **`document_versions` ships dormant** (SELECT-only, no write path — versioning is Release 1.1), and **soft-deleting a document does not purge its bytes** — a retention/GC job is owed (Q52, Phase 8). Downloads and uploads are server-mediated; the browser never gets a Storage grant (`storage.objects` is deny-all fenced), which is what lets the download path authorise, audit and gate on scan status before any signed URL exists.

**Network, as it actually shipped in Phase 6** — publishable profiles for company/artist/venue/agency, a browsable directory, request-to-connect, and an explicit private-record-to-network-identity link. Four things read as gaps and are deliberate:

- **The base table is readable and the VIEW is the mask, not the policy.** `public.network_profiles` carries the one policy in the whole schema that permits a cross-tenant read (`network_profiles_select_published_directory`) — a row policy filters rows, it cannot filter columns, so a query against the base table directly would see every field, including ones the publisher marked `hidden`. The **only** sanctioned read path is two views, `public.network_directory` (`network`-level fields) and `public.network_connected_profiles` (`network` + `connections`-level fields, for an accepted connection), each locked to a fixed dependency set asserted from `pg_depend` (N2) — a future join against a private table to resolve a nicer display name is the failure mode that assertion exists to catch. `SECURITY.md` § 2 has the full as-built description.
- **Nothing private unlocks on accept.** An accepted `network_connection_requests` row changes exactly one thing: the requesting/requested organisation's *published profile fields* marked `connections` resolve for the other side. It grants no access to any tenant table — no notes, no financial entries, no documents, no events, no activity, no tasks, no meetings, and no ratings (which do not exist as a table yet and are guarded structurally against the day they do, N5/Q85). Proved query path by query path in `supabase/tests/network_leakage_phase6.sql`. **The unlock is also organisation-wide, not profile-pair-scoped (Q80)** — accepting one request resolves the requesting organisation's *other* published profiles' `connections`-level fields too, not only the one profile the request named.
- **Linking is manual only, never suggested.** `network_links` — "this network profile is the same entity as my own private record" — is created by an explicit search-and-confirm the user runs from their own record's page (Q73). No fuzzy matching, no auto-suggestion, no pre-filled search term, and no ranking by similarity: the search box starts empty. A link is also strictly private to the linking organisation (Q82) — the profile's publisher is never told who linked it, and no policy gives them a read of `network_links` at all.
- **A connection request arrives silently.** There is no notification subsystem at MVP (the same answer as `reminder_at`, Q45, for a second feature): a request is discovered by visiting `/[orgSlug]/network/requests` or reading the pending-received count on the workspace hub, and nothing else — not email, not an in-app toast — tells either side a request exists, was accepted or was declined. "We sent them a request and nothing happened" is the expected experience today, not a bug report.

Three further things worth stating plainly rather than leaving a pentester or a reviewer to find them: **a declined connection request no longer blocks re-requesting** — Q79 shipped with declined-as-terminal (the one zero-cost anti-harassment control), and the founder reversed it on 2026-09-07 (`20260907000000` narrows the live-pair unique index to `pending`/`accepted`; the declined row itself stays immutable, a re-request is a fresh row beside it), which reopens a spam vector whose mitigation is the Phase 7 rate limiter below, not anything in Phase 6; the **30 requests/min network-discovery rate limit `SECURITY.md` § 5 specifies is not implemented** (deferred to Phase 7, Q86/Q87); and a **suspended organisation's published profile stays visible** to a counterparty *and* to the suspended organisation's own members (Q88, measured in Task 5) — reads are not suspension-gated anywhere else either (`view_crm` is the sole `survives_suspension = true` key), so this is consistent with the rest of the product rather than an oversight specific to the network. **A shipped migration comment is wrong about this and is not silently correctable:** `supabase/migrations/20260904002000_network_permissions.sql:42-45` claims "a suspended organisation's members cannot browse the directory or read their own network profiles until the workspace is reinstated" — measured false on both halves. It is a plain `--` script comment, not a `comment on policy`/`comment on view` statement, so there is no live database object whose comment a later migration could additively reissue (the `20260904007000` precedent applies only to `comment on` statements) — the shipped migration file is left as written, immutable, and this paragraph plus `FOLLOW-UPS.md`'s Q88 entry are the correction of record.

**Duplicate contacts/companies:** an **exact, case-insensitive email match auto-merges**; everything else — including an exact name match — is flagged for manual review and never auto-merged silently. Every merge is audited. Name is only ever a *fuzzy* signal: `screen_for_duplicates()` labels a pair `exact_email` only when both emails are non-null and equal case-insensitively, and `fuzzy_name` otherwise (`supabase/migrations/20260829020000_dedup_detection_and_merge_workflow.sql:385`), and the application merges only on the ids the database proposes for that first case (`lib/crm/dedup.ts:704`, "AUTO-MERGE IS EMAIL-ONLY AND FIRES ONLY WHEN THE DATABASE PROPOSES IT"). In practice that means **contacts only**, because `contact` is the one entity in `MERGEABLE_COLUMNS` with an `email` column (`lib/crm/dedup.ts:65`).

### Permissions

An action is allowed only if **all** of these permit it: platform policy ∩ subscription entitlement ∩ organisation role ∩ record scope ∩ user-specific exception. Entitlements are enforced **server-side** — hiding UI is not enforcement. Roles: Owner, Admin, Manager, Booker, Venue Manager, Finance, Marketing, Standard User, Read Only, Platform Superuser.

Downgrading a subscription makes features read-only or limited; it must never silently delete data.

### Subscription tiers

Per-seat pricing, monthly or annual (15% off annual), GBP. No seat minimum — a single paid seat is valid. Enterprise/contact-sales tier is deliberately deferred past MVP (see Scope discipline).

| Tier | Price | CRM writes | Network profile | Custom fields | Finance module | Storage |
|---|---|---|---|---|---|---|
| Free | £0 | No — view-only network browsing | No | 0 | No | — |
| Starter | £19/seat/mo | Yes | Yes, can publish | 5 per entity | No | 5GB/org |
| Pro | £39/seat/mo | Yes | Yes, can publish | Unlimited | Yes (budget & actuals) | 20GB/org |

### Superuser dashboard

Single hardcoded superuser (the founder) at MVP — no multi-account superuser role yet.

**Impersonation.** Break-glass only: the superuser requests impersonation, the org's admin must accept the request, and the session is time-boxed and fully audited (actor, org, reason, start/end). No silent or unilateral impersonation.

**No direct tenant-data access outside impersonation.** The dashboard never shows record content (contacts, events, documents) directly — only aggregate metadata (seat count, storage used, record counts). Any deeper look goes through the audited, admin-approved impersonation flow above.

**Org lifecycle.** Suspend/reinstate and delete are soft-delete only, require step-up re-auth, and notify the org's admin. Deletion follows the standard retention/soft-delete policy — no immediate hard delete.

**Billing overrides** (manual tier/seat change, comps, refunds): require step-up re-auth, a mandatory reason field (goes into the audit record), and notify the org admin automatically. Comps/overrides are time-boxed and auto-revert to the org's actual paid tier when the period ends — never a silent permanent edit.

**Per-org feature overrides** (early access, custom gating): scoped per org per flag, with a **mandatory expiry date** — no open-ended overrides. Prevents forgotten one-off grants from becoming permanent tech debt.

**Platform health/ops view:** basic counts only at MVP (active orgs, signups, seat/storage usage, error counts), queried on-demand/daily from Postgres directly — no separate metrics/observability pipeline. Deeper real-time monitoring stays in existing infra tooling (Supabase dashboard, hosting provider), not rebuilt in-app.

**Audit log viewer** is a core dashboard feature — searchable/filterable by org, actor, action type and date range, not just a raw DB table.

**Incident alerting:** basic trigger-based email/SMS alerts only (e.g. repeated failed logins across an org, a malware-scan hit) — not a full alerting platform. A complete on-call/runbook build-out stays post-MVP per `SECURITY.md` § Incident response.

**In-app feedback** is a dashboard section fed by the feature below — see § In-app feedback.

### In-app feedback

Any logged-in user, on any tier, can submit feedback (bug / idea / other) from within the app. Always identified — no anonymous option — capturing user, org, role, category, free-text message, current page/route, browser/device info, and an optional single screenshot attachment.

**On submit:** an email is sent to the founder's inbox (the same single support/security contact as `SECURITY.md` § 13 at this stage — no separate feedback address yet), and the submission is written to a `feedback` table, platform-scoped (not tenant-owned — the superuser dashboard reads it directly, it does not go through org RLS).

**Superuser dashboard view:** a dedicated Feedback list — filterable by org, category, and date — with a status per item (New / Read / Actioned / Archived) the founder updates manually. Separate UI from the audit log viewer, though the submission event itself is also audited like any other write.

**Screenshot attachment** goes through the same file-security pipeline as any other upload (§ Non-negotiable rules, `SECURITY.md` § 6): private bucket, malware-scanned, strict allowlist (image types only), signed URL, access logged.

**Screenshot risk (ties to § Superuser dashboard's "no direct tenant-data access" rule):** a screenshot can capture on-screen tenant-private data (another org's CRM record) that the submitting user happened to have open. The submit UI must warn the user before upload that the screenshot may include on-screen data. Because this is the one deliberate exception to "no direct tenant-data access outside impersonation," every superuser view of a feedback screenshot is itself an audited action (actor, feedback ID, timestamp) — same audit discipline as impersonation, not a silent read.

**Rate limit:** 10 submissions / hour per user, same tier as other write actions (`SECURITY.md` § 5).

**Retention:** 2 years, same as the inactive-account default — feedback is low-sensitivity operational data, not a financial or audit record.

### Session security

- Inactivity timeout **30 minutes**; absolute max session lifetime **12 hours**.
- MFA is **required** for: Platform Superuser, Organisation Owner, Admin, Finance. Optional (not enforced) for other roles at MVP.
- Step-up re-authentication (re-enter credentials/MFA) is required before: changing security settings (MFA, password, email), large data exports, deleting organisation data, and any high-risk admin/superuser function (including impersonation).
- SSO: **Google sign-in ships at MVP** (in addition to email/password + magic-link). Microsoft SSO is post-MVP.

### Non-functional targets

- Availability SLO: **99.9%**, excluding planned maintenance.
- Backup targets: **RPO 24h / RTO 4h** for the database.
- Data residency: **UK/EU Supabase region only** — no US-region hosting for customer data.
- Currency: **GBP only at MVP**; `financial_entries` and related tables store a currency column and use minor units so multi-currency UI can be added later without a schema migration.

## Non-negotiable rules

These are acceptance criteria, not hardening tasks. A feature is not done until they hold.

**`SECURITY.md` consolidates all security controls, rate limits, incident response and known risk areas into one reference — read it before touching anything security-sensitive, and before any pentest/audit.**

- **RLS on before access.** Enable RLS on every tenant-owned table before the application can reach it. Separate policies per operation where useful.
- **Service-role keys stay server-side.** They bypass RLS. Never ship them to the browser.
- **Parameterise everything.** No string-concatenated SQL. Search/filter/sort inputs map to allowlisted columns and operators.
- **Paginate everything.** No unbounded list endpoint. Server-side page-size ceiling; cursor/keyset pagination for activity feeds. Exports are async and bounded.
- **Files are private.** Private buckets, short-lived signed URLs issued after authorisation, sanitised filenames (never user-supplied paths as storage keys), every access logged. **Malware-scan every upload at MVP** (e.g. ClamAV or a scanning API) and hold quarantined files until cleared. Accept only a strict allowlist of file types (documents, images, PDFs) — not just MIME/extension checks, no executables or macro-enabled Office formats.
- **Treat all user content as untrusted.** Sanitise rich text; validate URL protocols (reject `javascript:`, `data:`); avoid `dangerouslySetInnerHTML`; ship a strong CSP.
- **Audit high-value actions.** Actor, org, timestamp, action, target, correlation ID, before/after. Append-only from the application. Superuser access audits itself. Never log passwords, tokens or keys. Retention: hot/queryable for 30 days, archived (cold storage) for up to 1 year total, then purged.
- **Soft-delete operational records** rather than hard deletion, subject to the retention policy. Default retention: 7 years for financial records, 2 years for inactive-account data — confirm exact periods per record type with legal counsel before launch (see § Legal and regulatory compliance).
- **UTC in the database**, UK local time in the UI with explicit timezone handling. UUID primary keys. Index every foreign key.

## Design

**`DESIGN.md` holds the colour, type, spacing and shape tokens. Read it before writing any UI.**

Direction in one line: minimalist, sharp-edged, bold serif — square corners everywhere (`--radius: 0`), no shadows, no gradients, structure from hairline rules and typographic weight.

Palette is `#FFF4F4` shell, `#BDB2FF` lilac and `#FFD6E0` pink as surfaces, `#14141C` ink for all text, and **two blues**: `--primary` `#0062FF` is the only blue permitted on text or a button (the source `#3A86FF` fails AA at 4.5:1); `--accent` `#3A86FF` is borders, focus rails, active state and charts. That split is the single easiest thing to get wrong — always go through the token, never a literal hex.

Type is Source Serif 4 throughout, with `tabular-nums` mandatory on every number in a table.

`python scripts/contrast.py` audits the whole token contract against WCAG 2.2 AA and exits non-zero on any failure. Run it after touching a colour; any colour added to `DESIGN.md` arrives with its measured ratio.

The product must not look like a re-skinned generic sales CRM. **`DESIGN.md` § "Build-time design tooling" is the contract for which design/UI/UX/frontend skills to invoke and in what order.** Three passes over every piece of UI:

1. **Decide** — `superpowers:brainstorming` → `hallmark` → `ui-ux-pro-max` → `frontend-design`.
2. **Build** — `tailwind-design-system` (v4 `@theme`) → `shadcn-ui` + `ui-ux-pro-max:ui-styling` → `nextjs-app-router-patterns` + `vercel-composition-patterns` → `typescript-advanced-types`; `dataviz` for charts, `framer-motion-best-practices` for motion.
3. **Review before merge** — `web-design-guidelines` on the diff, `accessibility-compliance` for WCAG 2.2 AA, `vercel-react-best-practices` on anything rendering a list or table.

Skills supply method; `DESIGN.md` supplies the tokens and **outranks every skill default** (rounded corners, shadows, gradients, sans stacks, stock palettes).

Priorities: high information density without clutter; keyboard-first navigation and global command/search; contextual drawers for quick edits; one consistent timeline/activity component reused across every entity; status chips and relationship indicators; empty states that teach the workflow; WCAG 2.2 AA from the start, not retrofitted.

Golden path to prototype and protect: create contact → create event → add artist → add venue → add task → view activity.

**What of it ships today, checked against the suite rather than asserted.** Every step is now walked in a real browser on every `pnpm test:e2e`: the Phase 2 half (contact, company, link, artist, venue, room, activity) in `tests/e2e/golden-path.spec.ts`, the Phase 3 half (create event, add the artist to the bill, change the venue, read the activity timeline) in `tests/e2e/events.spec.ts`, the Phase 4 "add task → view activity" step in `tests/e2e/operations.spec.ts` (create a task, link it to an event, complete it, read `task_completed` on that event's timeline), the Phase 5 money step in `tests/e2e/finance.spec.ts` (a Finance user — MFA-challenged for real, in a Pro-tier workspace — budgets a fee, books the actual income, and reads the gross/expense/net summary those two lines produce), and — the fifth sibling, Phase 6 — `tests/e2e/network.spec.ts`: a Manager publishes a venue with two fields at `network` and one at `connections`; a genuinely disconnected second organisation finds it in the directory and reads exactly the two `network` fields, not the third; it publishes a minimal profile of its own, sends a connection request, and has it accepted; it then reads the `connections`-level field for the first time; and it links the profile to its own private company record, which then shows the link. Five specs are siblings on purpose; whoever extends the sentence adds a sixth, not rewrites the others.

## Testing gates

Beyond unit tests, a release needs: **RLS integration tests across roles, tenants and network visibility**; API tests for validation, pagination and rate limiting; security tests for XSS, SQLi, IDOR/BOLA, CSRF, session handling, file access, privilege escalation and tenant breakout; accessibility (automated plus keyboard/screen-reader spot checks); dependency and secret scanning in CI.

Tenant-breakout and network-leakage tests matter most — write them alongside the feature, not after.

**Skills for these gates** (pinned project-level; full mapping in `SECURITY.md` § 11): `supabase` and `supabase-postgres-best-practices` for schema and policy design, `supabase-audit-rls` for RLS bypass auditing (**dev/staging only, anon key only**), `owasp-security-check` for the XSS/SQLi/IDOR/CSRF pass, `javascript-testing-patterns` for RLS integration and API tests, `e2e-testing-patterns` for Playwright golden-path and tenant-breakout runs, `wcag-audit-patterns` and `screen-reader-testing` for accessibility.

## Scope discipline

MVP (PRD §4) is: auth + orgs + invites, core CRM entities, events with lineup, tasks/meetings/notes/attachments, basic event finance, RLS isolation, entitlements, network profiles, audit log, legal pages, superuser dashboard (§ Superuser dashboard), in-app feedback (§ In-app feedback).

**Not MVP:** email/calendar integration, offers/holds/contracts workflow, settlements, ticketing APIs, file versioning, public profiles and connection requests, tour management, AI features, external API, first-class supplier management (suppliers exist only as a generic Contact/Company tag at MVP), network profile verification badges, Microsoft SSO, Enterprise/contact-sales subscription tier. Don't build ahead into these.

Finance starts at event/booking level and MVP scope is **budget & actuals only** — fee, cost and income lines per event, no invoicing, no full P&L. Resist expanding it toward accounting software or invoicing — that is an integration, later.

## Decisions log

Resolved 2026-08-26 (founder sign-off):

- **Frontend:** Next.js (React).
- **Multi-org:** supported from MVP, not deferred.
- **Network discovery:** request-to-connect (see private/network split).
- **Suppliers:** not first-class at MVP.
- **Pricing shape:** free + paid tiers.
- **Subscription tiers:** Free (£0) / Starter (£19/seat/mo) / Pro (£39/seat/mo), 15% off annual, no seat minimum. Enterprise deferred past MVP. Full gating matrix in § Subscription tiers.
- **Ratings:** permanently private in v1.
- **Finance scope:** budget & actuals only at MVP.
- **Retention:** 7yr financial / 2yr inactive as working defaults, pending legal review.
- **Superuser impersonation:** allowed, but only with org-admin acceptance, time-boxing and full audit.
- **Superuser dashboard scope:** single hardcoded superuser at MVP; org lifecycle (soft-delete only) + billing overrides (time-boxed, auto-revert) + per-org feature overrides (mandatory expiry) + basic platform health counts + searchable audit log viewer + trigger-based incident alerts. No direct tenant-record access outside impersonation. Full spec in § Superuser dashboard.
- **In-app feedback:** any logged-in user can submit (bug/idea/other), always identified, optional screenshot. Emails the founder and lands in a dedicated superuser dashboard list (New/Read/Actioned/Archived). Platform-scoped table, not tenant RLS. 10/hour rate limit, 2yr retention. Screenshot upload carries a leakage warning and every superuser view of one is audited. Full spec in § In-app feedback.
- **Superuser dashboard and in-app feedback are MVP**, not fast-follows — added to § Scope discipline.
- **Tier gating dimension:** seats + features (not pure usage/event-volume gating).
- **Free tier shape:** view-only network access, no CRM writes.
- **Audit log retention:** hot 30 days, archived up to 1 year total, then purged.
- **GDPR DSR turnaround target:** 30 days (ICO statutory maximum).
- **Session limits:** 30min inactivity / 12hr absolute lifetime.
- **MFA scope:** required for Superuser, Owner, Admin, Finance; optional for other roles at MVP.
- **Step-up re-auth triggers:** security-setting changes, large exports, org data deletion, high-risk admin/superuser functions.
- **Malware scanning:** enabled at MVP, plus a strict file-type allowlist (not just MIME/extension checks).
- **SSO:** Google at MVP; Microsoft deferred.
- **Currency:** GBP only at MVP, schema is multi-currency-ready.
- **Availability SLO:** 99.9% excluding planned maintenance.
- **Backup targets:** RPO 24h / RTO 4h.
- **Data residency:** UK/EU Supabase region only.
- **Dedup/merge:** an exact email match auto-merges (contacts only, since they are the only entity with an email); every other match, name included, is flagged for manual review. See § Architecture.
- **Custom field limits:** tier-gated (free: none, paid: more).
- **Network profile verification:** deferred past MVP.

## Open decisions (need founder sign-off — ask, don't assume)

- **First ticketing API partner** — deliberately deferred; ticketing integration is out of MVP scope, revisit when that phase starts.
- **Exact retention periods per record type** — working defaults are set above (financial, inactive-account, audit log); needs sign-off from qualified UK legal/privacy counsel before launch (see § Legal and regulatory compliance).
- **EU Art 27 representative** — need and appointment unconfirmed; required before onboarding meaningful EU-based org signups if the company has no EU establishment.
- **DPIA, ROPA and ICO registration** — none completed yet; all are pre-launch legal/compliance tasks, not engineering defaults (see § Legal and regulatory compliance).
- **Analytics/tracking vendor** — none chosen; the choice determines whether a PECR cookie-consent banner is needed at launch.
- **Payment processor** — not yet selected; must be confirmed PCI-DSS-compliant and used via tokenisation/redirect so the product stays out of PCI DSS scope.

## Legal and regulatory compliance

Legal pages and compliance decisions require review by qualified UK legal/privacy counsel before launch. Drafted content here is a starting point for that review, never a substitute for it. PRD §12 lists the required pages and the ICO/OWASP sources behind them.

**Applicable frameworks.** UK GDPR + Data Protection Act 2018 (primary, since the company and its Supabase region are UK-based); EU GDPR applies in parallel for any data subject located in the EU — a UK-first live-events product will have EU venues, artists and agents in its network from early on, so build to the aligned standard rather than UK-only with an EU bolt-on later. PECR (Privacy and Electronic Communications Regulations 2003, as amended) governs marketing email/SMS and non-essential cookies. The Equality Act 2010 underpins the accessibility requirement already in `DESIGN.md` and § Testing gates.

**Lawful basis.** Contract (Art 6(1)(b)) for core CRM processing needed to deliver the service a customer signed up for; legitimate interests (Art 6(1)(f)) for product analytics, fraud/abuse prevention, and the in-app feedback feature (§ In-app feedback); consent only where legally required (marketing communications, non-essential cookies) — never bundled with core-service consent, and as easy to withdraw as to give. No MVP entity collects special category data (health, biometric, etc.); a future feature that would must trigger a DPIA before build, not after.

**Data Protection Impact Assessment (DPIA).** Required pre-launch given systematic profiling for network matching/discovery and processing at scale across many orgs — a screening DPIA is a legal pre-launch task, owned by counsel + founder, not an engineering default.

**Records of Processing Activities (ROPA)**, Art 30: required once the company crosses the regular/risky-processing threshold, which a multi-tenant CRM handling personal and financial data does. One ROPA entry per domain entity category (PRD §11), kept current as the schema changes.

**International transfers.** Database and file storage are UK/EU-region-only (§ Non-functional targets) — no transfer issue there. Any sub-processor outside the UK/EU (transactional email provider, error-tracking/analytics, etc.) needs either an adequacy-covered location, the UK International Data Transfer Addendum (IDTA), or EU Standard Contractual Clauses before it touches personal data — checked per vendor at integration time, never assumed.

**Sub-processor / DPA register.** Every third-party processor (Supabase, email provider, malware-scan API, future integrations) needs a signed Data Processing Agreement and a line in a public sub-processor list — required under Art 28 and expected by security-conscious customers even pre-Enterprise-tier.

**EU representative (Art 27).** A UK company with no EU establishment that processes EU residents' data beyond an occasional/low-risk level must appoint an EU-based Art 27 representative — likely true here given the network's EU venues/artists. Confirm need and appoint before onboarding meaningful EU-based org signups (see Open decisions).

**ICO registration.** The company must register as a data controller with the ICO (annual fee, tiered by size) before processing personal data commercially. A compliance task that blocks launch if missed, not a technical one.

**Breach notification.** `SECURITY.md` § 12 already sets a 72-hour ICO notification clock for notifiable UK GDPR breaches. EU GDPR carries the equivalent 72-hour obligation to the relevant EU supervisory authority when EU data subjects are affected — the same incident-response process covers both; no separate EU-only path.

**Cookies/tracking (PECR).** Any non-essential cookie (analytics, third-party embeds) requires prior opt-in consent via a cookie banner; strictly-necessary cookies (session, auth, CSRF) are exempt. No analytics/tracking vendor is chosen yet — its cookie footprint decides whether a consent banner ships alongside it.

**B2B does not mean no individual rights.** GetSetPaid is sold to organisations, not consumers, so consumer-protection law (e.g. Consumer Rights Act cancellation rights) mostly doesn't apply — but individual users within a customer org remain data subjects with full UK/EU GDPR rights regardless of the B2B commercial relationship.

**Payments.** No card data is handled directly — subscription billing routes through a PCI-DSS-compliant processor (provider TBD) via tokenisation/redirect, keeping the product itself out of PCI DSS scope. Reconfirm this holds once the billing integration is actually chosen.

**Existing controls already meeting GDPR requirements** (cross-referenced, not duplicated): 30-day DSR export/erasure (§ Decisions log); UK/EU-only data residency (§ Non-functional targets); soft-delete + retention schedule (§ Non-negotiable rules, `SECURITY.md` § 8); audited access with defined retention (`SECURITY.md` § 7); RLS-enforced access minimisation (`SECURITY.md` § 2); the `Consent` and `Data subject request` domain entities (PRD §11) as the technical backbone for rights requests and consent records.

**Data subject request (export/erasure) target: 30 days**, matching the ICO statutory maximum. Build the DSR workflow to hit this deadline, not just aim for it informally.
