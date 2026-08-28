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
  /**
   * What the user submitted, echoed back so a failed submit does not wipe it.
   *
   * REQUIRED IN REACT 19, AND FOUND IN A BROWSER RATHER THAN IN REVIEW.
   * React resets a `<form action={...}>` after the action resolves. For an
   * UNCONTROLLED form -- which every form in this codebase is, deliberately,
   * because it then works with JavaScript disabled -- that means the reset
   * puts each input back to its `defaultValue`, and on a create form every
   * `defaultValue` is the empty string. Measured on the new-contact form: type
   * a name and a malformed phone number, submit, and the field error renders
   * correctly while `name` and every other field come back "".
   *
   * A user who mistypes one character loses the whole record they just
   * entered, which is the difference between a validation message and a
   * punishment. Nothing about it is visible to tsc, lint, build or any test in
   * this repository -- the same profile as the three defects Task 3 shipped.
   *
   * THE FIX IS TO MAKE THE RESET HARMLESS rather than to fight it: the action
   * returns what it was given, the form uses that as its `defaultValue`, and
   * React's reset therefore restores the submitted values instead of blanks.
   * Controlled inputs would also work and would cost the no-JavaScript
   * behaviour, a `useState` per field, and a re-render per keystroke.
   *
   * Keyed by input `name`, so it round-trips through `FormData` unchanged.
   * Values only, never a decision: nothing here is trusted on the next
   * submission, which re-reads and re-validates the form from scratch.
   */
  values?: Readonly<Record<string, string>>;
}

/**
 * Every text value in a submitted form, for echoing back on failure.
 *
 * Deliberately reads the RAW FormData rather than the parsed values, so what
 * comes back is what the user typed -- including the whitespace and the
 * mistake. Handing back a normalised value would silently rewrite the field
 * they are being asked to correct.
 *
 * `getAll` for repeated names (a checkbox group), joined with a NEWLINE.
 * Written as an escape and not as a literal: a raw control character in a
 * source file is how tests/unit/list/cursor.test.ts became a binary blob no
 * reviewer could read in a diff. A newline cannot appear in the checkbox
 * values this joins (they are the closed vocabulary in companies-list.ts).
 */
export function echoedValues(data: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set(data.keys())) {
    // Server Action internals ($ACTION_*) travel in the same FormData. They are
    // not form fields and must not be echoed into one.
    if (key.startsWith("$")) continue;
    const all = data.getAll(key).filter((v): v is string => typeof v === "string");
    if (all.length > 0) out[key] = all.join("\n");
  }
  return out;
}

/** The inverse of `echoedValues`' join, for a checkbox group. */
export function splitEchoed(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return value.split("\n");
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
