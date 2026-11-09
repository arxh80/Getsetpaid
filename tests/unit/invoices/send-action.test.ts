import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  budget: { allowed: true } as { allowed: boolean; retryAfterSeconds?: number },
  sendOk: true,
  row: { status: "issued", snapshot: {} as unknown } as { status: string; snapshot: unknown } | null,
  account: { live: true, chargesEnabled: true, linkedAt: null, endedAt: null } as { live: boolean; chargesEnabled: boolean; linkedAt: string | null; endedAt: string | null } | null,
  payUrl: "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.sig" as string | null,
  renderOptions: undefined as { status: string; payUrl?: string | null } | undefined,
  mail: undefined as { text: string; html: string } | undefined,
}));
const snapshot = {
  version: 1, number: "INV-0001", issue_date: "2026-10-20", supply_date: "2026-10-20", due_date: "2026-11-19", currency: "GBP",
  seller: { name: "Alpha Ltd", address: "1 Road", vat_number: null, bank: null },
  recipient: { kind: "contact", name: "Sam", address: "2 Road", email: "sam@example.test" },
  lines: [{ position: 1, description: "Fee", quantity: "1.00", unit_price_minor: 1000, vat_rate: "none", net_minor: 1000, vat_minor: 0 }],
  totals: { net_minor: 1000, vat_minor: 0, gross_minor: 1000 },
  notes: null,
};

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ getCurrentOrg: async () => ({ id: "org-1", slug: "neon", name: "Neon" }) }));
vi.mock("@/lib/crm/finance-access", () => ({ getFinanceWriteAccess: async () => ({ canWrite: true }) }));
vi.mock("@/lib/security/rate-limit", () => ({
  consumeRateLimit: async (c: string) => { h.log.push(`budget:${c}`); return h.budget; },
}));
vi.mock("@/lib/invoices/stripe-account", () => ({ loadStripeAccount: async () => h.account }));
vi.mock("@/lib/stripe/pay-link", () => ({ payLinkUrl: () => h.payUrl }));
vi.mock("@/lib/invoices/pdf/render", () => ({
  renderInvoicePdf: async (_s: unknown, o: { status: string; payUrl?: string | null }) => { h.log.push("render"); h.renderOptions = o; return Buffer.from("%PDF-1.7"); },
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (i: { to: { email: string }[]; text: string; html: string; attachments?: { name: string }[] }) => {
    h.mail = { text: i.text, html: i.html };
    h.log.push(`send:${i.to[0].email}:${i.attachments?.[0]?.name}`);
    return h.sendOk ? { ok: true, messageId: "m-1" } : { ok: false, error: "Brevo 503" };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.row, error: null }) }) }) }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.log.push(`rpc:${name}:${String(args.p_to_email)}`);
      return { data: "send-1", error: null };
    },
  }),
}));

import { sendInvoiceAction } from "@/lib/invoices/send-action";

function form(toEmail: string): FormData {
  const d = new FormData();
  d.set("orgSlug", "neon");
  d.set("invoiceId", "11111111-2222-4333-8444-555555555555");
  d.set("toEmail", toEmail);
  return d;
}

beforeEach(() => {
  h.log = [];
  h.budget = { allowed: true };
  h.sendOk = true;
  h.row = { status: "issued", snapshot };
  h.account = { live: true, chargesEnabled: true, linkedAt: null, endedAt: null };
  h.payUrl = "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.sig";
  h.renderOptions = undefined;
  h.mail = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sendInvoiceAction", () => {
  it("spends the budget, renders, sends with <number>.pdf attached, THEN records", async () => {
    const s = await sendInvoiceAction({}, form("ap@customer.example"));
    expect(s.message).toContain("ap@customer.example");
    expect(h.log).toEqual([
      "budget:invoice_send",
      "render",
      "send:ap@customer.example:INV-0001.pdf",
      "rpc:record_invoice_send:ap@customer.example",
    ]);
  });
  it("a spent budget sends nothing and records nothing", async () => {
    h.budget = { allowed: false, retryAfterSeconds: 600 };
    const s = await sendInvoiceAction({}, form("ap@customer.example"));
    expect(s.error).toContain("Try again in");
    expect(h.log).toEqual(["budget:invoice_send"]);
  });
  it("a failed send records nothing", async () => {
    h.sendOk = false;
    await sendInvoiceAction({}, form("ap@customer.example"));
    expect(h.log.some((l) => l.startsWith("rpc:record_invoice_send"))).toBe(false);
  });
  describe("the pay-by-card link", () => {
    const url = "https://app.example.test/pay/11111111-2222-4333-8444-555555555555.sig";
    it("goes on the PDF and in the email for an issued invoice on a live, charges-enabled account", async () => {
      await sendInvoiceAction({}, form("ap@customer.example"));
      expect(h.renderOptions?.payUrl).toBe(url);
      expect(h.mail?.text).toContain(`Pay by card: ${url}`);
      expect(h.mail?.html).toContain(`<a href="${url}">Pay by card</a>`);
    });
    it.each([
      ["no Stripe account", () => { h.account = null; }],
      ["an ended account", () => { h.account = { live: false, chargesEnabled: true, linkedAt: null, endedAt: "2026-11-01T00:00:00Z" }; }],
      ["charges not enabled", () => { h.account = { live: true, chargesEnabled: false, linkedAt: null, endedAt: null }; }],
      ["an unconfigured pay-link secret", () => { h.payUrl = null; }],
      ["a paid invoice", () => { h.row = { status: "paid", snapshot }; }],
    ])("is left off with %s", async (_why, arrange) => {
      arrange();
      const s = await sendInvoiceAction({}, form("ap@customer.example"));
      expect(s.message).toContain("ap@customer.example");
      expect(h.renderOptions?.payUrl ?? null).toBeNull();
      expect(h.mail?.text).not.toContain("Pay by card");
      expect(h.mail?.html).not.toMatch(/<a\s/i);
    });
  });
  it("a bad address and a draft are refused before any budget is spent", async () => {
    expect((await sendInvoiceAction({}, form("nope"))).fieldErrors?.toEmail).toBeTruthy();
    h.row = { status: "draft", snapshot: null };
    expect((await sendInvoiceAction({}, form("ap@customer.example"))).error).toBeTruthy();
    expect(h.log).toEqual([]);
  });
});
