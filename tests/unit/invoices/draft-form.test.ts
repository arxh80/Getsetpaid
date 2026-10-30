import { describe, expect, it } from "vitest";
import { readDraftForm } from "@/lib/invoices/draft-form";

const CONTACT = "11111111-2222-4333-8444-555555555555";
const ENTRY = "99999999-2222-4333-8444-555555555555";

function form(top: Record<string, string>, lines: Record<string, string>[]): FormData {
  const d = new FormData();
  for (const [k, v] of Object.entries(top)) d.set(k, v);
  for (const l of lines) {
    d.append("line_description", l.description ?? "");
    d.append("line_quantity", l.quantity ?? "");
    d.append("line_unit_price", l.unitPrice ?? "");
    d.append("line_vat_rate", l.vatRate ?? "");
    d.append("line_entry_id", l.entryId ?? "");
  }
  return d;
}

describe("readDraftForm", () => {
  it("reads the recipient, the event and the lines, normalising quantity and price", () => {
    const r = readDraftForm(form(
      { recipient: `contact:${CONTACT}`, eventId: "", recipientAddress: " 1 Road\nLondon ", supplyDate: "2026-10-18", notes: "" },
      [
        { description: "Guarantee", quantity: "1", unitPrice: "3,000", vatRate: "standard_20", entryId: ENTRY },
        { description: "Production", quantity: "2.5", unitPrice: "£150.00", vatRate: "none" },
      ],
    ));
    expect(r).toEqual({
      ok: true,
      draft: {
        recipient: { kind: "contact", id: CONTACT },
        eventId: null,
        recipientAddress: "1 Road\nLondon",
        supplyDate: "2026-10-18",
        notes: null,
        lines: [
          { description: "Guarantee", quantity: "1.00", unitPriceMinor: 300000, vatRate: "standard_20", financialEntryId: ENTRY },
          { description: "Production", quantity: "2.50", unitPriceMinor: 15000, vatRate: "none", financialEntryId: null },
        ],
      },
    });
  });

  it("a draft may have no recipient and no lines yet", () => {
    const r = readDraftForm(form({ recipient: "" }, []));
    expect(r.ok && r.draft).toMatchObject({ recipient: null, lines: [] });
  });

  it("keys each line's error by its index and field", () => {
    const r = readDraftForm(form({ recipient: "" }, [
      { description: "", quantity: "0", unitPrice: "-1", vatRate: "standard" },
    ]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(
      ["line_0_description", "line_0_quantity", "line_0_unit_price", "line_0_vat_rate"].sort(),
    );
  });

  it("refuses a forged recipient, a forged entry id, an impossible date and 101 lines", () => {
    expect(readDraftForm(form({ recipient: "company:not-a-uuid" }, [])).ok).toBe(false);
    expect(readDraftForm(form({ recipient: "" }, [{ description: "x", quantity: "1", unitPrice: "1", vatRate: "none", entryId: "'; drop" }])).ok).toBe(false);
    expect(readDraftForm(form({ recipient: "", supplyDate: "2026-02-31" }, [])).ok).toBe(false);
    const many = Array.from({ length: 101 }, () => ({ description: "x", quantity: "1", unitPrice: "1", vatRate: "none" }));
    expect(readDraftForm(form({ recipient: "" }, many)).ok).toBe(false);
  });

  it("refuses ragged line arrays (a tampered form) as a whole", () => {
    const d = form({ recipient: "" }, [{ description: "x", quantity: "1", unitPrice: "1", vatRate: "none" }]);
    d.append("line_description", "orphan");
    expect(readDraftForm(d).ok).toBe(false);
  });
});
