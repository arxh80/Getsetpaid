export const INVOICE_STATUSES = ["draft", "issued", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  paid: "Paid",
  void: "Void",
};
export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value);
}
