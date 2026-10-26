import { NextResponse } from "next/server";
import { issueExportDownloadUrl } from "@/lib/export/download";
import { parsePartParam } from "@/lib/export/contract";

// ===========================================================================
// GET /account/exports/[jobId]/download
//
// The ONE server-mediated way to read an export archive's bytes, for BOTH
// kinds — an account export and a workspace one are downloaded here, because
// the authorisation is the same one in both cases (you asked for it) and a
// second route would be a second place for it to be wrong.
//
// The browser never holds a Storage grant: the `exports` bucket is private
// and `storage.objects` is deny-all fenced for every client role
// (20260927001000 § 3). It asks this handler, which authorises through RLS,
// refuses an expired or unfinished archive, AUDITS the access, and only then
// issues a 60-second signed URL and redirects to it. The order is the
// control and lives in issueExportDownloadUrl; this is the thin HTTP shell.
//
//   302 : to the signed URL, minted only after identity + RLS + expiry +
//         existence + audit.
//   404 : not signed in, not a uuid, not your job, no such job, still
//         running, failed, expired, or a malformed, zero or missing part
//         (`?part=`, Q228; absent means part 1) — indistinguishable on
//         purpose. A malformed part is refused before any lookup.
//   500 : a lookup, audit or signing fault. Never a URL.
//   503 : Storage could not say whether the archive is there (G20), so it is
//         neither a URL nor a claim that the archive does not exist.
//
// A route handler never streams, so this keeps the literal 404
// (DESIGN.md § Error pages, the document download route's own rule).
// ===========================================================================
export async function GET(
  request: Request,
  ctx: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const part = parsePartParam(new URL(request.url).searchParams.get("part"));
  if (part === null) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const { jobId } = await ctx.params;
  const outcome = await issueExportDownloadUrl(jobId, part);

  if (outcome.ok) {
    return new NextResponse(null, {
      status: 302,
      headers: { Location: outcome.url, "Cache-Control": "no-store" },
    });
  }
  if (outcome.status === 503) {
    return new NextResponse("This download is temporarily unavailable. Try again in a minute.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  return new NextResponse(outcome.status === 404 ? "Not found" : "Error", {
    status: outcome.status,
    headers: { "Cache-Control": "no-store" },
  });
}
