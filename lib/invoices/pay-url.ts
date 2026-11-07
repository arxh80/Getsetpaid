import "server-only";
// The card-payment link for an invoice, or null when it must not be offered:
// only an ISSUED invoice on a live, charges-enabled Stripe account carries one,
// and an unconfigured secret/site URL is "no link", never a throw.
import { loadStripeAccount } from "@/lib/invoices/stripe-account";
import { payLinkUrl } from "@/lib/stripe/pay-link";

export async function invoicePayUrl(orgId: string, invoiceId: string, status: string): Promise<string | null> {
  if (status !== "issued") return null;
  const account = await loadStripeAccount(orgId);
  return account?.live && account.chargesEnabled ? payLinkUrl(invoiceId) : null;
}
