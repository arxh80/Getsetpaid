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
// go out. A claim-before-send would need an UPDATE the sender is allowed to
// make on a row it has not yet emailed, which is the wrong direction for the
// column and would mark undelivered alerts delivered after a crash. So the
// duplicate is accepted and OVERLAP IS MADE UNREACHABLE INSTEAD, by keeping
// the whole route's worst case well inside the 600-second cadence:
//
//   * this digest is ONE Brevo call, so at most one 10-second timeout;
//   * lib/email/lockout-notification.ts, which runs on the same tick, is a
//     sequential loop and is therefore bounded BOTH by a 30-account limit and
//     by a 120-second wall-clock budget (fix round 1, M1 -- at the first cut's
//     100 accounts the worst case was ~1000 s, i.e. longer than the cadence,
//     and the earlier claim here that a 10-second Brevo timeout ruled overlap
//     out was false the moment that loop was added).
//
//   * the Telegram alert (below, founder 2026-09-30, Q111) is ONE request with
//     a 10-second timeout (lib/telegram/send.ts), so it adds at most ten.
//
//   * since 20261015000000, the DSR and export-ready notices (30 rows and a
//     60-second budget each, ~70 s each) and the erasure-failure notice (one
//     10-second call) -- lib/email/requester-notifications.ts.
//
// Worst case now ~300 s against a 600 s tick (20261015000000 reissues the
// clock function's comment with that number; it was ~150 s at 20261014000000). The pg_net timeout does not
// help with any of this: it abandons the response, it does not cancel the
// handler.

import { sendEmail } from "@/lib/email/send";
import { supportContactEmail } from "@/lib/email/feedback-notification";
import {
  buildIncidentAlertDigest,
  type IncidentAlertDigestRow,
} from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";
import { sendTelegramMessage, telegramConfig } from "@/lib/telegram/send";
import {
  buildTelegramAlertPayload,
  renderTelegramAlertText,
} from "@/lib/telegram/incident-alert-payload";

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

// ===========================================================================
// THE SECOND CHANNEL: TELEGRAM (founder 2026-09-30, Q111)
// ===========================================================================
// Same tick, same route, its OWN stamp. This half reads and writes
// `telegram_notified_at` and never `notified_at`; the email half above reads
// and writes `notified_at` and never `telegram_notified_at`
// (20261014000000). So a Telegram failure leaves the email stamp exactly as
// the email half left it, and vice versa, and either channel re-sends alone on
// the next tick.
//
// WHAT IT SELECTS IS WHAT IT MAY SAY. The read is `id, alert_type` -- not the
// summary, not the details, not the organisation -- and only `alert_type`
// reaches the payload builder; `id` is used for the stamp and nothing else.
// The builder is the allowlist (lib/telegram/incident-alert-payload.ts).
//
// NO CONFIG, NO-OP: with TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID unset
// this returns `disabled` before it reads anything -- not `failed`, because an
// environment that has not opted into the channel has nothing pending on it.

export type TelegramAlertDeliveryResult =
  | { readonly outcome: "disabled" }
  | { readonly outcome: "nothing_pending" }
  | { readonly outcome: "sent"; readonly count: number }
  | { readonly outcome: "failed"; readonly count: number; readonly error: string }
  | { readonly outcome: "unavailable"; readonly error: string };

export async function deliverPendingIncidentAlertsToTelegram(
  limit: number = INCIDENT_ALERT_DELIVERY_LIMIT,
): Promise<TelegramAlertDeliveryResult> {
  const config = telegramConfig();
  if (!config) return { outcome: "disabled" };

  const service = createServiceClient();
  const { data, error } = await service
    .from("incident_alerts")
    .select("id, alert_type")
    .is("telegram_notified_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, INCIDENT_ALERT_DELIVERY_LIMIT)));

  if (error) {
    console.error("[telegram] incident-alert delivery could not read pending alerts:", error.message);
    return { outcome: "unavailable", error: error.message };
  }

  const rows = (data ?? []).map((row) => ({
    id: row.id as string,
    alertType: row.alert_type as string,
  }));
  if (rows.length === 0) return { outcome: "nothing_pending" };

  let text: string;
  try {
    text = renderTelegramAlertText(
      buildTelegramAlertPayload(rows.map((r) => ({ alertType: r.alertType })), siteUrl()),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] alert payload refused; nothing sent, nothing stamped: ${message}`);
    return { outcome: "failed", count: rows.length, error: message };
  }

  let result: Awaited<ReturnType<typeof sendTelegramMessage>>;
  try {
    result = await sendTelegramMessage(config, text);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.name : "unknown error" };
  }
  if (!result.ok) {
    console.error(
      `[telegram] incident-alert message (${rows.length} alert(s)) failed; nothing stamped, re-sendable:`,
      result.error,
    );
    return { outcome: "failed", count: rows.length, error: result.error };
  }

  const { error: stampError } = await service
    .from("incident_alerts")
    .update({ telegram_notified_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id))
    .is("telegram_notified_at", null);
  if (stampError) {
    console.error(
      "[telegram] incident-alert message sent but telegram_notified_at could not be stamped; the next run will re-send:",
      stampError.message,
    );
    return { outcome: "failed", count: rows.length, error: stampError.message };
  }

  return { outcome: "sent", count: rows.length };
}
