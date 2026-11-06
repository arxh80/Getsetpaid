import { beforeEach, describe, expect, it, vi } from "vitest";

// The OAuth callback: every exit is a redirect to the settings page carrying a
// KEY, never a query value echoed back; the account id comes from the code
// exchange, never from the query.
const h = vi.hoisted(() => ({
  org: { id: "org-1", slug: "neon", name: "Neon" } as { id: string; slug: string; name: string } | null,
  rpc: vi.fn(),
  gateway: null as null | {
    exchangeCode: ReturnType<typeof vi.fn>;
    chargesEnabled: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentOrg: async () => h.org }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => h.gateway }));

import { GET } from "@/app/(app)/[orgSlug]/settings/invoicing/stripe/callback/route";
import { stripeReturnNotice } from "@/lib/invoices/stripe-account";

const call = (query: string) =>
  GET(new Request(`https://internal.test/neon/settings/invoicing/stripe/callback${query}`), {
    params: Promise.resolve({ orgSlug: "neon" }),
  });
const BACK = "https://app.example.test/neon/settings/invoicing?stripe=";

beforeEach(() => {
  h.org = { id: "org-1", slug: "neon", name: "Neon" };
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.gateway = {
    exchangeCode: vi.fn().mockResolvedValue({ account: "acct_FROMSTRIPE" }),
    chargesEnabled: vi.fn().mockResolvedValue(true),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the Stripe callback", () => {
  it("no such workspace for this caller: a plain 404, and Stripe is never asked", async () => {
    h.org = null;
    expect((await call("?code=c&state=s")).status).toBe(404);
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
  });
  it("the person cancelled at Stripe, or the code or state is missing: cancelled, nothing exchanged", async () => {
    for (const q of ["?error=access_denied&error_description=x", "?state=s", "?code=c"]) {
      const res = await call(q);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${BACK}cancelled`);
    }
    expect(h.gateway!.exchangeCode).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("completes the link with the account FROM STRIPE and the state from the query, then says linked", async () => {
    const res = await call("?code=the-code&state=the-state&account=acct_FORGED");
    expect(h.gateway!.exchangeCode).toHaveBeenCalledWith("the-code");
    expect(h.gateway!.chargesEnabled).toHaveBeenCalledWith("acct_FROMSTRIPE");
    expect(h.rpc).toHaveBeenCalledWith("complete_stripe_link", {
      p_org: "org-1",
      p_state: "the-state",
      p_account: "acct_FROMSTRIPE",
      p_charges_enabled: true,
    });
    expect(res.headers.get("location")).toBe(`${BACK}linked`);
  });
  it("a database refusal that has a sentence is passed on as its key", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "22023", hint: "stripe_account_in_use", message: "x" } });
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}stripe_account_in_use`);
  });
  it("a refusal with no sentence, or no hint, is just failed", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "something_new", message: "x" } });
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", hint: null, message: "x" } });
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
  });
  it("Stripe erroring on the exchange is failed, and the database is never reached", async () => {
    h.gateway!.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
    expect((await call("?code=c&state=s")).headers.get("location")).toBe(`${BACK}failed`);
    expect(h.rpc).not.toHaveBeenCalled();
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
