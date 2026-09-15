import "server-only";

// THE PER-ACCOUNT LOCKOUT NOTIFICATION -- founder ruling Q114.
//
// ===========================================================================
// WHY THIS IS A SEPARATE SENDER FROM THE DIGEST
// ===========================================================================
// lib/email/incident-alerts.ts sends ONE digest of every pending alert to the
// OPERATOR. This sends a different message, about a subset of those alerts, to
// A DIFFERENT PERSON: the holder of the account someone is failing to sign in
// to. It must not be folded into the digest -- the digest goes to the founder,
// and putting a customer's security notice in it would either tell the founder
// nothing new or tell the customer about the whole platform.
//
// It rides the SAME CLOCK (pg_cron -> /api/incident-alerts/deliver, Q118), so
// there is exactly one scheduler in the product; the route calls both and
// reports both.
//
// ===========================================================================
// THE ABUSE, AND WHAT ACTUALLY CAPS IT
// ===========================================================================
// The notification is reachable by failing someone's login, so an attacker who
// knows an address can now generate mail to that person as well as lock them
// out. The cap is NOT a counter in this file; it is structural, in two places:
//
//   * public.record_rate_limit_event() writes the `repeated_login_failures`
//     alert ONLY at the crossing (request_count = max + 1), exactly once per
//     fixed 15-minute window. Ten thousand further attempts in that window
//     write no further row, so they can produce no further email. Ceiling:
//     four emails per hour per account, however hard it is hammered.
//   * public.pending_lockout_notifications() GROUPS BY ACCOUNT, so a backlog
//     (the clock down for an hour, four windows crossed) is ONE email naming
//     the most recent window and one stamp over all four ids -- not four.
//
// WHAT REMAINS is stated in SECURITY.md § 5 rather than implied away: roughly
// four emails an hour to one address the attacker already knew.
//
// ===========================================================================
// THE ADDRESS NEVER LEAVES THIS FUNCTION, AND NEVER REACHES A LOG
// ===========================================================================
// The recipient is resolved in the database, inside
// public.pending_lockout_notifications() -- a SECURITY DEFINER function
// granted to `service_role` alone that takes NO user argument, so it cannot be
// asked for a chosen person's address, only for the accounts that currently
// have an unnotified lockout alert. Nothing here logs an address: a failed
// send logs the ACCOUNT ID, which is what a human would need to look it up
// through a path that is itself authorised. Nothing here reads, stores or logs
// anything that was typed at the sign-in form -- the alert row never carried
// it in the first place.
//
// ===========================================================================
// STAMP ONLY AFTER ok:true, AND THE LOCKOUT DOES NOT DEPEND ON ANY OF IT
// ===========================================================================
// `account_notified_at` moves only for the ids an accepted send actually
// covered, exactly the way `notified_at` does. A failed send stamps nothing
// and the next tick retries the identical set. And the send path is entirely
// downstream of the lockout: the lockout is enforced synchronously inside
// GoTrue's password-verification hook, in the database, and neither knows nor
// waits for this file. An outage here delays a notification; it cannot let an
// attempt through, and it cannot lock anybody out either.

import { sendEmail } from "@/lib/email/send";
import { buildLockoutNotification } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";

// ===========================================================================
// THE RUN IS BOUNDED IN WALL-CLOCK TIME, AND THAT IS A CORRECTNESS PROPERTY
// (fix round 1, M1)
// ===========================================================================
// This loop is SEQUENTIAL and each send has lib/email/send.ts's 10-second
// Brevo timeout. At the first cut's limit of 100 accounts, a degraded Brevo
// made the worst case ~1000 s against the clock's 600 s cadence (Q118) -- so
// tick 2 could fire while tick 1 was still looping, read
// pending_lockout_notifications() (which still returns every account tick 1
// has not yet STAMPED, because the stamp is after the send) and send the same
// notice again. The duplicate lands on the ACCOUNT HOLDER, which is exactly
// the outcome Q114's structural cap exists to bound, and a credential-stuffing
// spray reaches it without the attacker doing anything else.
//
// So the worst case is made to fit inside the cadence, twice over:
//   * at most 30 accounts per tick -- 30 x 10 s = 300 s even with no budget;
//   * and a 120-second wall-clock budget checked BEFORE each send, so the
//     real ceiling is 120 s + one in-flight send = ~130 s, against 600 s.
// Deferred accounts are not lost: nothing is stamped for them, so the next
// tick returns them unchanged. That is the same retry-is-the-schedule rule
// the rest of this file runs on, and `deferred` in the result says how many.
//
// AND THE CAP CANNOT STARVE THE VICTIM (fix round 2, review finding N3).
// A cap is only fair if the queue behind it ages. public.pending_lockout_
// notifications() used to order by each account's MOST RECENT unnotified
// alert, which ADVANCES every 15 minutes for an account that is still being
// hammered -- so on a queue this cap kept full, the accounts under active
// attack sorted to the back on every tick and were the ones never told.
// `20260918000000` orders by the OLDEST unnotified alert instead, which cannot
// advance while an account waits. Nothing in this file changed; the guarantee
// is a property of the query, and § RD28-RD35 measure it against a queue
// deliberately saturated through `p_limit`.
//
// WHO SEES A DEFERRAL (fix round 2, review finding N4). `deferred` is in this
// function's result, but its caller is a pg_net POST and pg_net reads no
// response -- so the number reached nobody. /super/health now carries the
// count of accounts waiting and the AGE of the oldest (`20260918001000`): a
// non-zero count is normal for a tick or two, an oldest-pending timestamp that
// keeps receding is a queue that is not draining, which is what a wrong bearer
// or a stopped clock look like from the outside.
//
// WHY NOT A LOCK. The obvious alternative -- pg_try_advisory_lock inside
// private.deliver_incident_alerts() -- cannot work, and the reason is worth
// recording so it is not "fixed" that way later: that function uses pg_net,
// which is FIRE-AND-FORGET. It queues the request and returns in
// microseconds, long before this route has started, let alone finished, so a
// lock taken there is released before the work it would be guarding begins.
// Real mutual exclusion would have to be a lease held across the HTTP request
// (a row with an expiry, claimed and released by the route) -- more moving
// parts, and a lease that outlives a crashed run is its own outage. Bounding
// the work so overlap is unreachable is smaller and needs nothing to be
// remembered.

/** Accounts notified in one run. A tick that finds more than this leaves the
 *  rest for the next one -- they stay pending, which is the retry. */
export const LOCKOUT_NOTIFICATION_LIMIT = 30;

/** Wall-clock budget for the whole loop. See the block above: it is what
 *  keeps a degraded Brevo from pushing one tick past the next one. */
export const LOCKOUT_NOTIFICATION_BUDGET_MS = 120_000;

export type LockoutNotificationResult =
  | { readonly outcome: "nothing_pending" }
  | {
      readonly outcome: "delivered";
      readonly sent: number;
      readonly failed: number;
      /** Accounts this run did not reach before its wall-clock budget ran
       *  out. Nothing was stamped for them; the next tick picks them up. */
      readonly deferred: number;
    }
  | { readonly outcome: "unavailable"; readonly error: string };

interface PendingRow {
  readonly account_user_id: string;
  readonly email: string;
  readonly alert_ids: string[];
  readonly latest_at: string;
  readonly max_requests: number;
  readonly window_seconds: number;
}

export async function deliverLockoutNotifications(
  limit: number = LOCKOUT_NOTIFICATION_LIMIT,
): Promise<LockoutNotificationResult> {
  const service = createServiceClient();

  const { data, error } = await service.rpc("pending_lockout_notifications", {
    p_limit: Math.max(1, Math.min(limit, LOCKOUT_NOTIFICATION_LIMIT)),
  });

  if (error) {
    console.error("[email] lockout notifications could not be read:", error.message);
    return { outcome: "unavailable", error: error.message };
  }

  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return { outcome: "nothing_pending" };

  const origin = siteUrl();
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  const startedAt = Date.now();

  for (const [index, row] of rows.entries()) {
    // THE BUDGET IS CHECKED BEFORE THE SEND, NOT AFTER: the point is that no
    // send is STARTED once the run is out of time, so the ceiling is the
    // budget plus at most one in-flight timeout.
    if (Date.now() - startedAt >= LOCKOUT_NOTIFICATION_BUDGET_MS) {
      deferred = rows.length - index;
      console.error(
        `[email] lockout notifications ran out of wall-clock budget with ${deferred} account(s) unsent; nothing stamped for them, the next tick retries`,
      );
      break;
    }

    const body = buildLockoutNotification({
      lastAttemptAt: row.latest_at,
      maxAttempts: row.max_requests,
      windowSeconds: row.window_seconds,
      siteUrl: origin,
    });

    const result = await sendEmail({
      to: [{ email: row.email }],
      subject: body.subject,
      html: body.html,
      text: body.text,
    });

    if (!result.ok) {
      failed += 1;
      // THE ACCOUNT ID, NEVER THE ADDRESS. A server log is read by more
      // people and kept in more places than the database is.
      console.error(
        `[email] lockout notification for account ${row.account_user_id} failed; nothing stamped, re-sendable:`,
        result.error,
      );
      continue;
    }

    const { error: stampError } = await service
      .from("incident_alerts")
      .update({ account_notified_at: new Date().toISOString() })
      .in("id", row.alert_ids)
      .is("account_notified_at", null);

    if (stampError) {
      // Sent but unstamped: the next tick sends it again. A duplicate warning
      // to the account holder is the honest failure; a silent stamp over an
      // unsent notice is the dishonest one.
      failed += 1;
      console.error(
        `[email] lockout notification for account ${row.account_user_id} was sent but could not be stamped; the next run will re-send:`,
        stampError.message,
      );
      continue;
    }

    sent += 1;
  }

  return { outcome: "delivered", sent, failed, deferred };
}
