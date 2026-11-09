import "server-only";
// The card-payment link for an invoice, or null when it must not be offered:
// only an ISSUED invoice on a live, charges-enabled Stripe account carries one.
// An unconfigured pay-link secret is "no link"; an unset NEXT_PUBLIC_SITE_URL
// throws, from siteUrl().
import { loadStripeAccount } from "@/lib/invoices/stripe-account";
import { payLinkUrl } from "@/lib/stripe/pay-link";

export async function invoicePayUrl(orgId: string, invoiceId: string, status: string): Promise<string | null> {
  if (status !== "issued") return null;
  const account = await loadStripeAccount(orgId);
  return account?.live && account.chargesEnabled ? payLinkUrl(invoiceId) : null;
}
