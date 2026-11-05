import { afterEach, describe, expect, it, vi } from "vitest";
import { getStripe } from "@/lib/stripe/client";
import { FakeStripeGateway } from "@/lib/stripe/fake";

const KEYS = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_CONNECT_CLIENT_ID: "ca_x",
} as const;

function set(over: Record<string, string> = {}) {
  vi.stubEnv("STRIPE_MODE", "");
  for (const [k, v] of Object.entries({ ...KEYS, ...over })) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("getStripe", () => {
  it.each(Object.keys(KEYS))("is null with %s missing", (name) => {
    set({ [name]: "" });
    expect(getStripe()).toBeNull();
  });
  it("is null for the fake under NODE_ENV=production", () => {
    set({ STRIPE_MODE: "fake", NODE_ENV: "production" });
    expect(getStripe()).toBeNull();
  });
  it("is the fake with STRIPE_MODE=fake in test", () => {
    set({ STRIPE_MODE: "fake" });
    expect(getStripe()).toBeInstanceOf(FakeStripeGateway);
  });
  it("is the real gateway with the mode unset and keys present", () => {
    set();
    const gw = getStripe();
    expect(gw).not.toBeNull();
    expect(gw).not.toBeInstanceOf(FakeStripeGateway);
    expect(gw!.authorizeUrl("s", "https://app.test/cb")).toContain("https://connect.stripe.com/oauth/authorize?");
  });
});
