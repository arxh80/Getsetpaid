import { NextResponse } from "next/server";
import { refuseUnlessRunner } from "@/lib/security/runner-auth";
import { runRetentionSweep } from "@/lib/retention/runner";

// ===========================================================================
// POST /api/retention/run
//
// The sessionless entry point for the retention runner, and the sibling of
// /api/exports/run and /api/erasure/run in every respect but one: it is the
// ONLY way in. Those two are a retry behind an in-process nudge; nobody is
// waiting for a garbage collection, so there is no nudge and this is the
// whole mechanism.
//
// The caller is THE DATABASE: pg_cron runs `incident-alert-delivery` every 10
// minutes, and private.deliver_retention_sweep() (20261003005000) pg_net-POSTs
// here with `Authorization: Bearer <RETENTION_RUNNER_SECRET>`, read from
// Supabase Vault -- but only when the last run began more than an hour ago,
// so the sweep runs about hourly on a ten-minute clock without a second
// scheduler.
//
// A FOURTH SECRET, SEPARATE FROM THE OTHER THREE, and the argument for
// separation is at its strongest here: the erasure secret, if it leaked,
// would make already-requested deletions happen sooner. THIS ONE RUNS THE
// SWEEP THAT DELETES THE AUDIT LOG. It still cannot choose what to delete --
// the route takes no argument but `dry`, every period is declared in the
// database, and the audit purge behind it carries a hard floor, a kill switch
// and a sanity ceiling that this endpoint cannot touch -- but the blast radii
// are different and neither should be reachable from the other.
//
// `{"dry": true}` runs the preview: every sweep counts what it would delete
// and deletes nothing, including objects. It is accepted from this endpoint
// because the endpoint is already the runner's own credential, and a preview
// is strictly less than what the same credential can already do.
//
// The credential check is lib/security/runner-auth.ts, shared with the other
// runner routes; this route's secret is RETENTION_RUNNER_SECRET.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and running
// a garbage collection is a side effect.
// ===========================================================================

/** `{"dry": true}` and nothing else. An unparseable body is a live run,
 *  which is what the cron sends (`{}`) -- never the other way round, so a
 *  malformed request cannot silently turn a scheduled sweep into a preview
 *  that deletes nothing for ever. */
async function wantsDryRun(request: Request): Promise<boolean> {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null && (body as { dry?: unknown }).dry === true;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseUnlessRunner(request, "RETENTION_RUNNER_SECRET");
  if (refused) return refused;

  const result = await runRetentionSweep({ dry: await wantsDryRun(request) });
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
