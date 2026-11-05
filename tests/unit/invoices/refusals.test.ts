import { describe, expect, it } from "vitest";
import { INVOICE_REFUSAL_SENTENCES, invoiceRefusal } from "@/lib/invoices/refusals";
import { FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";

describe("invoiceRefusal", () => {
  it("maps every RPC hint the migrations raise to its sentence", () => {
    for (const hint of [
      "plan_does_not_include_invoicing", "invoice_not_a_draft", "invoice_not_an_editable_draft",
      "invoice_needs_a_recipient", "invoice_recipient_deleted", "invoice_recipient_not_live",
      "invoice_needs_recipient_address", "invoice_has_no_lines", "invoice_settings_incomplete",
      "invoice_event_not_live", "invoice_entry_not_invoiceable", "invoice_line_invalid",
      "invoice_lines_invalid", "invoice_one_recipient", "invoice_not_issued",
      "invoice_paid_on_out_of_range", "invoice_not_voidable", "invoice_void_reason_required",
      "invoice_not_sendable", "invoice_send_email_invalid", "invoice_number_taken",
      "invoice_settings_invalid",
    ]) {
      expect(INVOICE_REFUSAL_SENTENCES[hint], hint).toBeTruthy();
      expect(invoiceRefusal({ code: "22023", hint, message: "x" })).toBe(INVOICE_REFUSAL_SENTENCES[hint]);
    }
  });
  it("an unmapped 42501 (forbidden) is the generic refusal; anything else the generic failure", () => {
    expect(invoiceRefusal({ code: "42501", hint: "forbidden", message: "x" })).toBe(REFUSED_MESSAGE);
    expect(invoiceRefusal({ code: "XX000", message: "boom" })).toBe(FAILED_MESSAGE);
  });
});
