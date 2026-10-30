"use server";
// Save the workspace's invoice settings. Four gates, in order: the workspace
// (membership), finance WRITE access (manage_finance + Pro + not suspended --
// the same sentence the disabled form shows), STEP-UP re-authentication
// (spec § Permissions: it changes where money is paid), then the form.
// public.save_invoice_settings() re-checks the first two in the database and
// writes the audit rows; a bank change is emailed to the Owners and Admins by
// the delivery tick (lib/email/invoice-notifications.ts).
import { revalidatePath } from "next/cache";
import { getCurrentOrg } from "@/lib/auth";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { readSettingsForm } from "@/lib/invoices/settings-form";
import { invoiceRefusal } from "@/lib/invoices/refusals";

const NEEDS_STEP_UP =
  "Confirm it is you before changing invoice settings. Use the prompt on this page, then save again.";

export async function saveInvoiceSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = echoedValues(formData);
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org) return { error: FAILED_MESSAGE, values };

  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) return { error: access.explanation, values };
  if (!(await checkStepUp())) return { error: NEEDS_STEP_UP, values };

  const parsed = readSettingsForm(formData);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values };
  const v = parsed.values;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_invoice_settings", {
    p_org: org.id,
    p_business_name: v.businessName,
    p_business_address: v.businessAddress,
    p_vat_number: v.vatNumber,
    p_bank_account_name: v.bankAccountName,
    p_bank_sort_code: v.bankSortCode,
    p_bank_account_number: v.bankAccountNumber,
    p_number_prefix: v.numberPrefix,
    p_payment_terms_days: v.paymentTermsDays,
  });
  if (error) {
    if (!error.hint) console.error("[invoices] save settings failed:", error.message);
    return { error: invoiceRefusal(error), values };
  }
  revalidatePath(`/${org.slug}/settings/invoicing`);
  return {
    message:
      data === true
        ? "Saved. The bank details changed, so this workspace’s Owners and Admins are being emailed about it."
        : "Saved.",
  };
}
