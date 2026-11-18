import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  canWrite: true,
  manageFinance: true,
  suspended: false,
  rpcError: null as { code?: string; hint?: string | null; message: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.log.push(`revalidate:${p}`) }));
vi.mock("@/lib/auth", () => ({
  getCurrentOrg: async () => ({ id: "org-1", slug: "neon", name: "Neon", isSuspended: h.suspended }),
  hasPermission: async () => h.manageFinance,
}));
vi.mock("@/lib/crm/finance-access", () => ({
  getFinanceWriteAccess: async () => (h.canWrite ? { canWrite: true } : { canWrite: false, explanation: "Invoicing is a Pro feature." }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.log.push(`rpc:${name}:${Object.values(args).join(",")}`);
      return { data: h.rpcError ? null : "d-1", error: h.rpcError };
    },
  }),
}));

import { deliverInvoiceAction, withdrawInvoiceDeliveryAction } from "@/lib/invoices/actions";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const DELIVER = { orgSlug: "neon", invoiceId: "inv-1", profileId: "prof-1" };
const WITHDRAW = { orgSlug: "neon", invoiceId: "inv-1", deliveryId: "d-1" };

beforeEach(() => {
  h.log = [];
  h.canWrite = true;
  h.manageFinance = true;
  h.suspended = false;
  h.rpcError = null;
});

describe("deliverInvoiceAction", () => {
  it("calls deliver_invoice with the invoice and the profile, then revalidates the invoice page", async () => {
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.message).toMatch(/^Delivered/);
    expect(h.log).toEqual(["rpc:deliver_invoice:inv-1,prof-1", "revalidate:/neon/invoices/inv-1"]);
  });
  it("refuses without finance write access and calls nothing", async () => {
    h.canWrite = false;
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toBe("Invoicing is a Pro feature.");
    expect(h.log).toEqual([]);
  });
  it("turns the one refusal hint into its sentence", async () => {
    h.rpcError = { code: "42501", hint: "invoice_delivery_refused", message: "refused" };
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toMatch(/can’t be delivered/);
  });
  it("turns the hourly budget into its own sentence", async () => {
    h.rpcError = { code: "PT429", hint: "600", message: "limit" };
    const state = await deliverInvoiceAction({}, form(DELIVER));
    expect(state.error).toMatch(/an hour/);
  });
});

describe("withdrawInvoiceDeliveryAction", () => {
  it("withdraws on a Starter workspace too: manage_finance is enough", async () => {
    h.canWrite = false;
    const state = await withdrawInvoiceDeliveryAction({}, form(WITHDRAW));
    expect(state.message).toMatch(/^Withdrawn/);
    expect(h.log).toEqual(["rpc:withdraw_invoice_delivery:d-1", "revalidate:/neon/invoices/inv-1"]);
  });
  it("refuses without manage_finance, or when suspended", async () => {
    h.manageFinance = false;
    expect((await withdrawInvoiceDeliveryAction({}, form(WITHDRAW))).error).toBeTruthy();
    h.manageFinance = true;
    h.suspended = true;
    expect((await withdrawInvoiceDeliveryAction({}, form(WITHDRAW))).error).toBeTruthy();
    expect(h.log).toEqual([]);
  });
});
