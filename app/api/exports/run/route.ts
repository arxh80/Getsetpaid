import { NextResponse } from "next/server";
import { refuseUnlessRunner } from "@/lib/security/runner-auth";
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
// The credential check is lib/security/runner-auth.ts, shared with the other
// runner routes; this route's secret is EXPORT_RUNNER_SECRET.
//
// A DIFFERENT SECRET FROM THE DIGEST'S, deliberately: leaking one must not
// hand over the other, and this one can be made to read every queued export.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and running
// exports is a side effect.
// ===========================================================================

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseUnlessRunner(request, "EXPORT_RUNNER_SECRET");
  if (refused) return refused;

  const result = await runPendingExportJobs();
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
