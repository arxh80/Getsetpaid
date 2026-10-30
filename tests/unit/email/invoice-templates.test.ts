import { describe, expect, it } from "vitest";
import { buildBankDetailsChangedNotice, buildInvoiceEmail } from "@/lib/email/invoice-templates";

const base = {
  organisationSlug: "neon-nights",
  organisationName: "Neon Nights Ltd",
  accountLast4: "4321",
  changedAt: "2026-10-20T12:00:00.000Z",
  siteUrl: "https://app.example.test",
};

describe("buildBankDetailsChangedNotice", () => {
  it("names the workspace, the last four digits and links ONLY to its invoice settings", () => {
    const body = buildBankDetailsChangedNotice(base);
    expect(body.subject).toContain("neon-nights");
    expect(body.text).toContain("ending 4321");
    expect(body.text).toContain("https://app.example.test/neon-nights/settings/invoicing");
    expect(body.html).not.toMatch(/\b\d{8}\b/);
  });
  it("says the bank details were removed when there is no account any more", () => {
    expect(buildBankDetailsChangedNotice({ ...base, accountLast4: null }).text).toContain("removed");
  });
  it("refuses an input key outside the allowlist, a non-digit last four and a bad slug", () => {
    expect(() => buildBankDetailsChangedNotice({ ...base, extra: "x" } as typeof base)).toThrow();
    expect(() => buildBankDetailsChangedNotice({ ...base, accountLast4: "12ab" })).toThrow();
    expect(() => buildBankDetailsChangedNotice({ ...base, organisationSlug: "../x" })).toThrow();
  });
  it("neutralises a link smuggled into the workspace name", () => {
    const body = buildBankDetailsChangedNotice({ ...base, organisationName: "Evil https://evil.example/login" });
    expect(body.text).not.toContain("https://evil.example");
  });
});

describe("buildInvoiceEmail", () => {
  const input = {
    number: "INV-0001",
    sellerName: "Alpha Promotions Ltd",
    recipientName: "Sam Booker",
    grossMinor: 396000,
    dueDate: "2026-11-19",
    bank: { accountName: "Alpha Promotions Ltd", sortCode: "123456", accountNumber: "12345678" },
  };
  it("says who it is from, the total, the due date and how to pay; carries no link", () => {
    const body = buildInvoiceEmail(input);
    expect(body.subject).toBe("Invoice INV-0001 from Alpha Promotions Ltd");
    expect(body.text).toContain("£3,960.00");
    expect(body.text).toContain("12345678");
    expect(body.html).not.toMatch(/<a\s/i);
  });
  it("neutralises a link smuggled into a name", () => {
    const body = buildInvoiceEmail({ ...input, sellerName: "Pay https://evil.example now" });
    expect(body.text).not.toContain("https://evil.example");
    expect(body.subject).not.toContain("https://");
  });
  it("refuses a number outside the invoice shape", () => {
    expect(() => buildInvoiceEmail({ ...input, number: "../x" })).toThrow();
  });
});
