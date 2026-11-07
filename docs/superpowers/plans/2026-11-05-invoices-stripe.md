# Invoices (part 2 of 3): Stripe Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Pro workspace links its existing Stripe account (Standard, OAuth), and every issued invoice carries a permanent "Pay by card" link that opens a Stripe Checkout page for the exact amount on that account, with a 1% GetSetPaid application fee; Stripe's signed webhook marks the invoice paid and books the income exactly as a manual "mark paid" does.

**Architecture:** All Stripe calls go through one seam, `lib/stripe/client.ts` (`getStripe()` returns the real SDK client, a deterministic fake for development and tests, or `null` when unconfigured). The pay link is `/pay/<invoiceId>.<HMAC>`, verified without storage. Five new tables (four tenant, one platform) take no client writes; every write is a `SECURITY DEFINER` RPC. The signed-in paths (link, disconnect) re-check `manage_finance`, Pro and step-up in the database. The two sessionless paths (pay page, webhook) call `service_role`-only RPCs through `lib/supabase/service.ts`. Card payment reuses part 1's mark-paid finance logic, moved into one private helper.

**Tech Stack:** Next.js 16 App Router (Server Actions, route handlers), React 19, Supabase Postgres (RLS, definer RPCs, triggers), `stripe` (new, official, MIT, pinned exact), Vitest 4, Playwright, psql suites under `supabase/tests/`.

**Spec:** `docs/superpowers/specs/2026-11-05-invoices-stripe-design.md` (founder-approved 2026-11-05; the source of truth).
**Ledger:** `.superpowers/sdd/2026-11-05-invoices-stripe/progress.md` (add with `git add -f`).

## Global Constraints

- Branch `invoicing-stripe`, worktree `.claude/worktrees/invoicing-stripe`, off `main` (2e2817b). The PR targets `main`. Merging to `main` needs the founder's explicit approval.
- New migrations take timestamps after the newest on `main`, `20261109001000_invoice_settings_step_up.sql`: this plan uses `20261110000000` … `20261110003000`. If `main` gains a later migration before merge, rename ours forward.
- **Never** run `pnpm build` or `pnpm start`; never point anything at the hosted project; never read the main checkout's `.env.local`.
- The local Supabase stack and port 3000 are shared across worktrees. Before any `db reset`, psql suite, integration run or e2e run, check for other sessions' `node`/`playwright`/`psql` processes (`tasklist | grep -i -E "node|playwright"`). If another session is running a heavy job, wait. One heavy job at a time. psql: `docker exec supabase_db_getsetpaid psql -U postgres ...`.
- Never start ClamAV or any extra container locally (the Docker VM is capped at 2 GB). That includes `stripe-mock`: the fake lives in TypeScript.
- e2e in groups: `npx playwright test <files> --workers=1`, each group under 10 minutes, with the dev server started separately in the background and `PLAYWRIGHT_REUSE_SERVER=1`. A worker death, `Target crashed` or `ERR_CONNECTION_REFUSED` is the machine; re-run that group. **Never** add retries to fix a flake.
- The five gates before a task is done: `pnpm lint` (locally use `npx eslint app lib components tests scripts`, since `pnpm lint` walks `.claude/worktrees`), `pnpm typecheck` (after adding a route, `npx next typegen` first), `pnpm test`, the psql suite (`npx supabase db reset --local` then `bash supabase/tests/run-rls-tests.sh`), and the e2e groups the change can reach (Task 9 runs all of them).
- **psql pin:** every assertion in the new `supabase/tests/rls_invoices_stripe.sql` is one line beginning `select ist.val(`. Its `run_suite` pin is `grep -c '^select ist.val(' supabase/tests/rls_invoices_stripe.sql`, moved in the same commit as the assertions. A new assertion in any other suite moves that suite's pin.
- TDD for every control: write the failing test, watch it fail for the stated reason, implement, watch it pass, then a **mutant** that reverts the control and turns the test red. Record each mutant in the task's ledger line.
- Migrations are additive: never edit an applied one. Rebuild an existing function from its live `pg_get_functiondef`, diffed against its latest migration first, adding only the stated lines.
- Every `SECURITY DEFINER` function sets `search_path = ''`, schema-qualifies everything, and ends with `revoke all on function … from public, anon, authenticated, service_role;` followed by exactly the grants the task names.
- Audit payloads are **name-only** (CLAUDE.md § Non-negotiable rules): no Stripe account ID, payment-intent ID, amount or email in `before`/`after`. Use counts, statuses and column names. Sessionless audit rows are inserted directly with `actor_user_id = private.erased_user_id()`, as the retention runner does (`20261003004000_retention_runner.sql:383`), because `private.log_audit_event()` requires `auth.uid()`.
- UI: `DESIGN.md` tokens only, square corners, no shadows or gradients, `tabular-nums` on numbers, money only through `formatGbp` (`lib/format/money.ts`), dates through `formatDateOnly`/`formatDate`. Every new page has a `loading.tsx`. Outcomes use `components/ui/action-outcome.tsx`.
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `INVOICE_PAY_LINK_SECRET`, and `STRIPE_MODE` are read **only** in `lib/stripe/env.ts`. Never commit a real key. `.env.example` carries obviously fake placeholder values.
- Commit and push after every change, one logical change per commit (`git pull --rebase` before `git push`). Every commit message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Founder answers of 2026-11-05 are recorded as **Q279** in `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md` (Task 9). New founder questions take Q280 onwards, each with an implemented default.
- Never use bare `git stash`.

## Decisions this plan takes where the spec is silent or meets the codebase

Each is recorded in the task that implements it and reported at the end.

1. **Card-payment state lives in its own table, `invoice_card_payments`, not in columns on `invoices`.** The spec put the conflict and refund fields on `invoices`, which would mean widening `private.invoices_freeze()` for four more columns. One row per Stripe payment carries the payment-intent ID, the amount, the outcome (`applied` | `after_paid` | `after_void`), and the refunded amount and time. `invoices` gains a single column, `paid_via`. The behaviour the spec describes is unchanged.
2. **`invoices.paid_via` (`manual` | `card`) and a rebuilt `invoices_paid_shape`.** Part 1's check requires `paid_by` whenever `paid_on` is set, but a card payment has no person. The new shape: `paid_on` set ⇔ `paid_via` set; `manual` ⇒ `paid_by` set; `card` ⇒ `paid_by` null. Existing paid and void-after-paid rows are backfilled to `manual` inside the migration, with the freeze trigger disabled for that one statement.
3. **The OAuth `state` is a database row bound to the user, not a cookie.** `begin_stripe_link(org)` spends the step-up token, stores the SHA-256 of a random state with the user, the organisation and a 10-minute expiry in `private.stripe_link_states`, and returns the state. `claim_stripe_link_state(state)` accepts it only for the same `auth.uid()`, once, before expiry, and says which workspace; it runs before the code is exchanged, and `complete_stripe_link(state, …)` accepts only a claimed state. A forged callback cannot carry a state minted for the victim's session, so this blocks login-CSRF account substitution without a cookie, and it outlives the step-up token's short life across the round trip to Stripe.
4. **The pay link opens a page, and a button creates the Checkout Session (POST).** The spec had the GET itself redirect to Stripe. Mail scanners (Outlook Safe Links, Gmail's link checker) GET every link in an email, and each GET would create a Checkout Session and spend the 20-per-hour budget. The GET page shows "Invoice <number> from <seller>: <amount>" and a "Pay by card" button. Its POST runs the spec's checks, creates the session and redirects with 303. Every refusal still renders the one uniform page, and the GET has no side effect.
5. **`stripe_events` carries `organisation_id` (not null, FK, cascade).** An event for an account no workspace has linked is acknowledged (200) and not recorded. So the idempotency ledger is tenant-attributable, is classified `cascades`, and goes with the workspace.
6. **The development and test fake is chosen by `STRIPE_MODE=fake`, which production refuses.** This follows the malware scanner's rule (`lib/security/malware-scan.ts:188`). With `NODE_ENV=production`, `STRIPE_MODE=fake` makes `getStripe()` return `null` (card payments unconfigured), never the fake. `scripts/dev-env.mjs` writes `STRIPE_MODE=fake` and the fake secrets from `.env.example` into `.env.development.local`.
7. **A mismatched webhook (wrong account, amount or currency) raises a new incident-alert type, `stripe_payment_mismatch`.** The `incident_alerts_alert_type_known` constraint and every mirror of it (`lib/admin/health.ts` `INCIDENT_ALERT_TYPE_LABELS` and the suites that bind them) widen together.
8. **The link and disconnect emails reuse the bank-change notice machinery** with a sibling notice, `invoice_stripe_account_changed`: an audit row, the `private.notification_deliveries` ledger, a `service_role` resolver, and the delivery tick (`app/api/incident-alerts/deliver/route.ts`).

## File Structure

**Migrations** (`supabase/migrations/`)
- `20261110000000_stripe_tables.sql`: `invoice_stripe_accounts`, `stripe_platform_settings`, `invoice_pay_sessions`, `invoice_card_payments`, `stripe_events`, `private.stripe_link_states`; `invoices.paid_via` with the rebuilt shape check, freeze and `mark_invoice_paid`; `private.book_invoice_payment`; the catalogues (audit actions, retention roll, export, alert type). (Task 2)
- `20261110001000_stripe_link_rpcs.sql`: `begin_stripe_link`, `complete_stripe_link`, `end_stripe_account_link`, `stripe_account_deauthorized`, `stripe_account_updated`, the `invoice_stripe_account_changed` notice and `pending_invoice_stripe_account_notifications`. (Task 3)
- `20261110002000_stripe_card_payment_rpcs.sql`: `begin_invoice_card_payment`, `record_stripe_checkout_completed`, `record_stripe_charge_refunded`, `invoice_pay_page`. (Task 4)

**psql:** `supabase/tests/rls_invoices_stripe.sql` (new, schema `ist`). Also modified: `run-rls-tests.sh`, `rls_phase2_crm.sql` (L6 if `updated_at` tables are added), `network_leakage_phase6.sql` (IN10 list), `rls_phase8_closure_backup.sql` (seed + KS1), `rls_invoices.sql` (§ IP/§ IV: paid_via, the reshaped check).

**Stripe seam** (`lib/stripe/`)
- `env.ts`: the only reader of the five variables.
- `client.ts`: the `StripeGateway` interface, `getStripe()`, the real implementation.
- `fake.ts`: `FakeStripeGateway`, deterministic.
- `pay-link.ts`: `payLinkToken(invoiceId)`, `verifyPayLinkToken(token)`, `payLinkUrl(invoiceId)` (pure apart from env).
- `fee.ts`: `applicationFeeMinor(grossMinor, bps)` (pure).

**Server** (`lib/invoices/`)
- `stripe-actions.ts` (`"use server"`): `startStripeLinkAction`, `disconnectStripeAction`.
- `stripe-account.ts`: `loadStripeAccount(orgId)`, used by the settings page, the PDF route and the send action (RLS client).
- `pay.ts`: `loadPayPage(token)` and `startCardPayment(token)` (service client).
- `stripe-webhook.ts`: `handleStripeEvent(event)` (service client).
- `refusals.ts` (modified): the new hints.

**Email:** `lib/email/invoice-templates.ts` (pay line, Stripe-account notice), `lib/email/invoice-notifications.ts` (`deliverInvoiceStripeAccountNotifications`), `app/api/incident-alerts/deliver/route.ts`.

**Routes**
- `app/api/stripe/connect/callback/route.ts` (GET)
- `app/pay/[token]/page.tsx`, `app/pay/[token]/loading.tsx`, `app/pay/[token]/start/route.ts` (POST), `app/pay/[token]/thanks/page.tsx`
- `app/api/stripe/webhook/route.ts` (POST)

**Components:** `components/invoices/stripe-connection-panel.tsx`, `components/invoices/card-payment-notices.tsx`, `components/invoices/pay-page.tsx`. Modified: `invoice-view.tsx`, `lib/invoices/pdf/invoice-document.tsx`, `lib/invoices/pdf/render.tsx`.

**Tests**
- Unit: `tests/unit/stripe/pay-link.test.ts`, `fee.test.ts`, `env.test.ts`, `fake.test.ts`, `stripe-env-readers.test.ts`, `webhook-route.test.ts`; modified: `public-paths.test.ts`, `service-client-census.test.ts`, `invoice-templates.test.ts`, `pdf-render.test.ts`, `send-action.test.ts`.
- Integration: `tests/integration/invoices/stripe-webhook.test.ts`, `stripe-pay.test.ts`; modified: `phase7-permission-matrix.test.ts`, `completeness-census.test.ts`, the definer register.
- e2e: `tests/e2e/invoices-card.spec.ts` (new), `support/fixtures.ts`, `support/axe-routes.ts`.

**Docs:** `docs/sub-processors.md`, `lib/legal/sub-processors.ts`, `.env.example`, `SECURITY.md` (local, gitignored), `CLAUDE.md`, `docs/as-built.md`, `docs/launch-gates.md` (founder actions), the decisions queue.

---

### Task 1: The Stripe seam: env, gateway, fake, pay-link token, fee

**Files:**
- Create: `lib/stripe/env.ts`, `lib/stripe/client.ts`, `lib/stripe/fake.ts`, `lib/stripe/pay-link.ts`, `lib/stripe/fee.ts`
- Create: `tests/unit/stripe/pay-link.test.ts`, `tests/unit/stripe/fee.test.ts`, `tests/unit/stripe/env.test.ts`, `tests/unit/stripe/fake.test.ts`, `tests/unit/security/stripe-env-readers.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (`stripe`, exact), `.env.example`, `scripts/dev-env.mjs`

**Interfaces:**
- Produces:
  ```ts
  // lib/stripe/env.ts
  export interface StripeEnv { mode: "live" | "fake"; secretKey: string; webhookSecret: string; connectClientId: string }
  export function stripeEnv(): StripeEnv | null;        // null = card payments not configured
  export function payLinkSecret(): Buffer | null;       // null unless >= 32 bytes
  // lib/stripe/client.ts
  export interface CheckoutInput { account: string; invoiceId: string; number: string; grossMinor: number; feeMinor: number; successUrl: string; cancelUrl: string }
  export interface StripeGateway {
    authorizeUrl(state: string, redirectUri: string): string;
    exchangeCode(code: string): Promise<{ account: string }>;
    chargesEnabled(account: string): Promise<boolean>;
    deauthorize(account: string): Promise<void>;
    createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
    constructEvent(rawBody: string, signature: string): StripeEvent;   // throws on a bad signature
  }
  export type StripeEvent = import("stripe").Stripe.Event;
  export function getStripe(): StripeGateway | null;
  // lib/stripe/pay-link.ts
  export function payLinkToken(invoiceId: string): string | null;     // "<uuid>.<base64url sig>"
  export function verifyPayLinkToken(token: string): string | null;   // the invoice id, or null
  export function payLinkUrl(invoiceId: string): string | null;       // absolute, from siteUrl()
  // lib/stripe/fee.ts
  export function applicationFeeMinor(grossMinor: number, bps: number): number;
  ```

- [ ] **Step 1: Add the dependency.** Run `pnpm view stripe time --json` and choose the newest version published at least 14 days ago. Then run `pnpm add stripe@<that version> --save-exact`. Check that `node scripts/check-licenses.mjs < <(pnpm licenses list --prod --json)` still passes (stripe is MIT). Record the version in the ledger.

- [ ] **Step 2: Write the failing pay-link tests.**

```ts
// tests/unit/stripe/pay-link.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { payLinkToken, payLinkUrl, verifyPayLinkToken } from "@/lib/stripe/pay-link";

const ID = "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a10";
const SECRET = "pay-link-test-secret-0123456789abcdef0123";

afterEach(() => vi.unstubAllEnvs());

describe("the pay-link token", () => {
  it("round-trips an invoice id", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    const token = payLinkToken(ID)!;
    expect(token.startsWith(`${ID}.`)).toBe(true);
    expect(verifyPayLinkToken(token)).toBe(ID);
  });
  it.each([
    ["a changed signature character", (t: string) => t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")],
    ["another invoice's id with this signature", (t: string) => t.replace(ID, "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a11")],
    ["no signature", (t: string) => t.split(".")[0]],
    ["an empty signature", (t: string) => `${t.split(".")[0]}.`],
    ["a non-uuid id", (t: string) => `x.${t.split(".")[1]}`],
    ["three parts", (t: string) => `${t}.x`],
  ])("refuses %s", (_label, mutate) => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    expect(verifyPayLinkToken(mutate(payLinkToken(ID)!))).toBeNull();
  });
  it("refuses a token made under another secret", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    const token = payLinkToken(ID)!;
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", `${SECRET}-rotated`);
    expect(verifyPayLinkToken(token)).toBeNull();
  });
  it("makes and accepts nothing with a missing or short secret", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", "short");
    expect(payLinkToken(ID)).toBeNull();
    expect(verifyPayLinkToken(`${ID}.abc`)).toBeNull();
  });
  it("builds an absolute URL on the site origin", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test/");
    expect(payLinkUrl(ID)).toBe(`https://app.example.test/pay/${payLinkToken(ID)}`);
  });
});
```

Run: `pnpm exec vitest run tests/unit/stripe/pay-link.test.ts`. Expected: FAIL, because `@/lib/stripe/pay-link` cannot be resolved.

- [ ] **Step 3: Implement `env.ts` and `pay-link.ts`.**

```ts
// lib/stripe/env.ts
import "server-only";
// THE ONLY READER OF THE STRIPE VARIABLES (tests/unit/security/stripe-env-readers.test.ts).
// STRIPE_MODE=fake selects lib/stripe/fake.ts for development and tests; under
// NODE_ENV=production it is refused (card payments read as unconfigured), the
// malware scanner's rule: a typo must never downgrade production to a stub.
export interface StripeEnv { mode: "live" | "fake"; secretKey: string; webhookSecret: string; connectClientId: string }

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

export function stripeEnv(): StripeEnv | null {
  const mode = value("STRIPE_MODE") === "fake" ? "fake" : "live";
  if (mode === "fake" && process.env.NODE_ENV === "production") return null;
  const secretKey = value("STRIPE_SECRET_KEY");
  const webhookSecret = value("STRIPE_WEBHOOK_SECRET");
  const connectClientId = value("STRIPE_CONNECT_CLIENT_ID");
  if (!secretKey || !webhookSecret || !connectClientId) return null;
  return { mode, secretKey, webhookSecret, connectClientId };
}

export function payLinkSecret(): Buffer | null {
  const raw = value("INVOICE_PAY_LINK_SECRET");
  return raw && Buffer.byteLength(raw) >= 32 ? Buffer.from(raw) : null;
}
```

```ts
// lib/stripe/pay-link.ts
import "server-only";
// /pay/<invoiceId>.<sig>: sig = base64url HMAC-SHA256("invoice-pay-link:v1:<id>").
// Nothing stored; rotating INVOICE_PAY_LINK_SECRET kills every link (spec § 2).
import { createHmac, timingSafeEqual } from "node:crypto";
import { siteUrl } from "@/lib/supabase/env";
import { payLinkSecret } from "@/lib/stripe/env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(secret: Buffer, invoiceId: string): Buffer {
  return createHmac("sha256", secret).update(`invoice-pay-link:v1:${invoiceId}`).digest();
}

export function payLinkToken(invoiceId: string): string | null {
  const secret = payLinkSecret();
  if (!secret || !UUID.test(invoiceId)) return null;
  return `${invoiceId}.${sign(secret, invoiceId).toString("base64url")}`;
}

export function verifyPayLinkToken(token: string): string | null {
  const secret = payLinkSecret();
  const parts = token.split(".");
  if (!secret || parts.length !== 2 || !UUID.test(parts[0]) || !parts[1]) return null;
  const presented = Buffer.from(parts[1], "base64url");
  const expected = sign(secret, parts[0]);
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? parts[0] : null;
}

export function payLinkUrl(invoiceId: string): string | null {
  const token = payLinkToken(invoiceId);
  return token ? `${siteUrl()}/pay/${token}` : null;
}
```

Run the test again. Expected: PASS. **Mutant:** in `verifyPayLinkToken` return `parts[0]` without the comparison, and the tamper cases go red.

- [ ] **Step 4: Fee, test first.**

```ts
// tests/unit/stripe/fee.test.ts
import { describe, expect, it } from "vitest";
import { applicationFeeMinor } from "@/lib/stripe/fee";

describe("applicationFeeMinor (round half up, minor units)", () => {
  it.each([
    [200000, 100, 2000],  // £2,000 at 1% = £20
    [12345, 100, 123],    // 123.45 -> 123
    [12350, 100, 124],    // 123.5 -> 124 (half up)
    [1, 100, 0],
    [50, 100, 1],         // 0.5 -> 1
    [99999, 0, 0],
    [100000, 1000, 10000],
  ])("%i at %i bps is %i", (gross, bps, fee) => expect(applicationFeeMinor(gross, bps)).toBe(fee));
  it.each([[-1, 100], [100, -1], [100, 1001], [1.5, 100]])("refuses gross %s / bps %s", (g, b) => {
    expect(() => applicationFeeMinor(g, b)).toThrow();
  });
});
```

```ts
// lib/stripe/fee.ts
/** GetSetPaid's application fee in minor units: round half up of gross × bps / 10 000. */
export function applicationFeeMinor(grossMinor: number, bps: number): number {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || !Number.isInteger(bps) || bps < 0 || bps > 1000) {
    throw new RangeError("applicationFeeMinor: gross must be a non-negative integer and bps 0..1000");
  }
  return Math.floor((grossMinor * bps + 5000) / 10000);
}
```

Run `pnpm exec vitest run tests/unit/stripe/fee.test.ts` and expect PASS. The SQL side uses the same formula in Task 4, and § SF of the psql suite carries the same seven rows.

- [ ] **Step 5: The gateway and its fake, test first.** Write `tests/unit/stripe/fake.test.ts` with these assertions:
  - `FakeStripeGateway.authorizeUrl(state, redirect)` returns `${redirect}?code=fake_code_<state first 8>&state=<state>`, so the e2e OAuth round trip never leaves the site.
  - `exchangeCode("fake_code_abcd1234")` resolves `{ account: "acct_fakeabcd1234" }`, and any other code rejects.
  - `chargesEnabled` resolves `true` unless the account ends in `_off`.
  - `createCheckoutSession` resolves `{ id: "cs_fake_<invoice id without dashes>", url: "https://checkout.stripe.test/c/pay/cs_fake_…" }`.
  - `constructEvent` verifies with the real `Stripe.webhooks.constructEvent`, so a header made by `Stripe.webhooks.generateTestHeaderString({ payload, secret })` passes and a wrong secret throws.

  Then the env test (`tests/unit/stripe/env.test.ts`):
  - `getStripe()` is `null` with any of the three keys missing.
  - It is `null` with `STRIPE_MODE=fake` and `NODE_ENV=production`.
  - It is a `FakeStripeGateway` with `STRIPE_MODE=fake` in test.
  - It is the real gateway with mode unset and keys present. Assert `instanceof`; no network call is made.

  Implement:

```ts
// lib/stripe/client.ts
import "server-only";
// THE ONE SEAM TO STRIPE. Every call the product makes is a method here, so
// the fake (lib/stripe/fake.ts) can stand in for all of them. Standard
// accounts, direct charges: we act on the workspace's account with the
// platform key plus the Stripe-Account header; no OAuth token is ever kept.
import Stripe from "stripe";
import { stripeEnv, type StripeEnv } from "@/lib/stripe/env";
import { FakeStripeGateway } from "@/lib/stripe/fake";

export type StripeEvent = Stripe.Event;
export interface CheckoutInput {
  account: string; invoiceId: string; number: string; grossMinor: number; feeMinor: number;
  successUrl: string; cancelUrl: string;
}
export interface StripeGateway {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string): Promise<{ account: string }>;
  chargesEnabled(account: string): Promise<boolean>;
  deauthorize(account: string): Promise<void>;
  createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
  constructEvent(rawBody: string, signature: string): StripeEvent;
}

class LiveStripeGateway implements StripeGateway {
  private readonly stripe: Stripe;
  constructor(private readonly env: StripeEnv) {
    this.stripe = new Stripe(env.secretKey, { maxNetworkRetries: 1, timeout: 15_000 });
  }
  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ response_type: "code", client_id: this.env.connectClientId, scope: "read_write", state, redirect_uri: redirectUri });
    return `https://connect.stripe.com/oauth/authorize?${q}`;
  }
  async exchangeCode(code: string) {
    const token = await this.stripe.oauth.token({ grant_type: "authorization_code", code });
    if (!token.stripe_user_id) throw new Error("stripe oauth: no stripe_user_id");
    return { account: token.stripe_user_id };
  }
  async chargesEnabled(account: string) {
    return (await this.stripe.accounts.retrieve(account)).charges_enabled === true;
  }
  async deauthorize(account: string) {
    await this.stripe.oauth.deauthorize({ client_id: this.env.connectClientId, stripe_user_id: account });
  }
  async createCheckoutSession(i: CheckoutInput) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: i.grossMinor, product_data: { name: `Invoice ${i.number}` } } }],
        payment_intent_data: { application_fee_amount: i.feeMinor, metadata: { invoice_id: i.invoiceId } },
        metadata: { invoice_id: i.invoiceId },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      },
      { stripeAccount: i.account },
    );
    if (!session.url) throw new Error("stripe checkout: no url");
    return { id: session.id, url: session.url };
  }
  constructEvent(rawBody: string, signature: string) {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.env.webhookSecret);
  }
}

export function getStripe(): StripeGateway | null {
  const env = stripeEnv();
  if (!env) return null;
  return env.mode === "fake" ? new FakeStripeGateway(env) : new LiveStripeGateway(env);
}
```

`lib/stripe/fake.ts` implements the same interface exactly as the fake test describes. Its `constructEvent` calls `Stripe.webhooks.constructEvent(rawBody, signature, env.webhookSecret)` on a `new Stripe("sk_test_fake")` instance, which makes no network call. It needs no `server-only`, so the e2e support code can import its URL shapes.

Run `pnpm exec vitest run tests/unit/stripe`. Expected: PASS.

- [ ] **Step 6: Env-reader census, test first.** Copy `tests/unit/security/service-key-readers.test.ts`'s detector and run it over each of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `INVOICE_PAY_LINK_SECRET` and `STRIPE_MODE`. Assert that the readers are exactly `["lib/stripe/env.ts"]`. It passes once Step 3 exists. **Mutant:** add `process.env.STRIPE_SECRET_KEY` to `lib/stripe/client.ts`, and the census goes red.

- [ ] **Step 7: Environment files.**
  - `.env.example` gets:
    ```
    # Card payments (Invoices part 2). Development uses the fake: STRIPE_MODE=fake.
    STRIPE_MODE=fake
    STRIPE_SECRET_KEY=sk_test_fake_not_a_real_key
    STRIPE_WEBHOOK_SECRET=whsec_fake_local_webhook_secret_0123456789
    STRIPE_CONNECT_CLIENT_ID=ca_fake_local_client
    INVOICE_PAY_LINK_SECRET=local-pay-link-secret-not-for-production-0123
    ```
  - `scripts/dev-env.mjs` copies those five lines from `.env.example` into `.env.development.local`. Do it the way it reads `GETSETPAID_SERVER_REQUEST_SECRET` today (line ~104), with one regex per name, and fail loudly if any is missing.
  - Check whether `tests/unit/scripts/` has a dev-env test (`grep -rl dev-env tests/unit`). If it does, extend it with the five names.

- [ ] **Step 8: Gates and commit.** Run `pnpm typecheck`, `npx eslint lib/stripe tests/unit/stripe tests/unit/security scripts`, and `pnpm exec vitest run tests/unit/stripe tests/unit/security`.

```bash
git add package.json pnpm-lock.yaml .env.example scripts/dev-env.mjs lib/stripe tests/unit/stripe tests/unit/security/stripe-env-readers.test.ts
git commit -m "Add the Stripe seam: env, gateway, fake, pay-link token and fee

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git pull --rebase && git push
```

---

### Task 2: The tables, `paid_via`, the shared booking helper, and every census they trip

**Files:**
- Create: `supabase/migrations/20261110000000_stripe_tables.sql`, `supabase/tests/rls_invoices_stripe.sql`
- Modify: `supabase/tests/run-rls-tests.sh`, `supabase/tests/rls_invoices.sql`, `supabase/tests/network_leakage_phase6.sql` (IN10), `supabase/tests/rls_phase8_closure_backup.sql`, `lib/admin/audit-actions.ts`, `lib/admin/health.ts`, `tests/integration/security/phase7-permission-matrix.test.ts`, `tests/integration/export/completeness-census.test.ts`, `tests/unit/invoices/refusals.test.ts` (if the hint table is pinned)

**Interfaces:**
- Produces (SQL):
  - `public.invoice_stripe_accounts(organisation_id uuid pk fk, stripe_account_id text, charges_enabled boolean, linked_by uuid, linked_at timestamptz, ended_at timestamptz, ended_reason text, created_at, updated_at)`
  - `public.stripe_platform_settings(id boolean pk default true check (id), application_fee_bps integer)`
  - `public.invoice_pay_sessions(id uuid pk, organisation_id, invoice_id, stripe_session_id text, created_at)`
  - `public.invoice_card_payments(id uuid pk, organisation_id, invoice_id, stripe_event_id text, stripe_payment_intent_id text unique, amount_minor bigint, currency text, outcome text, received_at, refunded_minor bigint default 0, refunded_at)`
  - `public.stripe_events(id text pk, organisation_id uuid not null fk cascade, type text, received_at)`
  - `private.stripe_link_states(state_hash bytea pk, organisation_id, user_id, expires_at, used_at)`
  - `invoices.paid_via text`
  - `private.book_invoice_payment(p_invoice_id uuid, p_paid_on date, p_actor uuid) returns table (flipped integer, entry_id uuid)`
  - audit actions `invoice.paid_by_card`, `invoice.card_payment_conflict`, `invoice.card_refund_flagged`, `invoice_stripe_account.linked`, `invoice_stripe_account.ended`
  - alert type `stripe_payment_mismatch`

- [ ] **Step 1: Write the psql suite's first sections (they fail: the tables do not exist).** Create `supabase/tests/rls_invoices_stripe.sql`. Copy `rls_invoices.sql`'s header, its `inv.val`/`inv.record` helpers renamed to `ist`, and its fixture block, which must be self-contained and re-runnable. The fixtures are:
  - org `org_a` (Pro), with users `fin_a` (Finance, aal2) and `ro_a` (Read Only);
  - org `org_b` (Pro), with user `fin_b`;
  - org `org_s` (Starter), with user `fin_s`;
  - an issued invoice `inv_ai` in A (gross 12000), an issued invoice `inv_bi` in B, and a paid invoice `inv_ap` in A.

  Sections, each assertion one line beginning `select ist.val(`:
  - **§ ST tables:** RLS is enabled on all five public tables. `authenticated` holds SELECT only on `invoice_stripe_accounts` and `invoice_card_payments`, and nothing on `invoice_pay_sessions`, `stripe_events` or `stripe_platform_settings`. `anon` holds nothing on any of them. `service_role` holds no table privilege on any of them (only RPCs). `private.stripe_link_states` is unreachable from `authenticated`.
  - **§ SR reads:** `fin_a` reads A's account row and card payments. `ro_a` reads them too (Read Only holds `view_finance`; check with `select public.has_permission(:'org_a','view_finance')` as `ro_a`, and if it is false, assert 0 rows instead). `fin_b` reads 0 of A's rows, the tenant breakout. `fin_s` (Starter) reads 0 rows. A positive control seeds B's own row and confirms `fin_b` reads 1.
  - **§ SB breakout:** as `fin_a`, an INSERT/UPDATE/DELETE on each table fails with 42501.
  - **§ SP paid shape:** as `postgres`:
    - an `issued→paid` update with `paid_via='card', paid_by=null` succeeds;
    - `paid_via='card'` with `paid_by` set fails with 23514;
    - `paid_via='manual'` with `paid_by` null fails;
    - `paid_on` set with `paid_via` null fails;
    - after paid, changing `paid_via` fails with `invoice_is_frozen`;
    - voiding keeps `paid_via` (changing it in the void update fails);
    - backfill: every pre-existing row with `paid_on` set has `paid_via='manual'`.
  - **§ SF fee table:** `select private.application_fee_minor(gross, bps)` for the seven rows of Task 1's fee test.
  - **§ SC catalogues:**
    - `private.unclassified_retention_subjects()` is empty;
    - the five new public tables appear in `private.retention_subjects()` with the classes from Step 3;
    - `private.audit_coverage()` (or whatever function names uncovered client-writable tables) does not name them, because none is client-writable;
    - the five audit actions exist in the audit catalogue table that `lib/admin/audit-actions.ts` binds to (find it with `grep -n "invoice.marked_paid" supabase/migrations/20261107000000_invoice_tables.sql`);
    - the alert type is in `incident_alerts_alert_type_known`.
  - **§ IZ housekeeping:** delete every fixture.

  Add a `run_suite "INVOICES STRIPE" rls_invoices_stripe.sql ist - "${P7VARS[@]}"` call (pass the variables the fixtures need, the way the `INVOICES` call at `run-rls-tests.sh:1386` does). With `-`, the runner prints the measured count, which becomes the pin in Step 6.

  Run: `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh`. Expected: the suite fails on § ST (`relation "public.invoice_stripe_accounts" does not exist`).

- [ ] **Step 2: Write the migration: tables, RLS, grants.**

```sql
-- ===========================================================================
-- INVOICES PART 2 -- TASK 2: THE STRIPE TABLES, paid_via, AND THE SHARED
-- BOOKING HELPER (spec docs/superpowers/specs/2026-11-05-invoices-stripe-design.md).
-- No client role writes any table here: the signed-in writes are Task 3's
-- RPCs, the sessionless ones (pay page, webhook) Task 4's service_role RPCs.
-- Plan decisions 1, 2, 3 and 5.
-- ===========================================================================

create table public.invoice_stripe_accounts (
  organisation_id   uuid primary key references public.organisations (id) on delete cascade,
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled   boolean not null default false,
  linked_by         uuid references auth.users (id),
  linked_at         timestamptz not null default pg_catalog.now(),
  ended_at          timestamptz,
  ended_reason      text check (ended_reason in ('disconnected', 'deauthorized')),
  created_at        timestamptz not null default pg_catalog.now(),
  updated_at        timestamptz not null default pg_catalog.now(),
  constraint invoice_stripe_accounts_end_pair check ((ended_at is null) = (ended_reason is null))
);
create unique index invoice_stripe_accounts_live_account_idx
  on public.invoice_stripe_accounts (stripe_account_id) where ended_at is null;
create index invoice_stripe_accounts_linked_by_idx on public.invoice_stripe_accounts (linked_by);
create trigger invoice_stripe_accounts_set_updated_at before update on public.invoice_stripe_accounts
  for each row execute function private.set_updated_at();
alter table public.invoice_stripe_accounts enable row level security;
create policy invoice_stripe_accounts_select on public.invoice_stripe_accounts for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_stripe_accounts from public, anon, authenticated, service_role;
grant select on public.invoice_stripe_accounts to authenticated;

create table public.stripe_platform_settings (
  id                  boolean primary key default true check (id),
  application_fee_bps integer not null check (application_fee_bps between 0 and 1000)
);
insert into public.stripe_platform_settings (application_fee_bps) values (100);  -- Q279: 1%
alter table public.stripe_platform_settings enable row level security;
revoke all on public.stripe_platform_settings from public, anon, authenticated, service_role;

create table public.invoice_pay_sessions (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null,
  invoice_id        uuid not null,
  stripe_session_id text check (stripe_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  created_at        timestamptz not null default pg_catalog.now(),
  foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade
);
create index invoice_pay_sessions_invoice_created_idx on public.invoice_pay_sessions (invoice_id, created_at);
create index invoice_pay_sessions_org_idx on public.invoice_pay_sessions (organisation_id);
alter table public.invoice_pay_sessions enable row level security;
revoke all on public.invoice_pay_sessions from public, anon, authenticated, service_role;

create table public.invoice_card_payments (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null,
  invoice_id               uuid not null,
  stripe_event_id          text not null,
  stripe_payment_intent_id text not null unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  amount_minor             bigint not null check (amount_minor > 0),
  currency                 text not null check (currency = 'GBP'),
  outcome                  text not null check (outcome in ('applied', 'after_paid', 'after_void')),
  received_at              timestamptz not null default pg_catalog.now(),
  refunded_minor           bigint not null default 0 check (refunded_minor >= 0 and refunded_minor <= amount_minor),
  refunded_at              timestamptz,
  constraint invoice_card_payments_refund_pair check ((refunded_minor = 0) = (refunded_at is null)),
  foreign key (invoice_id, organisation_id) references public.invoices (id, organisation_id) on delete cascade
);
create index invoice_card_payments_invoice_idx on public.invoice_card_payments (invoice_id);
create index invoice_card_payments_org_idx on public.invoice_card_payments (organisation_id);
alter table public.invoice_card_payments enable row level security;
create policy invoice_card_payments_select on public.invoice_card_payments for select to authenticated
  using (organisation_id in (select private.permitted_organisations('view_finance')));
revoke all on public.invoice_card_payments from public, anon, authenticated, service_role;
grant select on public.invoice_card_payments to authenticated;

create table public.stripe_events (
  id              text primary key check (id ~ '^evt_[A-Za-z0-9_]+$'),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  type            text not null,
  received_at     timestamptz not null default pg_catalog.now()
);
create index stripe_events_org_idx on public.stripe_events (organisation_id);
alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from public, anon, authenticated, service_role;

create table private.stripe_link_states (
  state_hash      bytea primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create index stripe_link_states_org_idx on private.stripe_link_states (organisation_id);
create index stripe_link_states_user_idx on private.stripe_link_states (user_id);
revoke all on private.stripe_link_states from public, anon, authenticated, service_role;

create or replace function private.application_fee_minor(p_gross bigint, p_bps integer)
returns bigint language sql immutable set search_path = '' as $$
  select (p_gross * p_bps + 5000) / 10000   -- integer division = floor for non-negatives; lib/stripe/fee.ts
$$;
revoke all on function private.application_fee_minor(bigint, integer) from public, anon, authenticated, service_role;
```

Check `private.permitted_organisations(text)` against `rls_invoices.sql`'s policies before using it, and copy the exact policy expression part 1 uses on `invoices`. The Pro gate on reads follows whatever part 1's `invoices` select policy does. If that policy also requires `private.finance_module_organisations()`, copy that term too, so § SR's Starter row reads 0.

- [ ] **Step 3: Same migration, `paid_via`, the helper, and the rebuilt functions.**
  1. `alter table public.invoices add column paid_via text check (paid_via in ('manual','card'));`
  2. `alter table public.invoices disable trigger <the freeze trigger's name>;` Find the name with `select tgname from pg_trigger where tgrelid='public.invoices'::regclass`. Then `update public.invoices set paid_via = 'manual' where paid_on is not null;` and re-enable the trigger. This happens in one migration transaction, so no client can see the window.
  3. Drop and re-add `invoices_paid_shape`:
     ```sql
     alter table public.invoices drop constraint invoices_paid_shape,
       add constraint invoices_paid_shape check (
         (paid_on is null) = (paid_via is null)
         and (paid_via is distinct from 'manual' or paid_by is not null)
         and (paid_via is distinct from 'card'   or paid_by is null)
         and (paid_via is not null or paid_by is null)
         and (status <> 'paid' or paid_on is not null)
         and (status in ('paid', 'void') or (paid_on is null and paid_entry_id is null)));
     ```
  4. Rebuild `private.invoices_freeze()` from its live definition, with only these changes:
     - add `'paid_via'` to `v_moving`;
     - add `new.paid_via` / `old.paid_via` to the same-status frozen tuple and to the void branch's kept tuple;
     - in the erasure re-point rule, `old.paid_by is not null` stays as it is (a card payment has no `paid_by`).
  5. Create `private.book_invoice_payment(p_invoice_id uuid, p_paid_on date, p_actor uuid) returns table (flipped integer, entry_id uuid)`. Its body is `mark_invoice_paid`'s finance block (`20261107003000_invoice_paid_and_void.sql` lines 59–104) moved verbatim:
     - from `if v_inv.event_id is not null` through the income insert;
     - with `created_by` = `p_actor`, which may be null for a card payment;
     - returning `cardinality(v_flipped)` and `v_entry`.

     It locks the invoice row itself (`for update`) and refuses with `invoice_not_issued` unless the invoice is issued. Revoke it from everyone, with no grants (private).
  6. Rebuild `public.mark_invoice_paid` from live, so its body after the date check is:
     ```sql
     select b.flipped, b.entry_id into v_count, v_entry from private.book_invoice_payment(p_invoice_id, p_paid_on, v_uid) b;
     update public.invoices i
        set status = 'paid', paid_on = p_paid_on, paid_by = v_uid, paid_via = 'manual', paid_entry_id = v_entry
      where i.id = p_invoice_id;
     ```
     The audit call keeps `entries_flipped => v_count`. Same signature, same grants.
  7. Widen `incident_alerts_alert_type_known` to add `'stripe_payment_mismatch'`, rebuilding the list from live, and update its comment. Add the label to `INCIDENT_ALERT_TYPE_LABELS` in `lib/admin/health.ts` ("Card payment did not match its invoice"). Then `grep -rn "upload_quarantined" lib tests/unit supabase/tests` and add the new type wherever every type is enumerated (the Telegram payload, the email templates, the label-binding psql assertion).
  8. Add the five audit actions to the audit-action catalogue the same way `20261107000000` added `invoice.issued`, and to `PLATFORM_AUDIT_ACTIONS` in `lib/admin/audit-actions.ts`.
  9. Rebuild `private.retention_subjects()` from its live definition (`20261109000000_retention_roll_carries_invoices.sql` is the latest) and add:
     - `('invoice_stripe_accounts','cascades',null,'FK to public.organisations, ON DELETE CASCADE: the workspace''s link to its Stripe account.')`
     - `('invoice_card_payments','cascades',null,'Composite FK to public.invoices, ON DELETE CASCADE: a card payment record lives as long as its invoice.')`
     - `('invoice_pay_sessions','cascades',null,'Composite FK to public.invoices, ON DELETE CASCADE: counts Checkout Sessions for the 20-per-hour limit.')`
     - `('stripe_events','cascades',null,'FK to public.organisations, ON DELETE CASCADE: the webhook idempotency ledger, ids only (plan decision 5).')`
     - `('stripe_platform_settings','platform_reference',null,'One row: the application fee in basis points (Q279).')` (check that `platform_reference` is the class `subscription_plans` uses; use whatever class that row carries).

- [ ] **Step 4: Run the suite.** Expected: § ST, § SR, § SB, § SP and § SF pass. Fix § SC by running the censuses, in this order, and declaring the new tables exactly as their failure messages ask:
  - `pnpm exec vitest run tests/integration/security/phase7-permission-matrix.test.ts`: add each table to the list part 1's tables are in. `PRE_PHASE7_RELATIONS` / `ORG_SCOPED_TABLES`: follow how `invoice_sends` is declared.
  - `pnpm exec vitest run tests/integration/export/completeness-census.test.ts`: export `invoice_stripe_accounts` and `invoice_card_payments` with the workspace (follow `invoice_sends`). Declare `invoice_pay_sessions` and `stripe_events` not exported, giving the reason "operational counter / idempotency ledger, ids only".
  - `network_leakage_phase6.sql` IN10: add the five table names to the three `relname in (...)` lists, and widen the regex to `public\.(invoice(s|_lines|_sends|_settings|_stripe_accounts|_card_payments|_pay_sessions)|stripe_events|stripe_platform_settings)`.
  - `rls_phase8_closure_backup.sql`: seed one row in each exported table in `ck.seed`, raise KS1's count by the number of exported tables, and add housekeeping deletes.
  - `rls_invoices.sql` § IP/§ IV: the existing assertions should pass unchanged. Add one assertion that a manual mark-paid writes `paid_via = 'manual'`, and move that suite's pin.

- [ ] **Step 5: Mutants.**
  - Drop `invoice_card_payments_select` and recreate it `using (true)`. § SR's breakout row goes red.
  - Remove `'paid_via'` from the freeze's frozen tuple. § SP's "changing paid_via after paid" goes red.

  Revert both.

- [ ] **Step 6: Pin, gates, commit.**
  - Set the pin to `grep -c '^select ist.val(' supabase/tests/rls_invoices_stripe.sql`.
  - Run a full reset and `bash supabase/tests/run-rls-tests.sh`, which must report "All suites passed".
  - Run `pnpm typecheck`, `pnpm exec vitest run tests/unit`, and `pnpm exec vitest run tests/integration`. The integration run needs the stack, so check for other sessions first.
  - Commit with the message "Add the Stripe tables, paid_via and the shared booking helper", plus the trailer, and push.

---

### Task 3: Linking and ending: the RPCs, the notice, the settings panel, the callback

**Files:**
- Create: `supabase/migrations/20261110001000_stripe_link_rpcs.sql`, `lib/invoices/stripe-actions.ts`, `lib/invoices/stripe-account.ts`, `components/invoices/stripe-connection-panel.tsx`, `app/api/stripe/connect/callback/route.ts`, `tests/unit/invoices/stripe-actions.test.ts`
- Modify: `supabase/tests/rls_invoices_stripe.sql` (§ SL), `lib/invoices/refusals.ts`, `app/(app)/[orgSlug]/settings/invoicing/page.tsx`, `lib/email/invoice-templates.ts`, `lib/email/invoice-notifications.ts`, `app/api/incident-alerts/deliver/route.ts`, `tests/unit/email/invoice-templates.test.ts`, `tests/unit/email/invoice-notifications.test.ts`, `tests/unit/email/delivery-route.test.ts`, `tests/unit/security/step-up-token-callers.test.ts` (only if it lists files), `tests/integration/security/phase7-permission-matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 `getStripe()`; Task 2 tables.
- Produces (SQL):
  - `public.begin_stripe_link(p_org uuid) returns text` (authenticated; spends step-up `invoice_settings`; returns the raw state, 43 base64url chars);
  - `public.complete_stripe_link(p_org uuid, p_state text, p_account text, p_charges_enabled boolean) returns void` (authenticated);
  - `public.end_stripe_account_link(p_org uuid) returns text` (authenticated; spends step-up; returns the ended account ID for the Stripe deauthorise call, or null if none was live);
  - `public.stripe_account_deauthorized(p_account text) returns boolean` and `public.stripe_account_updated(p_account text, p_charges_enabled boolean) returns boolean` (service_role only; true when a live link was found);
  - `public.pending_invoice_stripe_account_notifications(p_limit integer default 30)` (service_role only).
- Produces (TS):
  - `startStripeLinkAction(prev: FormState, formData: FormData): Promise<FormState>` (redirects on success);
  - `disconnectStripeAction(prev: FormState, formData: FormData): Promise<FormState>`;
  - `loadStripeAccount(orgId: string): Promise<{ live: boolean; chargesEnabled: boolean; linkedAt: string | null } | null>`. It never returns the account ID to the page, which has no use for it.

- [ ] **Step 1: psql § SL (fails: the RPCs do not exist).** Assertions:
  - **Begin:**
    - as `fin_a` (aal2, with a step-up token minted via the `step_up_fixture.sql` helper part 1's § IX uses), `begin_stripe_link(org_a)` returns a 43-character text and writes one `private.stripe_link_states` row with a 10-minute expiry;
    - without a token: 42501, hint `step_up_required` (use the hint `private.consume_step_up` raises);
    - as `ro_a`: 42501 `forbidden`;
    - as `fin_s` (Starter): `plan_does_not_include_invoicing`;
    - as `fin_b` for `org_a`: 42501 `forbidden`.
  - **Complete:**
    - with the state: a live row with `charges_enabled`, `linked_by = fin_a`, one `invoice_stripe_account.linked` audit row with `after = {"changed":["stripe_account"]}` (assert that the payload text does not contain `acct_`), and the state marked used;
    - the same state twice: `stripe_link_state_invalid`;
    - a state minted by `fin_a` completed by another A Finance user: `stripe_link_state_invalid`;
    - an expired state (as postgres, set `expires_at` in the past): `stripe_link_state_invalid`;
    - an account ID failing the regex: `stripe_account_invalid`;
    - the same `acct_` already live for org B: `stripe_account_in_use` (positive control: a fresh ID succeeds).
  - **Relinking:** linking again while live replaces the account (an UPDATE, not a second row) and audits `linked` again.
  - **End:**
    - `end_stripe_account_link(org_a)` with a token returns the account ID, sets `ended_at` and `ended_reason='disconnected'`, and audits `invoice_stripe_account.ended`;
    - again: returns null, with no second audit row.
  - **Service RPCs:**
    - as `authenticated`, `stripe_account_deauthorized(...)` is 42501;
    - as `service_role`, it ends a live link with `deauthorized` and returns true, and returns false for an unknown account;
    - `stripe_account_updated` flips `charges_enabled`;
    - each service write audits with `actor_user_id = private.erased_user_id()`.
  - **Notice:** after a link and an end, `pending_invoice_stripe_account_notifications()` as `service_role` returns two rows, each carrying the Owner and Admin emails of `org_a`, `organisation_slug`, `organisation_name`, `change` (`linked`|`ended`) and `changed_at`, and no account ID. As `authenticated` it is 42501.

- [ ] **Step 2: Write the migration.** Model every RPC on `public.save_invoice_settings` (`20261107004000`): the uid check, `has_permission(p_org,'manage_finance')`, the Pro check through `private.finance_module_organisations()`, and `perform private.consume_step_up('invoice_settings')` for `begin` and `end`. Then:

```sql
create or replace function public.begin_stripe_link(p_org uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_state text := pg_catalog.encode(extensions.gen_random_bytes(32), 'base64');
begin
  -- (uid / manage_finance / Pro checks exactly as save_invoice_settings)
  perform private.consume_step_up('invoice_settings');
  delete from private.stripe_link_states s where s.expires_at < pg_catalog.now();
  v_state := pg_catalog.translate(pg_catalog.rtrim(v_state, '='), '+/', '-_');   -- base64url
  insert into private.stripe_link_states (state_hash, organisation_id, user_id, expires_at)
  values (extensions.digest(v_state, 'sha256'), p_org, v_uid, pg_catalog.now() + interval '10 minutes');
  return v_state;
end $$;
```

Check that `extensions.gen_random_bytes` and `extensions.digest` exist (`\df extensions.digest`). If pgcrypto lives elsewhere, use the schema the other migrations use (`grep -rn "digest(" supabase/migrations | head -3`).

`complete_stripe_link` checks, in order:
1. uid;
2. `manage_finance`;
3. Pro;
4. the account regex (`stripe_account_invalid`, 22023);
5. the state: `update private.stripe_link_states set used_at = now() where state_hash = digest(p_state,'sha256') and organisation_id = p_org and user_id = v_uid and used_at is null and expires_at > now()`. Zero rows means `stripe_link_state_invalid` (42501).

Then it refuses a live row for another organisation with the same account (`stripe_account_in_use`, 22023). Then it upserts by `organisation_id`, setting `stripe_account_id`, `charges_enabled`, `linked_by`, `linked_at = now()`, `ended_at = null` and `ended_reason = null`. Finally `private.log_audit_event('invoice_stripe_account.linked','invoice_stripe_account', p_org, null, null, null, jsonb_build_object('changed', jsonb_build_array('stripe_account')))`.

`end_stripe_account_link` (step-up) sets `ended_at` and `ended_reason='disconnected'` on the live row, returns its account ID, and audits `ended`. The two service RPCs refuse unless `(select auth.role()) = 'service_role'`, mirroring `pending_invoice_bank_change_notifications`'s refusal. They audit by direct insert with the tombstone actor.

The notice: copy `20261107004000` lines 128–320, adding `'invoice_stripe_account_changed'` to `notification_deliveries_notice_check` and `notification_deliveries_one_subject`, and to the `closure_notice_action` / `mark_notices_*` branches. Rebuild each from live. The resolver returns rows for `invoice_stripe_account.linked`/`.ended` audit rows with no delivery yet. Grants: `begin`, `complete` and `end` to `authenticated`; the other three to `service_role`.

Declare all six in `phase7-permission-matrix.test.ts`, following `save_invoice_settings`'s entry (and the `SERVER_ONLY_RPCS` list for the service three), and add their refusal hints to `INVOICE_REFUSAL_SENTENCES`:
  - `stripe_link_state_invalid`: "That Stripe connection attempt expired or was already used. Start again from Invoice settings."
  - `stripe_account_invalid`: "Stripe returned an account we can’t use. Try connecting again."
  - `stripe_account_in_use`: "That Stripe account is already connected to another GetSetPaid workspace."

- [ ] **Step 3: The Server Actions, test first.** `tests/unit/invoices/stripe-actions.test.ts` mocks `@/lib/auth`, `@/lib/auth/step-up-gate`, `@/lib/supabase/server` and `@/lib/stripe/client`, the way `tests/unit/invoices/send-action.test.ts` mocks its seams. Cases:
  - no org: `FAILED_MESSAGE`;
  - no write access: the explanation;
  - `checkStepUp()` false: the step-up sentence, and the RPC is never called;
  - `getStripe()` null: "Card payments aren’t set up on this server yet.", and no RPC;
  - success: `begin_stripe_link` called with the org, then `redirect()` to `gateway.authorizeUrl(state, `${siteUrl()}/api/stripe/connect/callback`)`;
  - disconnect success: `end_stripe_account_link`, then `gateway.deauthorize(account)`, with message "Disconnected. Card payment links on this workspace’s invoices now say they can’t be paid online.";
  - disconnect where Stripe's call throws: the row is still ended (the RPC was called first), with message "Disconnected here, but Stripe didn’t confirm it. Remove GetSetPaid under Settings → Connected accounts in your Stripe dashboard."

  Implement `lib/invoices/stripe-actions.ts` in `settings-actions.ts`'s shape. Its step-up line is literally `if (!(await checkStepUp()) || !(await mintStepUpToken("invoice_settings")))` in each action, which is what `step-up-token-callers.test.ts` requires. Call `redirect()` from `next/navigation` outside any try/catch.

- [ ] **Step 4: The callback route.** `app/api/stripe/connect/callback/route.ts`, GET:
  1. Resolve the org with `getCurrentOrg(slug)`; with none, `notFound()` semantics. Copy how `invoices/[invoiceId]/pdf/route.ts` refuses.
  2. Read `code`, `state` and `error` from the query.
  3. On `error`, or a missing code or state, redirect to `/${slug}/settings/invoicing?stripe=cancelled`.
  4. Otherwise `gateway.exchangeCode(code)` → `gateway.chargesEnabled(account)` → `rpc("complete_stripe_link", …)`.
  5. On success redirect `?stripe=linked`. On an RPC refusal redirect `?stripe=<hint>`, keeping only hints in `INVOICE_REFUSAL_SENTENCES`, otherwise `failed`. On a Stripe error redirect `?stripe=failed`.

  The settings page maps `stripe` to a sentence through an allowlist and shows it in an `ActionOutcome`. Never echo the raw query value.

- [ ] **Step 5: The panel and the page.** `components/invoices/stripe-connection-panel.tsx` (client) shows:
  - not configured: "Card payments aren’t set up on this server yet.", with no button;
  - not linked: an explanation ("Link your existing Stripe account to add a Pay by card link to your invoices. GetSetPaid takes 1% of each card payment; Stripe’s own fees are charged to your account.") and a `StepUpGate`-wrapped "Connect Stripe" form, built the way `invoice-settings-form.tsx` wraps its save;
  - linked: "Connected on <date>", plus "Stripe hasn’t enabled card payments on this account yet. Finish setting it up in Stripe." when `chargesEnabled` is false, and a step-up "Disconnect" form;
  - ended: "Disconnected on <date>." and the Connect form.

  The page reads the fee for the sentence with a definer read or by hardcoding it from the DB. Simplest: add `public.stripe_application_fee_bps()` (stable, definer, granted to `authenticated`, returns the one integer) to this migration and to the matrix. Render the sentence through `formatPercent` if it exists (`grep -rn "export function format" lib/format`), otherwise `${bps / 100}%`.

- [ ] **Step 6: The email.**
  1. Tests first in `invoice-templates.test.ts`: `buildStripeAccountChangedNotice({ organisationSlug, organisationName, change, changedAt, siteUrl })` has the subject `[GetSetPaid] A Stripe account was connected to <slug>'s invoices` or `... was disconnected from ...`. The body says when, says to check Invoice settings, and says to contact support if it wasn't you. The allowlist refuses extra keys, as `buildBankDetailsChangedNotice` does.
  2. Then `deliverInvoiceStripeAccountNotifications` in `invoice-notifications.ts`, a copy of the bank-change sender with the new resolver and notice name.
  3. Wire it into `app/api/incident-alerts/deliver/route.ts` beside `invoiceBankChanges`, and extend `delivery-route.test.ts` the way it covers the bank sender.

- [ ] **Step 7: Mutants, gates, commit.**
  - Mutant 1: drop `and user_id = v_uid` from the state check. § SL's "another user's state" goes red.
  - Mutant 2: remove `consume_step_up` from `begin`. "Without a token" goes red.
  - Run `npx next typegen`, `pnpm typecheck`, eslint, the unit tests, the full psql suite, and the integration matrix.
  - Commit "Link and disconnect a workspace's Stripe account behind step-up", with the trailer, and push.

---

### Task 4: Paying: the pay page RPCs, the card-payment RPCs

**Files:**
- Create: `supabase/migrations/20261110002000_stripe_card_payment_rpcs.sql`
- Modify: `supabase/tests/rls_invoices_stripe.sql` (§ SY, § SW), `tests/integration/security/phase7-permission-matrix.test.ts`

**Interfaces:**
- Produces (SQL, all `service_role` only):
  - `public.invoice_pay_page(p_invoice_id uuid) returns table (payable boolean, seller_name text, number text, gross_minor bigint)`. `payable` is false for every refusal. `seller_name` is null when the invoice does not exist or is a draft, so an unknown and a known-but-unpayable link differ only by the seller name, as the spec's two refusal sentences require. `number` and `gross_minor` are null unless `payable`.
  - `public.begin_invoice_card_payment(p_invoice_id uuid) returns table (account text, number text, gross_minor bigint, fee_minor bigint, pay_session_id uuid)`, which raises `invoice_not_payable_online` (22023) or `invoice_pay_rate_limited` (54000).
  - `public.attach_invoice_pay_session(p_pay_session_id uuid, p_stripe_session_id text) returns void`.
  - `public.record_stripe_checkout_completed(p_event_id text, p_account text, p_invoice_id uuid, p_payment_intent text, p_amount_minor bigint, p_currency text, p_paid_at timestamptz) returns text`. It returns `'applied' | 'after_paid' | 'after_void' | 'duplicate' | 'mismatch' | 'unknown_account'`.
  - `public.record_stripe_charge_refunded(p_event_id text, p_account text, p_payment_intent text, p_refunded_minor bigint, p_refunded_at timestamptz) returns text`. It returns `'flagged' | 'duplicate' | 'unknown_payment' | 'unknown_account'`.

  The deauthorisation and account-update events go through Task 3's two RPCs, extended to take `p_event_id text` and record it in `stripe_events`. Rebuild them in this migration from Task 3's definitions, keeping their names, and update the matrix arguments.

- [ ] **Step 1: psql § SY (pay) and § SW (webhook), failing first.** Each RPC is 42501 as `authenticated` and `anon`. As `service_role`:
  - **§ SY:**
    - `invoice_pay_page(inv_ai)` with A linked and charges enabled is `payable` with the seller, number and gross;
    - with no link, an ended link, `charges_enabled=false`, org A downgraded to Starter (use part 1's tier helper or a billing override fixture), or a paid or void invoice: `payable=false`, the seller present, and number and gross null;
    - an unknown UUID or a draft: every column false or null;
    - `begin_invoice_card_payment` returns `fee_minor = 120` for gross 12000 at 100 bps and writes one `invoice_pay_sessions` row;
    - the 21st call within an hour raises `invoice_pay_rate_limited` (insert 20 rows as postgres first; positive control: with 19 rows the next call succeeds);
    - every unpayable state raises `invoice_not_payable_online`.
  - **§ SW:**
    - `record_stripe_checkout_completed` for issued `inv_ai`, A's live account, amount 12000 and `GBP` returns `applied`. The invoice is then `paid` with `paid_via='card'`, `paid_by` null and `paid_on` = the UK date of `p_paid_at`. One `invoice_card_payments` row has outcome `applied`. The finance booking matches what `mark_invoice_paid` books for an identical invoice: reuse `rls_invoices.sql` § IP's event fixture shape and assert that the income entry exists, net of VAT, with `created_by` null. One `invoice.paid_by_card` audit row has the tombstone actor and `after` = `{status, number}` only. There is one `stripe_events` row.
    - The same event ID again: `duplicate`, with no second row of any kind.
    - The same payment intent with a new event ID: `duplicate` (the unique payment intent).
    - Wrong account: `mismatch`. Nothing changes, and one `incident_alerts` row of type `stripe_payment_mismatch` is written for org A, whose `details` carry only `{invoice_id, event_id}`.
    - Wrong amount, and `currency='EUR'`: `mismatch`.
    - An account no workspace has: `unknown_account`, and no `stripe_events` row.
    - On `inv_ap` (already paid): `after_paid`. The status and finance are unchanged, and one card-payment row has outcome `after_paid`, audited as `invoice.card_payment_conflict`.
    - On a void invoice: `after_void`.
    - `record_stripe_charge_refunded` for the applied payment intent with 5000 returns `flagged`, setting `refunded_minor=5000` and `refunded_at`, with the status still `paid`, audited `invoice.card_refund_flagged`. A later event with a cumulative 12000 sets 12000. A refund greater than the amount clamps to the amount. An unknown payment intent returns `unknown_payment`.

- [ ] **Step 2: Write the migration.**

```sql
create or replace function private.invoice_is_payable_online(p_inv public.invoices)
returns text language sql stable security definer set search_path = '' as $$
  -- The live account id when the invoice can be paid by card now, else null.
  select a.stripe_account_id
    from public.invoice_stripe_accounts a
   where p_inv.status = 'issued'
     and a.organisation_id = p_inv.organisation_id
     and a.ended_at is null and a.charges_enabled
     and exists (select 1 from private.finance_module_organisations() f where f = p_inv.organisation_id)
$$;
revoke all on function private.invoice_is_payable_online(public.invoices) from public, anon, authenticated, service_role;
```

  `begin_invoice_card_payment`:
  1. Lock the invoice row (`for update`) so concurrent clicks serialise their count.
  2. Look up `v_account := private.invoice_is_payable_online(v_inv)`; null raises `invoice_not_payable_online`.
  3. Count `invoice_pay_sessions` for the invoice with `created_at > now() - interval '1 hour'`; 20 or more raises `invoice_pay_rate_limited`.
  4. Insert the session row, compute the fee with `private.application_fee_minor(v_inv.gross_minor, (select application_fee_bps from public.stripe_platform_settings))`, and return.

  `record_stripe_checkout_completed`:
  1. Resolve the org from the live or ended account (`select organisation_id from invoice_stripe_accounts where stripe_account_id = p_account order by ended_at nulls first limit 1`). None returns `unknown_account`.
  2. `insert into public.stripe_events … on conflict (id) do nothing`; no row inserted returns `duplicate`.
  3. If a card payment with this payment intent exists, return `duplicate`.
  4. Lock the invoice by `id = p_invoice_id and organisation_id = v_org`. Missing, or the account not the live linked one, or `p_amount_minor <> gross_minor`, or `upper(p_currency) <> currency`: insert the `incident_alerts` row (`summary` = 'A card payment did not match its invoice', `details` = `jsonb_build_object('invoice_id', p_invoice_id, 'event_id', p_event_id)`) and return `mismatch`.
  5. Status `issued`: `perform private.book_invoice_payment(p_invoice_id, (p_paid_at at time zone 'Europe/London')::date, null)`, set `status='paid', paid_on=…, paid_via='card', paid_entry_id=…`, insert the card payment `applied`, audit, and return `applied`.
  6. `paid` / `void`: insert the card payment with outcome `after_paid` / `after_void`, audit the conflict, and return the outcome.

  `paid_on` must be ≥ `issue_date`. If Stripe's time is earlier (clock skew), use `issue_date`.

  `record_stripe_charge_refunded` follows the same org resolution and event insert, then `update invoice_card_payments set refunded_minor = least(p_refunded_minor, amount_minor), refunded_at = p_refunded_at where stripe_payment_intent_id = p_payment_intent and organisation_id = v_org`. No row returns `unknown_payment`.

  Grant every public function to `service_role` only. Declare them all in the matrix's `SERVER_ONLY_RPCS` with the § reference.

- [ ] **Step 3: Mutants.**
  - Remove the amount comparison: § SW's wrong-amount row goes red.
  - Remove `on conflict do nothing` handling (insert plainly): the duplicate row errors instead of returning `duplicate`.
  - Change `>= 20` to `>= 21`: the rate-limit pair goes red.

- [ ] **Step 4: Pin, gates, commit.** Run the full psql suite and the matrix integration test, then commit "Pay-page and card-payment RPCs: one booking path for card and manual payment" and push.

---

### Task 5: The pay page, its start route, the thanks page, and the public path

**Files:**
- Create: `lib/invoices/pay.ts`, `components/invoices/pay-page.tsx`, `app/pay/[token]/page.tsx`, `app/pay/[token]/loading.tsx`, `app/pay/[token]/start/route.ts`, `app/pay/[token]/thanks/page.tsx`, `tests/integration/invoices/stripe-pay.test.ts`, `tests/unit/invoices/pay-page.test.tsx`
- Modify: `lib/supabase/middleware.ts` (`PUBLIC_PATHS`), `tests/unit/security/public-paths.test.ts`, `tests/unit/email/service-client-census.test.ts`, `lib/supabase/service.ts` (header list), `next.config.ts` or the headers source (the `Referrer-Policy` on `/pay`), `tests/unit/security/headers.test.ts`, `tests/e2e/support/axe-routes.ts`

**Interfaces:**
- Consumes: Task 1 `verifyPayLinkToken`, `getStripe`; Task 4 RPCs.
- Produces:
  ```ts
  // lib/invoices/pay.ts
  export type PayView =
    | { kind: "payable"; sellerName: string; number: string; grossMinor: number }
    | { kind: "refused"; sellerName: string | null };
  export async function loadPayView(token: string): Promise<PayView>;
  export type StartOutcome = { kind: "redirect"; url: string } | { kind: "refused"; sellerName: string | null } | { kind: "unavailable" };
  export async function startCardPayment(token: string, origin: string): Promise<StartOutcome>;
  ```

- [ ] **Step 1: Public path, test first.** In `public-paths.test.ts`, extend the expected list with `"/pay"`, and add `"/payments"`, `"/pay-anything"` and `"/paylater"` to the neighbour cases that must stay private. Run it and see it fail. Add `"/pay"` to `PUBLIC_PATHS` with a doc line ("the card-payment page for an invoice's recipient, who has no account; the credential is the signed token, lib/stripe/pay-link.ts"). Run it again and see it pass. Check `SIGNED_OUT_ONLY_PATHS` is untouched, because a signed-in user may also pay.

- [ ] **Step 2: Service-client census.** Add `"lib/invoices/pay.ts"` to `ALLOWED` in `tests/unit/email/service-client-census.test.ts`, with the reason "the card-payment page: no session; calls only invoice_pay_page / begin_invoice_card_payment / attach_invoice_pay_session, all service_role-only", and add the same paragraph to `lib/supabase/service.ts`'s "WHAT IT REACHES" list. Task 6 adds the webhook file the same way.

- [ ] **Step 3: `lib/invoices/pay.ts`, with an integration test first.** `tests/integration/invoices/stripe-pay.test.ts` runs against the local stack:
  - it creates an org with a linked account through SQL as postgres, as `tests/integration/export/runner.test.ts` builds its fixtures;
  - it stubs `INVOICE_PAY_LINK_SECRET` and `STRIPE_MODE=fake` plus the three fake keys;
  - `loadPayView(validToken)` is `payable` with the number;
  - `loadPayView` of a tampered token, of a random valid-shaped UUID, and of a draft is `{ kind: "refused", sellerName: null }`;
  - an unlinked issued invoice gives `{ kind: "refused", sellerName: <name> }`;
  - `startCardPayment(validToken, origin)` redirects to `https://checkout.stripe.test/c/pay/cs_fake_…`, and the `invoice_pay_sessions` row carries that session ID;
  - a fake gateway made to throw (`vi.spyOn(FakeStripeGateway.prototype, "createCheckoutSession").mockRejectedValue(...)`) gives `unavailable`.

  Implement `pay.ts` (`import "server-only"`):
  1. `verifyPayLinkToken`; a null result is `{ kind: "refused", sellerName: null }` with no database call.
  2. `createServiceClient().rpc("invoice_pay_page", { p_invoice_id })` maps to the view.
  3. `startCardPayment` re-verifies the token, calls `begin_invoice_card_payment`, and maps the hints `invoice_not_payable_online` → refused (seller name via `invoice_pay_page`) and `invoice_pay_rate_limited` → unavailable.
  4. It then calls `gateway.createCheckoutSession({ account, invoiceId, number, grossMinor, feeMinor, successUrl: `${origin}/pay/${token}/thanks`, cancelUrl: `${origin}/pay/${token}` })` and `attach_invoice_pay_session`, and returns the redirect.
  5. A null `getStripe()` is `unavailable`.

  Use `siteUrl()` for `origin`, never the request's Host (the auth callback's rule).

- [ ] **Step 4: The pages.** `app/pay/[token]/page.tsx` is a server component with `export const dynamic = "force-dynamic"` and `export const metadata = { robots: { index: false, follow: false } }`. It renders `<PayPage view={await loadPayView(token)} token={token} />`. `components/invoices/pay-page.tsx` shows:
  - payable: an `h1` "Invoice <number>", "From <seller>", "Amount due <formatGbp(gross)>", and a `<form method="post" action="/pay/<token>/start">` with a "Pay by card" submit button. Below it: "You’ll pay on a secure Stripe page. GetSetPaid never sees your card details.";
  - refused with a seller: an `h1` "This invoice can’t be paid online" and "Contact <seller> to pay it.";
  - refused without a seller: the same `h1` and "Check the link in your invoice email, or contact whoever sent it.";
  - `?unavailable=1`: "Card payment is unavailable right now. Try again later." above the form.

  Use the signed-out layout the legal pages use (`app/legal/...`), so the page carries the footer. Use no app chrome. A unit test (`tests/unit/invoices/pay-page.test.tsx`, Testing Library, as other component tests do) asserts the three states. The refused states must render no number and no amount: the test also asserts `container.textContent` contains no `£`.

  `app/pay/[token]/start/route.ts` (POST):
  - `redirect` → `NextResponse.redirect(url, 303)`;
  - `refused` → 303 to `/pay/<token>`;
  - `unavailable` → 303 to `/pay/<token>?unavailable=1`.

  No `GET` export, so a GET is 405. `app/pay/[token]/thanks/page.tsx` shows "Payment received — thank you." and "<seller> will see it on their invoice shortly. You can close this page." (seller from `loadPayView`, otherwise generic). It changes nothing.

- [ ] **Step 5: Headers.** Every `/pay/...` response sets `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
  1. Find where security headers are set (`grep -rn "Referrer-Policy" next.config.ts lib proxy.ts`).
  2. If the global value is already `no-referrer`, assert it for `/pay` in `headers.test.ts` and stop.
  3. Otherwise add a `/pay/:path*` header rule, with its test first.

- [ ] **Step 6: Census follow-ons.**
  - `tests/unit/design/axe-route-census.test.ts` will now name `app/pay/[token]/page.tsx` and `thanks`. Declare them in `tests/e2e/support/axe-routes.ts`, either as `SCANNED_ELSEWHERE` naming `invoices-card.spec.ts` (Task 9 scans them) or as `AXE_PAGES` with a signed-out role. A real token is needed, so `SCANNED_ELSEWHERE` is the honest choice.
  - Run `pnpm exec vitest run tests/unit` and declare anything else that goes red, following its message. The super-page census and route censuses may also walk `app/`.

- [ ] **Step 7: Mutant, gates, commit.**
  - Mutant: in `loadPayView`, skip `verifyPayLinkToken` and use the token's first segment. The tampered-token integration case goes red.
  - Run `npx next typegen`, typecheck, eslint, the unit tests, and the integration tests.
  - Commit "The card-payment page: a signed link, a button that starts Stripe Checkout", with the trailer, and push.

---

### Task 6: The webhook

**Files:**
- Create: `lib/invoices/stripe-webhook.ts`, `app/api/stripe/webhook/route.ts`, `tests/unit/stripe/webhook-route.test.ts`, `tests/integration/invoices/stripe-webhook.test.ts`
- Modify: `lib/supabase/middleware.ts` (`PUBLIC_PATHS` gains `"/api/stripe"`), `tests/unit/security/public-paths.test.ts`, `tests/unit/email/service-client-census.test.ts`, `lib/supabase/service.ts`

**Interfaces:**
- Consumes: Task 1 `getStripe().constructEvent`; Tasks 3–4 service RPCs.
- Produces: `handleStripeEvent(event: StripeEvent): Promise<{ status: 200 | 500; outcome: string }>`. 500 is returned only when the database call itself failed, so Stripe retries. Every business outcome (`mismatch`, `unknown_account`, `duplicate`, ignored types) is 200, so Stripe does not retry what will never succeed.

- [ ] **Step 1: Route unit test first** (`tests/unit/stripe/webhook-route.test.ts`, mocking `handleStripeEvent`):
  - `getStripe()` null: 503, handler not called;
  - missing `stripe-signature`: 400;
  - bad signature (a header from `generateTestHeaderString` with another secret): 400, handler not called;
  - valid signature: the handler is called with the parsed event and its status passed through;
  - the route reads the body with `await request.text()`, never `json()`, because the signature is over the raw bytes. Assert by sending a body with insignificant whitespace that would not survive a JSON round trip.
  - `GET` is not exported, so it is 405.

  Implement:

```ts
// app/api/stripe/webhook/route.ts
import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/invoices/stripe-webhook";

// POST /api/stripe/webhook -- Stripe Connect events, signed with
// STRIPE_WEBHOOK_SECRET. Public in the middleware (no session); the
// credential is the signature over the RAW body. Spec § 3.
export async function POST(request: Request): Promise<NextResponse> {
  const gateway = getStripe();
  if (!gateway) return new NextResponse("Not configured", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new NextResponse("Bad signature", { status: 400 });
  const raw = await request.text();
  let event;
  try {
    event = gateway.constructEvent(raw, signature);
  } catch {
    return new NextResponse("Bad signature", { status: 400 });
  }
  const result = await handleStripeEvent(event);
  return NextResponse.json({ outcome: result.outcome }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 2: Handler integration test first** (`tests/integration/invoices/stripe-webhook.test.ts`). It runs against the local stack with Task 5's fixture helpers, and builds each event as a plain object of the shape Stripe sends, passed straight to `handleStripeEvent`:
  - `checkout.session.completed` with `account`, `data.object = { metadata: { invoice_id }, payment_intent: "pi_…", amount_total, currency: "gbp", payment_status: "paid", created }`: the invoice becomes paid by card, with outcome `applied`;
  - `payment_status: "unpaid"`: ignored, 200, nothing changes;
  - `charge.refunded` with `data.object = { payment_intent, amount_refunded, created }`: `flagged`;
  - `account.application.deauthorized`: the link ends;
  - `account.updated` with `data.object.charges_enabled = false`: the flag flips;
  - an unhandled `invoice.paid` type: 200 `ignored`;
  - an event with no `account` (a platform event): 200 `ignored`;
  - one full route call through `POST` with a real signed body (`generateTestHeaderString` and the fake secret), proving the parse-to-RPC path end to end.

  Implement `lib/invoices/stripe-webhook.ts` (`import "server-only"`, service client). Use a `switch` on `event.type`. Read fields with narrow guards (`typeof x === "string"`), never by spreading the object. Pass `currency.toUpperCase()`, and `new Date(created * 1000).toISOString()` as the paid or refund time. A UUID check on `metadata.invoice_id` comes before the RPC (anything else is `ignored`).

- [ ] **Step 3: Public path and census.**
  - Add `"/api/stripe"` to `PUBLIC_PATHS`, with the test cases `/api/stripe/webhook` (public) and `/api/stripes` (not public).
  - Add `"lib/invoices/stripe-webhook.ts"` to the service-client `ALLOWED` list, with its reason, and to `service.ts`'s header.

- [ ] **Step 4: Mutants.**
  - Make the route call `request.json()` and `JSON.stringify` it back: the whitespace test goes red.
  - Map `mismatch` to 500: the handler test asserting 200 goes red.

- [ ] **Step 5: Gates, commit.** Commit "Stripe webhook: signed, idempotent, one RPC per event type" and push.

---

### Task 7: Pay by card on the PDF and in the email; notices on the invoice

**Files:**
- Create: `components/invoices/card-payment-notices.tsx`, `tests/unit/invoices/card-payment-notices.test.tsx`
- Modify: `lib/invoices/pdf/invoice-document.tsx`, `lib/invoices/pdf/render.tsx`, `app/(app)/[orgSlug]/invoices/[invoiceId]/pdf/route.ts`, `lib/invoices/send-action.ts`, `lib/email/invoice-templates.ts`, `lib/invoices/queries.ts` (`loadInvoice` gains card payments and `paid_via`), `components/invoices/invoice-view.tsx`, `tests/unit/invoices/pdf-render.test.ts`, `tests/unit/email/invoice-templates.test.ts`, `tests/unit/invoices/send-action.test.ts`

**Interfaces:**
- Consumes: Task 1 `payLinkUrl`; Task 3 `loadStripeAccount`.
- Produces:
  - `renderInvoicePdf(snapshot, { status, payUrl?: string | null })`;
  - `buildInvoiceEmail({ …, payUrl?: string | null })`;
  - `loadInvoice` returns `paidVia: "manual" | "card" | null` and `cardPayments: { amountMinor; outcome; receivedAt; refundedMinor; refundedAt }[]`.

- [ ] **Step 1: Template tests first.**
  - `buildInvoiceEmail` with `payUrl` adds the paragraph "Pay by card: <url>" before the bank paragraph. The HTML version renders it as a link (`<a href="…">Pay by card</a>`) only when the URL matches `^https?://[^\s"<>]+/pay/[0-9a-f-]{36}\.[A-Za-z0-9_-]+$`. Otherwise the builder throws `NoticeContentError`.
  - Without `payUrl`, the output is byte-identical to today's (snapshot the current output first).
  - The PDF: a "Pay by card" line with the URL renders when `payUrl` is set. `pdf-render.test.ts` extracts the text the way it checks the bank line.

- [ ] **Step 2: Implement.** In `invoice-document.tsx`, under the bank block, add `{payUrl ? <Text>Pay by card: <Link src={payUrl}>{payUrl}</Link></Text> : null}`, using `@react-pdf/renderer`'s `Link`. Thread `payUrl` through `render.tsx`. In the PDF route and `send-action.ts`, compute `payUrl` only when the status is `issued` and `(await loadStripeAccount(org.id))?.live && chargesEnabled`, then call `payLinkUrl(invoiceId)`. A paid or void invoice never carries the link.

- [ ] **Step 3: Notices, test first.** `card-payment-notices.tsx` renders from `cardPayments`:
  - `applied`: "Paid by card on <date> (<amount>)."
  - `after_paid`: "A card payment of <amount> arrived on <date> after this invoice was already paid. Refund it in Stripe."
  - `after_void`: the same with "voided".

  The two conflict notices use `role="alert"` and the danger token. When `refundedMinor > 0`, add "Refunded in Stripe: <amount> on <date>." The component test covers each outcome and the refund line. Add it to `invoice-view.tsx` under the status chip. `loadInvoice` reads `invoice_card_payments` through RLS (`.eq("invoice_id", id).order("received_at").limit(20)`, which keeps the unbounded-read census happy).

- [ ] **Step 4: Gates, commit.** Commit "Pay by card on the PDF and email; card-payment notices on the invoice" and push.

---

### Task 8: Legal and record: the sub-processor, the docs, the founder actions

**Files:**
- Modify: `docs/sub-processors.md`, `lib/legal/sub-processors.ts`, `docs/launch-gates.md` (Founder actions), `docs/as-built.md`, `CLAUDE.md` (Current state: one line for part 2), `SECURITY.md` (local only, gitignored: § 15 gains the four Stripe settings), `.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`

- [ ] **Step 1: Sub-processor, drift test first.**
  1. Add the Stripe entry to `lib/legal/sub-processors.ts` in the shape of the existing entries: Stripe Payments Europe, Ltd., Ireland; "card payments for invoices: payer email, invoice number and amount"; transfer basis per the existing fields (the EEA).
  2. Run the drift test (`grep -rl sub-processors tests/unit | head`). It goes red until `docs/sub-processors.md` gets the matching row, so add it.
  3. If the legal page `/legal/sub-processors` is generated from a published `legal_documents` version, do **not** publish a new version. That waits for counsel (F3). Add Q280 with the default "engineering-draft row added; the published page is updated with counsel's next review".

- [ ] **Step 2: Founder actions.** In `docs/launch-gates.md` § Founder actions, add F13: "Stripe platform account with Connect (Standard) on; the four secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `INVOICE_PAY_LINK_SECRET`, at least 32 bytes) in the hosted environment, `STRIPE_MODE` unset; the Connect webhook URL `https://<domain>/api/stripe/webhook` for `checkout.session.completed`, `charge.refunded`, `account.updated` and `account.application.deauthorized`; the one OAuth redirect URI `https://<domain>/api/stripe/connect/callback` (Stripe matches `redirect_uri` exactly against the registered list); one real test-mode payment end to end; accept Stripe's DPA". The lead time is half a day once a domain exists. Add the same items to `SECURITY.md` § 15 with their verification steps, and add the keys to `security-md-checklist.test.ts` if it enumerates them.

- [ ] **Step 3: Decisions queue.** Append `## Q279 -- Invoices part 2: Stripe Connect answers (founder 2026-11-05), recorded`, with the answers table from the spec and the plan's eight decisions listed by one line each. Q280 is the sub-processor page, if Step 1 needed it.

- [ ] **Step 4: As-built and CLAUDE.md.**
  - `docs/as-built.md` gains § "Invoices part 2 (Stripe Connect), as it actually shipped", recording what shipped, the eight decisions, and the founder action.
  - In `CLAUDE.md` § Current state, add one sentence after the part 1 paragraph: "**Invoices part 2** (Q279): link a Stripe Standard account behind step-up; a signed `/pay/<id>.<sig>` link on the PDF and email starts a Checkout direct charge with a 1% application fee; the signed webhook marks the invoice paid by card through part 1's booking path. Detail in `docs/as-built.md`."
  - Also update § Scope discipline's sentence "part 2 Stripe Connect and part 3 network delivery follow" to "part 2 Stripe Connect shipped; part 3 network delivery follows". Keep it short (CLAUDE.md's own rule).

- [ ] **Step 5: Commit.** `git add -f` the decisions queue and commit "Record invoices part 2: sub-processor, founder actions, decisions, as-built" and push. Do not add `SECURITY.md` (it is gitignored).

---

### Task 9: The card golden path, the scans, and the final gate run

**Files:**
- Create: `tests/e2e/invoices-card.spec.ts`
- Modify: `tests/e2e/support/fixtures.ts`, `tests/e2e/tenant-breakout.spec.ts` (if it enumerates finance tables or routes)

- [ ] **Step 1: Fixtures.**
  - `fixtures.ts` gains `linkFakeStripeAccount(orgId, account = "acct_fakee2e0001")` (postgres insert, `charges_enabled = true`) and `unlinkStripe(orgId)`.
  - `signedWebhook(event)` returns `{ body, headers }`, signed with `Stripe.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET ?? <read from .env.development.local> })`. Read the secret the way the fixtures read other dev-env values (`grep -n "env.development.local" tests/e2e/support/*.ts`).
  - `cardPaymentsFor(invoiceId)` returns the rows from `invoice_card_payments`.

- [ ] **Step 2: The spec**, serial, on one world:
  1. **Linking:** sign in as Finance, then open `/<slug>/settings/invoicing`. Click "Connect Stripe" and complete the step-up prompt the way `invoices.spec.ts`'s golden path does. The fake's authorize URL is our own callback, so expect `?stripe=linked` and the text "Connected on". Assert one `invoice_stripe_account.linked` audit row (`countAuditRows`).
  2. **The golden path:** issue a draft with an event income line, the same as `invoices.spec.ts`'s golden path but shorter: use the planted draft. Then:
     - download the PDF and assert its text contains `/pay/` (extract it the way `pdf-render.test.ts` does, or assert on bytes containing the URL string);
     - build the token in the test with the same HMAC as `lib/stripe/pay-link.ts` (import `payLinkToken` directly, with `INVOICE_PAY_LINK_SECRET` set from dev-env);
     - open `/pay/<token>` signed out, in a fresh context; see "Invoice INV-…", the amount, and "Pay by card";
     - run `scan(page)` (axe);
     - click "Pay by card" and assert the navigation goes to `https://checkout.stripe.test/` (`page.waitForRequest(/checkout\.stripe\.test/)`, then route-abort it so no DNS lookup happens);
     - POST a signed `checkout.session.completed` to `/api/stripe/webhook` with `page.request.post`, for the invoice's gross;
     - reload the invoice signed in as Finance: "Paid by card on …";
     - on the event page, the income appears net of VAT.
  3. **Thanks page:** `/pay/<token>/thanks` shows "Payment received", and `scan(page)`.
  4. **Refusals look alike:** a tampered token, and the paid invoice's token, both show "This invoice can’t be paid online", with no `£` on the page. The paid one names the seller; the tampered one does not. `scan(page)` the tampered one.
  5. **Conflict:** a second signed event with a new event ID and payment intent, for the same invoice, puts "Refund it in Stripe" on the invoice page.
  6. **Refund:** a signed `charge.refunded` shows "Refunded in Stripe".
  7. **Keyboard:** on `/pay/<token>`, Tab reaches "Pay by card" and Enter submits it. Unlink, issue another invoice, and the PDF has no `/pay/`.
  8. **Tier:** a Starter workspace's settings page shows no Connect button (finance write access refuses).

  The callback `/api/stripe/connect/callback` has no workspace in its path, so `tenant-breakout.spec.ts` has no foreign-org route to add; the claim RPC's user binding (Task 3's tests) is the cross-tenant guard.

- [ ] **Step 3: Run the new spec.** Stop any dev server you started, start one in the background with `pnpm dev`, then run `PLAYWRIGHT_REUSE_SERVER=1 npx playwright test tests/e2e/invoices-card.spec.ts --workers=1`. Expected: all pass. **Mutant:** make `startCardPayment` skip `begin_invoice_card_payment`'s status check by passing a paid invoice (temporarily allow `paid` in `private.invoice_is_payable_online`). Step 4's "paid invoice refused" goes red. Revert it.

- [ ] **Step 4: The final gate run.** Check for other sessions first, then run:
  1. `pnpm lint` (or the eslint form);
  2. `npx next typegen && pnpm typecheck`;
  3. `pnpm test`;
  4. `npx supabase db reset --local && bash supabase/tests/run-rls-tests.sh`, which must report "All suites passed";
  5. the whole e2e suite in groups under 10 minutes each (`npx playwright test --list` for the file set).

  Record the measured counts (Playwright total, axe scans via `grep -c "await scan(\|new AxeBuilder" tests/e2e/*.spec.ts`, and the `ist` pin) in the ledger, not in CLAUDE.md.

- [ ] **Step 5: Commit, PR.** Commit "Card-payment golden path, the seventh sibling" and push. Open the PR to `main`, titled "Invoices part 2: Stripe Connect card payments". Its body summarises the spec link, the eight plan decisions, the founder action F13, and the gate results, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Wait for CI green. **Do not merge** without the founder's explicit approval.
