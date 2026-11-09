import "server-only";

import { getStripe } from "@/lib/stripe/client";
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
  | { kind: "unavailable" };

const NOTHING = { kind: "refused", sellerName: null } as const;

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

  let session: { id: string; url: string };
  try {
    session = await gateway.createCheckoutSession({
      account: row.account,
      invoiceId,
      number: row.number,
      grossMinor: Number(row.gross_minor),
      feeMinor: Number(row.fee_minor),
      successUrl: `${origin}/pay/${token}/thanks`,
      cancelUrl: `${origin}/pay/${token}`,
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
