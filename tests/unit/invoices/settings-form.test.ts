import { describe, expect, it } from "vitest";
import { readSettingsForm } from "@/lib/invoices/settings-form";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
const good = {
  businessName: "Alpha Promotions Ltd",
  businessAddress: "1 Alpha Street\nLondon",
  vatNumber: "gb 123 4567 89",
  bankAccountName: "Alpha Promotions Ltd",
  bankSortCode: "12-34-56",
  bankAccountNumber: "1234 5678",
  numberPrefix: "inv-",
  paymentTermsDays: "30",
};

describe("readSettingsForm", () => {
  it("normalises what a person types: VAT upper-cased without spaces, sort code digits only, prefix upper-cased", () => {
    const r = readSettingsForm(form(good));
    expect(r).toEqual({
      ok: true,
      values: {
        businessName: "Alpha Promotions Ltd",
        businessAddress: "1 Alpha Street\nLondon",
        vatNumber: "GB123456789",
        bankAccountName: "Alpha Promotions Ltd",
        bankSortCode: "123456",
        bankAccountNumber: "12345678",
        numberPrefix: "INV-",
        paymentTermsDays: 30,
      },
    });
  });

  it("treats a blank VAT number and blank bank details as not set", () => {
    const r = readSettingsForm(form({ ...good, vatNumber: "", bankAccountName: "", bankSortCode: "", bankAccountNumber: "" }));
    expect(r.ok && r.values).toMatchObject({ vatNumber: null, bankAccountName: null, bankSortCode: null, bankAccountNumber: null });
  });

  it("refuses each bad field with its own sentence", () => {
    const r = readSettingsForm(form({
      ...good,
      businessName: "",
      vatNumber: "FR123",
      bankSortCode: "123",
      bankAccountNumber: "",
      numberPrefix: "inv/",
      paymentTermsDays: "121",
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(
      ["bankAccountNumber", "bankSortCode", "businessName", "numberPrefix", "paymentTermsDays", "vatNumber"].sort(),
    );
  });
});
