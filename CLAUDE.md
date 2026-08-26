# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**GetSetPaid** — a UK-first, multi-tenant CRM for the live events industry (promoters, venues, booking agents, DJs/artists, suppliers). It combines a **private per-company CRM** with a **controlled industry network**, so each business keeps its operational data private while being able to discover and connect with other industry entities.

Core workflow the product exists to serve:
`relationship → enquiry/hold → booking/event → delivery → settlement/history`

**`getsetpaid_crm_prd.docx` in the repo root is the source of truth.** Read the relevant section before implementing a feature — it defines entities, roles, security controls and acceptance criteria in detail. This file is a summary, not a replacement.

The PRD is a binary docx and no text version is committed. To read it, run `python scripts/read-prd.py` (see below), or unzip `word/document.xml` and strip the tags.

## Current state

The repo contains **no application code yet** — only the PRD, the design and security docs, and the pinned agent skills (`skills-lock.json` + `.agents/skills/`). There is no build, lint or test command yet. When the stack is scaffolded, adding those commands to this file is part of that work.

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

Organisation, User, Contact, Company, Artist/DJ, Agency, Venue (+ rooms), Supplier, Event (+ lineup), Tour, Offer/Hold/Booking, Task, Meeting, Note, Email activity, Document (+ versions), Financial entry, Relationship, Rating, Network profile, Audit event, Notification, Consent, Data subject request, Integration connection.

Full baseline table list is in PRD §11.

**Duplicate contacts/companies:** exact matches (email/name) auto-merge; fuzzy matches are flagged for manual review, never auto-merged silently. Every merge is audited.

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
- **Soft-delete operational records** rather than hard deletion, subject to the retention policy. Default retention: 7 years for financial records, 2 years for inactive-account data — confirm exact periods per record type with legal counsel before launch (see Legal).
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

## Testing gates

Beyond unit tests, a release needs: **RLS integration tests across roles, tenants and network visibility**; API tests for validation, pagination and rate limiting; security tests for XSS, SQLi, IDOR/BOLA, CSRF, session handling, file access, privilege escalation and tenant breakout; accessibility (automated plus keyboard/screen-reader spot checks); dependency and secret scanning in CI.

Tenant-breakout and network-leakage tests matter most — write them alongside the feature, not after.

**Skills for these gates** (pinned project-level; full mapping in `SECURITY.md` § 11): `supabase` and `supabase-postgres-best-practices` for schema and policy design, `supabase-audit-rls` for RLS bypass auditing (**dev/staging only, anon key only**), `owasp-security-check` for the XSS/SQLi/IDOR/CSRF pass, `javascript-testing-patterns` for RLS integration and API tests, `e2e-testing-patterns` for Playwright golden-path and tenant-breakout runs, `wcag-audit-patterns` and `screen-reader-testing` for accessibility.

## Scope discipline

MVP (PRD §4) is: auth + orgs + invites, core CRM entities, events with lineup, tasks/meetings/notes/attachments, basic event finance, RLS isolation, entitlements, network profiles, audit log, legal pages.

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
- **Dedup/merge:** exact matches auto-merge, fuzzy matches flagged for manual review.
- **Custom field limits:** tier-gated (free: none, paid: more).
- **Network profile verification:** deferred past MVP.

## Open decisions (need founder sign-off — ask, don't assume)

- **First ticketing API partner** — deliberately deferred; ticketing integration is out of MVP scope, revisit when that phase starts.
- **Exact retention periods per record type** — working defaults are set above (financial, inactive-account, audit log); needs sign-off from qualified UK legal/privacy counsel before launch (see Legal).

## Legal

Legal pages and compliance decisions require review by qualified UK legal/privacy counsel before launch. Drafted content is a starting point for that review, never a substitute for it. PRD §12 lists the required pages and the ICO/OWASP sources behind them.

**Data subject request (export/erasure) target: 30 days**, matching the ICO statutory maximum. Build the DSR workflow to hit this deadline, not just aim for it informally.
