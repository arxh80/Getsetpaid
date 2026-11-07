import type { Metadata } from "next";
import { Wordmark } from "@/components/wordmark";
import { SkipLink } from "@/components/ui/skip-link";
import { LegalFooter } from "@/components/legal/legal-footer";

// Shell for the card-payment pages (invoices part 2 Task 5): the legal pages'
// signed-out frame, with no app chrome and no link into the product. The
// recipient has no account, so the wordmark is not a link (it would only
// bounce to the sign-in page), and nothing here may be indexed: the URL is a
// credential.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-5">
          <Wordmark />
        </div>
      </header>

      {/* tabIndex={-1}: the skip link's focus target, as in app/legal/layout.tsx. */}
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">
        {children}
      </main>

      <LegalFooter />
    </div>
  );
}
