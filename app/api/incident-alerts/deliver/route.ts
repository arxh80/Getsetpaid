import { NextResponse } from "next/server";
import { refuseUnlessRunner } from "@/lib/security/runner-auth";
import {
  deliverPendingIncidentAlerts,
  deliverPendingIncidentAlertsToTelegram,
} from "@/lib/email/incident-alerts";
import { deliverLockoutNotifications } from "@/lib/email/lockout-notification";
import {
  deliverDsrNotifications,
  deliverErasureFailureNotifications,
  deliverExportReadyNotifications,
} from "@/lib/email/requester-notifications";
import { deliverConnectionRequestNotifications } from "@/lib/email/network-notifications";
import { deliverTaskReminderNotifications } from "@/lib/email/task-reminder-notifications";
import {
  deliverWorkspaceClosureNotifications,
  deliverWorkspaceDecisionNotifications,
} from "@/lib/email/workspace-closure-notifications";
import {
  deliverInvoiceBankChangeNotifications,
  deliverInvoiceDeliveredNotifications,
  deliverInvoiceStripeAccountNotifications,
} from "@/lib/email/invoice-notifications";

// ===========================================================================
// POST /api/incident-alerts/deliver
//
// The sessionless entry point for alert email delivery. Since founder ruling
// Q118 the caller is THE DATABASE: pg_cron runs `incident-alert-delivery`
// every 10 minutes, and private.deliver_incident_alerts() (20260916000000)
// pg_net-POSTs here with `Authorization: Bearer
// <INCIDENT_ALERT_DELIVERY_SECRET>`, read from Supabase Vault.
//
// EVERY DELIVERY, ONE CLOCK, INDEPENDENT RESULTS: the list is the `settle`
// calls in POST below. Each stamps its own rows only after Brevo (or Telegram)
// accepted the send.
//
// ONE DEADLINE FOR THE ROUTE. Nothing claims a row before sending it, so a run
// still sending when the next tick starts would send its unstamped rows twice.
// Each delivery bounds itself (lockouts ~130 s, the others ~55 s at worst), so
// none STARTS after LAST_START_MS: the run ends by ~530 s, inside the 600 s
// tick, however many deliveries are added. A delivery not started is reported
// `deferred` and its rows wait for the next tick, unstamped.
//
// They are deliberately not folded together: different recipients, different
// content, different failure. Each runs even if the other fails, and each
// reports its own outcome in the response body.
//
// The credential check is lib/security/runner-auth.ts, shared with the other
// runner routes; this route's secret is INCIDENT_ALERT_DELIVERY_SECRET.
//
// POST only: a GET is what a crawler or a browser prefetch sends, and a send
// is a side effect.
// ===========================================================================

/** No delivery starts later than this into the run (see ONE DEADLINE above). */
const LAST_START_MS = 400_000;

async function settle<T>(
  startedAt: number,
  run: () => Promise<T>,
): Promise<T | { readonly outcome: "unavailable"; readonly error: string } | { readonly outcome: "deferred" }> {
  if (Date.now() - startedAt >= LAST_START_MS) {
    console.error("[delivery] the run's start deadline passed; this delivery waits for the next tick");
    return { outcome: "deferred" };
  }
  try {
    return await run();
  } catch (err) {
    const error = err instanceof Error ? err.name : "unknown error";
    console.error(`[delivery] a delivery threw (${error}); the others still ran`);
    return { outcome: "unavailable", error };
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseUnlessRunner(request, "INCIDENT_ALERT_DELIVERY_SECRET");
  if (refused) return refused;

  // Sequential, not Promise.all: both run as service_role against the same
  // table and a tick has ten minutes; there is nothing to win by racing them
  // and a clearer log by not.
  //
  // Each is caught on its own: a THROW from one channel (none is expected --
  // each returns its failure -- but a thrown TypeError is not a returned one)
  // must not skip the next. The email digest runs first and its stamp is
  // written inside its own call, so nothing the Telegram half does afterwards
  // can reach it, and vice versa.
  const startedAt = Date.now();
  const digest = await settle(startedAt, deliverPendingIncidentAlerts);
  const telegram = await settle(startedAt, deliverPendingIncidentAlertsToTelegram);
  const lockouts = await settle(startedAt, deliverLockoutNotifications);
  const dataRequests = await settle(startedAt, deliverDsrNotifications);
  const exportsReady = await settle(startedAt, deliverExportReadyNotifications);
  const erasureFailures = await settle(startedAt, deliverErasureFailureNotifications);
  const connectionRequests = await settle(startedAt, deliverConnectionRequestNotifications);
  const taskReminders = await settle(startedAt, deliverTaskReminderNotifications);
  const workspaceClosures = await settle(startedAt, deliverWorkspaceClosureNotifications);
  const workspaceDecisions = await settle(startedAt, deliverWorkspaceDecisionNotifications);
  const invoiceBankChanges = await settle(startedAt, deliverInvoiceBankChangeNotifications);
  const invoiceStripeAccounts = await settle(startedAt, deliverInvoiceStripeAccountNotifications);
  const invoiceDeliveries = await settle(startedAt, deliverInvoiceDeliveredNotifications);

  const unavailable = [
    digest,
    telegram,
    lockouts,
    dataRequests,
    exportsReady,
    erasureFailures,
    connectionRequests,
    taskReminders,
    workspaceClosures,
    workspaceDecisions,
    invoiceBankChanges,
    invoiceStripeAccounts,
    invoiceDeliveries,
  ].some(
    (r) => r.outcome === "unavailable",
  );
  return NextResponse.json(
    {
      ...digest,
      telegram,
      accountNotifications: lockouts,
      dataRequestNotifications: dataRequests,
      exportReadyNotifications: exportsReady,
      erasureFailureNotifications: erasureFailures,
      connectionRequestNotifications: connectionRequests,
      taskReminderNotifications: taskReminders,
      workspaceClosureNotifications: workspaceClosures,
      workspaceDecisionNotifications: workspaceDecisions,
      invoiceBankChangeNotifications: invoiceBankChanges,
      invoiceStripeAccountNotifications: invoiceStripeAccounts,
      invoiceDeliveredNotifications: invoiceDeliveries,
    },
    {
      status: unavailable ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
