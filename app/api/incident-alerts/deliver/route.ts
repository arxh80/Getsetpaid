import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { deliverPendingIncidentAlerts } from "@/lib/email/incident-alerts";
import { deliverLockoutNotifications } from "@/lib/email/lockout-notification";

// ===========================================================================
// POST /api/incident-alerts/deliver
//
// The sessionless entry point for alert email delivery. Since founder ruling
// Q118 the caller is THE DATABASE: pg_cron runs `incident-alert-delivery`
// every 10 minutes, and private.deliver_incident_alerts() (20260916000000)
// pg_net-POSTs here with `Authorization: Bearer
// <INCIDENT_ALERT_DELIVERY_SECRET>`, read from Supabase Vault.
//
// TWO DELIVERIES, ONE CLOCK, INDEPENDENT RESULTS:
//   * the OPERATOR's digest -- one email covering every alert nobody has been
//     emailed about, stamping `notified_at` after ok:true
//     (lib/email/incident-alerts.ts);
//   * the ACCOUNT HOLDER's lockout notice -- one email per locked-out account,
//     stamping `account_notified_at` after ok:true
//     (lib/email/lockout-notification.ts, founder ruling Q114).
// They are deliberately not folded together: different recipients, different
// content, different failure. Each runs even if the other fails, and each
// reports its own outcome in the response body.
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

  // Sequential, not Promise.all: both run as service_role against the same
  // table and a tick has ten minutes; there is nothing to win by racing them
  // and a clearer log by not.
  const digest = await deliverPendingIncidentAlerts();
  const lockouts = await deliverLockoutNotifications();

  const unavailable =
    digest.outcome === "unavailable" || lockouts.outcome === "unavailable";
  return NextResponse.json(
    { ...digest, accountNotifications: lockouts },
    {
      status: unavailable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
