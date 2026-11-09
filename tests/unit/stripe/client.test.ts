import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStripe } from "@/lib/stripe/client";
import { INVOICE_ID_METADATA_KEY } from "@/lib/stripe/metadata";

// THE LIVE GATEWAY'S MONEY-MOVING PARAMETERS (final review F2/F4). Every other
// suite swaps in FakeStripeGateway, so these calls were pinned by nothing: the
// Stripe-Account header (the direct charge lands on the seller's account), the
// fee, amount and currency, the metadata key the webhook reads, and no retry on
// the OAuth exchange (a second use of a code revokes the connection).
const sdk = vi.hoisted(() => ({ ctor: vi.fn(), create: vi.fn(), token: vi.fn(), deauthorize: vi.fn() }));
vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { create: sdk.create } };
    oauth = { token: sdk.token, deauthorize: sdk.deauthorize };
    constructor(...args: unknown[]) {
      sdk.ctor(...args);
    }
  },
}));

const INVOICE = "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a10";

beforeEach(() => {
  for (const f of Object.values(sdk)) f.mockReset();
  vi.stubEnv("STRIPE_MODE", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_platform");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_live");
  vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_platform");
});
afterEach(() => vi.unstubAllEnvs());

describe("the live Stripe gateway", () => {
  it("builds the SDK with the platform key, one network retry and a 15 s timeout", () => {
    getStripe();
    expect(sdk.ctor.mock.calls).toEqual([["sk_live_platform", { maxNetworkRetries: 1, timeout: 15_000 }]]);
  });

  it("creates the Checkout as a direct charge on the seller's account, with the fee and the namespaced metadata key", async () => {
    sdk.create.mockResolvedValue({ id: "cs_live_1", url: "https://checkout.stripe.com/c/pay/cs_live_1" });
    const out = await getStripe()!.createCheckoutSession({
      account: "acct_seller", invoiceId: INVOICE, number: "INV-0007", grossMinor: 12000, feeMinor: 120,
      successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no",
    });
    expect(INVOICE_ID_METADATA_KEY).toBe("getsetpaid_invoice_id");
    expect(sdk.create.mock.calls).toEqual([[
      {
        mode: "payment",
        allowed_payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: 12000, product_data: { name: "Invoice INV-0007" } } }],
        payment_intent_data: { application_fee_amount: 120, metadata: { getsetpaid_invoice_id: INVOICE } },
        metadata: { getsetpaid_invoice_id: INVOICE },
        success_url: "https://app.test/ok",
        cancel_url: "https://app.test/no",
      },
      { stripeAccount: "acct_seller" },
    ]]);
    expect(out).toEqual({ id: "cs_live_1", url: "https://checkout.stripe.com/c/pay/cs_live_1" });
  });

  it("exchanges the OAuth code once, with retries off for that one call", async () => {
    sdk.token.mockResolvedValue({ stripe_user_id: "acct_new" });
    await expect(getStripe()!.exchangeCode("ac_code")).resolves.toEqual({ account: "acct_new" });
    expect(sdk.token.mock.calls).toEqual([[{ grant_type: "authorization_code", code: "ac_code" }, { maxNetworkRetries: 0 }]]);
  });

  it("deauthorizes the account under the platform's client id", async () => {
    sdk.deauthorize.mockResolvedValue({ stripe_user_id: "acct_old" });
    await getStripe()!.deauthorize("acct_old");
    expect(sdk.deauthorize.mock.calls).toEqual([[{ client_id: "ca_platform", stripe_user_id: "acct_old" }]]);
  });
});
