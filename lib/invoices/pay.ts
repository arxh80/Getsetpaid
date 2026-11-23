import "server-only";

import { createHash } from "node:crypto";
import { getStripe, type CheckoutInput } from "@/lib/stripe/client";
import { verifyPayLinkToken } from "@/lib/stripe/pay-link";
import { createServiceClient } from "@/lib/supabase/service";

// ===========================================================================
// THE CARD-PAYMENT PAGE'S LOGIC (invoices part 2 Task 5)
// ===========================================================================
// The recipient has no account, so there is no session and no RLS: the
// credential is the signed token (lib/stripe/pay-link.ts), checked FIRST, with
// no database call when it fails. Everything after that goes through three
// RPCs granted to service_role alone (20261110002000), each taking an invoice
// id and nothing about a user. Every refusal is one of two shapes, so the page
// cannot be used to learn whether an invoice exists: an unknown, draft or
// badly-signed link says nothing; a known-but-unpayable one names the seller.

export type PayView =
  | { kind: "payable"; sellerName: string; number: string; grossMinor: number }
  | { kind: "refused"; sellerName: string | null };

export type StartOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "refused"; sellerName: string | null }
  | { kind: "already_paid" }
  | { kind: "unavailable" };

const NOTHING = { kind: "refused", sellerName: null } as const;

/**
 * Two clicks that arrive together both see no stamped session yet, so both
 * would create one. With the same key Stripe returns the first one's session
 * instead (and the SDK retries the 409 it gives while the first is in flight).
 * The key covers every parameter, so a changed fee is a new session rather
 * than an idempotency error, and the previous session id, so the first click
 * after that session expires gets a fresh one. It also covers the minute:
 * Stripe replays a cached 500 for 24 hours, so a key without one would turn a
 * single Stripe failure into a day with no card payment for this invoice.
 * shortcut: two clicks a second apart that straddle a minute boundary still
 * get two sessions; the webhook's after_paid row and "Refund it in Stripe"
 * remain the backstop.
 */
export function checkoutIdempotencyKey(
  input: Omit<CheckoutInput, "idempotencyKey">,
  previousStripeSessionId: string | null,
  nowMs: number = Date.now(),
): string {
  const parts = [
    input.account, input.invoiceId, input.number, input.grossMinor, input.feeMinor,
    input.successUrl, input.cancelUrl, input.expiresAt, previousStripeSessionId, Math.floor(nowMs / 60_000),
  ];
  return `checkout-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/**
 * A session stays payable for an hour, not Stripe's default 24, so a link
 * opened before the invoice is voided or the account is disconnected stops
 * taking money soon after. Taken from the key's own minute: a retry inside
 * that minute must send the same body, or Stripe rejects the reused key.
 */
export function checkoutExpiresAt(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60 + 60 * 60;
}

export async function loadPayView(token: string): Promise<PayView> {
  const invoiceId = verifyPayLinkToken(token);
  if (!invoiceId) return NOTHING;
  const { data, error } = await createServiceClient().rpc("invoice_pay_page", { p_invoice_id: invoiceId });
  const row = data?.[0];
  if (error || !row) {
    if (error) console.error("[pay] invoice_pay_page failed:", error.message);
    return NOTHING;
  }
  if (row.payable && row.seller_name && row.number && row.gross_minor !== null) {
    return { kind: "payable", sellerName: row.seller_name, number: row.number, grossMinor: Number(row.gross_minor) };
  }
  return { kind: "refused", sellerName: row.seller_name };
}

export async function startCardPayment(token: string, origin: string): Promise<StartOutcome> {
  const invoiceId = verifyPayLinkToken(token);
  if (!invoiceId) return NOTHING;
  const gateway = getStripe();
  if (!gateway) return { kind: "unavailable" };

  const service = createServiceClient();
  const { data, error } = await service.rpc("begin_invoice_card_payment", { p_invoice_id: invoiceId });
  if (error) {
    if (error.hint === "invoice_not_payable_online") {
      return { kind: "refused", sellerName: (await loadPayView(token)).sellerName };
    }
    if (error.hint !== "invoice_pay_rate_limited") console.error("[pay] begin_invoice_card_payment failed:", error.message);
    return { kind: "unavailable" };
  }
  const row = data?.[0];
  if (!row) return { kind: "unavailable" };

  // One payable session at a time: a second click or tab goes back to the
  // open one, so the payer cannot pay twice. Only a session Stripe says it
  // does not have (an account relinked since) is replaced; any other failure
  // to read it is a try-again, since that session may still be open and
  // payable, and a second one beside it is how a payer pays twice.
  if (row.previous_stripe_session_id) {
    let previous;
    try {
      previous = await gateway.checkoutSession(row.account, row.previous_stripe_session_id);
    } catch (e) {
      console.error("[pay] the earlier Checkout Session could not be read:", e instanceof Error ? e.message : "unknown");
      return { kind: "unavailable" };
    }
    if (!previous) console.error("[pay] Stripe has no earlier Checkout Session on this account; making a new one");
    else if (previous.status === "complete") return { kind: "already_paid" };
    else if (previous.status === "open" && previous.url) return { kind: "redirect", url: previous.url };
  }

  const nowMs = Date.now();
  const input = {
    account: row.account,
    invoiceId,
    number: row.number,
    grossMinor: Number(row.gross_minor),
    feeMinor: Number(row.fee_minor),
    successUrl: `${origin}/pay/${token}/thanks`,
    cancelUrl: `${origin}/pay/${token}`,
    expiresAt: checkoutExpiresAt(nowMs),
  };
  let session: { id: string; url: string };
  try {
    session = await gateway.createCheckoutSession({
      ...input,
      idempotencyKey: checkoutIdempotencyKey(input, row.previous_stripe_session_id ?? null, nowMs),
    });
  } catch (e) {
    console.error("[pay] Stripe refused to create a Checkout Session:", e instanceof Error ? e.message : "unknown");
    return { kind: "unavailable" };
  }

  // The session exists at Stripe whether or not this stamp lands, and the
  // webhook books by the invoice id in its metadata, so a failed stamp is
  // logged and the payer is still sent on.
  const { error: attachError } = await service.rpc("attach_invoice_pay_session", {
    p_pay_session_id: row.pay_session_id,
    p_stripe_session_id: session.id,
  });
  if (attachError) console.error("[pay] attach_invoice_pay_session failed:", attachError.message);
  return { kind: "redirect", url: session.url };
}
