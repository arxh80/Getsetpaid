import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  LEGAL_DOCUMENTS,
  isLegalSlug,
  legalDocumentEntry,
  legalDocumentHref,
  type LegalSlug,
} from "@/lib/legal/documents";
import { listOperatorLegalVersions, type OperatorLegalVersion } from "@/lib/legal/operator";
import { formatDateOnly, formatDateTime } from "@/lib/format/date";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { Alert } from "@/components/ui/alert";
import { LegalDocumentView } from "@/components/legal/legal-document-view";
import {
  CreateDraftForm,
  DraftEditForm,
  PublishDraftForm,
  RecordReviewForm,
} from "@/components/admin/legal-editor-forms";

// PHASE 8 TASK 1: the legal-document editor (DECISIONS-QUEUE Q128).
//
// ONE PAGE, TWO VIEWS, chosen by `?doc=<slug>`: the list of all fifteen, or
// one document's current version, draft, preview and history. One page.tsx
// rather than a `[slug]` segment keeps this area's route census
// (tests/e2e/super-permissions.spec.ts) a literal list of URLs.
//
// Every /super convention, unchanged: generateMetadata() gated on identity so
// the tab title cannot leak into the refusal; the gate in the page, below this
// route's own loading.tsx, so a non-superuser receives the STREAMED not-found
// document (app/(app)/super/layout.tsx's header); and no data read that is not
// itself guarded -- public.operator_legal_document_versions() refuses anyone
// but the allowlisted superuser at aal2. Publishing and recording a review are
// behind <StepUpGate>, and re-checked in lib/legal/admin-actions.ts.
//
// NO TENANT DATA. Legal text is platform content.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Legal documents · Superuser · GetSetPaid" };
}

function ReviewChip({ reviewedAt }: { reviewedAt: string | null }) {
  // Status as a bordered uppercase chip with a word, never colour alone
  // (DESIGN.md § Palette).
  return reviewedAt ? (
    <span className="inline-block border border-success px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-success uppercase">
      Reviewed
    </span>
  ) : (
    <span className="inline-block border border-warning px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-warning uppercase">
      Not reviewed
    </span>
  );
}

function summarise(versions: readonly OperatorLegalVersion[], slug: LegalSlug) {
  const own = versions.filter((v) => v.slug === slug);
  return {
    current: own.find((v) => v.status === "published") ?? null,
    draft: own.find((v) => v.status === "draft") ?? null,
    history: own,
  };
}

function DocumentList({ versions }: { versions: readonly OperatorLegalVersion[] }) {
  return (
    <div className="overflow-x-auto border border-rule" role="region" aria-label="Legal documents" tabIndex={0}>
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <thead>
          <tr>
            {["Document", "Public version", "Effective", "Counsel review", "Draft"].map((label) => (
              <th
                key={label}
                scope="col"
                className="border-b border-rule bg-surface px-3 py-2 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LEGAL_DOCUMENTS.map((doc) => {
            const { current, draft } = summarise(versions, doc.slug);
            return (
              <tr key={doc.slug}>
                <th scope="row" className="border-b border-rule px-3 py-3 align-top font-semibold">
                  <Link
                    href={`/super/legal?doc=${doc.slug}`}
                    className="text-primary underline underline-offset-4 hover:text-ink"
                  >
                    {doc.title}
                  </Link>
                </th>
                <td className="border-b border-rule px-3 py-3 align-top tabular-nums text-ink">
                  {current ? current.version : "—"}
                </td>
                <td className="border-b border-rule px-3 py-3 align-top tabular-nums text-ink">
                  {current ? formatDateOnly(current.effectiveDate) : "—"}
                </td>
                <td className="border-b border-rule px-3 py-3 align-top">
                  {current ? <ReviewChip reviewedAt={current.counselReviewedAt} /> : "—"}
                </td>
                <td className="border-b border-rule px-3 py-3 align-top text-ink">
                  {draft ? (
                    <span>
                      Version <span className="tabular-nums">{draft.version}</span>
                      {draft.counselReviewedAt ? " (reviewed)" : ""}
                    </span>
                  ) : (
                    <span className="text-ink-muted">None</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DocumentEditor({
  slug,
  versions,
}: {
  slug: LegalSlug;
  versions: readonly OperatorLegalVersion[];
}) {
  const { current, draft, history } = summarise(versions, slug);
  const here = `/super/legal?doc=${slug}`;
  const entry = legalDocumentEntry(slug);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Link href="/super/legal" className="text-sm text-primary underline underline-offset-4 hover:text-ink">
          All legal documents
        </Link>
        <h2 className="text-2xl font-extrabold text-ink">{entry.title}</h2>
        <p className="text-sm text-ink-muted">
          Public at{" "}
          <Link href={legalDocumentHref(slug)} className="text-primary underline underline-offset-4 hover:text-ink">
            {legalDocumentHref(slug)}
          </Link>
        </p>
      </div>

      <section aria-labelledby="legal-current" className="flex flex-col gap-4 border-t border-rule pt-6">
        <h3 id="legal-current" className="text-xl font-bold text-ink">
          Current public version
        </h3>
        {current ? (
          <>
            <p className="text-base text-ink">
              Version <span className="tabular-nums">{current.version}</span>, effective{" "}
              <span className="tabular-nums">{formatDateOnly(current.effectiveDate)}</span>, published{" "}
              <span className="tabular-nums">{current.publishedAt ? formatDateTime(current.publishedAt) : "—"}</span>.{" "}
              <ReviewChip reviewedAt={current.counselReviewedAt} />
            </p>
            {current.counselReviewedAt ? (
              <p className="text-sm text-ink-muted">
                Review recorded <span className="tabular-nums">{formatDateTime(current.counselReviewedAt)}</span>
                {current.counselReviewer ? `, by ${current.counselReviewer}` : ""}.
              </p>
            ) : (
              <StepUpGate next={here}>
                <RecordReviewForm slug={slug} documentId={current.id} version={current.version} which="current" />
              </StepUpGate>
            )}
          </>
        ) : (
          <Alert tone="error">This document has no public version.</Alert>
        )}
      </section>

      <section aria-labelledby="legal-draft" className="flex flex-col gap-6 border-t border-rule pt-6">
        <h3 id="legal-draft" className="text-xl font-bold text-ink">
          {draft ? `Draft — version ${draft.version}` : "Draft"}
        </h3>
        {draft ? (
          <>
            <p className="text-sm text-ink-muted">
              Private to you until published. Last saved{" "}
              <span className="tabular-nums">{formatDateTime(draft.updatedAt)}</span>.{" "}
              <ReviewChip reviewedAt={draft.counselReviewedAt} />
              {draft.counselReviewedAt && draft.counselReviewer ? ` Reviewed by ${draft.counselReviewer}.` : ""}
            </p>
            <DraftEditForm
              key={`${draft.id}-${draft.updatedAt}`}
              slug={slug}
              documentId={draft.id}
              title={draft.title}
              body={draft.body}
              effectiveDate={draft.effectiveDate}
            />
            {draft.counselReviewedAt ? null : (
              <div className="flex flex-col gap-3 border-t border-rule pt-6">
                <h4 className="text-lg font-bold text-ink">Record counsel’s review of this draft</h4>
                <StepUpGate next={here}>
                  <RecordReviewForm slug={slug} documentId={draft.id} version={draft.version} which="draft" />
                </StepUpGate>
              </div>
            )}
            <div className="flex flex-col gap-3 border-t border-rule pt-6">
              <h4 className="text-lg font-bold text-ink">Publish this draft</h4>
              <StepUpGate next={here}>
                <PublishDraftForm
                  slug={slug}
                  documentId={draft.id}
                  version={draft.version}
                  reviewed={draft.counselReviewedAt !== null}
                />
              </StepUpGate>
            </div>
            <div className="flex flex-col gap-3 border-t border-rule pt-6">
              <h4 className="text-lg font-bold text-ink">Preview, as the public page will show it</h4>
              <div className="border border-rule bg-surface px-4 py-6" data-testid="legal-draft-preview">
                <LegalDocumentView
                  headingLevel={2}
                  title={draft.title}
                  version={draft.version}
                  effectiveDate={draft.effectiveDate}
                  reviewed={draft.counselReviewedAt !== null}
                  body={draft.body}
                />
              </div>
            </div>
          </>
        ) : (
          <CreateDraftForm slug={slug} />
        )}
      </section>

      <section aria-labelledby="legal-history" className="flex flex-col gap-4 border-t border-rule pt-6">
        <h3 id="legal-history" className="text-xl font-bold text-ink">
          Version history
        </h3>
        <ul className="flex flex-col border-t border-rule">
          {history.map((v) => (
            <li key={v.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-3 text-sm text-ink">
              <span className="font-semibold">
                Version <span className="tabular-nums">{v.version}</span>
              </span>
              <span className="text-ink-muted">{v.status === "published" ? "Public" : v.status === "draft" ? "Draft" : "Superseded"}</span>
              <span className="tabular-nums text-ink-muted">
                {v.publishedAt ? `published ${formatDateTime(v.publishedAt)}` : `created ${formatDateTime(v.createdAt)}`}
                {v.supersededAt ? `, superseded ${formatDateTime(v.supersededAt)}` : ""}
              </span>
              <ReviewChip reviewedAt={v.counselReviewedAt} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default async function LegalDocumentsAdminPage({ searchParams }: PageProps<"/super/legal">) {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header.
  if (!(await isSuperuser())) notFound();

  const raw = await searchParams;
  const docParam = Array.isArray(raw.doc) ? raw.doc[0] : raw.doc;
  const slug = isLegalSlug(docParam) ? docParam : null;

  const read = await listOperatorLegalVersions(slug);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Legal documents</h1>
        <p className="max-w-prose text-base text-ink-muted">
          The fifteen public legal pages, versioned. Drafts are private to you;
          publishing makes a version public at once and freezes it. Until
          counsel’s review of a version is recorded here, its public page says
          it is a draft pending legal review.
        </p>
      </div>
      {!read.ok ? (
        <Alert tone="error">
          The legal documents could not be loaded. Reload the page; if it persists, check the server log.
        </Alert>
      ) : slug ? (
        <DocumentEditor slug={slug} versions={read.versions} />
      ) : (
        <DocumentList versions={read.versions} />
      )}
    </div>
  );
}
