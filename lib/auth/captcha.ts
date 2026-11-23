// Cloudflare Turnstile on the auth forms, verified by Supabase Auth itself.
//
// GoTrue checks `captchaToken` against the secret set in the hosted
// dashboard (Auth > Bot and Abuse Protection), so there is no siteverify call
// of our own. With captcha off (local, CI) GoTrue ignores the token. What
// bounds a password grant or magic-link request sent straight to GoTrue,
// bypassing these forms, is that GoTrue then demands a token too
// (SECURITY.md § 10).
import { field } from "@/lib/forms";

/** The hidden input Turnstile adds to the form it is rendered in. */
export const CAPTCHA_FIELD = "cf-turnstile-response";

/**
 * Said for a refused or missing token. GoTrue checks the token before it
 * looks the address up, so this reveals nothing about whether an account
 * exists.
 */
export const CAPTCHA_FAILED =
  "The security check didn't complete. Wait for it to finish, or refresh the page, then try again.";

export function captchaToken(formData: FormData): string | undefined {
  return field(formData, CAPTCHA_FIELD) ?? undefined;
}

export function isCaptchaFailure(error: { code?: string } | null): boolean {
  return error?.code === "captcha_failed";
}
