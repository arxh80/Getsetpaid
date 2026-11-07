// THE PAY PAGE'S LOGIC, AGAINST THE REAL STACK (invoices part 2 Task 5).
// lib/invoices/pay.ts has no session: it reads and writes only through the
// three service_role-only RPCs. Each refusal is asserted beside a payable
// control (the first case), so a refusal cannot pass for want of a fixture.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;
let loadPayView: typeof import("@/lib/invoices/pay").loadPayView;
let startCardPayment: typeof import("@/lib/invoices/pay").startCardPayment;
let payLinkToken: typeof import("@/lib/stripe/pay-link").payLinkToken;
let FakeStripeGateway: typeof import("@/lib/stripe/fake").FakeStripeGateway;

const ORIGIN = "https://app.example.test";
let number: string;
let issued: string; // linked, Pro, issued
let draft: string;
let unlinked: string; // issued, but its workspace has no Stripe link

async function invoice(org: string, userId: string, company: string, n: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.invoices (organisation_id, recipient_company_id, recipient_address, created_by)
     values ($1,$2,'8 Customer Road, London',$3) returning id`,
    [org, company, userId],
  );
  const id = rows[0].id;
  await pool.query(
    `insert into public.invoice_lines (organisation_id, invoice_id, position, description, quantity,
       unit_price_minor, vat_rate, net_minor, vat_minor) values ($1,$2,1,'Fee',1.00,10000,'standard_20',10000,2000)`,
    [org, id],
  );
  await pool.query(`update public.invoices set net_minor = 10000, vat_minor = 2000, gross_minor = 12000 where id = $1`, [id]);
  if (n) {
    await pool.query(
      `update public.invoices i set status = 'issued', number = $2, issue_date = current_date,
         supply_date = current_date, due_date = current_date + 30,
         snapshot = private.build_invoice_snapshot(i.id, $2, current_date, current_date, current_date + 30)
       where i.id = $1`,
      [id, n],
    );
  }
  return id;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  vi.stubEnv("INVOICE_PAY_LINK_SECRET", "x".repeat(40));
  vi.stubEnv("STRIPE_MODE", "fake");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fake");
  vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_fake");
  ({ loadPayView, startCardPayment } = await import("@/lib/invoices/pay"));
  ({ payLinkToken } = await import("@/lib/stripe/pay-link"));
  ({ FakeStripeGateway } = await import("@/lib/stripe/fake"));

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
     values ($1,'Pay Alpha Ltd','1 Alpha Street'), ($2,'Pay Beta Ltd','2 Beta Road')`,
    [fx.orgA.id, fx.orgB.id],
  );
  const acct = "acct_P" + fx.runId.replaceAll("-", "").slice(0, 16);
  await pool.query(
    `insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by)
     values ($1,$2,true,$3)`,
    [fx.orgA.id, acct, fx.ownerA.userId],
  );
  const { rows: ca } = await pool.query<{ id: string }>(
    `insert into public.companies (organisation_id, name) values ($1,'Pay Customer A') returning id`, [fx.orgA.id]);
  const { rows: cb } = await pool.query<{ id: string }>(
    `insert into public.companies (organisation_id, name) values ($1,'Pay Customer B') returning id`, [fx.orgB.id]);
  number = "PAY-0001"; // the shape invoices_number_check allows
  issued = await invoice(fx.orgA.id, fx.ownerA.userId, ca[0].id, number);
  draft = await invoice(fx.orgA.id, fx.ownerA.userId, ca[0].id, null);
  unlinked = await invoice(fx.orgB.id, fx.ownerB.userId, cb[0].id, "PAYB-0001");
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (fx) await destroyFixtures(fx);
});

const tok = (id: string) => {
  const t = payLinkToken(id);
  if (!t) throw new Error("no token");
  return t;
};

describe("loadPayView", () => {
  it("a valid token for an issued, linked invoice is payable, with the number (the control)", async () => {
    expect(await loadPayView(tok(issued))).toEqual({
      kind: "payable", sellerName: "Pay Alpha Ltd", number, grossMinor: 12000,
    });
  });

  it("a tampered token is refused with no seller", async () => {
    const t = tok(issued);
    expect(await loadPayView(t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA"))).toEqual({ kind: "refused", sellerName: null });
    expect(await loadPayView(issued)).toEqual({ kind: "refused", sellerName: null });
  });

  it("a validly signed random UUID and a draft are refused with no seller", async () => {
    expect(await loadPayView(tok(crypto.randomUUID()))).toEqual({ kind: "refused", sellerName: null });
    expect(await loadPayView(tok(draft))).toEqual({ kind: "refused", sellerName: null });
  });

  it("an issued invoice whose workspace has no Stripe link is refused WITH the seller's name", async () => {
    expect(await loadPayView(tok(unlinked))).toEqual({ kind: "refused", sellerName: "Pay Beta Ltd" });
  });
});

describe("startCardPayment", () => {
  it("redirects to the fake Checkout URL and stamps the session on the counted row", async () => {
    const out = await startCardPayment(tok(issued), ORIGIN);
    expect(out.kind).toBe("redirect");
    if (out.kind !== "redirect") return;
    expect(out.url).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_fake_/);
    const { rows } = await pool.query<{ stripe_session_id: string }>(
      `select stripe_session_id from public.invoice_pay_sessions where invoice_id = $1 and stripe_session_id is not null`,
      [issued],
    );
    expect(out.url.endsWith(rows[0].stripe_session_id)).toBe(true);
  });

  it("hands Stripe the thanks and cancel URLs built from the origin it was given", async () => {
    const spy = vi.spyOn(FakeStripeGateway.prototype, "createCheckoutSession");
    const t = tok(issued);
    await startCardPayment(t, ORIGIN);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: issued, number, grossMinor: 12000,
      successUrl: `${ORIGIN}/pay/${t}/thanks`, cancelUrl: `${ORIGIN}/pay/${t}`,
    }));
    spy.mockRestore();
  });

  it("an unlinked invoice and a tampered token are refused", async () => {
    expect(await startCardPayment(tok(unlinked), ORIGIN)).toEqual({ kind: "refused", sellerName: "Pay Beta Ltd" });
    expect(await startCardPayment(tok(issued) + "x", ORIGIN)).toEqual({ kind: "refused", sellerName: null });
  });

  it("a gateway that throws is unavailable", async () => {
    const spy = vi.spyOn(FakeStripeGateway.prototype, "createCheckoutSession").mockRejectedValue(new Error("stripe down"));
    expect(await startCardPayment(tok(issued), ORIGIN)).toEqual({ kind: "unavailable" });
    spy.mockRestore();
  });

  it("the twenty-first session in an hour is unavailable (rate limit)", async () => {
    const t = tok(issued);
    const { rows } = await pool.query<{ n: string }>(`select count(*) n from public.invoice_pay_sessions where invoice_id = $1`, [issued]);
    for (let i = Number(rows[0].n); i < 20; i += 1) {
      await pool.query(`insert into public.invoice_pay_sessions (organisation_id, invoice_id) values ($1,$2)`, [fx.orgA.id, issued]);
    }
    expect(await startCardPayment(t, ORIGIN)).toEqual({ kind: "unavailable" });
  });
});
