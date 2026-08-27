// Pure decision logic for the idle-timeout tracker, kept separate from
// components/auth/idle-timeout.tsx (the "use client" component that wires it
// to real DOM events, localStorage and Supabase) so it can be unit-tested
// without a DOM -- same split as lib/auth/step-up.ts (pure age arithmetic) vs.
// its callers. Deliberately NOT `server-only`: this file has no server
// dependency and is imported from a Client Component.
//
// ===========================================================================
// WHY THIS EXISTS AS APPLICATION-LEVEL ENFORCEMENT, NOT JUST UX
// ===========================================================================
// CLAUDE.md § Session security: "Inactivity timeout 30 minutes." The natural
// assumption is that supabase/config.toml's [auth.sessions]
// inactivity_timeout = "30m" already delivers this server-side, making
// anything here a nicety. Checked against the running stack rather than
// assumed (full methodology and results in
// tests/integration/session/session-limits.test.ts) -- it does enforce
// something real (a refresh past the window is genuinely rejected,
// error_code "session_expired"), but with a gap wide enough to matter:
//
//   GoTrue's inactivity check only runs once a session has refreshed at least
//   ONCE -- its `refreshed_at` column starts NULL and the comparison is
//   skipped entirely until that column is set. A session that is abandoned
//   before its first refresh is NOT caught by inactivity_timeout at all, no
//   matter how long it sits idle, right up to the 12h timebox. Measured: a
//   session created, then left with created_at backdated 2 hours and NEVER
//   refreshed, still refreshes successfully.
//
// So a real 30-minutes-of-no-interaction guarantee needs a check that does
// not depend on a refresh having already happened -- which is exactly what a
// client-side last-activity timestamp gives, checked independently of
// whether GoTrue would currently allow a refresh. IDLE_TIMEOUT_MS below is
// enforced by SIGNING THE SESSION OUT (idle-timeout.tsx calls
// supabase.auth.signOut(), which revokes the refresh token server-side) --
// not by hiding the UI and leaving a live session behind it.
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long before the timeout to start warning, with a visible countdown. */
export const WARNING_LEAD_MS = 60 * 1000;

/** Throttle for how often an activity event is allowed to touch storage. */
export const ACTIVITY_WRITE_THROTTLE_MS = 5_000;

export type IdlePhase = "active" | "warning" | "expired";

/**
 * The one decision this whole file exists for: given how long ago the last
 * recorded activity was, what should happen right now?
 *
 * A pure function of one number -- no Date.now() inside it -- so a test can
 * assert every boundary exactly rather than racing the clock.
 */
export function idlePhase(elapsedMs: number): IdlePhase {
  if (elapsedMs >= IDLE_TIMEOUT_MS) return "expired";
  if (elapsedMs >= IDLE_TIMEOUT_MS - WARNING_LEAD_MS) return "warning";
  return "active";
}

/** Seconds remaining until sign-out, floored at 0, for the countdown label. */
export function secondsRemaining(elapsedMs: number): number {
  return Math.max(0, Math.ceil((IDLE_TIMEOUT_MS - elapsedMs) / 1000));
}
