import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess } from "@/lib/crm/finance-access";
import { createClient } from "@/lib/supabase/server";
import { loadReceivedInvoice } from "@/lib/invoices/received";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { renderInvoicePdf } from "@/lib/invoices/pdf/render";
import { payLinkUrl } from "@/lib/stripe/pay-link";

// GET /[orgSlug]/invoices/received/[deliveryId]/pdf. THE ORDER IS THE
// CONTROL: check view_finance in the RECEIVING workspace, then load through
// the definer view public.received_invoices, so another workspace's, a
// withdrawn and an unknown delivery are the same 404; parse the snapshot;
// AUDIT; only then render. Nothing is stored. The filename is the constrained
// invoice number, so no user text reaches the header.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ orgSlug: string; deliveryId: string }> },
): Promise<Response> {
  const { orgSlug, deliveryId } = await ctx.params;
  const org = await getCurrentOrg(orgSlug);
  if (!org || !(await getFinanceReadAccess(org))) return new Response("Not found", { status: 404, headers: NO_STORE });

  const result = await loadReceivedInvoice(org.id, deliveryId);
  if (result.outcome === "missing") return new Response("Not found", { status: 404, headers: NO_STORE });
  if (result.outcome === "unavailable") return new Response("Error", { status: 500, headers: NO_STORE });
  const invoice = result.invoice;

  const snapshot = parseSnapshot(invoice.snapshot);
  if (!snapshot) {
    console.error(`[invoices] received delivery ${deliveryId} has an unreadable snapshot`);
    return new Response("Error", { status: 500, headers: NO_STORE });
  }

  const supabase = await createClient();
  const { error: auditError } = await supabase.rpc("audit_received_invoice_download", { p_delivery_id: deliveryId });
  if (auditError) {
    console.error("[invoices] received PDF download audit failed; refusing the download:", auditError.message);
    return new Response("Error", { status: 500, headers: NO_STORE });
  }

  const pdf = await renderInvoicePdf(snapshot, {
    status: invoice.status,
    payUrl: invoice.cardPaymentEnabled && invoice.status === "issued" ? payLinkUrl(invoice.invoiceId) : null,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${snapshot.number}.pdf"`,
    },
  });
}
