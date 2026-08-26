# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**GetSetPaid** — a UK-first, multi-tenant CRM for the live events industry (promoters, venues, booking agents, DJs/artists, suppliers). It combines a **private per-company CRM** with a **controlled industry network**, so each business keeps its operational data private while being able to discover and connect with other industry entities.

Core workflow the product exists to serve:
`relationship → enquiry/hold → booking/event → delivery → settlement/history`

**`getsetpaid_crm_prd.docx` in the repo root is the source of truth.** Read the relevant section before implementing a feature — it defines entities, roles, security controls and acceptance criteria in detail. This file is a summary, not a replacement.

The PRD is a binary docx and no text version is committed. To read it, run `python scripts/read-prd.py` (see below), or unzip `word/document.xml` and strip the tags.

## Current state

The repo contains **no application code yet** — only the PRD, `skills-lock.json` (pins the `hallmark` design skill) and `.agents/skills/hallmark/` reference docs. There is no build, lint or test command yet. When the stack is scaffolded, adding those commands to this file is part of that work.

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

### Permissions

An action is allowed only if **all** of these permit it: platform policy ∩ subscription entitlement ∩ organisation role ∩ record scope ∩ user-specific exception. Entitlements are enforced **server-side** — hiding UI is not enforcement. Roles: Owner, Admin, Manager, Booker, Venue Manager, Finance, Marketing, Standard User, Read Only, Platform Superuser.

Downgrading a subscription makes features read-only or limited; it must never silently delete data.

Pricing shape: **free + paid tiers** (exact tier definitions and plan limits still to be specified — see Open decisions).

### Superuser impersonation

A platform superuser may impersonate a customer account for support, but only via break-glass: the superuser requests impersonation, the org's admin must accept the request, and the session is time-boxed and fully audited (actor, org, reason, start/end). No silent or unilateral impersonation.

## Non-negotiable rules

These are acceptance criteria, not hardening tasks. A feature is not done until they hold.

- **RLS on before access.** Enable RLS on every tenant-owned table before the application can reach it. Separate policies per operation where useful.
- **Service-role keys stay server-side.** They bypass RLS. Never ship them to the browser.
- **Parameterise everything.** No string-concatenated SQL. Search/filter/sort inputs map to allowlisted columns and operators.
- **Paginate everything.** No unbounded list endpoint. Server-side page-size ceiling; cursor/keyset pagination for activity feeds. Exports are async and bounded.
- **Files are private.** Private buckets, short-lived signed URLs issued after authorisation, MIME/extension validation, sanitised filenames (never user-supplied paths as storage keys), every access logged.
- **Treat all user content as untrusted.** Sanitise rich text; validate URL protocols (reject `javascript:`, `data:`); avoid `dangerouslySetInnerHTML`; ship a strong CSP.
- **Audit high-value actions.** Actor, org, timestamp, action, target, correlation ID, before/after. Append-only from the application. Superuser access audits itself. Never log passwords, tokens or keys.
- **Soft-delete operational records** rather than hard deletion, subject to the retention policy. Default retention: 7 years for financial records, 2 years for inactive-account data — confirm exact periods per record type with legal counsel before launch (see Legal).
- **UTC in the database**, UK local time in the UI with explicit timezone handling. UUID primary keys. Index every foreign key.

## Design

**`DESIGN.md` holds the colour, type, spacing and shape tokens. Read it before writing any UI.**

Direction in one line: minimalist, sharp-edged, bold serif — square corners everywhere (`--radius: 0`), no shadows, no gradients, structure from hairline rules and typographic weight.

Palette is `#FFF4F4` shell, `#BDB2FF` lilac and `#FFD6E0` pink as surfaces, `#14141C` ink for all text, and **two blues**: `--primary` `#0062FF` is the only blue permitted on text or a button (the source `#3A86FF` fails AA at 4.5:1); `--accent` `#3A86FF` is borders, focus rails, active state and charts. That split is the single easiest thing to get wrong — always go through the token, never a literal hex.

Type is Source Serif 4 throughout, with `tabular-nums` mandatory on every number in a table.

`python scripts/contrast.py` audits the whole token contract against WCAG 2.2 AA and exits non-zero on any failure. Run it after touching a colour; any colour added to `DESIGN.md` arrives with its measured ratio.

The product must not look like a re-skinned generic sales CRM. **`DESIGN.md` § "Build-time design tooling" is the contract for which design/UI/UX skills to invoke and in what order** — `superpowers:brainstorming` → `hallmark` (pinned in `skills-lock.json`) → `ui-ux-pro-max` → `frontend-design` → `ui-ux-pro-max:ui-styling`, plus `dataviz` for charts and `framer-motion-best-practices` for motion. Skills supply method; `DESIGN.md` supplies the tokens and outranks every skill default (rounded corners, shadows, gradients, sans stacks).

Priorities: high information density without clutter; keyboard-first navigation and global command/search; contextual drawers for quick edits; one consistent timeline/activity component reused across every entity; status chips and relationship indicators; empty states that teach the workflow; WCAG 2.2 AA from the start, not retrofitted.

Golden path to prototype and protect: create contact → create event → add artist → add venue → add task → view activity.

## Testing gates

Beyond unit tests, a release needs: **RLS integration tests across roles, tenants and network visibility**; API tests for validation, pagination and rate limiting; security tests for XSS, SQLi, IDOR/BOLA, CSRF, session handling, file access, privilege escalation and tenant breakout; accessibility (automated plus keyboard/screen-reader spot checks); dependency and secret scanning in CI.

Tenant-breakout and network-leakage tests matter most — write them alongside the feature, not after.

## Scope discipline

MVP (PRD §4) is: auth + orgs + invites, core CRM entities, events with lineup, tasks/meetings/notes/attachments, basic event finance, RLS isolation, entitlements, network profiles, audit log, legal pages.

**Not MVP:** email/calendar integration, offers/holds/contracts workflow, settlements, ticketing APIs, file versioning, public profiles and connection requests, tour management, AI features, external API, first-class supplier management (suppliers exist only as a generic Contact/Company tag at MVP). Don't build ahead into these.

Finance starts at event/booking level and MVP scope is **budget & actuals only** — fee, cost and income lines per event, no invoicing, no full P&L. Resist expanding it toward accounting software or invoicing — that is an integration, later.

## Decisions log

Resolved 2026-08-26 (founder sign-off):

- **Frontend:** Next.js (React).
- **Multi-org:** supported from MVP, not deferred.
- **Network discovery:** request-to-connect (see private/network split).
- **Suppliers:** not first-class at MVP.
- **Pricing shape:** free + paid tiers.
- **Ratings:** permanently private in v1.
- **Finance scope:** budget & actuals only at MVP.
- **Retention:** 7yr financial / 2yr inactive as working defaults, pending legal review.
- **Superuser impersonation:** allowed, but only with org-admin acceptance, time-boxing and full audit.

## Open decisions (need founder sign-off — ask, don't assume)

- **Exact subscription tier definitions and plan limits** — the free/paid shape is decided, the specific tiers and limits are not.
- **First ticketing API partner** — deliberately deferred; ticketing integration is out of MVP scope, revisit when that phase starts.
- **Exact retention periods per record type** — working defaults are set above; needs sign-off from qualified UK legal/privacy counsel before launch (see Legal).

## Legal

Legal pages and compliance decisions require review by qualified UK legal/privacy counsel before launch. Drafted content is a starting point for that review, never a substitute for it. PRD §12 lists the required pages and the ICO/OWASP sources behind them.
