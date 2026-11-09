import "server-only";

import type { StripeEvent } from "@/lib/stripe/client";
import { stripeEnv } from "@/lib/stripe/env";
import { createServiceClient } from "@/lib/supabase/service";

// ===========================================================================
// THE STRIPE WEBHOOK'S LOGIC (invoices part 2 Task 6)
// ===========================================================================
// The route (app/api/stripe/webhook/route.ts) has already verified the
// signature, so this only decides what an authentic event means. One RPC per
// event type, each idempotent on the event id (20261110002000, service_role
// only). Status contract: 500 ONLY when the database call itself failed (Stripe
// then retries); every business outcome, and every event we cannot use, is 200
// so Stripe does not retry what can never succeed.
//
// The event id, account and payment intent come from the event envelope; only
// the invoice id is read from metadata, and it is UUID-checked first. Fields
// are read with narrow guards, and every number is checked BEFORE the RPC: a 0
// or null amount would hit a CHECK constraint, which is a 500 and a retry
// forever. Nothing here logs an account, intent, amount or address.

export interface WebhookResult { status: 200 | 500; outcome: string }

const OK = (outcome: string): WebhookResult => ({ status: 200, outcome });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function handleStripeEvent(event: StripeEvent): Promise<WebhookResult> {
  // Before any RPC, for every type: a test-mode event carries the same acct_ id as a
  // live one, so under a live key it could pay an invoice with no money received.
  const env = stripeEnv();
  if (!env || (event.livemode === true) !== env.live) return OK("ignored");
  const account = typeof event.account === "string" ? event.account : null;
  if (!account) return OK("ignored"); // a platform event: not a workspace's
  // The EVENT's time, not the object's: session.created is when Checkout opened (up to 24 h
  // before payment) and charge.created is the payment, not the refund.
  const { created } = event as { created?: unknown };
  const obj: Record<string, unknown> = (event.data?.object ?? {}) as unknown as Record<string, unknown>;
  const db = createServiceClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
      const invoiceId = metadata.invoice_id;
      const { payment_intent: intent, amount_total: amount, currency } = obj;
      if (
        obj.payment_status !== "paid" || typeof invoiceId !== "string" || !UUID.test(invoiceId) ||
        !str(intent) || !Number.isSafeInteger(amount) || (amount as number) < 0 || !str(currency) || !num(created)
      ) return OK("ignored");
      const { data, error } = await db.rpc("record_stripe_checkout_completed", {
        p_event_id: event.id, p_account: account, p_invoice_id: invoiceId, p_payment_intent: intent,
        p_amount_minor: amount as number, p_currency: currency.toUpperCase(),
        p_paid_at: new Date(created * 1000).toISOString(),
      });
      return rpcResult(error, data);
    }
    case "charge.refunded": {
      const { payment_intent: intent, amount_refunded: refunded } = obj;
      if (!str(intent) || !Number.isSafeInteger(refunded) || (refunded as number) <= 0 || !num(created)) return OK("ignored");
      const { data, error } = await db.rpc("record_stripe_charge_refunded", {
        p_event_id: event.id, p_account: account, p_payment_intent: intent,
        p_refunded_minor: refunded as number, p_refunded_at: new Date(created * 1000).toISOString(),
      });
      return rpcResult(error, data);
    }
    case "account.application.deauthorized": {
      const { data, error } = await db.rpc("stripe_account_deauthorized", { p_event_id: event.id, p_account: account });
      return rpcResult(error, data === true ? "applied" : "duplicate");
    }
    case "account.updated": {
      if (typeof obj.charges_enabled !== "boolean") return OK("ignored");
      const { data, error } = await db.rpc("stripe_account_updated", {
        p_event_id: event.id, p_account: account, p_charges_enabled: obj.charges_enabled,
      });
      return rpcResult(error, data === true ? "applied" : "duplicate");
    }
    default:
      return OK("ignored");
  }
}

function rpcResult(error: { name?: string } | null, outcome: unknown): WebhookResult {
  if (error) {
    console.error("[stripe-webhook] rpc failed"); // no message: it can echo an argument
    return { status: 500, outcome: "error" };
  }
  return OK(typeof outcome === "string" ? outcome : "applied");
}
