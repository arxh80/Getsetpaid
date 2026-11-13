# Invoices (part 3 of 3): network delivery, design

Date: 2026-11-13. Status: approved in brainstorming, awaiting spec review.
Branch: `invoicing-network`, off `main` (`89c4d4c`).

Parts 1 and 2: `2026-10-20-invoices-design.md`,
`2026-11-05-invoices-stripe-design.md`. Founder scope: Q276.

## What it does

A workspace that has issued an invoice to a CRM company can also deliver it
into that company's own GetSetPaid workspace, when the two organisations are
connected on the network. The receiving workspace gets a read-only inbox.

This crosses the private/network boundary (CLAUDE.md § The private/network
split), so the read path is one definer view with pinned columns, and the
leakage tests ship with the feature.

## Founder answers (2026-11-13), to be recorded as Q282

| Question | Answer |
|---|---|
| What can the receiver do? | Read-only inbox: view, download the PDF, follow the existing Pay by card link, see paid or void. Nothing is written into their CRM or finance. |
| How is the destination chosen? | By a button on the issued invoice, through the existing manual link between the recipient company and a network profile. No new picker. |
| Who sees the inbox? | Members with `view_finance` in the receiving workspace. No new permission key. |

Defaults chosen in the design and accepted with it:

1. The receiver reads the sender's snapshot; nothing is copied. If the
   sender's workspace is purged (60 days after closure, Q88), the delivery
   goes with it.
2. A delivery appears in the sender's data export only, not the receiver's.
3. No in-app badge or unread state. One email is the only notice.

## Data model

### `public.invoice_deliveries`

Two-tenant, like `network_connection_requests`: it is the second exemption
to schema invariant D10 and is declared by name there.

- `id` uuid PK
- `invoice_id`, `from_organisation_id`: composite FK to
  `invoices (id, organisation_id)`, `on delete cascade`
- `to_organisation_id`: FK to `organisations`, `on delete cascade`
- `delivered_by` (FK `auth.users`, `on delete set null`), `delivered_at`
- `withdrawn_at`, `withdrawn_by` (nullable)
- check `from_organisation_id <> to_organisation_id`
- partial unique index on `(invoice_id, to_organisation_id)` where
  `withdrawn_at is null`
- every FK indexed; RLS enabled in the creating migration

It stores no link id and no network profile id. Which private record the
sender linked is not the receiver's to learn (Q82), so it is not kept where
a receiver-facing view could ever join it.

Grants and policies:

- No INSERT, UPDATE or DELETE grant to any client role. Writes are the two
  RPCs below.
- SELECT policy: the sender's side only (`from_organisation_id` is the
  caller's and the caller has `view_finance`). The receiver never reads the
  base table.

Retention: classified in `private.retention_periods()` with the invoice it
belongs to (financial). Audit coverage: declared for
`private.audit_coverage()`.

### `public.received_invoices` (definer view)

The only receiver read path. One row per live (not withdrawn) delivery
whose `to_organisation_id` is an organisation where the caller holds
`view_finance`, through one `private` predicate function in the WHERE
clause, as `network_directory` does. Its dependencies are pinned from
`pg_depend`.

Columns, and nothing else:

- `delivery_id`, `to_organisation_id`, `delivered_at`
- `invoice_id` (needed to build the pay link; it is already printed on the
  PDF and email as part of `/pay/<id>.<sig>`)
- `number`, `status`, `issue_date`, `due_date`, `currency`,
  `net_minor`, `vat_minor`, `gross_minor`, `paid_at`
- `snapshot` (the seller block, recipient block, lines and totals frozen
  at issue; exactly what the PDF prints)
- `card_payment_enabled` (boolean; whether the Pay by card link is live)

Never exposed: `event_id`, `notes` outside the snapshot,
`recipient_company_id`, `recipient_contact_id`, `paid_entry_id`,
`void_reason`, `created_by` and the other actor columns, `invoice_sends`,
`invoice_lines.financial_entry_id`, any Stripe table.

A void invoice stays in the view with `status = 'void'`. A draft cannot be
delivered, so it cannot appear.

## Sender side

### `public.deliver_invoice(p_invoice_id uuid, p_network_profile_id uuid)`

Security definer, `search_path` pinned. It refuses with one generic error
unless all of these hold, checked in the database:

1. The caller has `manage_finance` in the invoice's organisation.
2. That organisation's effective plan is Pro
   (`private.effective_organisation_plan()`), and it is not read-only
   (`deleted_at is null`).
3. The invoice is `issued` or `paid`.
4. The invoice's recipient is a company (not a contact), and a live
   `network_links` row in the caller's organisation ties that company to
   `p_network_profile_id`.
5. The profile is live and belongs to another organisation that is not
   read-only.
6. An `accepted` `network_connection_requests` row exists between the two
   organisations, in either direction.

It inserts the delivery row and an audit event `invoice.delivered` (names
only: invoice id, receiving organisation id). A second call for the same
invoice and organisation is a no-op that returns the existing delivery.

Rate limit: a `rate_limit_policies` row, 30 per hour per user, enforced by
a `BEFORE INSERT` trigger on `invoice_deliveries`, as invoice email is.

### `public.withdraw_invoice_delivery(p_delivery_id uuid)`

For a wrong link. `manage_finance` on the sender's side, not read-only.
Stamps `withdrawn_at` and `withdrawn_by`, audits `invoice.delivery_withdrawn`.
No tier gate: a downgraded workspace must still be able to pull back
something it sent. After a withdrawal the invoice can be delivered again.

### UI (`/[orgSlug]/invoices/[invoiceId]`)

- A "Deliver in GetSetPaid" form, one button per eligible profile (usually
  one), shown only when rules 2 to 6 hold. The page computes eligibility
  with the sender's own rights; the RPC re-checks it.
- After delivery: "Delivered to <profile display name> on <date>" and a
  "Withdraw" button. Outcomes through `components/ui/action-outcome.tsx`.
- An invoice to a contact, or to an unlinked or unconnected company, shows
  nothing. No hint, no suggestion to link (linking stays manual-only).

## Receiver side

### Pages

- `/[orgSlug]/invoices/received`: a list through the shared list
  infrastructure (`lib/list/query.ts`, so reads are metered), keyset
  paginated on `(delivered_at, delivery_id)`. Columns: sender business
  name (from the snapshot), number, issue date, due date, gross, status.
  `tabular-nums` on every number. Empty state that says what will appear
  here and why.
- `/[orgSlug]/invoices/received/[deliveryId]`: `InvoiceView` rendered
  read-only from the snapshot, the PDF download, and the Pay by card link
  when `card_payment_enabled`.
- `/[orgSlug]/invoices/received/[deliveryId]/pdf`: the existing PDF
  renderer fed from the view's snapshot.

The pay link is built server-side with `lib/invoices/pay-url.ts` from
`invoice_id`. This is the same link the PDF already carries.

### Gates

- `view_finance` in the receiving organisation. Any tier: it is the
  receiver's own bill, and a downgrade never removes data.
- A refusal (wrong role, wrong organisation, withdrawn, unknown id) follows
  the streamed not-found contract. Never a 403.
- The existing `/[orgSlug]/invoices` page is Pro-gated for the sender's
  features. The received pages sit beside it and do not inherit that gate.
  Navigation shows "Received" to `view_finance` holders on every tier.
- Impersonation: the `read_only` role's keys decide; the pages are
  bannered and audited by route like every org-scoped page.

### Email

One notice, "New invoice from <sender business name>", to the receiving
organisation's `view_finance` members. It carries no amount, no number and
no line detail: only the sender name and a link to the inbox.

It reuses the audit-row notice loop in `lib/email/invoice-notifications.ts`
(`deliverAuditNotices`): a new resolver RPC keyed on the `invoice.delivered`
audit row, a new notice name for `mark_notices_delivered`, a template in
`lib/email/invoice-templates.ts`, sent on the existing delivery tick
through the one Brevo sender. No new sub-processor.

## Edge rules

- **Connection state after delivery.** There is no "disconnect" today (an
  accepted request has no exit), so the only way a connection ends is a
  workspace closing. A delivery stays readable while both workspaces
  exist, as an email would.
- **Sender suspended or closed.** The delivery stays readable until the
  purge. The Pay by card link behaves as it already does for that state.
- **Receiver suspended.** `view_finance` does not survive suspension, so
  the inbox is unavailable until the workspace is reopened. No change.
- **Link removed after delivery.** No effect; the delivery does not
  reference the link.
- **What delivery discloses.** The receiver learns that the sender invoiced
  them, which the invoice itself says. They learn nothing about the link,
  the CRM record, the event or the sender's finance.
- **Erasure.** `delivered_by` and `withdrawn_by` are set null with the
  user, like every other actor column.

## Out of scope

Booking a received invoice as a cost; acknowledging or querying an invoice;
delivery to a contact; delivery to an unconnected organisation; an unread
count; a copy that survives the sender's purge; the receiver's export.

## Testing

psql (`supabase/tests/`), a new suite through `run_suite()` with its
pinned total. Every refusal is paired with a positive control:

- A third organisation sees no row in `received_invoices`; the receiving
  organisation's finance role sees exactly one.
- A receiver member without `view_finance` sees none; the same fixture with
  `view_finance` sees one.
- The receiver cannot read `invoice_deliveries`, `invoices`,
  `invoice_lines` or `invoice_sends` for the sender's invoice.
- `deliver_invoice` refuses each of rules 1 to 6 on its own, and succeeds
  when all hold.
- A withdrawn delivery leaves the view; a void invoice stays with
  `status = 'void'`.
- The view's column list and its `pg_depend` dependencies are pinned, so a
  new column or a joined private table is a red test.
- No client role holds a write grant on `invoice_deliveries`.
- The rate limit refuses the 31st delivery in an hour.

Integration: `phase7-permission-matrix.test.ts` declares the two RPCs, the
resolver, the table and the view. The notice loop gets a test beside the
existing invoice notices.

e2e: a new sibling spec `invoices-network.spec.ts` (the golden path is
extended, not rewritten): connect two workspaces, link the company, issue,
deliver, sign in as the receiver's Finance user, open the inbox, download
the PDF, then withdraw and see not-found. Axe scans on both new pages, a
keyboard-only pass over the deliver and withdraw forms, and the refusal
parity matrix gains the two received routes.

Docs in the same PR: `docs/as-built.md` ("Invoices part 3, as it actually
shipped"), CLAUDE.md § Current state and § Scope discipline (one sentence
each), `SECURITY.md` for the new cross-tenant read path, and Q282 in the
decisions queue.
