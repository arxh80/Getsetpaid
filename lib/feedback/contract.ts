// In-app feedback: the closed vocabularies and limits, shared by the submit
// form, the server action, the superuser list and the tests.
//
// PURE. No "server-only", no Supabase import -- tests/unit drives every
// parser here, and the client-side dialog reads the labels. Every value that
// also lives in the database (public.feedback's CHECK constraints,
// 20260911000000) is mirrored here for copy and for the picker; the database
// is the enforcement, this is the vocabulary.

/** CLAUDE.md § In-app feedback: "bug / idea / other". */
export const FEEDBACK_CATEGORIES = ["bug", "idea", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Bug",
  idea: "Idea",
  other: "Other",
};

/** CLAUDE.md § In-app feedback: "New / Read / Actioned / Archived". */
export const FEEDBACK_STATUSES = ["new", "read", "actioned", "archived"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  read: "Read",
  actioned: "Actioned",
  archived: "Archived",
};

/** public.feedback.message's CHECK (<= 4000 chars). */
export const FEEDBACK_MESSAGE_MAX = 4000;

/** public.feedback.screenshot_size_bytes' CHECK and the bucket's cap: 5 MiB. */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 5242880;

/** The image types the bucket and the CHECK accept -- the ONLY sniffed MIMEs
 *  the submit action stores. A PDF is on the documents allowlist and is
 *  refused here: a screenshot is an image. */
export const FEEDBACK_SCREENSHOT_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/**
 * OWN KEYS ONLY, not `in` -- the incident-alert filter's lesson
 * (lib/admin/health.ts): `"toString" in LABELS` is true, and a query-string
 * value that passes an allowlist by way of Object.prototype is a filter nobody
 * wrote.
 */
export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_CATEGORY_LABELS, value);
}

export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_STATUS_LABELS, value);
}

export function isFeedbackScreenshotMime(
  mime: string,
): mime is (typeof FEEDBACK_SCREENSHOT_MIMES)[number] {
  return (FEEDBACK_SCREENSHOT_MIMES as readonly string[]).includes(mime);
}

/**
 * The submit UI's pre-upload warning, verbatim, in one place so the form and
 * the e2e assertion cannot drift. CLAUDE.md § In-app feedback: "The submit UI
 * must warn the user before upload that the screenshot may include on-screen
 * data" -- it is the one deliberate exception to the no-direct-tenant-data
 * rule, so the sentence is a product requirement, not helper text.
 */
export const SCREENSHOT_WARNING =
  "A screenshot captures whatever is on your screen, including records that belong to your workspace or to a workspace you were viewing. The GetSetPaid operator will be able to see it, and every time they open it is recorded.";

/**
 * What a support-access (impersonating) session is told instead of the
 * generic "refused" sentence (fix round 1, M4). Lives here rather than in
 * actions.ts because a "use server" module may export only async functions,
 * and the unit test asserts the exact sentence.
 */
export const IMPERSONATION_REFUSAL =
  "Feedback can’t be sent during a support-access session — it would be attributed to a workspace you don’t belong to. End the session, or send it from the superuser area.";

/** The storage key for a feedback screenshot: `feedback/{id}`, pinned by the
 *  database CHECK feedback_screenshot_key_shape. No user input, ever. */
export function feedbackScreenshotKey(feedbackId: string): string {
  if (!UUID_RE.test(feedbackId)) {
    throw new Error("feedbackScreenshotKey: feedbackId is not a uuid");
  }
  return `feedback/${feedbackId}`;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `YYYY-MM-DD` filter value from a query string, or null. A date that does
 * not parse, or does not round-trip (2026-02-31), degrades to "no filter" --
 * the parseListParams rule: never throw on a hostile query string.
 */
export function parseIsoDate(value: string | null): string | null {
  if (value === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? value : null;
}
