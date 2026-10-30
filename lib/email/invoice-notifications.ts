import "server-only";
// THE BANK-CHANGE NOTICE (Invoices part 1, spec § Security 2) through the ONE
// Brevo sender, on the existing delivery tick. Database half: 20261106004000
// (the resolver, the ledger notice). Same loop, stamps and bounds as
// lib/email/workspace-closure-notifications.ts: one email per audit row, its
// recipients Bcc'd by deliverEach, the stamp written only after ok:true.
import {
  deliverEach,
  REQUESTER_NOTICE_LIMIT,
  type NoticeRefusal,
  type Pending,
  type RequesterNoticeResult,
} from "@/lib/email/requester-notifications";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import { buildBankDetailsChangedNotice } from "@/lib/email/invoice-templates";

const NOTICE = "invoice_bank_details_changed";

interface PendingRow {
  readonly audit_event_id: string;
  readonly emails: string[] | null;
  readonly organisation_slug: string;
  readonly organisation_name: string;
  readonly account_last4: string | null;
  readonly changed_at: string;
}

export async function deliverInvoiceBankChangeNotifications(
  limit: number = REQUESTER_NOTICE_LIMIT,
): Promise<RequesterNoticeResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("pending_invoice_bank_change_notifications", {
    p_limit: Math.max(1, Math.min(limit, REQUESTER_NOTICE_LIMIT)),
  });
  if (error) {
    console.error("[email] invoice bank-change notices could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }
  const origin = siteUrl();
  const rows = ((data ?? []) as PendingRow[]).map((row): Pending => ({
    id: row.audit_event_id,
    to: row.emails ?? [],
    // FIVE FIELDS, by name -- never a spread of the row.
    build: () =>
      buildBankDetailsChangedNotice({
        organisationSlug: row.organisation_slug,
        organisationName: row.organisation_name,
        accountLast4: row.account_last4,
        changedAt: row.changed_at,
        siteUrl: origin,
      }),
    stamp: async () => {
      const { data: stamped, error: stampError } = await createServiceClient().rpc("mark_notices_delivered", {
        p_notice: NOTICE,
        p_subject_ids: [row.audit_event_id],
      });
      if (stampError) return { error: { message: stampError.message } };
      if (stamped !== 1) return { error: { message: `stamped ${String(stamped)} of 1` } };
      return { error: null };
    },
    refuse: async (reason: NoticeRefusal) => {
      const { error: refuseError } = await createServiceClient().rpc("mark_notices_undeliverable", {
        p_notice: NOTICE,
        p_subject_ids: [row.audit_event_id],
        p_reason: reason,
      });
      return { error: refuseError ? { message: refuseError.message } : null };
    },
  }));
  return deliverEach("invoice bank-change notice", rows);
}
