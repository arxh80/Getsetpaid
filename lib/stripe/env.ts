import "server-only";
// THE ONLY READER OF THE STRIPE VARIABLES (tests/unit/security/stripe-env-readers.test.ts).
// STRIPE_MODE=fake selects lib/stripe/fake.ts for development and tests; under
// NODE_ENV=production it is refused (card payments read as unconfigured), the
// malware scanner's rule: a typo must never downgrade production to a stub.
// `live` is the key's Stripe mode (sk_live_/rk_live_), not `mode`: the webhook ignores
// every event whose livemode differs (a Connect endpoint receives both modes' events).
// The fake is test mode.
export interface StripeEnv { mode: "live" | "fake"; live: boolean; secretKey: string; webhookSecret: string; connectClientId: string }

// The .env.example placeholders (public, in the repo): a production deployment that
// copied the file reads as unconfigured, never as configured with known secrets.
const PLACEHOLDERS = new Set([
  "sk_test_fake_not_a_real_key",
  "whsec_fake_local_webhook_secret_0123456789",
  "ca_fake_local_client",
  "local-pay-link-secret-not-for-production-0123",
]);

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw || (process.env.NODE_ENV === "production" && PLACEHOLDERS.has(raw))) return null;
  return raw;
}

export function stripeEnv(): StripeEnv | null {
  const mode = value("STRIPE_MODE") === "fake" ? "fake" : "live";
  if (mode === "fake" && process.env.NODE_ENV === "production") return null;
  const secretKey = value("STRIPE_SECRET_KEY");
  const webhookSecret = value("STRIPE_WEBHOOK_SECRET");
  const connectClientId = value("STRIPE_CONNECT_CLIENT_ID");
  if (!secretKey || !webhookSecret || !connectClientId) return null;
  const live = mode === "live" && /^[sr]k_live_/.test(secretKey);
  return { mode, live, secretKey, webhookSecret, connectClientId };
}

export function payLinkSecret(): Buffer | null {
  const raw = value("INVOICE_PAY_LINK_SECRET");
  return raw && Buffer.byteLength(raw) >= 32 ? Buffer.from(raw) : null;
}
