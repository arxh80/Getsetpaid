import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { payLinkSecret } from "@/lib/stripe/env";
import { payLinkToken, payLinkUrl, verifyPayLinkToken } from "@/lib/stripe/pay-link";

const ID = "3f0c9a52-6f0e-4d8e-9a43-0d5c2b1e7a10";
const SECRET = "pay-link-test-secret-0123456789abcdef0123";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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
    // Non-canonical spellings of the same MAC (final review F8): Node's base64url decoder skips
    // characters outside the alphabet and ignores the last character's two padding bits.
    ["an appended !", (t: string) => `${t}!`],
    ["an inserted %", (t: string) => `${t.slice(0, 50)}%${t.slice(50)}`],
    ["a last character that differs only in its padding bits", (t: string) => t.slice(0, -1) + B64URL[B64URL.indexOf(t.at(-1)!) ^ 1]],
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
  it("the .env.example placeholder is no secret under NODE_ENV=production: no pay link, no throw (final review F7)", () => {
    const placeholder = /^INVOICE_PAY_LINK_SECRET=(\S+)\r?$/m.exec(readFileSync(".env.example", "utf8"))![1];
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", placeholder);
    expect(payLinkToken(ID)).not.toBeNull(); // development: the placeholder works
    vi.stubEnv("NODE_ENV", "production");
    expect(payLinkSecret()).toBeNull();
    expect(payLinkToken(ID)).toBeNull();
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    expect(payLinkToken(ID)).not.toBeNull(); // the control: a real secret under production
  });
  it("builds an absolute URL on the site origin", () => {
    vi.stubEnv("INVOICE_PAY_LINK_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test/");
    expect(payLinkUrl(ID)).toBe(`https://app.example.test/pay/${payLinkToken(ID)}`);
  });
});
