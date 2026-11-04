import { NextResponse } from "next/server";
import { refuseUnlessRunner } from "@/lib/security/runner-auth";
import { runPendingErasureJobs } from "@/lib/erasure/runner";

// ===========================================================================
// POST /api/erasure/run
//
// The sessionless RETRY entry point for the erasure runner, and the sibling
// of /api/exports/run in every respect but one: what it can be made to do.
//
// The caller is THE DATABASE: pg_cron runs `incident-alert-delivery` every 10
// minutes and private.deliver_erasure_jobs() (20260930006000) pg_net-POSTs
// here with `Authorization: Bearer <ERASURE_RUNNER_SECRET>`, read from
// Supabase Vault.
//
// IT IS NOT THE NORMAL PATH. The request that starts a job nudges the runner
// in-process through `after()`, so an account is gone in seconds. This route
// exists for the job whose nudge died with the process that owed it -- without
// it, somebody who asked to be deleted would wait for ever and nothing would
// say so.
//
// A THIRD SECRET, SEPARATE FROM THE DIGEST'S AND THE EXPORT RUNNER'S, and the
// argument for separation is stronger here than it was there: this one, if it
// leaked, would run queued DELETIONS. It still cannot CHOOSE one -- the route
// takes no argument at all, and every job it can reach is one somebody
// already asked for through a gate this endpoint does not control -- but the
// blast radius of the export secret is "read every queued export" and the
// blast radius of this one is "make already-requested deletions happen
// sooner", and neither should be reachable from the other.
//
// The credential check is lib/security/runner-auth.ts, shared with the other
// runner routes; this route's secret is ERASURE_RUNNER_SECRET.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and running
// erasures is a side effect.
// ===========================================================================

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseUnlessRunner(request, "ERASURE_RUNNER_SECRET");
  if (refused) return refused;

  const result = await runPendingErasureJobs();
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
