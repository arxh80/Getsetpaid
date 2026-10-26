# CLAUDE.md

Guidance for Claude Code in this repository. **Rules and architecture only.** The detailed as-built description of every phase, each deliberate gap and the history of every fix round lives in [`docs/as-built.md`](docs/as-built.md). Code comments that cite "`CLAUDE.md` § X … as it actually shipped" mean the matching section there.

**Keep this file short.** Do not add test counts, assertion totals, migration counts or fix-round history here. Counts go stale, so measure them instead (see § Gates). History goes in the PR description, or in `docs/as-built.md` if a later reader needs it.

## Project

**GetSetPaid** is a UK-first, multi-tenant CRM for the live events industry (promoters, venues, booking agents, DJs/artists, suppliers). It pairs a **private per-company CRM** with a **controlled industry network**.

Core workflow: `relationship → enquiry/hold → booking/event → delivery → settlement/history`

**`getsetpaid_crm_prd.docx` is the source of truth.** Read the relevant section before implementing a feature. To read it, run `python scripts/read-prd.py`, or unzip `word/document.xml` and strip the tags.

Also read before touching their area:
- `SECURITY.md`: every security control, rate limit, incident process and known risk. Read it before anything security-sensitive.
- `DESIGN.md`: tokens and the design-skill contract. Read it before any UI.
- `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`: founder questions (Qnnn) and their rulings.

## Current state

Phases 2–9 are shipped and merged:

| Phase | What it built |
|---|---|
| 2 | Auth, orgs, invites, list infrastructure, core CRM |
| 3 | Events and lineup |
| 4 | Tasks, meetings, notes, documents |
| 5 | Event finance |
| 6 | The network |
| 7 | Superuser dashboard: audit log, impersonation, lifecycle, overrides, health and rate limits, feedback, CRM audit triggers |
| 8 | Legal pages, consent, data subject requests, exports, erasure, retention, notification emails, Owner workspace closure |
| 9 | Integrations schema, with no live connector |

Per-phase detail is in `docs/as-built.md` § Current state and the "as it actually shipped" sections.

## Gates

Run all five before claiming a change is done:

| Command | Notes |
|---|---|
| `pnpm lint` | ESLint. |
| `pnpm typecheck` | `tsc --noEmit`. Nothing local runs it for you. Several exhaustiveness guards are compile-time only. **After adding or renaming a route, run `npx next typegen` first**, or `PageProps<"/…">` fails with a misleading `AppRoutes` error. |
| `pnpm test` | Vitest, unit and integration. Includes `pnpm test:rls` (`tests/integration/rls`). |
| `pnpm test:e2e` | Playwright against a real browser and the local stack. It starts its own dev server (`PLAYWRIGHT_REUSE_SERVER=1` reuses one on :3000). It covers the golden paths, tenant breakout, refusal parity, axe scans, keyboard-only journeys and the storage census. Run `npx playwright install chromium` once per machine. |
| psql RLS suite | `npx supabase db reset --local`, then `bash supabase/tests/run-rls-tests.sh`. It refuses a second run without a reset. Every suite goes through `run_suite()`, which fails on any `psql: ERROR:` line and on a **pinned assertion total**. Update the pin when you add assertions. |

**Measure counts, never increment them:**
- Playwright: `npx playwright test --list`.
- Axe scans: `grep -c "await scan(\|new AxeBuilder" tests/e2e/*.spec.ts`.
- psql: the `run_suite` pins in `run-rls-tests.sh`.

**One stack per worktree** is opt-in: `pnpm stack:claim` gives a worktree its own project id and ports, and you must export `SUPABASE_WORKDIR` as it prints, or a bare `npx supabase db reset` still resets the shared stack. Recipe and the tiered-gate policy (what to run while iterating; the full five gates still gate every handback): `docs/parallel-stacks.md`.

**CI runs every gate**, in five jobs on pull requests and pushes to `main`: `gates` (lint, `next typegen`, typecheck, `vitest run tests/unit`), `scan` (`pnpm audit --audit-level high`, gitleaks, the licence allowlist `scripts/check-licenses.mjs`, Semgrep), and three jobs that each start a real local stack: `integration`, `psql` and `e2e`. `tests/unit/ci/workflow-jobs.test.ts` pins that shape. A green CI tick is still not a green launch: nothing in CI checks the hosted project (`SECURITY.md` § 15). Actions are pinned to full SHAs. To bump one, look it up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and update the `# vX.Y.Z` trailer.

**Forbidden here:** `pnpm build` / `pnpm start` in a worktree pointed at the local stack. They resolve to the **hosted** project.

**Do not start the ClamAV container on this machine.** The 2 GB Docker VM cannot hold it beside Supabase, and it hung the VM once. Runbook: `docs/clamav.md`.

Skills are pinned project-level. Restore them with `npx skills experimental_install` and check for updates with `npx skills check`. The roster is in `DESIGN.md` § "Build-time design tooling".

## Git workflow (required)

- Commit and push after every change: one logical change per commit, pushed immediately.
- Never leave the working tree dirty at the end of a task.
- Work on a branch and open a PR for non-trivial changes. Never commit feature work straight to `main`.
- Never commit secrets, `.env` files, service-role keys or private-bucket contents.

## Architecture

**Backend:** Supabase. Postgres is the system of record; Supabase Auth handles identity; Storage holds files in private buckets only; RLS controls row access. **Frontend:** Next.js App Router, desktop-first, no native mobile at MVP.

### Tenancy model

`Organisation` is the tenant. Users belong to one or more organisations via `organisation_memberships`, and the workspace switcher ships at MVP. Every tenant-owned table has a reliable row → organisation path. RLS derives the user from the session and checks membership **in the database**. Never trust a client-supplied organisation ID.

### The private/network split (highest-risk boundary)

- Network identities (`network_profiles`, `network_links`) and tenant-private records live in **separate tables**.
- Discovery reads only explicitly published fields. Publishing is opt-in per field.
- **The two views are the only foreign read path.** The base `network_profiles` table answers only its own organisation's members (its cross-tenant row policy was dropped in Phase 10 Task 19, because a row policy cannot hide columns). A foreign profile reaches a caller only through the **definer** views `network_directory` and `network_connected_profiles`, whose WHERE clauses call `private.network_profile_reaches_caller` and whose dependencies are pinned from `pg_depend`. Never join a private table into them.
- **Request-to-connect.** An accepted request unlocks only the other side's `connections`-level *published fields*, organisation-wide (Q80). It never unlocks notes, ratings, financials, documents, events or activity.
- Linking a private record to a network profile is **manual only**: an empty search box, no suggestions. The link is private to the linking organisation.
- **Ratings are permanently private in v1.** No aggregate, ever, without a deliberate future decision.

### Domain entities

Organisation, User, Contact, Company, Artist/DJ, Agency, Venue (+ rooms), Supplier, Event (+ lineup), Tour, Offer/Hold/Booking, Task, Meeting, Note, Email activity, Document (+ versions), Financial entry, Relationship, Rating, Network profile, Audit event, Notification, Consent, Data subject request, Integration connection, Feedback. The full table list is in PRD §11.

These look like gaps but are deliberate (detail in `docs/as-built.md`):
- `events.status` values are **labels with no state machine**. Offers/holds/bookings are not MVP.
- Events are **not dedup-screened or mergeable**. A lineup artist is always a real `artists` row. `venue_id` is nullable.
- Note visibility is binary (`private` | `company`). A company note is editable only by its author.
- `document_versions` is dormant (versioning is Release 1.1).
- `documents.deleted_at` and `retention_class` are database-owned retention clocks. A client cannot write them.
- Malware scanning: an EICAR stub when `MALWARE_SCANNER` is unset, fail-closed ClamAV (`MALWARE_SCANNER=clamav`) in production. A misconfiguration throws. It never falls back to the stub.
- Integrations (Phase 9) are **schema only**. No provider is live, so `connect_integration()` always refuses. Tokens live in Supabase Vault, and writes are RPC-only.
- **Dedup:** only an exact, case-insensitive email match auto-merges, which means contacts only. Everything else, name included, is flagged for manual review. Every merge is audited.

### Permissions

An action is allowed only if **all** of these permit it: platform policy ∩ subscription entitlement ∩ organisation role ∩ record scope ∩ user exception. Entitlements are enforced **server-side**, because hiding UI is not enforcement.

Roles: Owner, Admin, Manager, Booker, Venue Manager, Finance, Marketing, Standard User, Read Only, Platform Superuser.

`organisations.deleted_at is not null` is **the** read-only flag that every gate reads. `lifecycle_state` is a discriminator beside it, held equivalent by a CHECK constraint. Only a few permission keys have `survives_suspension = true` (`view_crm`, `end_support_access`, `export_organisation_data`). Adding one is a deliberate decision.

Tier gates go through **one effective-tier function per language**: `private.effective_organisation_plan()` in SQL and `getOrganisationEntitlements()` in TypeScript. Never fork a gate. A downgrade makes features read-only or limited and never deletes data.

### Subscription tiers

Per-seat pricing in GBP, monthly or annual (15% off annual), no seat minimum. Enterprise is deferred.

| Tier | Price | CRM writes | Network profile | Custom fields | Finance module | Storage |
|---|---|---|---|---|---|---|
| Free | £0 | No (view-only network browsing) | No | 0 | No | — |
| Starter | £19/seat/mo | Yes | Yes, can publish | 5 per entity | No | 5GB/org |
| Pro | £39/seat/mo | Yes | Yes, can publish | Unlimited | Yes (budget & actuals) | 20GB/org |

### Superuser dashboard

There is a single hardcoded superuser (the founder) at MVP. Every `/super` request from a caller not on the allowlist is rewritten to `/super/not-found` in `lib/supabase/middleware.ts`, so a refusal is indistinguishable from a missing page.

- **No direct tenant-data access.** Only aggregates. Any deeper look goes through impersonation.
- **Impersonation is break-glass:**
  - The superuser requests it with a reason, the org admin accepts, and the superuser starts it behind step-up.
  - It is read-only (the `read_only` role's keys at full record scope) and time-boxed at 60 minutes. The time box **is** the grant: no membership row is created.
  - Every org-scoped page is bannered and audited by route (no query string).
  - Support access cannot extend itself. The customer can always end it, even when the workspace is suspended.
- **Org lifecycle** (`/super/organisations`): suspend, close and reopen. These are soft-delete only, need step-up and a reason, are audited and reversible, and are written only through audited RPCs. An Owner cannot change the lifecycle columns, except through `close_my_workspace()`, which the superuser then decides at `/super/closures`. The retention sweep purges a closed workspace 60 days later (Q88).
- **Billing and feature overrides** (`/super/billing`): separate tables, never edits to `organisation_subscriptions`. Each needs step-up, a reason and a **mandatory future expiry**. They revert by **read-time expiry**, with nothing scheduled.
- **Health, rate limits and alerts** (`/super/health`):
  - Limits live in `public.rate_limit_policies`. TypeScript never holds a number.
  - Reads are metered app-side at the `lib/list/query.ts` chokepoint. Writes are metered by DB triggers at the insert. A direct PostgREST GET is unmetered, a known residual (Q107).
  - Login lockout is a GoTrue hook, **which must be enabled in the hosted dashboard**.
  - Incident alerts are `incident_alerts` rows, delivered as an email digest plus a counts-only Telegram message by the single `pg_cron` 10-minute tick.
- **Audit log viewer** (`/super/audit-log`): searchable by org, actor, action and date. Superuser access audits itself.

### In-app feedback

- Any signed-in user on any tier can send bug / idea / other. It is always identified.
- Attribution (user, email, role, workspace, route without query string, user agent) is stamped **by the database** and is outside the client's INSERT grant.
- The rate limit is 10 per hour, enforced by the `BEFORE INSERT` trigger.
- No submitter can read any row, including their own.
- The optional screenshot goes through the full file pipeline (private bucket, magic-byte sniff, malware scan). The UI warns before the picker that it may capture on-screen data.
- Every superuser view of a screenshot is audited before a 60-second signed URL is minted.
- The founder gets an email through the one Brevo sender (`lib/email/send.ts`), sent after the response. A failure leaves `notified_at` null and is visible on `/super/feedback`.
- Retention is 2 years.

### Session security

- Inactivity timeout 30 minutes; absolute lifetime 12 hours.
- MFA is **required** for Platform Superuser, Owner, Admin and Finance, and optional for everyone else.
- Step-up re-auth is required before: security-setting changes, large exports, deleting org data, and any high-risk admin/superuser function (impersonation included).
- Sign-in: email/password, magic link and Google. Microsoft SSO is post-MVP.

### Non-functional targets

99.9% availability SLO. RPO 24h / RTO 4h. **UK/EU region only** (Supabase in Ireland, eu-west-1). GBP only, but money is stored in minor units with a currency column.

## Non-negotiable rules

These are acceptance criteria, not hardening tasks. A feature is not done until they hold.

- **RLS on before access.** Enable RLS on every tenant-owned table before the app can reach it.
- **Service-role keys stay server-side.** They bypass RLS. `lib/supabase/service.ts` importers are censused.
- **Parameterise everything.** Search, filter and sort inputs map to allowlisted columns and operators.
- **Paginate everything.** Use a server-side page-size ceiling and keyset pagination for feeds. Exports are async and bounded: they fail at a ceiling and never truncate.
- **Files are private.** Use private buckets, short-lived signed URLs issued after authorisation, opaque storage keys, logged access, malware scanning with quarantine, and a strict type allowlist checked by content, not just MIME or extension.
- **Treat user content as untrusted.** Sanitise rich text, reject `javascript:` and `data:` URLs, avoid `dangerouslySetInnerHTML`, and keep the strong CSP.
- **Audit high-value actions.** Record actor, org, timestamp, action, target, correlation ID and before/after. Audit payloads are **name-only diffs** and never carry tenant content (the log is superuser-readable). New client-writable tables are caught by `private.audit_coverage()`. Never log passwords, tokens or keys. Retention: 30 days hot, 1 year total.
- **Soft-delete operational records**, subject to retention. All periods live in `private.retention_periods()`, and every `public` table must be classified.
- **UTC in the database**, UK local time in the UI. UUID primary keys. Index every foreign key.
- **A refusal looks like not-found.** Record and `/super` refusals follow the streamed not-found contract (`DESIGN.md` § Error pages). Never return a 403 that confirms existence.
- **Show outcomes where the action can't unmount them.** Use `components/ui/action-outcome.tsx`.

## Design

- **Read `DESIGN.md` before writing UI.** Its tokens outrank every skill default.
- Look: minimalist and sharp-edged, a bold serif (Source Serif 4) on a near-black ground. `--radius: 0`, no shadows, no gradients.
- **One brand green**, `#20FC8F`. Always use a token, never a literal hex.
- `tabular-nums` on every number in a table.
- Run `python scripts/contrast.py` after touching any colour.
- Skill passes: Decide (brainstorming → hallmark → ui-ux-pro-max → frontend-design), Build, then Review (web-design-guidelines, accessibility-compliance, vercel-react-best-practices). The full contract is in `DESIGN.md` § "Build-time design tooling".
- Priorities: dense but uncluttered, keyboard-first (Ctrl/Cmd-K palette), contextual drawers, one shared timeline component, empty states that teach, and WCAG 2.2 AA from the start.
- Golden path to protect: create contact → create event → add artist → add venue → add task → view activity. It is walked by `golden-path`, `events`, `operations`, `finance` and `network` specs. Extend it with a new sibling spec rather than rewriting one.

## Testing gates

A release needs:
- RLS integration tests across roles, tenants and network visibility
- API tests for validation, pagination and rate limiting
- Security tests: XSS, SQLi, IDOR/BOLA, CSRF, sessions, file access, privilege escalation, tenant breakout
- Accessibility: axe plus keyboard and screen-reader spot checks
- Dependency and secret scanning in CI

**Tenant-breakout and network-leakage tests matter most. Write them alongside the feature.**

Where they live:
- `supabase/tests/*.sql`: role and tenant isolation.
- `rls_phase6_network.sql` and `network_leakage_phase6.sql`: network visibility.
- `tests/integration/security/phase7-permission-matrix.test.ts` and `tests/e2e/super-permissions.spec.ts`: privilege escalation. Both are **censuses built from the live catalogue and route tree**, so a new RPC, table, grant or `/super` page lands as a red test until it is declared.
- Pair every refusal with a positive control. A refusal that passes for lack of a fixture looks identical to one that passes because the guard held.

Skills: `supabase`, `supabase-postgres-best-practices`, `supabase-audit-rls` (dev/staging, anon key only), `owasp-security-check`, `javascript-testing-patterns`, `e2e-testing-patterns`, `wcag-audit-patterns`, `screen-reader-testing`. The mapping is in `SECURITY.md` § 11.

## Scope discipline

**MVP (PRD §4):** auth, orgs and invites; core CRM; events with lineup; tasks, meetings, notes and attachments; basic event finance; RLS isolation; entitlements; network profiles; audit log; legal pages; superuser dashboard; in-app feedback.

**Not MVP — don't build ahead:**
- Email/calendar integration
- Offers/holds/contracts, settlements, ticketing APIs
- File versioning
- Public profiles; tours
- AI features; an external API
- First-class suppliers (they are a Contact/Company tag)
- Verification badges; Microsoft SSO; an Enterprise tier

Finance is **budget & actuals only** (fee, cost and income lines per event). No invoicing, no P&L.

## Decisions log

Resolved 2026-08-26 (founder sign-off), and still binding:

- **Product:** Next.js frontend. Multi-org from MVP. Request-to-connect discovery. Suppliers not first-class. Ratings permanently private in v1. Network verification deferred.
- **Pricing and tiers:** Free / Starter £19 / Pro £39 per seat, 15% off annual, Enterprise deferred. Gating is seats plus features. The Free tier is view-only network with no CRM writes. Custom fields are tier-gated.
- **Finance and money:** budget & actuals only. GBP only, multi-currency-ready schema.
- **Retention and privacy:** 7 years financial, 2 years inactive (pending counsel). Audit log 30 days hot / 1 year total. DSR turnaround 30 days.
- **Superuser and feedback:** impersonation needs admin acceptance, a time box and full audit. The superuser dashboard and in-app feedback are MVP (scope as above).
- **Security:** sessions 30 min idle / 12 h absolute. MFA for Superuser, Owner, Admin and Finance. Step-up triggers as listed. Malware scanning plus a strict allowlist at MVP. Google SSO at MVP.
- **Operations and data:** 99.9% SLO. RPO 24h / RTO 4h. UK/EU residency. Dedup auto-merges on exact email only.

Later rulings are recorded per question in the decisions queue (see § Project).

## Open decisions (need founder sign-off — ask, don't assume)

- First ticketing API partner (deferred with ticketing).
- Exact retention periods per record type (counsel, Q133).
- EU Art 27 representative.
- DPIA, ROPA and ICO registration (legal tasks, not engineering defaults).
- Analytics/tracking vendor. This decides whether a PECR cookie banner is needed (see `SECURITY.md` § 8).
- Payment processor. It must be PCI-DSS compliant and used via tokenisation or redirect.

## Legal and regulatory compliance

**Counsel must review legal pages and compliance decisions before launch.** Drafts are a starting point, never a substitute.

- **Frameworks:** UK GDPR + DPA 2018, with EU GDPR built to in parallel. PECR covers marketing and non-essential cookies. The Equality Act backs the accessibility requirement.
- **Lawful basis:** contract for core CRM. Legitimate interests for analytics, abuse prevention and feedback. Consent only for marketing and non-essential cookies, never bundled. No special-category data: a feature that would collect it needs a DPIA first.
- **Sub-processors:**
  - Every vendor needs a DPA, plus a line in `docs/sub-processors.md` and `lib/legal/sub-processors.ts` **in the same change** that first sends it personal data. A drift test binds the two lists.
  - A vendor outside the UK/EU needs adequacy, the IDTA or SCCs first.
- **Legal pages:** the fifteen `/legal/<slug>` pages are versioned in `public.legal_documents` and edited at `/super/legal`. They are **all engineering drafts** carrying a non-dismissable notice until counsel's review of that exact version is recorded. Published versions are immutable.
- **Cookies:** no banner today. A storage census (`tests/unit/legal/storage-census.test.ts` in CI, plus a local browser check) fails on any undeclared cookie, storage write or tracker. Adding a vendor means consent-before-load, a banner, an inventory entry and a sub-processor entry, together.
- **Rights:** `/account/privacy` handles consent, an append-only ledger. `/account/data-requests` handles DSRs, with `due_by` computed by the database and enforced. `/account/exports` and `/[orgSlug]/settings/export` produce exports, read with the requester's own rights. `/account/erase` erases an account in one transaction that pseudonymises the audit trail to a tombstone and refuses for the last Owner (Q131).
- **B2B:** individual users in customer orgs keep full GDPR rights.
- **Breaches:** 72-hour notification, under `SECURITY.md` § 12.
- **Payments:** no card data is ever handled directly.
