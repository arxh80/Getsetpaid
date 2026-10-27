import { StatusChip } from "@/components/ui/ruled-row";
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from "@/lib/invoices/status";

// The label is the signal; the tone only reinforces it (DESIGN.md: never colour alone).
const TONE = { draft: "revoked", issued: "pending", paid: "active", void: "revoked" } as const;

export function InvoiceStatusChip({ status }: { status: InvoiceStatus }) {
  return <StatusChip tone={TONE[status]}>{INVOICE_STATUS_LABELS[status]}</StatusChip>;
}
