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

**Frontend:** not yet decided (see Open decisions). Desktop-first responsive web app; no native mobile for MVP.

### Tenancy model

`Organisation` is the tenant. Users belong to one or more organisations via `organisation_memberships`, with an explicit active-workspace selector in the UI. Every tenant-owned table must have a reliable row → organisation path, and RLS derives the current user from the authenticated session and checks membership **in the database**. Never trust a client-supplied organisation ID.

### The private/network split (highest-risk boundary)

Network identities and tenant-private records are **separate concepts in separate tables** (`network_profiles`, `network_links` vs. the tenant tables). Matching a private contact to a network identity must never expose private notes, ratings, financials, documents or activity. Discovery queries read only explicitly published fields, and publishing is opt-in per field. Do not join private tables into public discovery paths without an explicit, tested policy.

### Domain entities

Organisation, User, Contact, Company, Artist/DJ, Agency, Venue (+ rooms), Supplier, Event (+ lineup), Tour, Offer/Hold/Booking, Task, Meeting, Note, Email activity, Document (+ versions), Financial entry, Relationship, Rating, Network profile, Audit event, Notification, Consent, Data subject request, Integration connection.

Full baseline table list is in PRD §11.

### Permissions

An action is allowed only if **all** of these permit it: platform policy ∩ subscription entitlement ∩ organisation role ∩ record scope ∩ user-specific exception. Entitlements are enforced **server-side** — hiding UI is not enforcement. Roles: Owner, Admin, Manager, Booker, Venue Manager, Finance, Marketing, Standard User, Read Only, Platform Superuser.

Downgrading a subscription makes features read-only or limited; it must never silently delete data.

## Non-negotiable rules

These are acceptance criteria, not hardening tasks. A feature is not done until they hold.

- **RLS on before access.** Enable RLS on every tenant-owned table before the application can reach it. Separate policies per operation where useful.
- **Service-role keys stay server-side.** They bypass RLS. Never ship them to the browser.
- **Parameterise everything.** No string-concatenated SQL. Search/filter/sort inputs map to allowlisted columns and operators.
- **Paginate everything.** No unbounded list endpoint. Server-side page-size ceiling; cursor/keyset pagination for activity feeds. Exports are async and bounded.
- **Files are private.** Private buckets, short-lived signed URLs issued after authorisation, MIME/extension validation, sanitised filenames (never user-supplied paths as storage keys), every access logged.
- **Treat all user content as untrusted.** Sanitise rich text; validate URL protocols (reject `javascript:`, `data:`); avoid `dangerouslySetInnerHTML`; ship a strong CSP.
- **Audit high-value actions.** Actor, org, timestamp, action, target, correlation ID, before/after. Append-only from the application. Superuser access audits itself. Never log passwords, tokens or keys.
- **Soft-delete operational records** rather than hard deletion, subject to the retention policy.
- **UTC in the database**, UK local time in the UI with explicit timezone handling. UUID primary keys. Index every foreign key.

## Design

Use a **bespoke design system** — the product must not look like a re-skinned generic sales CRM. The `hallmark` skill (pinned in `skills-lock.json`) and `ui-ux-pro-max` are the intended design tooling.

Priorities: high information density without clutter; keyboard-first navigation and global command/search; contextual drawers for quick edits; one consistent timeline/activity component reused across every entity; status chips and relationship indicators; empty states that teach the workflow; WCAG 2.2 AA from the start, not retrofitted.

Golden path to prototype and protect: create contact → create event → add artist → add venue → add task → view activity.

## Testing gates

Beyond unit tests, a release needs: **RLS integration tests across roles, tenants and network visibility**; API tests for validation, pagination and rate limiting; security tests for XSS, SQLi, IDOR/BOLA, CSRF, session handling, file access, privilege escalation and tenant breakout; accessibility (automated plus keyboard/screen-reader spot checks); dependency and secret scanning in CI.

Tenant-breakout and network-leakage tests matter most — write them alongside the feature, not after.

## Scope discipline

MVP (PRD §4) is: auth + orgs + invites, core CRM entities, events with lineup, tasks/meetings/notes/attachments, basic event finance, RLS isolation, entitlements, network profiles, audit log, legal pages.

**Not MVP:** email/calendar integration, offers/holds/contracts workflow, settlements, ticketing APIs, file versioning, public profiles and connection requests, tour management, AI features, external API. Don't build ahead into these.

Finance starts at event/booking level. Resist expanding it toward accounting software — that is an integration, later.

## Open decisions (need founder sign-off — ask, don't assume)

Frontend stack; subscription tiers and plan limits; multi-org membership at MVP; whether superusers may impersonate and what break-glass controls apply; the network discovery model (public vs authenticated-only vs request-to-connect); whether ratings stay permanently private in v1; exact MVP finance scope; first ticketing API partner; whether suppliers are first-class at MVP; retention periods.

## Legal

Legal pages and compliance decisions require review by qualified UK legal/privacy counsel before launch. Drafted content is a starting point for that review, never a substitute for it. PRD §12 lists the required pages and the ICO/OWASP sources behind them.
