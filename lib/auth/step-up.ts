import "server-only";

// Session freshness, read from the JWT's `amr` claim.
//
// CLAUDE.md § Session security: "Step-up re-authentication (re-enter
// credentials/MFA) is required before: changing security settings (MFA,
// password, email), large data exports, deleting organisation data, and any
// high-risk admin/superuser function."
//
// A session lasts up to 12 hours (config.toml [auth.sessions] timebox). So
// "there is a session" proves almost nothing about right now -- it is
// compatible with a cookie stolen eleven hours after the user last typed
// anything. Everything in this file exists to answer the sharper question:
// HOW LONG AGO, and BY WHAT METHOD, did this person actually authenticate?
//
// ===========================================================================
// WHY `amr` AND NOT `iat`, `exp` OR THE SESSION'S OWN AGE
// ===========================================================================
// `iat`/`exp` describe the ACCESS TOKEN, which is reminted every hour by the
// refresh cycle. A token issued sixty seconds ago says nothing about when its
// holder last proved who they were, so gating on `iat` would let an
// eleven-hour-old stolen session pass every time it refreshed. `amr`
// (Authentication Method References, RFC 8176) records the authentication
// events themselves, each with the timestamp it happened at.
//
// VERIFIED against the running stack rather than assumed -- the property that
// makes this work at all: refreshing a session does NOT restamp `amr`. A
// session created by password sign-in and then refreshed still reports
// `[{ method: "password", timestamp: <original> }]`, byte-identical timestamp.
//
// Observed methods on this stack:
//   signInWithPassword / signUp        -> [{ method: "password", ... }]
//   verifyOtp({ type: "invite" })      -> [{ method: "otp", ... }]
//   (magic link verifies the same way) -> [{ method: "otp", ... }]
//
// ===========================================================================
// WHY THE GATE IS METHOD-AND-AGE AND NOT "DOES THIS USER HAVE A PASSWORD?"
// ===========================================================================
// The obvious design is to branch on whether the account already has a
// password: a first-time set by an invitee is not a "change" and does not need
// step-up. THAT FACT IS NOT OBSERVABLE. Probed exhaustively against the
// running stack before settling on what is here:
//
//   - `user.identities` is IDENTICAL in both cases. A user created by
//     admin.inviteUserByEmail() gets an identity row with provider='email',
//     exactly like a password signup. Branching on identities would classify
//     every invitee as an existing password holder.
//   - The Admin API's user object has no password-related field at all.
//     admin.getUserById() returns: app_metadata, aud, confirmed_at,
//     created_at, email, email_confirmed_at, id, identities, invited_at,
//     is_anonymous, last_sign_in_at, phone, role, updated_at, user_metadata.
//   - `auth.users.encrypted_password` LOOKS like the answer and is a trap.
//     It is '' for a freshly invited user -- but GoTrue writes a bcrypt hash
//     of an unusable random value the moment that user confirms. Measured:
//
//         after invite    : encrypted_password = ''            (length 0)
//         after verifyOtp : encrypted_password = '$2a$10$dTc…' (length 60)
//         sign-in with '' , ' ', 'password' -> invalid_credentials (all three)
//
//     So by the time an invitee reaches the account-setup form -- which they
//     can only reach BY confirming -- the column already says "has a
//     password", for a user who demonstrably has none. A check built on it
//     would fail OPEN in the one direction that matters.
//
// What IS observable is how, and how recently, this session authenticated, so
// that is what the gate uses. Two accepted proofs:
//
//   STEP-UP        a credential method (password/MFA) within 5 minutes.
//                  The user just demonstrated possession of a credential.
//
//   LINK PROOF     a one-time emailed token (otp) within 30 minutes.
//                  The user just demonstrated control of the address the
//                  password secures. This is the invitee's path, and it is the
//                  same root of trust the product already grants email control
//                  everywhere else: magic link is a first-class sign-in method
//                  here, so anyone able to consume a fresh link could equally
//                  sign in and use the recovery flow. It grants nothing new.
//
// Anything else -- including a perfectly valid session that authenticated
// hours ago by any method -- is refused. That is the finding this replaces.
//
// KNOWN RESIDUAL, named rather than hidden: because the password-holder case
// cannot be detected, a user who ALREADY has a password and arrives on a fresh
// magic link takes the LINK PROOF path rather than being made to re-enter the
// old password. Equivalent in strength to the recovery flow, not weaker, but
// it is not the "step-up for a genuine change" the ideal design would give.
// The intended mitigation is notification rather than prevention --
// config.toml declares [auth.email.notification.password_changed] -- but that
// block is NOT currently honoured by the local CLI (measured: no notification
// reaches Mailpit, and the auth container carries no notification env var), so
// treat it as declared intent, not an active control, until re-checked on a
// newer CLI or the hosted project. If GoTrue ever exposes a real "has usable
// password" signal, add it as an ADDITIONAL condition on the LINK PROOF path
// -- never as a way to widen either window.
//
// ===========================================================================
// THIS FAILS CLOSED
// ===========================================================================
// If `amr` is missing, empty, or in the RFC-8176 string form (which carries no
// timestamps), age is reported as `null` and every gate below refuses. An auth
// server that stops emitting timestamped `amr` must break password changes
// loudly rather than quietly downgrade them to "a session exists".

/** One entry of the JWT's `amr` array, in the timestamped form Supabase emits. */
interface AmrEntry {
  method: string;
  timestamp: number;
}

export interface AuthFreshness {
  /** The most recent authentication method, or null if `amr` was unusable. */
  method: string | null;
  /** Seconds since that authentication, or null if it could not be determined. */
  ageSeconds: number | null;
}

/**
 * Step-up window: how recently a CREDENTIAL must have been presented.
 *
 * Five minutes -- long enough to sign in and walk to the settings screen,
 * short enough that a session left open in a coffee shop is not a
 * password-change capability. Supabase's own `secure_password_change` uses a
 * 24-hour grace, which is longer than our entire 12-hour session timebox and
 * therefore no protection at all; this is the real gate.
 */
export const STEP_UP_MAX_AGE_SECONDS = 5 * 60;

/**
 * Link-proof window: how recently a one-time emailed token must have been
 * consumed.
 *
 * Thirty minutes, matching CLAUDE.md's inactivity timeout. Wider than the
 * step-up window because the invitee has just arrived from an email client and
 * may read the page before acting -- but still bounded, so a link-minted
 * session left open all afternoon stops being a credential-setting capability.
 */
export const LINK_PROOF_MAX_AGE_SECONDS = 30 * 60;

/**
 * Methods that prove possession of a CREDENTIAL, as opposed to control of an
 * inbox. `otp` is deliberately absent -- it is handled by the link-proof path,
 * on its own shorter leash, and must never satisfy step-up.
 */
const CREDENTIAL_METHODS = new Set(["password", "totp", "webauthn", "passkey"]);

/**
 * Methods that prove control of the email address, via a single-use token.
 *
 * Only `otp` is OBSERVED on this stack -- Supabase reports invite and magic
 * link alike as `otp`. The other three are defensive spellings: each names an
 * unambiguously email-token flow, so listing one that never appears costs
 * nothing, while a spelling change upstream would otherwise fail every
 * invitee's setup. A generic `email` is deliberately NOT here: it is ambiguous
 * enough that it might one day denote a password sign-in, and putting it in
 * this set would silently move password auth onto the wider 30-minute window.
 *
 * `oauth` is also absent, which means a Google-SSO user cannot set a password
 * through this form. That is the intended, fail-closed outcome: they sign in
 * with Google, and adding a password is an account-settings action for the
 * later screen that owes them real step-up.
 */
const LINK_METHODS = new Set(["otp", "magiclink", "invite", "recovery"]);

function isCredentialMethod(method: string | null): boolean {
  if (!method) return false;
  // Supabase namespaces MFA factors as `mfa/totp`, `mfa/phone`, `mfa/webauthn`.
  if (method.startsWith("mfa/")) return true;
  return CREDENTIAL_METHODS.has(method);
}

/**
 * Reads the most recent authentication event out of verified JWT claims.
 *
 * Pass the claims from `supabase.auth.getClaims()`, never a hand-decoded
 * token: on a symmetric (HS256) project getClaims() validates the JWT with the
 * auth server before returning the payload, so these claims are checked rather
 * than merely parsed.
 */
export function readAuthFreshness(
  claims: Record<string, unknown> | null | undefined,
): AuthFreshness {
  const raw = claims?.amr;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { method: null, ageSeconds: null };
  }

  // The string[] form of amr is RFC-8176 compliant but carries no timestamps.
  // There is nothing to measure, so treat it as unknown and let callers refuse.
  const entries = raw.filter(
    (e): e is AmrEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as AmrEntry).method === "string" &&
      Number.isFinite((e as AmrEntry).timestamp),
  );
  if (entries.length === 0) return { method: null, ageSeconds: null };

  const latest = entries.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const nowSeconds = Math.floor(Date.now() / 1000);

  // A timestamp in the future is clock skew or a forged claim; either way it
  // must not read as "zero seconds old". Anything more than a minute ahead is
  // refused outright; smaller skew is clamped to 0.
  const age = nowSeconds - latest.timestamp;
  if (age < -60) return { method: latest.method, ageSeconds: null };

  return { method: latest.method, ageSeconds: Math.max(age, 0) };
}

/** A credential was presented within the step-up window. */
export function isStepUpSatisfied(freshness: AuthFreshness): boolean {
  if (freshness.ageSeconds === null) return false;
  if (!isCredentialMethod(freshness.method)) return false;
  return freshness.ageSeconds <= STEP_UP_MAX_AGE_SECONDS;
}

/** A single-use emailed token was consumed within the link-proof window. */
export function isLinkProofFresh(freshness: AuthFreshness): boolean {
  if (freshness.ageSeconds === null) return false;
  if (!freshness.method || !LINK_METHODS.has(freshness.method)) return false;
  return freshness.ageSeconds <= LINK_PROOF_MAX_AGE_SECONDS;
}

/**
 * The single decision: may this session set or replace the account password?
 *
 * Either accepted proof will do, and nothing else will. Note what is NOT here:
 * there is no branch that passes on "a session exists", and no branch that
 * passes on an unrecognised method. Adding one would reopen the finding.
 */
export function mayChangePassword(freshness: AuthFreshness): boolean {
  return isStepUpSatisfied(freshness) || isLinkProofFresh(freshness);
}
