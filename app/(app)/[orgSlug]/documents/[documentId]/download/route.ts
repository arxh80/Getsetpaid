import { NextResponse } from "next/server";
import { issueDownloadUrl } from "@/lib/crm/documents";

// ===========================================================================
// GET /[orgSlug]/documents/[documentId]/download
//
// The one server-mediated way to read a document's bytes. The browser never
// holds a Storage grant (storage.objects is deny-all fenced, 20260902030000);
// it asks this handler, which authorises the caller through RLS, refuses
// anything but a `clean` document, AUDITS the access, and only then issues a
// 60-second signed URL and redirects to it. All of that logic — and the ORDER,
// which is the control (Global Constraint 12: refusing the signed URL is the
// control, not hiding a link) — lives in issueDownloadUrl; this handler is the
// thin HTTP shell that maps its typed outcome to a status code.
//
//   200-path : 302 to the short-lived signed URL (the browser follows it and
//              the file downloads). The URL is minted only after auth + audit.
//   404      : cross-tenant id, a soft-deleted or absent document, an org the
//              caller is not a member of, or no session — all indistinguishable
//              on purpose, so the endpoint is not an existence oracle.
//   409      : the document exists but is withheld — still scanning, or
//              quarantined. THE QUARANTINE GATE.
//   500      : a lookup, audit or signing fault. Never a URL.
//
// A signed URL in a Location header is standard for a private download and is
// safe here because it expires in 60s; there is no page to render and nothing
// tenant-private in the response but the redirect target itself.
// ===========================================================================
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ orgSlug: string; documentId: string }> },
): Promise<NextResponse> {
  const { orgSlug, documentId } = await ctx.params;

  const outcome = await issueDownloadUrl(orgSlug, documentId);

  if (outcome.ok) {
    // 302 See Other-style redirect to the signed URL. Not cached — the URL is
    // single-use-ish and short-lived, and must not be stored by an intermediary.
    return new NextResponse(null, {
      status: 302,
      headers: { Location: outcome.url, "Cache-Control": "no-store" },
    });
  }

  if (outcome.status === 409) {
    return new NextResponse(outcome.reason, {
      status: 409,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // 404 and 500 carry no detail — a 404 must not distinguish "not yours" from
  // "not there", and a 500 leaks nothing about why.
  return new NextResponse(outcome.status === 404 ? "Not found" : "Error", {
    status: outcome.status,
    headers: { "Cache-Control": "no-store" },
  });
}
