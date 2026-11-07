import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/lib/invoices/pdf/render";
import type { InvoiceSnapshot } from "@/lib/invoices/snapshot";

const snapshot: InvoiceSnapshot = {
  number: "INV-0001",
  issueDate: "2026-10-20",
  supplyDate: "2026-10-18",
  dueDate: "2026-11-19",
  currency: "GBP",
  vatRegistered: true,
  seller: {
    name: "Alpha Promotions Ltd",
    address: "1 Alpha Street\nLondon",
    vatNumber: "GB123456789",
    bank: { accountName: "Alpha Promotions Ltd", sortCode: "123456", accountNumber: "12345678" },
  },
  recipient: { kind: "contact", name: "Sam Booker", address: "2 Road\nLeeds", email: "sam@example.test" },
  lines: [
    { position: 1, description: "Headline fee <script>alert(1)</script>", quantity: "1.00", unitPriceMinor: 300000, vatRate: "standard_20", netMinor: 300000, vatMinor: 60000 },
  ],
  totals: { netMinor: 300000, vatMinor: 60000, grossMinor: 360000 },
  notes: "Thanks",
};

describe("renderInvoicePdf", () => {
  it("renders a PDF from a snapshot, hostile text and all", async () => {
    const pdf = await renderInvoicePdf(snapshot, { status: "issued" });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5000);
  });
  it("renders an unregistered seller with no bank details, and a void invoice", async () => {
    const pdf = await renderInvoicePdf(
      { ...snapshot, vatRegistered: false, seller: { ...snapshot.seller, vatNumber: null, bank: null } },
      { status: "void" },
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("renderInvoicePdf: pay by card", () => {
  const payUrl = "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.abc-DEF_123";
  // The page text sits in compressed, subsetted font streams, but a Link is a
  // plain /URI annotation: that is the thing a reader clicks, so that is what is checked.
  const uris = (pdf: Buffer) => [...pdf.toString("latin1").matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]);

  it("carries the pay link as a clickable annotation when payUrl is set", async () => {
    const pdf = await renderInvoicePdf(snapshot, { status: "issued", payUrl });
    expect(uris(pdf)).toEqual([payUrl]);
  });
  it("carries no link without a payUrl", async () => {
    expect(uris(await renderInvoicePdf(snapshot, { status: "issued" }))).toEqual([]);
    expect(uris(await renderInvoicePdf(snapshot, { status: "issued", payUrl: null }))).toEqual([]);
  });
});
