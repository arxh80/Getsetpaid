import type { Metadata } from "next";
import Link from "next/link";
import {
  LEGAL_DOCUMENTS,
  LEGAL_GROUP_LABELS,
  LEGAL_GROUP_ORDER,
  legalDocumentHref,
} from "@/lib/legal/documents";

export const metadata: Metadata = {
  title: "Legal · GetSetPaid",
  description: "GetSetPaid's privacy, terms and trust documents.",
};

// The index of the fifteen legal pages. Static: it lists the catalogue, not
// the documents, so it needs no database read.
export default function LegalIndexPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-prose flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Legal</h1>
        <p className="text-base text-ink-muted">
          How GetSetPaid handles your data, the terms of using it and how we
          keep it secure. Each page shows its version and the date it took
          effect, and says plainly when a version has not yet been reviewed by
          legal counsel.
        </p>
      </div>

      {LEGAL_GROUP_ORDER.map((group) => (
        <section key={group} aria-labelledby={`legal-group-${group}`} className="flex flex-col gap-3">
          <h2 id={`legal-group-${group}`} className="text-xl font-extrabold text-ink">
            {LEGAL_GROUP_LABELS[group]}
          </h2>
          <ul className="flex flex-col border-t border-rule">
            {LEGAL_DOCUMENTS.filter((doc) => doc.group === group).map((doc) => (
              <li key={doc.slug} className="border-b border-rule py-3">
                <Link
                  href={legalDocumentHref(doc.slug)}
                  className="text-base font-semibold text-primary underline underline-offset-4 hover:text-ink"
                >
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
