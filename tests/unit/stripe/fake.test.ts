import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { FakeStripeGateway } from "@/lib/stripe/fake";

const ENV = { mode: "fake" as const, live: false, secretKey: "sk_test_fake", webhookSecret: "whsec_fake_secret", connectClientId: "ca_fake" };
const INVOICE = "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a10";

describe("FakeStripeGateway", () => {
  const fake = new FakeStripeGateway(ENV);

  it("sends the OAuth round trip straight back to the redirect", () => {
    expect(fake.authorizeUrl("abcd1234zzzz", "https://app.test/cb")).toBe(
      "https://app.test/cb?code=fake_code_abcd1234&state=abcd1234zzzz",
    );
  });
  it("exchanges only a fake code", async () => {
    await expect(fake.exchangeCode("fake_code_abcd1234")).resolves.toEqual({ account: "acct_fakeabcd1234" });
    await expect(fake.exchangeCode("fake_code_a-b_c123")).resolves.toEqual({ account: "acct_fakeabc123" });
    await expect(fake.exchangeCode("real_code")).rejects.toThrow();
  });
  it("reports charges enabled unless the account ends in _off", async () => {
    await expect(fake.chargesEnabled("acct_fakeabcd1234")).resolves.toBe(true);
    await expect(fake.chargesEnabled("acct_fake_off")).resolves.toBe(false);
  });
  it("deauthorizes without a network call", async () => {
    await expect(fake.deauthorize("acct_fakeabcd1234")).resolves.toBeUndefined();
  });
  it("makes a checkout session keyed on the invoice", async () => {
    const s = await fake.createCheckoutSession({
      account: "acct_fakeabcd1234", invoiceId: INVOICE, number: "INV-1", grossMinor: 12000, feeMinor: 120,
      successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no",
    });
    const id = `cs_fake_${INVOICE.replaceAll("-", "")}`;
    expect(s).toEqual({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
  });
  it("verifies a webhook signature with the real algorithm", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed" });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: ENV.webhookSecret });
    expect(fake.constructEvent(payload, header).id).toBe("evt_1");
    const wrong = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect(() => fake.constructEvent(payload, wrong)).toThrow();
  });
});
