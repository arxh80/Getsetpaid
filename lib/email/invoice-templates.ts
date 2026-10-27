// INVOICE EMAILS, AS PURE BUILDERS WITH AN ALLOWLIST (no I/O; tests/unit/email
// drives it). Task 8: the bank-details-changed notice to a workspace's Owners
// and Admins -- the spec's bank-detail fraud guard. Task 11 adds the invoice
// email itself. Never the full account number: the last four digits only,
// which is what the audit row carries.
import type { EmailBody } from "@/lib/email/templates";
import { NoticeContentError } from "@/lib/email/requester-templates";
import { assertInputAllowlisted, assertOnlyLink, oneLine, origin, render, slugOrRefuse, ukDateTime } from "@/lib/email/notice-render";

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
