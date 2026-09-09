// "Try again in …" — a wait, rendered the way a person reads one.
//
// ===========================================================================
// WHY THIS EXISTS (fix round 1, minor M2)
// ===========================================================================
// Every rate-limit refusal in the product carries `retryAfterSeconds`, the
// real remainder of the fixed window, and every one of them used to render it
// raw. That reads fine for the 60-second budgets (`search`,
// `network_discovery`) and badly for the 3,600-second ones: a user refused one
// minute into the hour was told "Try again in 3,541 seconds". The
// connection-request budget (`20260909040000`) is a 3,600-second window today
// and in-app feedback is another one at Task 6, so this is not a one-off fix.
//
// ROUNDS UP, ALWAYS. A refusal that says "1 minute" when 61 seconds remain
// invites a retry that is refused again; overstating the wait by up to 59
// seconds costs nothing and is never wrong in the direction that matters.
//
// Not `Intl.RelativeTimeFormat`: this is a DURATION ("in 12 minutes"), not a
// relative instant, and the plural/threshold rules below are the whole point.

/**
 * A human wait, from seconds.
 *
 *   0–119     -> "45 seconds"     (a real number, because it is actionable)
 *   120–5399  -> "12 minutes"     (nobody counts past two minutes in seconds)
 *   5400+     -> "2 hours"
 *
 * Negative or non-finite input is clamped to 0 rather than throwing: this is
 * display copy on a refusal path, and a limiter that returned nonsense must
 * not also take the page down (the same posture `lib/security/rate-limit.ts`
 * keeps when the RPC answers oddly).
 */
export function formatRetryAfter(seconds: number): string {
  const safe =
    Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;

  if (safe < 120) return `${safe} ${safe === 1 ? "second" : "seconds"}`;

  if (safe < 5400) {
    const minutes = Math.ceil(safe / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  const hours = Math.ceil(safe / 3600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
