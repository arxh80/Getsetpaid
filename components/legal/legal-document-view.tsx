import { formatDateOnly } from "@/lib/format/date";
import { LegalBody } from "./legal-body";

// One legal document, as a reader sees it: the stored title as the page's
// <h1>, the version and effective date, the draft notice when counsel has not
// reviewed this version, and the body.
//
// Used by the public page (app/legal/[slug]/page.tsx) and by the superuser
// editor's preview, so the preview is the page -- not an approximation of it.

/**
 * The notice every unreviewed version carries.
 *
 * NOT DISMISSABLE, BY CONSTRUCTION: it is server-rendered markup with no
 * control and no client state, so there is nothing to close and nothing to
 * remember having closed. It sits between the title and the text, so it is
 * read before the first word of the document by eye and by screen reader
 * alike. `role="note"` rather than an alert: it is a standing fact about the
 * page, not an event.
 */
export function DraftNotice() {
  return (
    <div
      role="note"
      aria-label="Draft pending legal review"
      data-testid="legal-draft-notice"
      className="my-6 border border-warning bg-surface px-4 py-4"
    >
      <p className="text-base text-ink">
        <span className="mr-2 inline-block border border-warning px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-warning uppercase">
          Draft
        </span>
        <span className="font-semibold">Pending legal review.</span>{" "}
        This version is a working draft written by the GetSetPaid team. Qualified
        legal counsel has not yet reviewed it, so it may change and should not
        be relied on as a final statement of your rights or our obligations.
      </p>
    </div>
  );
}

export function LegalDocumentView({
  title,
  version,
  effectiveDate,
  reviewed,
  body,
  headingLevel = 1,
}: {
  title: string;
  version: number;
  effectiveDate: string;
  reviewed: boolean;
  body: string;
  /** 1 on the public page; 2 inside the editor, whose own <h1> is the page's. */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <article className="max-w-prose" data-testid="legal-document">
      <header className="flex flex-col gap-2 border-b border-rule pb-4">
        <Heading className="tracking-display text-3xl font-extrabold text-ink">{title}</Heading>
        <p className="text-sm text-ink-muted" data-testid="legal-version">
          Version <span className="tabular-nums">{version}</span> · Effective{" "}
          <span className="tabular-nums">{formatDateOnly(effectiveDate)}</span>
          {reviewed ? " · Reviewed by legal counsel" : null}
        </p>
      </header>
      {reviewed ? null : <DraftNotice />}
      <LegalBody source={body} />
    </article>
  );
}
