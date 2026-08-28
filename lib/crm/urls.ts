// URL protocol validation, on the way in AND on the way out.
//
// CLAUDE.md § Non-negotiable rules: "validate URL protocols (reject
// `javascript:`, `data:`)". SECURITY.md § 3 says the same. FOLLOW-UPS.md
// routed it here because it had no owner, and named the surface: `website` on
// four tables plus `socials jsonb` on three, whose values have NO constraint
// at all -- 20260827232510 says so in the column comment, because no CHECK can
// reach inside a jsonb object and validate a protocol.
//
// ===========================================================================
// WHY BOTH DIRECTIONS, WHEN VALIDATING ON THE WAY IN LOOKS SUFFICIENT
// ===========================================================================
// Three reasons, and the first is the one that decides it:
//
//   1. PostgREST is reachable from the browser with the anon key. A member
//      with 'manage_contacts' can PATCH `socials` to
//      {"web":"javascript:..."} without going near a Server Action. Every
//      write-side check in this application is a message-quality feature; the
//      database is the only chokepoint, and the database cannot do this one.
//   2. Rows predating this file exist by assumption -- the column has been
//      writable since 20260828121000 with nothing looking at its contents.
//   3. Import, merge (Task 6) and any future integration all write these
//      columns by paths that have not been written yet.
//
// So the render side is the control and the write side is the error message.
// Not the other way round.
//
// ===========================================================================
// THE PARSE IS `new URL()`, NOT A REGEX, AND THE STRIP COMES FIRST
// ===========================================================================
// A regex over the raw string loses to the ordinary evasions, all of which
// browsers accept as `javascript:`:
//
//     JaVaScRiPt:alert(1)          case
//     java<TAB>script:alert(1)   TAB / LF / CR inside the scheme
//     <NUL>javascript:alert(1)   a leading C0 control
//     "  javascript:alert(1)"      leading whitespace
//
// The URL parser removes TAB/LF/CR from anywhere and trims leading and
// trailing C0 controls and spaces before it reads the scheme, so anything that
// does not do the same is checking a different string than the browser will.
// `stripUrlNoise` below does exactly that and no more -- see its own comment on
// why "and no more" is half the point; `new URL()` then answers what the
// protocol actually is.
//
// The allowlist is `http:` and `https:` and nothing else. `mailto:` and `tel:`
// are deliberately absent: nothing in this task renders a link from a
// user-supplied mailto, and a two-entry allowlist that is right is better than
// a four-entry one that has to be re-argued.

/**
 * Exactly what the URL parser ignores, removed before the scheme is read.
 *
 * ===========================================================================
 * TWO DIFFERENT RULES, BECAUSE THE PARSER HAS TWO
 * ===========================================================================
 * The WHATWG basic URL parser does precisely this and nothing more:
 *
 *   1. TAB, LF and CR are removed from ANYWHERE in the string. That is what
 *      makes `java<TAB>script:alert(1)` a javascript URL, and the case a
 *      regex over the raw string loses to.
 *   2. Leading and trailing C0 controls and SPACE (U+0000-U+0020) are
 *      trimmed. That is `<NUL>javascript:` and `"   javascript:"`.
 *
 * It does NOT remove a space from the middle, and neither does this any more.
 * The first version stripped every C0 control and all Unicode whitespace from
 * anywhere, so `"http s://x"` became a live link to `https://x` -- a string no
 * browser would navigate there. No security consequence (the output was still
 * an http(s) URL the parser had normalised) and a direct contradiction of the
 * rule this file states: CHECK THE SAME STRING THE BROWSER WILL. Over-cleaning
 * is the same class of mistake as under-cleaning; it just fails in the
 * friendly direction, by linkifying something the user did not write.
 *
 * A value with an interior space is still safe. `"java script:alert(1)"` has
 * no valid scheme once the space stays, so `new URL()` throws and `safeHref`
 * renders it as inert text -- which is what the browser does with it too.
 */
function stripUrlNoise(raw: string): string {
  // The ranges are written as backslash-u escapes rather than as literal
  // control characters on purpose. tests/unit/list/cursor.test.ts shipped a
  // raw NUL byte in Task 3, which made git treat the file as BINARY -- so the
  // test for the security-critical cursor decoder became the one file no
  // reviewer could read in a diff. Escapes cost nothing and cannot do that.
  return raw
    .replace(/[\u0009\u000a\u000d]/g, "")
    .replace(/^[\u0000-\u0020]+/, "")
    .replace(/[\u0000-\u0020]+$/, "");
}

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The href to render for a user-supplied value, or null to render it inert.
 *
 * NULL IS THE COMMON, CORRECT ANSWER, not a failure. A social handle
 * (`@nightshift`), a half-typed address, a bare `instagram.com` -- none of
 * those is an absolute http(s) URL, and none of them is linkified. The value
 * is still shown to the user; it is shown as text.
 *
 * Deliberately NOT upgrading a bare host to `https://`. It looks helpful and
 * it is the step that turns "is this a URL" from a question with an answer
 * into a guess -- and a guess that is wrong on the way OUT is a link to
 * somewhere the record does not name.
 *
 * Returns `url.href` rather than the input, so what reaches the DOM is the
 * parser's normalised output rather than the attacker's string.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = stripUrlNoise(raw);
  if (cleaned === "") return null;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    // Relative, scheme-less, or unparseable. Not a link.
    return null;
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/**
 * True when a value carries a scheme this application will not render.
 *
 * The write-side guard. It is deliberately narrower than `safeHref` returning
 * null: a bare handle has no scheme and is perfectly legitimate in `socials`,
 * so refusing everything `safeHref` will not linkify would refuse most real
 * input. What this refuses is a value that ANNOUNCES a protocol and names one
 * that is not http(s).
 *
 * `new URL()` is the oracle again, on the stripped string, so `JaVa\tScRiPt:`
 * is caught for the same reason it is caught on render.
 */
export function hasUnsafeScheme(raw: string): boolean {
  const cleaned = stripUrlNoise(raw);
  if (cleaned === "") return false;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    // No scheme at all -- a handle, or a relative path. Nothing announced.
    return false;
  }
  return !SAFE_PROTOCOLS.has(url.protocol);
}

/**
 * Normalise a `website` column value, or report why it cannot be stored.
 *
 * `website` differs from a `socials` value in that it is *supposed* to be a
 * URL, so a bare host IS upgraded here -- on the way IN, once, where the user
 * is present to see what it became, rather than on every render where nobody
 * is. `getsetpaid.com` is what people type into a website field, and refusing
 * it is the kind of strictness § 4 of the brief warns about on `email`.
 *
 * The host pattern is deliberately conservative: labels of ASCII letters,
 * digits and hyphens, at least two of them, optionally followed by a path. It
 * is not an attempt to match every valid host -- anything it declines can be
 * typed with `https://` in front of it.
 */
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(?=[/?#]|$)/i;

export type WebsiteResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string };

export function normaliseWebsite(raw: string | null): WebsiteResult {
  if (raw === null) return { ok: true, value: null };
  const cleaned = stripUrlNoise(raw);
  if (cleaned === "") return { ok: true, value: null };

  const candidate = BARE_HOST.test(cleaned) ? `https://${cleaned}` : cleaned;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      message: "That doesn’t look like a web address. Try https://example.com.",
    };
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      message: "Only http:// and https:// web addresses can be stored here.",
    };
  }
  // Length cap: the column is unbounded text, and an 8KB URL is either a bug
  // or an attempt to make a page expensive to render.
  if (url.href.length > 2048) {
    return { ok: false, message: "That web address is too long." };
  }
  return { ok: true, value: url.href };
}

// ---------------------------------------------------------------------------
// socials
// ---------------------------------------------------------------------------

/**
 * The platforms the form offers.
 *
 * A fixed list, even though the column is a free-form jsonb object and
 * 20260827232510 chose jsonb precisely so the set could change without a
 * migration. Both are right: the SCHEMA stays open so tomorrow's platform
 * costs nothing, and the FORM stays closed so today's keys are consistent
 * enough to filter and display.
 *
 * A KEY THAT IS NOT ON THIS LIST SURVIVES BOTH DIRECTIONS, and the second
 * half of that sentence was FALSE when it was first written. `parseSocials`
 * preserved unknown keys on READ, and the previous version of this comment
 * stopped there -- but `updateContactAction` then wrote a fresh object built
 * by iterating this list alone, straight over the column. Reproduced in a
 * browser: a row imported with `mixcloud` rendered its link on the detail
 * page, the edit form had no input for it, and the first save of any other
 * field destroyed it silently and permanently. The write path now merges
 * through `mergeSocials()` below; this comment is only true because that
 * function exists.
 */
export const SOCIAL_PLATFORMS = [
  { key: "instagram", label: "Instagram" },
  { key: "soundcloud", label: "SoundCloud" },
  { key: "bandcamp", label: "Bandcamp" },
  { key: "spotify", label: "Spotify" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "x", label: "X" },
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]["key"];

/**
 * What to STORE in `socials` after an edit: the submitted six, over the top of
 * whatever was already there.
 *
 * ===========================================================================
 * WHY THIS IS A MERGE AND NOT AN ASSIGNMENT
 * ===========================================================================
 * `socials` is a free-form jsonb object and only six of its keys have inputs
 * on the form. An import, Task 6's merge, or a direct PostgREST call can put
 * anything else in there -- `mixcloud`, `telegram`, a key that does not exist
 * yet -- and `parseSocials` deliberately renders all of it. Writing the six
 * form fields over the whole column therefore DELETES data the user was never
 * shown, never warned about and cannot recover: there is no undo and field
 * edits are not audited until Phase 7.
 *
 * ===========================================================================
 * WHY THE SIX ARE AUTHORITATIVE AND EVERYTHING ELSE IS NOT
 * ===========================================================================
 * An absent key among the six means CLEARED, not unchanged -- the user emptied
 * that input on purpose and `field()` turns "" into null, so the submission
 * has no entry for it. Falling back to the stored value there would make an
 * emptied social field un-clearable, which is the same defect as the checkbox
 * group reverting (see `selectedInGroup` in lib/forms.ts). Every OTHER key is
 * carried through untouched, because the form never offered the user a way to
 * say anything about it.
 *
 * `stored` is read from the database at save time, NOT echoed through a hidden
 * input: a hidden input is client-supplied and would let a caller rewrite keys
 * the form does not render, under cover of an ordinary save.
 *
 * Pure, so the round trip is a unit test rather than a browser walk.
 */
export function mergeSocials(
  stored: unknown,
  submitted: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      // Same shape discipline as parseSocials: the column's only CHECK is
      // `jsonb_typeof(socials) = 'object'`, so a value can be a number, an
      // array or null. A non-string is not a handle and is not carried.
      if (typeof value === "string") out[key] = value;
    }
  }
  for (const platform of SOCIAL_PLATFORMS) {
    const value = submitted[platform.key];
    if (value === undefined) delete out[platform.key];
    else out[platform.key] = value;
  }
  return out;
}

export interface SocialEntry {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Non-null only when the value is a safe absolute http(s) URL. */
  readonly href: string | null;
}

const PLATFORM_LABELS = new Map<string, string>(
  SOCIAL_PLATFORMS.map((p) => [p.key, p.label]),
);

/**
 * Read a stored `socials` object into something a page can render.
 *
 * DEFENSIVE ABOUT SHAPE AS WELL AS PROTOCOL. The column's only constraint is
 * `jsonb_typeof(socials) = 'object'`, so a value can be a number, an array, a
 * nested object or null, and any of those reaching `String()` produces
 * `[object Object]` in a table cell. Non-strings are dropped, which is the
 * honest reading of "this is not a handle".
 *
 * `href` is computed here, once, rather than at each call site, so no page can
 * render one of these values into an `href` without going through `safeHref`.
 */
export function parseSocials(raw: unknown): SocialEntry[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const entries: SocialEntry[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    entries.push({
      key,
      label: PLATFORM_LABELS.get(key) ?? key,
      value: trimmed,
      href: safeHref(trimmed),
    });
  }
  return entries;
}
