import { describe, expect, it } from "vitest";
import { buildBankDetailsChangedNotice } from "@/lib/email/invoice-templates";

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
