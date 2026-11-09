// The development and test stand-in for Stripe (STRIPE_MODE=fake). No network
// call. No "server-only": the e2e support code imports its URL shapes. The
// gateway types come from client.ts as a type-only import, erased at build.
import Stripe from "stripe";
import type { StripeEnv } from "@/lib/stripe/env";
import type { CheckoutInput, StripeGateway } from "@/lib/stripe/client";

const FAKE_CODE = /^fake_code_([A-Za-z0-9_-]{8})$/;

export class FakeStripeGateway implements StripeGateway {
  // A key-only instance: webhooks.constructEvent is pure HMAC, no request.
  private readonly stripe = new Stripe("sk_test_fake");
  constructor(private readonly env: StripeEnv) {}

  authorizeUrl(state: string, redirectUri: string): string {
    return `${redirectUri}?code=fake_code_${state.slice(0, 8)}&state=${state}`;
  }
  async exchangeCode(code: string) {
    const m = FAKE_CODE.exec(code);
    if (!m) throw new Error("fake stripe: unknown code");
    // The code is the first 8 chars of a base64url state: `-` and `_` would fail the database's ^acct_[A-Za-z0-9]+$ check (about 22% of links: 1 - (62/64)^8).
    return { account: `acct_fake${m[1].replace(/[-_]/g, "")}` };
  }
  async chargesEnabled(account: string) {
    return !account.endsWith("_off");
  }
  async deauthorize(account: string) {
    void account; // nothing to revoke: the fake holds no state
  }
  async createCheckoutSession(i: CheckoutInput) {
    const id = `cs_fake_${i.invoiceId.replaceAll("-", "")}`;
    return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
  }
  constructEvent(rawBody: string, signature: string) {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.env.webhookSecret);
  }
}
