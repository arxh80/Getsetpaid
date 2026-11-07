# Invoices (part 2 of 3): Stripe Connect design

Date: 2026-11-05. Status: approved section by section in brainstorming.
Branch: `invoicing-stripe`, off `main` at 2e2817b (part 1 merged as #41).

Part 1 (`2026-10-20-invoices-design.md`) built draft, issue, PDF, send,
mark paid and void, bank transfer only. Part 2 lets a workspace take card
payment for an issued invoice through its own Stripe account. The founder
answers in part 1's table still bind (Standard accounts, a percentage
application fee, Pro only, our own invoices with Stripe only taking the
payment, invoicing works without Stripe).

## Founder answers (2026-11-05)

| Question | Answer |
|---|---|
| Stripe account today | None yet. Build and test against a fake Stripe; the founder runs the real test-mode flow before launch |
| Application fee | 1% (100 basis points), held in one platform row, changed by SQL |
| Refund made in Stripe | Flag it on the invoice; the invoice stays paid; the workspace voids by hand if it wants |
| Payment methods | Card, with Apple Pay and Google Pay (Checkout adds the wallets). No Bacs or pay-by-bank, so no pending state |
| Pay link | Our own permanent link that mints a fresh Checkout Session per click (not Stripe Payment Links, not an emailed 24-hour session) |

## 1. Linking a Stripe account

- A "Card payments" block on `/[orgSlug]/settings/invoicing`, for
  `manage_finance` (Owner, Admin, Finance), Pro only.
- **Link** runs Stripe Connect OAuth for Standard accounts
  (`connect.stripe.com/oauth/authorize`, `scope=read_write`). Starting it
  needs step-up re-auth (purpose `invoice_settings`: it changes where money
  is paid). A random `state` is bound to the user's session (an httpOnly,
  short-lived cookie) and compared on return; a mismatch or a missing
  cookie refuses and stores nothing. The callback
  (one fixed path, `/api/stripe/connect/callback`, behind sign-in) claims
  the state, exchanges the code and keeps only `stripe_user_id`. The path
  is fixed because Stripe matches `redirect_uri` exactly against a
  registered list, so the workspace cannot be in it: the state row, bound
  to the user and claimed once before the code is exchanged (Stripe
  revokes a connection whose code is used twice), says which workspace.
- **Stored:** `public.invoice_stripe_accounts`, one row per organisation:
  `organisation_id` (PK, FK), `stripe_account_id` (text, `^acct_[A-Za-z0-9]+$`,
  unique among live rows), `charges_enabled` (boolean, refreshed from the
  account at link time and by `account.updated`), `linked_by`, `linked_at`,
  `ended_at`, `ended_reason` (`disconnected` | `deauthorized`). No OAuth
  access or refresh token is kept: direct charges use the platform secret
  key with the `Stripe-Account` header. RLS: `view_finance` reads its own
  organisation's row; no client write grant; writes only through
  SECURITY DEFINER RPCs (`link_stripe_account`, `end_stripe_account_link`)
  that re-check membership, `manage_finance` and the Pro entitlement, and a
  service-role-only one for the webhook's deauthorisation.
- **Disconnect** (step-up again) calls Stripe's OAuth deauthorise, then
  ends the row. If Stripe's call fails, the row is still ended and the
  failure is shown, so the app never keeps charging on an account the user
  asked to disconnect.
- **Fraud guard:** link and disconnect each email every active Owner and
  Admin through the existing notification-delivery path (the same one the
  bank-detail change uses) and write an audit row with the column names
  only (`{changed: ["stripe_account"]}`), never the account ID.
- **Fee:** `public.stripe_platform_settings`, a one-row table
  (`application_fee_bps integer not null check (between 0 and 1000)`,
  seeded 100). No client grant; read by the pay-page RPC.

## 2. Paying an invoice

- **The link:** `/pay/<invoiceId>.<sig>`, where `sig` is base64url
  HMAC-SHA256 of `invoice-pay-link:v1:<invoiceId>` under
  `INVOICE_PAY_LINK_SECRET` (at least 32 bytes; startup refuses a shorter
  one). Compared in constant time. Nothing is stored; rotating the secret
  kills every link.
- **Where it appears:** a "Pay by card" line on the PDF and a button in the
  invoice email, only when the invoice is issued and the organisation has a
  live, `charges_enabled` Stripe link at render/send time. Bank details stay
  on the invoice beside it. The URL is absolute, built from
  `NEXT_PUBLIC_SITE_URL`.
- **A click** (GET `/pay/[token]`, a server route): verify the signature,
  then one service-role-only RPC `public.begin_invoice_card_payment(invoice_id)`
  that, in one transaction, refuses unless the invoice is issued, the
  organisation is on Pro (`private.finance_module_organisations()`), the
  Stripe link is live and `charges_enabled`, and fewer than 20 sessions were
  begun for this invoice in the last hour; it records a row in
  `public.invoice_pay_sessions` (`invoice_id`, `organisation_id`,
  `created_at`, `stripe_session_id` filled after creation) and returns the
  gross, currency, number, seller name and account ID. Then a Checkout
  Session on the connected account: `mode=payment`, one line item of the
  gross named "Invoice <number>", `payment_method_types=["card"]`,
  `payment_intent_data.application_fee_amount = round_half_up(gross × bps / 10000)`,
  `metadata.invoice_id` on both the session and the payment intent,
  success URL `/pay/<token>/thanks`, cancel URL `/pay/<token>`. 303 to it.
- **Every refusal renders one page:** "This invoice can't be paid online.
  Contact <seller name>." for a known invoice, and the same words with no
  name for a bad signature or unknown ID. Same status (200) and shape
  either way; the page carries no number, amount or recipient. A Stripe API
  error renders "Card payment is unavailable right now. Try again later."
- **Thanks page** says "Payment received, thank you." It changes nothing:
  only the signed webhook marks an invoice paid.
- **The 20-per-hour limit is counted in `invoice_pay_sessions`,** not
  `consume_rate_limit()`, because that function binds to a signed-in member
  and the payer is anonymous. Per-IP limiting is not reliable here (G10).
- `/pay` joins `PUBLIC_PATHS` in `lib/supabase/middleware.ts`, pinned by
  `tests/unit/security/public-paths.test.ts`. The page is `noindex` and
  sends `Referrer-Policy: no-referrer` so the token does not leak to Stripe
  or anywhere else in a Referer header.

## 3. Webhooks

- `POST /api/stripe/webhook`, a Connect endpoint. The raw body is checked
  with `stripe.webhooks.constructEvent` and `STRIPE_WEBHOOK_SECRET`; a bad
  or missing signature is 400 with no write. Unhandled event types are
  acknowledged (200) and ignored.
- **Idempotent:** `public.stripe_events` (`id` text PK = Stripe event ID,
  `type`, `account`, `received_at`, `processed_at`). The insert and the
  effect run in one service-role-only RPC per event type; a duplicate ID is
  a no-op that returns 200.
- **`checkout.session.completed`** with `payment_status = paid` →
  `public.record_invoice_card_payment(event_id, invoice_id, account, payment_intent, amount_minor, currency)`:
  - the account must equal the invoice organisation's live linked account,
    and amount and currency must equal the invoice's gross and currency;
    otherwise nothing changes and an `incident_alerts` row is raised
    (it is a bug or an attack, not a customer state);
  - issued → the part 1 mark-paid finance logic, moved into one private
    helper both RPCs call, so card and manual payment book income the same
    way (net of VAT on the event); `paid_on` is the payment date in
    Europe/London; new columns `paid_via` (`manual` | `card`) and
    `stripe_payment_intent_id`; `paid_by` stays null for a card payment;
  - already paid or void → no finance change; set
    `card_payment_conflict_minor` and `card_payment_conflict_at` so the
    invoice page shows "A card payment of £X arrived after this invoice was
    paid/voided. Refund it in Stripe."
- **`charge.refunded`** for a payment intent we recorded → set
  `stripe_refunded_minor` (cumulative, from the charge) and
  `stripe_refunded_at`; the invoice page shows "Refunded in Stripe: £X on
  <date>". Status and finance are unchanged.
- **`account.application.deauthorized`** → end the link with reason
  `deauthorized`. **`account.updated`** → refresh `charges_enabled`.
- **The freeze trigger** (`private.invoices_freeze()`) admits the new
  columns only through these RPCs, as it does for the paid/void columns
  today.
- **Audit** (name-only payloads): `invoice.paid_by_card`,
  `invoice.card_refund_flagged`, `invoice.card_payment_conflict`,
  `invoice_stripe_account.linked` / `.ended`. No card data reaches us.

## 4. Security, legal, dependency, tests

- **Secrets** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_CONNECT_CLIENT_ID`, `INVOICE_PAY_LINK_SECRET` are read only in
  `lib/stripe/`; a census test pins the readers (as
  `service-key-readers.test.ts` does). `.env.example` gets placeholders.
  Missing keys: the "Card payments" block says card payments are not
  configured and no link appears; the webhook returns 503.
- **Service role** is used by the pay route and the webhook only, each
  through its own narrow RPC; the `lib/supabase/service.ts` importer census
  is updated with the two files and their reasons.
- **PCI:** Stripe-hosted Checkout; we never see card data.
- **Permission matrix and definer register:** the new RPCs and tables are
  declared in `phase7-permission-matrix.test.ts` (service-role-only vs
  browser-executable), and both tables are classified in
  `private.retention_periods()` / `audit_coverage()`.
- **Sub-processor:** Stripe added to `docs/sub-processors.md` and
  `lib/legal/sub-processors.ts` in the same change (payer email, invoice
  number and amount go to Stripe; Stripe Payments Europe, Ireland). Founder
  action: accept Stripe's DPA.
- **Dependency:** the official `stripe` package (MIT). All calls go through
  `lib/stripe/client.ts`, an interface with the real implementation and a
  fake used by unit, integration and e2e tests.
- **Tests:**
  - Unit: signature round-trip, tamper, wrong secret, short secret; every
    refusal renders the same page; fee rounding table; OAuth `state`
    mismatch refuses.
  - Integration: webhook with `stripe.webhooks.generateTestHeaderString`:
    paid → issued becomes paid by card with income on the event; wrong
    account / wrong amount / duplicate event / bad signature change
    nothing; payment after paid and after void sets the conflict; refund
    flag; deauthorisation ends the link; 21st session in an hour refused.
  - psql: RLS on `invoice_stripe_accounts`, `invoice_pay_sessions`,
    `stripe_events`, `stripe_platform_settings` (a foreign member reads
    nothing; no client writes); the freeze trigger on the new columns.
  - e2e, a seventh golden-path sibling `invoices-card.spec.ts`: link a fake
    account, issue, open the pay link (redirects to the fake Checkout URL),
    post a signed completed event, see "Paid by card" and the income on the
    event.
- **Before launch (founder):** create the Stripe platform account with
  Connect on; put the four secrets in the hosted environment; register the
  webhook URL for Connect events; run one real test-mode payment end to
  end; accept Stripe's DPA.

## Out of scope

Bacs, pay-by-bank and any pending state; partial payments; Stripe-side
invoices or customers; automatic void on refund; expiring open Checkout
Sessions on void (the conflict notice covers it); a superuser screen for
the fee; Express or Custom accounts.
