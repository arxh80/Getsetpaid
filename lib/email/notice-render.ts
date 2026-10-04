// SHARED RENDERING FOR THE JOB-3 NOTICES (connection requests, task reminders):
// pure, no I/O. The two content rules every builder runs on every render --
// an input allowlist and "no URL but the one in-app link" -- live here once.

import { escapeHtml, type EmailBody } from "@/lib/email/templates";
import { NoticeContentError } from "@/lib/email/requester-templates";

/** Every key of `input` must be in `allowed`, or nothing is rendered. */
export function assertInputAllowlisted(kind: string, allowed: readonly string[], input: object): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new NoticeContentError(`${kind} notice refused: "${key}" is not an allowlisted field`);
    }
  }
}

export function assertOnlyLink(kind: string, body: EmailBody, link: string): void {
  for (const part of [body.subject, body.text, body.html]) {
    for (const match of part.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
      if (match[0] !== link) {
        throw new NoticeContentError(`${kind} notice refused: it carries a URL that is not its one in-app link`);
      }
    }
  }
}

export const SLUG = /^[a-z0-9-]+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function origin(siteUrl: string): string {
  return siteUrl.replace(/\/$/, "");
}

export function slugOrRefuse(kind: string, slug: string): string {
  if (!SLUG.test(slug)) throw new NoticeContentError(`${kind} notice refused: no in-app page to link to`);
  return slug;
}

/**
 * Free text from a person (a display name, a task title) is one line and
 * bounded, and cannot become a second link.
 */
export function oneLine(value: string, max: number): string {
  // URL schemes are dropped, so a title naming a website renders as text and
  // can never be a second link (assertOnlyLink still runs after rendering).
  const flat = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\//gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** UK local date and time, explicit zone -- the database stores UTC. */
export function ukDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new NoticeContentError("notice refused: not a date");
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function render(subject: string, paragraphs: readonly string[], link: string, linkText: string): EmailBody {
  const text = [...paragraphs, "", `${linkText}: ${link}`].join("\n\n").replace(/\n{3,}/g, "\n\n");
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(linkText)}</a></p>`,
  ].join("\n");
  return { subject, html, text };
}
