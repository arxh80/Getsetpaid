import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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
// The incident-digest route's credential rules, verbatim and for the same
// reasons: lib/supabase/middleware.ts lists this path as public so the
// signed-out bounce does not redirect a cron to /login; the credential is the
// bearer secret, compared in constant time; with the secret UNSET the route
// answers 404 for every caller -- an unconfigured deployment has no runner
// endpoint at all rather than an open one -- and a wrong secret answers 404
// too, so a prober cannot tell the two apart.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and running
// erasures is a side effect.
// ===========================================================================

function configuredSecret(): string | null {
  const value = process.env.ERASURE_RUNNER_SECRET;
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

  const result = await runPendingErasureJobs();
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
