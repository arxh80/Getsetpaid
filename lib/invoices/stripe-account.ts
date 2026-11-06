import "server-only";
// The workspace's Stripe link, as the settings page may see it. Read through
// the caller's own RLS (view_finance); the account id is selected nowhere, so
// it cannot reach a page or a prop.
import { createClient } from "@/lib/supabase/server";
import { INVOICE_REFUSAL_SENTENCES } from "@/lib/invoices/refusals";

export interface StripeAccountView {
  live: boolean;
  chargesEnabled: boolean;
  linkedAt: string | null;
  /** When an ended link ended; null while live. */
  endedAt: string | null;
}

export async function loadStripeAccount(orgId: string): Promise<StripeAccountView | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoice_stripe_accounts")
    .select("charges_enabled, linked_at, ended_at")
    .eq("organisation_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[invoices] stripe account lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  return {
    live: data.ended_at === null,
    chargesEnabled: data.charges_enabled === true,
    linkedAt: data.linked_at,
    endedAt: data.ended_at,
  };
}

/** The application fee in basis points (Q279), through its RPC; the table is closed to clients. */
export async function loadStripeFeeBps(): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stripe_application_fee_bps");
  if (error || typeof data !== "number") {
    if (error) console.error("[invoices] stripe fee lookup failed:", error.message);
    return null;
  }
  return data;
}

export interface StripeReturnNotice {
  tone: "success" | "error" | "info";
  text: string;
}

/**
 * The callback's `?stripe=` value -> the page's sentence. An ALLOWLIST: the raw
 * query value is never echoed. `linked`, `cancelled` and `failed` are the
 * route's own; any other key is a refusal hint, and only the ones the invoice
 * refusals already name are sentences.
 */
export function stripeReturnNotice(value: string | undefined): StripeReturnNotice | null {
  if (value === undefined) return null;
  if (value === "linked") return { tone: "success", text: "Stripe account connected. Your invoices can now be paid by card." };
  if (value === "cancelled") return { tone: "info", text: "Stripe connection cancelled. Nothing was changed." };
  if (value === "failed") return { tone: "error", text: "We couldn’t connect your Stripe account. Nothing was changed. Try again from here." };
  if (Object.hasOwn(INVOICE_REFUSAL_SENTENCES, value)) return { tone: "error", text: INVOICE_REFUSAL_SENTENCES[value] };
  return null;
}
