import type { InvoiceSnapshot } from "@/lib/invoices/snapshot";
import { VAT_RATE_LABELS } from "@/lib/invoices/arithmetic";
import { formatGbp } from "@/lib/format/money";
import { formatDateOnly } from "@/lib/format/date";

// The issued invoice, read-only, rendered ONLY from its snapshot -- the same
// source as the PDF, so the screen and the paper cannot disagree.
export function InvoiceView({ snapshot: s }: { snapshot: InvoiceSnapshot }) {
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">From</dt>
          <dd className="whitespace-pre-line text-base text-ink">
            {s.seller.name}{"\n"}{s.seller.address}{s.seller.vatNumber ? `\nVAT ${s.seller.vatNumber}` : ""}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">To</dt>
          <dd className="whitespace-pre-line text-base text-ink">{s.recipient.name}{"\n"}{s.recipient.address}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Issued</dt>
          <dd className="text-base text-ink tabular-nums">{formatDateOnly(s.issueDate)}</dd>
        </div>
        {s.supplyDate !== s.issueDate ? (
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Supply date</dt>
            <dd className="text-base text-ink tabular-nums">{formatDateOnly(s.supplyDate)}</dd>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Due</dt>
          <dd className="text-base text-ink tabular-nums">{formatDateOnly(s.dueDate)}</dd>
        </div>
      </dl>

      <div role="region" aria-label="Invoice lines" tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-rule text-left text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
              <th scope="col" className="py-2 pr-4">Description</th>
              <th scope="col" className="py-2 pr-4 text-right">Qty</th>
              <th scope="col" className="py-2 pr-4 text-right">Unit price</th>
              {s.vatRegistered ? <th scope="col" className="py-2 pr-4">VAT</th> : null}
              <th scope="col" className="py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.position} className="border-b border-rule">
                <td className="py-2 pr-4 text-ink">{l.description}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{l.quantity}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(l.unitPriceMinor)}</td>
                {s.vatRegistered ? <td className="py-2 pr-4">{VAT_RATE_LABELS[l.vatRate]}</td> : null}
                <td className="py-2 text-right tabular-nums">{formatGbp(l.netMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-y-1 text-base tabular-nums">
        <dt className="text-ink-muted">Net</dt>
        <dd className="text-right">{formatGbp(s.totals.netMinor)}</dd>
        {s.vatRegistered ? (
          <>
            <dt className="text-ink-muted">VAT</dt>
            <dd className="text-right">{formatGbp(s.totals.vatMinor)}</dd>
          </>
        ) : null}
        <dt className="font-bold text-ink">Total</dt>
        <dd className="text-right font-bold text-ink">{formatGbp(s.totals.grossMinor)}</dd>
      </dl>

      <section aria-labelledby="pay-heading" className="flex flex-col gap-2 border-t border-rule pt-6">
        <h2 id="pay-heading" className="text-xl font-bold text-ink">How to pay</h2>
        {s.seller.bank ? (
          <p className="text-base text-ink tabular-nums">
            Bank transfer to {s.seller.bank.accountName}, sort code {s.seller.bank.sortCode}, account {s.seller.bank.accountNumber}, quoting {s.number}.
          </p>
        ) : (
          <p className="text-base text-ink-muted">No bank details were set when this invoice was issued.</p>
        )}
        {s.notes ? <p className="whitespace-pre-line text-base text-ink-muted">{s.notes}</p> : null}
      </section>
    </div>
  );
}
