import "server-only";
// THE RECEIVED INVOICES (Invoices part 3): read ONLY through the definer view
// public.received_invoices, whose `id` is the delivery and `organisation_id`
// the RECEIVING workspace (plan decision 1), so lib/list/query.ts's tenant
// clause applies unchanged. Any tier: view_finance in this workspace.
import { defineListSpec } from "@/lib/list/spec";
import { createClient } from "@/lib/supabase/server";
import { INVOICE_STATUS_LABELS } from "@/lib/invoices/status";

export const RECEIVED_SELECT = "id, sender_name, number, status, issue_date, due_date, gross_minor, delivered_at";

const RECEIVED_STATUSES = ["issued", "paid", "void"] as const;
type ReceivedStatus = (typeof RECEIVED_STATUSES)[number];

export interface ReceivedRow {
  id: string;
  senderName: string | null;
  number: string;
  status: ReceivedStatus;
  issueDate: string;
  dueDate: string;
  grossMinor: number;
  deliveredAt: string;
}

export function mapReceivedRow(row: Record<string, unknown>): ReceivedRow {
  return {
    id: String(row.id),
    senderName: (row.sender_name as string | null) ?? null,
    number: String(row.number),
    status: row.status as ReceivedStatus,
    issueDate: String(row.issue_date),
    dueDate: String(row.due_date),
    grossMinor: Number(row.gross_minor),
    deliveredAt: String(row.delivered_at),
  };
}

export const RECEIVED_LIST = defineListSpec({
  entity: "received_invoices",
  noun: { one: "received invoice", many: "received invoices" },
  searchColumn: "sender_name",
  searchLabel: "Search by sender",
  sort: {
    delivered: {
      column: "delivered_at",
      label: "Received",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "invoice_deliveries_to_org_list_idx",
    },
  },
  defaultSort: "delivered",
  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...RECEIVED_STATUSES.map((s) => ({ value: s, label: INVOICE_STATUS_LABELS[s] })),
      ],
    },
  },
});

export type ReceivedSortKey = keyof (typeof RECEIVED_LIST)["sort"];
export type ReceivedFilterKey = keyof (typeof RECEIVED_LIST)["filters"];

export interface ReceivedDetail extends ReceivedRow {
  invoiceId: string;
  snapshot: unknown;
  cardPaymentEnabled: boolean;
}

export async function loadReceivedInvoice(
  organisationId: string,
  deliveryId: string,
): Promise<{ outcome: "loaded"; invoice: ReceivedDetail } | { outcome: "missing" } | { outcome: "unavailable" }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("received_invoices")
    .select(`${RECEIVED_SELECT}, invoice_id, snapshot, card_payment_enabled`)
    .eq("organisation_id", organisationId)
    .eq("id", deliveryId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error("[invoices] received invoice lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };
  const row = data as Record<string, unknown>;
  return {
    outcome: "loaded",
    invoice: {
      ...mapReceivedRow(row),
      invoiceId: String(row.invoice_id),
      snapshot: row.snapshot,
      cardPaymentEnabled: row.card_payment_enabled === true,
    },
  };
}
