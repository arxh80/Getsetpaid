import { NextResponse } from "next/server";
import { issueFeedbackScreenshotUrl } from "@/lib/feedback/screenshot";

// ===========================================================================
// GET /super/feedback/[feedbackId]/screenshot
//
// The one way a feedback screenshot's bytes are ever read: the superuser
// follows this link, the handler authorises through RLS, refuses anything but
// a `clean` scan verdict, WRITES THE AUDIT ROW, and only then issues a
// 60-second signed URL and redirects to it. Order and reasoning live in
// lib/feedback/screenshot.ts; this is the thin HTTP shell, the document
// download route's twin.
//
//   302 : to the signed URL (minted after identity + RLS + verdict + audit)
//   404 : not the superuser, no such row, outside retention, no screenshot --
//         indistinguishable on purpose
//   409 : the screenshot exists and is withheld (quarantined / unscanned)
//   500 : the audit or the signing failed -- never a URL
//
// A route handler never streams, so this keeps the literal 404
// (DESIGN.md § Error pages, the download route's own rule).
// ===========================================================================
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ feedbackId: string }> },
): Promise<NextResponse> {
  const { feedbackId } = await ctx.params;
  const outcome = await issueFeedbackScreenshotUrl(feedbackId);

  if (outcome.ok) {
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
  return new NextResponse(outcome.status === 404 ? "Not found" : "Error", {
    status: outcome.status,
    headers: { "Cache-Control": "no-store" },
  });
}
