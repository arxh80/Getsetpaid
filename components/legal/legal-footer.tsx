import Link from "next/link";
import {
  LEGAL_DOCUMENTS,
  LEGAL_GROUP_LABELS,
  LEGAL_GROUP_ORDER,
  legalDocumentHref,
} from "@/lib/legal/documents";

// The footer every signed-out screen carries: all fifteen legal pages,
// grouped. A <nav> with its own label, so a screen-reader user can jump to it
// as a landmark and tell it apart from any other navigation on the page.

export function LegalFooterLinks() {
  return (
    <nav aria-label="Legal" className="grid grid-cols-1 gap-6 sm:grid-cols-3">
      {LEGAL_GROUP_ORDER.map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            {LEGAL_GROUP_LABELS[group]}
          </p>
          <ul className="flex flex-col gap-1.5">
            {LEGAL_DOCUMENTS.filter((doc) => doc.group === group).map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={legalDocumentHref(doc.slug)}
                  prefetch={false}
                  className="text-sm text-ink-muted underline underline-offset-4 hover:text-ink"
                >
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function LegalFooter({ width = "max-w-3xl" }: { width?: "max-w-md" | "max-w-3xl" }) {
  return (
    <footer className="border-t border-rule">
      <div className={`mx-auto flex w-full ${width} flex-col gap-6 px-4 py-8`}>
        <p className="text-sm text-ink-muted">A CRM for the live events industry.</p>
        <LegalFooterLinks />
      </div>
    </footer>
  );
}
