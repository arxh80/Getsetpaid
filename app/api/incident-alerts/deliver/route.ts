import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { deliverPendingIncidentAlerts } from "@/lib/email/incident-alerts";

// ===========================================================================
// POST /api/incident-alerts/deliver
//
// The sessionless entry point for incident-alert email delivery: an external
// cron calls it with `Authorization: Bearer <INCIDENT_ALERT_DELIVERY_SECRET>`
// and it emails the founder one digest of every alert nobody has been emailed
// about, stamping `notified_at` only after the send succeeds
// (lib/email/incident-alerts.ts carries the contract).
//
// NOT A SESSION ROUTE. lib/supabase/middleware.ts lists this path as public so
// the signed-out bounce does not redirect a cron to /login; the credential is
// the bearer secret, compared in constant time. With the secret UNSET the
// route answers 404 for every caller -- an unconfigured deployment has no
// delivery endpoint at all rather than an open one -- and a wrong secret also
// answers 404, so a prober cannot tell the two apart.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and a send
// is a side effect.
// ===========================================================================

function configuredSecret(): string | null {
  const value = process.env.INCIDENT_ALERT_DELIVERY_SECRET;
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

  const result = await deliverPendingIncidentAlerts();
  return NextResponse.json(result, {
    status: result.outcome === "unavailable" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
