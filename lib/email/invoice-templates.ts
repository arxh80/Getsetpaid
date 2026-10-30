// INVOICE EMAILS, AS PURE BUILDERS WITH AN ALLOWLIST (no I/O; tests/unit/email
// drives it). Task 8: the bank-details-changed notice to a workspace's Owners
// and Admins -- the spec's bank-detail fraud guard. Task 11 adds the invoice
// email itself. Never the full account number: the last four digits only,
// which is what the audit row carries.
import type { EmailBody } from "@/lib/email/templates";
import { NoticeContentError } from "@/lib/email/requester-templates";
import { assertInputAllowlisted, assertOnlyLink, oneLine, origin, render, slugOrRefuse, ukDateTime } from "@/lib/email/notice-render";
import { escapeHtml } from "@/lib/email/templates";
import { formatGbp } from "@/lib/format/money";
import { formatDateOnly } from "@/lib/format/date";
import type { InvoiceSnapshot } from "@/lib/invoices/snapshot";

export const INVOICE_NOTICE_ALLOWLIST = {
  bankDetailsChanged: ["organisationSlug", "organisationName", "accountLast4", "changedAt", "siteUrl"],
} as const;

export interface BankDetailsChangedInput {
  readonly organisationSlug: string;
  readonly organisationName: string;
  readonly accountLast4: string | null;
  readonly changedAt: string;
  readonly siteUrl: string;
}

export function buildBankDetailsChangedNotice(input: BankDetailsChangedInput): EmailBody {
  assertInputAllowlisted("bankDetailsChanged", INVOICE_NOTICE_ALLOWLIST.bankDetailsChanged, input);
  const slug = slugOrRefuse("bankDetailsChanged", input.organisationSlug);
  if (input.accountLast4 !== null && !/^\d{4}$/.test(input.accountLast4)) {
    throw new NoticeContentError("bankDetailsChanged notice refused: last four is not four digits");
  }
  const name = oneLine(input.organisationName, 120);
  const label = name ? `“${name}” (${slug})` : slug;
  const link = `${origin(input.siteUrl)}/${slug}/settings/invoicing`;
  const what =
    input.accountLast4 === null
      ? "The bank details printed on its invoices were removed."
      : `Its invoices now ask to be paid into the account ending ${input.accountLast4}.`;
  const body = render(
    `[GetSetPaid] The bank details on ${slug}'s invoices were changed`,
    [
      `The bank details on invoices from the workspace ${label} were changed on ${ukDateTime(input.changedAt)}.`,
      what,
      "If you expected this, there is nothing to do. If you did not, open the invoice settings now and check them before another invoice is sent.",
    ],
    link,
    "Open invoice settings",
  );
  assertOnlyLink("bankDetailsChanged", body, link);
  return body;
}

const INVOICE_NUMBER = /^[A-Z0-9-]{0,12}[0-9]{4,10}$/;

export interface InvoiceEmailInput {
  readonly number: string;
  readonly sellerName: string;
  readonly recipientName: string;
  readonly grossMinor: number;
  readonly dueDate: string;
  readonly bank: InvoiceSnapshot["seller"]["bank"];
}

/** The invoice email to the customer: plain, no link (the PDF is attached),
 *  every person's text one line and neutralised. */
export function buildInvoiceEmail(input: InvoiceEmailInput): EmailBody {
  if (!INVOICE_NUMBER.test(input.number)) throw new NoticeContentError("invoice email refused: bad number");
  const seller = oneLine(input.sellerName, 120);
  const recipient = oneLine(input.recipientName, 120);
  const paragraphs = [
    `Dear ${recipient},`,
    `Please find attached invoice ${input.number} from ${seller} for ${formatGbp(input.grossMinor)}, due on ${formatDateOnly(input.dueDate)}.`,
    input.bank
      ? `Please pay by bank transfer to ${oneLine(input.bank.accountName, 140)}, sort code ${input.bank.sortCode}, account number ${input.bank.accountNumber}, quoting ${input.number}.`
      : `Please contact ${seller} for payment details, quoting ${input.number}.`,
    `Sent on behalf of ${seller} by GetSetPaid.`,
  ];
  return {
    subject: `Invoice ${input.number} from ${seller}`,
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
  };
}
