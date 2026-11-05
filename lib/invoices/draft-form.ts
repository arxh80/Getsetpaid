// The draft editor's form, read and validated. PURE. The database
// (public.save_invoice_draft) re-checks everything that matters; this is
// the sentence beside the field. Lines arrive as five parallel repeated
// fields, one entry per line in order; ragged arrays mean a tampered form.
import { field } from "@/lib/forms";
import { parseGbpDetailed } from "@/lib/format/money";
import { formatQuantity, isVatRate, lineAmounts, parseQuantity, type VatRate } from "@/lib/invoices/arithmetic";

export const MAX_LINES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DraftLine {
  description: string;
  quantity: string;
  unitPriceMinor: number;
  vatRate: VatRate;
  financialEntryId: string | null;
}

export interface DraftInput {
  recipient: { kind: "company" | "contact"; id: string } | null;
  eventId: string | null;
  recipientAddress: string | null;
  supplyDate: string | null;
  notes: string | null;
  lines: DraftLine[];
}

function isCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function multiline(data: FormData, name: string): string | null {
  const raw = data.get(name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  return trimmed === "" ? null : trimmed;
}

const strings = (data: FormData, name: string) =>
  data.getAll(name).map((v) => (typeof v === "string" ? v.trim() : ""));

export function readDraftForm(
  formData: FormData,
): { ok: true; draft: DraftInput } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};

  let recipient: DraftInput["recipient"] = null;
  const recipientRaw = field(formData, "recipient");
  if (recipientRaw) {
    const match = /^(company|contact):(.+)$/.exec(recipientRaw);
    if (match && UUID.test(match[2])) recipient = { kind: match[1] as "company" | "contact", id: match[2] };
    else errors.recipient = "Choose a recipient from the list.";
  }

  const eventId = field(formData, "eventId");
  if (eventId && !UUID.test(eventId)) errors.eventId = "Choose an event from the list.";

  const recipientAddress = multiline(formData, "recipientAddress");
  if (recipientAddress && recipientAddress.length > 500) {
    errors.recipientAddress = "That address is too long — 500 characters at most.";
  }

  const supplyDate = field(formData, "supplyDate");
  if (supplyDate && !isCalendarDate(supplyDate)) errors.supplyDate = "That doesn’t look like a date.";

  const notes = multiline(formData, "notes");
  if (notes && notes.length > 2000) errors.notes = "Those notes are too long — 2,000 characters at most.";

  const descriptions = strings(formData, "line_description");
  const quantities = strings(formData, "line_quantity");
  const prices = strings(formData, "line_unit_price");
  const rates = strings(formData, "line_vat_rate");
  const entries = strings(formData, "line_entry_id");
  const lines: DraftLine[] = [];
  const n = descriptions.length;
  if ([quantities, prices, rates, entries].some((a) => a.length !== n)) {
    errors.lines = "The lines didn’t arrive intact. Reload the page and try again.";
  } else if (n > MAX_LINES) {
    errors.lines = `An invoice can have up to ${MAX_LINES} lines.`;
  } else {
    for (let i = 0; i < n; i++) {
      const description = descriptions[i];
      if (description === "") errors[`line_${i}_description`] = "Describe this line.";
      else if (description.length > 500) errors[`line_${i}_description`] = "500 characters at most.";
      const q = parseQuantity(quantities[i]);
      if (q === null) errors[`line_${i}_quantity`] = "A quantity above zero, up to two decimal places.";
      const price = parseGbpDetailed(prices[i] === "" ? null : prices[i]);
      if (!price.ok) errors[`line_${i}_unit_price`] = "A price in pounds, up to two decimal places.";
      const rate = rates[i];
      if (!isVatRate(rate)) errors[`line_${i}_vat_rate`] = "Choose a VAT rate from the list.";
      const entry = entries[i] === "" ? null : entries[i];
      if (entry !== null && !UUID.test(entry)) errors.lines = "The lines didn’t arrive intact. Reload the page and try again.";
      if (q !== null && price.ok && isVatRate(rate)) {
        try {
          lineAmounts(q, price.minor, rate);
          lines.push({ description, quantity: formatQuantity(q), unitPriceMinor: price.minor, vatRate: rate, financialEntryId: entry });
        } catch {
          errors[`line_${i}_unit_price`] = "That line’s total is too large.";
        }
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, draft: { recipient, eventId, recipientAddress, supplyDate, notes, lines } };
}

// THE EDITOR'S LINE SHAPE, here rather than in components/invoices/invoice-editor.tsx:
// that file is "use client", so a server page importing a VALUE from it gets a
// client reference, not the object (spreading EMPTY_LINE there gave undefined
// fields and a crash in parseQuantity).
export interface EditorLine { description: string; quantity: string; unitPrice: string; vatRate: VatRate; entryId: string }
export interface EditorInitial {
  recipient: string;
  eventId: string;
  recipientAddress: string;
  supplyDate: string;
  notes: string;
  lines: EditorLine[];
}
export const EMPTY_LINE: EditorLine = { description: "", quantity: "1", unitPrice: "", vatRate: "standard_20", entryId: "" };

/** The one explanation note every disabled invoice control points at (aria-describedby). */
export const BLOCKED_NOTE_ID = "invoice-blocked";
