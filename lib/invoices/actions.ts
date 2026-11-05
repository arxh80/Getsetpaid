"use server";
// Invoice writes. Every one: resolve the workspace from the slug (never a
// client-supplied org id), check finance WRITE access (manage_finance + Pro +
// not suspended -- the same sentence the disabled controls show, so the two
// paths never disagree), then call the SECURITY DEFINER RPC that re-checks
// all of it in the database. Every refusal echoes the submitted values.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { readDraftForm } from "@/lib/invoices/draft-form";
import { invoiceRefusal } from "@/lib/invoices/refusals";

async function authorise(
  formData: FormData,
): Promise<{ ok: true; org: CurrentOrg } | { ok: false; state: FormState }> {
  const values = echoedValues(formData);
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values } };
  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) return { ok: false, state: { error: access.explanation, values } };
  return { ok: true, org };
}

function refused(error: { code?: string; hint?: string | null; message: string }, context: string, formData: FormData): FormState {
  // A hint is an expected refusal with its own sentence; anything else is a fault.
  if (!error.hint) console.error(`[invoices] ${context} failed:`, error.message);
  return { error: invoiceRefusal(error), values: echoedValues(formData) };
}

export async function saveInvoiceDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const parsed = readDraftForm(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values: echoedValues(formData) };
  const d = parsed.draft;
  const invoiceId = field(formData, "invoiceId");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_invoice_draft", {
    p_org: auth.org.id,
    p_invoice_id: invoiceId,
    p_recipient_company_id: d.recipient?.kind === "company" ? d.recipient.id : null,
    p_recipient_contact_id: d.recipient?.kind === "contact" ? d.recipient.id : null,
    p_event_id: d.eventId,
    p_recipient_address: d.recipientAddress,
    p_supply_date: d.supplyDate,
    p_notes: d.notes,
    p_lines: d.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unitPriceMinor,
      vat_rate: l.vatRate,
      financial_entry_id: l.financialEntryId,
    })),
  });
  if (error) return refused(error, "save draft", formData);

  revalidatePath(`/${auth.org.slug}/invoices`);
  if (!invoiceId) redirect(`/${auth.org.slug}/invoices/${String(data)}`);
  revalidatePath(`/${auth.org.slug}/invoices/${invoiceId}`);
  return { message: "Draft saved." };
}

export async function deleteInvoiceDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const invoiceId = field(formData, "invoiceId");
  if (!invoiceId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_invoice_draft", { p_invoice_id: invoiceId });
  if (error) return refused(error, "delete draft", formData);
  revalidatePath(`/${auth.org.slug}/invoices`);
  redirect(`/${auth.org.slug}/invoices`);
}

export async function issueInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const invoiceId = field(formData, "invoiceId");
  if (!invoiceId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("issue_invoice", { p_invoice_id: invoiceId });
  if (error) return refused(error, "issue", formData);
  revalidatePath(`/${auth.org.slug}/invoices`);
  revalidatePath(`/${auth.org.slug}/invoices/${invoiceId}`);
  return { message: `Issued as ${String(data)}.` };
}

export async function markInvoicePaidAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const invoiceId = field(formData, "invoiceId");
  const paidOn = field(formData, "paidOn");
  if (!invoiceId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (!paidOn || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return { fieldErrors: { paidOn: "Choose the date the payment arrived." }, values: echoedValues(formData) };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_invoice_paid", { p_invoice_id: invoiceId, p_paid_on: paidOn });
  if (error) return refused(error, "mark paid", formData);
  revalidatePath(`/${auth.org.slug}/invoices`);
  revalidatePath(`/${auth.org.slug}/invoices/${invoiceId}`);
  return { message: "Marked as paid. Any income it brings in is now on its event’s finance." };
}

export async function voidInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const invoiceId = field(formData, "invoiceId");
  const reason = field(formData, "reason");
  if (!invoiceId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (!reason || reason.length > 500) {
    return { fieldErrors: { reason: "Give a reason for voiding — 500 characters at most." }, values: echoedValues(formData) };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("void_invoice", { p_invoice_id: invoiceId, p_reason: reason });
  if (error) return refused(error, "void", formData);
  revalidatePath(`/${auth.org.slug}/invoices`);
  revalidatePath(`/${auth.org.slug}/invoices/${invoiceId}`);
  return { message: "Voided. The number stays used; issue a new invoice to correct it." };
}

export async function createDraftFromFinanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorise(formData);
  if (!auth.ok) return auth.state;
  const eventId = field(formData, "eventId");
  const ids = [...new Set(formData.getAll("entryId").filter((v): v is string => typeof v === "string" && v !== ""))];
  if (!eventId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (ids.length === 0) return { error: "Tick at least one income line to invoice.", values: echoedValues(formData) };

  // Read through RLS; the RPC re-checks each entry is live income on this event.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("financial_entries")
    .select("id, description, amount_minor")
    .eq("organisation_id", auth.org.id)
    .eq("event_id", eventId)
    .eq("category", "income")
    .is("deleted_at", null)
    .in("id", ids);
  if (error || !data || data.length !== ids.length) {
    return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
  }
  const byId = new Map(data.map((e) => [String(e.id), e]));
  const lines = ids.map((id) => {
    const e = byId.get(id)!;
    return {
      description: (e.description as string | null) ?? "Income",
      quantity: "1.00",
      unit_price_minor: Number(e.amount_minor),
      vat_rate: "standard_20",
      financial_entry_id: id,
    };
  });
  const { data: invoiceId, error: saveError } = await supabase.rpc("save_invoice_draft", {
    p_org: auth.org.id,
    p_invoice_id: null,
    p_recipient_company_id: null,
    p_recipient_contact_id: null,
    p_event_id: eventId,
    p_recipient_address: null,
    p_supply_date: null,
    p_notes: null,
    p_lines: lines,
  });
  if (saveError) return refused(saveError, "draft from finance", formData);
  revalidatePath(`/${auth.org.slug}/invoices`);
  redirect(`/${auth.org.slug}/invoices/${String(invoiceId)}`);
}
