import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runPendingExportJobs } from "@/lib/export/runner";

// ===========================================================================
// POST /api/exports/run
//
// The sessionless RETRY entry point for the export runner. The caller is THE
// DATABASE: pg_cron runs `incident-alert-delivery` every 10 minutes and
// private.deliver_export_jobs() (20260927004000) pg_net-POSTs here with
// `Authorization: Bearer <EXPORT_RUNNER_SECRET>`, read from Supabase Vault.
//
// IT IS NOT THE NORMAL PATH. The request that starts a job nudges the runner
// in-process through `after()`, so an export is ready in seconds. This route
// exists for the job whose nudge died with the process that owed it — without
// it, a person who asked for a copy of their data would wait for ever and
// nothing would say so.
//
// The incident-digest route's credential rules, verbatim and for the same
// reasons: lib/supabase/middleware.ts lists this path as public so the
// signed-out bounce does not redirect a cron to /login; the credential is the
// bearer secret, compared in constant time; with the secret UNSET the route
// answers 404 for every caller — an unconfigured deployment has no runner
// endpoint at all rather than an open one — and a wrong secret answers 404
// too, so a prober cannot tell the two apart.
//
// A DIFFERENT SECRET FROM THE DIGEST'S, deliberately: leaking one must not
// hand over the other, and this one can be made to read every queued export.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and running
// exports is a side effect.
// ===========================================================================

function configuredSecret(): string | null {
  const value = process.env.EXPORT_RUNNER_SECRET;
  return value && value.trim().length >= 32 ? value.trim() : null;
}

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = configuredSecret();
  if (!secret || !bearerMatches(request.headers.get("authorization"), secret)) {
    return new NextResponse("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const result = await runPendingExportJobs();
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
