import "server-only";
// Invoice reads, through the caller's own RLS-bound client: view_finance
// decides what comes back (20261106000000), so another workspace's row is
// simply absent.
import { createClient } from "@/lib/supabase/server";

export interface InvoiceSettingsRow {
  businessName: string | null;
  businessAddress: string | null;
  vatNumber: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  numberPrefix: string;
  nextNumber: number;
  paymentTermsDays: number;
}

export async function loadInvoiceSettings(
  organisationId: string,
): Promise<{ outcome: "loaded"; settings: InvoiceSettingsRow | null } | { outcome: "unavailable" }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoice_settings")
    .select("business_name, business_address, vat_number, bank_account_name, bank_sort_code, bank_account_number, number_prefix, next_number, payment_terms_days")
    .eq("organisation_id", organisationId)
    .maybeSingle();
  if (error) {
    console.error("[invoices] settings lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "loaded", settings: null };
  return {
    outcome: "loaded",
    settings: {
      businessName: data.business_name,
      businessAddress: data.business_address,
      vatNumber: data.vat_number,
      bankAccountName: data.bank_account_name,
      bankSortCode: data.bank_sort_code,
      bankAccountNumber: data.bank_account_number,
      numberPrefix: String(data.number_prefix),
      nextNumber: Number(data.next_number),
      paymentTermsDays: Number(data.payment_terms_days),
    },
  };
}
