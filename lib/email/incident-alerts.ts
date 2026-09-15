import "server-only";

// Incident-alert delivery -- the second consumer of the ONE Brevo sender, and
// the thing Task 5 built `incident_alerts.notified_at` for (Q91).
//
// ===========================================================================
// THE SEAM, AS TASK 5 LEFT IT, AND WHAT THIS DOES WITH IT
// ===========================================================================
// `notified_at` is null on every alert nobody has been emailed about; it sits
// in the resolution guard's IMMUTABLE set so the operator's browser can never
// stamp it; and since 20260909070000 `service_role` holds `select` on the
// table and `update` on that ONE column. So this runs as service_role, with
// no session, reads `where notified_at is null`, sends, and stamps -- and
// stamps ONLY the rows a successful send actually carried, ONLY after
// `sendEmail()` answered ok:true. A failed send stamps nothing and returns
// `failed`; the rows stay exactly as they were and the next run picks them
// up. That is the "re-sendable, never swallowed" contract the send.ts
// docstring demands, and it is why the stamp is the last statement here.
//
// ONE DIGEST PER RUN (lib/email/templates.ts explains): the feed is floodable
// (Q117) and one email per alert would flood the inbox in step with it.
//
// ===========================================================================
// WHO CALLS THIS, AND WHEN -- HONESTLY
// ===========================================================================
// THE DATABASE DOES, every 10 minutes, since Task 6c (founder ruling Q118).
// `pg_cron` runs the job `incident-alert-delivery`, which calls
// private.deliver_incident_alerts() (20260916000000); that function reads the
// route's URL and bearer from Supabase Vault and `pg_net`-POSTs
// app/api/incident-alerts/deliver/route.ts. This is the product's ONLY
// scheduler -- everything else here uses read-time expiry, and an email cannot
// be read-time.
//
// IT IS A NO-OP WHEREVER THE VAULT ENTRIES ARE ABSENT, which is every
// environment this repository can reach: local dev and CI register the job and
// the function returns before it builds a request. So "nothing arrives locally"
// is the designed behaviour, not a broken clock.
//
// A run is bounded (`limit`) so a flood cannot produce an unbounded email.
// Two overlapping runs can double-send the same digest: the stamp is
// `where notified_at is null`, so the SECOND stamp is a no-op, but both sends
// go out. Accepted at the 10-minute cadence (with a 15-second pg_net timeout
// and a 10-second Brevo timeout, overlap needs this route to hang for ten
// minutes); a claim-before-send would need an UPDATE the sender is allowed to
// make on a row it has not yet emailed, which is the wrong direction for the
// column and would mark undelivered alerts delivered after a crash.

import { sendEmail } from "@/lib/email/send";
import { supportContactEmail } from "@/lib/email/feedback-notification";
import {
  buildIncidentAlertDigest,
  type IncidentAlertDigestRow,
} from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";

/** Upper bound on alerts per digest. 200 rows is a long email already. */
export const INCIDENT_ALERT_DELIVERY_LIMIT = 200;

export type IncidentAlertDeliveryResult =
  | { readonly outcome: "nothing_pending" }
  | { readonly outcome: "sent"; readonly count: number; readonly messageId: string }
  | { readonly outcome: "failed"; readonly count: number; readonly error: string }
  | { readonly outcome: "unavailable"; readonly error: string };

export async function deliverPendingIncidentAlerts(
  limit: number = INCIDENT_ALERT_DELIVERY_LIMIT,
): Promise<IncidentAlertDeliveryResult> {
  const service = createServiceClient();

  const { data, error } = await service
    .from("incident_alerts")
    .select("id, alert_type, summary, created_at, organisation_id")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, INCIDENT_ALERT_DELIVERY_LIMIT)));

  if (error) {
    console.error("[email] incident-alert delivery could not read pending alerts:", error.message);
    return { outcome: "unavailable", error: error.message };
  }

  const rows: IncidentAlertDigestRow[] = (data ?? []).map((row) => ({
    id: row.id as string,
    alertType: row.alert_type as string,
    summary: row.summary as string,
    createdAt: row.created_at as string,
    organisationId: (row.organisation_id as string | null) ?? null,
  }));
  if (rows.length === 0) return { outcome: "nothing_pending" };

  const to = supportContactEmail();
  if (!to) {
    const message = "SUPPORT_CONTACT_EMAIL is not set";
    console.error(`[email] ${rows.length} incident alert(s) pending and ${message}; nothing sent, nothing stamped.`);
    return { outcome: "failed", count: rows.length, error: message };
  }

  const body = buildIncidentAlertDigest(rows, siteUrl());
  const result = await sendEmail({
    to: [{ email: to }],
    subject: body.subject,
    html: body.html,
    text: body.text,
  });

  if (!result.ok) {
    // NOTHING STAMPED. The rows are exactly as they were; the next run sends
    // them again. Logged so a broken key or a Brevo outage reads as a stream
    // of failures in the server log, not silence.
    console.error(
      `[email] incident-alert digest (${rows.length} alert(s)) failed; nothing stamped, re-sendable:`,
      result.error,
    );
    return { outcome: "failed", count: rows.length, error: result.error };
  }

  // THE STAMP -- last, and only for the ids this digest carried.
  const { error: stampError } = await service
    .from("incident_alerts")
    .update({ notified_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id))
    .is("notified_at", null);
  if (stampError) {
    // The digest went and the rows still read "undelivered": the next run
    // re-sends them. A duplicate email is the honest failure mode here; a
    // silent stamp over an unsent row would be the dishonest one.
    console.error(
      `[email] incident-alert digest sent (messageId ${result.messageId}) but notified_at could not be stamped; the next run will re-send:`,
      stampError.message,
    );
    return { outcome: "failed", count: rows.length, error: stampError.message };
  }

  return { outcome: "sent", count: rows.length, messageId: result.messageId };
}
