// The invoices list. Newest first on invoices_org_created_id_idx (a draft has
// no number, so the number cannot be the sort). No owner filter: invoices
// are read by view_finance holders, who are all full-scope.
import { defineListSpec } from "@/lib/list/spec";
import type { ListParams } from "@/lib/list/params";
import { INVOICE_STATUSES, INVOICE_STATUS_LABELS, type InvoiceStatus } from "@/lib/invoices/status";

/** A literal. The recipient's name comes through the two composite FKs. */
export const INVOICE_SELECT =
  "id, status, number, gross_minor, issue_date, due_date, created_at, company:companies!invoices_recipient_company_fkey(name), contact:contacts!invoices_recipient_contact_fkey(name)";

export interface InvoiceRow {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  grossMinor: number;
  issueDate: string | null;
  dueDate: string | null;
  createdAt: string;
  recipientName: string | null;
}

function embeddedName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

export function mapInvoiceRow(row: Record<string, unknown>): InvoiceRow {
  return {
    id: String(row.id),
    status: row.status as InvoiceStatus,
    number: (row.number as string | null) ?? null,
    grossMinor: Number(row.gross_minor),
    issueDate: (row.issue_date as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    createdAt: String(row.created_at),
    recipientName: embeddedName(row.company) ?? embeddedName(row.contact),
  };
}

export const INVOICE_LIST = defineListSpec({
  entity: "invoices",
  noun: { one: "invoice", many: "invoices" },
  searchColumn: "number",
  searchLabel: "Search by invoice number",
  sort: {
    created: {
      column: "created_at",
      label: "Created",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "invoices_org_created_id_idx",
    },
  },
  defaultSort: "created",
  filters: {
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...INVOICE_STATUSES.map((s) => ({ value: s, label: INVOICE_STATUS_LABELS[s] })),
      ],
    },
  },
});

export type InvoiceSortKey = keyof (typeof INVOICE_LIST)["sort"];
export type InvoiceFilterKey = keyof (typeof INVOICE_LIST)["filters"];
export type InvoiceParams = ListParams<InvoiceSortKey, InvoiceFilterKey>;
