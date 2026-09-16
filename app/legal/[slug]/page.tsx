import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLegalSlug, legalDocumentEntry } from "@/lib/legal/documents";
import { getPublishedLegalDocument } from "@/lib/legal/published";
import { LegalDocumentView } from "@/components/legal/legal-document-view";

// One public legal page: the CURRENT PUBLISHED version of `slug`.
//
// Reachable signed out (lib/supabase/middleware.ts PUBLIC_PATHS). An unknown
// slug is a plain 404 -- there is nothing to hide about which legal pages
// exist, and no loading.tsx here, so it is the literal status.
//
// Always read at request time (the query goes through the cookie-bound
// server client), so a version published from /super/legal is what the very
// next visitor reads, with no deploy and no cache to wait out.

export async function generateMetadata({
  params,
}: PageProps<"/legal/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  if (!isLegalSlug(slug)) return { title: "Not found · GetSetPaid" };
  const doc = await getPublishedLegalDocument(slug);
  const title = doc?.title ?? legalDocumentEntry(slug).title;
  return { title: `${title} · GetSetPaid` };
}

export default async function LegalDocumentPage({ params }: PageProps<"/legal/[slug]">) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) notFound();

  const doc = await getPublishedLegalDocument(slug);
  if (!doc) notFound();

  return (
    <LegalDocumentView
      title={doc.title}
      version={doc.version}
      effectiveDate={doc.effectiveDate}
      reviewed={doc.counselReviewedAt !== null}
      body={doc.body}
    />
  );
}
