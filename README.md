<p align="center">
  <img src="brand/logo_with_text.png" alt="GetSetPaid" width="360">
</p>

# GetSetPaid

A UK-first, multi-tenant CRM for the live events industry: promoters, venues, booking agents, DJs/artists and suppliers.

Each company keeps a **private CRM**, and can also publish a profile to a **controlled industry network** to discover and connect with other businesses. The workflow it is built around:

`relationship → enquiry/hold → booking/event → delivery → settlement/history`

## What's built

- **Auth and organisations:** email and Google sign-in, multi-organisation workspaces, roles and subscription-tier entitlements
- **Core CRM:** contacts, companies, and list views
- **Events:** events with their lineup
- **Operations:** tasks, meetings, notes, and documents (private storage bucket; uploads go through a scan-and-quarantine pipeline, currently using a stub scanner rather than a real malware engine)
- **Finance:** event-level budgeted fees, actual income and expenses, with a gross/expense/net summary (role- and tier-gated)
- **Network:** publishable profiles, a browsable directory, request-to-connect, and manual linking of a private record to a network profile

## Tech stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · Supabase (Postgres, Auth, Row Level Security, Storage) · Framer Motion · pnpm

## Security and tenancy

Tenant isolation is enforced in the database with Row Level Security, not only in application code. Migrations live in `supabase/migrations/`.

## Testing

| Command | What it runs |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm test:rls` | RLS integration tests |
| `pnpm test:e2e` | Playwright end-to-end tests, including tenant-breakout tests and an axe accessibility scan of each page |

CI (`.github/workflows/ci.yml`) runs lint, typecheck and unit tests, then a dependency audit (`pnpm audit`) and a secret scan (gitleaks) on every pull request.

## Run it locally

Prerequisites: Node.js, [pnpm](https://pnpm.io), Docker (for the local Supabase stack).

```bash
git clone https://github.com/arxh80/Getsetpaid.git
cd Getsetpaid
pnpm install
npx supabase start
npx supabase db reset --local
pnpm dev
```

Open http://localhost:3000.

`pnpm dev` reads the keys from the running local Supabase stack and writes them to a git-ignored `.env.development.local` (see `scripts/dev-env.mjs`), so there is nothing to copy for local development. `.env.example` lists the variables a hosted deployment needs, including the Google OAuth client for Google sign-in.

For the end-to-end tests, run `npx playwright install chromium` once first.

## Project docs

- [`DESIGN.md`](DESIGN.md): design system and UX decisions
- `CLAUDE.md`: project guidance and the test gates

## About this project

I built this as a portfolio project, working with AI coding tools (Claude Code). The requirements, schema, security model and test gates are documented in this repo.
