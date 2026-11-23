// lib/invoices/pay.ts checkoutIdempotencyKey: two clicks together must share a
// key (Stripe then makes one session), and anything that should be a new
// session must change it.
import { describe, expect, it } from "vitest";
import { checkoutExpiresAt, checkoutIdempotencyKey } from "@/lib/invoices/pay";

const MINUTE = 60_000;
const t0 = 29_000_000 * MINUTE; // the start of a minute
const input = {
  account: "acct_seller", invoiceId: "11111111-1111-1111-1111-111111111111", number: "INV-0007",
  grossMinor: 12000, feeMinor: 120, successUrl: "https://app.test/pay/t/thanks", cancelUrl: "https://app.test/pay/t",
  expiresAt: checkoutExpiresAt(t0),
};

describe("checkoutExpiresAt", () => {
  it("is the same for every click in one minute, so a retried key sends the same body", () => {
    expect(checkoutExpiresAt(t0)).toBe(checkoutExpiresAt(t0 + MINUTE - 1));
  });

  it("stays inside Stripe's window (30 minutes to 24 hours) from any moment in that minute", () => {
    for (const now of [t0, t0 + MINUTE - 1]) {
      const ahead = checkoutExpiresAt(now) - now / 1000;
      expect(ahead).toBeGreaterThanOrEqual(30 * 60);
      expect(ahead).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });
});

describe("checkoutIdempotencyKey", () => {
  it("is the same for two clicks in the same minute", () => {
    expect(checkoutIdempotencyKey(input, null, t0)).toBe(checkoutIdempotencyKey(input, null, t0 + MINUTE - 1));
  });

  it("changes the next minute, so a cached Stripe failure clears", () => {
    expect(checkoutIdempotencyKey(input, null, t0)).not.toBe(checkoutIdempotencyKey(input, null, t0 + MINUTE));
  });

  it("changes with any parameter, so Stripe never sees one key with two bodies", () => {
    const base = checkoutIdempotencyKey(input, null, t0);
    expect(checkoutIdempotencyKey({ ...input, feeMinor: 121 }, null, t0)).not.toBe(base);
    expect(checkoutIdempotencyKey({ ...input, account: "acct_other" }, null, t0)).not.toBe(base);
    expect(checkoutIdempotencyKey({ ...input, cancelUrl: "https://www.app.test/pay/t" }, null, t0)).not.toBe(base);
  });

  it("changes with the previous session, so the click after it expires gets a fresh one", () => {
    expect(checkoutIdempotencyKey(input, "cs_old", t0)).not.toBe(checkoutIdempotencyKey(input, null, t0));
  });

  it("fits Stripe's 255-character limit", () => {
    expect(checkoutIdempotencyKey(input, "cs_old", t0)).toMatch(/^checkout-[0-9a-f]{64}$/);
  });
});
