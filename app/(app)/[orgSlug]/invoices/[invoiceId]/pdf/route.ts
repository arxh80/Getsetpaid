import { getCurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseSnapshot } from "@/lib/invoices/snapshot";
import { renderInvoicePdf } from "@/lib/invoices/pdf/render";

// GET /[orgSlug]/invoices/[invoiceId]/pdf (spec § PDF). THE ORDER IS THE
// CONTROL: load through the caller's RLS (view_finance) so another tenant's,
// a missing and a draft invoice are the same 404; parse the snapshot; AUDIT;
// only then render. Nothing is stored. The filename is the constrained
// number, so no user text reaches the header.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ orgSlug: string; invoiceId: string }> },
): Promise<Response> {
  const { orgSlug, invoiceId } = await ctx.params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return new Response("Not found", { status: 404, headers: NO_STORE });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select("status, snapshot")
    .eq("organisation_id", org.id)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return new Response("Not found", { status: 404, headers: NO_STORE });
    console.error("[invoices] PDF lookup failed:", error.message);
    return new Response("Error", { status: 500, headers: NO_STORE });
  }
  if (!data || data.status === "draft") return new Response("Not found", { status: 404, headers: NO_STORE });

  const snapshot = parseSnapshot(data.snapshot);
  if (!snapshot) {
    console.error(`[invoices] invoice ${invoiceId} has an unreadable snapshot`);
    return new Response("Error", { status: 500, headers: NO_STORE });
  }

  const { error: auditError } = await supabase.rpc("audit_invoice_download", { p_invoice_id: invoiceId });
  if (auditError) {
    console.error("[invoices] PDF download audit failed; refusing the download:", auditError.message);
    return new Response("Error", { status: 500, headers: NO_STORE });
  }

  const pdf = await renderInvoicePdf(snapshot, { status: data.status as "issued" | "paid" | "void" });
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${snapshot.number}.pdf"`,
    },
  });
}
