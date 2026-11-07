import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayPage } from "@/components/invoices/pay-page";

// The recipient's pay page, as the server renders it (no Testing Library in
// this repo; renderToStaticMarkup is what the other component tests use).
const TOKEN = "11111111-1111-4111-8111-111111111111.abc";

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

describe("PayPage", () => {
  const payable = { kind: "payable", sellerName: "Alpha Promotions Ltd", number: "INV-0007", grossMinor: 123456 } as const;

  it("payable: the number, the seller, the amount through formatGbp, and a POST form to the start route", () => {
    const html = renderToStaticMarkup(<PayPage view={payable} token={TOKEN} />);
    expect(html).toMatch(/<h1[^>]*>Invoice INV-0007<\/h1>/);
    expect(text(html)).toContain("From Alpha Promotions Ltd");
    expect(text(html)).toContain("Amount due £1,234.56");
    expect(html).toMatch(new RegExp(`<form[^>]*method="post"[^>]*action="/pay/${TOKEN}/start"|<form[^>]*action="/pay/${TOKEN}/start"[^>]*method="post"`));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Pay by card<\/button>/);
    expect(text(html)).toContain("GetSetPaid never sees your card details.");
    expect(text(html)).not.toContain("unavailable");
  });

  it("payable with ?unavailable=1: the notice appears above the form", () => {
    const html = renderToStaticMarkup(<PayPage view={payable} token={TOKEN} unavailable />);
    expect(text(html)).toContain("Card payment is unavailable right now. Try again later.");
    expect(html.indexOf("unavailable right now")).toBeLessThan(html.indexOf("<form"));
  });

  it("refused with a seller: names the seller and shows no number, amount or form", () => {
    const html = renderToStaticMarkup(<PayPage view={{ kind: "refused", sellerName: "Alpha Promotions Ltd" }} token={TOKEN} />);
    expect(html).toMatch(/<h1[^>]*>This invoice can’t be paid online<\/h1>/);
    expect(text(html)).toContain("Contact Alpha Promotions Ltd to pay it.");
    expect(text(html)).not.toContain("£");
    expect(html).not.toContain("<form");
  });

  it("refused without a seller: the generic sentence, and still no amount or form", () => {
    const html = renderToStaticMarkup(<PayPage view={{ kind: "refused", sellerName: null }} token={TOKEN} />);
    expect(html).toMatch(/<h1[^>]*>This invoice can’t be paid online<\/h1>/);
    expect(text(html)).toContain("Check the link in your invoice email, or contact whoever sent it.");
    expect(text(html)).not.toContain("£");
    expect(html).not.toContain("<form");
  });

  it("a refusal ignores ?unavailable=1 (nothing to retry)", () => {
    const html = renderToStaticMarkup(<PayPage view={{ kind: "refused", sellerName: null }} token={TOKEN} unavailable />);
    expect(text(html)).not.toContain("unavailable right now");
  });
});
