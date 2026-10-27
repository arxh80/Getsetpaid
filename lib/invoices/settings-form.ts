// The invoice settings form, read and validated. PURE (no I/O) so it is
// unit-tested; the database CHECKs on public.invoice_settings are the
// enforcement, this is the sentence a person can act on.
import { field } from "@/lib/forms";

export interface SettingsInput {
  businessName: string;
  businessAddress: string;
  vatNumber: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  numberPrefix: string;
  paymentTermsDays: number;
}

const VAT = /^(GB|XI)([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$/;

/** The raw textarea value, trimmed at the ends but keeping its line breaks. */
function multiline(data: FormData, name: string): string | null {
  const raw = data.get(name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  return trimmed === "" ? null : trimmed;
}

export function readSettingsForm(
  formData: FormData,
): { ok: true; values: SettingsInput } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const businessName = field(formData, "businessName");
  if (!businessName) errors.businessName = "Enter the business name that goes on your invoices.";
  else if (businessName.length > 200) errors.businessName = "That name is too long — 200 characters at most.";

  const businessAddress = multiline(formData, "businessAddress");
  if (!businessAddress) errors.businessAddress = "Enter the business address that goes on your invoices.";
  else if (businessAddress.length > 500) errors.businessAddress = "That address is too long — 500 characters at most.";

  const vatRaw = field(formData, "vatNumber");
  const vatNumber = vatRaw ? vatRaw.replace(/\s+/g, "").toUpperCase() : null;
  if (vatNumber && !VAT.test(vatNumber)) {
    errors.vatNumber = "Enter a UK VAT number, for example GB123456789 — or leave it blank if you are not VAT registered.";
  }

  const bankAccountName = field(formData, "bankAccountName");
  const sortRaw = field(formData, "bankSortCode");
  const bankSortCode = sortRaw ? sortRaw.replace(/[\s-]+/g, "") : null;
  const accountRaw = field(formData, "bankAccountNumber");
  const bankAccountNumber = accountRaw ? accountRaw.replace(/\s+/g, "") : null;
  const anyBank = bankAccountName !== null || bankSortCode !== null || bankAccountNumber !== null;
  if (anyBank) {
    if (!bankAccountName) errors.bankAccountName = "Enter the account name, or clear all three bank fields.";
    else if (bankAccountName.length > 140) errors.bankAccountName = "That account name is too long — 140 characters at most.";
    if (!bankSortCode || !/^[0-9]{6}$/.test(bankSortCode)) errors.bankSortCode = "Enter a six-digit sort code.";
    if (!bankAccountNumber || !/^[0-9]{8}$/.test(bankAccountNumber)) errors.bankAccountNumber = "Enter an eight-digit account number.";
  }

  const numberPrefix = (field(formData, "numberPrefix") ?? "").toUpperCase();
  if (!/^[A-Z0-9-]{0,12}$/.test(numberPrefix)) {
    errors.numberPrefix = "Use up to 12 letters, digits or hyphens.";
  }

  const termsRaw = field(formData, "paymentTermsDays") ?? "";
  const paymentTermsDays = /^\d{1,3}$/.test(termsRaw) ? Number(termsRaw) : NaN;
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 120) {
    errors.paymentTermsDays = "Enter a number of days from 0 to 120.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    values: {
      businessName: businessName as string,
      businessAddress: businessAddress as string,
      vatNumber,
      bankAccountName: anyBank ? bankAccountName : null,
      bankSortCode: anyBank ? bankSortCode : null,
      bankAccountNumber: anyBank ? bankAccountNumber : null,
      numberPrefix,
      paymentTermsDays,
    },
  };
}
