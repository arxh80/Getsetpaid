// THE STRIPE WEBHOOK'S LOGIC, AGAINST THE REAL STACK (invoices part 2 Task 6).
// Each event is the plain object Stripe sends, handed straight to
// handleStripeEvent; one case goes through POST with a real signed body. Every
// guard case sits beside the applied control (the first), so a refusal cannot
// pass for want of a fixture.
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;
let handleStripeEvent: typeof import("@/lib/invoices/stripe-webhook").handleStripeEvent;
let POST: typeof import("@/app/api/stripe/webhook/route").POST;
type Ev = Parameters<typeof import("@/lib/invoices/stripe-webhook").handleStripeEvent>[0];

const SECRET = "whsec_fake";
let acctA: string; // org A's live link, charges enabled
let acctB: string; // org B's live link, for the account.* events
let company: string;
let n = 0;

const evt = (type: string, account: string | undefined, object: Record<string, unknown>): Ev =>
  ({ id: `evt_${fx.runId}_${(n += 1)}`, type, ...(account ? { account } : {}), data: { object } }) as unknown as Ev;

async function issuedInvoice(): Promise<string> {
  const num = `WH-${String((n += 1)).padStart(4, "0")}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.invoices (organisation_id, recipient_company_id, recipient_address, created_by)
     values ($1,$2,'8 Customer Road, London',$3) returning id`,
    [fx.orgA.id, company, fx.ownerA.userId],
  );
  const id = rows[0].id;
  await pool.query(
    `insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
       unit_price_minor, vat_rate, net_minor, vat_minor) values ($1,$2,1,'Fee',1.00,10000,'standard_20',10000,2000)`,
    [fx.orgA.id, id],
  );
  await pool.query(`update public.invoices set net_minor = 10000, vat_minor = 2000, gross_minor = 12000 where id = $1`, [id]);
  await pool.query(
    `update public.invoices i set status = 'issued', number = $2, issue_date = current_date,
       supply_date = current_date, due_date = current_date + 30,
       snapshot = private.build_invoice_snapshot(i.id, $2, current_date, current_date, current_date + 30)
     where i.id = $1`,
    [id, num],
  );
  return id;
}

const session = (invoiceId: string, intent: string, over: Record<string, unknown> = {}) => ({
  metadata: { invoice_id: invoiceId }, payment_intent: intent, amount_total: 12000, currency: "gbp",
  payment_status: "paid", created: 1_790_000_000, ...over,
});
const paid = (invoiceId: string, intent: string, over: Record<string, unknown> = {}) =>
  handleStripeEvent(evt("checkout.session.completed", acctA, session(invoiceId, intent, over)));
const invoiceRow = async (id: string) =>
  (await pool.query<{ status: string; paid_via: string | null }>(`select status, paid_via from public.invoices where id = $1`, [id])).rows[0];
const paymentCount = async (intent: string) =>
  Number((await pool.query<{ c: string }>(`select count(*) c from public.invoice_card_payments where stripe_payment_intent_id = $1`, [intent])).rows[0].c);
const refunded = async (intent: string) =>
  Number((await pool.query<{ r: string }>(`select refunded_minor r from public.invoice_card_payments where stripe_payment_intent_id = $1`, [intent])).rows[0].r);
const pi = () => `pi_${fx.runId.replaceAll("-", "").slice(0, 12)}_${(n += 1)}`;

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  vi.stubEnv("STRIPE_MODE", "fake");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_fake");
  ({ handleStripeEvent } = await import("@/lib/invoices/stripe-webhook"));
  ({ POST } = await import("@/app/api/stripe/webhook/route"));

  fx = await createFixtures();
  pool = fx._pool;
  await pool.query(
    `insert into public.organisation_subscriptions (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
     values ($1,'pro','monthly',4,'active', now() + interval '30 days'), ($2,'pro','monthly',4,'active', now() + interval '30 days')
     on conflict (organisation_id) do update set plan_id = 'pro', status = 'active'`,
    [fx.orgA.id, fx.orgB.id],
  );
  await pool.query(
    `insert into public.invoice_settings (organisation_id, business_name, business_address)
     values ($1,'Hook Alpha Ltd','1 Alpha Street'), ($2,'Hook Beta Ltd','2 Beta Road')`,
    [fx.orgA.id, fx.orgB.id],
  );
  const tag = fx.runId.replaceAll("-", "").slice(0, 16);
  acctA = `acct_WA${tag}`;
  acctB = `acct_WB${tag}`;
  await pool.query(
    `insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by)
     values ($1,$2,true,$3), ($4,$5,true,$6)`,
    [fx.orgA.id, acctA, fx.ownerA.userId, fx.orgB.id, acctB, fx.ownerB.userId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.companies (organisation_id, name) values ($1,'Hook Customer') returning id`, [fx.orgA.id]);
  company = rows[0].id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (fx) await destroyFixtures(fx);
});

describe("checkout.session.completed", () => {
  it("marks an issued invoice paid by card (the control), and a replay of the event id is a duplicate", async () => {
    const inv = await issuedInvoice();
    const intent = pi();
    const e = evt("checkout.session.completed", acctA, session(inv, intent));
    expect(await handleStripeEvent(e)).toEqual({ status: 200, outcome: "applied" });
    expect(await invoiceRow(inv)).toEqual({ status: "paid", paid_via: "card" });
    expect(await handleStripeEvent(e)).toEqual({ status: 200, outcome: "duplicate" });
    expect(await paymentCount(intent)).toBe(1);
  });

  it("payment_status unpaid is ignored and changes nothing", async () => {
    const inv = await issuedInvoice();
    const intent = pi();
    expect(await paid(inv, intent, { payment_status: "unpaid" })).toEqual({ status: 200, outcome: "ignored" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
    expect(await paymentCount(intent)).toBe(0);
  });

  it.each([
    ["a non-UUID invoice_id", { metadata: { invoice_id: "not-a-uuid" } }],
    ["no invoice_id", { metadata: {} }],
    ["no payment_intent", { payment_intent: null }],
    ["a null amount_total", { amount_total: null }],
    ["a negative amount_total", { amount_total: -1 }],
    ["a fractional amount_total", { amount_total: 120.5 }],
    ["a null created", { created: null }],
    ["a missing currency", { currency: null }],
  ])("%s is ignored (200), never a CHECK-constraint 500", async (_label, over) => {
    const inv = await issuedInvoice();
    const intent = pi();
    expect(await paid(inv, intent, over)).toEqual({ status: 200, outcome: "ignored" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
    expect(await paymentCount(intent)).toBe(0);
  });

  it("a wrong amount is a mismatch, answered 200 so Stripe does not retry, and the invoice stays issued", async () => {
    const inv = await issuedInvoice();
    expect(await paid(inv, pi(), { amount_total: 11999 })).toEqual({ status: 200, outcome: "mismatch" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
  });

  it("an account no workspace holds is 200 unknown_account", async () => {
    const inv = await issuedInvoice();
    const out = await handleStripeEvent(evt("checkout.session.completed", "acct_nobody", session(inv, pi())));
    expect(out).toEqual({ status: 200, outcome: "unknown_account" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
  });

  it("a database failure is the one 500, and nothing is applied", async () => {
    const { createServiceClient } = await import("@/lib/supabase/service");
    const proto = Object.getPrototypeOf(createServiceClient());
    const spy = vi.spyOn(proto, "rpc").mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const inv = await issuedInvoice();
    expect(await paid(inv, pi())).toEqual({ status: 500, outcome: "error" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
    spy.mockRestore();
    quiet.mockRestore();
  });
});

describe("charge.refunded", () => {
  it("flags a refund on a card payment (the control); the invoice stays paid", async () => {
    const inv = await issuedInvoice();
    const intent = pi();
    expect((await paid(inv, intent)).outcome).toBe("applied");
    const out = await handleStripeEvent(evt("charge.refunded", acctA, { payment_intent: intent, amount_refunded: 5000, created: 1_790_000_100 }));
    expect(out).toEqual({ status: 200, outcome: "flagged" });
    expect(await refunded(intent)).toBe(5000);
    expect(await invoiceRow(inv)).toEqual({ status: "paid", paid_via: "card" });
  });

  it.each([
    ["a zero amount_refunded", { amount_refunded: 0 }],
    ["a null amount_refunded", { amount_refunded: null }],
    ["a fractional amount_refunded", { amount_refunded: 10.5 }],
    ["a null created", { created: null }],
    ["a null payment_intent", { payment_intent: null }],
  ])("%s is ignored (200), never a CHECK-constraint 500", async (_label, over) => {
    const inv = await issuedInvoice();
    const intent = pi();
    await paid(inv, intent);
    const out = await handleStripeEvent(
      evt("charge.refunded", acctA, { payment_intent: intent, amount_refunded: 1000, created: 1_790_000_100, ...over }),
    );
    expect(out).toEqual({ status: 200, outcome: "ignored" });
    expect(await refunded(intent)).toBe(0);
  });

  it("a refund for a payment this workspace never received is 200 unknown_payment", async () => {
    const out = await handleStripeEvent(evt("charge.refunded", acctA, { payment_intent: pi(), amount_refunded: 100, created: 1_790_000_100 }));
    expect(out).toEqual({ status: 200, outcome: "unknown_payment" });
  });
});

describe("account events and the rest", () => {
  it("account.updated with charges_enabled false flips the flag (a non-boolean is ignored)", async () => {
    expect(await handleStripeEvent(evt("account.updated", acctB, { charges_enabled: "no" })))
      .toEqual({ status: 200, outcome: "ignored" });
    expect(await handleStripeEvent(evt("account.updated", acctB, { charges_enabled: false })))
      .toEqual({ status: 200, outcome: "applied" });
    const { rows } = await pool.query<{ charges_enabled: boolean }>(
      `select charges_enabled from public.invoice_stripe_accounts where stripe_account_id = $1`, [acctB]);
    expect(rows[0].charges_enabled).toBe(false);
  });

  it("account.application.deauthorized ends the link", async () => {
    expect(await handleStripeEvent(evt("account.application.deauthorized", acctB, {})))
      .toEqual({ status: 200, outcome: "applied" });
    const { rows } = await pool.query<{ ended_at: string | null; ended_reason: string | null }>(
      `select ended_at, ended_reason from public.invoice_stripe_accounts where stripe_account_id = $1`, [acctB]);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].ended_reason).toBe("deauthorized");
  });

  it("an unhandled type is 200 ignored", async () => {
    expect(await handleStripeEvent(evt("invoice.paid", acctA, {}))).toEqual({ status: 200, outcome: "ignored" });
  });

  it("an event with no account (a platform event) is 200 ignored, even of a handled type", async () => {
    const inv = await issuedInvoice();
    expect(await handleStripeEvent(evt("checkout.session.completed", undefined, session(inv, pi()))))
      .toEqual({ status: 200, outcome: "ignored" });
    expect(await invoiceRow(inv)).toEqual({ status: "issued", paid_via: null });
  });
});

describe("POST with a real signed body", () => {
  const stripe = new Stripe("sk_test_fake");
  const call = (body: string, secret: string) =>
    POST(new Request("https://app.example.test/api/stripe/webhook", {
      method: "POST", body, headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret }) },
    }));

  it("parses, verifies and pays the invoice end to end; a wrong-secret signature pays nothing", async () => {
    const inv = await issuedInvoice();
    const res = await call(JSON.stringify(evt("checkout.session.completed", acctA, session(inv, pi())), null, 2), SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "applied" });
    expect(await invoiceRow(inv)).toEqual({ status: "paid", paid_via: "card" });

    const inv2 = await issuedInvoice();
    const refused = await call(JSON.stringify(evt("checkout.session.completed", acctA, session(inv2, pi()))), "whsec_other");
    expect(refused.status).toBe(400);
    expect(await invoiceRow(inv2)).toEqual({ status: "issued", paid_via: null });
  });
});
