import type { Metadata } from "next";
import { PayPage } from "@/components/invoices/pay-page";
import { loadPayView } from "@/lib/invoices/pay";

// Never cached and never indexed: the token in the URL is the credential.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Pay an invoice · GetSetPaid",
  robots: { index: false, follow: false },
};

export default async function PayInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ unavailable?: string | string[] }>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  // Only the literal flag is read; no query value is ever rendered.
  return <PayPage view={await loadPayView(token)} token={token} unavailable={query.unavailable === "1"} />;
}
