import { Alert } from "@/components/ui/alert";
import { formatDate } from "@/lib/format/date";
import { formatGbp } from "@/lib/format/money";

export interface CardPaymentRow {
  amountMinor: number;
  outcome: "applied" | "after_paid" | "after_void";
  receivedAt: string;
  refundedMinor: number;
  refundedAt: string | null;
}

// What Stripe did to this invoice, from invoice_card_payments. `applied` is the
// payment that paid it; the two conflict outcomes are money that arrived when
// the invoice could take none, so they alert and say what to do (the money
// stays in Stripe until the workspace refunds it there).
export function CardPaymentNotices({ payments }: { payments: readonly CardPaymentRow[] }) {
  if (payments.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 tabular-nums">
      {payments.map((p, i) => {
        const date = formatDate(p.receivedAt);
        const amount = formatGbp(p.amountMinor);
        const refund =
          p.refundedMinor > 0 && p.refundedAt ? ` Refunded in Stripe: ${formatGbp(p.refundedMinor)} on ${formatDate(p.refundedAt)}.` : "";
        return p.outcome === "applied" ? (
          <Alert key={i} tone="success">{`Paid by card on ${date} (${amount}).${refund}`}</Alert>
        ) : (
          <Alert key={i} tone="error">
            {`A card payment of ${amount} arrived on ${date} after this invoice was already ${p.outcome === "after_paid" ? "paid" : "voided"}. Refund it in Stripe.${refund}`}
          </Alert>
        );
      })}
    </div>
  );
}
