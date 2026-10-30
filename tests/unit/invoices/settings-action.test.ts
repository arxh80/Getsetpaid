import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stepUp: true, canWrite: true, rpc: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ getCurrentOrg: async () => ({ id: "org-1", slug: "neon", name: "Neon" }) }));
vi.mock("@/lib/auth/step-up-gate", () => ({ checkStepUp: async () => h.stepUp }));
vi.mock("@/lib/crm/finance-access", () => ({
  getFinanceWriteAccess: async () =>
    h.canWrite ? { canWrite: true } : { canWrite: false, reason: "tier", explanation: "Finance is a Pro feature." },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));

import { saveInvoiceSettingsAction } from "@/lib/invoices/settings-actions";

function form(): FormData {
  const d = new FormData();
  for (const [k, v] of Object.entries({
    orgSlug: "neon", businessName: "A", businessAddress: "B", vatNumber: "",
    bankAccountName: "N", bankSortCode: "12-34-56", bankAccountNumber: "12345678",
    numberPrefix: "INV-", paymentTermsDays: "30",
  })) d.set(k, v);
  return d;
}

beforeEach(() => {
  h.stepUp = true;
  h.canWrite = true;
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: true, error: null });
});

describe("saveInvoiceSettingsAction", () => {
  it("refuses without a fresh credential, keeps what was typed, never reaches the database", async () => {
    h.stepUp = false;
    const s = await saveInvoiceSettingsAction({}, form());
    expect(s.error).toContain("Confirm it is you");
    expect(s.values?.businessName).toBe("A");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("refuses a Starter workspace with the disabled form's own sentence", async () => {
    h.canWrite = false;
    expect((await saveInvoiceSettingsAction({}, form())).error).toBe("Finance is a Pro feature.");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("saves normalised values and says the Owners and Admins are emailed when the bank changed", async () => {
    const s = await saveInvoiceSettingsAction({}, form());
    expect(h.rpc).toHaveBeenCalledWith(
      "save_invoice_settings",
      expect.objectContaining({ p_org: "org-1", p_bank_sort_code: "123456", p_vat_number: null }),
    );
    expect(s.message).toContain("Owners and Admins");
  });
});
