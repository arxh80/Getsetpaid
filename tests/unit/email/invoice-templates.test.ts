import { describe, expect, it } from "vitest";
import { NoticeContentError } from "@/lib/email/requester-templates";
import { buildBankDetailsChangedNotice, buildInvoiceEmail, buildStripeAccountChangedNotice } from "@/lib/email/invoice-templates";

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

describe("buildStripeAccountChangedNotice", () => {
  const stripe = {
    organisationSlug: "neon-nights",
    organisationName: "Neon Nights Ltd",
    change: "linked" as "linked" | "ended",
    changedAt: "2026-10-20T12:00:00.000Z",
    siteUrl: "https://app.example.test",
  };
  it("a link: says a Stripe account was connected, when, to check Invoice settings, and to contact support if it was not them", () => {
    const body = buildStripeAccountChangedNotice(stripe);
    expect(body.subject).toBe("[GetSetPaid] A Stripe account was connected to neon-nights's invoices");
    expect(body.text).toContain("20 October 2026 at 13:00 BST");
    expect(body.text).toContain("Invoice settings");
    expect(body.text).toMatch(/contact (GetSetPaid )?support/i);
    expect(body.text).toContain("https://app.example.test/neon-nights/settings/invoicing");
  });
  it("an end: says it was disconnected", () => {
    const body = buildStripeAccountChangedNotice({ ...stripe, change: "ended" });
    expect(body.subject).toBe("[GetSetPaid] A Stripe account was disconnected from neon-nights's invoices");
    expect(body.text).toContain("disconnected");
  });
  it("carries no Stripe identifier and only the one link", () => {
    const body = buildStripeAccountChangedNotice(stripe);
    expect(body.text + body.html).not.toMatch(/acct_/);
    expect(body.text.match(/https?:\/\//g)).toHaveLength(1);
  });
  it("refuses an input key outside the allowlist, a change that is neither, and a bad slug", () => {
    expect(() => buildStripeAccountChangedNotice({ ...stripe, accountId: "acct_1" } as typeof stripe)).toThrow();
    expect(() => buildStripeAccountChangedNotice({ ...stripe, change: "deleted" as "ended" })).toThrow();
    expect(() => buildStripeAccountChangedNotice({ ...stripe, organisationSlug: "../x" })).toThrow();
  });
  it("neutralises a link smuggled into the workspace name", () => {
    const body = buildStripeAccountChangedNotice({ ...stripe, organisationName: "Evil https://evil.example/login" });
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
  it("without a pay link the output is exactly what it was before the pay link existed", () => {
    const expected = [
      "Dear Sam Booker,",
      "Please find attached invoice INV-0001 from Alpha Promotions Ltd for £3,960.00, due on 19 Nov 2026.",
      "Please pay by bank transfer to Alpha Promotions Ltd, sort code 123456, account number 12345678, quoting INV-0001.",
      "Sent on behalf of Alpha Promotions Ltd by GetSetPaid.",
    ];
    for (const body of [buildInvoiceEmail(input), buildInvoiceEmail({ ...input, payUrl: null })]) {
      expect(body.text).toBe(expected.join("\n\n"));
      expect(body.html).toBe(expected.map((p) => `<p>${p}</p>`).join("\n"));
    }
  });
  describe("with a pay link", () => {
    const payUrl = "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.abc-DEF_123";
    it("adds 'Pay by card: <url>' before the bank paragraph, as a link in the HTML", () => {
      const body = buildInvoiceEmail({ ...input, payUrl });
      const paragraphs = body.text.split("\n\n");
      expect(paragraphs[2]).toBe(`Pay by card: ${payUrl}`);
      expect(paragraphs[3]).toContain("bank transfer");
      expect(body.html).toContain(`<a href="${payUrl}">Pay by card</a>`);
      expect(body.html.indexOf("Pay by card")).toBeLessThan(body.html.indexOf("bank transfer"));
    });
    it.each([
      "javascript:alert(1)",
      "https://app.example.test/pay/not-a-uuid.sig",
      "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.",
      'https://app.example.test/pay/11111111-2222-4333-8444-555555555555.a"onmouseover="x',
      "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.abc\n",
      "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.abc def",
      "https://app.example.test/other/11111111-2222-4333-8444-555555555555.abc",
    ])("refuses %j with NoticeContentError", (bad) => {
      expect(() => buildInvoiceEmail({ ...input, payUrl: bad })).toThrow(NoticeContentError);
    });
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
