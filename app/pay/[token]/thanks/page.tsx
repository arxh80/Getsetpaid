import type { Metadata } from "next";
import { loadPayView } from "@/lib/invoices/pay";

// Where Stripe returns the payer. It changes nothing and proves nothing: the
// invoice is marked paid by the webhook, never by someone arriving here.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Payment received · GetSetPaid",
  robots: { index: false, follow: false },
};

export default async function PayThanksPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { sellerName } = await loadPayView(token);
  return (
    <div className="flex max-w-prose flex-col gap-3">
      <h1 className="tracking-display text-3xl font-extrabold text-ink">Payment received — thank you.</h1>
      <p className="text-base text-ink-muted">
        {sellerName ?? "The seller"} will see it on their invoice shortly. You can close this page.
      </p>
    </div>
  );
}
