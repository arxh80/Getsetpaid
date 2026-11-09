import "server-only";
// THE ONE SEAM TO STRIPE. Every call the product makes is a method here, so
// the fake (lib/stripe/fake.ts) can stand in for all of them. Standard
// accounts, direct charges: we act on the workspace's account with the
// platform key plus the Stripe-Account header; no OAuth token is ever kept.
import Stripe from "stripe";
import { stripeEnv, type StripeEnv } from "@/lib/stripe/env";
import { FakeStripeGateway } from "@/lib/stripe/fake";
import { INVOICE_ID_METADATA_KEY } from "@/lib/stripe/metadata";

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
  constructEvent(rawBody: string, signature: string): StripeEvent;   // throws on a bad signature
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
    // No retry: Stripe counts a retried exchange as a second use of the code and revokes the link.
    const token = await this.stripe.oauth.token({ grant_type: "authorization_code", code }, { maxNetworkRetries: 0 });
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
        allowed_payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: i.grossMinor, product_data: { name: `Invoice ${i.number}` } } }],
        payment_intent_data: { application_fee_amount: i.feeMinor, metadata: { [INVOICE_ID_METADATA_KEY]: i.invoiceId } },
        metadata: { [INVOICE_ID_METADATA_KEY]: i.invoiceId },
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
