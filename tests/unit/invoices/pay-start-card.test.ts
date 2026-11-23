// lib/invoices/pay.ts startCardPayment with an earlier session stamped: a
// session that may still be open must never get a second one beside it, or
// the payer can pay twice. Only "Stripe has no such session" makes a new one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ checkoutSession: vi.fn(), createCheckoutSession: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/stripe/pay-link", () => ({ verifyPayLinkToken: () => "11111111-1111-1111-1111-111111111111" }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({ checkoutSession: m.checkoutSession, createCheckoutSession: m.createCheckoutSession }),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: m.rpc }) }));

import { startCardPayment } from "@/lib/invoices/pay";

const ROW = {
  account: "acct_seller", number: "INV-0007", gross_minor: 12000, fee_minor: 120,
  pay_session_id: "22222222-2222-2222-2222-222222222222", previous_stripe_session_id: "cs_old",
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.rpc.mockImplementation(async (name: string) =>
    name === "begin_invoice_card_payment" ? { data: [ROW], error: null } : { data: null, error: null });
  m.createCheckoutSession.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.test/cs_new" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("startCardPayment with an earlier Checkout Session", () => {
  it("a failed read (an outage, a network error) is a try-again and makes no new session", async () => {
    m.checkoutSession.mockRejectedValue(new Error("api_error: 503"));
    await expect(startCardPayment("t", "https://app.test")).resolves.toEqual({ kind: "unavailable" });
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("CONTROL: a session Stripe does not have is replaced by a new one", async () => {
    m.checkoutSession.mockResolvedValue(null);
    await expect(startCardPayment("t", "https://app.test")).resolves.toEqual({
      kind: "redirect", url: "https://checkout.stripe.test/cs_new",
    });
    expect(m.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("an open session sends the payer back to it", async () => {
    m.checkoutSession.mockResolvedValue({ status: "open", url: "https://checkout.stripe.test/cs_old" });
    await expect(startCardPayment("t", "https://app.test")).resolves.toEqual({
      kind: "redirect", url: "https://checkout.stripe.test/cs_old",
    });
    expect(m.createCheckoutSession).not.toHaveBeenCalled();
  });
});
