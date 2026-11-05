import { describe, expect, it } from "vitest";
import { INVOICE_LIST, mapInvoiceRow } from "@/lib/invoices/list";

describe("INVOICE_LIST", () => {
  it("sorts newest first on the covering index, and filters by the four statuses", () => {
    expect(INVOICE_LIST.sort.created.backedBy).toBe("invoices_org_created_id_idx");
    expect(INVOICE_LIST.sort.created.defaultDirection).toBe("desc");
    expect(INVOICE_LIST.filters.status.choices.map((c) => c.value)).toEqual(["any", "draft", "issued", "paid", "void"]);
  });
  it("maps the recipient from whichever of company or contact is set", () => {
    const base = { id: "i", status: "issued", number: "INV-0001", gross_minor: 360000, issue_date: "2026-10-20", due_date: "2026-11-19", created_at: "2026-10-20T10:00:00Z" };
    expect(mapInvoiceRow({ ...base, company: { name: "Acme" }, contact: null }).recipientName).toBe("Acme");
    expect(mapInvoiceRow({ ...base, company: null, contact: { name: "Sam" } }).recipientName).toBe("Sam");
    expect(mapInvoiceRow({ ...base, company: null, contact: null }).recipientName).toBeNull();
  });
});
