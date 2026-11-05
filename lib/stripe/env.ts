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
