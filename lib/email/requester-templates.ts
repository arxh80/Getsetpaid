// THE FOUR DSR / EXPORT / ERASURE NOTICES, AS PURE BUILDERS WITH AN ALLOWLIST.
//
// Founder 2026-09-30, Q157(3)/Q174/Q45: build all notification emails through
// the one Brevo sender. This file is the content half of four of them; the
// delivery half is lib/email/requester-notifications.ts.
//
// THE CONTENT RULE: an email carries nothing the recipient cannot already
// read in the app, and in practice much less -- a reference, a right, a
// status word, a date and ONE in-app link. Three specific prohibitions:
//
//   * no free text a person typed (a request's detail, a rejection reason, a
//     failure reason): the page shows those to the right person, an inbox is
//     a copy kept in more places than the database;
//   * the export-ready notice links to the in-app export PAGE only -- never
//     the archive, never a signed URL, never a storage key. The page is
//     behind the session, the audited download, and the archive's own
//     expiry; a link in an email is behind none of them;
//   * the erasure-failure notice to the superuser carries a COUNT and a /super
//     link -- no subject, no workspace, no reason, no job id. What the
//     operator needs to act on is on the dashboard, which is itself the
//     authorised path.
//
// ENFORCED, NOT INTENDED. Each builder takes a narrow input type AND checks at
// runtime that the object it was handed has no key outside its allowlist
// (`assertNoticeInputAllowlisted`), and that the rendered body contains no URL
// but the one it built (`assertOnlyLink`). Both run on every render, not only
// in tests: a caller that spreads a whole row into the input -- the way a
// detail or a storage key would arrive -- throws before anything is sent.
//
// No "server-only" and no I/O: tests/unit/email drives every builder.

import {
  ACCOUNT_DATA_REQUESTS_PATH,
  DSR_RIGHT_COPY,
  DSR_STATUS_LABELS,
  SUPER_DATA_REQUESTS_PATH,
  type DsrRight,
} from "@/lib/dsr/contract";
import { ACCOUNT_EXPORTS_PATH, workspaceExportPath } from "@/lib/export/contract";
import { escapeHtml, type EmailBody } from "@/lib/email/templates";

export class NoticeContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeContentError";
  }
}

/** The ONLY keys each notice's input may carry. */
export const NOTICE_INPUT_ALLOWLIST = {
  dsrReceived: ["reference", "rightType", "dueBy", "siteUrl"],
  dsrClosed: ["reference", "rightType", "status", "siteUrl"],
  exportReady: ["kind", "organisationSlug", "expiresAt", "siteUrl"],
  erasureFailure: ["count", "siteUrl"],
} as const;

export type NoticeKind = keyof typeof NOTICE_INPUT_ALLOWLIST;

export function assertNoticeInputAllowlisted(kind: NoticeKind, input: object): void {
  const allowed: readonly string[] = NOTICE_INPUT_ALLOWLIST[kind];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new NoticeContentError(`${kind} notice refused: "${key}" is not an allowlisted field`);
    }
  }
}

/**
 * ANYTHING A MAIL CLIENT WOULD AUTOLINK: any scheme followed by `//`, in ANY
 * case (Task 9b fix round 1, I3: `HTTPS://evil` slipped past a lowercase-only
 * check), or a bare `www.` host. Read case-insensitively over the FINAL
 * rendered subject, text and HTML, NFKC-normalised so a full-width
 * `ｈｔｔｐｓ：／／` is the same thing as `https://`.
 */
export const LINK_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"'<>)]*/gi;

/** Every link-like run in the body must be exactly `link`. */
export function assertOnlyLink(kind: string, body: EmailBody, link: string): void {
  for (const part of [body.subject, body.text, body.html]) {
    for (const match of part.normalize("NFKC").matchAll(LINK_LIKE)) {
      if (match[0] !== link) {
        throw new NoticeContentError(`${kind} notice refused: it carries a URL that is not its one in-app link`);
      }
    }
  }
}

function origin(siteUrl: string): string {
  return siteUrl.replace(/\/$/, "");
}

/** UK local date, explicit zone -- the database stores UTC (CLAUDE.md). */
function ukDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new NoticeContentError("notice refused: not a date");
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function rightLabel(right: string): string {
  const copy = DSR_RIGHT_COPY[right as DsrRight];
  if (!copy) throw new NoticeContentError(`notice refused: unknown right "${right}"`);
  return copy.label;
}

function render(subject: string, paragraphs: readonly string[], link: string, linkText: string): EmailBody {
  const text = [...paragraphs, "", `${linkText}: ${link}`].join("\n\n").replace(/\n{3,}/g, "\n\n");
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(linkText)}</a></p>`,
  ].join("\n");
  return { subject, html, text };
}

// ---------------------------------------------------------------------------

export interface DsrReceivedInput {
  readonly reference: number;
  readonly rightType: string;
  readonly dueBy: string;
  readonly siteUrl: string;
}

export function buildDsrReceivedNotice(input: DsrReceivedInput): EmailBody {
  assertNoticeInputAllowlisted("dsrReceived", input);
  const link = `${origin(input.siteUrl)}${ACCOUNT_DATA_REQUESTS_PATH}`;
  const body = render(
    `We received your data request (#${input.reference})`,
    [
      `We have received your request: ${rightLabel(input.rightType)}.`,
      `Its reference is #${input.reference}. We will answer it by ${ukDate(input.dueBy)} — the 30 days the law allows, counted by our database from the moment you asked.`,
      `You can follow it, and withdraw it if you change your mind, on your account's data requests page. We will email you again when it is closed.`,
    ],
    link,
    "Your data requests",
  );
  assertOnlyLink("dsrReceived", body, link);
  return body;
}

export interface DsrClosedInput {
  readonly reference: number;
  readonly rightType: string;
  readonly status: string;
  readonly siteUrl: string;
}

const CLOSED_COPY: Record<string, string> = {
  fulfilled: "We have answered it.",
  rejected: "We were not able to carry it out. The reason is on your account page.",
  withdrawn: "You withdrew it, so we have stopped working on it.",
};

export function buildDsrClosedNotice(input: DsrClosedInput): EmailBody {
  assertNoticeInputAllowlisted("dsrClosed", input);
  const copy = CLOSED_COPY[input.status];
  if (!copy) throw new NoticeContentError(`dsrClosed notice refused: "${input.status}" is not a closed status`);
  const label = DSR_STATUS_LABELS[input.status as keyof typeof DSR_STATUS_LABELS];
  const link = `${origin(input.siteUrl)}${ACCOUNT_DATA_REQUESTS_PATH}`;
  const body = render(
    `Your data request #${input.reference} is closed: ${label}`,
    [
      `Your request #${input.reference} (${rightLabel(input.rightType)}) is closed.`,
      copy,
      `The full outcome is on your account's data requests page.`,
    ],
    link,
    "Your data requests",
  );
  assertOnlyLink("dsrClosed", body, link);
  return body;
}

export interface ExportReadyInput {
  readonly kind: "account" | "workspace";
  readonly organisationSlug: string | null;
  readonly expiresAt: string;
  readonly siteUrl: string;
}

export function buildExportReadyNotice(input: ExportReadyInput): EmailBody {
  assertNoticeInputAllowlisted("exportReady", input);
  let path: string;
  if (input.kind === "account") {
    path = ACCOUNT_EXPORTS_PATH;
  } else if (input.kind === "workspace" && input.organisationSlug && /^[a-z0-9-]+$/.test(input.organisationSlug)) {
    path = workspaceExportPath(input.organisationSlug);
  } else {
    throw new NoticeContentError("exportReady notice refused: no in-app page to link to");
  }
  const link = `${origin(input.siteUrl)}${path}`;
  const what = input.kind === "account" ? "Your account export" : "Your workspace export";
  const body = render(
    `${what} is ready to download`,
    [
      `${what} has finished building.`,
      `Download it from the export page in GetSetPaid while you are signed in — the file is not attached to this email and there is no download link in it, on purpose. It is available until ${ukDate(input.expiresAt)}.`,
    ],
    link,
    "Open the export page",
  );
  assertOnlyLink("exportReady", body, link);
  return body;
}

export interface ErasureFailureInput {
  readonly count: number;
  readonly siteUrl: string;
}

export function buildErasureFailureNotice(input: ErasureFailureInput): EmailBody {
  assertNoticeInputAllowlisted("erasureFailure", input);
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new NoticeContentError("erasureFailure notice refused: count must be a positive integer");
  }
  const link = `${origin(input.siteUrl)}${SUPER_DATA_REQUESTS_PATH}`;
  const n = input.count === 1 ? "1 erasure job" : `${input.count} erasure jobs`;
  const body = render(
    `[GetSetPaid] ${n} failed`,
    [
      `${n} failed since the last notice. Nothing was changed by a failed erasure — each one is all-or-nothing.`,
      `A failed erasure leaves the request it answers open, so it is still in the data requests queue to run again. This email carries no detail on purpose; each job's recorded reason is on its erasure_jobs row (no dashboard view shows it yet).`,
    ],
    link,
    "Open the data requests dashboard",
  );
  assertOnlyLink("erasureFailure", body, link);
  return body;
}
