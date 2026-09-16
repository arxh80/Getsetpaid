import "server-only";

// The contact address the legal pages show, read from configuration.
//
// SECURITY.md § 13: there is ONE contact today -- `SUPPORT_CONTACT_EMAIL`,
// where feedback receipts and incident digests already go -- and it is an
// environment value, never committed. The legal documents therefore never
// contain an address: they contain the `{{support_email}}` placeholder, and
// this module fills it in at render time. So counsel can edit every word of
// the Contact and Vulnerability Disclosure pages without an address ever
// being written into the database or the repository.
//
// WHEN IT IS UNSET (a fresh local stack, a preview deployment) the page says
// so in words -- UNSET_CONTACT_SENTENCE -- rather than rendering an empty link
// or a made-up address. A page that invites a report and then gives nowhere
// to send it has to admit it.

export const UNSET_CONTACT_SENTENCE =
  "no contact address has been configured for this deployment yet";

// Deliberately conservative: one address, no display name, no whitespace, no
// characters that would need escaping inside a mailto: URL. A value that
// fails this is treated exactly like an unset one -- the page never renders a
// malformed or injected mailto: target from configuration either.
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export interface SupportContact {
  readonly address: string | null;
}

export function supportContact(
  env: Record<string, string | undefined> = process.env,
): SupportContact {
  const raw = env.SUPPORT_CONTACT_EMAIL?.trim() ?? "";
  // ADDRESS can backtrack quadratically on a long run of dots (`.` is in the
  // domain class and is the separator). The value is configuration, not user
  // input, but the check runs on every contact-page render, so it is bounded
  // by the longest address RFC 5321 allows before the regex sees it (fix
  // round 2, M5 sweep).
  return { address: raw.length <= 254 && ADDRESS.test(raw) ? raw : null };
}
