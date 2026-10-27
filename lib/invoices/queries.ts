import "server-only";
// Invoice reads, through the caller's own RLS-bound client: view_finance
// decides what comes back (20261106000000), so another workspace's row is
// simply absent.
import { createClient } from "@/lib/supabase/server";
import type { VatRate } from "@/lib/invoices/arithmetic";
import type { InvoiceStatus } from "@/lib/invoices/status";

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


export interface InvoiceLineRow {
  position: number;
  description: string;
  quantity: string;
  unitPriceMinor: number;
  vatRate: VatRate;
  financialEntryId: string | null;
  netMinor: number;
  vatMinor: number;
}

export interface InvoiceDetail {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  recipientCompanyId: string | null;
  recipientContactId: string | null;
  recipientAddress: string | null;
  eventId: string | null;
  supplyDate: string | null;
  notes: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  snapshot: unknown;
  paidOn: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  lines: InvoiceLineRow[];
}

const INVOICE_DETAIL_SELECT =
  "id, status, number, recipient_company_id, recipient_contact_id, recipient_address, event_id, supply_date, notes, net_minor, vat_minor, gross_minor, snapshot, paid_on, voided_at, void_reason, deleted_at, invoice_lines(position, description, quantity, unit_price_minor, vat_rate, financial_entry_id, net_minor, vat_minor)";

/** One invoice of this workspace through the caller's RLS. A soft-deleted
 *  draft, another tenant's id, an unparseable id and an absent one are all
 *  "missing" -- the page answers each with the same not-found. */
export async function loadInvoice(
  organisationId: string,
  invoiceId: string,
): Promise<{ outcome: "loaded"; invoice: InvoiceDetail } | { outcome: "missing" } | { outcome: "unavailable" }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_DETAIL_SELECT)
    .eq("organisation_id", organisationId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error("[invoices] invoice lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (!data || data.deleted_at !== null) return { outcome: "missing" };
  const lines = ((data.invoice_lines ?? []) as Record<string, unknown>[])
    .map((l) => ({
      position: Number(l.position),
      description: String(l.description),
      quantity: Number(l.quantity).toFixed(2),
      unitPriceMinor: Number(l.unit_price_minor),
      vatRate: l.vat_rate as VatRate,
      financialEntryId: (l.financial_entry_id as string | null) ?? null,
      netMinor: Number(l.net_minor),
      vatMinor: Number(l.vat_minor),
    }))
    .sort((a, b) => a.position - b.position);
  return {
    outcome: "loaded",
    invoice: {
      id: String(data.id),
      status: data.status as InvoiceStatus,
      number: data.number ?? null,
      recipientCompanyId: data.recipient_company_id ?? null,
      recipientContactId: data.recipient_contact_id ?? null,
      recipientAddress: data.recipient_address ?? null,
      eventId: data.event_id ?? null,
      supplyDate: data.supply_date ?? null,
      notes: data.notes ?? null,
      netMinor: Number(data.net_minor),
      vatMinor: Number(data.vat_minor),
      grossMinor: Number(data.gross_minor),
      snapshot: data.snapshot,
      paidOn: data.paid_on ?? null,
      voidedAt: data.voided_at ?? null,
      voidReason: data.void_reason ?? null,
      lines,
    },
  };
}

export async function loadInvoiceSends(organisationId: string, invoiceId: string): Promise<{ toEmail: string; sentAt: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoice_sends")
    .select("to_email, sent_at")
    .eq("organisation_id", organisationId)
    .eq("invoice_id", invoiceId)
    .order("sent_at", { ascending: false })
    .limit(20);
  if (error) {
    console.error("[invoices] send history lookup failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({ toEmail: String(r.to_email), sentAt: String(r.sent_at) }));
}
