// The Checkout metadata key that carries the invoice id, written by the live gateway
// (lib/stripe/client.ts) and read by the webhook (lib/invoices/stripe-webhook.ts).
// Namespaced because a linked Standard account's own Checkouts may carry a plain
// `invoice_id`. No "server-only": the e2e spec builds events with it.
export const INVOICE_ID_METADATA_KEY = "getsetpaid_invoice_id";
