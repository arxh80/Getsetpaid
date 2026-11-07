import { beforeEach, describe, expect, it, vi } from "vitest";

// The OAuth callback (ONE fixed path): the state is CLAIMED before the code is
// exchanged, because Stripe revokes the connection if a code is used twice; the
// workspace comes from the claim, never from the URL; the account id comes from
// the code exchange, never from the query.
const h = vi.hoisted(() => ({
  claim: { data: [{ organisation_id: "org-1", slug: "neon" }], error: null } as {
    data: { organisation_id: string; slug: string }[] | null;
    error: { code?: string; hint?: string | null; message: string } | null;
  },
  complete: { data: null, error: null } as { data: null; error: { code?: string; hint?: string | null; message: string } | null },
  log: [] as string[],
  rpc: vi.fn(),
  gateway: null as null | {
    exchangeCode: ReturnType<typeof vi.fn>;
    chargesEnabled: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => h.gateway }));

import { GET } from "@/app/api/stripe/connect/callback/route";
import { stripeReturnNotice } from "@/lib/invoices/stripe-account";

const call = (query: string) => GET(new Request(`https://internal.test/api/stripe/connect/callback${query}`));
const BACK = "https://app.example.test/neon/settings/invoicing?stripe=";

beforeEach(() => {
  h.claim = { data: [{ organisation_id: "org-1", slug: "neon" }], error: null };
  h.complete = { data: null, error: null };
  h.log = [];
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string) => {
    h.log.push(`rpc:${name}`);
    return name === "claim_stripe_link_state" ? h.claim : h.complete;
  });
  h.gateway = {
    exchangeCode: vi.fn(async () => {
      h.log.push("exchange");
      return { account: "acct_FROMSTRIPE" };
    }),
    chargesEnabled: vi.fn().mockResolvedValue(true),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the Stripe callback", () => {
  it("claims the state BEFORE exchanging the code, then completes, then says linked", async () => {
    const res = await call("?code=the-code&state=the-state");
    expect(h.log).toEqual(["rpc:claim_stripe_link_state", "exchange", "rpc:complete_stripe_link"]);
    expect(h.rpc).toHaveBeenCalledWith("claim_stripe_link_state", { p_state: "the-state" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BACK}linked`);
  });
  it("the account id is Stripe's, the workspace is not passed at all", async () => {
    await call("?code=c&state=s&account=acct_FORGED&org=other&organisation_id=other");
    expect(h.gateway!.chargesEnabled).toHaveBeenCalledWith("acct_FROMSTRIPE");
    expect(h.rpc).toHaveBeenCalledWith("complete_stripe_link", {
      p_state: "s",
      p_account: "acct_FROMSTRIPE",
      p_charges_enabled: true,
    });
  });
  it("the workspace to return to comes from the claim, not from the URL", async () => {
    h.claim = { data: [{ organisation_id: "org-9", slug: "other-slug" }], error: null };
    const res = await call("?code=c&state=s&slug=neon&orgSlug=neon");
    expect(res.headers.get("location")).toBe("https://app.example.test/other-slug/settings/invoicing?stripe=linked");
  });
  it("A REPLAY (the claim is refused) never calls Stripe and never completes; it lands on / with no key", async () => {
    h.claim = { data: null, error: { code: "42501", hint: "stripe_link_state_invalid", message: "x" } };
    const res = await call("?code=c&state=s");
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
    expect(h.log).toEqual(["rpc:claim_stripe_link_state"]);
    expect(res.headers.get("location")).toBe("https://app.example.test/");
  });
  it("a claim that returns no row is a replay too", async () => {
    h.claim = { data: [], error: null };
    await call("?code=c&state=s");
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
  });
  it("no state at all: nothing is claimed or exchanged", async () => {
    const res = await call("?code=c");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://app.example.test/");
  });
  it("cancelled at Stripe, or no code: back to the settings page as cancelled, nothing exchanged", async () => {
    for (const q of ["?error=access_denied&error_description=x&state=s", "?state=s"]) {
      const res = await call(q);
      expect(res.headers.get("location")).toBe(`${BACK}cancelled`);
    }
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
    expect(h.log).not.toContain("rpc:complete_stripe_link");
  });
  it("a completion refusal that has a sentence is passed on as its key", async () => {
    h.complete = { data: null, error: { code: "22023", hint: "stripe_account_in_use", message: "x" } };
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}stripe_account_in_use`);
  });
  it("a completion refusal with no sentence, or no hint, is just failed", async () => {
    h.complete = { data: null, error: { code: "42501", hint: "something_new", message: "x" } };
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
    h.complete = { data: null, error: { code: "XX000", hint: null, message: "x" } };
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
  });
  it("Stripe erroring on the exchange is failed (the state stays spent), and nothing is completed", async () => {
    h.gateway!.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
    expect(h.log).not.toContain("rpc:complete_stripe_link");
  });
  it("Stripe unconfigured is failed", async () => {
    h.gateway = null;
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
  });
});

describe("stripeReturnNotice (the page's allowlist)", () => {
  it("maps the route's keys and the three Stripe refusals to sentences", () => {
    expect(stripeReturnNotice("linked")?.tone).toBe("success");
    expect(stripeReturnNotice("cancelled")?.tone).toBe("info");
    expect(stripeReturnNotice("failed")?.tone).toBe("error");
    expect(stripeReturnNotice("stripe_link_state_invalid")?.text).toContain("expired or was already used");
    expect(stripeReturnNotice("stripe_account_in_use")?.text).toContain("another GetSetPaid workspace");
  });
  it("shows nothing for an absent, unknown or prototype-named value, and never echoes it", () => {
    expect(stripeReturnNotice(undefined)).toBeNull();
    expect(stripeReturnNotice("<script>alert(1)</script>")).toBeNull();
    expect(stripeReturnNotice("constructor")).toBeNull();
    expect(stripeReturnNotice("__proto__")).toBeNull();
  });
});
