import "server-only";
// An invoice RPC's refusal hint -> the sentence a person can act on. The
// hints are raised by the 2026110600x000 migrations; a hint not listed here
// falls back to the generic refusal (42501) or failure (anything else).
import { FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";

export const INVOICE_REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  plan_does_not_include_invoicing: "Invoicing is a Pro feature. An Owner can upgrade the workspace to issue invoices.",
  invoice_not_a_draft: "This invoice has already been issued, so it can no longer be changed.",
  invoice_not_an_editable_draft: "This draft can no longer be changed. Reload the page to see where it stands.",
  invoice_needs_a_recipient: "Choose who the invoice is to before issuing it.",
  invoice_recipient_deleted: "The company or contact this invoice is to has been deleted. Choose another recipient, save, then issue.",
  invoice_recipient_not_live: "That company or contact has been deleted. Choose another recipient.",
  invoice_needs_recipient_address: "Add the recipient’s address before issuing — a VAT invoice must show it.",
  invoice_has_no_lines: "Add at least one line before issuing.",
  invoice_settings_incomplete: "Fill in your business name and address in Invoice settings before issuing.",
  invoice_event_not_live: "That event has been deleted. Choose another event, or none.",
  invoice_entry_not_invoiceable: "One of the lines from event finance can no longer be invoiced — it was deleted, moved or is not income. Reload and try again.",
  invoice_line_invalid: "One of the lines is not valid. Check each description, quantity and price.",
  invoice_lines_invalid: "An invoice can have up to 100 lines.",
  invoice_one_recipient: "Choose one recipient: a company or a contact.",
  invoice_not_issued: "Only an issued invoice can be marked as paid. Reload the page to see where it stands.",
  invoice_paid_on_out_of_range: "Choose a payment date between the issue date and today.",
  invoice_not_voidable: "This invoice can’t be voided. Reload the page to see where it stands.",
  invoice_void_reason_required: "Give a reason for voiding — 500 characters at most.",
  invoice_not_sendable: "Only an issued or paid invoice can be sent.",
  invoice_send_email_invalid: "Enter the email address to send the invoice to.",
  invoice_number_taken: "That invoice number is already used. Change the number prefix in Invoice settings, then issue again.",
  invoice_settings_invalid: "One of the settings is not valid. Check each field and save again.",
};

export function invoiceRefusal(error: { code?: string; hint?: string | null; message: string }): string {
  if (error.hint && Object.hasOwn(INVOICE_REFUSAL_SENTENCES, error.hint)) {
    return INVOICE_REFUSAL_SENTENCES[error.hint];
  }
  if (error.code === "42501") return REFUSED_MESSAGE;
  return FAILED_MESSAGE;
}
