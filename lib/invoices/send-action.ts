"use server";
// Send an issued or paid invoice by email with its PDF attached (spec § Send).
// ORDER IS THE CONTROL: authorise; validate the address; load the invoice
// through RLS (issued or paid); SPEND THE BUDGET (invoice_send, 30/h/user,
// SECURITY.md § 5) -- after the cheap refusals, before any work; render the
// PDF from the snapshot; hand it to Brevo; only after Brevo accepted it,
// record the send (public.record_invoice_send audits it). A failed send
// records nothing; a recorded send that the database then refuses is
// reported as sent-but-not-logged, never as a failure to send.
import { revalidatePath } from "next/cache";
import { getCurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, isValidEmail, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { formatRetryAfter } from "@/lib/format/duration";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { renderInvoicePdf } from "@/lib/invoices/pdf/render";
import { invoiceRefusal } from "@/lib/invoices/refusals";
import { sendEmail } from "@/lib/email/send";
import { buildInvoiceEmail } from "@/lib/email/invoice-templates";

const SEND_FAILED = "We couldn’t send that email just now. Nothing was sent. Try again in a moment.";
const SENT_NOT_RECORDED =
  "The email was sent, but we couldn’t record it in the send history. Don’t send it again — reload the page.";

export async function sendInvoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = echoedValues(formData);
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org) return { error: FAILED_MESSAGE, values };
  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) return { error: access.explanation, values };

  const invoiceId = field(formData, "invoiceId");
  const toEmail = field(formData, "toEmail");
  if (!invoiceId) return { error: FAILED_MESSAGE, values };
  if (!toEmail || !isValidEmail(toEmail)) {
    return { fieldErrors: { toEmail: "Enter the email address to send the invoice to." }, values };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select("status, snapshot")
    .eq("organisation_id", org.id)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error || !data) return { error: REFUSED_MESSAGE, values };
  if (data.status !== "issued" && data.status !== "paid") {
    return { error: invoiceRefusal({ hint: "invoice_not_sendable", message: "" }), values };
  }
  const snapshot = parseSnapshot(data.snapshot);
  if (!snapshot) return { error: FAILED_MESSAGE, values };

  const budget = await consumeRateLimit("invoice_send");
  if (!budget.allowed) {
    return {
      error: `You’ve sent as many invoices as allowed for now — nothing is wrong. Try again in ${formatRetryAfter(budget.retryAfterSeconds)}.`,
      values,
    };
  }

  const pdf = await renderInvoicePdf(snapshot, { status: data.status });
  const body = buildInvoiceEmail({
    number: snapshot.number,
    sellerName: snapshot.seller.name,
    recipientName: snapshot.recipient.name,
    grossMinor: snapshot.totals.grossMinor,
    dueDate: snapshot.dueDate,
    bank: snapshot.seller.bank,
  });
  const sent = await sendEmail({
    to: [{ email: toEmail }],
    subject: body.subject,
    html: body.html,
    text: body.text,
    attachments: [{ name: `${snapshot.number}.pdf`, contentBase64: pdf.toString("base64") }],
  });
  if (!sent.ok) {
    // The invoice id, never the address (a log is read by more people than the database).
    console.error(`[invoices] email of invoice ${invoiceId} failed:`, sent.error);
    return { error: SEND_FAILED, values };
  }

  const { error: recordError } = await supabase.rpc("record_invoice_send", {
    p_invoice_id: invoiceId,
    p_to_email: toEmail,
    p_provider_message_id: sent.messageId || null,
  });
  if (recordError) {
    console.error(`[invoices] invoice ${invoiceId} was emailed but not recorded:`, recordError.message);
    return { error: SENT_NOT_RECORDED, values };
  }
  revalidatePath(`/${org.slug}/invoices/${invoiceId}`);
  return { message: `Sent to ${toEmail}.` };
}
