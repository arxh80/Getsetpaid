import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { SkipLink } from "@/components/ui/skip-link";
import { LegalFooter } from "@/components/legal/legal-footer";

// Shell for the fifteen public legal pages (Phase 8 Task 1).
//
// OUTSIDE BOTH ROUTE GROUPS ON PURPOSE. `(auth)` bounces a signed-in user away
// (SIGNED_OUT_ONLY_PATHS) and `(app)` requires a session; a legal page must
// read the same to both, so it has its own shell. lib/supabase/middleware.ts
// lists `/legal` in PUBLIC_PATHS so a signed-out request reaches it at all.
//
// A long-form reading layout: one column, the text held to `max-w-prose`
// (about 65 characters) inside a slightly wider frame so tables can breathe,
// nothing fixed-width, so it reflows to 320px.
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-5">
          <Link href="/" className="no-underline" aria-label="GetSetPaid home">
            <Wordmark />
          </Link>
          <Link
            href="/legal"
            className="text-sm text-primary underline underline-offset-4 hover:text-ink"
          >
            All legal pages
          </Link>
        </div>
      </header>

      {/* tabIndex={-1}: the skip link's focus target, never tabbable --
          the same note as app/(auth)/layout.tsx's main. */}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12"
      >
        {children}
      </main>

      <LegalFooter />
    </div>
  );
}
