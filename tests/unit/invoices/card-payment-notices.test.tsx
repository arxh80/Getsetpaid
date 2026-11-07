import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardPaymentNotices, type CardPaymentRow } from "@/components/invoices/card-payment-notices";

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const base: CardPaymentRow = {
  amountMinor: 123456,
  outcome: "applied",
  receivedAt: "2026-11-03T23:30:00.000Z", // 23:30 UTC on 3 Nov is 23:30 London (GMT)
  refundedMinor: 0,
  refundedAt: null,
};
const render = (...rows: Partial<CardPaymentRow>[]) =>
  renderToStaticMarkup(<CardPaymentNotices payments={rows.map((r) => ({ ...base, ...r }))} />);

describe("CardPaymentNotices", () => {
  it("renders nothing without a card payment", () => {
    expect(renderToStaticMarkup(<CardPaymentNotices payments={[]} />)).toBe("");
  });

  it("applied: 'Paid by card on <date> (<amount>).' and no alert", () => {
    const html = render({});
    expect(text(html)).toContain("Paid by card on 03 Nov 2026 (£1,234.56).");
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain("Refunded");
  });

  it("reads the date in UK local time, not UTC", () => {
    // 23:30 UTC on 30 Jun is 00:30 on 1 Jul in London (BST).
    expect(text(render({ receivedAt: "2026-06-30T23:30:00.000Z" }))).toContain("Paid by card on 01 Jul 2026");
  });

  it("after_paid: a role=alert in the danger token telling the user to refund it in Stripe", () => {
    const html = render({ outcome: "after_paid" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(text(html)).toContain(
      "A card payment of £1,234.56 arrived on 03 Nov 2026 after this invoice was already paid. Refund it in Stripe.",
    );
  });

  it("after_void: the same, with 'voided'", () => {
    const html = render({ outcome: "after_void" });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(
      "A card payment of £1,234.56 arrived on 03 Nov 2026 after this invoice was already voided. Refund it in Stripe.",
    );
  });

  it("a refund adds 'Refunded in Stripe: <amount> on <date>.' to any outcome", () => {
    const refund = { refundedMinor: 5000, refundedAt: "2026-11-05T10:00:00.000Z" };
    for (const outcome of ["applied", "after_paid", "after_void"] as const) {
      expect(text(render({ outcome, ...refund }))).toContain("Refunded in Stripe: £50.00 on 05 Nov 2026.");
    }
  });

  it("one notice per payment, in order", () => {
    const t = text(render({ outcome: "applied" }, { outcome: "after_paid", amountMinor: 100 }));
    expect(t.indexOf("Paid by card")).toBeLessThan(t.indexOf("A card payment of £1.00"));
  });
});
