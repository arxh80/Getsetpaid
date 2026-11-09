import { beforeEach, describe, expect, it, vi } from "vitest";

// startStripeLinkAction / disconnectStripeAction: the gates in order (workspace,
// finance write access, Stripe configured, step-up), then the database call.
// redirect() is Next's control-flow throw, so the mock throws like it does.
const h = vi.hoisted(() => ({
  org: { id: "org-1", slug: "neon", name: "Neon" } as { id: string; slug: string; name: string } | null,
  canWrite: true,
  stepUp: true,
  mint: true,
  rpc: vi.fn(),
  gateway: null as null | {
    authorizeUrl: ReturnType<typeof vi.fn>;
    deauthorize: ReturnType<typeof vi.fn>;
  },
}));

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentOrg: async () => h.org }));
vi.mock("@/lib/auth/step-up-gate", () => ({ checkStepUp: async () => h.stepUp, mintStepUpToken: async () => h.mint }));
vi.mock("@/lib/crm/finance-access", () => ({
  getFinanceWriteAccess: async () =>
    h.canWrite ? { canWrite: true } : { canWrite: false, reason: "tier", explanation: "Finance is a Pro feature." },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "https://app.example.test" }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => h.gateway }));

import { disconnectStripeAction, startStripeLinkAction } from "@/lib/invoices/stripe-actions";
import { FAILED_MESSAGE } from "@/lib/crm/write";

function form(): FormData {
  const d = new FormData();
  d.set("orgSlug", "neon");
  return d;
}

async function redirectedTo(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  h.org = { id: "org-1", slug: "neon", name: "Neon" };
  h.canWrite = true;
  h.stepUp = true;
  h.mint = true;
  h.rpc.mockReset();
  h.gateway = {
    authorizeUrl: vi.fn((state: string, redirectUri: string) => `https://stripe.test/authorize?state=${state}&redirect_uri=${redirectUri}`),
    deauthorize: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("startStripeLinkAction", () => {
  it("no workspace: the generic failure, nothing called", async () => {
    h.org = null;
    expect((await startStripeLinkAction({}, form())).error).toBe(FAILED_MESSAGE);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("no finance write access: the disabled form's own sentence", async () => {
    h.canWrite = false;
    expect((await startStripeLinkAction({}, form())).error).toBe("Finance is a Pro feature.");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("no fresh credential: the step-up sentence, and the database is never reached", async () => {
    h.stepUp = false;
    expect((await startStripeLinkAction({}, form())).error).toContain("Confirm it is you");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("the database would not record the step-up: the same sentence, no begin", async () => {
    h.mint = false;
    expect((await startStripeLinkAction({}, form())).error).toContain("Confirm it is you");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("Stripe not configured on this server: says so, and no state is minted", async () => {
    h.gateway = null;
    expect((await startStripeLinkAction({}, form())).error).toBe("Card payments aren’t set up on this server yet.");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("begins the link for the org, then redirects to Stripe's authorize URL with the state and the callback", async () => {
    h.rpc.mockResolvedValue({ data: "STATE43", error: null });
    const to = await redirectedTo(startStripeLinkAction({}, form()));
    expect(h.rpc).toHaveBeenCalledWith("begin_stripe_link", { p_org: "org-1" });
    expect(h.gateway!.authorizeUrl).toHaveBeenCalledWith("STATE43", "https://app.example.test/api/stripe/connect/callback");
    expect(to).toBe("https://stripe.test/authorize?state=STATE43&redirect_uri=https://app.example.test/api/stripe/connect/callback");
  });
  it("a database refusal is a sentence, not a redirect", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "plan_does_not_include_invoicing", message: "x" } });
    expect((await startStripeLinkAction({}, form())).error).toContain("Pro feature");
    expect(h.gateway!.authorizeUrl).not.toHaveBeenCalled();
  });
});

describe("disconnectStripeAction", () => {
  it("no fresh credential: the step-up sentence, and the database is never reached", async () => {
    h.stepUp = false;
    expect((await disconnectStripeAction({}, form())).error).toContain("Confirm it is you");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("no finance write access: the explanation, nothing called", async () => {
    h.canWrite = false;
    expect((await disconnectStripeAction({}, form())).error).toBe("Finance is a Pro feature.");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("ends the link, THEN deauthorises the account at Stripe", async () => {
    const order: string[] = [];
    h.rpc.mockImplementation(async (name: string) => {
      order.push(`rpc:${name}`);
      return { data: "acct_123", error: null };
    });
    h.gateway!.deauthorize.mockImplementation(async (a: string) => {
      order.push(`deauthorize:${a}`);
    });
    const s = await disconnectStripeAction({}, form());
    expect(order).toEqual(["rpc:end_stripe_account_link", "deauthorize:acct_123"]);
    expect(h.rpc).toHaveBeenCalledWith("end_stripe_account_link", { p_org: "org-1" });
    expect(s.message).toBe("Disconnected. Card payment links on this workspace’s invoices now say they can’t be paid online.");
  });
  it("Stripe's call throws: the row is still ended (the RPC came first) and the message says to remove the app by hand", async () => {
    h.rpc.mockResolvedValue({ data: "acct_123", error: null });
    h.gateway!.deauthorize.mockRejectedValue(new Error("stripe 500"));
    const s = await disconnectStripeAction({}, form());
    expect(h.rpc).toHaveBeenCalledOnce();
    expect(s.message).toBe(
      "Disconnected here, but Stripe didn’t confirm it. Remove GetSetPaid under Settings → Connected accounts in your Stripe dashboard.",
    );
    expect(s.error).toBeUndefined();
  });
  it("Stripe not configured: the link is still ended, and the same hand-removal message is shown", async () => {
    h.gateway = null;
    h.rpc.mockResolvedValue({ data: "acct_123", error: null });
    const s = await disconnectStripeAction({}, form());
    expect(h.rpc).toHaveBeenCalledOnce();
    expect(s.message).toContain("Stripe didn’t confirm it");
  });
  it("nothing was live: says so and never calls Stripe", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    const s = await disconnectStripeAction({}, form());
    expect(s.message).toBe("There was no connected Stripe account to disconnect.");
    expect(h.gateway!.deauthorize).not.toHaveBeenCalled();
  });
  it("a database refusal is a sentence, and Stripe is never called", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "step_up_required", message: "x" } });
    expect((await disconnectStripeAction({}, form())).error).toBeTruthy();
    expect(h.gateway!.deauthorize).not.toHaveBeenCalled();
  });
});
