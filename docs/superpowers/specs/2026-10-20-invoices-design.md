# Invoices (part 1 of 3): design

Date: 2026-10-20. Status: approved in brainstorming, awaiting spec review.
Branch: `invoicing`, off the `launch-hardening` tip; its PR stacks after the
Phase 10 PR.

## Why, and what changed

Until now finance was "budget & actuals only, no invoicing" (CLAUDE.md
§ Scope discipline). The founder reversed that on 2026-10-20: workspaces
can generate invoices, and later take card payment through their own
linked Stripe account. This is a scope change by founder decision, recorded
in DECISIONS-QUEUE and reflected in CLAUDE.md when part 1 ships.

The work is split into three sub-projects, each with its own spec, plan and
branch, built in order:

1. **Invoices** (this spec): draft, issue, number, PDF, email, mark paid,
   void, pull lines from event finance. Bank transfer only.
2. **Stripe Connect**: a workspace links its existing Stripe account
   (Standard account, OAuth); an issued invoice gets a "Pay by card" Stripe
   Checkout link as a direct charge on that account, carrying a GetSetPaid
   percentage application fee; a webhook marks the invoice paid. Own spec.
3. **Network delivery**: an invoice to a connected network organisation
   also appears inside that organisation's GetSetPaid. Crosses the
   private/network boundary; own spec and leakage tests.

Founder answers that bind all three parts:

| Question | Answer |
|---|---|
| Timing | Built in parallel with Phase 10 |
| Recipient | Any CRM company/contact by email, and (part 3) connected network orgs in-app |
| Platform fee | A small percentage per Stripe payment (part 2; rate to DECISIONS-QUEUE with a default) |
| Connect type | Link an existing Stripe account (Standard) |
| Line items | Free lines, plus "pull from event finance" |
| Tier | Pro only |
| Without Stripe | Invoicing works; bank details on the invoice; marked paid by hand |
| Approach | Our own invoices (A); Stripe only takes the payment |

## Data model

All four tables are tenant-owned: `organisation_id` on every row, RLS
enabled in the migration that creates them, UUID primary keys, every
foreign key indexed, `created_at`/`updated_at` in UTC, soft delete via
`deleted_at` on `invoices` (drafts only; see Lifecycle).

### `public.invoice_settings` (one row per organisation)

- `organisation_id` (PK and FK)
- `business_name`, `business_address` (text, required before first issue)
- `vat_number` (text, nullable). Null means the business is not VAT
  registered: every line is forced to "no VAT" and the PDF shows no VAT
  column, because a non-registered business must not charge VAT.
- `bank_account_name`, `bank_sort_code` (6 digits), `bank_account_number`
  (8 digits); all nullable, shown on the PDF when set.
- `number_prefix` (text, default `INV-`, shape `^[A-Z0-9-]{0,12}$`)
- `next_number` (integer, default 1, only ever advanced by the issue RPC)
- `payment_terms_days` (integer 0..120, default 30)

### `public.invoices`

- `id`, `organisation_id`
- `status`: `draft` | `issued` | `paid` | `void`
- `number` (text, null while draft; unique per organisation once set)
- `recipient_company_id` / `recipient_contact_id`: exactly one set
  (check constraint), tenant-scoped composite FKs
- `event_id` (nullable, tenant-scoped composite FK)
- `issue_date`, `due_date`, `supply_date` (dates; set at issue;
  `supply_date` defaults to `issue_date`)
- `currency` (`GBP` only, check constraint; column exists for later)
- `net_minor`, `vat_minor`, `gross_minor` (bigint; computed from lines)
- `snapshot` (jsonb, null while draft): the frozen copy taken at issue of
  the seller block (from `invoice_settings`), the recipient block (name,
  address, email from the CRM record), the lines and the totals. The PDF is
  rendered only from this.
- `paid_at`, `paid_by`, `voided_at`, `voided_by`, `void_reason`
- `notes` (text, optional, printed on the invoice)
- `created_by`, timestamps, `deleted_at`

### `public.invoice_lines`

- `id`, `organisation_id`, `invoice_id` (tenant-scoped composite FK)
- `position` (integer)
- `description` (text, required, at most 500 chars)
- `quantity` (numeric(12,2) > 0)
- `unit_price_minor` (bigint >= 0, ex VAT)
- `vat_rate`: `standard_20` | `reduced_5` | `zero` | `exempt` | `none`
- `net_minor`, `vat_minor` (bigint, computed)
- `financial_entry_id` (nullable, tenant-scoped composite FK): set when
  the line was pulled from an event's finance

### `public.invoice_sends`

Append-only log: `id`, `organisation_id`, `invoice_id`, `to_email`,
`sent_by`, `sent_at`, `provider_message_id`. No UPDATE or DELETE policy.

### Arithmetic

Per line: `net = round_half_up(quantity × unit_price_minor)`,
`vat = round_half_up(net × rate)`. Invoice totals are the sums of the line
values. Computed in one SQL function used by both the draft save path and
the issue RPC, so the database is the single source of the numbers; the UI
shows a live preview from a TypeScript port of the same function, held
equal by a unit test over a fixed table of cases.

## Lifecycle

```
draft --issue--> issued --mark paid--> paid
                   |                     |
                   +-------void--------> void <--void--+
```

- **Draft**: editable by `manage_finance`. No number. Soft-deletable.
- **Issue** (`public.issue_invoice(p_invoice_id)`, SECURITY DEFINER):
  re-checks membership, `manage_finance` and the Pro entitlement; refuses
  if settings are incomplete or there are no lines; locks the settings row
  (`for update`), takes `next_number`, writes `number = prefix || lpad(n, 4,
  '0')`, increments `next_number`, sets the dates, builds `snapshot`, and
  flips status, all in one transaction. Two concurrent issues get two
  consecutive numbers; a rolled-back issue consumes no number.
- **Issued**: frozen. A trigger on `invoices` and `invoice_lines` refuses
  any change to an issued invoice's content (lines, recipient, dates,
  totals, snapshot) from any role, including `service_role`; only the two
  RPCs below may change `status` and the paid/void columns.
- **Mark paid** (`public.mark_invoice_paid(p_invoice_id, p_paid_on)`):
  issued only. If the invoice has an event:
  - each line with a `financial_entry_id` whose entry is `budgeted` flips
    that entry to `actual` (its amount is left as it is);
  - the remaining lines' net sum, if non-zero, becomes one new `actual`
    `income` entry on the event, described as "Invoice <number>".
  Income is recorded net of VAT, because VAT collected is owed to HMRC and
  is not income. The RPC records which entries it touched, so void can
  reverse exactly those.
- **Void** (`public.void_invoice(p_invoice_id, p_reason)`): issued or
  paid; reason required. Keeps the number (no gaps in the sequence, ever).
  If it was paid, reverses the finance changes mark-paid made: flipped
  entries go back to `budgeted`, the created entry is soft-deleted.
  Corrections are void-and-reissue. Credit notes are out of scope.

## Permissions and tier

- Reuse the existing keys; no new roles or permissions:
  - `view_finance` reads invoices, lines, sends and settings.
  - `manage_finance` drafts, issues, sends, marks paid and voids.
  Both are held by Owner, Admin and Finance today, all MFA-required roles.
- Saving `invoice_settings` requires step-up re-auth (it changes where
  money is paid).
- **Pro only**, through the existing finance entitlement helper, enforced
  in RLS and in every RPC. Downgrade: invoices become read-only (view and
  download stay), nothing is deleted.

## Screens

All under `/[orgSlug]/`, built to DESIGN.md (dark ground, square corners,
`tabular-nums` on every number), each with a `loading.tsx`.

1. `invoices`: paginated list (keyset, server page-size ceiling), status
   filter, sidebar item shown only to `view_finance` roles.
2. `invoices/new` and `invoices/[id]`:
   - draft: recipient picker (company or contact), optional event, line
     editor (description, quantity, unit price, VAT rate), notes, live
     totals, Save and Issue;
   - issued/paid/void: read-only view with Download PDF, Send, Mark paid
     (date picker) and Void (reason), each offered only where the status
     allows it.
3. Event finance panel: an "Invoice these lines" action. The user ticks
   income lines; a draft is created with those lines prefilled and linked
   via `financial_entry_id`, recipient left for the user to pick.
4. `settings/invoicing`: business details, VAT number, bank details,
   prefix, terms. Step-up on save.

Out of scope: an invoices panel on company/contact pages, recurring
invoices, automatic reminders, credit notes, multiple currencies,
per-sender reply-to, a branded email beyond a plain template.

## PDF

Rendered on demand from `snapshot` by a route handler that authorises
(`view_finance`, record scope) before rendering, audits the download, and
returns `Content-Disposition: attachment; filename="<number>.pdf"` (the
number's shape is constrained, so no user text reaches the filename).
Nothing is stored in a bucket: the snapshot is immutable, so the same
invoice always renders the same content.

Library: `@react-pdf/renderer` (new dependency; no PDF library is
installed and hand-building PDFs is not a few lines). It lays out from
React primitives, not HTML, so user text cannot inject script. Source
Serif 4 is embedded. Build-order step 1 is a spike proving it runs in the
Next.js server runtime; if it does not, stop and re-decide before any
other step.

Fields printed, per HMRC's full VAT invoice requirements: unique sequential
number; issue date; supply date (tax point) when it differs; seller name,
address and VAT number; recipient name and address; per line the
description, quantity, unit price ex VAT, VAT rate and net amount; total
net, total VAT, total gross; due date and bank details. With no VAT number
set, VAT fields are omitted.

## Send

`sendInvoiceAction(invoiceId, toEmail)`: issued or paid only;
`manage_finance`. The recipient email defaults to the contact's email (a
company has no email column, so for a company recipient the field starts
empty) and is editable; it is validated as an email. The message goes
through the existing Brevo sender (`lib/email/send.ts`) with the PDF
attached, plain template. Each send is written to `invoice_sends` and
audited. Rate-limited through `public.consume_rate_limit()` with a new
`invoice_send` category in `public.rate_limit_policies` (per user, default
30/hour; outbound email to arbitrary addresses is a spam vector). Build
step 1 also proves a Brevo attachment of a realistic invoice PDF is
accepted.

## Security

1. The database enforces state: per-operation RLS on all four tables;
   organisation derived from the session's membership, never from the
   client; table UPDATE allowed only on `draft` rows; the three state
   changes only through SECURITY DEFINER RPCs that re-check permission and
   entitlement; the freeze trigger applies to every role.
2. Bank-detail fraud guard: step-up re-auth to save; on any change to the
   bank fields, an email to every active Owner and Admin of the
   organisation; the audit record carries the last four digits of the
   account number only, never the full number.
3. Untrusted content: react-pdf primitives, not HTML; the filename built
   from the constrained number; the send-to address validated; sends
   rate-limited.
4. Private stays private: nothing in the network views reads these
   tables; the existing `pg_depend` assertion on `network_directory` and
   `network_connected_profiles` fails if a future change joins them in.
5. Retention: an issued, paid or void invoice is a financial record, kept
   7 years. A data-subject erasure of a contact soft-deletes drafts that
   name it but leaves issued snapshots intact (legal-obligation basis);
   the erasure and retention runners and the ROPA notes are updated to say
   so.
6. Audit: issue, send, mark paid, void, settings change and PDF download,
   each with actor, organisation, target, correlation ID and before/after.

## Tests

Each control is written failing first and gets a mutant that turns it red.

1. Unit: line and VAT arithmetic over a fixed case table (both the SQL and
   the TypeScript function), number formatting, snapshot building.
2. psql RLS suite (`supabase/tests/rls_invoices.sql`): every role × own
   and foreign tenant × Free/Starter/Pro, for read, draft write, issue,
   mark paid, void and settings; the freeze trigger as `service_role`;
   concurrency (two sessions issue at once: two consecutive numbers, no
   gap, no duplicate); invoices unreachable from the network views.
3. e2e `tests/e2e/invoices.spec.ts`, the sixth golden-path sibling: an
   MFA-challenged Finance user in a Pro workspace fills settings (step-up),
   drafts an invoice from an event's income line plus one free line,
   issues it, downloads the PDF, marks it paid, and reads the income on the
   event's finance summary. Plus: a Starter workspace's disabled Issue
   control refuses server-side with `disabled` stripped (row count
   unchanged); `invoices/[id]` under a foreign slug meets the streamed
   not-found contract; axe scans of the four new pages; the line editor
   driven by keyboard only.

## Build order

1. Spike: `@react-pdf/renderer` in the Next.js server runtime; a Brevo
   send with a PDF attachment. Stop if either fails.
2. Migrations: tables, RLS, arithmetic function, the three RPCs, numbering,
   freeze trigger, rate-limit row; the psql suite.
3. Settings page with step-up and the Owner/Admin bank-change email.
4. List and draft editor.
5. Issue and PDF.
6. Send.
7. Mark paid and void, with the finance link.
8. "Invoice these lines" from the event finance panel.
9. Docs: SECURITY.md, CLAUDE.md (scope change and the shipped section),
   retention and ROPA notes, DECISIONS-QUEUE entry.

## Running alongside Phase 10

- One local Supabase stack and port 3000 are shared (the Docker VM cap
  rules out a second stack). Heavy runs (reset, psql suite, integration,
  e2e) queue one at a time across both branches; check for other node,
  playwright and psql processes first.
- `invoicing` rebases onto `launch-hardening` after each Phase 10 task
  lands. New migrations take timestamps after the newest Phase 10
  migration at the time they are written; a rebase that would put one
  before a Phase 10 migration is renamed forward.
- Estimate 5 to 7 days; it slows Phase 10 by roughly a fifth to a third
  because of the shared stack.
