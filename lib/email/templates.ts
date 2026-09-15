// The three transactional messages the product sends, as PURE builders.
//
// No "server-only" and no I/O: tests/unit/email drives all three against fixed
// inputs, and the senders in this directory only ever hand the result to
// lib/email/send.ts. Everything user-entered is HTML-ESCAPED on the way into
// the HTML body -- a feedback message is untrusted content (CLAUDE.md
// § Non-negotiable rules), and an email client renders HTML.

import {
  FEEDBACK_CATEGORY_LABELS,
  SUPPORT_ACCESS_LABEL,
  type FeedbackCategory,
} from "@/lib/feedback/contract";

/** Minimal, complete HTML escaping for text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface FeedbackEmailInput {
  readonly feedbackId: string;
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly route: string;
  readonly submitterEmail: string | null;
  readonly organisationName: string | null;
  readonly organisationSlug: string | null;
  readonly organisationRole: string | null;
  readonly userAgent: string | null;
  readonly screenshot: "none" | "clean" | "quarantined" | "error";
  /** Q121: sent from inside a break-glass support-access session, so the row
   *  carries no workspace and is labelled. Optional so existing callers and
   *  fixtures read as `false`. */
  readonly supportAccess?: boolean;
  /** Absolute origin of the app, for the dashboard link. */
  readonly siteUrl: string;
}

export interface EmailBody {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const SCREENSHOT_COPY: Record<FeedbackEmailInput["screenshot"], string> = {
  none: "No screenshot attached.",
  clean: "Screenshot attached (opening it from the dashboard is audited).",
  quarantined:
    "A screenshot was attached but the malware scanner quarantined it; it will not be shown.",
  error:
    "A screenshot was attached but the scan did not complete; it is withheld.",
};

/**
 * The founder's receipt for one submission. Subject carries the category and
 * the workspace; body carries the message verbatim (escaped), where it was
 * sent from, and a link to the row on /super/feedback.
 */
export function buildFeedbackEmail(input: FeedbackEmailInput): EmailBody {
  const category = FEEDBACK_CATEGORY_LABELS[input.category];
  const workspace = input.organisationName
    ? `${input.organisationName}${input.organisationSlug ? ` (${input.organisationSlug})` : ""}`
    : input.supportAccess
      ? `${SUPPORT_ACCESS_LABEL} — no workspace on the row`
      : "no workspace (submitted outside one)";
  const role = input.organisationRole ?? "—";
  const from = input.submitterEmail ?? "(email unavailable)";
  const link = `${input.siteUrl.replace(/\/$/, "")}/super/feedback`;

  const subject = `[Feedback · ${category}] ${
    input.organisationName ?? (input.supportAccess ? SUPPORT_ACCESS_LABEL : "No workspace")
  }`;

  const text = [
    `New in-app feedback (${category}).`,
    ``,
    `From: ${from}`,
    `Workspace: ${workspace}`,
    `Role: ${role}`,
    `Page: ${input.route}`,
    `Browser: ${input.userAgent ?? "—"}`,
    `${SCREENSHOT_COPY[input.screenshot]}`,
    ``,
    `Message:`,
    input.message,
    ``,
    `Feedback id: ${input.feedbackId}`,
    `Dashboard: ${link}`,
  ].join("\n");

  const html = [
    `<p>New in-app feedback (<strong>${escapeHtml(category)}</strong>).</p>`,
    `<table cellpadding="4">`,
    `<tr><td>From</td><td>${escapeHtml(from)}</td></tr>`,
    `<tr><td>Workspace</td><td>${escapeHtml(workspace)}</td></tr>`,
    `<tr><td>Role</td><td>${escapeHtml(role)}</td></tr>`,
    `<tr><td>Page</td><td>${escapeHtml(input.route)}</td></tr>`,
    `<tr><td>Browser</td><td>${escapeHtml(input.userAgent ?? "—")}</td></tr>`,
    `<tr><td>Screenshot</td><td>${escapeHtml(SCREENSHOT_COPY[input.screenshot])}</td></tr>`,
    `</table>`,
    `<p><strong>Message</strong></p>`,
    `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(input.message)}</pre>`,
    `<p>Feedback id: <code>${escapeHtml(input.feedbackId)}</code><br>`,
    `<a href="${escapeHtml(link)}">Open the feedback list</a></p>`,
  ].join("\n");

  return { subject, html, text };
}

export interface IncidentAlertDigestRow {
  readonly id: string;
  readonly alertType: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly organisationId: string | null;
}

/**
 * ONE digest per delivery run, not one email per alert. Task 5's review
 * established the alert feed is floodable (Q117: roughly two unattributed
 * rate-limit alerts a minute from one account); one email per row would turn
 * that flood into an inbox flood and get the founder to filter the sender.
 * The digest lists every pending alert -- id, type, summary, when, and the
 * workspace id if attributed -- and the dashboard is where they are triaged.
 * Identifiers and template sentences only: `summary` is written by this
 * schema's own definer functions and never carries user-entered content
 * (20260909020000's table comment), so nothing here needs more than escaping.
 */
export function buildIncidentAlertDigest(
  rows: readonly IncidentAlertDigestRow[],
  siteUrl: string,
): EmailBody {
  const link = `${siteUrl.replace(/\/$/, "")}/super/health`;
  const n = rows.length;
  const subject = `[GetSetPaid] ${n} new incident ${n === 1 ? "alert" : "alerts"}`;

  const textLines = rows.map(
    (r) =>
      `- ${r.createdAt}  ${r.alertType}  ${r.summary}` +
      (r.organisationId ? `  [org ${r.organisationId}]` : "  [not attributed to a workspace]") +
      `  (${r.id})`,
  );
  const text = [
    `${n} incident ${n === 1 ? "alert has" : "alerts have"} been raised since the last delivery.`,
    ``,
    ...textLines,
    ``,
    `Triage: ${link}`,
  ].join("\n");

  const htmlRows = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.createdAt)}</td><td>${escapeHtml(r.alertType)}</td>` +
        `<td>${escapeHtml(r.summary)}</td>` +
        `<td>${r.organisationId ? escapeHtml(r.organisationId) : "not attributed to a workspace"}</td>` +
        `<td><code>${escapeHtml(r.id)}</code></td></tr>`,
    )
    .join("\n");
  const html = [
    `<p>${n} incident ${n === 1 ? "alert has" : "alerts have"} been raised since the last delivery.</p>`,
    `<table cellpadding="4" border="1">`,
    `<tr><th>Raised</th><th>Type</th><th>Summary</th><th>Workspace</th><th>Id</th></tr>`,
    htmlRows,
    `</table>`,
    `<p><a href="${escapeHtml(link)}">Triage on the platform health page</a></p>`,
  ].join("\n");

  return { subject, html, text };
}

export interface LockoutEmailInput {
  /** When the lockout that triggered this notification was crossed. ISO. */
  readonly lastAttemptAt: string;
  /** SECURITY.md § 5's Login row, read from the alert's own details so the
   *  copy cannot drift from the policy the database enforces. */
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  /** Absolute origin of the app, for the sign-in link. */
  readonly siteUrl: string;
}

/**
 * THE ACCOUNT HOLDER'S OWN NOTIFICATION (founder ruling Q114) — a different
 * message to a different person from `buildIncidentAlertDigest`, which is the
 * operator's. It goes to the address on the account and to nobody else.
 *
 * Three things the copy has to do, because a security email that only says
 * "suspicious activity" makes people change a password they did not need to
 * change and still not be able to sign in:
 *
 *   1. say what actually happened, in the product's own words;
 *   2. say plainly that THIS does not mean the password is compromised — the
 *      attempts failed, which is why there is a lockout at all;
 *   3. say how to get in RIGHT NOW: the magic link and Google sign-in are not
 *      affected by a password lockout, which is the whole escape hatch
 *      SECURITY.md § 5 relies on.
 *
 * It carries no IP, no location, no attempt count beyond the policy's own
 * numbers, and nothing that was typed — a notification about failed password
 * attempts must never quote the attempts.
 */
export function buildLockoutNotification(input: LockoutEmailInput): EmailBody {
  const minutes = Math.max(1, Math.round(input.windowSeconds / 60));
  const link = `${input.siteUrl.replace(/\/$/, "")}/login`;
  const when = input.lastAttemptAt;

  const subject = "Someone is trying to sign in to your GetSetPaid account";

  const lines = [
    `Someone has repeatedly failed to sign in to your GetSetPaid account with a password.`,
    ``,
    `We locked password sign-in on your account for ${minutes} minutes after ${input.maxAttempts} failed attempts. The most recent burst was at ${when} (UTC).`,
    ``,
    `This does NOT mean your password was compromised — the attempts failed, which is exactly why the lock exists. We never see what was typed, and nothing in your workspace was accessed.`,
    ``,
    `If this was you: wait ${minutes} minutes and try again, or sign in right now with a magic link or with Google — neither is affected by a password lock.`,
    ``,
    `If it was not you: no action is required, but if your password is one you use elsewhere, change it once you are back in.`,
    ``,
    `Sign in: ${link}`,
    ``,
    `You are getting this because it is your account. We do not tell anyone else about sign-in attempts on it.`,
  ];

  const html = [
    `<p>Someone has repeatedly failed to sign in to your GetSetPaid account with a password.</p>`,
    `<p>We locked password sign-in on your account for <strong>${minutes} minutes</strong> after ${escapeHtml(String(input.maxAttempts))} failed attempts. The most recent burst was at ${escapeHtml(when)} (UTC).</p>`,
    `<p><strong>This does not mean your password was compromised</strong> — the attempts failed, which is exactly why the lock exists. We never see what was typed, and nothing in your workspace was accessed.</p>`,
    `<p><strong>If this was you:</strong> wait ${minutes} minutes and try again, or sign in right now with a <em>magic link</em> or with <em>Google</em> — neither is affected by a password lock.</p>`,
    `<p><strong>If it was not you:</strong> no action is required, but if your password is one you use elsewhere, change it once you are back in.</p>`,
    `<p><a href="${escapeHtml(link)}">Sign in to GetSetPaid</a></p>`,
    `<p>You are getting this because it is your account. We do not tell anyone else about sign-in attempts on it.</p>`,
  ].join("\n");

  return { subject, html, text: lines.join("\n") };
}
