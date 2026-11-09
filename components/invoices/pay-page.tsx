import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatGbp } from "@/lib/format/money";
import type { PayView } from "@/lib/invoices/pay";

// The recipient's card-payment page (invoices part 2 Task 5). A plain server
// component with a native POST form, so it works without JavaScript. A refusal
// renders no number, no amount and no recipient: the only thing it may say is
// the seller's name, and only when the server gave one.
export function PayPage({
  view,
  token,
  unavailable = false,
}: {
  view: PayView;
  token: string;
  unavailable?: boolean;
}) {
  if (view.kind === "refused") {
    return (
      <div className="flex max-w-prose flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          This invoice can’t be paid online
        </h1>
        <p className="text-base text-ink-muted">
          {view.sellerName
            ? `Contact ${view.sellerName} to pay it.`
            : "Check the link in your invoice email, or contact whoever sent it."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex max-w-prose flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Invoice {view.number}</h1>
        <p className="text-base text-ink-muted">From {view.sellerName}</p>
        <p className="text-xl text-ink">
          Amount due <span className="font-extrabold tabular-nums">{formatGbp(view.grossMinor)}</span>
        </p>
      </div>
      {unavailable ? <Alert tone="error">Card payment is unavailable right now. Try again later.</Alert> : null}
      <form method="post" action={`/pay/${token}/start`} className="flex flex-col gap-3">
        <div>
          <Button type="submit">Pay by card</Button>
        </div>
        <p className="text-sm text-ink-muted">
          You’ll pay on a secure Stripe page. GetSetPaid never sees your card details.
        </p>
      </form>
    </div>
  );
}
