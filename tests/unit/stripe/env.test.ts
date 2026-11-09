import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStripe } from "@/lib/stripe/client";
import { stripeEnv } from "@/lib/stripe/env";
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

describe("stripeEnv().live: the mode the webhook accepts events from (final review F1)", () => {
  it.each([
    ["sk_live_x", "", true],
    ["rk_live_x", "", true],
    ["sk_test_x", "", false],
    ["rk_test_x", "", false],
    ["sk_live_x", "fake", false], // the fake is test mode, whatever key it holds
  ])("%s with STRIPE_MODE=%j is live=%s", (key, mode, live) => {
    set({ STRIPE_SECRET_KEY: key, STRIPE_MODE: mode });
    expect(stripeEnv()?.live).toBe(live);
  });
});

// Read from the file itself, so a placeholder changed there without env.ts goes red.
const EXAMPLE: Record<string, string> = Object.fromEntries(
  [...readFileSync(".env.example", "utf8").matchAll(/^(STRIPE_[A-Z_]+|INVOICE_PAY_LINK_SECRET)=(\S+)\r?$/gm)].map((m) => [m[1], m[2]]),
);

describe("the .env.example placeholders under NODE_ENV=production (final review F7)", () => {
  it.each(Object.keys(KEYS))("%s at its placeholder reads as unset: card payments unconfigured, no throw", (name) => {
    expect(EXAMPLE[name]).toBeTruthy();
    set({ NODE_ENV: "production", [name]: EXAMPLE[name] });
    expect(stripeEnv()).toBeNull();
    expect(getStripe()).toBeNull();
  });
  it("real-looking keys under production are configured (the control)", () => {
    set({ NODE_ENV: "production" });
    expect(stripeEnv()).not.toBeNull();
  });
  it("outside production the placeholders still drive the fake (development)", () => {
    set({ STRIPE_MODE: "fake", STRIPE_SECRET_KEY: EXAMPLE.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: EXAMPLE.STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_CLIENT_ID: EXAMPLE.STRIPE_CONNECT_CLIENT_ID });
    expect(getStripe()).toBeInstanceOf(FakeStripeGateway);
  });
});
