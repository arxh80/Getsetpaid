// SHARED RENDERING FOR THE JOB-3 NOTICES (connection requests, task reminders):
// pure, no I/O. The two content rules every builder runs on every render --
// an input allowlist and "no URL but the one in-app link" -- live here once.

import { escapeHtml, type EmailBody } from "@/lib/email/templates";
import { NoticeContentError, assertOnlyLink as assertOnlyLinkShared } from "@/lib/email/requester-templates";

/** Every key of `input` must be in `allowed`, or nothing is rendered. */
export function assertInputAllowlisted(kind: string, allowed: readonly string[], input: object): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new NoticeContentError(`${kind} notice refused: "${key}" is not an allowlisted field`);
    }
  }
}

/** The one shared check (requester-templates.ts): case-insensitive, every scheme, bare `www.`, on the final render. */
export const assertOnlyLink = assertOnlyLinkShared;

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
 * NEUTRALISE EVERYTHING LINK-LIKE IN A PERSON'S TEXT, TO A FIXED POINT (Task 9b
 * fix round 1, I3). One case-insensitive pass of an http(s) strip was beatable by
 * reassembly: `HThttps://TPS://evil` lost its inner `https://` and became
 * `HTTPS://evil`. So: NFKC first (full-width `ｈｔｔｐｓ：／／` folds to
 * `https://`), format characters (zero-width joiners and spaces) dropped, then
 * EVERY `<scheme>://` (any scheme, any case) and every `www.` is removed, and
 * the removal repeats until the text stops changing -- a removal that
 * reassembles a new one is caught by the next pass (`https:www.//evil` is
 * the measured case: removing `www.` is what assembles the scheme, and a
 * single pass leaves `https://evil` behind). Every pass shortens the
 * string, so it terminates. Total: it never throws, so hostile text renders
 * neutralised instead of poisoning the queue (I2).
 *
 * RESIDUAL, stated: a bare domain (`evil.example/login`) is left as typed --
 * some clients autolink it, and removing dots between words would mangle
 * ordinary names (`St. Luke's`, `Acme.co`). assertOnlyLink() still runs on
 * every final render.
 */
export function neutraliseLinks(value: string): string {
  let current = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  for (;;) {
    const next = current.replace(/[a-z][a-z0-9+.-]*:\/\//gi, "").replace(/www\./gi, "");
    if (next === current) return current;
    current = next;
  }
}

/**
 * Free text from a person (a display name, a task title) is one line and
 * bounded, and cannot become a second link.
 */
export function oneLine(value: string, max: number): string {
  const flat = neutraliseLinks(value.replace(/[\r\n\t]+/g, " "))
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
