import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServiceClient } from "@/lib/supabase/service";
import type { createClient } from "@/lib/supabase/server";
import { MUST_CHOOSE_PASSWORD_KEY } from "@/lib/supabase/middleware";

// ===========================================================================
// A PASSWORD CHOSEN AFTER THE PROOF (Phase 10 Task 20, Q245; G11's residual)
// ===========================================================================
// GoTrue keeps the FIRST password on an unconfirmed re-sign-up, and confirming
// does not replace it (measured on v2.196.0, Task 4). So whoever signed an
// address up first -- possibly a squatter who does not own it -- holds the
// password of the account its real owner later confirms. The owner can reach
// that confirmation four ways (all in tests/e2e/first-proof-password.spec.ts):
// signing up over the squatter, following the squatter's own confirmation
// email, asking for an emailed sign-in link (GoTrue sends a sign-up
// confirmation instead), or following a recovery email anybody can request.
//
// THE RULE, applied by the callback at an address's FIRST proof (no row in
// private.address_first_proofs yet):
//   * The password survives only when the browser proving the address is the
//     browser whose sign-up CREATED the account -- the binding cookie set by
//     bindSignUp() below, matched against a hash only the server can write
//     (app_metadata) -- or when the account has no email identity at all, so
//     no password can exist (a Google-only account).
//   * Otherwise: the password is replaced with a long random one (the
//     squatter's dies), every OTHER session is signed out, and
//     the account is marked "must choose a password", which the proxy turns
//     into "nothing but /set-password and signing out" until it is cleared.
//   * Both outcomes are recorded once the outcome is complete, so a failure
//     part-way leaves no row and the next proof retries the whole thing.
//   * An account BORN confirmed (Admin API, OAuth) gets its row from a trigger
//     on auth.users (20261104000000), so a later magic link is not a "first".
// The templates (supabase/templates/confirmation.html, recovery.html) send
// every sign-up confirmation and recovery link through the callback; with
// GoTrue's defaults they went to /auth/v1/verify, which confirmed the account
// and redirected with tokens in a URL fragment the server never sees.
//
// SERVICE ROLE: this file is the auth callback's only reach into the table
// (two RPCs, service_role alone -- lib/supabase/service.ts's census names it)
// and into the Admin API (app_metadata only: the binding hash and the mark). Both clients are
// server-only and constructed per call.
// ===========================================================================

/** The httpOnly cookie that ties a new sign-up to the browser that made it. */
export const SIGNUP_BINDING_COOKIE = "gsp_signup_binding";

/** app_metadata key holding SHA-256(nonce); app_metadata is server-writable only. */
const BINDING_HASH_KEY = "signup_binding_sha256";

/** Comfortably past GoTrue's confirmation-link lifetime ([auth.email] otp_expiry, 1h). */
const BINDING_MAX_AGE_SECONDS = 60 * 60 * 24;

/**
 * GoTrue refuses to re-send a confirmation to one account inside
 * `[auth.email] max_frequency` (1s locally; asserted >= 1s by
 * tests/unit/security/auth-config.test.ts). So a RE-sign-up's
 * confirmation_sent_at is at least that long after the account's created_at,
 * while a new account's two stamps are milliseconds apart (14ms measured).
 * Both are GoTrue's own clock, so no skew against this server enters.
 */
const RESEND_FLOOR_MS = 1_000;

/** Did this signUp() create the account (rather than return an existing, unconfirmed one)? */
export function isNewSignUp(user: Pick<User, "created_at" | "confirmation_sent_at">): boolean {
  if (!user.confirmation_sent_at) return false;
  const gap = Date.parse(user.confirmation_sent_at) - Date.parse(user.created_at);
  return Number.isFinite(gap) && gap >= 0 && gap < RESEND_FLOOR_MS;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Does the binding cookie `<user id>.<nonce>` belong to this user and hash to the stored value? */
export function bindingMatches(
  cookieValue: string | undefined,
  userId: string,
  storedHash: unknown,
): boolean {
  if (!cookieValue || typeof storedHash !== "string" || storedHash === "") return false;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return false;
  const nonce = cookieValue.slice(dot + 1);
  return cookieValue.slice(0, dot) === userId && nonce !== "" && sha256(nonce) === storedHash;
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  // The local stack and `next dev` are plain http; production is HTTPS-only.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  // Read only by /auth/callback.
  path: "/auth",
};

/**
 * Called by signUpAction when signUp() CREATED the account. Best effort: with
 * no binding the first proof requires a new password, which is the safe side.
 */
export async function bindSignUp(userId: string): Promise<void> {
  const nonce = randomBytes(32).toString("base64url");
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: { [BINDING_HASH_KEY]: sha256(nonce) },
  });
  if (error) return;
  (await cookies()).set(SIGNUP_BINDING_COOKIE, `${userId}.${nonce}`, {
    ...COOKIE_OPTIONS,
    maxAge: BINDING_MAX_AGE_SECONDS,
  });
}

export type FirstProofOutcome = "already-proved" | "settled" | "must-choose-password";

/**
 * Settles an address's first proof for the session the callback just minted.
 * `otpType` is the verifyOtp type, or null for the code exchange (OAuth).
 * Throws on any failure; the caller signs the session out and fails the link,
 * and because the record is written before any cleanup, a failed write leaves
 * the binding in place for the retry.
 *
 * AN INVITATION is proved without the mark: inviteUserByEmail creates the
 * account with no password, and the invite landing (/invites?welcome=1)
 * already offers to set one. Its password is still replaced and other
 * sessions signed out, which costs a password-less account nothing and closes
 * the one way an invited account can carry somebody else's password: a
 * squatter's sign-up landing between the invite step's lookup and its
 * inviteUserByEmail call (lib/org/actions.ts, the "millisecond race").
 */
export async function settleFirstProof(
  supabase: Awaited<ReturnType<typeof createClient>>,
  user: User,
  otpType: string | null,
): Promise<FirstProofOutcome> {
  const service = createServiceClient();
  const proved = await service.rpc("address_is_proved", { p_user_id: user.id });
  if (proved.error) throw new Error(`address_is_proved: ${proved.error.message}`);
  if (proved.data === true) return "already-proved";

  const store = await cookies();
  const hasEmailIdentity = (user.identities ?? []).some((i) => i.provider === "email");
  const kept =
    !hasEmailIdentity ||
    bindingMatches(store.get(SIGNUP_BINDING_COOKIE)?.value, user.id, user.app_metadata?.[BINDING_HASH_KEY]);
  const mark = !kept && otpType !== "invite";

  const admin = createAdminClient();
  if (!kept) {
    // 1. The pre-proof password dies: nobody knows this one. Through THIS
    //    session, not the Admin API: an Admin API password update revokes
    //    every session's refresh token, this one included (measured), which
    //    would leave the owner a session that dies within the JWT's 15 minutes.
    const rotated = await supabase.auth.updateUser({ password: randomBytes(48).toString("base64url") });
    if (rotated.error) throw new Error(`password replacement: ${rotated.error.message}`);
    // 2. So does every session but this one.
    const others = await supabase.auth.signOut({ scope: "others" });
    if (others.error) throw new Error(`sign out others: ${others.error.message}`);
    if (mark) {
      // 3. The mark lives in app_metadata, which only the server can write...
      const marked = await admin.auth.admin.updateUserById(user.id, {
        app_metadata: { [MUST_CHOOSE_PASSWORD_KEY]: true },
      });
      if (marked.error) throw new Error(`mark: ${marked.error.message}`);
      // ...and this session's JWT was minted before it; the proxy reads the JWT.
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.error) throw new Error(`refresh: ${refreshed.error.message}`);
    }
  }

  const recorded = await service.rpc("record_address_first_proof", {
    p_user_id: user.id,
    p_password_kept: kept,
  });
  if (recorded.error) throw new Error(`record_address_first_proof: ${recorded.error.message}`);

  // Cleanup, after the record: the binding has done its one job. A null
  // app_metadata key is deleted by GoTrue, not stored (measured locally).
  if (user.app_metadata?.[BINDING_HASH_KEY]) {
    await admin.auth.admin.updateUserById(user.id, { app_metadata: { [BINDING_HASH_KEY]: null } });
  }
  store.set(SIGNUP_BINDING_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return mark ? "must-choose-password" : "settled";
}

/** Clears the mark once the user has chosen a password (choosePasswordAction). */
export async function clearMustChoosePassword(userId: string): Promise<boolean> {
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: { [MUST_CHOOSE_PASSWORD_KEY]: null },
  });
  return !error;
}
