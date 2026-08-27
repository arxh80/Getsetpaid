// Shared shape for every Server Action that backs a form.
//
// One type for all of them so the client components can share a single
// `useActionState` wiring and a single error-rendering path. `fieldErrors` is
// keyed by input name so each message can be rendered next to the field it
// belongs to, which is the accessibility requirement (a form error that only
// appears in a summary at the top is a WCAG failure and a usability one).

export interface FormState {
  /** Top-level failure, rendered in a role="alert" above the form. */
  error?: string;
  /** Per-input failures, keyed by the input's `name`. */
  fieldErrors?: Record<string, string>;
  /** Success confirmation, for flows that stay on the page. */
  message?: string;
}

export const EMPTY_FORM_STATE: FormState = {};

/** Reads a text field, trimming and normalising "" to null. */
export function field(data: FormData, name: string): string | null {
  const raw = data.get(name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

// Deliberately permissive. Real address validity is only ever established by
// successfully delivering mail to it, so this rejects obvious typos and gets
// out of the way -- an over-clever regex here rejects valid addresses
// (apostrophes, plus-addressing, long TLDs) and teaches users the product is
// broken. The 254-char cap is the RFC 5321 path limit.
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/**
 * Supabase's local/hosted minimum is configurable (config.toml
 * `minimum_password_length`) and defaults to 6. We ask for more here because
 * this is a B2B product holding other people's commercial data, and because
 * an app-side minimum is the only one a user ever sees a useful message about
 * -- Supabase's own rejection is a generic 422.
 *
 * Length only, no composition rules: NIST SP 800-63B and the NCSC both advise
 * against forced character classes, which push users toward `Passw0rd!` and
 * away from length. The real defences are MFA (required for Owner/Admin/
 * Finance per CLAUDE.md § Session security) and rate limiting.
 */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // bcrypt silently truncates at 72 bytes; refuse rather than accept a
  // password whose tail is ignored.
  if (new TextEncoder().encode(value).length > 72) {
    return "That password is too long. Use 72 characters or fewer.";
  }
  return null;
}
