import { describe, expect, it } from "vitest";
import { parseSnapshot } from "@/lib/invoices/snapshot";

const valid = {
  version: 1,
  number: "INV-0001",
  issue_date: "2026-10-20",
  supply_date: "2026-10-18",
  due_date: "2026-11-19",
  currency: "GBP",
  seller: {
    name: "Alpha Promotions Ltd",
    address: "1 Alpha Street\nLondon",
    vat_number: "GB123456789",
    bank: { account_name: "Alpha Promotions Ltd", sort_code: "123456", account_number: "12345678" },
  },
  recipient: { kind: "contact", name: "Sam Booker", address: "2 Road", email: "sam@example.test" },
  lines: [
    { position: 1, description: "Headline fee", quantity: "1.00", unit_price_minor: 300000, vat_rate: "standard_20", net_minor: 300000, vat_minor: 60000 },
  ],
  totals: { net_minor: 300000, vat_minor: 60000, gross_minor: 360000 },
  notes: null,
};

describe("parseSnapshot", () => {
  it("reads a well-formed snapshot", () => {
    const s = parseSnapshot(valid);
    expect(s?.number).toBe("INV-0001");
    expect(s?.seller.bank?.sortCode).toBe("123456");
    expect(s?.lines[0].vatRate).toBe("standard_20");
    expect(s?.totals.grossMinor).toBe(360000);
    expect(s?.vatRegistered).toBe(true);
  });

  it("reads an unregistered seller with no bank details", () => {
    const s = parseSnapshot({ ...valid, seller: { ...valid.seller, vat_number: null, bank: null } });
    expect(s?.vatRegistered).toBe(false);
    expect(s?.seller.bank).toBeNull();
  });

  it("refuses anything malformed rather than rendering half an invoice", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ ...valid, version: 2 })).toBeNull();
    expect(parseSnapshot({ ...valid, number: "../../etc" })).toBeNull();
    expect(parseSnapshot({ ...valid, lines: [{ ...valid.lines[0], vat_rate: "bogus" }] })).toBeNull();
    expect(parseSnapshot({ ...valid, totals: { net_minor: 1, vat_minor: 0, gross_minor: 2 } })).toBeNull();
    expect(parseSnapshot({ ...valid, recipient: { ...valid.recipient, kind: "other" } })).toBeNull();
  });
});
