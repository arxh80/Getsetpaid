import "server-only";

// The application half of SECURITY.md § 5's rate limiter.
//
// ===========================================================================
// NO LIMIT VALUES LIVE IN THIS FILE, AND THAT IS THE DESIGN
// ===========================================================================
// public.rate_limit_policies (20260909020000) is the one place a limit's
// value exists -- seeded with SECURITY.md § 5's numbers verbatim and asserted
// against that table row by row in rls_phase7_rate_limits.sql. This module
// only asks "may this request proceed" and obeys the answer, so the app and
// the database cannot drift the way a mirrored constant could. The window
// arithmetic, the atomic increment and the alert-at-crossing write are all
// inside the RPC; what lives here is the request-scoped dedupe and the
// fail-closed error posture.
//
// ===========================================================================
// ONE CONSUME PER REQUEST PER CATEGORY -- cache(), NOT A FLAG
// ===========================================================================
// A single user-visible request can fan out into several metered reads: the
// command palette runs one fetchListPage per palette entity for ONE
// keystroke's search, and a future page could carry two searched lists. The
// budget meters USER requests, not internal fan-out -- so the consume is
// cache()-wrapped (React's per-request memoisation, the same mechanism
// isSuperuser() uses), which collapses every same-category call inside one
// render/action into one counted unit. An opt-out flag on fetchListPage was
// considered and rejected: lib/list/query.ts's own TABLES_WITHOUT_SOFT_DELETE
// comment explains why escapes are keyed sets, never caller-supplied flags,
// and a metering opt-out is the same shape of hole.
//
// ===========================================================================
// FAIL CLOSED
// ===========================================================================
// A consume that ERRORS refuses the request, the same direction every gate
// in this codebase fails (isSuperuser(), the MFA gate, the impersonation
// page-view audit). The categories metered here are retryable conveniences
// -- a search, a directory browse -- so the cost of a
// false refusal is a retry, while failing open turns any limiter outage into
// exactly the unmetered state SECURITY.md § 5 exists to close. Logged loudly
// so a real outage reads as a spike of refusals in the server log, not a
// mystery.

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * The client-consumable categories. Deliberately narrower than the table:
 * 'login_account' and 'password_recovery' are account-scoped and belong to
 * the auth hooks -- the RPC refuses them from a session (42501), and this
 * type keeps a caller from ever writing that call.
 *
 * 'exports' takes an organisation id (the budget is the tenant's, not the
 * caller's); the RPC verifies active MEMBERSHIP so a stranger cannot burn
 * another tenant's allowance.
 *
 * MEMBERSHIP IS NOT PERMISSION, and the difference is worth stating rather
 * than leaving to be discovered (cleanup round, N1; Q116). `consume_rate_limit`
 * is granted to `authenticated` and callable directly over PostgREST, so ANY
 * active member of a workspace -- a Read Only one holding no export right and
 * no `manage_network_connections` -- can POST it ten times against their own
 * organisation and spend that workspace's whole hourly budget, and file a
 * `rate_limit_tripped` alert naming their own workspace on the operator's
 * feed. That is IN-TENANT, not a tenant crossing: the gate does stop a
 * stranger, which is the property finding I1 was about. It is also
 * pre-existing rather than introduced by any of this, and it is why the claim
 * is "the caller belongs to the workspace" and not "the caller is entitled to
 * spend its budget".
 *
 * Every other category here is USER-scoped and
 * takes NO organisation: since `20260909050000` the RPC refuses one with
 * 22023, because a caller-supplied organisation on a user-scoped budget was
 * what let an incident alert be attributed to a workspace the caller merely
 * named (fix round 1, review finding I1).
 *
 * 'network_connection_request' AND 'feedback' ARE DELIBERATELY ABSENT, though
 * both categories exist in `public.rate_limit_policies`. Q79/Q112's budget is
 * enforced in the database at the INSERT (`private.meter_connection_request()`,
 * `20260909060000`) so that it binds every writer including a direct
 * PostgREST POST -- and a second, app-side meter beside it would spend two
 * units per click and silently halve the shipped limit. Phase 7 Task 6 gave
 * the feedback budget the same shape for the same reason
 * (`private.feedback_before_insert()`, `20260911000000`): `public.feedback`
 * carries a client INSERT grant, so the meter lives where every writer
 * passes, and `submitFeedbackAction` does NOT call this. Leaving both names
 * out of this union is what stops one being added back by accident.
 */
export type RateLimitCategory =
  | "search"
  | "network_discovery"
  | "exports"
  // Q113 (founder 2026-09-30): document uploads, 10/hour per user, spent by
  // uploadDocumentAction BEFORE the bytes reach Storage. App-side rather than
  // a BEFORE INSERT trigger like the write budgets above, because the
  // documents row lands only AFTER the bytes are stored -- a trigger there
  // would refuse too late (20261011000000's header).
  | "uploads"
  | "invoice_send";

export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * When the RPC itself fails we cannot know the real window's remainder, so
 * the refusal advises the longest window any per-user category consumed HERE
 * uses (60s for search/discovery; the hour-long budgets are metered in the
 * database and carry their own remainder in the refusal's `hint`).
 */
const FAIL_CLOSED_RETRY_SECONDS = 60;

/**
 * Count this request against the caller's own budget for `category` and say
 * whether it may proceed. One counted unit per request per category (see the
 * header); refusals carry the seconds until the window turns over, for the
 * "try again in …" copy a 429-shaped refusal owes the person reading it.
 */
export const consumeRateLimit = cache(
  async (
    category: RateLimitCategory,
    organisationId?: string,
  ): Promise<RateLimitVerdict> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_category: category,
      ...(organisationId !== undefined
        ? { p_organisation_id: organisationId }
        : {}),
    });

    if (error) {
      console.error(
        `[rate-limit] consume_rate_limit(${category}) failed; failing CLOSED (refusing the request):`,
        error.message,
      );
      return { allowed: false, retryAfterSeconds: FAIL_CLOSED_RETRY_SECONDS };
    }

    // The RPC returns one row. Anything else is a contract break -- treated
    // as an error, in the closed direction.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: unknown; retry_after_seconds?: unknown }
      | undefined;

    if (!row || typeof row.allowed !== "boolean") {
      console.error(
        `[rate-limit] consume_rate_limit(${category}) returned an unexpected shape; failing CLOSED.`,
      );
      return { allowed: false, retryAfterSeconds: FAIL_CLOSED_RETRY_SECONDS };
    }

    if (row.allowed) return { allowed: true };

    return {
      allowed: false,
      retryAfterSeconds:
        typeof row.retry_after_seconds === "number" &&
        Number.isFinite(row.retry_after_seconds) &&
        row.retry_after_seconds >= 0
          ? row.retry_after_seconds
          : FAIL_CLOSED_RETRY_SECONDS,
    };
  },
);
