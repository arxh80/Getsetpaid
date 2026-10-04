import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  deliverPendingIncidentAlerts,
  deliverPendingIncidentAlertsToTelegram,
} from "@/lib/email/incident-alerts";
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
// THREE DELIVERIES, ONE CLOCK, INDEPENDENT RESULTS:
//   * the OPERATOR's digest -- one email covering every alert nobody has been
//     emailed about, stamping `notified_at` after ok:true
//     (lib/email/incident-alerts.ts);
//   * the OPERATOR's Telegram alert (founder 2026-09-30, Q111) -- one
//     counts-only message, stamping its OWN column `telegram_notified_at`
//     after ok:true, a no-op when TELEGRAM_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID
//     are unset (same module, 20261014000000);
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

async function settle<T>(
  run: () => Promise<T>,
): Promise<T | { readonly outcome: "unavailable"; readonly error: string }> {
  try {
    return await run();
  } catch (err) {
    const error = err instanceof Error ? err.name : "unknown error";
    console.error(`[delivery] a delivery threw (${error}); the others still ran`);
    return { outcome: "unavailable", error };
  }
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
  //
  // Each is caught on its own: a THROW from one channel (none is expected --
  // each returns its failure -- but a thrown TypeError is not a returned one)
  // must not skip the next. The email digest runs first and its stamp is
  // written inside its own call, so nothing the Telegram half does afterwards
  // can reach it, and vice versa.
  const digest = await settle(deliverPendingIncidentAlerts);
  const telegram = await settle(deliverPendingIncidentAlertsToTelegram);
  const lockouts = await settle(deliverLockoutNotifications);

  const unavailable =
    digest.outcome === "unavailable" ||
    telegram.outcome === "unavailable" ||
    lockouts.outcome === "unavailable";
  return NextResponse.json(
    { ...digest, telegram, accountNotifications: lockouts },
    {
      status: unavailable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
