import { afterEach, describe, expect, it, vi } from "vitest";
import { payLinkToken, payLinkUrl, verifyPayLinkToken } from "@/lib/stripe/pay-link";

const ID = "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a10";
const SECRET = "pay-link-test-secret-0123456789abcdef0123";

afterEach(() => vi.unstubAllEnvs());

describe("the pay-link token", () => {
  it("round-trips an invoice id", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    const token = payLinkToken(ID)!;
    expect(token.startsWith(`${ID}.`)).toBe(true);
    expect(verifyPayLinkToken(token)).toBe(ID);
  });
  it.each([
    ["a changed signature character", (t: string) => t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")],
    ["another invoice's id with this signature", (t: string) => t.replace(ID, "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a11")],
    ["no signature", (t: string) => t.split(".")[0]],
    ["an empty signature", (t: string) => `${t.split(".")[0]}.`],
    ["a non-uuid id", (t: string) => `x.${t.split(".")[1]}`],
    ["three parts", (t: string) => `${t}.x`],
  ])("refuses %s", (_label, mutate) => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    expect(verifyPayLinkToken(mutate(payLinkToken(ID)!))).toBeNull();
  });
  it("refuses a token made under another secret", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    const token = payLinkToken(ID)!;
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", `${SECRET}-rotated`);
    expect(verifyPayLinkToken(token)).toBeNull();
  });
  it("makes and accepts nothing with a missing or short secret", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", "short");
    expect(payLinkToken(ID)).toBeNull();
    expect(verifyPayLinkToken(`${ID}.abc`)).toBeNull();
  });
  it("builds an absolute URL on the site origin", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test/");
    expect(payLinkUrl(ID)).toBe(`https://app.example.test/pay/${payLinkToken(ID)}`);
  });
});
