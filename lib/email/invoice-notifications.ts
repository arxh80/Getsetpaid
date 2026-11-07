import "server-only";
// THE BANK-CHANGE NOTICE (Invoices part 1, spec § Security 2) and its sibling,
// THE STRIPE-ACCOUNT NOTICE (Invoices part 2: a link or an end), through the ONE
// Brevo sender, on the existing delivery tick. Database halves: 20261107004000
// and 20261110001000 (the resolvers, the ledger notices). Same loop, stamps and bounds as
// lib/email/workspace-closure-notifications.ts: one email per audit row, its
// recipients Bcc'd by deliverEach, the stamp written only after ok:true.
import {
  deliverEach,
  REQUESTER_NOTICE_LIMIT,
  type NoticeRefusal,
  type Pending,
  type RequesterNoticeResult,
} from "@/lib/email/requester-notifications";
import type { EmailBody } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import { buildBankDetailsChangedNotice, buildStripeAccountChangedNotice } from "@/lib/email/invoice-templates";

/** What every resolver row carries; each notice adds its own fields. */
interface NoticeRow {
  readonly audit_event_id: string;
  readonly emails: string[] | null;
}

/**
 * The one sender both notices share: read the resolver, build one email per
 * audit row, stamp it only after Brevo accepted it, record a deterministic
 * refusal once. `build` names the row's fields one by one -- never a spread.
 */
async function deliverAuditNotices<Row extends NoticeRow>(spec: {
  readonly resolver: string;
  readonly notice: string;
  /** Names the notice in the log line. */
  readonly label: string;
  readonly build: (row: Row, origin: string) => EmailBody;
  readonly limit: number;
}): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc(spec.resolver, {
    p_limit: Math.max(1, Math.min(spec.limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error(`[email] ${spec.label}s could not be read:`, error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as Row[]).map((row): Pending => ({
    id: row.audit_event_id,
    to: row.emails ?? [],
    build: () => spec.build(row, origin),
    stamp: async () => {
      const { data: stamped, error: stampError } = await createServiceClient().rpc("mark_notices_delivered", {
        p_notice: spec.notice,
        p_subject_ids: [row.audit_event_id],
      });
      if (stampError) return { error: { message: stampError.message } };
      if (stamped !== 1) return { error: { message: `stamped ${String(stamped)} of 1` } };
      return { error: null };
    },
    refuse: async (reason: NoticeRefusal) => {
      const { error: refuseError } = await createServiceClient().rpc("mark_notices_undeliverable", {
        p_notice: spec.notice,
        p_subject_ids: [row.audit_event_id],
        p_reason: reason,
      });
      return { error: refuseError ? { message: refuseError.message } : null };
    },
  }));
  return deliverEach(spec.label, rows);
}

interface BankChangeRow extends NoticeRow {
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly account_last4: string | null;
  readonly changed_at: string;
}

export function deliverInvoiceBankChangeNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  return deliverAuditNotices<BankChangeRow>({
    resolver: "pending_invoice_bank_change_notifications",
    notice: "invoice_bank_details_changed",
    label: "invoice bank-change notice",
    limit,
    // FIVE FIELDS, by name -- never a spread of the row.
    build: (row, origin) =>
      buildBankDetailsChangedNotice({
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        accountLast4: row.account_last4,
        changedAt: row.changed_at,
        siteUrl: origin,
      }),
  });
}

interface StripeAccountRow extends NoticeRow {
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly change: string;
  readonly changed_at: string;
}

/** No account id ever reaches it: the resolver does not return one. */
export function deliverInvoiceStripeAccountNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  return deliverAuditNotices<StripeAccountRow>({
    resolver: "pending_invoice_stripe_account_notifications",
    notice: "invoice_stripe_account_changed",
    label: "invoice Stripe-account notice",
    limit,
    // FIVE FIELDS, by name. An unknown `change` is refused by the builder.
    build: (row, origin) =>
      buildStripeAccountChangedNotice({
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        change: row.change as "linked" | "ended",
        changedAt: row.changed_at,
        siteUrl: origin,
      }),
  });
}
